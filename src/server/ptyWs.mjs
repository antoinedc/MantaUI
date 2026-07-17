// ptyWs.mjs — the /pty WebSocket handler (BET-158).
//
// Owns the WS↔pty lifecycle for the box server's /pty endpoint: a device
// (or the relay's agent) opens a single WebSocket, sends JSON control
// strings ({type:"data",data} / {type:"resize",cols,rows}), and receives
// raw terminal bytes back. One pty per sessionKey; the pty dies with the
// socket.
//
// Lives in its own module so the WS-to-pty wiring is unit-testable without
// standing up the full HTTP server (src/server/index.mjs owns the upgrade
// listener that calls into here).
//
// This is the box-side counterpart to the relay's STREAM_* bridge: the
// relay's agent opens ws://127.0.0.1:8787/pty?<query>&token=<box_token>
// and the box server uses this module to bridge that WS to the ephemeral
// pty module (src/server/pty.mjs).

// Lazy import: ./pty.mjs pulls in node-pty, which is not available in CI.
// Keeping the import dynamic lets this module load (and `parsePtyQuery`
// get unit-tested) without forcing every test runner to install node-pty.
// The first `attachPtyWs(ws, url, { pty })` call without an injected pty
// resolves the real module.
let _defaultPty = null;
async function getDefaultPty() {
  if (_defaultPty === null) {
    _defaultPty = (await import("./pty.mjs")).default || (await import("./pty.mjs"));
  }
  return _defaultPty;
}

/**
 * Attach a /pty WS to the ephemeral pty module: one shell/launcher per
 * sessionKey, killed when the socket closes. Pure dispatcher — owns the
 * WS↔pty lifecycle and nothing else. Auth + path matching happen at the
 * upgrade layer (src/server/index.mjs); this function is only called once
 * the upgrade is authorized and the URL path is /pty.
 *
 * Required URL query:
 *   session=<sessionKey>   keys the ephemeral pty (see src/server/pty.mjs).
 * Optional:
 *   cwd=<path>             defaults to process.cwd().
 *   cols=<n> rows=<n>      clamped to safe bounds; defaults 80x24.
 *   launcher=<json>        a { id, flags? } JSON object for the AI CLI TUI
 *                          launch mode; falls back to a plain shell if the
 *                          JSON is malformed.
 *
 * @param {object} ws    a `ws` WebSocket instance
 * @param {URL}    url   the parsed upgrade URL
 * @param {object} [opts]
 * @param {object} [opts.pty]  injectable pty module (defaults to ./pty.mjs).
 *                            Tests inject a fake; production gets the real
 *                            node-pty-backed module.
 */
export function attachPtyWs(ws, url, opts = {}) {
  // Required query: session=<sessionKey>. The box server's ephemeral pty
  // registry keys PTYs by sessionKey (see src/server/pty.mjs); a missing or
  // empty sessionKey would silently squat the first available key — reject.
  const params = parsePtyQuery(url);
  if (!params.sessionKey) {
    try {
      ws.send(JSON.stringify({ type: "error", error: "session_required" }));
    } catch {
      /* socket already closing */
    }
    ws.close(1008, "session_required");
    return;
  }
  const { sessionKey, cwd, cols, rows, launcher } = params;

  // Resolve the pty module: an injected one (tests) wins; production
  // resolves lazily so this module loads even on a CI runner without
  // node-pty available. When the test passes opts.pty, use it directly —
  // keeping the call synchronous matters for the integration tests that
  // assert spawn() ran before the first ws message arrives.
  let ptyReady;
  if (opts.pty) {
    ptyReady = Promise.resolve(opts.pty);
  } else {
    ptyReady = getDefaultPty();
  }

  function withPty(fn) {
    ptyReady.then(fn).catch((err) => {
      // The pty module failed to load (e.g. node-pty not installed). Surface
      // once on the first attempt — subsequent attempts (after close) are
      // no-ops on a closed socket.
      try {
        ws.send(JSON.stringify({ type: "error", error: "pty_unavailable", message: String(err?.message || err) }));
      } catch {
        /* ignore */
      }
      try { ws.close(1011, "pty_unavailable"); } catch { /* ignore */ }
    });
  }

  withPty((ptyModule) => {
    ptyModule.spawn({ sessionKey, cwd, cols, rows, launcher }, (e) => {
      if (e.kind === "data") {
        try {
          ws.send(typeof e.data === "string" ? e.data : Buffer.from(e.data));
        } catch {
          /* socket closing */
        }
      } else if (e.kind === "exit") {
        try {
          ws.close(1000, JSON.stringify({ kind: "exit", code: e.code ?? null }));
        } catch {
          /* already closed */
        }
      }
    });
  });

  ws.on("message", (raw) => {
    // Control frames are JSON text: { type: "data"|"resize", ... }.
    // Anything that fails to parse is dropped silently — the device is
    // authoritative for input shaping; a stray garbage frame should not
    // kill the pty.
    withPty((ptyModule) => {
      let msg;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
      } catch {
        return;
      }
      if (msg && msg.type === "data" && typeof msg.data === "string") {
        ptyModule.write(sessionKey, msg.data);
      } else if (
        msg &&
        msg.type === "resize" &&
        Number.isInteger(msg.cols) &&
        Number.isInteger(msg.rows)
      ) {
        ptyModule.resize(sessionKey, msg.cols, msg.rows);
      }
    });
  });

  ws.on("close", () => {
    // Mirror desktop killPty(): drop the pty so it dies with the WS. A
    // reconnecting device creates a fresh sessionKey on the next WS — the
    // pty module's `if (ptys.has(sessionKey)) return` re-spawn guard is
    // bypassed intentionally, since the WS is the connection owner here.
    withPty((ptyModule) => {
      try { ptyModule.kill(sessionKey); } catch { /* already gone */ }
    });
  });
  ws.on("error", () => {
    // ws fires 'error' then 'close'; cleanup runs in the close handler.
  });
}

function clampInt(raw, min, max, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * Pure-ish: parse the /pty URL query for the parameters attachPtyWs reads.
 * Exported for tests so the parameter handling can be pinned independently
 * of the live pty module (which would otherwise require node-pty + a real
 * binary to spawn).
 *
 * @param {URL} url
 * @returns {{ sessionKey: string, cwd: string, cols: number, rows: number, launcher: object|undefined }}
 */
export function parsePtyQuery(url) {
  const sessionKey = url.searchParams.get("session") ?? url.searchParams.get("sessionKey") ?? "";
  const cwd = url.searchParams.get("cwd") || process.cwd();
  const cols = clampInt(url.searchParams.get("cols"), 20, 500, 80);
  const rows = clampInt(url.searchParams.get("rows"), 5, 200, 24);
  let launcher;
  const launcherRaw = url.searchParams.get("launcher");
  if (launcherRaw) {
    try {
      launcher = JSON.parse(launcherRaw);
    } catch {
      launcher = undefined;
    }
  }
  return { sessionKey, cwd, cols, rows, launcher };
}


