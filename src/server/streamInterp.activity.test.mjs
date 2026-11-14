// The interpreter's activity tap (spec 2026-11-14 §A1), replayed from the recorded OpenCode V2 streams.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStreamInterpreter } from "./streamInterp.mjs";
import { activityTarget, activityTimeoutMs } from "./jobLiveness.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "opencodeV2Events");
const events = (name) => readFileSync(join(DIR, `${name}.jsonl`), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

function tap(opts = {}) {
  const records = [];
  const interp = createStreamInterpreter({ publish: () => {}, ...opts });
  interp.onActivity((r) => records.push(r));
  return { interp, records };
}
const replay = (name, interp) => events(name).forEach((e) => interp.interpret(e));
const ofType = (records, type) => records.filter((r) => r.type === type);

test("02-slow-bash: toolStarted only at .called (input complete, target = the command), progress never starts a tool, toolEnded carries the cached name + input", () => {
  const { interp, records } = tap();
  replay("02-slow-bash", interp);
  const started = ofType(records, "toolStarted");
  assert.equal(started.length, 1);
  assert.equal(started[0].name, "bash");
  assert.equal(started[0].target, "for i in 1 2 3 4 5; do echo line$i; sleep 1; done");
  assert.equal(started[0].timeoutMs, null);
  assert.equal(started[0].at, 1792170303636, "stamped with the event's own time");
  assert.equal(ofType(records, "toolProgress").length, 1);
  const ended = ofType(records, "toolEnded");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].callID, started[0].callID);
  assert.equal(ended[0].name, "bash");
  assert.equal(ended[0].input.command, started[0].target);
  const steps = ofType(records, "step");
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0].tokens, { input: 3, output: 76, reasoning: 0, cacheRead: 18850, cacheWrite: 363 });
  assert.equal(steps[0].cost, 0.00272175);
  assert.match(steps[0].eventId, /^evt_/);
  assert.ok(ofType(records, "content").length >= 2, "a step end is content too");
});

test("02-slow-bash: new shell output bytes become toolOutput records, even past the 20 000-char display cap", async () => {
  const big = "x".repeat(25_000);
  const timers = [];
  let served = false;
  const { interp, records } = tap({
    fetchShellOutput: async () => (served ? null : ((served = true), { output: big, cursor: big.length })),
    shellPollMs: 1,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
  });
  for (const e of events("02-slow-bash")) {
    interp.interpret(e);
    if (e.type === "session.tool.progress") break; // the shell is now being tailed
  }
  for (let i = 0; i < 4 && timers.length; i++) await timers.shift()(); // (the poller re-arms itself: a few ticks are enough)
  const out = ofType(records, "toolOutput");
  assert.equal(out.length, 1);
  assert.equal(out[0].bytes, 25_000, "the whole read counts, not the capped display text");
  assert.equal(out[0].callID, ofType(records, "toolStarted")[0].callID);
});

test("03-edit-todo: todos records carry the parsed list; file tools target their path", () => {
  const { interp, records } = tap();
  replay("03-edit-todo", interp);
  const todos = ofType(records, "todos");
  assert.equal(todos.length, 2);
  assert.equal(todos[0].items[0].content, "read notes.txt");
  assert.equal(todos[0].items[0].status, "in_progress");
  assert.ok(todos[1].items.some((i) => i.status === "completed"));
  const targets = ofType(records, "toolStarted").map((r) => [r.name, r.target]);
  assert.deepEqual(targets.filter(([n]) => n === "read" || n === "edit"), [["read", "notes.txt"], ["edit", "notes.txt"]]);
});

test("04-task-subagent: the child is announced from session.created and from the task tool's metadata, and its own records carry its id", () => {
  const { interp, records } = tap();
  replay("04-task-subagent", interp);
  const children = ofType(records, "child");
  assert.ok(children.length >= 2, "one from session.created, one from the tool's metadata");
  assert.equal(children[0].childSessionId.endsWith("LalMtY"), true);
  assert.equal(children[0].parentSessionId.endsWith("uWIWl1"), true);
  const childTool = ofType(records, "toolStarted").find((r) => r.sessionId.endsWith("LalMtY"));
  assert.equal(childTool.name, "grep");
  assert.equal(childTool.target, "", "only shell and file tools name a target");
  assert.ok(ofType(records, "step").some((r) => r.sessionId.endsWith("LalMtY")));
});

test("activityTarget / activityTimeoutMs: the A1 rules", () => {
  assert.equal(activityTarget("bash", { command: "npm test\nnext" }), "npm test");
  assert.equal(activityTarget("bash", { command: "x".repeat(200) }).length, 80);
  assert.equal(activityTarget("patch", { path: "a/b.ts" }), "a/b.ts");
  assert.equal(activityTarget("grep", { pattern: "x" }), "");
  assert.equal(activityTimeoutMs("bash", { timeout: 1_200_000 }), 1_200_000);
  assert.equal(activityTimeoutMs("bash", { timeout: 0 }), null);
  assert.equal(activityTimeoutMs("bash", { timeout: Infinity }), null);
  assert.equal(activityTimeoutMs("read", { timeout: 5 }), null);
});

test("a subscriber that throws never breaks the interpreter or the other subscribers; unsubscribe stops delivery", () => {
  const records = [];
  const interp = createStreamInterpreter({ publish: () => {} });
  interp.onActivity(() => {
    throw new Error("boom");
  });
  const off = interp.onActivity((r) => records.push(r));
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    replay("01-plain-text", interp);
  } finally {
    console.warn = origWarn;
  }
  const n = records.length;
  assert.ok(ofType(records, "content").length > 0);
  off();
  console.warn = () => {};
  try {
    replay("01-plain-text", createStreamInterpreter({ publish: () => {} }));
  } finally {
    console.warn = origWarn;
  }
  assert.equal(records.length, n, "no delivery after unsubscribe");
});
