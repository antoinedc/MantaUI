import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createVcCallEngine } from "./vccall.mjs";

// A fake OpenAI Realtime WebSocket: an EventEmitter whose .send captures
// client→OpenAI messages and .close flips a flag. Tests drive the connection
// (server→client events) via receiveRealtime, the same path the real socket's
// on("message") dispatches through.
function makeFakeWs() {
  const ws = new EventEmitter();
  ws.sent = [];
  ws.closed = false;
  ws.send = (msg) => ws.sent.push(typeof msg === "string" ? msg : JSON.stringify(msg));
  ws.close = () => {
    ws.closed = true;
  };
  return ws;
}

function makeEngine(overrides = {}) {
  const ws = makeFakeWs();
  const published = [];
  const calls = [];
  const stateLog = [];
  const config = {
    openaiApiKey: "sk-test",
    cto: {
      model: "gpt-4o-realtime-preview",
      voice: "alloy",
      trustedActions: ["trusted_list_sessions"],
    },
  };
  const engine = createVcCallEngine({
    realtimeConnect: async () => ws,
    configGet: async () => config,
    dispatchCto: async (name, args, ctx) => {
      calls.push({ name, args, ctx });
      if (name === "confirmable_action") return { ok: true, needConfirmation: true, id: "cid-1", preview: "send the report" };
      if (name === "trusted_list_sessions") return { ok: true, sessions: [] };
      return { ok: true };
    },
    approveConfirm: (id) => {
      ws.approved = [...(ws.approved ?? []), id];
      return true;
    },
    rejectConfirm: (id) => {
      ws.rejected = [...(ws.rejected ?? []), id];
      return true;
    },
    publish: (m) => published.push(m),
    onState: (s) => stateLog.push(s),
    ...overrides,
  });
  engine.setTools([
    { name: "trusted_list_sessions", description: "list sessions", params: {} },
    { name: "confirmable_action", description: "an action", params: {} },
  ]);
  return { engine, ws, published, calls, stateLog, config };
}

function json(ws) {
  return ws.sent.map((s) => JSON.parse(s));
}

test("start connects and sends a session.update with the tools configured", async () => {
  const { engine, ws, stateLog } = makeEngine();
  await engine.start({ openaiApiKey: "sk-test", cto: { model: "m1", voice: "nova" } });
  const sent = json(ws);
  assert.ok(sent.some((m) => m.type === "session.update"), "session.update sent");
  const su = sent.find((m) => m.type === "session.update");
  assert.equal(su.session.voice, "nova");
  assert.equal(su.session.modalities.join(","), "audio,text");
  assert.equal(su.session.tools.length, 2);
  assert.equal(su.session.turn_detection.type, "server_vad");
  assert.equal(stateLog[0], "connecting");

  // Server → client: session.created flips the call live.
  engine.receiveRealtime({ type: "session.created", session: { id: "s1" } });
  assert.equal(stateLog.includes("live"), true);
});

test("function-call round-trip: dispatches to cto, emits working + cost, completes the call", async () => {
  const { engine, ws, published, calls } = makeEngine();
  await engine.start({ openaiApiKey: "sk-test", cto: {} });
  engine.receiveRealtime({ type: "session.created", session: { id: "s1" } });

  await engine.receiveRealtime({
    type: "response.function_call_arguments.done",
    call_id: "call-1",
    name: "trusted_list_sessions",
    arguments: "{}",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "trusted_list_sessions");
  // The trusted action runs without a confirm pause.
  assert.equal(published.some((m) => m.type === "working" && m.tool === "trusted_list_sessions"), true);
  const sent = json(ws);
  const output = sent.find((m) => m.type === "conversation.item.create" && m.item.type === "function_call_output");
  assert.ok(output, "function_call_output sent");
  assert.ok(output.item.output.includes('"ok":true'));
  assert.ok(sent.some((m) => m.type === "response.create"));
});

test("voice confirm: gated tool pauses, re-issue (spoken go-ahead) approves and runs", async () => {
  const { engine, ws, published, calls } = makeEngine();
  await engine.start({ openaiApiKey: "sk-test", cto: { trustedActions: [] } });
  engine.receiveRealtime({ type: "session.created", session: { id: "s1" } });

  // First call to a gated, untrusted action → pause for go-ahead.
  await engine.receiveRealtime({
    type: "response.function_call_arguments.done",
    call_id: "call-1",
    name: "confirmable_action",
    arguments: "{\"x\":1}",
  });
  assert.equal(published.some((m) => m.type === "confirm" && m.id === "cid-1"), true);
  assert.equal(await engine.listState().pendingConfirm?.tool, "confirmable_action");
  const sent = json(ws);
  const out = sent.find((m) => m.type === "conversation.item.create" && m.item.type === "function_call_output");
  assert.ok(out.item.output.includes("awaiting_confirmation"), "pauses for go-ahead");

  // The model re-issues the SAME tool+args (user said "go ahead") → approves + runs.
  calls.length = 0;
  const before = calls.length;
  await engine.receiveRealtime({
    type: "response.function_call_arguments.done",
    call_id: "call-2",
    name: "confirmable_action",
    arguments: "{\"x\":1}",
  });
  assert.ok(ws.approved?.includes("cid-1"), "approveConfirm called on the spoken go-ahead");
  // dispatchCto ran a second time (the approved re-dispatch).
  assert.equal(calls.length, 1);
  assert.equal(published.some((m) => m.type === "confirm-resolved" && m.ok === true), true);
  assert.equal(await engine.listState().pendingConfirm, null);
  assert.equal(before, 0);
});

test("barge: speech_started cancels the in-flight response and notifies the renderer", async () => {
  const { engine, ws, published } = makeEngine();
  await engine.start({ openaiApiKey: "sk-test", cto: {} });
  engine.receiveRealtime({ type: "session.created", session: { id: "s1" } });
  engine.receiveRealtime({ type: "input_audio_buffer.speech_started" });
  const sent = json(ws);
  assert.ok(sent.some((m) => m.type === "response.cancel"), "response.cancel sent on barge");
  assert.ok(published.some((m) => m.type === "barge"));
});

test("narration seam: onNarrate is threaded into the dispatch ctx", async () => {
  let narrated = null;
  const { engine, calls } = makeEngine({
    onNarrate: (t) => {
      narrated = t;
    },
  });
  await engine.start({ openaiApiKey: "sk-test", cto: {} });
  engine.receiveRealtime({ type: "session.created", session: { id: "s1" } });
  await engine.receiveRealtime({
    type: "response.function_call_arguments.done",
    call_id: "c",
    name: "trusted_list_sessions",
    arguments: "{}",
  });
  assert.equal(typeof calls[0].ctx.onNarrate, "function");
  // Call it and confirm the injected seam fires.
  calls[0].ctx.onNarrate("hello narration");
  assert.equal(narrated, "hello narration");
});

test("injectTurn: live inbound events are injected into the Realtime session", async () => {
  const { engine, ws } = makeEngine();
  await engine.start({ openaiApiKey: "sk-test", cto: {} });
  engine.injectTurn("deploy finished");
  const sent = json(ws);
  const item = sent.find((m) => m.type === "conversation.item.create" && m.item.type === "message");
  assert.ok(item, "injected conversation item");
  assert.equal(item.item.content[0].text, "deploy finished");
  assert.ok(sent.some((m) => m.type === "response.create"));
});

test("user audio + commit stream to the Realtime session", async () => {
  const { engine, ws } = makeEngine();
  await engine.start({ openaiApiKey: "sk-test", cto: {} });
  engine.handleUserAudio("AAAA");
  engine.commitAndRespond();
  const sent = json(ws);
  assert.ok(sent.some((m) => m.type === "input_audio_buffer.append" && m.audio === "AAAA"));
  assert.ok(sent.some((m) => m.type === "input_audio_buffer.commit"));
  assert.ok(sent.some((m) => m.type === "response.create"));
});

test("hangup tears down the Realtime session and returns to idle", async () => {
  const { engine, ws, stateLog } = makeEngine();
  await engine.start({ openaiApiKey: "sk-test", cto: {} });
  engine.receiveRealtime({ type: "session.created", session: { id: "s1" } });
  engine.hangup();
  assert.equal(ws.closed, true);
  assert.equal(stateLog[stateLog.length - 1], "idle");
});

test("park closes the session without silent spend and sets parked", async () => {
  const { engine, ws, stateLog } = makeEngine();
  await engine.start({ openaiApiKey: "sk-test", cto: {} });
  engine.receiveRealtime({ type: "session.created", session: { id: "s1" } });
  engine.park();
  assert.equal(ws.closed, true);
  assert.equal(stateLog[stateLog.length - 1], "parked");
});

test("reconnect: an unexpected realtime close while live enters a reconnecting state (not a permanent drop)", async () => {
  const { engine, ws, stateLog } = makeEngine({});
  await engine.start({ openaiApiKey: "sk-test", cto: { reconnect: { maxAttempts: 5, baseMs: 10 } } });
  engine.receiveRealtime({ type: "session.created", session: { id: "s1" } });
  // Simulate the provider dropping the socket mid-call.
  ws.emit("close");
  assert.equal(stateLog.includes("reconnecting"), true);
  assert.equal(stateLog.includes("dropped"), false, "reconnecting, not dropped");
});

test("reconnect: giving up after maxAttempts surfaces a dropped state", async () => {
  const { engine, ws, stateLog } = makeEngine({
    realtimeConnect: async () => {
      // First connect works; subsequent reconnect attempts fail.
      if (stateLog.filter((s) => s === "connecting").length <= 1) return ws;
      throw new Error("provider down");
    },
  });
  await engine.start({ openaiApiKey: "sk-test", cto: { reconnect: { maxAttempts: 1, baseMs: 5 } } });
  engine.receiveRealtime({ type: "session.created", session: { id: "s1" } });
  ws.emit("close"); // attempt 1 → reconnect
  await new Promise((r) => setTimeout(r, 20)); // let the reconnect attempt run + fail
  ws.emit("close"); // reconnect attempt's socket closes → attempt 2 >= max → dropped
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(stateLog.includes("reconnecting"), true);
  assert.equal(stateLog[stateLog.length - 1], "dropped");
});
