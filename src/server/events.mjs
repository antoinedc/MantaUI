// In-process pub/sub + the GET /events SSE endpoint.
// Event envelope: { kind: "opencode"|"pty"|"status"|"screenshot", payload: any }

export function createBus() {
  const subs = new Set();
  return {
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    publish(evt) { for (const fn of subs) { try { fn(evt); } catch {} } },
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
  // socket and lets the client notice a half-open connection.
  const ka = setInterval(() => {
    try { ws.ping?.(); } catch { /* closing */ }
  }, 15000);
  ka.unref();
  const cleanup = () => { clearInterval(ka); off(); };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}
