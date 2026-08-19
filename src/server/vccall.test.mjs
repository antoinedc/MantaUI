import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createVcCallEngine, awaitOpen, classifyConfirmReply } from "./vccall.mjs";

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
      model: "gpt-realtime-2.1",
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

// Engine for the voice-confirm flow tests. Its dispatchCto mimics the real cto
// engine: a confirmable tool returns needConfirmation until it has been
// approved (approveConfirm flips the flag), then the same call runs — the only
// way to observe "approves once" end to end.
function makeConfirmEngine(overrides = {}) {
  const ws = makeFakeWs();
  const published = [];
  const calls = [];
  let approved = false;
  const engine = createVcCallEngine({
    realtimeConnect: async () => ws,
    configGet: async () => ({ openaiApiKey: "sk-test", cto: { trustedActions: [] } }),
    dispatchCto: async (name, args, ctx) => {
      calls.push({ name, args, ctx });
      if (name === "confirmable_action") {
        return approved ? { ok: true } : { ok: true, needConfirmation: true, id: "cid-1", preview: "send the report" };
      }
      return { ok: true };
    },
    approveConfirm: (id) => {
      approved = true;
      ws.approved = [...(ws.approved ?? []), id];
      return true;
    },
    rejectConfirm: (id) => {
      ws.rejected = [...(ws.rejected ?? []), id];
      return true;
    },
    publish: (m) => published.push(m),
    ...overrides,
  });
  engine.setTools([
    { name: "confirmable_action", description: "an action", params: {} },
    { name: "trusted_list_sessions", description: "list sessions", params: {} },
  ]);
  return { engine, ws, published, calls };
}

async function startLive(engine) {
  await engine.start({ openaiApiKey: "sk-test", cto: {} });
  engine.receiveRealtime({ type: "session.created", session: { id: "s1" } });
}

// Raise the confirm pause for confirmable_action({x:1}) via GA's response.done.
async function raiseConfirm(engine) {
  await engine.receiveRealtime({
    type: "response.done",
    response: {
      output: [
        { type: "function_call", call_id: "call-1", name: "confirmable_action", arguments: '{"x":1}' },
      ],
    },
  });
}

test("start connects and sends a session.update with the tools configured", async () => {
  const { engine, ws, stateLog } = makeEngine();
  await engine.start({ openaiApiKey: "sk-test", cto: { model: "m1", voice: "nova" } });
  const sent = json(ws);
  assert.ok(sent.some((m) => m.type === "session.update"), "session.update sent");
  const su = sent.find((m) => m.type === "session.update");
  assert.equal(su.session.type, "realtime");
  assert.equal(su.session.audio.output.voice, "nova");
  assert.equal(su.session.audio.input.turn_detection.type, "server_vad");
  assert.equal(su.session.output_modalities.join(","), "audio");
  assert.equal(su.session.tools.length, 2);
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
    type: "response.done",
    response: {
      output: [
        { type: "function_call", call_id: "call-1", name: "trusted_list_sessions", arguments: "{}" },
      ],
    },
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

test("voice confirm: a gated tool pauses until the user's words authorize it", async () => {
  const { engine, ws, published } = makeConfirmEngine();
  await startLive(engine);

  // First call to a gated, untrusted action → pause for go-ahead.
  await raiseConfirm(engine);
  assert.equal(published.some((m) => m.type === "confirm" && m.id === "cid-1"), true);
  assert.equal(await engine.listState().pendingConfirm?.tool, "confirmable_action");
  const sent = json(ws);
  const out = sent.find((m) => m.type === "conversation.item.create" && m.item.type === "function_call_output");
  assert.ok(out.item.output.includes("awaiting_confirmation"), "pauses for go-ahead");
});

test("voice confirm: a model re-issue with NO affirmative user utterance does NOT approve", async () => {
  const { engine, ws, calls } = makeConfirmEngine();
  await startLive(engine);
  await raiseConfirm(engine); // paused
  calls.length = 0;

  // The model re-issues the SAME tool+args, but the user has said nothing.
  await engine.receiveRealtime({
    type: "response.done",
    response: {
      output: [
        { type: "function_call", call_id: "call-2", name: "confirmable_action", arguments: "{\"x\":1}" },
      ],
    },
  });
  assert.ok(!ws.approved?.includes("cid-1"), "no approval without a spoken yes");
  assert.equal(calls.length, 0, "action did NOT run (re-issue re-raised, not approved)");
  assert.equal(await engine.listState().pendingConfirm?.tool, "confirmable_action", "still pending");
});

test("voice confirm: re-issue AFTER an affirmative utterance approves once and runs", async () => {
  const { engine, ws, calls } = makeConfirmEngine();
  await startLive(engine);
  await raiseConfirm(engine); // paused
  calls.length = 0;

  // The user actually says yes (input transcription of their speech).
  engine.receiveRealtime({ type: "conversation.item.input_audio_transcription.completed", transcript: "yes" });
  assert.ok(ws.approved?.includes("cid-1"), "approveConfirm called on the spoken yes");

  // Now the model re-issues the same tool+args → it is authorized to run.
  await engine.receiveRealtime({
    type: "response.done",
    response: {
      output: [
        { type: "function_call", call_id: "call-3", name: "confirmable_action", arguments: '{"x":1}' },
      ],
    },
  });
  assert.equal(ws.approved?.filter((id) => id === "cid-1").length, 1, "approved exactly once");
  assert.equal(calls.length, 1, "approved re-issue dispatched and ran");
  assert.equal(await engine.listState().pendingConfirm, null, "pending cleared after approval");
});

test("voice confirm: a negative utterance rejects the pending confirm", async () => {
  const { engine, ws, published } = makeConfirmEngine();
  await startLive(engine);
  await raiseConfirm(engine); // paused

  engine.receiveRealtime({ type: "conversation.item.input_audio_transcription.completed", transcript: "no" });
  assert.ok(ws.rejected?.includes("cid-1"), "rejectConfirm called on a spoken no");
  assert.equal(await engine.listState().pendingConfirm, null, "pending cleared on reject");
  assert.equal(published.some((m) => m.type === "confirm-resolved" && m.ok === false), true);
  const sent = json(ws);
  assert.ok(sent.some((m) => m.type === "conversation.item.create" && m.item.role === "user"), "model told to replan");
});

test("voice confirm: an unclear utterance leaves it pending (not an approval)", async () => {
  const { engine, ws } = makeConfirmEngine();
  await startLive(engine);
  await raiseConfirm(engine); // paused

  engine.receiveRealtime({ type: "conversation.item.input_audio_transcription.completed", transcript: "huh what was that" });
  assert.ok(!ws.approved?.length, "unclear reply never approves");
  assert.ok(!ws.rejected?.length, "unclear reply never rejects");
  assert.equal(await engine.listState().pendingConfirm?.tool, "confirmable_action", "still pending until timeout aborts");
});

test("GA event names: output_audio delta + transcript deltas publish audio/transcript (BET-1178)", async () => {
  const { engine, published } = makeEngine();
  await engine.start({ openaiApiKey: "sk-test", cto: {} });
  engine.receiveRealtime({ type: "session.created", session: { id: "s1" } });

  engine.receiveRealtime({ type: "response.output_audio.delta", delta: "AAE=" });
  assert.equal(published.some((m) => m.type === "audio" && m.delta === "AAE="), true);

  engine.receiveRealtime({ type: "response.output_audio_transcript.delta", delta: "Hello" });
  assert.equal(published.some((m) => m.type === "transcript" && m.delta === "Hello" && m.role === "cto"), true);

  engine.receiveRealtime({ type: "response.output_audio_transcript.done", transcript: "Hello world" });
  assert.equal(published.some((m) => m.type === "transcript-finished" && m.text === "Hello world"), true);
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
    type: "response.done",
    response: {
      output: [
        { type: "function_call", call_id: "c", name: "trusted_list_sessions", arguments: "{}" },
      ],
    },
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

test("regression: the Realtime socket authenticates with the OpenAI key, not the Groq key (BET-1173)", async () => {
  // With BOTH groqApiKey and openaiApiKey present, the bearer token must be
  // the OpenAI key. A Groq key is required for chat dictation, so nearly every
  // user has one — a groqApiKey fallback would open the OpenAI Realtime socket
  // with a Groq credential, get rejected, and end in the dropped state.
  let capturedHeaders = null;
  const { engine } = makeEngine({
    realtimeConnect: async (url, headers) => {
      capturedHeaders = headers;
      const ws = makeFakeWs();
      return ws;
    },
  });
  await engine.start({
    groqApiKey: "gsk-groq",
    openaiApiKey: "sk-openai",
    cto: {},
  });
  assert.ok(capturedHeaders, "realtimeConnect was called");
  assert.equal(capturedHeaders.authorization, "Bearer sk-openai");
});

test("regression: the connect headers carry no openai-beta key (GA, not the retired beta interface) (BET-1178)", async () => {
  let capturedHeaders = null;
  const { engine } = makeEngine({
    realtimeConnect: async (url, headers) => {
      capturedHeaders = headers;
      return makeFakeWs();
    },
  });
  await engine.start({ openaiApiKey: "sk-openai", cto: {} });
  assert.ok(capturedHeaders, "realtimeConnect was called");
  assert.equal(capturedHeaders.authorization, "Bearer sk-openai");
  assert.ok(!Object.keys(capturedHeaders).some((k) => k.toLowerCase() === "openai-beta"), "no openai-beta header");
});

test("awaitOpen resolves once the socket emits open", async () => {
  const ws = makeFakeWs();
  const p = awaitOpen(ws);
  ws.emit("open");
  assert.equal(await p, ws);
});

test("awaitOpen rejects when the socket errors before open", async () => {
  const ws = makeFakeWs();
  const p = awaitOpen(ws);
  ws.emit("error", new Error("connect refused"));
  await assert.rejects(p);
});

test("awaitOpen rejects when the socket closes before open", async () => {
  const ws = makeFakeWs();
  const p = awaitOpen(ws);
  ws.emit("close");
  await assert.rejects(p);
});

test("awaitOpen removes all listeners once settled", async () => {
  const ws = makeFakeWs();
  const settled = awaitOpen(ws);
  ws.emit("open");
  await settled;
  assert.equal(ws.listenerCount("open"), 0);
  assert.equal(ws.listenerCount("error"), 0);
  assert.equal(ws.listenerCount("close"), 0);
});

test("a socket whose send throws publishes an error frame and does not propagate (start resolves)", async () => {
  const { engine, published } = makeEngine({
    realtimeConnect: async () => {
      const ws = makeFakeWs();
      ws.send = () => {
        throw new Error("socket dead");
      };
      return ws;
    },
  });
  // start() must resolve (not reject) — the write failure is contained.
  await engine.start({ openaiApiKey: "sk-test", cto: {} });
  assert.ok(
    published.some((m) => m.type === "error" && m.error === "realtime_send_failed"),
    "error frame published on failed send",
  );
});

// ---------------------------------------------------------------------------
// classifyConfirmReply
// ---------------------------------------------------------------------------

test("classifyConfirmReply: affirmative utterances → yes", () => {
  for (const t of ["yes", "yeah", "yep", "go ahead", "okay, do it", "sure, go ahead", "yes you can", "ok"]) {
    assert.equal(classifyConfirmReply(t), "yes", JSON.stringify(t));
  }
});

test("classifyConfirmReply: negative utterances → no", () => {
  for (const t of ["no", "nope", "no, cancel", "not now", "cancel that", "stop"]) {
    assert.equal(classifyConfirmReply(t), "no", JSON.stringify(t));
  }
});

test("classifyConfirmReply: ambiguous / empty / unrelated → unclear (never an approval)", () => {
  for (const t of ["", "   ", "hmm", "what's that", "thank you", "you know", "42"]) {
    assert.equal(classifyConfirmReply(t), "unclear", JSON.stringify(t));
  }
});

test("mic frames alone do NOT postpone the idle park (auto-park still fires)", async () => {
  // A controllable fake clock: the engine's timers live in `timers` and only
  // advance when `advance()` runs, so we can prove the idle deadline is NOT
  // pushed forward by raw mic packets.
  let fakeTime = 0;
  let seq = 0;
  const timers = new Map();
  const setTimer = (fn, ms) => {
    const id = ++seq;
    timers.set(id, { at: fakeTime + ms, fn });
    return id;
  };
  const clearTimer = (id) => {
    timers.delete(id);
  };
  const advance = (ms) => {
    fakeTime += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= fakeTime) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  const { engine, ws } = makeEngine({
    now: () => fakeTime,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
  });
  await engine.start({ openaiApiKey: "sk-test", cto: { idleParkMs: 100, model: "m", voice: "v" } });
  engine.receiveRealtime({ type: "session.created", session: { id: "s1" } });
  assert.equal(engine.listState().status, "live");

  // Continuously stream mic frames for 90ms. The idle deadline is armed at
  // t=100; re-arming it from each frame (the old behaviour) would keep it at
  // t≈190, so the original deadline would be the proof of the fix.
  for (let i = 0; i < 90; i++) {
    advance(1);
    engine.handleUserAudio("AAAA");
  }
  assert.equal(engine.listState().status, "live", "still live while the deadline hasn't passed");

  // Cross the ORIGINAL deadline (t=100). A deadline reset by mic frames would
  // still be in the future at t=105 → the fixed engine auto-parks, the buggy
  // one would not.
  advance(15);
  assert.equal(engine.listState().status, "parked", "auto-parked at the idle deadline despite mic frames");
  assert.equal(ws.closed, true, "realtime session torn down on auto-idle park");
});

test("response.done usage accumulates spend and hangs up once the cap is crossed", async () => {
  const { engine, ws, published } = makeEngine();
  await engine.start({ openaiApiKey: "sk-test", cto: { spendCapUsd: 0.1, model: "m", voice: "v" } });
  engine.receiveRealtime({ type: "session.created", session: { id: "s1" } });
  assert.equal(ws.closed, false, "call live before spend");

  // 1000 text + 1000 audio input tokens; 500 text + 2000 audio output tokens
  // → $0.045 + $0.17 = $0.215 (see REALTIME_TOKEN_RATES). That crosses cap $0.10.
  const usage = {
    input_token_details: { text_tokens: 1000, audio_tokens: 1000 },
    output_token_details: { text_tokens: 500, audio_tokens: 2000 },
  };
  engine.receiveRealtime({ type: "response.done", usage });

  const costs = published.filter((m) => m.type === "cost");
  assert.equal(costs.length, 1, "a cost frame was published");
  assert.ok(Math.abs(costs[0].usd - 0.215) < 1e-9, "cost frame reflects response usage");
  assert.equal(ws.closed, true, "hung up once the cap is crossed");
  assert.equal(engine.listState().status, "idle");
  assert.ok(published.some((m) => m.type === "notify" && /\bspend cap\b/i.test(m.message)), "cap notify published");
});

test("spend accumulates across responses below the cap", async () => {
  const { engine, published } = makeEngine();
  await engine.start({ openaiApiKey: "sk-test", cto: { model: "m", voice: "v" } });
  engine.receiveRealtime({ type: "session.created", session: { id: "s1" } });
  const usage = {
    input_token_details: { text_tokens: 1000, audio_tokens: 1000 },
    output_token_details: { text_tokens: 500, audio_tokens: 2000 },
  };
  engine.receiveRealtime({ type: "response.done", usage });
  engine.receiveRealtime({ type: "response.done", usage });
  const costs = published.filter((m) => m.type === "cost");
  assert.equal(costs.length, 2);
  assert.ok(Math.abs(costs[1].usd - 0.43) < 1e-9, "spend accumulates across responses");
});

test("response.done without a usable usage breakdown does NOT invent spend", async () => {
  const { engine, ws, published } = makeEngine();
  await engine.start({ openaiApiKey: "sk-test", cto: { spendCapUsd: 0.01, model: "m" } });
  engine.receiveRealtime({ type: "session.created", session: { id: "s1" } });
  engine.receiveRealtime({ type: "response.done", usage: { total_tokens: 5000 } });
  assert.equal(published.some((m) => m.type === "cost"), false, "no cost frame from unusable usage");
  assert.equal(ws.closed, false, "not hung up on an un-priceable response");
});
