// callWs.mjs — the /call WebSocket handler (BET-1166, issue 3/3).
//
// The renderer's call window connects here (auth-gated at the upgrade layer,
// mirroring /pty) and streams opus mic frames up while receiving transcript /
// audio / intent events down. One vccall engine per socket; the engine owns
// the OpenAI Realtime session (whose key lives on the box, never in the
// renderer). Lives in its own module so the WS↔engine wiring is unit-testable
// without standing up the HTTP server — attachCallWs(ws, url, opts) is called
// only after the upgrade is authorized and the path is /call.
//
// Client→server (JSON text):
//   { type:"audio", delta:<base64 opus> }  → engine.handleUserAudio
//   { type:"commit" }                       → engine.commitAndRespond
//   { type:"barge" }                        → engine.barge
//   { type:"played", ms }                   → engine.setPlayedMs (truncate pt)
//   { type:"control", action:"park"|"hangup" } → lifecycle
// Server→client (JSON text): every engine.publish(msg) forwarded verbatim
//   ({ type:"state"|"audio"|"transcript"|"stt"|"working"|"confirm"|… }).

import { createVcCallEngine } from "./vccall.mjs";

/**
 * The single-call registry (BET-1185, Cause 2). Owns the "exactly one live
 * call" invariant across every /call socket: `begin` registers a new call and
 * returns whatever was active before it (the displaced call the caller must
 * tear down); `end` clears the active call ONLY if that exact engine is still
 * the current one — so a displaced call's own teardown can never clear the flag
 * for the call that replaced it.
 */
export function createCallRegistry() {
  let active = null; // { id, engine, ws }
  let seq = 0;
  return {
    /** Register a new call as active; returns the displaced call or null. */
    begin(engine, ws) {
      const displaced = active;
      active = { id: ++seq, engine, ws };
      return displaced;
    },
    /** Clear the active call if (and only if) it is this engine. Returns true if cleared. */
    end(engine) {
      if (active && active.engine === engine) {
        active = null;
        return true;
      }
      return false;
    },
    current() {
      return active;
    },
    isActive() {
      return active !== null;
    },
  };
}

/**
 * Attach a /call WS to a fresh vccall engine. Auth + path matching happen at
 * the upgrade layer (src/server/index.mjs). `opts` supplies the engine deps
 *  and the live-routing hooks (the "call active" flag that issue 2's inbound
 *  funnel reads):
 *   { dispatchCto, approveConfirm, rejectConfirm, configGet,
 *     synthesizeSpeech, onNarrate,
 *     setCallActive:(active, engine|null)=>void,
 *     registry,          // a shared createCallRegistry() — the single-call guard
 *     log:(msg)=>void }  // default console.log; the box logs nothing for calls
 *
 * @param {object} ws   a `ws` WebSocket instance
 * @param {URL}    url  the parsed upgrade URL
 * @param {object} [opts]
 */
export function attachCallWs(ws, url, opts = {}) {
  const {
    dispatchCto,
    approveConfirm,
    rejectConfirm,
    configGet,
    synthesizeSpeech,
    realtimeConnect,
    onNarrate = () => {},
    setCallActive = () => {},
    registry = null,
    log = (msg) => console.log(msg),
  } = opts;

  let open = true;
  function sendJson(obj) {
    if (!open) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* socket closing */
    }
  }

  // Narration (spec #6): tool-boundary narration is a separate, lighter voice
  // than the Realtime model — a server-side Groq Orpheus TTS synthesis pushed
  // down the /call WS as `cto.narrate` {text, audio(base64), mime}. The key
  // never leaves the box; the renderer just plays the audio.
  function narrate(raw) {
    if (!raw) return;
    const text = cleanNarration(String(raw));
    onNarrate(text);
    (async () => {
      let cfg = {};
      try {
        cfg = (await configGet()) ?? {};
      } catch {
        cfg = {};
      }
      const apiKey = cfg.groqApiKey;
      if (!apiKey) return;
      try {
        const { buffer, mime } = await synthesizeSpeech({
          text,
          apiKey,
          model: cfg.cto?.transport === "groq" ? cfg.cto?.voice : undefined,
          voice: cfg.cto?.voice || undefined,
        });
        if (buffer && buffer.length > 0) {
          sendJson({ type: "cto.narrate", text, audio: Buffer.from(buffer).toString("base64"), mime });
        }
      } catch {
        /* narration is best-effort; never breaks the call */
      }
    })().catch((err) => {
      console.error("[callWs] narration failed:", err);
      sendJson({ type: "error", error: "narration_failed" });
    });
  }

  const engine = createVcCallEngine({
    dispatchCto,
    approveConfirm,
    rejectConfirm,
    configGet,
    synthesizeSpeech,
    realtimeConnect,
    onNarrate: narrate,
    publish: sendJson,
  });

  // ----- single-call guard (BET-1185, Cause 2) -----
  // The box permits ONE live call. Register this socket+engine as the active
  // call at attach time (synchronously, BEFORE the async boot). If another
  // call is already active it is displaced — a reconnecting window must be
  // able to take over a dead session, so we close its socket rather than
  // reject it. The displaced socket's own `close` handler hangs its engine and
  // clears the flag in an identity-guarded way (registry.end only clears the
  // active call if that engine is still the current one), so the displaced
  // call can never clobber the flag for the call that replaced it.
  let displaced = null;
  if (registry) {
    displaced = registry.begin(engine, ws);
  }
  markActive(displaced ? "takeover" : "new");
  if (displaced) {
    log(`[call] takeover: closing the ${displacedCause(displaced)} on new /call`);
    if (typeof displaced.ws?.close === "function") {
      displaced.ws.close();
    } else {
      try {
        displaced.engine.hangup();
      } catch {
        /* ignore */
      }
    }
  }

  function markActive(reason) {
    setCallActive(true, engine);
    log(`[call] attach: ${reason}`);
  }

  function clearActive(reason) {
    if (registry) {
      // Identity guard: only clear if THIS engine is still the active call.
      // If it was already displaced by a takeover, leaving the new call's flag
      // alone is the point.
      const cleared = registry.end(engine);
      if (!cleared) return;
      setCallActive(false, null);
    } else {
      setCallActive(false, null);
    }
    log(`[call] detach: ${reason}`);
  }

  // Boot the call on connect (open a Realtime session). The keys live on the
  // box; the engine reads them via configGet — nothing reaches the renderer.
  engine.setTools(opts.listTools ? opts.listTools() : []);
  (async () => {
    let cfg = {};
    try {
      cfg = (await configGet()) ?? {};
    } catch {
      cfg = {};
    }
    // Push the cto profile to the renderer so it honours the config (e.g. the
    // push-to-barge default reads cto.alwaysListening; never hardcodes it).
    sendJson({
      type: "config",
      cto: {
        alwaysListening: cfg?.cto?.alwaysListening === true,
        voice: cfg?.cto?.voice || "alloy",
        transport: cfg?.cto?.transport || "realtime",
        enabled: cfg?.cto?.enabled === true,
      },
    });
    await engine.start(cfg);
  })().catch((err) => {
    // One call window failing is a call-window problem, never a box-wide
    // outage: never let a boot failure become an unhandled rejection (which
    // exits the process).
    console.error("[callWs] engine.start failed:", err);
    sendJson({ type: "error", error: "call_boot_failed" });
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "audio":
        if (typeof msg.delta === "string") engine.handleUserAudio(msg.delta);
        return;
      case "commit":
        engine.commitAndRespond();
        return;
      case "barge":
        engine.barge();
        return;
      case "played":
        // BET-1186: renderer reports ms it has actually played of the current
        // response, so an interruption can truncate the conversation there.
        if (typeof msg.ms === "number") engine.setPlayedMs(msg.ms);
        return;
      case "control":
        if (msg.action === "park") {
          clearActive("park");
          engine.park();
        } else if (msg.action === "hangup") {
          clearActive("hangup");
          engine.hangup();
        }
        return;
      default:
        return;
    }
  });

  ws.on("close", () => {
    open = false;
    // A socket close (normal hangup, the renderer window vanishing, or a
    // takeover displacing this call) tears the engine down and clears the
    // active flag — identity-guarded so a displaced call can't clear a newer
    // call's flag.
    clearActive(`socket close${displaced ? " (displaced by takeover)" : ""}`);
    engine.hangup();
  });
  ws.on("error", () => {
    /* cleanup runs in close */
  });
}

// human label for which call was displaced, for the takeover log line
function displacedCause(d) {
  if (d?.ws?.id) return `socket ${d.ws.id}`;
  return "active call";
}

// Narration text from cto.dispatch arrives as terse `[cto] <tool>` / ` ok` /
// ` error` labels (issue 1's seam). Turn them into something the Orpheus voice
// can actually speak.
function cleanNarration(raw) {
  let s = raw.replace(/^\[cto\]\s*/i, "").trim();
  if (s.endsWith(" ok")) return `${s.slice(0, -3)} done`;
  if (s.endsWith(" error")) return `${s.slice(0, -6)} failed`;
  return s || "Working on it";
}
