import { test } from "node:test";
import assert from "node:assert/strict";
import { createJobViews } from "./jobViews.mjs";
import { createJobLiveness } from "./jobLiveness.mjs";

const T = 1_700_000_000_000;
const job = (over = {}) => ({ id: "j1", name: "n", status: "running", childSessionID: "ses_a", attempt: 1, origin: "delegate", launch: {}, completionOwner: "manta", startedAt: T, ceilingMs: 4 * 3_600_000, jobProgress: undefined, ...over });

function world() {
  const clock = { t: T };
  const timers = [];
  const published = [];
  const store = [job()];
  const liveness = createJobLiveness({ now: () => clock.t });
  liveness.ensure(job());
  const views = createJobViews({
    now: () => clock.t,
    epoch: 777,
    liveness,
    publish: (e) => published.push(e),
    load: async () => store,
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimer: () => {},
  });
  const fire = async () => {
    const t = timers.shift();
    await t.fn();
  };
  return { clock, timers, published, store, liveness, views, fire };
}

test("rev: epoch is the process start; n bumps only when the content changes (never on a repeat read, never for asOf)", () => {
  const w = world();
  const a = w.views.viewFor(job());
  w.clock.t += 5_000;
  const b = w.views.viewFor(job());
  assert.deepEqual(a.rev, { epoch: 777, n: 1 });
  assert.deepEqual(b.rev, { epoch: 777, n: 1 });
  assert.notEqual(a.asOf, b.asOf);
  w.liveness.observe({ type: "toolStarted", sessionId: "ses_a", callID: "c", name: "bash", target: "ls", timeoutMs: null, at: w.clock.t });
  const c = w.views.viewFor(job());
  assert.equal(c.rev.n, 2);
  assert.deepEqual(c.live, { tool: "bash", target: "ls", startedAt: w.clock.t });
});

test("notify is coalesced per job: the first goes out on the next tick, later ones at most every 5 s, and the last state is always sent", async () => {
  const w = world();
  w.views.notify("j1");
  w.views.notify("j1");
  assert.equal(w.timers.length, 1, "one pending publish per job");
  assert.equal(w.timers[0].ms, 0);
  await w.fire();
  assert.equal(w.published.length, 1);
  assert.equal(w.published[0].payload.view.rev.n, 1);
  assert.equal(w.published[0].kind, "delegate.updated");

  w.liveness.observe({ type: "toolStarted", sessionId: "ses_a", callID: "c", name: "bash", target: "ls", timeoutMs: null, at: w.clock.t });
  w.clock.t += 1_000;
  w.views.notify("j1");
  assert.equal(w.timers[0].ms, 4_000, "trailing: waits out the 5 s window");
  w.liveness.observe({ type: "toolStarted", sessionId: "ses_a", callID: "d", name: "bash", target: "pwd", timeoutMs: null, at: w.clock.t });
  w.clock.t += 4_000;
  await w.fire();
  assert.equal(w.published.length, 2);
  assert.equal(w.published[1].payload.view.live.tool, "bash");
  assert.ok(w.published[1].payload.view.rev.n > w.published[0].payload.view.rev.n);
});

test("an unchanged view is not published again", async () => {
  const w = world();
  w.views.notify("j1");
  await w.fire();
  w.clock.t += 6_000;
  w.views.notify("j1");
  await w.fire();
  assert.equal(w.published.length, 1);
});

test("publishNow is immediate and carries the view; prune forgets removed jobs only", () => {
  const w = world();
  const v = w.views.publishNow(job({ status: "done", finishedAt: T + 5 }), { launchState: "running" });
  assert.equal(w.published.length, 1);
  assert.equal(w.published[0].payload.status, "done");
  assert.equal(w.published[0].payload.launchState, "running");
  assert.equal(w.published[0].payload.view.state, "done");
  assert.equal(v.rev.n, 1);
  w.views.viewFor(job({ id: "gone" }));
  w.views.prune(["j1"]);
  assert.equal(w.views._revs.has("gone"), false);
  assert.equal(w.views._revs.has("j1"), true, "a record still in the store keeps its revision");
});
