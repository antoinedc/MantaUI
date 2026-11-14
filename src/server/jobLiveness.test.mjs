import { test } from "node:test";
import assert from "node:assert/strict";
import { createJobLiveness, STALL_WINDOW_MS } from "./jobLiveness.mjs";

const MIN = 60_000;
const T0 = 1_000_000_000_000;
const job = (over = {}) => ({ id: "j1", status: "running", childSessionID: "ses_root", attempt: 1, origin: "delegate", launch: { text: "x" }, completionOwner: "manta", ...over });

function world({ reconstructed = true } = {}) {
  const clock = { t: T0 };
  const lv = createJobLiveness({ now: () => clock.t });
  lv.ensure(job());
  if (reconstructed) assert.equal(lv.applyReconstruction("j1", lv.get("j1").generation, {}), true);
  const at = (min) => T0 + min * MIN;
  const rec = (type, min, extra = {}) => lv.observe({ type, sessionId: "ses_root", at: at(min), ...extra });
  return { lv, clock, at, rec, verdict: (min) => lv.judgeStall("j1", at(min)) };
}

test("output every 2 minutes for 3 hours is never stalled", () => {
  const w = world();
  for (let m = 2; m <= 180; m += 2) {
    w.rec("content", m);
    assert.equal(w.verdict(m).stalled, false);
  }
});

test("16 minutes with no events is stalled; 15 is not", () => {
  const w = world();
  assert.equal(w.verdict(15).stalled, false);
  assert.equal(w.verdict(16).stalled, true);
  assert.equal(w.verdict(16).tool, null);
});

test("tool calls alone keep the job alive (a loop is the loop rule's business, not the stall rule's)", () => {
  const w = world();
  for (let m = 5; m <= 60; m += 5) {
    w.rec("toolStarted", m, { callID: `c${m}`, name: "progress_report", target: "", timeoutMs: null });
    w.rec("toolEnded", m, { callID: `c${m}`, name: "progress_report", input: {} });
  }
  assert.equal(w.verdict(60).stalled, false);
});

test("a silent shell with timeout 1 200 000: alive at 24 min, stalled at 26 (anchored to its start)", () => {
  const w = world();
  w.rec("toolStarted", 0, { callID: "sh", name: "bash", target: "make", timeoutMs: 1_200_000 });
  assert.equal(w.verdict(24).stalled, false);
  const late = w.verdict(26);
  assert.equal(late.stalled, true);
  assert.deepEqual(late.tool, { name: "bash", target: "make", ranPastTimeout: true });
});

test("a silent shell with timeout 0: alive at 59 min, stalled at 61 (60 minutes of no output)", () => {
  const w = world();
  w.rec("toolStarted", 0, { callID: "sh", name: "bash", target: "sleep", timeoutMs: null });
  assert.equal(w.verdict(59).stalled, false);
  const late = w.verdict(61);
  assert.equal(late.stalled, true);
  assert.equal(late.tool.ranPastTimeout, false);
});

test("shell output bytes (even ones the display cap drops) advance liveness and the tool's own silence clock", () => {
  const w = world();
  w.rec("toolStarted", 0, { callID: "sh", name: "bash", target: "build", timeoutMs: null });
  w.rec("toolOutput", 50, { callID: "sh", bytes: 25_000 });
  assert.equal(w.verdict(65).stalled, false, "15 minutes after the last output, still inside the tool's 60-minute silence allowance");
  assert.equal(w.verdict(111).stalled, true);
});

test("two tools, one within its allowance: alive", () => {
  const w = world();
  w.rec("toolStarted", 0, { callID: "old", name: "bash", target: "a", timeoutMs: 60_000 });
  w.rec("toolStarted", 10, { callID: "new", name: "bash", target: "b", timeoutMs: null });
  assert.equal(w.verdict(30).stalled, false);
  w.rec("toolEnded", 31, { callID: "new", name: "bash", input: {} });
  assert.equal(w.verdict(60).stalled, true);
});

test("a descendant's records advance the parent job; a child announced by its parent is routed before its own records", () => {
  const w = world();
  assert.equal(w.lv.observe({ type: "content", sessionId: "ses_kid", at: w.at(1) }), null, "unknown session: not a job's");
  w.lv.observe({ type: "child", sessionId: "ses_root", childSessionId: "ses_kid", parentSessionId: "ses_root", at: w.at(1) });
  w.lv.observe({ type: "child", sessionId: "ses_kid", childSessionId: "ses_kid", parentSessionId: "ses_root", at: w.at(1) });
  assert.equal(w.lv.jobIdOf("ses_kid"), "j1");
  w.lv.observe({ type: "content", sessionId: "ses_kid", at: w.at(20) });
  assert.equal(w.verdict(30).stalled, false);
  assert.equal(w.verdict(36).stalled, true);
});

test("fail open: a job whose live state was never rebuilt is never judged stalled; a rebuilt one is", () => {
  const w = world({ reconstructed: false });
  assert.equal(w.verdict(500).stalled, false);
  assert.equal(w.lv.applyReconstruction("j1", w.lv.get("j1").generation, { running: [] }), true);
  assert.equal(w.verdict(500).stalled, true);
});

test("reconstruction: tombstone rule (the tap wins), stale generation discarded, started time kept, tools unobserved", () => {
  const w = world({ reconstructed: false });
  const gen = w.lv.get("j1").generation;
  w.rec("toolEnded", 1, { callID: "done-during-read", name: "bash", input: {} });
  w.rec("toolStarted", 2, { callID: "live", name: "bash", target: "x", timeoutMs: null });
  w.lv.applyReconstruction("j1", gen, {
    nodes: [{ id: "ses_kid", parent: "ses_root" }],
    running: [
      { callID: "done-during-read", sessionId: "ses_root", name: "bash", startedAt: w.at(-30) },
      { callID: "live", sessionId: "ses_root", name: "bash", startedAt: w.at(-99) },
      { callID: "silent", sessionId: "ses_kid", name: "bash", target: "slow", startedAt: w.at(-20), timeoutMs: null },
      { callID: "timed", sessionId: "ses_kid", name: "bash", target: "t", startedAt: w.at(-10), timeoutMs: 20 * MIN },
    ],
  });
  const tools = w.lv.get("j1").tools;
  assert.equal(tools.has("done-during-read"), false, "ended by the tap while the read was in flight: not resurrected");
  assert.equal(tools.get("live").startedAt, w.at(2), "the tap's record is kept");
  assert.equal(tools.get("live").observed, true);
  assert.equal(tools.get("silent").observed, false);
  assert.equal(tools.get("silent").startedAt, w.at(-20), "start time from the transcript");
  assert.equal(w.lv.jobIdOf("ses_kid"), "j1");
  // a reconstructed no-timeout shell is never ended by the silence rule
  tools.delete("live");
  tools.delete("timed");
  assert.equal(w.verdict(600).stalled, false);

  // one with a timeout stalls past startedAt + timeout + 5 min
  const timedOnly = world({ reconstructed: false });
  timedOnly.lv.applyReconstruction("j1", timedOnly.lv.get("j1").generation, {
    running: [{ callID: "timed", sessionId: "ses_root", name: "bash", target: "t", startedAt: timedOnly.at(0), timeoutMs: 20 * MIN }],
  });
  assert.equal(timedOnly.verdict(24).stalled, false);
  assert.equal(timedOnly.verdict(26).stalled, true);

  const stale = world({ reconstructed: false });
  const old = stale.lv.get("j1").generation;
  stale.lv.rootChanged(job());
  assert.equal(stale.lv.applyReconstruction("j1", old, { running: [] }), false, "a result for a live that was recreated is discarded");
  assert.equal(stale.lv.get("j1").reconstructedAt, null);
});

test("a root change (handoff, resume, launch confirmation) drops the live picture and the descendants' routes", () => {
  const w = world();
  w.lv.observe({ type: "child", sessionId: "ses_root", childSessionId: "ses_kid", parentSessionId: "ses_root", at: w.at(1) });
  w.lv.rootChanged(job({ childSessionID: "ses_new" }));
  assert.equal(w.lv.jobIdOf("ses_root"), null);
  assert.equal(w.lv.jobIdOf("ses_kid"), null);
  assert.equal(w.lv.jobIdOf("ses_new"), "j1");
  assert.equal(w.lv.get("j1").reconstructedAt, null);
  const early = w.lv.observe({ type: "toolStarted", sessionId: "ses_new", callID: "c", name: "bash", target: "", timeoutMs: null, at: w.at(2) });
  assert.equal(early.jobId, "j1", "tap records for the new root apply normally");
});

test("syncRoots keeps exactly the running jobs", () => {
  const lv = createJobLiveness({ now: () => T0 });
  lv.syncRoots([job(), job({ id: "j2", childSessionID: "ses_b" }), job({ id: "j3", status: "done", childSessionID: "ses_c" })]);
  assert.equal(lv.size(), 2);
  lv.syncRoots([job()]);
  assert.equal(lv.size(), 1);
  assert.equal(lv.jobIdOf("ses_b"), null);
});

test("usage: dedupe on the event id, costPartial in either order, taken once", () => {
  const w = world();
  const step = (id, cost) => w.rec("step", 1, { eventId: id, tokens: { input: 10, output: 5, reasoning: 1, cacheRead: 100, cacheWrite: 4 }, cost });
  step("e1", null);
  step("e1", 9);
  step("e2", 0.5);
  assert.deepEqual(w.lv.takeUsageDelta("j1"), { tokens: 240, costUsd: 0.5, partial: true });
  assert.equal(w.lv.takeUsageDelta("j1"), null);
  step("e3", 0.25);
  assert.deepEqual(w.lv.takeUsageDelta("j1"), { tokens: 120, costUsd: 0.25, partial: false });
});

test("opencode-owned jobs track progress but not usage", () => {
  const lv = createJobLiveness({ now: () => T0 });
  lv.ensure(job({ id: "oc", childSessionID: "ses_oc", completionOwner: "opencode", origin: "subagent", launch: undefined }));
  lv.observe({ type: "step", sessionId: "ses_oc", eventId: "e", tokens: { input: 5 }, cost: 1, at: T0 });
  assert.equal(lv.takeUsageDelta("oc"), null);
  assert.equal(lv.ownsSession("ses_oc"), false);
});

test("ownsSession: only a running Manta-owned delegate job's own session or one below it", () => {
  const lv = createJobLiveness({ now: () => T0 });
  lv.ensure(job());
  lv.ensure(job({ id: "cmd", childSessionID: "ses_cmd", origin: "command", launch: undefined }));
  assert.equal(lv.ownsSession("ses_root"), true);
  lv.observe({ type: "child", sessionId: "ses_root", childSessionId: "ses_kid", parentSessionId: "ses_root", at: T0 });
  assert.equal(lv.ownsSession("ses_kid"), true);
  assert.equal(lv.ownsSession("ses_cmd"), false, "a background COMMAND keeps its asks");
  assert.equal(lv.ownsSession("ses_other"), false);
  lv.drop("j1");
  assert.equal(lv.ownsSession("ses_root"), false);
});

test("the pending-rejection queue is bounded and keyed by request id", () => {
  const lv = createJobLiveness({ now: () => T0 });
  for (let i = 0; i < 130; i++) lv.queueRejection({ kind: "question", requestId: `r${i}`, sessionId: "s" });
  assert.equal(lv.pendingRejections().length, 100);
  assert.equal(lv.pendingRejections()[0].requestId, "r30");
  lv.queueRejection({ kind: "question", requestId: "r129", sessionId: "s" });
  assert.equal(lv.pendingRejections().length, 100);
  lv.dropRejection("r129");
  assert.equal(lv.pendingRejections().length, 99);
});

test("evidence: the content records of the last 15 minutes, and the tools running at the decision", () => {
  const w = world();
  for (let m = 0; m < 30; m++) w.rec("content", m);
  w.rec("toolStarted", 29, { callID: "t", name: "bash", target: "x", timeoutMs: 5000 });
  const ev = w.lv.evidence("j1", w.at(30));
  assert.ok(ev.contentRecordsLast15m >= 14 && ev.contentRecordsLast15m <= 16, String(ev.contentRecordsLast15m));
  assert.deepEqual(ev.toolsAtEnd, [{ name: "bash", runningForMs: MIN, timeoutMs: 5000 }]);
  assert.equal(STALL_WINDOW_MS, 15 * MIN);
});
