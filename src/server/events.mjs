// In-process pub/sub + the GET /events SSE endpoint.
// Event envelope: { kind: "opencode"|"pty"|"status"|"screenshot"|"capJob"|"cap.updated", payload: any }

export function createBus() {
  const subs = new Set();
  // Optional state replay. `setSnapshot(fn)` registers a provider that returns
  // the current-state events to emit to each NEW subscriber on connect. The
  // bus itself is a pure forwarder (no retained history); this is the one
  // deliberate exception so a (re)connecting client recovers edge-only state.
  let snapshot = () => [];
  return {
    subscribe(fn) {
      subs.add(fn);
      // Replay current state to the newly (re)connected consumer. Edge-only
      // frames — `stream.running`, and the pending `stream.questions` /
      // `stream.permissions` (BET-916) — never re-fire on their own, so a
      // client that connects mid-state would never learn a session is already
      // busy or already blocked on an interactive card. This is exactly the
      // force-quit + relaunch case, where those recoverable states must
      // survive a fresh process.
      for (const evt of snapshot()) { try { fn(evt); } catch {} }
      return () => subs.delete(fn);
    },
    publish(evt) { for (const fn of subs) { try { fn(evt); } catch {} } },
    setSnapshot(fn) { snapshot = fn; },
  };
}

// ---------- per-connection subscription filter (iOS stability spec, C1) ----------
//
// A connection may narrow what it receives: `kinds` limits envelopes to the listed `kind`s (heartbeat always
// passes) and a focus set limits the HEAVY `stream` subs (streamed text / tool output / message refetch hints)
// to the sessions the client is looking at. A connection that never sends either gets everything, as before.
export const HEAVY_STREAM_SUBS = new Set(["flush", "toolOutput", "messageChanged"]);
export const MAX_FILTER_KINDS = 64;
export const MAX_FOCUS_SESSIONS = 32;
const MAX_CONTROL_MESSAGE_BYTES = 64 * 1024;

/** A kinds list → a Set, or null (= deliver all) for an empty / missing / oversized list. Never throws. */
function normalizeKinds(list, warn) {
  if (!Array.isArray(list)) return null;
  const out = new Set(list.filter((k) => typeof k === "string").map((k) => k.trim()).filter(Boolean));
  if (out.size === 0) return null;
  if (out.size > MAX_FILTER_KINDS) {
    warn?.(`[events] kinds list of ${out.size} entries exceeds ${MAX_FILTER_KINDS}; delivering everything`);
    return null;
  }
  return out;
}

/** The `kinds` query parameter (comma-separated) → a list for `createEventFilter`; null when absent. */
export function parseKindsParam(value) {
  return typeof value === "string" ? value.split(",") : null;
}

/**
 * @param {{ kinds?: string[]|null, warn?: (msg: string) => void }} [opts]
 * @returns {{ accepts: (evt: any) => boolean, setKinds: (list?: unknown) => void, setFocus: (ids?: unknown) => void }}
 */
export function createEventFilter({ kinds = null, warn = (m) => console.warn(m) } = {}) {
  let kindSet = normalizeKinds(kinds, warn);
  let focus = null; // null = no focus message yet: heavy subs go to everyone
  return {
    accepts(evt) {
      const kind = evt?.kind;
      if (kindSet && kind !== "heartbeat" && !kindSet.has(kind)) return false;
      if (focus && kind === "stream" && HEAVY_STREAM_SUBS.has(evt.sub)) {
        const sid = evt.sessionId;
        if (typeof sid === "string" && sid && !focus.has(sid)) return false;
      }
      return true;
    },
    setKinds(list) {
      kindSet = normalizeKinds(list, warn);
    },
    /** Replace the focus set; returns the ids that were NOT in the previous set (all of them on the first call). */
    setFocus(ids) {
      if (!Array.isArray(ids)) return [];
      const prev = focus;
      focus = new Set(ids.filter((s) => typeof s === "string" && s).slice(0, MAX_FOCUS_SESSIONS));
      return [...focus].filter((s) => !prev || !prev.has(s));
    },
  };
}

/**
 * Apply one client→server WS text message to a filter. Malformed messages are ignored.
 * `onFocusAdded(ids)` is called synchronously for a focus message that adds session ids.
 */
export function applyControlMessage(filter, raw, { onFocusAdded } = {}) {
  let msg;
  try {
    if (raw == null) return;
    const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    if (text.length > MAX_CONTROL_MESSAGE_BYTES) return;
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "kinds") filter.setKinds(msg.kinds);
  else if (msg.type === "focus") {
    const added = filter.setFocus(msg.sessions);
    if (added.length > 0) onFocusAdded?.(added);
  }
}

// Attach to a node:http response. One SSE stream; client demuxes by `kind`.
// Optional `?kinds=a,b` narrows the stream to those kinds (C1); absent = everything.
export function handleEventsRequest(bus, req, res) {
  let filter = null;
  try {
    const kinds = new URL(req.url ?? "/", "http://localhost").searchParams.get("kinds");
    if (kinds != null) filter = createEventFilter({ kinds: parseKindsParam(kinds) });
  } catch { /* an unparseable url: deliver everything */ }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
    // Tell reverse proxies (Cloudflare tunnel, nginx) NOT to buffer this
    // response. Without it the SSE stream is held proxy-side: the client's
    // EventSource connects but receives zero bytes (works direct on the
    // box, dead through the tunnel). This is the canonical SSE-behind-
    // proxy directive.
    "x-accel-buffering": "no",
  });
  res.write("retry: 2000\n\n");
  // Flush the headers + retry preamble immediately so the proxy opens the
  // downstream stream now rather than waiting for the first buffered chunk.
  res.flushHeaders?.();
  const off = bus.subscribe((evt) => {
    if (filter && !filter.accepts(evt)) return;
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  });
  const ka = setInterval(() => res.write(": keep-alive\n\n"), 15000);
  ka.unref(); // Don't keep the Node process alive for keep-alive pings alone
  req.on("close", () => { clearInterval(ka); off(); });
}

// Attach to a WebSocket (the /events upgrade path). Same `bus`, same
// {kind,payload} envelope as SSE — one JSON text frame per event, so the
// client demux is identical. This exists because iOS standalone PWAs can't
// reliably receive SSE/EventSource (works in Safari proper), whereas
// WebSockets work there — proven by the /pty WS already tunneling fine in
// the installed PWA. SSE (handleEventsRequest) is kept for other consumers.
//
// Subscription filter (C1): optional `kinds` (from the `?kinds=` query) plus the client's runtime
// `{"type":"kinds"}` / `{"type":"focus"}` text messages. Heartbeats below bypass it (they are sent
// outside the bus).
//
// Focus replay: V2's streamed text deltas are ephemeral, so a client that focuses a session mid-segment would
// miss everything streamed before. When a focus message ADDS a session, this connection (only) is sent, per
// open text/reasoning part, a `flush` frame with `replay:true` = "set this part's text to exactly this"
// (`inFlightText(sid)` → [{messageID, partID, field, text}]; absent = no replay).
export function attachEventsWs(bus, ws, { kinds = null, inFlightText = null } = {}) {
  const filter = createEventFilter({ kinds });
  const replayInFlight = (sessionIds) => {
    if (typeof inFlightText !== "function") return;
    for (const sessionId of sessionIds) {
      let parts;
      try { parts = inFlightText(sessionId); } catch { continue; }
      for (const { messageID, partID, field, text } of parts ?? []) {
        if (ws.readyState !== 1 /* OPEN */) return;
        const evt = { kind: "stream", sub: "flush", sessionId, payload: { messageID, partID, field, text, replay: true } };
        if (!filter.accepts(evt)) continue;
        try { ws.send(JSON.stringify(evt)); } catch { /* peer gone */ }
      }
    }
  };
  ws.on?.("message", (data) => applyControlMessage(filter, data, { onFocusAdded: replayInFlight }));
  const off = bus.subscribe((evt) => {
    if (ws.readyState === 1 /* OPEN */ && filter.accepts(evt)) {
      try { ws.send(JSON.stringify(evt)); } catch { /* peer gone */ }
    }
  });
  // Heartbeat: keeps intermediaries (Cloudflare tunnel) from idling the
  // socket and lets the client notice a half-open connection. The WS
  // protocol ping() alone isn't enough — it's answered by the network stack
  // transparently to JS, so the browser never learns whether frames are
  // actually still arriving. Also send an app-level frame the client CAN
  // see; the renderer's liveness watchdog (httpApi.ts) stamps a
  // last-frame-received timestamp on every frame, including this one, and
  // force-reconnects if too many heartbeats are missed.
  const ka = setInterval(() => {
    try { ws.ping?.(); } catch { /* closing */ }
    try { ws.send(JSON.stringify({ kind: "heartbeat", ts: Date.now() })); } catch { /* closing */ }
  }, 15000);
  ka.unref();
  const cleanup = () => { clearInterval(ka); off(); };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}
