// WS11 D11 — event/canonical PARITY for the run ledger: for each V2 event script, the ledger's runs, segments, closed set and
// layout equal what `transcriptRuns.computeRuns` makes of the equivalent canonical messages. This is the drift guard that
// replaced the desktop/iOS wording fixture. Plus the boundary machinery (unknown delivery classes, buffering, provisional
// boundaries and the canonical rebuild), revisions and coalescing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStreamInterpreter } from "./streamInterp.mjs";
import { computeRuns, runView } from "./transcriptRuns.mjs";
import { annotateView, annotateSingle } from "./transcriptView.mjs";
import { mapToolBlock } from "../shared/opencodeV2.mjs";

const SID = "ses_main";
let n = 0;
const ev = (type, data = {}) => ({ id: `evt_${++n}`, type, data: { sessionID: SID, ...data } });

function rig(opts = {}) {
  let clock = 1_000_000;
  const frames = [];
  const timers = [];
  const interp = createStreamInterpreter({
    publish: (e) => frames.push(e),
    epoch: "E1",
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { at: clock + ms, fn, dead: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => (t.dead = true),
    ...opts,
  });
  const advance = async (ms) => {
    const until = clock + ms;
    for (;;) {
      const due = timers.filter((t) => !t.dead && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.dead = true;
      clock = due.at;
      due.fn();
      await new Promise((r) => setImmediate(r));
    }
    clock = until;
  };
  const settle = async () => {
    await advance(10_000);
    await new Promise((r) => setImmediate(r));
  };
  return { interp, frames, advance, settle, tick: (ms) => (clock += ms), runFrames: () => frames.filter((f) => f.sub === "toolRuns").map((f) => f.payload) };
}

// ---- a client-side reducer for the frames (the rev rule, simplified: newest seq of the current gen wins) ----
function reduce(payloads) {
  const runs = new Map();
  let layout = [];
  const closed = new Set();
  for (const p of payloads) {
    if (p.full) {
      runs.clear();
      closed.clear();
    }
    if (p.rebuilt) for (const id of p.retired) runs.delete(id);
    layout = p.layout;
    for (const r of p.runs) {
      const cur = runs.get(r.id);
      if (!cur || r.rev.gen > cur.rev.gen || (r.rev.gen === cur.rev.gen && r.rev.seq >= cur.rev.seq)) runs.set(r.id, r);
    }
    for (const id of p.closed) closed.add(id);
  }
  return { runs, layout, closed };
}

// ---- one script → raw events AND canonical messages ----
function build(script) {
  const events = [];
  const messages = [];
  const parts = new Map();
  const msg = (id, role) => {
    let m = messages.find((x) => x.info.id === id);
    if (!m) messages.push((m = { info: { id, role }, parts: [] }));
    return m;
  };
  for (const s of script) {
    switch (s.k) {
      case "user":
        events.push(ev("session.inbox.enqueued", { inboxID: s.id, item: { type: "user", id: s.id, payload: { text: s.text }, delivery: "steer" } }));
        events.push(ev("session.inbox.delivered", { inboxID: s.id }));
        msg(s.id, "user").parts.push({ id: `${s.id}:text:0`, type: "text", text: s.text });
        break;
      case "text":
        events.push(ev("session.text.delta", { assistantMessageID: s.msg, ordinal: s.ord ?? 0, delta: s.text }));
        msg(s.msg, "assistant").parts.push({ id: `${s.msg}:text:${s.ord ?? 0}`, type: "text", text: s.text });
        break;
      case "reasoning":
        events.push(ev("session.reasoning.delta", { assistantMessageID: s.msg, ordinal: s.ord ?? 0, delta: s.text }));
        msg(s.msg, "assistant").parts.push({ id: `${s.msg}:reasoning:${s.ord ?? 0}`, type: "reasoning", text: s.text });
        break;
      case "tool": {
        const name = s.name ?? "read";
        const input = s.input ?? { path: `/w/${s.id}.ts` };
        events.push(ev("session.tool.input.started", { assistantMessageID: s.msg, id: s.id, name }));
        events.push(ev("session.tool.called", { assistantMessageID: s.msg, id: s.id, input }));
        const out = s.output ?? "";
        const ok = s.ok !== false;
        events.push(ok
          ? ev("session.tool.success", { assistantMessageID: s.msg, id: s.id, content: [{ type: "text", text: out }] })
          : ev("session.tool.failed", { assistantMessageID: s.msg, id: s.id, error: { message: "boom" } }));
        msg(s.msg, "assistant").parts.push(mapToolBlock({ id: s.id, name, state: ok ? { status: "completed", input, content: [{ type: "text", text: out }] } : { status: "error", input, error: { message: "boom" } } }, { messageID: s.msg }));
        break;
      }
      case "exec":
        // An execution boundary: never a run boundary (rule 8) and not a transcript record.
        events.push(ev(s.ok === false ? "session.execution.failed" : "session.execution.succeeded", {}));
        events.push(ev("session.execution.started", {}));
        break;
      case "hidden":
        // A synthetic (non-subagent) inbox item: delivered, but it never becomes a drawn message — transparent to a run.
        events.push(ev("session.inbox.enqueued", { inboxID: s.id, item: { type: "synthetic", id: s.id, text: s.text ?? "note", metadata: {} } }));
        events.push(ev("session.inbox.delivered", { inboxID: s.id }));
        break;
      default:
        throw new Error(s.k);
    }
  }
  void parts;
  return { events, messages };
}

const sig = (v) => ({ id: v.id, owner: v.ownerMessageId, label: v.label, calls: v.calls, failed: v.failed, tone: v.tone, live: v.live, segments: v.segments });

function canonicalLayout(messages) {
  const out = [];
  const keys = new Set();
  const { walker, partRun } = computeRuns(messages);
  const push = (e, k) => (keys.has(k) ? 0 : (keys.add(k), out.push(e)));
  for (const m of messages) {
    if (m.info.role !== "assistant") continue;
    for (const p of m.parts) {
      const at = partRun.get(p.id);
      if (at) push({ kind: "run", id: at.runId, segmentId: at.segmentId }, `run:${at.runId}:${at.segmentId}`);
      else if (p.type === "text" && p.text.trim()) push({ kind: "text", partID: p.id, messageID: m.info.id }, `t:${p.id}`);
      else if (p.type === "reasoning" && p.text.trim()) push({ kind: "reasoning", partID: p.id, messageID: m.info.id }, `r:${p.id}`);
    }
  }
  return { walker, layout: out };
}

async function parity(script, name) {
  const { events, messages } = build(script);
  const { interp, runFrames, settle } = rig();
  for (const e of events) interp.interpret(e);
  await settle();
  const live = reduce(runFrames());
  const { walker, layout } = canonicalLayout(messages);
  const canon = new Map(walker.order.map((id) => [id, runView(walker, walker.runs.get(id), { epoch: "E1", gen: 1, seq: 0 })]));
  assert.deepEqual([...live.runs.keys()].sort(), [...canon.keys()].sort(), `${name}: run ids`);
  for (const [id, view] of canon) assert.deepEqual(sig(live.runs.get(id)), sig(view), `${name}: run ${id}`);
  const closedCanon = walker.order.filter((id) => walker.runs.get(id).closed);
  assert.deepEqual([...live.closed].filter((id) => live.runs.has(id)).sort(), closedCanon.sort(), `${name}: closed`);
  // The ledger resets at a drawing user message; the canonical layout of an assistant-only script has none, so compare directly.
  assert.deepEqual(live.layout.map((e) => (e.kind === "run" ? { kind: "run", id: e.id, segmentId: e.segmentId } : e)), layout, `${name}: layout`);
  return { live, canon };
}

test("(1) tool → text → tool → reasoning → tool: layout run,text,run(+segment); ids are first parts", async () => {
  const { live } = await parity([
    { k: "user", id: "u1", text: "go" },
    { k: "tool", msg: "a1", id: "A1" },
    { k: "text", msg: "a1", text: "Found it." },
    { k: "tool", msg: "a1", id: "B1", name: "shell", input: { command: "ls" } },
    { k: "reasoning", msg: "a2", text: "thinking" },
    { k: "tool", msg: "a2", id: "B2" },
  ], "script 1");
  assert.deepEqual(live.layout.map((e) => `${e.kind}:${e.id ?? e.partID}`), ["run:A1", "text:a1:text:0", "run:B1", "reasoning:a2:reasoning:0", "run:B1"]);
  assert.equal(live.runs.get("B1").segments.length, 2);
});

test("(2) two text parts and a tool in ONE message", async () => {
  await parity([
    { k: "user", id: "u1", text: "go" },
    { k: "text", msg: "a1", ord: 0, text: "one" },
    { k: "tool", msg: "a1", id: "T1" },
    { k: "text", msg: "a1", ord: 1, text: "two" },
  ], "script 2");
});

test("(3) tool A → background-job completion USER message delivered → tool B: ONE run, id A, live and canonical", async () => {
  const { live } = await parity([
    { k: "user", id: "u1", text: "go" },
    { k: "tool", msg: "a1", id: "A" },
    { k: "user", id: "u2", text: '[background job "x" done]\n\nbody' },
    { k: "tool", msg: "a2", id: "B" },
  ], "script 3").catch((e) => { throw e; });
  assert.deepEqual([...live.runs.keys()], ["A"]);
});

test("(4) a tool → a hidden synthetic-only inbox message across two executions → a tool: ONE run, live and canonical", async () => {
  const { live } = await parity([
    { k: "user", id: "u1", text: "go" },
    { k: "tool", msg: "a1", id: "A" },
    { k: "exec" },
    { k: "hidden", id: "h1" },
    { k: "tool", msg: "a2", id: "B" },
  ], "script 4");
  assert.deepEqual([...live.runs.keys()], ["A"]);
  assert.equal(live.runs.get("A").calls, 2);
});

test("(11) segment layout: A → R → B is [run(A,A), reasoning R, run(A,B)] live and in the canonical walk", async () => {
  const { live } = await parity([
    { k: "user", id: "u1", text: "go" },
    { k: "tool", msg: "a1", id: "A" },
    { k: "reasoning", msg: "a2", text: "thinking it over" },
    { k: "tool", msg: "a2", id: "B" },
  ], "script 11");
  assert.deepEqual(live.layout.map((e) => (e.kind === "run" ? `run:${e.id}/${e.segmentId}` : `${e.kind}:${e.partID}`)), ["run:A/A", "reasoning:a2:reasoning:0", "run:A/B"]);
});

test("(5) a drawing user message ends the run (and resets the turn): two runs across two turns", async () => {
  const { events } = build([{ k: "user", id: "u1", text: "go" }, { k: "tool", msg: "a1", id: "A" }, { k: "user", id: "u2", text: "next" }, { k: "tool", msg: "a2", id: "B" }]);
  const { interp, runFrames, settle } = rig();
  for (const e of events) interp.interpret(e);
  await settle();
  const live = reduce(runFrames());
  assert.deepEqual([...live.runs.keys()], ["B"], "the new turn's ledger starts empty (A is canonical history now)");
  assert.deepEqual(live.layout.map((e) => e.id), ["B"]);
});

test("(7) a delegate call's live label equals the canonical one (name from the OUTPUT)", async () => {
  const { live, canon } = await parity([
    { k: "user", id: "u1", text: "go" },
    { k: "tool", msg: "a1", id: "D", name: "mcp_delegate_delegate", input: { prompt: "Run the sync nightly" }, output: 'Started job "nightly-sync" (id 198262c2). Result later.' },
  ], "script 7");
  assert.equal(live.runs.get("D").label, "Started background job nightly-sync");
  assert.equal(canon.get("D").label, live.runs.get("D").label);
});

test("(8) coalescing — tool events inside 100 ms fold into ONE frame whose runs/closed cover all of them", async () => {
  const { interp, runFrames, advance, tick } = rig();
  interp.interpret(ev("session.inbox.delivered", { inboxID: "u1" }));
  const before = runFrames().length;
  for (const id of ["A", "B", "C", "D", "E"]) {
    interp.interpret(ev("session.tool.input.started", { assistantMessageID: "a1", id, name: "read" }));
    tick(5);
  }
  await advance(200);
  const fresh = runFrames().slice(before);
  assert.ok(fresh.length <= 2, `expected a leading + one trailing frame, got ${fresh.length}`);
  const live = reduce(runFrames());
  assert.equal(live.runs.get("A").calls, 5);
});

test("(9) the connect snapshot carries a full toolRuns frame with the whole layout, and runningSet carries the epoch (12)", async () => {
  const { events } = build([{ k: "user", id: "u1", text: "go" }, { k: "tool", msg: "a1", id: "A" }, { k: "text", msg: "a1", text: "hi" }]);
  const { interp, settle } = rig();
  for (const e of events) interp.interpret(e);
  await settle();
  const snap = interp.snapshotState();
  assert.equal(snap[0].kind, "runningSet");
  assert.equal(snap[0].payload.epoch, "E1");
  const f = snap.find((x) => x.sub === "toolRuns");
  assert.equal(f.sessionId, SID);
  assert.equal(f.payload.full, true);
  assert.deepEqual(f.payload.layout.map((e) => e.kind), ["run", "text"]);
  assert.equal(f.payload.runs[0].id, "A");
});

test("(10) revisions — an earlier tool completes AFTER a later one joined: the run's rev rises, and getMessage of the EARLIER message carries it", async () => {
  const { interp, runFrames, settle } = rig();
  interp.interpret(ev("session.inbox.delivered", { inboxID: "u1" }));
  interp.interpret(ev("session.tool.input.started", { assistantMessageID: "a1", id: "A", name: "read" }));
  interp.interpret(ev("session.tool.called", { assistantMessageID: "a1", id: "A", input: { path: "/x/a.ts" } }));
  interp.interpret(ev("session.tool.input.started", { assistantMessageID: "a2", id: "B", name: "read" }));
  await settle();
  const seqBefore = reduce(runFrames()).runs.get("A").rev.seq;
  interp.interpret(ev("session.tool.success", { assistantMessageID: "a1", id: "A", content: [{ type: "text", text: "ok" }] }));
  await settle();
  const after = reduce(runFrames()).runs.get("A");
  assert.ok(after.rev.seq > seqBefore);
  const ledger = interp.ledgerFor(SID);
  const early = annotateSingle(
    { info: { id: "a1", role: "assistant" }, parts: [mapToolBlock({ id: "A", name: "read", state: { status: "completed", input: { path: "/x/a.ts" }, content: [] } }, { messageID: "a1" })] },
    { ledger },
  );
  assert.equal(early.view.runs[0].rev.seq, after.rev.seq);
  assert.equal(early.parts[0].view.runId, "A");
  assert.equal(early.parts[0].view.gen, 1);
});

// ---- boundaries the ledger could not classify at enqueue time ----
const unknownDelivery = (id) => ev("session.inbox.delivered", { inboxID: id }); // never enqueued here → class unknown

test("(6) unknown class resolving AFTER tool B's events: with \"draws\" B starts a NEW run, with \"transparent\" B joins run A — never a lost part", async () => {
  for (const cls of ["draws", "transparent"]) {
    let resolve;
    const { interp, runFrames, settle } = rig({ classifyDelivered: () => new Promise((r) => (resolve = r)) });
    interp.interpret(ev("session.tool.input.started", { assistantMessageID: "a1", id: "A", name: "read" }));
    interp.interpret(ev("session.tool.called", { assistantMessageID: "a1", id: "A", input: { path: "/x/a.ts" } }));
    interp.interpret(unknownDelivery("u2"));
    interp.interpret(ev("session.tool.input.started", { assistantMessageID: "a2", id: "B", name: "read" }));
    interp.interpret(ev("session.tool.called", { assistantMessageID: "a2", id: "B", input: { path: "/x/b.ts" } }));
    assert.deepEqual([...reduce(runFrames()).runs.keys()], ["A"], "B is buffered while the lookup is pending");
    resolve({ cls, user: false });
    await settle();
    const live = reduce(runFrames());
    if (cls === "draws") assert.deepEqual([...live.runs.keys()].sort(), ["A", "B"]);
    else {
      assert.deepEqual([...live.runs.keys()], ["A"]);
      assert.equal(live.runs.get("A").calls, 2);
    }
  }
});

test("(6) a classification that fails or times out resolves as a boundary (provisional) and replays the buffer; reconnect resolves it before resync frames", async () => {
  // timeout
  {
    const { interp, runFrames, advance } = rig({ classifyDelivered: () => new Promise(() => {}), });
    interp.interpret(ev("session.tool.input.started", { assistantMessageID: "a1", id: "A", name: "read" }));
    interp.interpret(unknownDelivery("u2"));
    interp.interpret(ev("session.tool.input.started", { assistantMessageID: "a2", id: "B", name: "read" }));
    await advance(3100);
    assert.deepEqual([...reduce(runFrames()).runs.keys()].sort(), ["A", "B"]);
    assert.equal(interp.runLedger._state(SID).provisional != null, true);
  }
  // failure
  {
    const { interp, runFrames, settle } = rig({ classifyDelivered: () => Promise.reject(new Error("down")) });
    interp.interpret(ev("session.tool.input.started", { assistantMessageID: "a1", id: "A", name: "read" }));
    interp.interpret(unknownDelivery("u2"));
    interp.interpret(ev("session.tool.input.started", { assistantMessageID: "a2", id: "B", name: "read" }));
    await settle();
    assert.deepEqual([...reduce(runFrames()).runs.keys()].sort(), ["A", "B"]);
  }
  // reconnect while pending
  {
    const { interp, runFrames } = rig({ classifyDelivered: () => new Promise(() => {}) });
    interp.interpret(ev("session.tool.input.started", { assistantMessageID: "a1", id: "A", name: "read" }));
    interp.interpret(unknownDelivery("u2"));
    interp.interpret(ev("session.tool.input.started", { assistantMessageID: "a2", id: "B", name: "read" }));
    interp.resync(SID, { running: true });
    assert.deepEqual([...reduce(runFrames()).runs.keys()].sort(), ["A", "B"], "the boundary is resolved before the resync frames");
  }
});

test("(6c) provisional repair: a timed-out boundary that was truly transparent splits A | B, then turnComplete rebuilds ONE run A (gen 2, retired B)", async () => {
  const canonical = [
    { info: { id: "u1", role: "user" }, parts: [{ id: "u1:text:0", type: "text", text: "go" }] },
    { info: { id: "a1", role: "assistant" }, parts: [mapToolBlock({ id: "A", name: "read", state: { status: "completed", input: { path: "/x/a.ts" }, content: [] } }, { messageID: "a1" })] },
    { info: { id: "u2", role: "user" }, parts: [{ id: "u2:text:0", type: "text", text: '[background job "x" done]' }] },
    { info: { id: "a2", role: "assistant" }, parts: [mapToolBlock({ id: "B", name: "read", state: { status: "completed", input: { path: "/x/b.ts" }, content: [] } }, { messageID: "a2" })] },
  ];
  let late;
  const { interp, runFrames, advance, settle } = rig({
    classifyDelivered: () => new Promise((r) => (late = r)),
    rebuildFromCanonical: async () => canonical,
  });
  interp.interpret(ev("session.tool.input.started", { assistantMessageID: "a1", id: "A", name: "read" }));
  interp.interpret(ev("session.tool.called", { assistantMessageID: "a1", id: "A", input: { path: "/x/a.ts" } }));
  interp.interpret(unknownDelivery("u2"));
  interp.interpret(ev("session.tool.input.started", { assistantMessageID: "a2", id: "B", name: "read" }));
  await advance(3100);
  assert.deepEqual([...reduce(runFrames()).runs.keys()].sort(), ["A", "B"], "guessed split");
  interp.interpret(ev("session.execution.succeeded"));
  await settle();
  const frames = runFrames();
  const rebuilt = frames.find((f) => f.rebuilt);
  assert.ok(rebuilt, "a rebuilt frame");
  assert.deepEqual([rebuilt.full, rebuilt.gen, rebuilt.retired], [true, 2, ["B"]]);
  const live = reduce(frames);
  assert.deepEqual([...live.runs.keys()], ["A"]);
  assert.equal(live.runs.get("A").calls, 2);
  // the late lookup result is ignored; getMessage of B's message stamps run A at gen 2
  late({ cls: "draws", user: false });
  await settle();
  assert.equal(frames.length, runFrames().length, "no further frame from the stale lookup");
  const single = annotateSingle(canonical[3], { ledger: interp.ledgerFor(SID) });
  assert.equal(single.parts[0].view.runId, "A");
  assert.equal(single.parts[0].view.gen, 2);
});

test("(6c) an AGREEING late result clears the provisional mark without a rebuild", async () => {
  let late;
  const { interp, runFrames, advance, settle } = rig({ classifyDelivered: () => new Promise((r) => (late = r)), rebuildFromCanonical: async () => { throw new Error("must not rebuild"); } });
  interp.interpret(ev("session.tool.input.started", { assistantMessageID: "a1", id: "A", name: "read" }));
  interp.interpret(unknownDelivery("u2"));
  await advance(3100);
  late({ cls: "draws", user: false });
  await settle();
  assert.equal(interp.runLedger._state(SID).provisional, null);
  assert.equal(runFrames().some((f) => f.rebuilt), false);
});

test("(6b) a native synthetic background RESULT (metadata.source subagent) draws: A, B are TWO runs live", async () => {
  const { interp, runFrames, settle } = rig();
  interp.interpret(ev("session.inbox.delivered", { inboxID: "u1" }));
  interp.interpret(ev("session.tool.input.started", { assistantMessageID: "a1", id: "A", name: "read" }));
  interp.interpret(ev("session.inbox.enqueued", { inboxID: "s1", item: { type: "synthetic", id: "s1", text: '<subagent sessionID="ses_c" state="completed">\nok\n</subagent>', metadata: { source: "subagent", childID: "ses_c", state: "completed" } } }));
  interp.interpret(ev("session.inbox.delivered", { inboxID: "s1" }));
  interp.interpret(ev("session.tool.input.started", { assistantMessageID: "a2", id: "B", name: "read" }));
  await settle();
  const live = reduce(runFrames());
  assert.deepEqual([...live.runs.keys()].sort(), ["A", "B"]);
  assert.ok(live.layout.length >= 2, "the turn's layout survives a (non-user) boundary");
});

test("the canonical annotation: a run the ledger knows is emitted with the LEDGER's view/rev; history it does not know gets seq 0", () => {
  const A = mapToolBlock({ id: "A", name: "read", state: { status: "completed", input: { path: "/x/a.ts" }, content: [] } }, { messageID: "a1" });
  const out = annotateView([{ info: { id: "a1", role: "assistant" }, parts: [A] }], {
    ledger: { epoch: "E1", gen: 3, runView: (id) => (id === "A" ? { id: "A", rev: { epoch: "E1", gen: 3, seq: 9 }, label: "LIVE" } : null), runOfPart: () => null },
  });
  assert.equal(out[0].view.runs[0].label, "LIVE");
  assert.equal(out[0].view.runs[0].rev.seq, 9);
  const cold = annotateView([{ info: { id: "a1", role: "assistant" }, parts: [A] }], { ledger: { epoch: "E1", gen: 3, runView: () => null, runOfPart: () => null } });
  assert.deepEqual(cold[0].view.runs[0].rev, { epoch: "E1", gen: 3, seq: 0 });
  assert.equal(cold[0].parts[0].view.activity.label, "Read a.ts");
});

test("window edges: a run that began before the window keeps its TRUE id and owner when walked over the extended context", () => {
  const mk = (id, tid) => ({ info: { id, role: "assistant" }, parts: [mapToolBlock({ id: tid, name: "read", state: { status: "completed", input: { path: `/x/${tid}.ts` }, content: [] } }, { messageID: id })] });
  const all = [mk("a1", "T1"), mk("a2", "T2"), mk("a3", "T3")];
  const window = all.slice(1);
  const wide = annotateView(window, { runContext: all });
  assert.equal(wide[0].view.runs[0].id, "T1", "true id");
  assert.equal(wide[0].view.runs[0].ownerMessageId, "a1", "true owner (outside the window)");
  assert.equal(wide[0].view.runs[0].calls, 3);
  const narrow = annotateView(window);
  assert.equal(narrow[0].view.runs[0].id, "T2", "no lookback: the run is annotated as if it started at the window");
  // widening the window gives the SAME id
  assert.equal(annotateView(all)[0].view.runs[0].id, "T1");
});
