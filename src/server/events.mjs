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

// Attach to a node:http response. One SSE stream; client demuxes by `kind`.
export function handleEventsRequest(bus, req, res) {
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
export function attachEventsWs(bus, ws) {
  const off = bus.subscribe((evt) => {
    if (ws.readyState === 1 /* OPEN */) {
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
