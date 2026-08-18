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
//   { type:"control", action:"park"|"hangup" } → lifecycle
// Server→client (JSON text): every engine.publish(msg) forwarded verbatim
//   ({ type:"state"|"audio"|"transcript"|"stt"|"working"|"confirm"|… }).

import { createVcCallEngine } from "./vccall.mjs";

/**
 * Attach a /call WS to a fresh vccall engine. Auth + path matching happen at
 * the upgrade layer (src/server/index.mjs). `opts` supplies the engine deps
 * and the live-routing hooks (the "call active" flag that issue 2's inbound
 * funnel reads):
 *   { dispatchCto, approveConfirm, rejectConfirm, configGet,
 *     synthesizeSpeech, onNarrate,
 *     setCallActive:(active, engine|null)=>void }
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

  const engine = createVcCallEngine({
    dispatchCto,
    approveConfirm,
    rejectConfirm,
    configGet,
    synthesizeSpeech,
    realtimeConnect,
    onNarrate,
    publish: sendJson,
  });

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
    setCallActive(true, engine);
    await engine.start(cfg);
  })();

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
      case "control":
        if (msg.action === "park") {
          setCallActive(false, null);
          engine.park();
        } else if (msg.action === "hangup") {
          setCallActive(false, null);
          engine.hangup();
        }
        return;
      default:
        return;
    }
  });

  ws.on("close", () => {
    open = false;
    setCallActive(false, null);
    engine.hangup();
  });
  ws.on("error", () => {
    /* cleanup runs in close */
  });
}
