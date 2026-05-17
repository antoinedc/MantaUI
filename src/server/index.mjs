// bui mobile server — runs on the Linux box, exposes tmux over HTTP+WS.
// Serves a touch-friendly single-page client at /.
//
// Why local-exec (not the SSH wrapper from src/main/pty.ts):
//   This process IS the remote. tmux + node-pty run in the same box, so we
//   skip the ssh hop entirely. One less moving part, one less auth surface.

import { createServer } from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";
import { homedir } from "node:os";
import { pipeline } from "node:stream/promises";
import { WebSocketServer } from "ws";
import * as tmux from "./tmux.mjs";
import * as oc from "./opencode.mjs";
import * as pty from "./pty.mjs";
import * as local from "./local.mjs";
import { createBus, handleEventsRequest, attachEventsWs } from "./events.mjs";
import { buildHandlers, handleRpcRequest } from "./rpc.mjs";
import { startStatusPoller } from "./status.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
// The web client is the React renderer built by `npm run build:mobile` into
// mobile/www/ (index.html + hashed /assets/* + PWA manifest/icons). The old
// vanilla src/server/public/ client was removed 2026-05-17.
const PUBLIC_DIR = join(PROJECT_ROOT, "mobile", "www");

const bus = createBus();
const rpcHandlers = buildHandlers({ tmux, oc, pty, bus, local });

// Periodically capture every tmux pane and push WindowStatus[] batches so the
// mobile sidebar's activity/attention dots work (parity with desktop status.ts).
// eslint-disable-next-line no-unused-vars
const { stop: stopStatusPoller } = startStatusPoller(bus, { intervalMs: 2000 });

// Forward every opencode SSE event into the bus so mobile clients
// subscribed to /events receive live chat updates.
// subscribeEvents reconnects silently on failure (opencode may not be up
// yet at server start — that's fine, it retries with 1.5s backoff).
//
// Trust mode (mirrors src/main/index.ts opencodeBusLoop):
// When a permission.asked event arrives and chatAutoAllow is true, we
// auto-reply "always" and suppress the event (no permission card reaches
// the client). Config is read live per event so toggling Trust takes
// effect immediately. On any error in the auto-allow path we fall back
// to publishing the event normally so the user can approve manually.
//
// subscribeEvents calls onEvent() synchronously (no await), so we wrap
// the async trust-mode logic in an immediately-invoked async function
// with .catch() to avoid unhandled rejection warnings if the async work
// rejects — the pump loop itself is unaffected.
// eslint-disable-next-line no-unused-vars
const stopOpencodePump = oc.subscribeEvents((evt) => {
  if (evt && evt.type === "permission.asked") {
    (async () => {
      try {
        const cfg = await local.configGet();
        if (cfg.chatAutoAllow) {
          const permId = evt.properties?.id;
          if (permId) {
            try {
              await oc.replyPermission({ requestId: permId, reply: "always" });
            } catch (e) {
              console.warn("[opencode-pump] auto-allow failed:", e?.message ?? e);
              // Fall back: forward the event so the user can approve manually.
              bus.publish({ kind: "opencode", payload: evt });
            }
            // Suppress: don't publish when auto-allow succeeded (mirrors desktop continue).
            return;
          }
        }
      } catch (e) {
        console.warn("[opencode-pump] trust-mode config read failed:", e?.message ?? e);
        // Fall back: forward the event so the user can approve manually.
      }
      // chatAutoAllow is false, or permId was missing, or configGet threw — publish normally.
      bus.publish({ kind: "opencode", payload: evt });
    })().catch((e) => {
      console.warn("[opencode-pump] unexpected error:", e?.message ?? e);
    });
    return;
  }
  bus.publish({ kind: "opencode", payload: evt });
});

const PORT = Number(process.env.BUI_MOBILE_PORT ?? 8787);
const HOST = process.env.BUI_MOBILE_HOST ?? "0.0.0.0";

// ---------- static file serving ----------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

async function serveFile(res, filePath, fallbackStatus = 404) {
  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error("not a file");
    const data = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-cache",
      "content-length": data.length,
    });
    res.end(data);
  } catch {
    res.writeHead(fallbackStatus, { "content-type": "text/plain" });
    res.end(fallbackStatus === 404 ? "not found" : "error");
  }
}

function safeJoin(root, sub) {
  const target = normalize(join(root, sub));
  if (!target.startsWith(root)) return null; // path traversal guard
  return target;
}

// ---------- uploads ----------
//
// Layout matches the Electron path (~/.bui-uploads/<session>/<ts>/<file>) so
// the existing cleanup conventions apply. Client sends one request per file
// with raw bytes; filename + batch id come in headers. No multipart parser.

const UPLOAD_ROOT = join(homedir(), ".bui-uploads");
const SESSION_RE = /^[A-Za-z0-9._-]+$/;
const BATCH_RE = /^[0-9]{6,20}$/;

function safeBasename(name) {
  // Strip path separators and control chars; collapse oddballs to "_".
  let n = String(name).replace(/[\x00-\x1f\\/:*?"<>|]/g, "_");
  if (n === "." || n === "..") n = "file";
  if (!n) n = "file";
  if (n.length > 200) n = n.slice(0, 200);
  return n;
}

async function handleUpload(req, res, url) {
  const session = url.searchParams.get("session");
  if (!session || !SESSION_RE.test(session)) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bad session" }));
    return;
  }
  const rawName = req.headers["x-filename"];
  if (typeof rawName !== "string" || !rawName) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "missing X-Filename" }));
    return;
  }
  let decoded;
  try { decoded = decodeURIComponent(rawName); } catch { decoded = rawName; }
  const filename = safeBasename(decoded);

  const batchHeader = req.headers["x-batch-id"];
  const batch = typeof batchHeader === "string" && BATCH_RE.test(batchHeader)
    ? batchHeader
    : String(Date.now());

  const dir = join(UPLOAD_ROOT, session, batch);
  const target = join(dir, filename);

  try {
    await mkdir(dir, { recursive: true });
    await pipeline(req, createWriteStream(target));
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ path: target }));
}

// ---------- HTTP ----------

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  // The Capacitor shell loads from http://localhost and calls this server
  // cross-origin. Allow any origin (the server is the user's own box) and
  // answer CORS preflight so the mobile WebView's fetch() isn't blocked.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Filename");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (req.method === "GET" && path === "/events") {
    return handleEventsRequest(bus, req, res);
  }
  if (req.method === "POST" && path.startsWith("/rpc/")) {
    const channel = decodeURIComponent(path.slice("/rpc/".length));
    return handleRpcRequest(rpcHandlers, channel, req, res);
  }

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    return serveFile(res, join(PUBLIC_DIR, "index.html"));
  }

  if (req.method === "GET" && path === "/api/projects") {
    try {
      const projects = await tmux.listProjects();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(projects));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
    return;
  }

  if (req.method === "POST" && path === "/api/upload") {
    return handleUpload(req, res, url);
  }

  // Static fallback for the React + PWA bundle in mobile/www/. All backend
  // routes (/events, /rpc/*, /api/*, /pty WS) were matched above, so this
  // only ever sees client asset / SPA-route requests. An existing file
  // (hashed /assets/*, /manifest.webmanifest, /icons/*) is served with its
  // MIME; anything else falls back to index.html so client-side routing /
  // deep links work. safeJoin() blocks path traversal.
  if (req.method === "GET") {
    const target = safeJoin(PUBLIC_DIR, decodeURIComponent(path));
    if (target) {
      try {
        if ((await stat(target)).isFile()) {
          return serveFile(res, target);
        }
      } catch {
        // not an existing file → fall through to SPA index
      }
    }
    return serveFile(res, join(PUBLIC_DIR, "index.html"));
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

// ---------- WebSocket: one PTY per connection ----------
//
// URL: /pty?session=NAME&window=INDEX&cols=80&rows=24
// Client→Server text frames are JSON: {type:"data",data:"..."} or
//   {type:"resize",cols,rows}.
// Server→Client text frames are raw PTY output (utf-8).

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/events") {
    // Live event stream over WS (SSE alternative for iOS standalone PWAs,
    // which can't reliably receive EventSource). Same bus + envelope.
    wss.handleUpgrade(req, socket, head, (ws) => attachEventsWs(bus, ws));
    return;
  }
  if (url.pathname === "/pty") {
    wss.handleUpgrade(req, socket, head, (ws) => attachPty(ws, url));
    return;
  }
  socket.destroy();
});

function attachPty(ws, url) {
  const session = url.searchParams.get("session");
  const windowIdx = url.searchParams.get("window");
  const cols = Number(url.searchParams.get("cols")) || 80;
  const rows = Number(url.searchParams.get("rows")) || 24;

  if (!session || !/^[A-Za-z0-9._-]+$/.test(session)) {
    ws.close(1008, "bad session");
    return;
  }

  // Delegate to the shared spawn helper in pty.mjs.
  // spawnRawPty handles window pre-select, clamping, env — behaviour unchanged.
  const wsPty = pty.spawnRawPty({ session, windowIdx, cols, rows });

  wsPty.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  wsPty.onExit(({ exitCode }) => {
    try {
      ws.close(1000, `pty exited ${exitCode}`);
    } catch {
      /* already closed */
    }
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "data" && typeof msg.data === "string") {
      wsPty.write(msg.data);
    } else if (msg.type === "resize") {
      const c = Number(msg.cols);
      const r = Number(msg.rows);
      if (c > 0 && r > 0) wsPty.resize(c, r);
    }
  });

  ws.on("close", () => {
    try {
      wsPty.kill();
    } catch {
      /* already gone */
    }
  });
}

server.listen(PORT, HOST, () => {
  console.log(`bui-mobile listening on http://${HOST}:${PORT}`);
});
