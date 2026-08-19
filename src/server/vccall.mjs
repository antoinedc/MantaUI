// vccall.mjs — the on-call CTO voice-call engine (BET-1166, issue 3/3).
//
// Owns the OpenAI Realtime WebSocket session (server-relayed transport). The
// renderer's call window never talks to OpenAI directly and never sees the
// API key: it streams opus mic frames up a local, auth-gated /call WS and
// receives audio + transcript + intent events back down it. THIS module is
// the brain between the two — a pure, injectable state machine so the whole
// Realtime protocol (barge, function-call loop → cto.dispatch, voice
// confirmation, narration injection, lifecycle) is unit-testable against a
// MOCKED OpenAI Realtime WS with no live socket.
//
// Design rules (mirror cto.mjs / delegate.mjs): pure decision logic with
// injected I/O. `deps` supplies every I/O:
//   - realtimeConnect(url, headers) → a ws-like (EventEmitter with .send)
//   - dispatchCto(name, args, ctx)   → cto.dispatch from issue 1
//   - approveConfirm / rejectConfirm → cto engine's voice-confirm handlers
//   - configGet()                    → AppConfig (model/voice/trustedActions/…)
//   - synthesizeSpeech({text,apiKey})→ Groq Orpheus TTS (narration)
//   - publish(msg)                   → emit a message down the /call WS
//   - now()                          → clock (for idle/cost accounting)
//   - onState(state)                 → state-change hook (tests observe)
//
// The Realtime session is torn down on park and hangup so there is no silent
// per-minute OpenAI spend (cost guard).

import { WebSocket as NodeWebSocket } from "ws";

const REALTIME_BASE = "wss://api.openai.com/v1/realtime";
const DEFAULT_REALTIME_MODEL = "gpt-4o-realtime-preview";
const DEFAULT_VOICE = "alloy";

// Cost cap defaults (USD). Per-call cap disconnects + notifies; a generous
// auto-idle park leaves the model no silent spend.
export const DEFAULT_SPEND_CAP_USD = 5;
export const DEFAULT_IDLE_PARK_MS = 60_000;

// The Realtime session is instructed to ask for go-ahead before acting on a
// confirm-mode tool. This is the contract the model follows (issue 2's text
// confirm loop, issued 3's voice loop).
const SESSION_INSTRUCTIONS = [
  "You are the on-call CTO voice assistant. You have deterministic read tools.",
  "When a tool needs the user's go-ahead, you MUST pause and state exactly",
  "what you are about to do, then WAIT for a spoken yes/no. Do not act until",
  "the user answers. If the user says no or cancels, explain and replan.",
].join(" ");

export function clampModel(v, dflt) {
  return typeof v === "string" && v.trim() ? v.trim() : dflt;
}

/**
 * Build the vccall engine. Returns a control surface plus the low-level
 * `receiveRealtime(evt, send)` dispatcher so tests can drive a fake WS.
 */
export function createVcCallEngine(deps = {}) {
  const {
    realtimeConnect = defaultRealtimeConnect,
    dispatchCto = async () => ({ ok: true }),
    approveConfirm = () => true,
    rejectConfirm = () => true,
    configGet = async () => ({}),
    synthesizeSpeech = async () => ({ buffer: new Uint8Array(0), mime: "audio/mpeg" }),
    publish = () => {},
    onNarrate = () => {},
    onState = () => {},
    now = () => Date.now(),
  } = deps;

  const state = {
    active: false, // a live call is open (set true on session.created)
    status: "idle", // idle | connecting | live | parked | dropped | reconnecting
    openai: null, // ws-like to OpenAI
    tools: [], // [{name,description,params}]
    session: null,
    pendingConfirm: null, // {id, tool, preview, at}
    ongoingSpend: 0, // per-call USD spent
    idleTimer: null,
    startedAt: null,
    apiKey: null,
    model: null,
    voice: null,
    cfg: {},
    reconnectAttempts: 0,
    reconnectTimer: null,
    caps: {
      spendCapUsd: DEFAULT_SPEND_CAP_USD,
      idleParkMs: DEFAULT_IDLE_PARK_MS,
      maxReconnectAttempts: 5,
      reconnectBaseMs: 1000,
    },
  };

  function setStatus(s) {
    state.status = s;
    onState(s);
    publish({ type: "state", state: s });
  }

  function clearIdleTimer() {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
  }

  function armIdleTimer() {
    clearIdleTimer();
    if (!state.caps.idleParkMs) return;
    state.idleTimer = setTimeout(() => {
      // Auto-idle → park: tear down the Realtime session (no silent spend).
      if (state.status === "live") {
        publish({ type: "notify", message: "Calls idle — closed the session." });
        park();
      }
    }, state.caps.idleParkMs);
    if (state.idleTimer?.unref) state.idleTimer.unref();
  }

  function spend(usd) {
    state.ongoingSpend += usd;
    publish({ type: "cost", usd: state.ongoingSpend });
    if (state.ongoingSpend >= state.caps.spendCapUsd) {
      publish({ type: "notify", message: "Call spend cap reached — disconnected." });
      hangup();
    }
  }

  // Emit a message down the /call WS to the renderer.
  function emit(msg) {
    publish(msg);
  }

  // -------------------------------------------------------------------------
  // Starting a call
  // -------------------------------------------------------------------------

  async function start(cfg = {}) {
    if (state.status === "connecting" || state.status === "live") return;
    state.cfg = cfg;
    const conf = cfg?.cto ?? {};
    const apiKey = cfg?.groqApiKey || cfg?.openaiApiKey;
    state.caps = {
      spendCapUsd: typeof cfg?.cto?.spendCapUsd === "number" ? cfg.cto.spendCapUsd : DEFAULT_SPEND_CAP_USD,
      idleParkMs: typeof cfg?.cto?.idleParkMs === "number" ? cfg.cto.idleParkMs : DEFAULT_IDLE_PARK_MS,
      maxReconnectAttempts: typeof conf?.reconnect?.maxAttempts === "number" ? conf.reconnect.maxAttempts : 5,
      reconnectBaseMs: typeof conf?.reconnect?.baseMs === "number" ? conf.reconnect.baseMs : 1000,
    };
    if (!apiKey) {
      state.apiKey = null;
      setStatus("dropped");
      emit({ type: "error", error: "openai_key_missing" });
      showConnectionState("dropped", "openai_key_missing");
      return;
    }
    state.apiKey = apiKey;
    state.model = clampModel(conf.model, DEFAULT_REALTIME_MODEL);
    state.voice = typeof conf.voice === "string" && conf.voice ? conf.voice : DEFAULT_VOICE;
    state.reconnectAttempts = 0;
    return openTransport();
  }

  // One connection attempt: connect → wire message/close/error → send
  // session.update. Returns the ws on success, null on connect failure.
  async function openTransport() {
    const { model, apiKey, voice } = state;
    let ws;
    try {
      setStatus("connecting");
      ws = await realtimeConnect(`${REALTIME_BASE}?model=${encodeURIComponent(model)}`, {
        authorization: `Bearer ${apiKey}`,
        "openai-beta": "realtime=v1",
      });
    } catch (e) {
      scheduleReconnect("connect_error");
      return null;
    }
    state.reconnectAttempts = 0;
    state.openai = ws;
    if (!state.startedAt) state.startedAt = now();
    configureTransport(ws);
    send({ type: "session.update", session: {
      instructions: SESSION_INSTRUCTIONS,
      voice,
      modalities: ["audio", "text"],
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      tools: state.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.params })),
      turn_detection: { type: "server_vad", create_response: true },
    }});
    armIdleTimer();
    return ws;
  }

  function configureTransport(ws) {
    ws.on("message", (raw) => {
      let evt;
      try {
        evt = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
      } catch {
        return;
      }
      receiveRealtime(evt);
    });
    ws.on("close", () => {
      // Box restart / Realtime drop (spec #10): reconnect with backoff instead
      // of permanently dropping. Park/hangup close the socket deliberately and
      // clear `state.active`, so those do NOT reconnect.
      if (state.active && (state.status === "live" || state.status === "connecting")) {
        scheduleReconnect("realtime_closed");
      }
    });
    ws.on("error", () => {
      /* close handler drives reconnect */
    });
  }

  // Reconnect with capped exponential backoff; visible "reconnecting" state so
  // the renderer can surface "call dropped — reconnecting…". Gives up (dropped)
  // after `maxReconnectAttempts` so a permanently-down provider doesn't spin.
  function scheduleReconnect(reason) {
    if (!state.active || state.status === "parked" || state.status === "idle") return;
    if (state.reconnectAttempts >= state.caps.maxReconnectAttempts) {
      clearReconnectTimer();
      state.openai = null;
      setStatus("dropped");
      showConnectionState("dropped", reason);
      emit({ type: "dropped", reason });
      return;
    }
    clearReconnectTimer();
    state.openai = null;
    state.reconnectAttempts += 1;
    setStatus("reconnecting");
    showConnectionState("reconnecting", reason);
    const delay = Math.min(state.caps.reconnectBaseMs * 2 ** (state.reconnectAttempts - 1), 10_000);
    state.reconnectTimer = setTimeout(() => {
      if (!state.active || state.status === "parked") return;
      openTransport().catch(() => {});
    }, delay);
    if (state.reconnectTimer?.unref) state.reconnectTimer.unref();
  }

  function clearReconnectTimer() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  function showConnectionState(stateName, reason) {
    publish({ type: "connstate", state: stateName, reason });
  }

  function send(msg) {
    if (state.openai && typeof state.openai.send === "function") {
      state.openai.send(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
  }

  // -------------------------------------------------------------------------
  // Renderer → engine (audio + controls)
  // -------------------------------------------------------------------------

  function handleUserAudio(b64) {
    armIdleTimer();
    send({ type: "input_audio_buffer.append", audio: b64 });
  }

  function commitAndRespond() {
    armIdleTimer();
    send({ type: "input_audio_buffer.commit" });
    send({ type: "response.create" });
  }

  function barge() {
    // Stop playback + cancel the in-flight model response so the new user
    // input wins. Realtime handles turn-taking natively.
    emit({ type: "barge" });
    send({ type: "response.cancel" });
    clearIdleTimer();
  }

  function injectTurn(text) {
    // Live inbound routing (issue 2): make the CTO speak an inbound event.
    const item = { type: "message", role: "user", content: [{ type: "input_text", text }] };
    send({ type: "conversation.item.create", item });
    send({ type: "response.create" });
    armIdleTimer();
  }

  function hangup() {
    state.active = false;
    clearIdleTimer();
    clearReconnectTimer();
    if (state.openai) {
      try { state.openai.close(); } catch { /* ignore */ }
    }
    state.openai = null;
    state.pendingConfirm = null;
    setStatus("idle");
  }

  function park() {
    state.active = false;
    clearIdleTimer();
    clearReconnectTimer();
    if (state.openai) {
      try { state.openai.close(); } catch { /* ignore */ }
    }
    state.openai = null;
    state.pendingConfirm = null;
    setStatus("parked");
  }

  function listState() {
    return {
      status: state.status,
      tools: state.tools.map((t) => t.name),
      pendingConfirm: state.pendingConfirm
        ? { id: state.pendingConfirm.id, tool: state.pendingConfirm.tool, preview: state.pendingConfirm.preview }
        : null,
      spend: state.ongoingSpend,
      caps: { ...state.caps },
    };
  }

  // -------------------------------------------------------------------------
  // OpenAI Realtime event dispatch
  // -------------------------------------------------------------------------

  async function receiveRealtime(evt) {
    if (!evt || typeof evt !== "object") return;
    switch (evt.type) {
      case "session.created":
        return handleSessionCreated(evt);
      case "response.audio.delta":
        return handleAudioDelta(evt);
      case "response.audio_transcript.delta": {
        const d = evt.delta ?? "";
        if (d) emit({ type: "transcript", delta: d, role: "cto" });
        return;
      }
      case "response.audio_transcript.done": {
        const t = evt.transcript ?? "";
        if (t) emit({ type: "transcript-finished", text: t, role: "cto" });
        return;
      }
      case "response.output_audio.done":
      case "response.done":
        return armIdleTimer();
      case "input_audio_buffer.speech_started":
        return barge();
      case "input_audio_buffer.speech_stopped":
        return armIdleTimer();
      case "conversation.item.created": {
        // User speech item → push STT text when available.
        if (evt?.item?.type === "message" && evt.item.role === "user") {
          for (const c of evt.item.content ?? []) {
            if (c?.type === "input_text" && c.text) {
              emit({ type: "transcript", delta: c.text, role: "user" });
            }
          }
        }
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const t = evt?.transcript ?? "";
        if (t) emit({ type: "stt", text: t });
        return;
      }
      case "response.function_call_arguments.done":
        return handleFunctionCall(evt);
      case "response.function_call_arguments.delta":
        return; // accumulate in openai's built-in buffer; done carries full args
      case "error":
        return handleError(evt);
      default:
        return;
    }
  }

  function handleSessionCreated(evt) {
    state.session = evt?.session ?? null;
    state.active = true;
    state.reconnectAttempts = 0;
    setStatus("live");
    emit({ type: "ready", sessionId: state.session?.id ?? null });
  }

  function handleAudioDelta(evt) {
    // Forward raw delta audio to the renderer to play (base64 opus).
    if (evt?.delta) emit({ type: "audio", delta: evt.delta });
    armIdleTimer();
  }

  async function handleFunctionCall(evt) {
    const name = evt?.name;
    const rawArgs = evt?.arguments ?? "{}";
    let args = {};
    try {
      args = JSON.parse(rawArgs || "{}");
    } catch {
      args = {};
    }
    emit({ type: "working", tool: name });

    // Voice-confirm resolution: if there is a pending confirm for the SAME
    // (tool,args), the model re-issuing it IS the user's spoken "go ahead"…
    const pc = state.pendingConfirm;
    if (pc && pc.tool === name && sameArgs(pc.args, args)) {
      approveConfirm(pc.id);
      state.pendingConfirm = null;
      emit({ type: "confirm-resolved", id: pc.id, ok: true });
    }

    const conf = (await configGet().catch(() => ({}))) ?? {};
    const result = await dispatchCto(name, args, {
      gate: () => "confirm",
      trustedActions: Array.isArray(conf?.cto?.trustedActions) ? conf.cto.trustedActions : [],
      onNarrate,
    });

    if (result?.needConfirmation && !pc) {
      // Gated tool, user hasn't spoken yet → pause for go-ahead.
      const id = result.id;
      emit({ type: "confirm", id, tool: name, preview: result.preview });
      state.pendingConfirm = { id, tool: name, args, preview: result.preview, at: now() };
      armConfirmTimeout(id);
      // Tell the model to ask, then complete the function call so it can speak.
      send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: evt?.call_id,
          output: JSON.stringify({ ok: true, awaiting_confirmation: true, preview: result.preview }),
        },
      });
      send({ type: "response.create" });
      return;
    }

    // Normal (or just-approved) path: complete the function call with the result.
    const output = result?.ok === false || !result ? JSON.stringify({ ok: false, error: result?.error ?? "failed" })
      : result?.needConfirmation
        ? JSON.stringify({ ok: true, error: "cancelled" })
        : JSON.stringify({ ok: true, ...result });
    send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: evt?.call_id, output },
    });
    send({ type: "response.create" });
    armIdleTimer();
  }

  function handleError(evt) {
    const message = evt?.error?.message ?? "";
    emit({ type: "error", error: message || "realtime_error" });
  }

  // A pending confirm with no re-issue times out → abort + re-plan.
  function armConfirmTimeout(id) {
    const ms = state.caps.confirmTimeoutMs ?? 30_000;
    const t = setTimeout(() => {
      const pc = state.pendingConfirm;
      if (pc && pc.id === id) {
        rejectConfirm(id);
        state.pendingConfirm = null;
        emit({ type: "confirm-resolved", id, ok: false });
        // Ask the model to re-plan since no go-ahead came.
        send({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text: "No answer. Abort and replan, do not act." }] },
        });
        send({ type: "response.create" });
      }
    }, ms);
    if (t?.unref) t.unref();
  }

  function sameArgs(a, b) {
    try {
      return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
    } catch {
      return false;
    }
  }

  // Exposed for tests + index wiring to snapshot the working tool/confirm
  // timers. (Confirm timeout is armed in the confirm branch; see below.)
  return {
    start,
    handleUserAudio,
    commitAndRespond,
    barge,
    injectTurn,
    hangup,
    park,
    receiveRealtime,
    listState,
    // Set the tool registry before starting a call (from ctoEngine.listTools).
    setTools: (tools) => {
      state.tools = Array.isArray(tools) ? tools : [];
    },
  };
}

async function defaultRealtimeConnect(url, headers) {
  return new NodeWebSocket(url, { headers });
}
