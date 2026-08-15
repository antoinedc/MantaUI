import { describe, it, expect } from "vitest";
import type { OpencodeMessage, ServedPageMeta } from "../shared/types";
import {
  deriveArtifacts,
  groupByDay,
  pageState,
  countByKind,
  planStepCount,
  planStatus,
  type Artifact,
} from "./artifacts";

// ── builders ────────────────────────────────────────────────────────────────

function msg(
  id: string,
  role: "user" | "assistant",
  parts: Array<Record<string, unknown>>,
  created = id === "u" ? 1000 : 2000,
): OpencodeMessage {
  return {
    info: {
      id,
      sessionID: "ses_a",
      role,
      ...(created > 0 ? { time: { created } } : {}),
    },
    parts: parts.map((p, i) => ({ id: `${id}-p${i}`, messageID: id, ...(p as object) })),
  } as unknown as OpencodeMessage;
}

function filePart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "file", mime: "text/plain", url: "file:///home/u/report.txt", filename: "report.txt", ...overrides };
}

function textPart(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "text", text, ...overrides };
}

function toolPart(tool: string): Record<string, unknown> {
  return { type: "tool", tool, state: { status: "completed" } };
}

function page(p: Partial<ServedPageMeta>): ServedPageMeta {
  return { subdomain: "preview", url: "", createdAt: 0, expiresAt: null, sessionID: "ses_a", ...p };
}

function fileArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "id",
    kind: "file",
    origin: "agent",
    key: "/home/u/report.txt",
    label: "report.txt",
    href: "/home/u/report.txt",
    mime: "text/plain",
    size: null,
    at: 2000,
    messageId: null,
    context: null,
    expiresAt: null,
    ...overrides,
  };
}

const img = (href: string, at: number) => fileArtifact({ kind: "image", key: href.toLowerCase(), href, label: href, at });

// ── extraction rules ────────────────────────────────────────────────────────

describe("deriveArtifacts", () => {
  it("splits file parts into image vs file by mime and strips file://", () => {
    const messages = [
      msg("u", "user", [filePart({ mime: "image/png", url: "file:///a/pic.png", filename: "pic.png" })]),
      msg("a", "assistant", [filePart({ mime: "application/pdf", url: "file:///b/doc.pdf", filename: "doc.pdf" })]),
    ];
    const out = deriveArtifacts(messages, [], "ses_a");
    expect(out).toHaveLength(2);
    const image = out.find((a) => a.kind === "image")!;
    const file = out.find((a) => a.kind === "file")!;
    expect(image.href).toBe("/a/pic.png");
    expect(image.origin).toBe("user");
    expect(file.href).toBe("/b/doc.pdf");
    expect(file.mime).toBe("application/pdf");
  });

  it("assistant file part → origin agent", () => {
    const messages = [msg("a", "assistant", [filePart({ url: "file:///x/agent.bin", filename: "agent.bin" })])];
    const out = deriveArtifacts(messages, [], "ses_a");
    expect(out[0].origin).toBe("agent");
    expect(out[0].kind).toBe("file");
  });

  it("threads the file part's byte size through as `size`", () => {
    const messages = [msg("u", "user", [filePart({ size: 1_258_291 })])];
    const out = deriveArtifacts(messages, [], "ses_a");
    expect(out[0].size).toBe(1_258_291);
  });

  it("leaves size null when the file part carries none (links/pages too)", () => {
    const withOut = deriveArtifacts([msg("u", "user", [filePart()])], [], "ses_a");
    expect(withOut[0].size).toBeNull();
    const link = deriveArtifacts([msg("u", "user", [textPart("https://example.com")])], [], "ses_a");
    expect(link[0].size).toBeNull();
    const p = deriveArtifacts([], [page({ createdAt: 0 })], "ses_a");
    expect(p[0].size).toBeNull();
  });

  it("uses filename, falling back to last path segment of url", () => {
    const a = deriveArtifacts([msg("a", "assistant", [filePart({ url: "file:///dir/no-name", filename: undefined })])], [], "ses_a");
    expect(a[0].label).toBe("no-name");
  });

  it("user text part with one URL → link with context (URL removed)", () => {
    const messages = [msg("u", "user", [textPart("see https://example.com/path and more")])];
    const out = deriveArtifacts(messages, [], "ses_a");
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("link");
    expect(out[0].origin).toBe("user");
    expect(out[0].href).toBe("https://example.com/path");
    expect(out[0].label).toBe("example.com/path");
    expect(out[0].context).toBe("see and more");
    expect(out[0].mime).toBeNull();
    // single link keeps the part id (spec: "the part id")
    expect(out[0].id).toBe("u-p0");
  });

  it("user text part with two URLs → two artifacts", () => {
    const messages = [msg("u", "user", [textPart("https://a.com/x https://b.com/y")])];
    const out = deriveArtifacts(messages, [], "ses_a");
    expect(out).toHaveLength(2);
    expect(out.map((a) => a.href).sort()).toEqual(["https://a.com/x", "https://b.com/y"]);
    // two links from one part must NOT share an id (React-key collision guard)
    expect(new Set(out.map((a) => a.id)).size).toBe(2);
  });

  it("file part carries its owning message id (jump target)", () => {
    const messages = [msg("u", "user", [filePart()])];
    const out = deriveArtifacts(messages, [], "ses_a");
    expect(out[0].messageId).toBe("u");
  });

  it("a pasted user link carries its owning message id, and is not hosted", () => {
    const messages = [msg("u", "user", [textPart("see https://example.com/x")])];
    const out = deriveArtifacts(messages, [], "ses_a");
    expect(out[0].kind).toBe("link");
    expect(out[0].messageId).toBe("u");
    expect(out[0].isHosted).toBeFalsy();
  });

  it("a hosted page artifact is flagged isHosted (chip always present)", () => {
    const pages = [
      page({ subdomain: "preview", url: "https://box/pages/preview", sessionID: "ses_a", createdAt: 100 }),
    ];
    const out = deriveArtifacts([], pages, "ses_a");
    expect(out[0].isHosted).toBe(true);
  });

  it("assistant text part with a URL → NO artifact", () => {
    const messages = [msg("a", "assistant", [textPart("docs at https://example.com/docs")])];
    expect(deriveArtifacts(messages, [], "ses_a")).toEqual([]);
  });

  it("tool parts of every kind → NO artifacts", () => {
    for (const tool of ["read", "write", "edit", "bash", "webfetch"]) {
      const messages = [msg("a", "assistant", [toolPart(tool)])];
      expect(deriveArtifacts(messages, [], "ses_a"), `tool:${tool}`).toEqual([]);
    }
  });

  it("outbox file → file artifact (origin agent, scoped to its session)", () => {
    const got = deriveArtifacts([], [], "ses_a", [
      { path: "/home/dev/.manta-outbox/q3-revenue.csv", name: "q3-revenue.csv", size: 1204, sessionID: "ses_a", mtime: 5000, expiresAt: 5000 + 604800000 },
    ]);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      kind: "file",
      origin: "agent",
      label: "q3-revenue.csv",
      href: "/home/dev/.manta-outbox/q3-revenue.csv",
      mime: "text/csv",
      size: 1204,
      at: 5000,
      messageId: null,
      context: null,
      expiresAt: 5000 + 604800000,
    });
  });

  it("outbox files from another session are excluded (workspace-linked)", () => {
    const got = deriveArtifacts([], [], "ses_a", [
      { path: "/home/dev/.manta-outbox/x.csv", name: "x.csv", size: 1, sessionID: "ses_OTHER", mtime: 1000, expiresAt: null },
    ]);
    expect(got).toEqual([]);
  });

  it("outbox image file → image artifact with its mime", () => {
    const got = deriveArtifacts([], [], "ses_a", [
      { path: "/home/dev/.manta-outbox/shot.png", name: "shot.png", size: 2048, sessionID: "ses_a", mtime: 1000, expiresAt: null },
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].kind).toBe("image");
    expect(got[0].mime).toBe("image/png");
  });

  it("outbox file with an unknown extension keeps a null mime (file kind)", () => {
    const got = deriveArtifacts([], [], "ses_a", [
      { path: "/home/dev/.manta-outbox/archive.bin", name: "archive.bin", size: 99, sessionID: "ses_a", mtime: 1000, expiresAt: null },
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].kind).toBe("file");
    expect(got[0].mime).toBeNull();
  });

  it("user uploads and outbox files both land in the same list", () => {
    const messages = [
      msg("u", "user", [filePart({ filename: "mine.csv", url: "file:///home/dev/.manta-uploads/mine.csv" })]),
    ];
    const got = deriveArtifacts(messages, [], "ses_a", [
      { path: "/home/dev/.manta-outbox/pushed.pdf", name: "pushed.pdf", size: 100, sessionID: "ses_a", mtime: 2000, expiresAt: null },
    ]);
    expect(got.length).toBe(2);
    expect(got.map((a) => a.origin).sort()).toEqual(["agent", "user"]);
  });

  it("edit tool part → NO artifact (modifies existing source, not produced)", () => {
    const messages = [
      msg("a", "assistant", [
        {
          type: "tool",
          tool: "edit",
          state: { status: "completed", input: { filePath: "/home/dev/q3-revenue.csv" } },
        },
      ]),
    ];
    expect(deriveArtifacts(messages, [], "ses_a")).toEqual([]);
  });

  it("patch part → NO artifact", () => {
    const messages = [msg("a", "assistant", [{ type: "patch", state: {} }])];
    expect(deriveArtifacts(messages, [], "ses_a")).toEqual([]);
  });

  it("synthetic and ignored text parts are skipped", () => {
    const messages = [
      msg("u", "user", [textPart("https://example.com/1", { synthetic: true })]),
      msg("u2", "user", [textPart("https://example.com/2", { ignored: true })], 3000),
    ];
    expect(deriveArtifacts(messages, [], "ses_a")).toEqual([]);
  });

  it("pages are filtered by sessionID and matched to their announcing message", () => {
    const link = "https://box.example/pages/preview";
    const messages = [
      msg("a", "assistant", [textPart(`Here's your page: ${link}`)], 100),
      msg("a2", "assistant", [textPart("later")], 200),
    ];
    const pages = [
      page({ subdomain: "mine", url: link, sessionID: "ses_a", createdAt: 150, expiresAt: 999 }),
      page({ subdomain: "other", url: "https://x/p", sessionID: "ses_b", createdAt: 300, expiresAt: 999 }),
    ];
    const out = deriveArtifacts(messages, pages, "ses_a");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("page:mine");
    expect(out[0].origin).toBe("agent");
    expect(out[0].label).toBe("mine");
    expect(out[0].expiresAt).toBe(999);
    expect(out[0].messageId).toBe("a");
    expect(out[0].context).toContain("Here's your page");
  });

  it("a page with no announcing message → messageId null", () => {
    const pages = [page({ subdomain: "preview", url: "https://box.example/pages/preview", sessionID: "ses_a", createdAt: 500 })];
    const messages = [msg("a", "assistant", [textPart("no url at all")])];
    const out = deriveArtifacts(messages, pages, "ses_a");
    expect(out[0].messageId).toBeNull();
    expect(out[0].context).toBeNull();
  });

  it("dedupe keeps the newest of two same-href items", () => {
    const out = deriveArtifacts(
      [
        msg("u", "user", [filePart({ url: "file:///a/report.txt", filename: "report.txt" })], 100),
        msg("u2", "user", [filePart({ url: "file:///a/report.txt", filename: "report.txt" })], 500),
      ],
      [],
      "ses_a",
    );
    expect(out).toHaveLength(1);
    expect(out[0].at).toBe(500);
    expect(out[0].id).toBe("u2-p0");
  });

  it("ordering is newest-first overall", () => {
    const out = deriveArtifacts(
      [
        msg("u", "user", [filePart({ url: "file:///a/one.txt", filename: "one.txt" })], 100),
        msg("u2", "user", [textPart("https://example.com/x")], 300),
        msg("a", "assistant", [filePart({ url: "file:///a/two.pdf", filename: "two.pdf" })], 200),
      ],
      [],
      "ses_a",
    );
    expect(out.map((a) => a.at)).toEqual([300, 200, 100]);
  });
});

// ── day grouping ────────────────────────────────────────────────────────────

describe("groupByDay", () => {
  // now = Wed 5 Aug 2026, 12:00 local
  const now = new Date(2026, 7, 5, 12, 0, 0).getTime();
  const today = new Date(2026, 7, 5, 9, 0).getTime();
  const yesterday = new Date(2026, 7, 4, 9, 0).getTime();
  const older = new Date(2026, 7, 3, 9, 0).getTime();

  it("groups Today / Yesterday / older with item order preserved and newest first", () => {
    // The older-group label follows the OS locale (Intl), so derive the
    // expectation rather than hardcoding an en-US string.
    const olderLabel = new Intl.DateTimeFormat(undefined, {
      weekday: "short", day: "numeric", month: "short",
    }).format(older);
    const out = groupByDay(
      [img("/a/today2", today + 1000), img("/a/older", older), img("/a/today1", today), img("/a/yest", yesterday)],
      now,
    );
    expect(out.map((g) => g.label)).toEqual(["Today", "Yesterday", olderLabel]);
    expect(out[0].items.map((a) => a.href)).toEqual(["/a/today2", "/a/today1"]);
    expect(out[1].items.map((a) => a.href)).toEqual(["/a/yest"]);
    expect(out[2].items.map((a) => a.href)).toEqual(["/a/older"]);
    expect(out[2].label).toContain("3");
  });

  it("empty input → empty groups", () => {
    expect(groupByDay([], now)).toEqual([]);
  });
});

// ── expiry state ────────────────────────────────────────────────────────────

describe("pageState", () => {
  const now = 1_000_000;

  it("expired exactly at now", () => {
    expect(pageState(now, now)).toBe("expired");
  });

  it("5h59m → soon", () => {
    expect(pageState(now + 5 * 3600 * 1000 + 59 * 60 * 1000, now)).toBe("soon");
  });

  it("6h01m → live", () => {
    expect(pageState(now + 6 * 3600 * 1000 + 60 * 1000, now)).toBe("live");
  });

  it("null expiresAt → null", () => {
    expect(pageState(null, now)).toBeNull();
  });
});

// ── plan artifacts ──────────────────────────────────────────────────────────

describe("plan artifacts", () => {
  it("derives a plan artifact from a .opencode/plans path in the transcript", () => {
    const messages = [
      msg("a", "assistant", [
        textPart(
          "Here's the plan I wrote:\n## Step one\n## Step two\n### Step two.a\nSee .opencode/plans/2026-08-15-ship-the-thing.md",
        ),
      ], 5000),
    ];
    const out = deriveArtifacts(messages, [], "ses_a", [], "/proj");
    expect(out).toHaveLength(1);
    const plan = out[0];
    expect(plan.kind).toBe("plan");
    expect(plan.origin).toBe("agent");
    expect(plan.label).toBe("ship the thing");
    expect(plan.href).toBe("/proj/.opencode/plans/2026-08-15-ship-the-thing.md");
    expect(plan.mime).toBe("text/markdown");
    expect(plan.messageId).toBe("a");
    // Step count is derived from the announcing message's markdown headings.
    expect(plan.planStepCount).toBe(3);
    expect(plan.planStatus).toBe("draft");
  });

  it("handles a leading ./, keeps the relative href without a cwd", () => {
    const messages = [
      msg("a", "assistant", [textPart("wrote ./.opencode/plans/2026-08-15-foo.md")], 1000),
    ];
    const out = deriveArtifacts(messages, [], "ses_a");
    expect(out[0].kind).toBe("plan");
    expect(out[0].href).toBe(".opencode/plans/2026-08-15-foo.md");
  });

  it("a plan is NOT also emitted as a file or a link (no double-counting)", () => {
    // The same message references a plan path AND a real URL: the plan path is
    // never an https URL, so each yields exactly one artifact of its own kind.
    const messages = [
      msg("a", "assistant", [textPart("plan: .opencode/plans/2026-08-15-foo.md and https://example.com/x")], 1000),
    ];
    // The URL is in ASSISTANT text, so it yields no link; the plan ref does.
    const out = deriveArtifacts(messages, [], "ses_a");
    expect(out.map((a) => a.kind)).toEqual(["plan"]);
    expect(out.filter((a) => a.kind === "file")).toHaveLength(0);
    expect(out.filter((a) => a.kind === "link")).toHaveLength(0);
  });

  it("dedupes plan refs to the same path, keeping the newest message", () => {
    const messages = [
      msg("a", "assistant", [textPart(".opencode/plans/x.md")], 100),
      msg("a2", "assistant", [textPart(".opencode/plans/x.md")], 900),
    ];
    const out = deriveArtifacts(messages, [], "ses_a");
    expect(out).toHaveLength(1);
    expect(out[0].at).toBe(900);
    expect(out[0].messageId).toBe("a2");
  });

  it("does not create a plan artifact from a plain .md path outside plans/", () => {
    const messages = [msg("a", "assistant", [textPart("wrote ./notes/ideas.md")], 1000)];
    expect(deriveArtifacts(messages, [], "ses_a")).toEqual([]);
  });

  it("no plan refs → panel-equivalent empty list", () => {
    expect(
      deriveArtifacts(
        [msg("u", "user", [textPart("just a message")])],
        [],
        "ses_a",
      ),
    ).toEqual([]);
  });
});

describe("planStepCount", () => {
  it("counts ## and ### step headings, ignores body text", () => {
    expect(
      planStepCount("intro\n## Step one\n## Step two\n### sub\nbody\n## Step three"),
    ).toBe(4);
  });
  it("returns 0 for null or heading-less text", () => {
    expect(planStepCount(null)).toBe(0);
    expect(planStepCount("no headings here")).toBe(0);
  });
});

describe("planStatus", () => {
  it("maps the lifecycle: draft → approved → building → done", () => {
    expect(planStatus({})).toBe("draft");
    expect(planStatus({ approved: true })).toBe("approved");
    expect(planStatus({ running: true })).toBe("building");
    expect(planStatus({ completed: true })).toBe("done");
  });
  it("completed wins over running/approved", () => {
    expect(planStatus({ completed: true, running: true, approved: true })).toBe("done");
    expect(planStatus({ running: true, approved: true })).toBe("building");
  });
});

// ── counts ──────────────────────────────────────────────────────────────────

describe("countByKind", () => {
  it("counts mixed input", () => {
    const out = countByKind([
      fileArtifact({ kind: "link" }),
      fileArtifact({ kind: "image" }),
      fileArtifact({ kind: "image" }),
      fileArtifact({ kind: "file" }),
      fileArtifact({ kind: "plan" }),
    ]);
    expect(out).toEqual({ link: 1, image: 2, file: 1, plan: 1 });
  });

  it("includes plans in the count", () => {
    const out = countByKind([fileArtifact({ kind: "plan" }), fileArtifact({ kind: "plan" })]);
    expect(out.plan).toBe(2);
  });

  it("empty input → zeroed counts", () => {
    expect(countByKind([])).toEqual({ link: 0, image: 0, file: 0, plan: 0 });
  });
});
