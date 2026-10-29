import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  activityView, computeRuns, createRunWalker, deliveryClassOf, describeActivity, runBoundaryOf, runView, summarizeParts,
} from "./transcriptRuns.mjs";

const cases = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/tool-activity-cases.json", import.meta.url)), "utf8"));

test("the regression suite is big enough to be a contract; case names are unique", () => {
  assert.ok(cases.describe.length + cases.summarize.length >= 25);
  assert.ok(cases.layout.length >= 6);
  for (const group of [cases.describe, cases.summarize, cases.layout]) {
    const names = group.map((c) => c.name);
    assert.equal(new Set(names).size, names.length);
  }
});

for (const c of cases.describe) {
  test(`describe: ${c.name}`, () => {
    const a = describeActivity(c.part);
    assert.deepEqual({ kind: a.kind, status: a.status, running: a.running, done: a.done, failed: a.failed, label: a.label, counted: a.counted }, c.expect);
  });
}

for (const c of cases.summarize) {
  test(`summarize: ${c.name}`, () => {
    const s = summarizeParts(c.parts);
    assert.deepEqual({ label: s.label, calls: s.calls, failed: s.failed, running: s.tone === "running", live: s.live ? s.live.label : null }, c.expect);
  });
}

// A layout case's expected `tools:` groups are the run SEGMENTS when reasoning is shown and the whole runs when it is not.
for (const c of cases.layout) {
  test(`runs: ${c.name}`, () => {
    const { walker } = computeRuns(c.messages);
    const groups = [];
    for (const id of walker.order) {
      const run = walker.runs.get(id);
      if (c.showThinking) for (const seg of walker.segmentsOf(run)) groups.push(seg.parts.map((p) => p.id).join(","));
      else groups.push(run.parts.map((p) => p.id).join(","));
    }
    const expected = Object.values(c.expect.blocks).flat().filter((b) => b.startsWith("tools:")).map((b) => b.slice(6));
    const all = c.expect.trailing ? [...expected, c.expect.trailing] : expected;
    assert.deepEqual(groups.sort(), all.sort());
    if (c.running) assert.equal(walker.open ? walker.open.parts.map((p) => p.id).join(",") : null, c.expect.trailing);
  });
}

// ---- the rules that changed when the two clients' copies became one ----
const tool = (id, name = "read", status = "completed", input = { filePath: `/a/${id}.ts` }) => ({ type: "tool", id, messageID: "m", tool: name, state: { status, input } });
const text = (id, t) => ({ type: "text", id, text: t });
const asst = (id, parts) => ({ info: { id, role: "assistant" }, parts });
const usr = (id, t, extra = {}) => ({ info: { id, role: "user" }, parts: [text(`${id}:t`, t)], ...extra });

test("a whitespace-only text part is transparent to a run (the phone's rule, now both clients')", () => {
  const { walker } = computeRuns([asst("a", [tool("t1"), text("x", "\n"), tool("t2")])]);
  assert.deepEqual([...walker.order], ["t1"]);
  assert.equal(walker.runs.get("t1").parts.length, 2);
});

test("a background-job completion USER turn is transparent: tool A → completion → tool B is ONE run with id A", () => {
  const { walker } = computeRuns([asst("a1", [tool("A")]), usr("u", '[background job "x" done]\n\nbody'), asst("a2", [tool("B")])]);
  assert.deepEqual([...walker.order], ["A"]);
  assert.equal(runBoundaryOf(usr("u", '[background job "x" done]')), "transparent");
  assert.equal(runBoundaryOf(usr("u", "next")), "draws");
  assert.equal(runBoundaryOf(usr("u", "  \n ")), "transparent");
  assert.equal(runBoundaryOf({ info: { role: "user", id: "f" }, parts: [{ type: "file" }] }), "draws");
});

test("an assistant background-result part DRAWS: it ends the run in both paths", () => {
  const bg = { info: { id: "r", role: "assistant" }, parts: [{ type: "background-result", id: "r:bg" }] };
  assert.equal(runBoundaryOf(bg), "draws");
  const { walker } = computeRuns([asst("a1", [tool("A")]), asst("a2", [{ type: "background-result", id: "bg" }, tool("B")])]);
  assert.deepEqual([...walker.order], ["A", "B"]);
});

test("a handoff tool ends the run and stands alone (no run of its own)", () => {
  const { walker, partRun } = computeRuns([asst("a", [tool("t1"), tool("h", "handoff"), tool("t2")])]);
  assert.deepEqual([...walker.order], ["t1", "t2"]);
  assert.equal(partRun.has("h"), false);
});

test("reasoning is transparent but starts a SEGMENT: ids are the first part of each segment", () => {
  const { walker } = computeRuns([asst("a", [tool("A"), { type: "reasoning", id: "r", text: "hm" }, tool("B"), tool("C")])]);
  const run = walker.runs.get("A");
  assert.deepEqual(run.segments, ["A", "B"]);
  const v = runView(walker, run, { epoch: "e", gen: 1, seq: 0 });
  assert.equal(v.segments.length, 2);
  assert.equal(v.segments[0].id, "A");
  assert.equal(v.segments[1].calls, 2);
  // a run without a split has no segments array
  assert.equal(runView(walker, computeRuns([asst("b", [tool("X")])]).walker.runs.get("X"), { epoch: "e", gen: 1, seq: 0 }).segments, undefined);
});

test("a run's summary tone follows the TOOL status (a background task reads by its call, not its job)", () => {
  const t = tool("T", "task", "completed", { description: "Explore" });
  assert.equal(summarizeParts([t]).tone, "ok");
  assert.equal(summarizeParts([tool("T", "task", "error")]).tone, "warn");
});

test("activityView carries kind, status, label, full target and whether it counts", () => {
  assert.deepEqual(activityView(tool("t", "bash", "running", { command: "npm test\nmore", description: "Run the tests" })), {
    kind: "bash", status: "running", label: "Run the tests", target: "npm test", counted: true,
  });
  assert.deepEqual(activityView({ type: "patch", id: "p", files: ["/a/b.ts", "/c.ts"] }), {
    kind: "patch", status: "completed", label: "Saved changes to 2 files", target: "/a/b.ts, /c.ts", counted: false,
  });
});

test("the walker: seq rises on every change and is stamped on the changed run; a part update keeps its run", () => {
  const w = createRunWalker();
  w.part(tool("A", "read", "running"), "m1");
  w.end();
  w.part(tool("B"), "m1");
  assert.equal(w.runs.get("A").seq, 1);
  assert.equal(w.runs.get("B").seq, 2);
  w.part(tool("A", "read", "completed"), "m1");
  assert.equal(w.runs.get("A").seq, 3);
  assert.equal(w.runs.get("A").parts[0].state.status, "completed");
  assert.equal(w.runs.get("A").parts.length, 1);
});

test("deliveryClassOf: by the item's MAPPED transcript outcome", () => {
  assert.equal(deliveryClassOf({ type: "user", id: "i", payload: { text: "hi" } }), "draws");
  assert.equal(deliveryClassOf({ type: "user", id: "i", payload: { text: '[background job "x" done]' } }), "transparent");
  assert.equal(deliveryClassOf({ type: "user", id: "i", payload: { text: "   " } }), "transparent");
  assert.equal(deliveryClassOf({ type: "user", id: "i" }), "unknown");
  const result = { type: "synthetic", id: "s", text: "<subagent sessionID=\"ses_c\" state=\"completed\">\nok\n</subagent>", metadata: { source: "subagent", childID: "ses_c", state: "completed" } };
  assert.equal(deliveryClassOf(result), "draws");
  assert.equal(deliveryClassOf({ ...result, metadata: { source: "subagent" }, text: "no child here" }), "transparent");
  assert.equal(deliveryClassOf({ type: "synthetic", id: "s", metadata: { source: "other" } }), "transparent");
  assert.equal(deliveryClassOf({ type: "compaction", id: "c" }), "transparent");
  assert.equal(deliveryClassOf({ type: "mystery", id: "c" }), "unknown");
  assert.equal(deliveryClassOf(null), "unknown");
});
