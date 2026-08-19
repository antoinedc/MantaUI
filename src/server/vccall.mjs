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
const DEFAULT_REALTIME_MODEL = "gpt-realtime-2.1";
const DEFAULT_VOICE = "alloy";

// Per-1M-token cost of the Realtime model, used to turn a response.done
// `usage` object into a dollar figure for the per-call spend cap (cost guard).
// These ratios come from OpenAI's realtime pricing page
// (https://openai.com/api/pricing/) as of 2026-08-19 — audio tokens bill at a
// higher rate than text, and input/output are separate. They were captured for
// the older gpt-4o-realtime-preview; the default model is now gpt-realtime-2.1
// (BET-1178), so re-confirm the per-token rates against the current model's
// published pricing before relying on the exact dollar figure. The guard still
// fires on whatever is logged here.
export const REALTIME_TOKEN_RATES = {
  inputTextUsdPerM: 5.0, //  $5.00 / 1M input text tokens
  outputTextUsdPerM: 20.0, // $20.00 / 1M output text tokens
  inputAudioUsdPerM: 40.0, //  $40.00 / 1M input audio tokens
  outputAudioUsdPerM: 80.0, // $80.00 / 1M output audio tokens
};

// Cost cap defaults (USD). Per-call cap disconnects + notifies; a generous
// auto-idle park leaves the model no silent spend.
export const DEFAULT_SPEND_CAP_USD = 5;
export const DEFAULT_IDLE_PARK_MS = 60_000;
export const DEFAULT_CONFIRM_TIMEOUT_MS = 30_000;

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

// Deliberately dumb confirmation-reply classifier (BET-1181). Approval of a
// pending confirm must come from the user's OWN words, so this maps a spoken
// transcript to yes / no / unclear with a short explicit phrase list and
// defaults to "unclear" — which is NOT an approval. Any ambiguity leaves the
// pending confirm running until its timeout aborts it.
const YES_PHRASES = ["yes", "yeah", "yep", "yup", "sure", "okay", "ok", "go ahead", "goahead", "do it", "please do", "confirm", "approve", "proceed", "fine"];
const NO_PHRASES = ["no", "nope", "nah", "cancel", "stop", "abort", "dont", "don't", "never", "reject", "deny", "not"];

export function classifyConfirmReply(text) {
  const t = String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, " ")
    .trim();
  if (!t) return "unclear";
  // A leading explicit no wins (covers "no", "no thanks", "not now", …).
  if (NO_PHRASES.some((p) => t === p || t.startsWith(`${p} `))) return "no";
  if (YES_PHRASES.some((p) => t === p || t.startsWith(`${p} `))) return "yes";
  return "unclear";
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
    setTimeout: setTimer = setTimeout,
    clearTimeout: clearTimer = clearTimeout,
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
      confirmTimeoutMs: DEFAULT_CONFIRM_TIMEOUT_MS,
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
      clearTimer(state.idleTimer);
      state.idleTimer = null;
    }
  }

  function armIdleTimer() {
    clearIdleTimer();
    if (!state.caps.idleParkMs) return;
    state.idleTimer = setTimer(() => {
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
    const apiKey = cfg?.openaiApiKey;
    state.caps = {
      spendCapUsd: typeof cfg?.cto?.spendCapUsd === "number" ? cfg.cto.spendCapUsd : DEFAULT_SPEND_CAP_USD,
      idleParkMs: typeof cfg?.cto?.idleParkMs === "number" ? cfg.cto.idleParkMs : DEFAULT_IDLE_PARK_MS,
      maxReconnectAttempts: typeof conf?.reconnect?.maxAttempts === "number" ? conf.reconnect.maxAttempts : 5,
      reconnectBaseMs: typeof conf?.reconnect?.baseMs === "number" ? conf.reconnect.baseMs : 1000,
      confirmTimeoutMs: typeof cfg?.cto?.confirmTimeoutMs === "number" ? cfg.cto.confirmTimeoutMs : DEFAULT_CONFIRM_TIMEOUT_MS,
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
      type: "realtime",
      model,
      instructions: SESSION_INSTRUCTIONS,
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          turn_detection: { type: "server_vad", create_response: true },
          // Input transcription turns the user's speech into text so that a
          // pending confirm can be approved by their actual words (BET-1181).
          transcription: { model: "whisper-1" },
        },
        output: {
          format: { type: "audio/pcm" },
          voice,
        },
      },
      tools: state.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.params })),
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
      // A websocket can close between any two writes; a send on a CONNECTING /
      // CLOSED socket throws, and that must never take the server down. Publish
      // an error frame instead of propagating (openTransport keeps running and
      // the reconnect/close handlers own the retry).
      try {
        state.openai.send(typeof msg === "string" ? msg : JSON.stringify(msg));
      } catch {
        publish({ type: "error", error: "realtime_send_failed" });
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Renderer → engine (audio + controls)
  // -------------------------------------------------------------------------

  function handleUserAudio(b64) {
    // Raw mic frames must NOT re-arm the idle timer: with always-listening
    // (the default on some boxes) frames arrive continuously, so a deadline
    // that resets on every packet never fires and auto-park never happens.
    // Idle is armed on conversational activity only (speech / response in
    // receiveRealtime), not on the mere presence of audio packets.
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
      case "response.output_audio.delta":
        return handleAudioDelta(evt);
      case "response.output_audio_transcript.delta": {
        const d = evt.delta ?? "";
        if (d) emit({ type: "transcript", delta: d, role: "cto" });
        return;
      }
      case "response.output_audio_transcript.done": {
        const t = evt.transcript ?? "";
        if (t) emit({ type: "transcript-finished", text: t, role: "cto" });
        return;
      }
      case "response.output_audio.done":
        return armIdleTimer();
      case "response.done": {
        // GA's `response.done` carries complete function-call items in
        // `response.output`; dispatch each one (the only function-call path).
        const items = evt?.response?.output ?? [];
        for (const item of items) {
          if (item?.type === "function_call") await handleFunctionCall(item);
        }
        // Feed the completed response's usage into the spend cap (cost guard).
        chargeUsage(evt);
        return armIdleTimer();
      }
      case "input_audio_buffer.speech_started":
        barge();
        return armIdleTimer();
      case "input_audio_buffer.speech_stopped":
        return armIdleTimer();
      case "conversation.item.added": {
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
        if (t) {
          emit({ type: "stt", text: t });
          handleUserUtterance(t);
        }
        return;
      }
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
    // Forward raw delta audio to the renderer to play (PCM audio).
    if (evt?.delta) emit({ type: "audio", delta: evt.delta });
  }

  // Turn a response.done `usage` object into a dollar figure and feed the
  // per-call spend cap. Returns early (leaves the cap machinery untouched)
  // when the usage object lacks the text/audio breakdown — never invent an
  // estimate for a response we can't price.
  function chargeUsage(evt) {
    // GA places response.done usage at the event level; tolerate it on the
    // response too so a payload-shape change never silently disables the cap.
    const usage = evt?.usage ?? evt?.response?.usage;
    const usd = usageToUsd(usage);
    if (usd == null) return;
    spend(usd);
  }

  function usageToUsd(usage) {
    if (!usage || typeof usage !== "object") return null;
    const inputDetails = usage.input_token_details ?? usage.input_details;
    const outputDetails = usage.output_token_details ?? usage.output_details;
    const it = inputDetails?.text_tokens;
    const ia = inputDetails?.audio_tokens;
    const ot = outputDetails?.text_tokens;
    const oa = outputDetails?.audio_tokens;
    if ([it, ia, ot, oa].some((n) => typeof n !== "number")) return null;
    const usd =
      it * REALTIME_TOKEN_RATES.inputTextUsdPerM +
      ia * REALTIME_TOKEN_RATES.inputAudioUsdPerM +
      ot * REALTIME_TOKEN_RATES.outputTextUsdPerM +
      oa * REALTIME_TOKEN_RATES.outputAudioUsdPerM;
    return usd / 1_000_000;
  }

  // A user utterance (from input transcription) is the ONLY thing that can
  // authorize a pending confirm. A clear "yes" approves it; a clear "no"
  // rejects it; anything else leaves it pending until the timeout aborts.
  function handleUserUtterance(transcript) {
    const pc = state.pendingConfirm;
    if (!pc || pc.approvedByUser) return;
    const verdict = classifyConfirmReply(transcript);
    if (verdict === "yes") {
      approveConfirm(pc.id);
      pc.approvedByUser = true;
      armConfirmTimeout(pc.id);
      emit({ type: "confirm-resolved", id: pc.id, ok: true });
    } else if (verdict === "no") {
      rejectConfirm(pc.id);
      state.pendingConfirm = null;
      emit({ type: "confirm-resolved", id: pc.id, ok: false });
      send({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: "User said no. Abort and replan, do not act." }] },
      });
      send({ type: "response.create" });
    }
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

    // A model re-issue of the SAME pending (tool,args) is only authorized if
    // the user's own words approved it. A re-issue with no such utterance is
    // NOT an approval — re-raise the pause instead of acting.
    const pc = state.pendingConfirm;
    const isReissue = pc && pc.tool === name && sameArgs(pc.args, args);
    if (isReissue) {
      if (!pc.approvedByUser) {
        emit({ type: "confirm", id: pc.id, tool: name, preview: pc.preview });
        send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: evt?.call_id,
            output: JSON.stringify({ ok: true, awaiting_confirmation: true, preview: pc.preview }),
          },
        });
        send({ type: "response.create" });
        armConfirmTimeout(pc.id);
        return;
      }
      // Spoken "go ahead" → clear the local pending; the engine's approval
      // lets this re-dispatch actually run.
      state.pendingConfirm = null;
    }

    const conf = (await configGet().catch(() => ({}))) ?? {};
    const result = await dispatchCto(name, args, {
      trustedActions: Array.isArray(conf?.cto?.trustedActions) ? conf.cto.trustedActions : [],
      onNarrate,
    });

    if (result?.needConfirmation && !pc) {
      // Gated tool, user hasn't spoken yet → pause for go-ahead. It is only
      // approved by an affirmative user utterance (see handleUserUtterance).
      const id = result.id;
      emit({ type: "confirm", id, tool: name, preview: result.preview });
      state.pendingConfirm = { id, tool: name, args, preview: result.preview, at: now(), approvedByUser: false };
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
    const ms = state.caps.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    const t = setTimer(() => {
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

/**
 * Resolve once `ws` is open; reject if it errors or closes before open. The
 * realtimeConnect contract is "resolves with an OPEN socket" — openTransport
 * writes to it immediately, and a write on a CONNECTING socket throws. Takes a
 * ws-like EventEmitter (never references NodeWebSocket) and removes its
 * listeners once settled.
 *
 * @param {import("events").EventEmitter & object} ws a ws-like instance
 * @returns {Promise<object>} resolves with the same `ws` once open
 */
export function awaitOpen(ws) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      ws.removeListener("open", onOpen);
      ws.removeListener("error", onError);
      ws.removeListener("close", onClose);
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ws);
    };
    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("websocket closed before open"));
    };
    ws.on("open", onOpen);
    ws.on("error", onError);
    ws.on("close", onClose);
  });
}

async function defaultRealtimeConnect(url, headers) {
  return awaitOpen(new NodeWebSocket(url, { headers }));
}
