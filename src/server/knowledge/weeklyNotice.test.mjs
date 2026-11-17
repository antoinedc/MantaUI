import { test } from "node:test";
import assert from "node:assert/strict";
import { NOTICE_AT_KEY, WEEK_MS, composeWeeklyNotice, createWeeklyNotice } from "./weeklyNotice.mjs";
import { createChangeLog } from "./changes.mjs";
import { memState } from "./testHelpers.mjs";

async function rig({ enabled = true } = {}) {
  const state = await memState();
  let t = 1_000_000;
  const changes = createChangeLog({ state, now: () => t });
  const sent = [];
  let failNotify = false;
  const notice = createWeeklyNotice({
    state,
    changesLog: changes,
    settings: { get: async () => ({ enabled }) },
    fireNotify: async (n) => {
      if (failNotify) throw new Error("push down");
      sent.push(n);
    },
    now: () => t,
    log: () => {},
  });
  return { notice, state, changes, sent, advance: (ms) => (t += ms), now: () => t, fail: (v) => (failNotify = v) };
}

test("composeWeeklyNotice: null when nothing changed; counts, latest summaries and the Knowledge pointer otherwise", () => {
  assert.equal(composeWeeklyNotice({ skipped: 5, waiting: 0 }), null);
  const m = composeWeeklyNotice({ applied: 3, undo: 1, outward: 1, waiting: 2 }, ["Rule: use pnpm", "Page: release steps"]);
  assert.match(m, /3 updates added/);
  assert.match(m, /1 repository change/);
  assert.match(m, /1 undone/);
  assert.match(m, /Latest: Rule: use pnpm; Page: release steps/);
  assert.match(m, /2 items waiting/);
  assert.match(m, /Settings → Knowledge/);
  assert.ok(m.length <= 400);
});

test("the first tick starts the clock; nothing is sent before a week has passed", async () => {
  const r = await rig();
  assert.equal((await r.notice.tick()).reason, "clock-started");
  assert.equal(r.state.kvGet(NOTICE_AT_KEY), String(r.now()));
  r.changes.add({ kind: "applied", summary: "Added a rule" });
  r.advance(6 * 24 * 3600 * 1000);
  assert.equal((await r.notice.tick()).reason, "not-due");
  assert.equal(r.sent.length, 0);
});

test("after a week with changes: one notification via fireNotify (informational), then the clock restarts", async () => {
  const r = await rig();
  await r.notice.tick();
  r.advance(1000);
  r.changes.add({ kind: "applied", summary: "Added rule: use pnpm", undoable: true });
  r.changes.add({ kind: "applied", summary: "Edited release page" });
  r.changes.add({ kind: "skipped", summary: "Dropped a conflicting rule" });
  r.advance(WEEK_MS);
  const out = await r.notice.tick();
  assert.equal(out.sent, true);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].tag, "knowledge-weekly");
  assert.match(r.sent[0].message, /2 updates added/);
  assert.match(r.sent[0].message, /Edited release page/);
  assert.equal(r.sent[0].urgent, undefined);
  r.advance(2 * 24 * 3600 * 1000);
  assert.equal((await r.notice.tick()).reason, "not-due");
});

test("a quiet week sends nothing but still restarts the clock; skipped/waiting alone is not a change", async () => {
  const r = await rig();
  await r.notice.tick();
  r.changes.add({ kind: "skipped", summary: "x" });
  r.changes.add({ kind: "waiting", summary: "y" });
  r.advance(WEEK_MS + 1);
  assert.equal((await r.notice.tick()).reason, "nothing-changed");
  assert.equal(r.sent.length, 0);
  assert.equal(r.state.kvGet(NOTICE_AT_KEY), String(r.now()));
});

test("changes from before the previous notice are not repeated; undone updates are not listed as latest", async () => {
  const r = await rig();
  await r.notice.tick();
  r.changes.add({ kind: "applied", summary: "old change" });
  r.advance(WEEK_MS);
  await r.notice.tick();
  r.advance(WEEK_MS);
  assert.equal((await r.notice.tick()).reason, "nothing-changed");
  const id = r.changes.add({ kind: "applied", summary: "will be undone", undoable: true });
  r.changes.markUndone(id);
  r.advance(WEEK_MS);
  const out = await r.notice.tick();
  assert.equal(out.sent, true);
  assert.doesNotMatch(r.sent.at(-1).message, /will be undone/);
});

test("a failing notification is retried later (not every tick); disabled does nothing", async () => {
  const r = await rig();
  await r.notice.tick();
  r.changes.add({ kind: "applied", summary: "a" });
  r.advance(WEEK_MS);
  r.fail(true);
  assert.equal((await r.notice.tick()).reason, "notify-failed");
  assert.equal((await r.notice.tick()).reason, "backoff");
  r.fail(false);
  r.advance(61 * 60 * 1000);
  assert.equal((await r.notice.tick()).sent, true);
  const off = await rig({ enabled: false });
  assert.equal((await off.notice.tick()).reason, "disabled");
});
