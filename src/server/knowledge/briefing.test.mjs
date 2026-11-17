import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NOTES_HEADER, RULES_HEADER, composeBriefing, createBriefings } from "./briefing.mjs";
import { createSettings } from "./settings.mjs";
import { memState, tmpDir } from "./testHelpers.mjs";

const SLUG = "alpha-0123456789";
const SID = "ses_abc123";
const est = (t) => Math.ceil(String(t).length / 4);

async function rig({ pages = {}, sessions = {}, mapped = { [SID]: SLUG }, cto = new Set(), active = true, stored, directoryProject = SLUG } = {}) {
  const state = await memState();
  const dir = await tmpDir("knowledge-briefing-");
  let t = 1_000_000_000_000;
  const store = { read: async (p) => (p in pages ? pages[p] : null), listPages: async () => Object.keys(pages).sort() };
  const registry = {
    identify: async () => (directoryProject ? { slug: directoryProject } : null),
    list: async () => [{ slug: SLUG }],
    get: async (s) => (s === SLUG ? { slug: s, canonicalId: "github.com/o/alpha" } : null),
  };
  const cfg = { knowledge: stored };
  const settings = createSettings({ config: { get: async () => cfg, update: async () => {} }, registry });
  const flags = { active };
  const b = createBriefings({
    state,
    store,
    registry,
    sessionMap: { get: (id) => (mapped[id] ? { slug: mapped[id] } : null) },
    settings,
    estimateTokens: est,
    getSession: async (id) => {
      if (sessions[id] === "throw") throw new Error("boom");
      return sessions[id] ?? { directory: "/repo/a" };
    },
    isCtoSession: async (id) => cto.has(id),
    isActive: () => flags.active,
    dir,
    now: () => t,
  });
  return { b, dir, pages, state, flags, advance: (ms) => (t += ms) };
}

const overview = (briefing) => `---\ntitle: Overview\n---\n# Overview\n\n## Briefing\n\n${briefing}\n\n## Other\n\nx\n`;
const runbook = (title, first) => `---\ntitle: ${title}\nverified: 2026-11-01\n---\n${first}\n`;

test("composeBriefing: two parts in order, rules first; empty when there is nothing", () => {
  const t = composeBriefing({ rules: ["Use pnpm", "Never force-push"], section: "Deploys go through CI.", entries: [{ title: "Deploy", summary: "tag and push", path: "projects/x/runbooks/deploy.md" }], estimateTokens: est });
  const lines = t.split("\n");
  assert.equal(lines[0], RULES_HEADER);
  assert.equal(lines[1], "- Use pnpm");
  assert.ok(lines.includes(NOTES_HEADER));
  assert.ok(t.indexOf(RULES_HEADER) < t.indexOf(NOTES_HEADER));
  assert.match(t, /- Deploy: tag and push \(page:projects\/x\/runbooks\/deploy\.md\)/);
  assert.equal(composeBriefing({ estimateTokens: est }), "");
  assert.ok(!composeBriefing({ section: "only notes", estimateTokens: est }).includes(RULES_HEADER));
});

test("composeBriefing: ≤1,500 tokens, truncated from the bottom of part 2 first; rules survive", () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ title: `Runbook ${i}`, summary: "s".repeat(1000), path: `projects/x/runbooks/r${i}.md` }));
  const t = composeBriefing({ rules: ["Rule A"], section: "sec", entries, estimateTokens: est });
  assert.ok(est(t) <= 1500);
  assert.ok(t.includes("- Rule A"));
  assert.ok(t.includes("Runbook 0"));
  assert.ok(!t.includes("Runbook 9"));
  const huge = composeBriefing({ rules: Array.from({ length: 400 }, (_, i) => `rule ${i} ${"x".repeat(40)}`), estimateTokens: est });
  assert.ok(est(huge) <= 1500);
  assert.ok(huge.includes("rule 0 "));
  assert.equal(composeBriefing({ section: Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n"), estimateTokens: est }).split("\n").length, 1 + 60);
});

test("precompute: rules.md bullets (box-only), the overview Briefing section, runbooks most-used first, written per project", async () => {
  const { b, dir, state } = await rig({
    pages: {
      [`projects/${SLUG}/rules.md`]: "# Rules\n\n- Use pnpm, never npm\n- Run typecheck before pushing\n",
      [`projects/${SLUG}/overview.md`]: overview("Monorepo. API in apps/api."),
      [`projects/${SLUG}/runbooks/deploy.md`]: runbook("Deploy", "Tag a release and push the tag."),
      [`projects/${SLUG}/runbooks/rollback.md`]: runbook("Rollback", "Revert the tag."),
      "commons/howto/ssh.md": runbook("SSH setup", "Add your key."),
    },
  });
  state.db.prepare("INSERT INTO page_use (path, uses) VALUES (?, 5)").run(`projects/${SLUG}/runbooks/rollback.md`);
  const text = await b.precompute(SLUG);
  assert.match(text, /- Use pnpm, never npm/);
  assert.match(text, /Monorepo\. API in apps\/api\./);
  assert.ok(text.indexOf("Rollback") < text.indexOf("Deploy")); // used more → first
  assert.match(text, /SSH setup/);
  assert.equal(await readFile(join(dir, `project-${SLUG}.txt`), "utf8"), text);
  assert.ok(!text.includes("## Other"));
});

test("private projects don't get commons how-tos; outward repo modes don't repeat rules the repo carries", async () => {
  const pages = { [`projects/${SLUG}/rules.md`]: "- Rule one\n", "commons/howto/ssh.md": runbook("SSH setup", "Add your key."), [`projects/${SLUG}/overview.md`]: overview("Notes.") };
  const priv = await rig({ pages, stored: { projects: { [SLUG]: { sharing: "private" } } } });
  const t1 = await priv.b.precompute(SLUG);
  assert.ok(!t1.includes("SSH setup"));
  assert.ok(t1.includes("Rule one"));
  const outward = await rig({ pages, stored: { projects: { [SLUG]: { repoRules: "pull-request" } } } }); // no forge wired → effective box-only
  assert.ok((await outward.b.precompute(SLUG)).includes("Rule one"));
});

test("first request: {text, token}; ack pins the bytes — later wiki changes never alter that session's briefing", async () => {
  const r = await rig({ pages: { [`projects/${SLUG}/overview.md`]: overview("First version.") } });
  await r.b.precompute(SLUG);
  const first = await r.b.request({ sessionID: SID, assistantMessages: 0 });
  assert.match(first.text, /First version\./);
  assert.match(first.token, /^[0-9a-f]{16}$/);
  assert.deepEqual(r.b.ack({ sessionID: SID, token: first.token }), { ok: true });
  r.pages[`projects/${SLUG}/overview.md`] = overview("Second version.");
  await r.b.precompute(SLUG);
  const later = await r.b.request({ sessionID: SID, assistantMessages: 7 });
  assert.equal(later.text, first.text);
  assert.equal(later.token, first.token);
  assert.equal(await readFile(join(r.dir, `${SID}.txt`), "utf8"), first.text);
  // idempotent ack
  assert.deepEqual(r.b.ack({ sessionID: SID, token: first.token }), { ok: true });
  // a different session gets the new text
  const other = await r.b.request({ sessionID: "ses_other1", directory: "/repo/a", assistantMessages: 0 });
  assert.match(other.text, /Second version\./);
});

test("without an ack the bytes are not pinned: the same token is reused while unchanged, a fresh one if the text changed", async () => {
  const r = await rig({ pages: { [`projects/${SLUG}/overview.md`]: overview("v1") } });
  await r.b.precompute(SLUG);
  const a = await r.b.request({ sessionID: SID, assistantMessages: 0 });
  const a2 = await r.b.request({ sessionID: SID, assistantMessages: 1 });
  assert.equal(a2.token, a.token);
  r.pages[`projects/${SLUG}/overview.md`] = overview("v2");
  await r.b.precompute(SLUG);
  const b = await r.b.request({ sessionID: SID, assistantMessages: 0 });
  assert.notEqual(b.token, a.token);
  assert.throws(() => r.b.ack({ sessionID: SID, token: a.token }), (e) => e.code === "stale-token" && e.status === 409);
  assert.deepEqual(r.b.ack({ sessionID: SID, token: b.token }), { ok: true });
});

test("never inserted mid-conversation: a session past its first assistant message gets '' and keeps getting ''", async () => {
  const r = await rig({ pages: { [`projects/${SLUG}/overview.md`]: overview("Hello.") } });
  await r.b.precompute(SLUG);
  assert.deepEqual(await r.b.request({ sessionID: SID, assistantMessages: 4 }), { text: "", token: null });
  assert.deepEqual(await r.b.request({ sessionID: SID, assistantMessages: 0 }), { text: "", token: null }); // stored empty
  // unacked pending then a later request after the conversation moved on → empty
  const r2 = await rig({ pages: { [`projects/${SLUG}/overview.md`]: overview("Hello.") } });
  await r2.b.precompute(SLUG);
  const p = await r2.b.request({ sessionID: SID, assistantMessages: 0 });
  assert.ok(p.text);
  assert.deepEqual(await r2.b.request({ sessionID: SID, assistantMessages: 3 }), { text: "", token: null });
  assert.throws(() => r2.b.ack({ sessionID: SID, token: p.token }), (e) => e.code === "stale-token");
});

test("reset permits exactly one fresh start regardless of assistantMessages (compaction); pre-upgrade sessions start at their next compaction", async () => {
  const r = await rig({ pages: { [`projects/${SLUG}/overview.md`]: overview("Old.") } });
  await r.b.precompute(SLUG);
  assert.equal((await r.b.request({ sessionID: SID, assistantMessages: 9 })).text, ""); // predates the upgrade
  assert.deepEqual(r.b.reset({ sessionID: SID }), { ok: true });
  const fresh = await r.b.request({ sessionID: SID, assistantMessages: 9 });
  assert.match(fresh.text, /Old\./);
  // permit is held until the ack, so a retry before it still works
  assert.equal((await r.b.request({ sessionID: SID, assistantMessages: 10 })).token, fresh.token);
  r.b.ack({ sessionID: SID, token: fresh.token });
  // consumed: a later request returns the pinned bytes, and a second compaction needs a second reset
  r.pages[`projects/${SLUG}/overview.md`] = overview("New.");
  await r.b.precompute(SLUG);
  assert.equal((await r.b.request({ sessionID: SID, assistantMessages: 20 })).text, fresh.text);
  r.b.reset({ sessionID: SID });
  const again = await r.b.request({ sessionID: SID, assistantMessages: 20 });
  assert.match(again.text, /New\./);
  assert.notEqual(again.token, fresh.token);
});

test("empty for internal sessions, the CTO conversation, routine runs, curator sessions, disabled/observe-only, unmapped-with-no-directory", async () => {
  const pages = { [`projects/${SLUG}/overview.md`]: overview("Hello.") };
  const sessions = {
    ses_internal: { directory: "/r", metadata: { manta: { internal: true } } },
    ses_routine: { directory: "/r", metadata: { manta: { routineId: "ab12cd34" } } },
    ses_curator: { directory: "/r", metadata: { manta: { knowledgeCurator: true } } },
    ses_cto: { directory: "/r" },
  };
  const mapped = Object.fromEntries(Object.keys(sessions).map((s) => [s, SLUG]));
  const r = await rig({ pages, sessions, mapped, cto: new Set(["ses_cto"]) });
  await r.b.precompute(SLUG);
  for (const id of Object.keys(sessions)) assert.deepEqual(await r.b.request({ sessionID: id, assistantMessages: 0 }), { text: "", token: null }, id);
  r.flags.active = false;
  assert.deepEqual(await r.b.request({ sessionID: SID, assistantMessages: 0 }), { text: "", token: null });
  r.flags.active = true;
  const noProject = await rig({ pages, mapped: {}, directoryProject: null });
  assert.deepEqual(await noProject.b.request({ sessionID: SID, assistantMessages: 0 }), { text: "", token: null });
});

test("an unmapped session is briefed from the directory the request names", async () => {
  const r = await rig({ pages: { [`projects/${SLUG}/overview.md`]: overview("From the directory.") }, mapped: {} });
  await r.b.precompute(SLUG);
  assert.match((await r.b.request({ sessionID: SID, directory: "/repo/a", assistantMessages: 0 })).text, /From the directory\./);
});

test("a request never errors: a throwing session lookup, a bad id → empty", async () => {
  const r = await rig({ sessions: { [SID]: "throw" }, pages: { [`projects/${SLUG}/overview.md`]: overview("x") } });
  assert.deepEqual(await r.b.request({ sessionID: SID, assistantMessages: 0 }), { text: "", token: null });
  assert.deepEqual(await r.b.request({ sessionID: "../etc/passwd", assistantMessages: 0 }), { text: "", token: null });
  assert.deepEqual(await r.b.request({}), { text: "", token: null });
});

test("ack of an unknown session or wrong token is 409 stale-token", async () => {
  const r = await rig({ pages: { [`projects/${SLUG}/overview.md`]: overview("x") } });
  assert.throws(() => r.b.ack({ sessionID: "ses_nope", token: "t" }), (e) => e.code === "stale-token");
  await r.b.precompute(SLUG);
  await r.b.request({ sessionID: SID, assistantMessages: 0 });
  assert.throws(() => r.b.ack({ sessionID: SID, token: "wrong" }), (e) => e.status === 409);
});

test("missed-prefetch counter: issued but never acked within a minute; served counted at ack; old sessions pruned", async () => {
  const r = await rig({ pages: { [`projects/${SLUG}/overview.md`]: overview("x") } });
  await r.b.precompute(SLUG);
  const a = await r.b.request({ sessionID: SID, assistantMessages: 0 });
  await r.b.request({ sessionID: "ses_two222", directory: "/r", assistantMessages: 0 });
  r.b.ack({ sessionID: SID, token: a.token });
  assert.deepEqual(r.b.weekStats(), { served: 1, missed: 0 });
  assert.deepEqual(await r.b.sweep(), { missed: 0, pruned: 0 }); // < 60 s
  r.advance(61_000);
  assert.deepEqual(await r.b.sweep(), { missed: 1, pruned: 0 }); // only the unacked one
  assert.deepEqual(await r.b.sweep(), { missed: 0, pruned: 0 }); // counted once
  assert.deepEqual(r.b.weekStats(), { served: 1, missed: 1 });
  r.advance(31 * 24 * 3600 * 1000);
  assert.equal((await r.b.sweep()).pruned, 2);
});
