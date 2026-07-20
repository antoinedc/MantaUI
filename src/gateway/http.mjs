// http.mjs — small HTTP helpers for the gateway service.
//
// MOVED from src/relay/server.mjs in BET-199 (the relay directory will be
// deleted by BET-198 WP4; the only piece worth salvaging was the body reader
// + 256 KiB cap, which is what gates every payload in the gateway). Pure
// functions where possible; the request reader is callback-style to match
// the relay's existing pattern (tests inject a fake req).
//
// The gateway binds 127.0.0.1:20081 (claimed in shared/ports/registry.md)
// and terminates behind the system Caddy — Caddy forwards the real client
// IP in `X-Forwarded-For`. Body cap matches the relay's: 256 KiB is
// generous for a JSON `{box_id, tokens, payload}` and rejects oversized
// payloads before they can exhaust memory.

export const MAX_BODY_BYTES = 256 * 1024;

// CORS headers applied to every gateway response. The native app (Capacitor
// WKWebView) pairs by fetch()ing https://gateway.mantaui.com/* from a
// cross-origin frame — without Access-Control-Allow-Origin the request
// hangs on iOS instead of cleanly returning an error. Same shape as the
// relay/bui-server already use.
export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization, x-box-id",
    "Access-Control-Max-Age": "600",
  };
}

// JSON response helper.
export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", ...corsHeaders() });
  res.end(body);
}

// Plain-text response helper (for 404s and the health probe).
export function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain", ...corsHeaders() });
  res.end(text);
}

// Read a request body up to MAX_BODY_BYTES. Calls `cb(err, body)` once;
// the body is a UTF-8 string (empty string when no bytes were sent).
// `err.code === "too_large"` once the cap is exceeded; the request stream
// is destroyed so no further chunks are read.
//
// Pure w.r.t. the request object — tests inject a fake req with
// `on("data"/"end"/"error")` and a small manual emitter.
export function readBody(req, cb) {
  const chunks = [];
  let total = 0;
  let done = false;
  const finish = (err, body) => {
    if (done) return;
    done = true;
    cb(err, body);
  };
  req.on("data", (c) => {
    total += c.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error("payload too large");
      err.code = "too_large";
      req.destroy();
      finish(err);
      return;
    }
    chunks.push(c);
  });
  req.on("end", () =>
    finish(null, chunks.length ? Buffer.concat(chunks).toString("utf8") : ""),
  );
  req.on("error", () =>
    finish(Object.assign(new Error("read error"), { code: "read" })),
  );
}
