// Tests for artifacts.mjs — the box-side artifact derivation + memoized service
// behind `artifacts:list`. Pure logic with injected I/O and a fake clock; no live
// opencode, filesystem or HTTP. Run via `npm run test:server`.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveArtifacts,
  planRefsFromPart,
  planStepCount,
  planTitleFromPath,
  expiryState,
  countByKind,
  view,
  planPageResolution,
  omittedHostedPages,
  createArtifactsService,
} from "./artifacts.mjs";
import { dispatch } from "./rpc.mjs";

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

const SID = "ses_a";

function msg(id, role, parts, created = id === "u" ? 1000 : 2000, extraInfo = {}) {
  return {
    info: { id, sessionID: SID, role, ...(created > 0 ? { time: { created } } : {}), ...extraInfo },
    parts: parts.map((p, i) => ({ id: `${id}-p${i}`, messageID: id, ...p })),
  };
}

const filePart = (o = {}) => ({
  type: "file", mime: "text/plain", url: "file:///home/u/report.txt", filename: "report.txt", ...o,
});
const textPart = (text, o = {}) => ({ type: "text", text, ...o });
const toolPart = (tool, input) => ({ type: "tool", tool, state: { status: "completed", ...(input ? { input } : {}) } });
const page = (o = {}) => ({
  subdomain: "preview", url: "https://box.example/pages/preview", createdAt: 0, expiresAt: null, sessionID: SID, ...o,
});
const outboxRow = (o = {}) => ({
  path: "/home/dev/.manta-outbox/ses_a/q3.csv", name: "q3.csv", size: 1204, sessionID: SID,
  mtime: 5000, expiresAt: null, messageID: null, ...o,
});

function derive(o = {}) {
  return deriveArtifacts({
    messages: [], pages: [], outbox: [], sessionId: SID, directory: null, baseUrl: "https://box.example", ...o,
  });
}

// ---------------------------------------------------------------------------
// 1. file parts
// ---------------------------------------------------------------------------

test("file part → kind/label/href/mime/size/messageId; image mime → image", () => {
  const out = derive({
    messages: [
      msg("u", "user", [filePart({ mime: "image/png", url: "file:///a/pic.png", filename: "pic.png", size: 2048 })]),
      msg("a", "assistant", [filePart({ mime: "application/pdf", url: "file:///b/doc.pdf", filename: "doc.pdf" })]),
    ],
  });
  assert.equal(out.length, 2);
  const image = out.find((a) => a.kind === "image");
  const file = out.find((a) => a.kind === "file");
  assert.equal(image.href, "/a/pic.png");
  assert.equal(image.origin, "user");
  assert.equal(image.size, 2048);
  assert.equal(image.messageId, "u");
  assert.equal(file.href, "/b/doc.pdf");
  assert.equal(file.mime, "application/pdf");
  assert.equal(file.origin, "agent");
  assert.equal(file.size, null);
  assert.equal(file.label, "doc.pdf");
});

test("label falls back to the last path segment of the url", () => {
  const out = derive({ messages: [msg("a", "assistant", [filePart({ url: "file:///dir/no-name", filename: undefined })])] });
  assert.equal(out[0].label, "no-name");
});

// ---------------------------------------------------------------------------
// 2. links
// ---------------------------------------------------------------------------

test("user text with one URL → link with context (URL removed, collapsed, 160 cap)", () => {
  const out = derive({ messages: [msg("u", "user", [textPart("see   https://example.com/path \n and more")])] });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "link");
  assert.equal(out[0].origin, "user");
  assert.equal(out[0].href, "https://example.com/path");
  assert.equal(out[0].label, "example.com/path");
  assert.equal(out[0].context, "see and more");
  assert.equal(out[0].mime, null);
  assert.equal(out[0].id, "u-p0");
  assert.equal(out[0].messageId, "u");
  assert.equal(out[0].isHosted, false);

  const long = derive({ messages: [msg("u", "user", [textPart(`https://x.io/a ${"word ".repeat(80)}`)])] });
  assert.equal(long[0].context.length, 160);
});

test("two URLs in one part → .0/.1 ids; assistant text links and synthetic/ignored parts are skipped", () => {
  const out = derive({ messages: [msg("u", "user", [textPart("https://a.com/x https://b.com/y")])] });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((a) => a.id).sort(), ["u-p0.0", "u-p0.1"]);
  assert.deepEqual(out.map((a) => a.href).sort(), ["https://a.com/x", "https://b.com/y"]);

  assert.deepEqual(derive({ messages: [msg("a", "assistant", [textPart("docs at https://example.com/docs")])] }), []);
  assert.deepEqual(
    derive({
      messages: [
        msg("u", "user", [textPart("https://example.com/1", { synthetic: true })]),
        msg("u2", "user", [textPart("https://example.com/2", { ignored: true })], 3000),
      ],
    }),
    [],
  );
});

test("tool / patch parts of every kind produce no artifact", () => {
  for (const tool of ["read", "write", "edit", "bash", "webfetch"]) {
    assert.deepEqual(derive({ messages: [msg("a", "assistant", [toolPart(tool)])] }), [], tool);
  }
  assert.deepEqual(derive({ messages: [msg("a", "assistant", [{ type: "patch", state: {} }])] }), []);
  assert.deepEqual(
    derive({ messages: [msg("a", "assistant", [toolPart("edit", { filePath: "/home/dev/q3.csv" })])] }),
    [],
  );
});

// ---------------------------------------------------------------------------
// 3. hosted pages
// ---------------------------------------------------------------------------

test("hosted page: other session excluded; isHosted; messageId/context from the newest announcing assistant message", () => {
  const link = "https://box.example/pages/mine";
  const out = derive({
    messages: [
      msg("a", "assistant", [textPart(`Here's your page: ${link}`)], 100),
      msg("a2", "assistant", [textPart(`updated ${link}`)], 300),
      msg("a3", "assistant", [textPart("later")], 400),
    ],
    pages: [
      page({ subdomain: "mine", url: link, createdAt: 150, expiresAt: 999 }),
      page({ subdomain: "other", url: "https://x.example/p", sessionID: "ses_b", createdAt: 300 }),
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "page:mine");
  assert.equal(out[0].isHosted, true);
  assert.equal(out[0].origin, "agent");
  assert.equal(out[0].label, "mine");
  assert.equal(out[0].messageId, "a2");
  assert.match(out[0].context, /updated/);
  assert.equal(out[0].expiresAt, 999);
  assert.equal(out[0].at, 150);
});

test("hosted page with no announcing message → null messageId/context; plan-subdomain page is NOT a link", () => {
  const out = derive({
    messages: [msg("a", "assistant", [textPart("no url at all")])],
    pages: [
      page({ subdomain: "preview", url: "https://box.example/pages/preview", createdAt: 500 }),
      page({ subdomain: "plan-sesa", url: "https://box.example/pages/plan-sesa" }),
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].messageId, null);
  assert.equal(out[0].context, null);
});

// ---------------------------------------------------------------------------
// 4. outbox
// ---------------------------------------------------------------------------

test("outbox: other session excluded; messageID carried; .mp4 → video/mp4 (kind file)", () => {
  const out = derive({
    outbox: [
      outboxRow({ name: "clip.mp4", path: "/o/clip.mp4", messageID: "msg-abc", expiresAt: 9999 }),
      outboxRow({ name: "x.csv", path: "/o/x.csv", sessionID: "ses_OTHER" }),
      outboxRow({ name: "shot.png", path: "/o/shot.png", size: 2048 }),
      outboxRow({ name: "x.ts", path: "/o/x.ts" }),
      outboxRow({ name: "q3.csv", path: "/o/q3.csv" }),
    ],
  });
  assert.equal(out.length, 4);
  const byLabel = Object.fromEntries(out.map((a) => [a.label, a]));
  assert.equal(byLabel["clip.mp4"].mime, "video/mp4");
  assert.equal(byLabel["clip.mp4"].kind, "file");
  assert.equal(byLabel["clip.mp4"].messageId, "msg-abc");
  assert.equal(byLabel["clip.mp4"].expiresAt, 9999);
  assert.equal(byLabel["clip.mp4"].origin, "agent");
  assert.equal(byLabel["shot.png"].kind, "image");
  assert.equal(byLabel["shot.png"].mime, "image/png");
  assert.equal(byLabel["q3.csv"].mime, "text/csv");
  assert.equal(byLabel["x.ts"].mime, null);
  assert.equal(byLabel["x.ts"].kind, "file");
  assert.equal(byLabel["q3.csv"].at, 5000);
  assert.equal(byLabel["q3.csv"].size, 1204);
});

test("user uploads and outbox files land in the same list", () => {
  const out = derive({
    messages: [msg("u", "user", [filePart({ filename: "mine.csv", url: "file:///home/dev/.manta-uploads/mine.csv" })])],
    outbox: [outboxRow({ name: "pushed.pdf", path: "/o/pushed.pdf", mtime: 2000 })],
  });
  assert.deepEqual(out.map((a) => a.origin).sort(), ["agent", "user"]);
});

// ---------------------------------------------------------------------------
// 5. plans
// ---------------------------------------------------------------------------

test("plan from text: title, steps, href joins the session directory, messageId", () => {
  const out = derive({
    messages: [
      msg("a", "assistant", [
        textPart("Plan:\n## Step one\n## Step two\n### Step two.a\nSee .opencode/plans/2026-08-15-ship-it.md"),
      ], 5000),
    ],
    directory: "/proj",
  });
  assert.equal(out.length, 1);
  const p = out[0];
  assert.equal(p.kind, "plan");
  assert.equal(p.origin, "agent");
  assert.equal(p.label, "ship it");
  assert.equal(p.href, "/proj/.opencode/plans/2026-08-15-ship-it.md");
  assert.equal(p.mime, "text/markdown");
  assert.equal(p.messageId, "a");
  assert.equal(p.plan.steps, 3);
  assert.equal(p.plan.status, "draft");
  assert.equal(p.plan.fileAvailable, true);
});

test("plan: unknown directory → relative href and fileAvailable false; leading ./ is stripped", () => {
  const out = derive({ messages: [msg("a", "assistant", [textPart("wrote ./.opencode/plans/2026-08-15-foo.md")], 1000)] });
  assert.equal(out[0].href, ".opencode/plans/2026-08-15-foo.md");
  assert.equal(out[0].plan.fileAvailable, false);
});

test("plan from a write tool's filePath; steps from the tool content", () => {
  const out = derive({
    messages: [
      msg("a", "assistant", [
        toolPart("write", {
          filePath: "/proj/.opencode/plans/2026-08-15-auto-publish.md",
          content: "# Auto-publish\n## One\n## Two\n",
        }),
      ], 5000),
    ],
    directory: "/proj/",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].label, "auto publish");
  assert.equal(out[0].href, "/proj/.opencode/plans/2026-08-15-auto-publish.md");
  assert.equal(out[0].plan.steps, 2);
});

test("plan from a patch part's files; a read tool is not an authoring signal; plain .md outside plans/ ignored", () => {
  const patch = derive({
    messages: [msg("a", "assistant", [{ type: "patch", files: ["/proj/.opencode/plans/x.md"] }], 100)],
    directory: "/proj",
  });
  assert.equal(patch.length, 1);
  assert.equal(patch[0].kind, "plan");
  assert.deepEqual(
    derive({ messages: [msg("a", "assistant", [toolPart("read", { filePath: "/proj/.opencode/plans/x.md" })], 5000)] }),
    [],
  );
  assert.deepEqual(derive({ messages: [msg("a", "assistant", [textPart("wrote ./notes/ideas.md")], 1000)] }), []);
});

test("plan is never also a file or a link; newest reference wins; synthetic parts skipped", () => {
  const out = derive({
    messages: [
      msg("a", "assistant", [textPart("plan: .opencode/plans/x.md and https://example.com/x")], 100),
      msg("a2", "assistant", [textPart(".opencode/plans/x.md")], 900),
      msg("a3", "assistant", [textPart(".opencode/plans/y.md", { synthetic: true })], 950),
    ],
  });
  assert.deepEqual(out.map((a) => a.kind), ["plan"]);
  assert.equal(out[0].at, 900);
  assert.equal(out[0].messageId, "a2");
});

test("plan steps fall back to the message text when the part carries none", () => {
  const out = derive({
    messages: [
      msg("a", "assistant", [textPart("## One\n## Two\n## Three"), toolPart("write", { filePath: "/p/.opencode/plans/z.md" })], 100),
    ],
    directory: "/p",
  });
  assert.equal(out[0].plan.steps, 3);
});

test("planRefsFromPart / planStepCount / planTitleFromPath", () => {
  assert.deepEqual(planRefsFromPart({ type: "text", text: "a .opencode/plans/a.md b .opencode/plans/a.md c .opencode/plans/b-1.md" }), [
    ".opencode/plans/a.md",
    ".opencode/plans/b-1.md",
  ]);
  assert.deepEqual(planRefsFromPart({ type: "tool", tool: "plan_exit", input: { planPath: ".opencode/plans/q.md" } }), [".opencode/plans/q.md"]);
  assert.deepEqual(planRefsFromPart({ type: "tool", tool: "bash", state: { input: { path: ".opencode/plans/q.md" } } }), []);
  assert.deepEqual(planRefsFromPart(null), []);
  // moved from chatUtils.test.ts (the renderer copy is deleted): every source, read ignored, dedupe within a part
  const part = (over) => ({ type: "tool", id: "p", messageID: "m", ...over });
  assert.deepEqual(planRefsFromPart(part({ type: "text", text: "Plan: .opencode/plans/a.md" })), [".opencode/plans/a.md"]);
  assert.deepEqual(
    planRefsFromPart(part({ tool: "write", state: { status: "completed", input: { filePath: ".opencode/plans/b.md" } } })),
    [".opencode/plans/b.md"],
  );
  assert.deepEqual(planRefsFromPart(part({ tool: "multiEdit", files: [".opencode/plans/c.md"] })), [".opencode/plans/c.md"]);
  assert.deepEqual(
    planRefsFromPart(part({ tool: "read", state: { status: "completed", input: { filePath: ".opencode/plans/ignored.md" } } })),
    [],
  );
  assert.deepEqual(
    planRefsFromPart(
      part({
        tool: "plan",
        state: { status: "completed", input: { path: ".opencode/plans/same.md" } },
        text: ".opencode/plans/same.md",
      }),
    ),
    [".opencode/plans/same.md"],
  );
  assert.equal(planStepCount("intro\n## Step one\n## Step two\n### sub\nbody\n## Step three"), 4);
  assert.equal(planStepCount("## A\n### B\n#### C"), 2);
  assert.equal(planStepCount(null), 0);
  assert.equal(planStepCount("no headings"), 0);
  assert.equal(planTitleFromPath("2026-08-15-ship_the-thing.md"), "ship the thing");
  assert.equal(planTitleFromPath("x.md"), "x");
});

// ---------------------------------------------------------------------------
// 6. dedupe / order / counts
// ---------------------------------------------------------------------------

test("dedupe keeps the greatest `at`; output is newest first; counts per kind", () => {
  const dup = derive({
    messages: [
      msg("u", "user", [filePart({ url: "file:///a/report.txt" })], 100),
      msg("u2", "user", [filePart({ url: "file:///A/Report.txt" })], 500),
    ],
  });
  assert.equal(dup.length, 1);
  assert.equal(dup[0].at, 500);
  assert.equal(dup[0].id, "u2-p0");

  const ordered = derive({
    messages: [
      msg("u", "user", [filePart({ url: "file:///a/one.txt", filename: "one.txt" })], 100),
      msg("u2", "user", [textPart("https://example.com/x")], 300),
      msg("a", "assistant", [filePart({ url: "file:///a/two.pdf", filename: "two.pdf" })], 200),
    ],
  });
  assert.deepEqual(ordered.map((a) => a.at), [300, 200, 100]);

  assert.deepEqual(
    countByKind([{ kind: "link" }, { kind: "image" }, { kind: "image" }, { kind: "file" }, { kind: "plan" }]),
    { link: 1, image: 2, file: 1, plan: 1 },
  );
  assert.deepEqual(countByKind([]), { link: 0, image: 0, file: 0, plan: 0 });
});

// ---------------------------------------------------------------------------
// 7. expiry
// ---------------------------------------------------------------------------

test("expiryState: null / expired / exactly 6h = soon / 7h = live", () => {
  const now = 1_000_000;
  assert.equal(expiryState(null, now), null);
  assert.equal(expiryState(now, now), "expired");
  assert.equal(expiryState(now - 1, now), "expired");
  assert.equal(expiryState(now + 6 * 3600_000, now), "soon");
  assert.equal(expiryState(now + 5 * 3600_000 + 59 * 60_000, now), "soon");
  assert.equal(expiryState(now + 7 * 3600_000, now), "live");
});

test("view: hosted no-TTL → never; plain file/link/plan → expiry null; outbox TTL → state at now", () => {
  const now = 10_000_000;
  const core = derive({
    messages: [msg("u", "user", [filePart(), textPart("https://example.com/x")], 100)],
    pages: [page({ subdomain: "forever", url: "https://box.example/pages/forever", expiresAt: null })],
    outbox: [outboxRow({ expiresAt: now + 2 * 3600_000 })],
  });
  const { items, counts } = view(core, now);
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.deepEqual(by["page:forever"].expiry, { state: "never", expiresAt: null });
  assert.equal(by["u-p0"].expiry, null);
  assert.deepEqual(by["outbox:/home/dev/.manta-outbox/ses_a/q3.csv"].expiry, { state: "soon", expiresAt: now + 2 * 3600_000 });
  assert.equal(items.every((i) => !("key" in i) && !("expiresAt" in i)), true);
  assert.deepEqual(counts, { link: 2, image: 0, file: 2, plan: 0 });
});

// ---------------------------------------------------------------------------
// 10. planPageResolution
// ---------------------------------------------------------------------------

test("planPageResolution: owned / collision / none / no base", () => {
  const sub = "plan-sesa";
  const base = "https://box.example";
  assert.deepEqual(
    planPageResolution({ sessionId: SID, pages: [page({ subdomain: sub, url: "https://box.example/pages/plan-sesa" })], baseUrl: base }),
    { pageUrl: "https://box.example/pages/plan-sesa", pageUrlReason: null },
  );
  // owned but the registry has no public URL → NOT the fallback
  assert.deepEqual(
    planPageResolution({ sessionId: SID, pages: [page({ subdomain: sub, url: "" })], baseUrl: base }),
    { pageUrl: null, pageUrlReason: "no-public-address" },
  );
  // collision: same subdomain, other session or no session → never the fallback
  for (const other of ["ses_other", null]) {
    assert.deepEqual(
      planPageResolution({ sessionId: SID, pages: [page({ subdomain: sub, sessionID: other })], baseUrl: base }),
      { pageUrl: null, pageUrlReason: "other-session" },
    );
  }
  // no registration
  assert.deepEqual(planPageResolution({ sessionId: SID, pages: [], baseUrl: base }), {
    pageUrl: "https://box.example/pages/plan-sesa",
    pageUrlReason: null,
  });
  assert.deepEqual(planPageResolution({ sessionId: SID, pages: [], baseUrl: "" }), {
    pageUrl: null,
    pageUrlReason: "no-public-address",
  });
  assert.deepEqual(planPageResolution({ sessionId: SID, pages: [], baseUrl: "not a url" }), {
    pageUrl: null,
    pageUrlReason: "no-public-address",
  });
});

test("plan item carries the resolved page url + reason", () => {
  const messages = [msg("a", "assistant", [toolPart("write", { filePath: "/p/.opencode/plans/x.md" })], 5000)];
  const owned = derive({ messages, directory: "/p", pages: [page({ subdomain: "plan-sesa", url: "https://box/pages/plan-sesa" })] });
  assert.equal(owned.length, 1);
  assert.equal(owned[0].plan.pageUrl, "https://box/pages/plan-sesa");
  assert.equal(owned[0].plan.pageUrlReason, null);
  const clash = derive({ messages, directory: "/p", pages: [page({ subdomain: "plan-sesa", sessionID: "ses_b" })] });
  assert.equal(clash[0].plan.pageUrl, null);
  assert.equal(clash[0].plan.pageUrlReason, "other-session");
  // an unrelated page still shows as a link beside the plan
  const both = derive({ messages, directory: "/p", pages: [page({ subdomain: "preview" })] });
  assert.deepEqual(both.map((a) => a.kind).sort(), ["link", "plan"]);
});

// ---------------------------------------------------------------------------
// 11. hosted page without a usable URL
// ---------------------------------------------------------------------------

test("hosted (non-plan) page with url '' is omitted; counted by omittedHostedPages", () => {
  const pages = [page({ subdomain: "nourl", url: "" }), page({ subdomain: "plan-sesa", url: "" }), page({ subdomain: "ftp", url: "ftp://x/y" })];
  const out = derive({ pages });
  assert.deepEqual(out, []);
  assert.deepEqual(omittedHostedPages({ pages, sessionId: SID }).map((p) => p.subdomain), ["nourl", "ftp"]);
});

// ---------------------------------------------------------------------------
// 8. service (fake clock, injected sources)
// ---------------------------------------------------------------------------

function fixture(over = {}) {
  const t = { now: 1_700_000_000_000 };
  const calls = { full: 0, tail: 0, pages: 0, outbox: 0 };
  const state = {
    messages: [
      msg("u", "user", [textPart("see https://example.com/x")], 1000),
      msg("a", "assistant", [textPart("done")], 2000, { time: { created: 2000, completed: 2100 } }),
    ],
    pages: [],
    outbox: [],
    directory: "/proj",
    base: "https://box.example",
    failPages: false,
    failMessages: false,
    failDirectory: false,
  };
  const svc = createArtifactsService({
    listMessages: async (_sid, o) => {
      if (state.failMessages) throw new Error("boom /secret/path");
      if (o?.limit) {
        calls.tail++;
        return state.messages.slice(-o.limit);
      }
      calls.full++;
      return state.messages;
    },
    listPages: async () => {
      calls.pages++;
      if (state.failPages) throw new Error("registry down");
      return state.pages;
    },
    listOutbox: async () => {
      calls.outbox++;
      return state.outbox;
    },
    sessionDirectory: async () => {
      if (state.failDirectory) throw new Error("dir down");
      return state.directory;
    },
    baseUrl: () => state.base,
    now: () => t.now,
    ...over,
  });
  return { svc, t, calls, state };
}

test("service: same key within ttl derives once across list() calls, expiry recomputed with the clock", async () => {
  const { svc, t, calls, state } = fixture();
  state.pages = [page({ subdomain: "p1", url: "https://box.example/pages/p1", expiresAt: t.now + 6 * 3600_000 + 10_000 })];
  const a = await svc.list(SID);
  assert.equal(calls.full, 1);
  assert.equal(a.sessionId, SID);
  assert.equal(a.generatedAt, t.now);
  assert.deepEqual(a.degraded, []);
  assert.equal(a.items.find((i) => i.id === "page:p1").expiry.state, "live");
  t.now += 20_000; // inside the 30 s ttl; now ≤ 6 h left → soon
  const b = await svc.list(SID);
  assert.equal(calls.full, 1, "no second full derivation");
  assert.equal(b.items.find((i) => i.id === "page:p1").expiry.state, "soon");
  assert.equal(b.generatedAt, t.now);
});

test("service: a new last message invalidates; text appended to the last part (same id/count) invalidates", async () => {
  const { svc, calls, state } = fixture();
  await svc.list(SID);
  state.messages = [...state.messages, msg("u2", "user", [textPart("https://new.example/z")], 3000)];
  const r = await svc.list(SID);
  assert.equal(calls.full, 2);
  assert.equal(r.counts.link, 2);

  // grow the SAME final part in place
  const last = state.messages[state.messages.length - 1];
  state.messages = [
    ...state.messages.slice(0, -1),
    { ...last, parts: [{ ...last.parts[0], text: `${last.parts[0].text} and https://third.example/w` }] },
  ];
  const r2 = await svc.list(SID);
  assert.equal(calls.full, 3);
  assert.equal(r2.counts.link, 3);
});

test("service: baseUrl change invalidates (plan pageUrl + hosted links follow)", async () => {
  const { svc, calls, state } = fixture();
  state.messages = [msg("a", "assistant", [textPart(".opencode/plans/x.md")], 100)];
  const r1 = await svc.list(SID);
  assert.equal(r1.items[0].plan.pageUrl, "https://box.example/pages/plan-sesa");
  state.base = "https://other.example";
  const r2 = await svc.list(SID);
  assert.equal(calls.full, 2);
  assert.equal(r2.items[0].plan.pageUrl, "https://other.example/pages/plan-sesa");
  state.base = "";
  const r3 = await svc.list(SID);
  assert.equal(r3.items[0].plan.pageUrl, null);
  assert.equal(r3.items[0].plan.pageUrlReason, "no-public-address");
});

test("service: republished page (same expiresAt, new createdAt/url) invalidates; outbox sidecar changes invalidate", async () => {
  const { svc, calls, state } = fixture();
  state.pages = [page({ subdomain: "p", url: "https://box.example/pages/p", createdAt: 1, expiresAt: 5_000_000_000_000 })];
  await svc.list(SID);
  state.pages = [page({ subdomain: "p", url: "https://box.example/pages/p", createdAt: 2, expiresAt: 5_000_000_000_000 })];
  const r = await svc.list(SID);
  assert.equal(calls.full, 2);
  assert.equal(r.items.find((i) => i.id === "page:p").at, 2);
  state.pages = [page({ subdomain: "p", url: "https://box2.example/pages/p", createdAt: 2, expiresAt: 5_000_000_000_000 })];
  const r2 = await svc.list(SID);
  assert.equal(calls.full, 3);
  assert.equal(r2.items.find((i) => i.id === "page:p").href, "https://box2.example/pages/p");

  state.outbox = [outboxRow({ expiresAt: 10, messageID: null })];
  await svc.list(SID);
  assert.equal(calls.full, 4);
  state.outbox = [outboxRow({ expiresAt: 20, messageID: null })]; // same mtime
  await svc.list(SID);
  assert.equal(calls.full, 5);
  state.outbox = [outboxRow({ expiresAt: 20, messageID: "msg_9" })]; // same mtime
  const r3 = await svc.list(SID);
  assert.equal(calls.full, 6);
  assert.equal(r3.items.find((i) => i.id.startsWith("outbox:")).messageId, "msg_9");
});

test("service: cache age is measured from derivation (hits at 10s and 25s, re-derive at 31s)", async () => {
  const { svc, t, calls } = fixture();
  await svc.list(SID); // derived at t0
  t.now += 10_000;
  await svc.list(SID);
  t.now += 15_000; // 25 s after derivation — a hit must not have refreshed the age
  await svc.list(SID);
  assert.equal(calls.full, 1);
  t.now += 6_000; // 31 s
  await svc.list(SID);
  assert.equal(calls.full, 2);
});

test("service: concurrent calls for one session share one derivation", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let full = 0;
  const svc = createArtifactsService({
    listMessages: async (_sid, o) => {
      if (o?.limit) return [msg("u", "user", [textPart("hi")], 1000)];
      full++;
      await gate;
      return [msg("u", "user", [textPart("hi https://a.example/x")], 1000)];
    },
    listPages: async () => [],
    listOutbox: async () => [],
    sessionDirectory: async () => null,
    baseUrl: () => "",
    now: () => 1_700_000_000_000,
  });
  const p1 = svc.list(SID);
  const p2 = svc.list(SID);
  await new Promise((r) => setTimeout(r, 20));
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(full, 1);
  assert.equal(a.counts.link, 1);
  assert.equal(b.counts.link, 1);
});

test("service: failing listPages → degraded ['pages'] and no hosted items, then recovery returns them", async () => {
  const { svc, state, calls } = fixture();
  state.pages = [page({ subdomain: "p", url: "https://box.example/pages/p" })];
  state.failPages = true;
  const bad = await svc.list(SID);
  assert.deepEqual(bad.degraded, ["pages"]);
  assert.equal(bad.items.some((i) => i.isHosted), false);
  state.failPages = false;
  const good = await svc.list(SID);
  assert.deepEqual(good.degraded, []);
  assert.equal(good.items.some((i) => i.isHosted), true);
  assert.equal(calls.full, 2, "the failure → recovery transition re-derives");
  // a cached core never carries a stale `degraded`
  const again = await svc.list(SID);
  assert.deepEqual(again.degraded, []);
  assert.equal(calls.full, 2);
});

test("service: failing directory → degraded ['directory'], plan has no file; hosted page without URL → ['public-address']", async () => {
  const { svc, state } = fixture();
  state.messages = [msg("a", "assistant", [textPart(".opencode/plans/x.md")], 100)];
  state.failDirectory = true;
  const r = await svc.list(SID);
  assert.deepEqual(r.degraded, ["directory"]);
  assert.equal(r.items[0].plan.fileAvailable, false);

  state.failDirectory = false;
  state.pages = [page({ subdomain: "nourl", url: "" })];
  const r2 = await svc.list(SID);
  assert.deepEqual(r2.degraded, ["public-address"]);
  assert.equal(r2.counts.link, 0);
});

test("service: failing transcript read throws the safe literal; blank sessionId throws", async () => {
  const { svc, state } = fixture();
  state.failMessages = true;
  await assert.rejects(svc.list(SID), (e) => {
    assert.equal(e.message, "Couldn't read this conversation's artifacts");
    assert.doesNotMatch(e.message, /secret/);
    return true;
  });
  await assert.rejects(svc.list(""), { message: "artifacts:list needs a sessionId" });
  await assert.rejects(svc.list("   "), { message: "artifacts:list needs a sessionId" });
  await assert.rejects(svc.list(undefined), { message: "artifacts:list needs a sessionId" });
});

test("service: maxSessions bounds the cache (a re-list of some session re-derives)", async () => {
  const { svc, calls } = fixture({ maxSessions: 2 });
  await svc.list("s1");
  await svc.list("s2");
  await svc.list("s3");
  assert.equal(calls.full, 3);
  await svc.list("s1");
  await svc.list("s2");
  await svc.list("s3");
  // with room for only two cores, the second pass must re-derive at least one
  assert.ok(calls.full > 3, `expected a re-derive, full=${calls.full}`);
});

// ---------------------------------------------------------------------------
// 9. rpc wiring
// ---------------------------------------------------------------------------

test("rpc: artifacts:list dispatches to the service with a single options object", async () => {
  const { svc } = fixture();
  const handlers = { "artifacts:list": (opts) => svc.list(opts?.sessionId) };
  const r = await dispatch(handlers, "artifacts:list", [{ sessionId: SID }]);
  assert.equal(r.sessionId, SID);
  assert.ok(Array.isArray(r.items));
  assert.deepEqual(Object.keys(r.counts).sort(), ["file", "image", "link", "plan"]);
  assert.ok(Array.isArray(r.degraded));
  await assert.rejects(dispatch(handlers, "artifacts:list", [{}]), { message: "artifacts:list needs a sessionId" });
});
