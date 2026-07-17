// protocol.mjs — pure framing / correlation / mux / routing primitives for the
// box↔relay tunnel (M2, BET-36). This is the "pure-before-wired" foundation
// slice: everything here is transport-injectable and fully testable with a fake
// in-memory socket. There is NO real `ws` import, NO SQLite, NO HTTP, NO timers
// beyond an injectable clock — those belong to later slices (Stages 2–5).
//
// ARCHITECTURE (why this shape):
//   The relay maps `boxId → live WebSocket` and multiplexes many concurrent
//   phone→box requests (and box→phone stream data) over that one socket. To do
//   that over a single duplex channel we need four independent, composable
//   pieces, each of which is a pure function of its inputs + an injected
//   transport/clock:
//
//     1. Framing        — a versioned envelope with encode/decode + validation.
//     2. Correlation    — PendingRequests: id → Promise, resolve on response,
//                          reject on timeout / error frame / transport close.
//     3. Stream mux      — StreamRegistry: route stream-data frames to the right
//                          consumer, enforce per-stream ordering, clean up on
//                          end / abort / close, drop late data after end.
//     4. Routing         — RoutingTable: boxId → transport handle, single live
//                          socket per box (re-register evicts + closes stale).
//
//   The transport contract is deliberately tiny (send / onMessage / onClose /
//   close) so a fake in-memory socket satisfies it in tests and a real `ws`
//   socket satisfies it in the wired slice — neither this file nor its tests
//   ever import `ws`.
//
// WIRE FORMAT: frames are UTF-8 JSON strings (WS *text* frames). Rationale:
//   the payloads we carry (HTTP request/response metadata, SSE lines, control
//   messages) are already text/JSON-friendly, JSON keeps the envelope
//   debuggable, and stream-data byte payloads that need to be binary are
//   base64-encoded in the `data` field (documented on FRAME_TYPES.STREAM_DATA).
//   A single, uniform text encoding avoids a mixed text/binary demux on the hot
//   path. `encodeFrame` returns a string; `decodeFrame` accepts a string or a
//   Buffer/Uint8Array (which it treats as UTF-8) so a transport that hands us
//   binary WS frames still decodes.

import { isValidToken } from "../server/webhooks.mjs";

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

// Bump when the envelope shape changes incompatibly. decodeFrame rejects any
// frame whose `v` !== PROTOCOL_VERSION (unknown-version guard).
export const PROTOCOL_VERSION = 1;

// Hard cap on a single encoded frame, in bytes (UTF-8). Guards the decoder
// against a hostile/oversized payload before we JSON.parse it. 1 MiB is
// comfortably above any control frame or SSE chunk we mux; larger bodies are
// the job of chunked stream-data, not a single frame.
export const MAX_FRAME_BYTES = 1024 * 1024;

// The frame taxonomy. Every frame has { v, type, id } at minimum; per-type
// required/optional fields are documented here and enforced by decodeFrame.
export const FRAME_TYPES = Object.freeze({
  // Request/response correlation (phone→box RPC-ish call).
  //   REQUEST:  { id, method, path, headers?, body?, boxId? }
  //   RESPONSE: { id, status, headers?, body? }   (id echoes the REQUEST id)
  REQUEST: "request",
  RESPONSE: "response",

  // Stream multiplexing (SSE / PTY). All carry a `stream` id.
  //   STREAM_OPEN  request form  (relay → box): { id, stream, method, path?, headers? }
  //                                     opens a logical stream on the box.
  //   STREAM_OPEN  response form (box → relay): { id, stream, status, headers? }
  //                                     reports the upstream response head.
  //                                     `id` echoes the request STREAM_OPEN's id
  //                                     for correlation (the box agent sets the
  //                                     SAME stream id the relay assigned).
  //   STREAM_DATA: { id, stream, data, enc? }
  //     `data` is a string; encoding is signaled by the optional `enc` field.
  //     - enc="utf8" (default when absent): `data` is a UTF-8 string. SSE/JSON
  //       chunks ride this form (BET-156). Defaulting to utf8 when absent is a
  //       backwards-compat shim so existing SSE frames keep round-tripping.
  //     - enc="b64": `data` is a base64-encoded byte string. Raw terminal I/O
  //       for /pty rides this form (BET-158) — box-side ws messages are
  //       Buffers, the agent base64-encodes them so the JSON text frame stays
  //       a single uniform wire form, and the relay decodes before forwarding
  //       binary to the device WS.
  //     Encoding is the CALLER's responsibility; the framing layer only carries
  //     the wire form and validates the `enc` value when present.
  //   STREAM_END:  { id, stream }
  //   STREAM_ABORT:{ id, stream, reason? }
  // Exactly one of {method, status} is present — that is how the demux tells
  // a request-side open from a response-side open. Both or neither is a wire
  // error (decodeFrame drops the frame).
  STREAM_OPEN: "stream-open",
  STREAM_DATA: "stream-data",
  STREAM_END: "stream-end",
  STREAM_ABORT: "stream-abort",

  // Out-of-band error. When it carries the `id` of an in-flight REQUEST it
  // rejects that pending request; a bare error (no matching id) is a
  // transport-level signal the caller may log.
  //   ERROR: { id?, code?, message? }
  ERROR: "error",

  // Liveness. PING/PONG carry no payload beyond the envelope; `id` correlates
  // a PONG to its PING if the caller wants RTT.
  PING: "ping",
  PONG: "pong",
});

const KNOWN_TYPES = new Set(Object.values(FRAME_TYPES));

// ---------------------------------------------------------------------------
// Framing — encode / decode with validation
// ---------------------------------------------------------------------------

// Encode a frame object to a UTF-8 JSON string. Injects { v } if absent, so
// callers only specify { type, id, ... }. Throws on a structurally invalid
// frame (unknown type, missing id where required, oversize) — the caller is
// producing the frame, so a throw is the right "programmer error" signal.
export function encodeFrame(obj) {
  if (obj == null || typeof obj !== "object") {
    throw new Error("encodeFrame: frame must be an object");
  }
  const frame = { v: PROTOCOL_VERSION, ...obj };
  validateFrameShape(frame, { context: "encodeFrame" });
  const raw = JSON.stringify(frame);
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > MAX_FRAME_BYTES) {
    throw new Error(
      `encodeFrame: frame too large (${bytes} > ${MAX_FRAME_BYTES} bytes)`,
    );
  }
  return raw;
}

// Decode a raw WS frame (string, Buffer, or Uint8Array) into a validated frame
// object. Unlike encodeFrame, decode operates on UNTRUSTED input from the wire,
// so it NEVER throws for bad data — it returns null (malformed / oversized /
// unknown version / unknown type / failing per-type validation). A null return
// means "drop this frame"; a non-null return is a fully validated frame.
export function decodeFrame(raw) {
  let text;
  if (typeof raw === "string") {
    text = raw;
    // Oversize guard on the string form (byte length, matches encode).
    if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) return null;
  } else if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    if (raw.length > MAX_FRAME_BYTES) return null;
    text = Buffer.from(raw).toString("utf8");
  } else {
    return null;
  }

  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return null;
  }
  if (frame == null || typeof frame !== "object" || Array.isArray(frame)) {
    return null;
  }
  // Unknown-version guard: only the current protocol version is accepted.
  if (frame.v !== PROTOCOL_VERSION) return null;

  try {
    validateFrameShape(frame, { context: "decodeFrame" });
  } catch {
    return null;
  }
  return frame;
}

// Shared structural validator. Throws on failure; encodeFrame lets it bubble
// (programmer error), decodeFrame catches it (drop malformed wire input).
function validateFrameShape(frame, { context }) {
  const { v, type, id } = frame;
  if (v !== PROTOCOL_VERSION) {
    throw new Error(`${context}: bad version ${v}`);
  }
  if (typeof type !== "string" || !KNOWN_TYPES.has(type)) {
    throw new Error(`${context}: unknown frame type ${JSON.stringify(type)}`);
  }
  // `id` correlates request/response and stream-owning frames. It must be a
  // finite non-negative integer whenever present. It is REQUIRED for every
  // type except PING/PONG (a bare PING needs no id — an id makes it RTT-able).
  const idRequired = type !== FRAME_TYPES.PING && type !== FRAME_TYPES.PONG;
  if (id !== undefined) {
    if (!Number.isInteger(id) || id < 0) {
      throw new Error(`${context}: bad id ${JSON.stringify(id)}`);
    }
  } else if (idRequired) {
    throw new Error(`${context}: missing id for type ${type}`);
  }

  // boxId, when present, must be the 32-hex box identifier shape. Reuse the
  // canonical validator from webhooks.mjs rather than re-implementing the regex.
  if (frame.boxId !== undefined && !isValidToken(frame.boxId)) {
    throw new Error(`${context}: bad boxId`);
  }

  switch (type) {
    case FRAME_TYPES.REQUEST:
      if (typeof frame.method !== "string" || !frame.method) {
        throw new Error(`${context}: request missing method`);
      }
      if (typeof frame.path !== "string" || !frame.path) {
        throw new Error(`${context}: request missing path`);
      }
      break;
    case FRAME_TYPES.RESPONSE:
      if (!Number.isInteger(frame.status)) {
        throw new Error(`${context}: response missing integer status`);
      }
      break;
    case FRAME_TYPES.STREAM_OPEN:
      requireStreamId(frame, context);
      // Exactly-one-of {method, status}: a request-side open carries the
      // upstream method/path; a response-side open carries the upstream
      // status. Both or neither → wire error.
      {
        const hasMethod = typeof frame.method === "string" && frame.method !== "";
        const hasStatus = Number.isInteger(frame.status);
        if (hasMethod === hasStatus) {
          throw new Error(
            `${context}: stream-open must carry exactly one of method or status`,
          );
        }
      }
      break;
    case FRAME_TYPES.STREAM_END:
    case FRAME_TYPES.STREAM_ABORT:
      requireStreamId(frame, context);
      break;
    case FRAME_TYPES.STREAM_DATA:
      requireStreamId(frame, context);
      if (typeof frame.data !== "string") {
        throw new Error(`${context}: stream-data missing string data`);
      }
      // `enc` is optional. When present it MUST be one of the known encodings;
      // an unknown value is a wire error so a typo doesn't silently misroute
      // bytes that the consumer expected to be utf8.
      if (frame.enc !== undefined && frame.enc !== "utf8" && frame.enc !== "b64") {
        throw new Error(`${context}: stream-data unknown enc ${JSON.stringify(frame.enc)}`);
      }
      break;
    case FRAME_TYPES.ERROR:
    case FRAME_TYPES.PING:
    case FRAME_TYPES.PONG:
      // No extra required fields.
      break;
    default:
      // Unreachable: KNOWN_TYPES gate above already rejected unknown types.
      throw new Error(`${context}: unhandled type ${type}`);
  }
}

function requireStreamId(frame, context) {
  const s = frame.stream;
  const ok =
    (typeof s === "string" && s.length > 0) ||
    (Number.isInteger(s) && s >= 0);
  if (!ok) {
    throw new Error(`${context}: ${frame.type} missing valid stream id`);
  }
}

// ---------------------------------------------------------------------------
// PendingRequests — request/response correlation
// ---------------------------------------------------------------------------

// Assigns a monotonic id to each outbound request, returns a Promise that
// resolves with the matching response frame, and rejects on timeout, on an
// error frame carrying the same id, or when the transport closes (rejectAll).
//
// The clock is injectable (`now` + `setTimer`/`clearTimer`) so tests drive
// timeouts deterministically with a fake clock and leave no real timers open.
export class PendingRequests {
  // opts:
  //   now       — () => ms  (default Date.now)
  //   setTimer  — (fn, ms) => handle   (default setTimeout)
  //   clearTimer— (handle) => void     (default clearTimeout)
  constructor({ now = () => Date.now(), setTimer, clearTimer } = {}) {
    this._now = now;
    this._setTimer = setTimer || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimer = clearTimer || ((h) => clearTimeout(h));
    this._nextId = 1;
    this._pending = new Map(); // id -> { resolve, reject, timer }
  }

  // Reserve the next monotonic id without creating a promise. Rarely needed
  // directly — `create` is the usual entry — but exposed for callers that want
  // to stamp the id into a frame they build themselves.
  nextId() {
    return this._nextId++;
  }

  // Create a pending entry. Returns { id, promise }. `timeoutMs` (optional)
  // arms a rejection via the injected timer; omit/<=0 for no timeout.
  create({ timeoutMs } = {}) {
    const id = this.nextId();
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry = { resolve, reject, timer: null };
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      entry.timer = this._setTimer(() => {
        // Timed out: remove + reject. Guard against a race where the response
        // already settled and deleted the entry.
        if (this._pending.get(id) === entry) {
          this._pending.delete(id);
          reject(new Error(`request ${id} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    }
    this._pending.set(id, entry);
    return { id, promise };
  }

  // True if `id` is still awaiting settlement.
  has(id) {
    return this._pending.has(id);
  }

  get size() {
    return this._pending.size;
  }

  // Resolve the pending request whose id matches this response frame. Returns
  // true if a match was found + settled, false otherwise (unknown/late id).
  resolve(responseFrame) {
    const id = responseFrame?.id;
    const entry = this._pending.get(id);
    if (!entry) return false;
    this._pending.delete(id);
    if (entry.timer != null) this._clearTimer(entry.timer);
    entry.resolve(responseFrame);
    return true;
  }

  // Reject the pending request whose id matches this error frame. Returns true
  // if a match was found + settled. A bare error frame (no matching id) → false
  // so the caller can treat it as a transport-level signal.
  rejectFromError(errorFrame) {
    const id = errorFrame?.id;
    const entry = this._pending.get(id);
    if (!entry) return false;
    this._pending.delete(id);
    if (entry.timer != null) this._clearTimer(entry.timer);
    const msg =
      errorFrame?.message || `request ${id} failed (code ${errorFrame?.code})`;
    const err = new Error(msg);
    err.code = errorFrame?.code;
    entry.reject(err);
    return true;
  }

  // Reject a single pending request by id (e.g. an explicit abort).
  reject(id, err) {
    const entry = this._pending.get(id);
    if (!entry) return false;
    this._pending.delete(id);
    if (entry.timer != null) this._clearTimer(entry.timer);
    entry.reject(err instanceof Error ? err : new Error(String(err)));
    return true;
  }

  // Reject EVERY in-flight request. Called when the transport closes so no
  // caller hangs forever. Clears all timers so nothing leaks.
  rejectAll(err) {
    const e = err instanceof Error ? err : new Error(String(err ?? "closed"));
    for (const [, entry] of this._pending) {
      if (entry.timer != null) this._clearTimer(entry.timer);
      entry.reject(e);
    }
    this._pending.clear();
  }
}

// ---------------------------------------------------------------------------
// StreamRegistry — multiplex concurrent streams over one socket
// ---------------------------------------------------------------------------

// Routes inbound stream frames (open/data/end/abort) to the right per-stream
// consumer and enforces per-stream lifecycle: data before open is dropped, data
// after end/abort is dropped (never misrouted to a reused id), and end/abort
// clean up so a later stream can reuse the id cleanly.
//
// A consumer is an object with optional callbacks:
//   { onOpen(frame), onData(payload, frame), onEnd(frame), onAbort(reason, frame) }
// `onOpen` is invoked with the full STREAM_OPEN frame (the consumer reads off
// `status`/`headers` for response-side opens or `method`/`path` for request-
// side opens — the registry doesn't distinguish the two, by design). All
// callbacks are wrapped in try/catch so a throwing consumer cannot corrupt
// the registry or the demux loop.
//
// Registering a consumer for a stream id is how the owner subscribes.
export class StreamRegistry {
  constructor() {
    // stream id -> { consumer, open: bool, closed: bool }
    this._streams = new Map();
  }

  get size() {
    return this._streams.size;
  }

  has(streamId) {
    return this._streams.has(streamId);
  }

  // Register (open) a stream with its consumer. Idempotent per id only while
  // the id is free; re-opening a live id throws (a mux bug — two owners for one
  // id would misroute). After end/abort the id is free and may be re-opened.
  open(streamId, consumer = {}) {
    if (this._streams.has(streamId)) {
      throw new Error(`StreamRegistry: stream ${streamId} already open`);
    }
    this._streams.set(streamId, { consumer, open: true, closed: false });
  }

  // Route a decoded stream-* frame. Returns true if delivered, false if dropped
  // (unknown id, or data after close). This is the single inbound entry point
  // the demux loop calls for every stream frame.
  handleFrame(frame) {
    if (frame == null) return false;
    switch (frame.type) {
      case FRAME_TYPES.STREAM_OPEN:
        return this._deliverOpen(frame);
      case FRAME_TYPES.STREAM_DATA:
        return this._deliverData(frame);
      case FRAME_TYPES.STREAM_END:
        return this._deliverEnd(frame);
      case FRAME_TYPES.STREAM_ABORT:
        return this._deliverAbort(frame);
      default:
        return false;
    }
  }

  _deliverOpen(frame) {
    // Open frames are delivered to an already-subscribed consumer (the
    // consumer is registered locally via open() BEFORE it expects data; a
    // peer's STREAM_OPEN confirms the stream and carries the response head for
    // response-side opens). An open for an unknown id is dropped — the owner
    // subscribes before it expects data, so a stray open is a protocol bug.
    const st = this._streams.get(frame.stream);
    if (!st || st.closed) return false;
    try {
      st.consumer.onOpen?.(frame);
    } catch {
      /* isolate consumer errors */
    }
    return true;
  }

  _deliverData(frame) {
    const st = this._streams.get(frame.stream);
    // Drop data for unknown or already-closed streams — this is the "late data
    // after end is dropped, not misrouted" invariant.
    if (!st || st.closed || !st.open) return false;
    try {
      st.consumer.onData?.(frame.data, frame);
    } catch {
      // A consumer callback throwing must not corrupt the registry.
    }
    return true;
  }

  _deliverEnd(frame) {
    const st = this._streams.get(frame.stream);
    if (!st || st.closed) return false;
    st.closed = true;
    st.open = false;
    this._streams.delete(frame.stream);
    try {
      st.consumer.onEnd?.(frame);
    } catch {
      /* isolate consumer errors */
    }
    return true;
  }

  _deliverAbort(frame) {
    const st = this._streams.get(frame.stream);
    if (!st || st.closed) return false;
    st.closed = true;
    st.open = false;
    this._streams.delete(frame.stream);
    try {
      st.consumer.onAbort?.(frame.reason, frame);
    } catch {
      /* isolate consumer errors */
    }
    return true;
  }

  // Locally abort a stream (e.g. the owning request was cancelled). Fires the
  // consumer's onAbort and frees the id. Returns true if it was live.
  abort(streamId, reason) {
    const st = this._streams.get(streamId);
    if (!st || st.closed) return false;
    st.closed = true;
    st.open = false;
    this._streams.delete(streamId);
    try {
      st.consumer.onAbort?.(reason, { type: FRAME_TYPES.STREAM_ABORT, stream: streamId, reason });
    } catch {
      /* isolate consumer errors */
    }
    return true;
  }

  // Tear down every live stream (transport close). Each consumer's onAbort is
  // fired with the given reason so no stream hangs half-open.
  abortAll(reason = "transport closed") {
    const entries = [...this._streams.entries()];
    this._streams.clear();
    for (const [streamId, st] of entries) {
      if (st.closed) continue;
      try {
        st.consumer.onAbort?.(reason, {
          type: FRAME_TYPES.STREAM_ABORT,
          stream: streamId,
          reason,
        });
      } catch {
        /* isolate consumer errors */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// RoutingTable — boxId → transport handle
// ---------------------------------------------------------------------------

// Maps each boxId to its single live transport handle. Enforces the
// single-live-socket-per-box invariant: registering a boxId that already has a
// live socket EVICTS the stale one — it is removed from the table and its
// `close()` is called — before the new one is stored. Rationale: a box only
// ever holds one outbound tunnel; a second register almost always means the box
// reconnected (its old socket is dead-but-not-yet-reaped), so the freshest
// socket wins and the stale one is closed to free resources deterministically.
export class RoutingTable {
  // opts.onEvict(boxId, staleHandle) — optional hook fired when a live socket
  // is evicted by a re-register (for logging/metrics). Never throws upward.
  constructor({ onEvict } = {}) {
    this._byBox = new Map(); // boxId -> handle
    this._onEvict = typeof onEvict === "function" ? onEvict : null;
  }

  get size() {
    return this._byBox.size;
  }

  // Register a transport handle for a boxId. Rejects an invalid boxId shape
  // (defense in depth — the caller authenticated it, but the table is the last
  // guard before routing). Evicts+closes any existing live handle for the box.
  // Returns the evicted handle (or null) so the caller can react.
  register(boxId, handle) {
    if (!isValidToken(boxId)) {
      throw new Error("RoutingTable.register: invalid boxId");
    }
    if (handle == null || typeof handle.send !== "function") {
      throw new Error("RoutingTable.register: handle must have send()");
    }
    let evicted = null;
    const existing = this._byBox.get(boxId);
    if (existing && existing !== handle) {
      this._byBox.delete(boxId);
      evicted = existing;
      if (this._onEvict) {
        try {
          this._onEvict(boxId, existing);
        } catch {
          /* metrics hook must not break registration */
        }
      }
      try {
        existing.close?.();
      } catch {
        /* stale socket may already be dead */
      }
    }
    this._byBox.set(boxId, handle);
    return evicted;
  }

  // Look up the live handle for a boxId, or null.
  lookup(boxId) {
    return this._byBox.get(boxId) ?? null;
  }

  // True if the box has a live registered handle.
  has(boxId) {
    return this._byBox.has(boxId);
  }

  // Remove a boxId's handle. If `handle` is given, only unregister when it is
  // the currently-registered one (avoids a late close() of a stale socket
  // clobbering a fresh reconnect that already re-registered). Returns true if
  // something was removed.
  unregister(boxId, handle) {
    const existing = this._byBox.get(boxId);
    if (existing === undefined) return false;
    if (handle !== undefined && existing !== handle) return false;
    this._byBox.delete(boxId);
    return true;
  }

  // List all registered boxIds.
  list() {
    return [...this._byBox.keys()];
  }

  // Send a frame to a box by id via its live handle. Returns true if a live
  // handle existed and send() was invoked, false if the box is not connected.
  send(boxId, frame) {
    const handle = this._byBox.get(boxId);
    if (!handle) return false;
    handle.send(frame);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Transport contract (documentation + a fake for tests)
// ---------------------------------------------------------------------------

// The minimal duplex transport every piece above is written against. A real
// `ws` socket is adapted to this in the wired slice; tests use createFakeTransport.
//
//   send(raw)         — send an encoded frame (string) to the peer.
//   onMessage(cb)     — register a callback invoked with each raw inbound frame.
//   onClose(cb)       — register a callback invoked once when the transport closes.
//   close()           — close the transport (idempotent; fires onClose once).
//
// createFakeTransport returns a connected PAIR of in-memory transports (a, b):
// anything a.send()s arrives at b's onMessage callbacks and vice versa, closing
// either end fires both onClose callbacks exactly once. No real sockets, no
// timers — deterministic and self-contained for node:test.
export function createFakeTransport() {
  const state = { closed: false };
  const a = makeEndpoint();
  const b = makeEndpoint();
  a._peer = b;
  b._peer = a;
  a._state = state;
  b._state = state;

  function makeEndpoint() {
    const msgCbs = [];
    const closeCbs = [];
    const ep = {
      _peer: null,
      _state: null,
      sent: [], // record of everything this endpoint sent (test convenience)
      send(raw) {
        if (ep._state.closed) return;
        ep.sent.push(raw);
        // Deliver asynchronously? No — synchronous delivery keeps node:test
        // deterministic without awaiting microtasks. Callers that need async
        // can wrap. Guard against a callback closing the transport mid-fanout.
        for (const cb of ep._peer._msgCbs.slice()) {
          if (ep._state.closed) break;
          cb(raw);
        }
      },
      onMessage(cb) {
        msgCbs.push(cb);
      },
      onClose(cb) {
        closeCbs.push(cb);
      },
      close() {
        if (ep._state.closed) return;
        ep._state.closed = true;
        for (const cb of a._closeCbs.slice()) cb();
        for (const cb of b._closeCbs.slice()) cb();
      },
      _msgCbs: msgCbs,
      _closeCbs: closeCbs,
    };
    return ep;
  }

  return { a, b };
}
