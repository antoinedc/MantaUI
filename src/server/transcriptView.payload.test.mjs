// WS11 D11 payload guard: `view:true` must not bloat the transcript. The spec's default (FULL RunView on every message
// touching a run) MEASURED +14.9 % on (a) but +145 % on (b) (one 60-step run), so the implementation is the
// RunRef fallback — the full view only on the run's placement message, `{id, rev, ref:true}` on every other. This test asserts
// the fallback's bytes (+15 % on all three) and that it IS the fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapTimeline, mapToolBlock } from "../shared/opencodeV2.mjs";
import { slimTranscript } from "./opencode.mjs";
import { annotateView } from "./transcriptView.mjs";

const timeline = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/opencodeV2Events/${name}.timeline.json`, import.meta.url)), "utf8"));
const bytes = (x) => Buffer.byteLength(JSON.stringify(x));
const LIMIT = 1.3;

function typical() {
  const out = [];
  for (const name of ["01-plain-text", "02-slow-bash", "03-edit-todo", "04-task-subagent"]) {
    const t = timeline(name);
    out.push(...mapTimeline(Array.isArray(t) ? t : t.data ?? [], { sessionID: "s" }));
  }
  return out;
}

// One long tool run (each call returns a ~1.5 KB file read — a tool result is rarely smaller): 60 steps, a reasoning part every 2 tools, each step its own message with ONE tool.
function longRun(steps = 60) {
  const msgs = [{ info: { id: "u", role: "user" }, parts: [{ id: "u:t", type: "text", text: "go" }] }];
  for (let i = 0; i < steps; i++) {
    const id = `a${i}`;
    const parts = [];
    if (i % 2 === 1) parts.push({ id: `${id}:r`, messageID: id, type: "reasoning", text: "hmm, let me think about the next file" });
    parts.push(mapToolBlock({ id: `T${i}`, name: "read", state: { status: "completed", input: { path: `/work/src/module${i}/file${i}.ts` }, content: [{ type: "text", text: "line of a source file\n".repeat(70) }] } }, { messageID: id }));
    msgs.push({ info: { id, role: "assistant", time: { created: i, completed: i + 1 } }, parts });
  }
  return msgs;
}

const grow = (view, plain) => (bytes(view) - bytes(plain)) / bytes(plain);

test("payload guard: the RunRef fallback stays within +30% on (a) and (b), and is what is sent", () => {
  const fixtures = {
    a: typical(),
    b: longRun(60),
    c: [...typical(), ...longRun(60)],
  };
  const report = {};
  for (const [k, messages] of Object.entries(fixtures)) {
    const plain = slimTranscript(messages);
    const viewed = slimTranscript(annotateView(messages, { ledger: { epoch: "e", gen: 1, runView: () => null, runOfPart: () => null } }));
    report[k] = Number(grow(viewed, plain).toFixed(3));
  }
  const b = annotateView(fixtures.b);
  const touching = b.filter((m) => m.view?.runs?.length);
  assert.equal(touching[0].view.runs[0].ref, undefined, "the placement message carries the full view");
  assert.equal(touching[0].view.runs[0].segments.length > 1, true, "…with its segments");
  assert.equal(touching[1].view.runs[0].ref, true, "every other message carries a RunRef");
  assert.equal(touching[1].view.runs[0].segments, undefined, "…never with segments");
  console.log("payload growth", JSON.stringify(report));
  assert.ok(report.a <= LIMIT - 1, `fixture (a) grew ${report.a}`);
  assert.ok(report.b <= LIMIT - 1, `fixture (b) grew ${report.b}`);
});
