import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractLastSnippet,
  resetAtFor,
  resumeCost,
  buildResumeView,
  planApply,
  createUsageResumeView,
} from "./usageResumeView.mjs";

const NOW = 1_000_000_000_000;
const rec = (over = {}) => ({
  workspace: "manta",
  conversation: "ses_1",
  provider: "claude",
  model: "claude-opus-4-7",
  window: "weekly",
  stoppedAt: NOW - 1000,
  cachedTokens: 340_000,
  armed: false,
  attempts: 1,
  ...over,
});
const snap = (resetsAt, over = {}) => [
  { provider: "claude", providerIDs: ["anthropic"], windows: [{ kind: "weekly", label: "Weekly", pct: 100, resetsAt, ...over }] },
];
const assistant = (text) => ({ info: { role: "assistant" }, parts: [{ type: "text", text }] });

describe("extractLastSnippet (moved)", () => {
  test("null for empty / no assistant text", () => {
    assert.equal(extractLastSnippet([]), null);
    assert.equal(extractLastSnippet(null), null);
    assert.equal(extractLastSnippet([{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }]), null);
    assert.equal(extractLastSnippet([assistant("  ")]), null);
  });
  test("takes the most recent assistant message with text, joins parts, truncates at 90 with an ellipsis", () => {
    assert.equal(extractLastSnippet([assistant("old"), assistant("new"), { info: { role: "user" }, parts: [] }]), "new");
    const long = "x".repeat(120);
    assert.equal(extractLastSnippet([assistant(long)]), "x".repeat(90) + "…");
    assert.equal(extractLastSnippet([{ info: { role: "assistant" }, parts: [{ type: "text", text: "a" }, { type: "tool" }, { type: "text", text: "b" }] }]), "a b");
  });
});

describe("resetAtFor / resumeCost", () => {
  test("reset lookup by provider + window kind", () => {
    assert.equal(resetAtFor(rec(), snap(5)), 5);
    assert.equal(resetAtFor(rec({ window: null }), snap(5)), undefined);
    assert.equal(resetAtFor(rec({ provider: "codex" }), snap(5)), undefined);
    assert.equal(resetAtFor(rec({ window: "session" }), snap(5)), undefined);
  });
  test("warm/cold boundary is exactly at the TTL; unknown reset is cold", () => {
    const ttl = 300_000;
    assert.equal(resumeCost(rec(), NOW + ttl, NOW, ttl), 0);
    assert.equal(resumeCost(rec(), NOW + ttl + 1, NOW, ttl), 340_000);
    assert.equal(resumeCost(rec(), NOW - 5, NOW, ttl), 0, "already reset = warm");
    assert.equal(resumeCost(rec(), undefined, NOW, ttl), 340_000);
    assert.equal(resumeCost(rec({ cachedTokens: undefined }), undefined, NOW, ttl), 0);
  });
});

describe("buildResumeView", () => {
  const view = (records, extra = {}) =>
    buildResumeView({ stopped: { records, lastLooked: null }, snapshots: [], cacheTtl: "5m", names: new Map(), snippets: new Map(), now: NOW, ...extra });

  test("header variants (none armed: singular / plural; some armed: counts new)", () => {
    assert.equal(view([rec()]).header, "1 conversation was stopped by a provider limit. Pick which ones should carry on by themselves when quota returns.");
    assert.equal(view([rec(), rec({ conversation: "b" })]).header, "2 conversations were stopped by a provider limit. Pick which ones should carry on by themselves when quota returns.");
    const armed = view([rec({ armed: true, stoppedAt: NOW - 5000 }), rec({ conversation: "b" })], {
      stopped: { records: [rec({ armed: true, stoppedAt: NOW - 5000 }), rec({ conversation: "b", stoppedAt: NOW })], lastLooked: NOW - 1000 },
    });
    assert.equal(armed.header, "1 armed · 1 stopped since you last looked.");
    assert.equal(armed.hasArmed, true);
    assert.equal(armed.unarmedCount, 1);
    assert.equal(armed.totalCount, 2);
  });

  test("isNew: null / equal / before / after lastLooked", () => {
    const flags = (lastLooked) =>
      buildResumeView({ stopped: { records: [rec({ stoppedAt: 100 })], lastLooked }, snapshots: [], cacheTtl: "5m", names: new Map(), snippets: new Map(), now: NOW }).groups[0].rows[0].isNew;
    assert.equal(flags(null), true);
    assert.equal(flags(100), false);
    assert.equal(flags(101), false);
    assert.equal(flags(99), true);
  });

  test("row: name from projects else the id; snippet; window label + reset; cost warm vs cold", () => {
    const warm = view([rec()], { snapshots: snap(NOW + 60_000), names: new Map([["ses_1", "fix login"]]), snippets: new Map([["ses_1", "I updated the guard…"]]) });
    const row = warm.groups[0].rows[0];
    assert.deepEqual([row.name, row.snippet, row.provider, row.model], ["fix login", "I updated the guard…", "claude", "claude-opus-4-7"]);
    assert.deepEqual(row.window, { label: "Weekly", resetsAt: NOW + 60_000 });
    assert.deepEqual(row.cost, { warm: true, reReadTokens: 0, label: "cache still warm · no extra cost" });
    const cold = view([rec()], { snapshots: snap(NOW + 3_600_000) }).groups[0].rows[0];
    assert.deepEqual(cold.cost, { warm: false, reReadTokens: 340_000, label: "≈ 340k tokens re-read" });
    const bare = view([rec({ window: null, model: undefined })]).groups[0].rows[0];
    assert.deepEqual([bare.name, bare.snippet, bare.model, bare.window], ["ses_1", null, null, { label: "Limit", resetsAt: null }]);
    assert.equal(view([rec({ window: "monthly" })]).groups[0].rows[0].window.label, "Monthly");
  });

  test("the TTL comes from cacheTtl (1h makes a 30-minute reset warm)", () => {
    const at = NOW + 30 * 60_000;
    assert.equal(view([rec()], { snapshots: snap(at), cacheTtl: "5m" }).groups[0].rows[0].cost.warm, false);
    assert.equal(view([rec()], { snapshots: snap(at), cacheTtl: "1h" }).groups[0].rows[0].cost.warm, true);
  });

  test("groups: workspace first-appearance order, rows newest-stopped first; empty workspace → '—'", () => {
    const v = view([rec({ conversation: "a", workspace: "w2", stoppedAt: 1 }), rec({ conversation: "b", workspace: "w1", stoppedAt: 2 }), rec({ conversation: "c", workspace: "w2", stoppedAt: 3 }), rec({ conversation: "d", workspace: "", stoppedAt: 0 })]);
    assert.deepEqual(v.groups.map((g) => [g.workspace, g.rows.map((r) => r.conversation)]), [["w2", ["c", "a"]], ["w1", ["b"]], ["—", ["d"]]]);
  });

  test("empty view carries the empty text and the cold-note templates", () => {
    const v = view([]);
    assert.equal(v.emptyText, "No conversations are stopped by a provider limit right now.");
    assert.deepEqual(v.groups, []);
    assert.equal(v.title, "Resume after limit reset");
    assert.match(v.coldNote.many, /^\{n\} of these reset well past/);
    assert.match(v.coldNote.one, /^One of these/);
  });
});

describe("planApply", () => {
  const records = [rec({ conversation: "a", armed: true }), rec({ conversation: "b" }), rec({ conversation: "c" })];
  test("one armed row unchecked → canApply with a disarm, title 'Update'", () => {
    const p = planApply({ records: [rec({ conversation: "a", armed: true })], selected: [] });
    assert.deepEqual([p.canApply, p.arm, p.disarm, p.title], [true, [], ["a"], "Update"]);
  });
  test("mixed diff", () => {
    const p = planApply({ records, selected: ["b"] });
    assert.deepEqual([p.arm, p.disarm, p.canApply, p.title], [["b"], ["a"], true, "Update"]);
  });
  test("no change → canApply false", () => {
    assert.equal(planApply({ records, selected: ["a"] }).canApply, false);
  });
  test("nothing armed → 'Resume N at reset'; ids not in the records are ignored", () => {
    const p = planApply({ records: [rec({ conversation: "b" }), rec({ conversation: "c" })], selected: ["b", "c", "ghost"] });
    assert.deepEqual([p.arm, p.disarm, p.title], [["b", "c"], [], "Resume 2 at reset"]);
    const none = planApply({ records: [rec({ conversation: "b" })], selected: [] });
    assert.deepEqual([none.canApply, none.title], [false, "Resume 0 at reset"]);
  });
});

function harness({ records = [rec({ conversation: "a", armed: true }), rec({ conversation: "b" })], lastLooked = null, failOn } = {}) {
  const state = { records: records.map((r) => ({ ...r })), lastLooked, armed: [], disarmed: [], listArgs: [] };
  const svc = createUsageResumeView({
    listStopped: async () => ({ records: state.records, lastLooked: state.lastLooked }),
    listSnapshots: () => snap(NOW + 60_000),
    configGet: async () => ({ cacheTtl: "5m" }),
    listProjects: async () => [{ tmuxSession: "manta", windows: [{ name: "fix login", opencodeSessionId: "a" }, { name: "other" }] }],
    listMessages: async (sid, opts) => {
      state.listArgs.push([sid, opts]);
      if (sid === "b") throw new Error("gone");
      return [assistant("done a")];
    },
    arm: async ({ conversation }) => {
      if (failOn === conversation) throw new Error("boom");
      state.armed.push(conversation);
      const r = state.records.find((x) => x.conversation === conversation);
      if (r) r.armed = true;
    },
    disarm: async ({ conversation }) => {
      if (failOn === conversation) throw new Error("boom");
      state.disarmed.push(conversation);
      state.records = state.records.filter((x) => x.conversation !== conversation);
    },
    now: () => NOW,
  });
  return { svc, state };
}

describe("createUsageResumeView", () => {
  test("view(): names from projects (id fallback), snippets for 5 messages, failed snippet → null, full envelope used", async () => {
    const { svc, state } = harness({ lastLooked: NOW - 10 });
    const v = await svc.view();
    const rows = v.groups[0].rows;
    assert.deepEqual(rows.map((r) => [r.conversation, r.name, r.snippet]).sort(), [["a", "fix login", "done a"], ["b", "b", null]]);
    assert.ok(state.listArgs.every(([, o]) => o.limit === 5));
    // stoppedAt (NOW-1000) is BEFORE lastLooked (NOW-10) → not new
    assert.equal(rows[0].isNew, false);
  });

  test("view(): a record stopped before lastLooked is not new; after stamping it stays not-new", async () => {
    const { svc, state } = harness({ lastLooked: null });
    assert.equal((await svc.view()).groups[0].rows[0].isNew, true);
    state.lastLooked = NOW; // stamp-last-looked
    assert.equal((await svc.view()).groups[0].rows[0].isNew, false);
  });

  test("apply dryRun computes only the plan (no writes)", async () => {
    const { svc, state } = harness();
    const r = await svc.apply({ selected: ["b"], dryRun: true });
    assert.deepEqual([r.ok, r.canApply, r.title, r.arm, r.disarm], [true, true, "Update", ["b"], ["a"]]);
    assert.equal(state.armed.length + state.disarmed.length, 0);
  });

  test("apply runs arms then disarms and reports the result", async () => {
    const { svc, state } = harness();
    const r = await svc.apply({ selected: ["b"] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.applied, { armed: ["b"], disarmed: ["a"] });
    assert.deepEqual([state.armed, state.disarmed], [["b"], ["a"]]);
    assert.equal(r.message, "Updated — 1 conversation will carry on at reset.");
  });

  test("apply disarming the last armed row works and says 'Removed'", async () => {
    const { svc } = harness({ records: [rec({ conversation: "a", armed: true })] });
    const r = await svc.apply({ selected: [] });
    assert.equal(r.ok, true);
    assert.equal(r.message, "Removed 1 conversation from resume.");
  });

  test("apply stops at the first failure and names the row", async () => {
    const { svc, state } = harness({ records: [rec({ conversation: "a", armed: true }), rec({ conversation: "b" }), rec({ conversation: "c" })], failOn: "b" });
    const r = await svc.apply({ selected: ["b", "c"] });
    assert.equal(r.ok, false);
    assert.deepEqual(r.failed.map((f) => f.conversation), ["b"]);
    assert.equal(r.message, "Couldn't update b — boom. The ones after it weren't changed.");
    assert.deepEqual(state.armed, [], "nothing after the failing step ran (c not armed, a not disarmed)");
    assert.deepEqual(state.disarmed, []);
  });

  test("apply with nothing to change is ok with a plain message", async () => {
    const { svc } = harness();
    const r = await svc.apply({ selected: ["a"] });
    assert.deepEqual([r.ok, r.canApply, r.message], [true, false, "Nothing to change."]);
  });
});
