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
  });
  res.write("retry: 2000\n\n");
  const off = bus.subscribe((evt) => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  });
  const ka = setInterval(() => res.write(": keep-alive\n\n"), 15000);
  ka.unref(); // Don't keep the Node process alive for keep-alive pings alone
  req.on("close", () => { clearInterval(ka); off(); });
}
