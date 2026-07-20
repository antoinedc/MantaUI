// logShip.mjs — shared log shipping module (mobile PWA, desktop renderer,
// manta-server, relay). One implementation; all four runtimes wrap their
// console once and let every existing `console.log/warn/error` call site
// ship transparently — no per-call-site edits.
//
// Backed by Axiom (`POST /v1/datasets/<dataset>/ingest`, Bearer auth). Without
// a token configured (resolveAxiomConfig returns null), no shipper is created
// and the module is a no-op. Logging is NEVER load-bearing: a bad token, a
// dropped connection, or a malformed event must not break the calling app.
//
// Two failure shapes are guarded against:
//   1. The wrapped console capturing its own failures would infinite-loop —
//      `captureConsole` calls the ORIGINAL console.* first and references the
//      original `console.warn` directly when it needs to emit a one-shot
//      warning on first-flush failure (NOT through the possibly-wrapped
//      console).
//   2. A flush failure must not drop logs silently — failed events are
//      re-prepended to the buffer, the buffer is capped at `maxBuffer` (oldest
//      dropped), and a single synthetic "logship dropped events" event is
//      appended on the next successful flush so an operator can see drops
//      happened.
//
// The fetchFn / setIntervalFn / now are injectable so unit tests can run
// without real timers or network. The shipper returns `pending()` so tests
// can assert buffer state and the pagehide handler can flush on teardown.

const MAX_MSG_LEN = 4000;

/**
 * Resolve the Axiom ingest endpoint + token. Env vars win over AppConfig
 * fields (env lets the relay — which has no `~/.manta` directory — be
 * configured without touching code). Dataset defaults to "manta" so a user
 * only needs to provide the token to start shipping.
 *
 * @param {object} args
 * @param {Record<string, string | undefined>} args.env    process.env-shaped
 * @param {{ axiomToken?: string; axiomDataset?: string } | null} args.config
 * @returns {{ endpoint: string; token: string } | null}
 */
export function resolveAxiomConfig({ env, config }) {
  const token = env?.MANTA_AXIOM_TOKEN || config?.axiomToken;
  if (!token) return null;
  const dataset = env?.MANTA_AXIOM_DATASET || config?.axiomDataset || "manta";
  return {
    endpoint: `https://api.axiom.co/v1/datasets/${dataset}/ingest`,
    token,
  };
}

/**
 * Format the variadic args from a console.* call into a single message
 * string. Pure — no fetch / no buffer access — so unit tests can assert the
 * exact serialization (string, number, plain object, Error, circular).
 *
 *   string      → as-is
 *   Error       → err.stack ?? String(err)         (stack is the operator's
 *                                                  debugging handle; falls
 *                                                  back to message-only for
 *                                                  Error subclasses that
 *                                                  don't set a stack)
 *   object      → JSON.stringify(x) with a String()
 *                 fallback when JSON throws (circular refs, BigInt, etc.)
 *   primitive   → String(x)
 *
 * Final string is truncated to MAX_MSG_LEN chars so a runaway log can't
 * blow the 64KB keepalive cap the renderer relies on.
 *
 * @param {unknown[]} args
 * @returns {string}
 */
export function formatConsoleArgs(args) {
  const parts = [];
  for (const arg of args) {
    if (typeof arg === "string") {
      parts.push(arg);
    } else if (arg instanceof Error) {
      parts.push(arg.stack ?? String(arg));
    } else if (typeof arg === "object" && arg !== null) {
      try {
        parts.push(JSON.stringify(arg));
      } catch {
        parts.push(String(arg));
      }
    } else {
      parts.push(String(arg));
    }
  }
  return parts.join(" ").slice(0, MAX_MSG_LEN);
}

/**
 * Create a buffered log shipper. See the spec (BET-187) for the exact
 * invariants this preserves; the brief:
 *   - log(): pushes an event onto the buffer. If buffer.length >= maxBatch,
 *     fires an immediate flush (fire-and-forget).
 *   - flush(): POSTs the entire buffer as a JSON array to the ingest
 *     endpoint. Single-flight guarded — overlapping calls are coalesced.
 *     Failures re-prepend the events (oldest stays oldest) and enforce
 *     maxBuffer by dropping the oldest; the drop count is reported on the
 *     next successful flush as one synthetic warn event.
 *   - stop(): clear the timer + fire one last flush.
 *   - pending(): current buffer length (tests + pagehide handler).
 *
 * @param {object} opts
 * @param {string} opts.endpoint
 * @param {string} opts.token
 * @param {"mobile"|"desktop"|"server"|"relay"} opts.source
 * @param {string} opts.device
 * @param {(url: string, init: object) => Promise<{ ok: boolean; status?: number }>} [opts.fetchFn]
 * @param {() => number} [opts.now]
 * @param {(cb: () => void, ms: number) => unknown} [opts.setIntervalFn]
 * @param {number} [opts.flushMs=5000]
 * @param {number} [opts.maxBatch=100]
 * @param {number} [opts.maxBuffer=500]
 */
export function createLogShipper({
  endpoint,
  token,
  source,
  device,
  fetchFn = globalThis.fetch,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  flushMs = 5000,
  maxBatch = 100,
  maxBuffer = 500,
}) {
  // Capture the ORIGINAL warn at construction time so the first-flush
  // failure warning bypasses the possibly-wrapped console (which would
  // re-enter ship() → another flush → another failure → infinite loop).
  // captureConsole does the same for the methods it wraps.
  const origWarn = console.warn;
  let buffer = [];
  let inFlight = false;
  let droppedCount = 0;
  let firstFailureWarned = false;
  let timer = null;

  function log(level, msg, fields) {
    try {
      const event = {
        _time: new Date(now()).toISOString(),
        source,
        device,
        level,
        msg: String(msg ?? "").slice(0, MAX_MSG_LEN),
      };
      if (fields && typeof fields === "object") {
        for (const k of Object.keys(fields)) {
          event[k] = fields[k];
        }
      }
      buffer.push(event);
      if (buffer.length >= maxBatch) void flush();
    } catch {
      // Swallow — logging never throws.
    }
  }

  async function flush() {
    if (buffer.length === 0) return;
    if (inFlight) return;
    inFlight = true;
    const batch = buffer;
    buffer = [];
    let ok = false;
    try {
      const res = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(batch),
      });
      ok = !!res && res.ok === true;
    } catch {
      ok = false;
    } finally {
      inFlight = false;
    }
    if (!ok) {
      // Re-prepend the failed batch (oldest stays oldest), then enforce
      // maxBuffer by dropping from the front.
      const combined = batch.concat(buffer);
      if (combined.length > maxBuffer) {
        droppedCount += combined.length - maxBuffer;
        buffer = combined.slice(combined.length - maxBuffer);
      } else {
        buffer = combined;
      }
      if (!firstFailureWarned) {
        firstFailureWarned = true;
        origWarn("[logship] first flush failed (subsequent failures are silent)");
      }
      return;
    }
    // Success path: if we dropped events during this window, surface them.
    if (droppedCount > 0) {
      const dropped = droppedCount;
      droppedCount = 0;
      log("warn", "logship dropped events", { dropped });
    }
  }

  // Fire one initial flush on construction so events logged BEFORE the
  // first interval tick (e.g. early-startup logs) don't sit unsent for 5s.
  void flush();
  timer = setIntervalFn(() => void flush(), flushMs);
  // Best-effort unref so the timer doesn't keep Node alive past the rest
  // of the process. Mirrors outbox.mjs's startOutboxPoller. Browsers ignore
  // the call (no-op), so it's safe in both runtimes.
  if (timer && typeof timer.unref === "function") {
    try { timer.unref(); } catch { /* ignore */ }
  }

  function stop() {
    if (timer != null) {
      try { clearInterval(timer); } catch { /* ignore */ }
      timer = null;
    }
    void flush();
  }

  function pending() {
    return buffer.length;
  }

  return { log, flush, stop, pending };
}

/**
 * Wrap `console.log`, `console.warn`, `console.error` so each call also
 * gets pushed into the shipper. Other console methods (`info`, `debug`,
 * `table`, etc.) are untouched — they aren't used by manta's existing call
 * sites and wrapping them would risk surprising the host environment.
 *
 * Idempotent: if console.log already carries a `__logshipWrapped` marker
 * (a previous captureConsole ran), returns a no-op restore so multiple
 * init calls don't double-wrap.
 *
 * @param {{ log: (level: "info"|"warn"|"error", msg: string, fields?: object) => void }} shipper
 * @returns {() => void} restore
 */
export function captureConsole(shipper) {
  if (console.log && console.log.__logshipWrapped) {
    return () => {};
  }
  // Capture the original function references without .bind() so test
  // assertions can use `===` against the saved references, AND so the
  // restored console.log is byte-identical to the pre-wrap one. The Node
  // and browser console methods don't depend on `this` for normal use, so
  // forwarding the args with the original function is safe.
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  try {
    console.log = function logWrapped(...args) {
      origLog.apply(console, args);
      try {
        shipper.log("info", formatConsoleArgs(args));
      } catch { /* swallow */ }
    };
    console.warn = function warnWrapped(...args) {
      origWarn.apply(console, args);
      try {
        shipper.log("warn", formatConsoleArgs(args));
      } catch { /* swallow */ }
    };
    console.error = function errorWrapped(...args) {
      origError.apply(console, args);
      try {
        shipper.log("error", formatConsoleArgs(args));
      } catch { /* swallow */ }
    };
    if (console.log) console.log.__logshipWrapped = true;
    if (console.warn) console.warn.__logshipWrapped = true;
    if (console.error) console.error.__logshipWrapped = true;
  } catch {
    // console isn't mutable (frozen / proxied); restore would be a no-op.
    return () => {};
  }
  return function restore() {
    try {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
      delete console.log.__logshipWrapped;
      delete console.warn.__logshipWrapped;
      delete console.error.__logshipWrapped;
    } catch { /* ignore */ }
  };
}
