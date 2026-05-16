// bui mobile server — runs on the Linux box, exposes tmux over HTTP+WS.
// Serves a touch-friendly single-page client at /.
//
// Why local-exec (not the SSH wrapper from src/main/pty.ts):
//   This process IS the remote. tmux + node-pty run in the same box, so we
//   skip the ssh hop entirely. One less moving part, one less auth surface.

import { createServer } from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn as cpSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";
import { homedir } from "node:os";
import { pipeline } from "node:stream/promises";
import { WebSocketServer } from "ws";
import { spawn as ptySpawn } from "node-pty";
import * as tmux from "./tmux.mjs";
import { createBus, handleEventsRequest } from "./events.mjs";
import { buildHandlers, handleRpcRequest } from "./rpc.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const PUBLIC_DIR = join(__dirname, "public");

const bus = createBus();
const rpcHandlers = buildHandlers({ tmux });

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
};

// Vendor files we serve out of node_modules. Keys are the public URL path
// under /vendor/, values are the on-disk path under node_modules.
const VENDOR = {
  "xterm.js": "@xterm/xterm/lib/xterm.js",
  "xterm.js.map": "@xterm/xterm/lib/xterm.js.map",
  "xterm.css": "@xterm/xterm/css/xterm.css",
  "addon-fit.js": "@xterm/addon-fit/lib/addon-fit.js",
  "addon-fit.js.map": "@xterm/addon-fit/lib/addon-fit.js.map",
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

  if (req.method === "GET" && path.startsWith("/vendor/")) {
    const name = path.slice("/vendor/".length);
    const rel = VENDOR[name];
    if (!rel) {
      res.writeHead(404).end("not found");
      return;
    }
    return serveFile(res, join(PROJECT_ROOT, "node_modules", rel));
  }

  if (req.method === "GET" && path.startsWith("/static/")) {
    const target = safeJoin(PUBLIC_DIR, path.slice("/static/".length));
    if (!target) {
      res.writeHead(403).end("forbidden");
      return;
    }
    return serveFile(res, target);
  }

  if (req.method === "POST" && path === "/api/upload") {
    return handleUpload(req, res, url);
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
  if (url.pathname !== "/pty") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => attachPty(ws, url));
});

function attachPty(ws, url) {
  const session = url.searchParams.get("session");
  const windowIdx = url.searchParams.get("window");
  const cols = Math.max(20, Math.min(500, Number(url.searchParams.get("cols")) || 80));
  const rows = Math.max(5, Math.min(200, Number(url.searchParams.get("rows")) || 24));

  if (!session || !/^[A-Za-z0-9._-]+$/.test(session)) {
    ws.close(1008, "bad session");
    return;
  }

  // Pre-select the requested window so attach lands on it. Fail-open: if the
  // select fails (window gone, session gone), the attach below will surface
  // the real error to the user.
  if (windowIdx != null && /^\d+$/.test(windowIdx)) {
    cpSpawn("tmux", ["select-window", "-t", `${session}:${windowIdx}`], {
      stdio: "ignore",
    });
  }

  const pty = ptySpawn("tmux", ["attach-session", "-t", session], {
    name: "xterm-256color",
    cols,
    rows,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  pty.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  pty.onExit(({ exitCode }) => {
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
      pty.write(msg.data);
    } else if (msg.type === "resize") {
      const c = Number(msg.cols);
      const r = Number(msg.rows);
      if (c > 0 && r > 0) pty.resize(c, r);
    }
  });

  ws.on("close", () => {
    try {
      pty.kill();
    } catch {
      /* already gone */
    }
  });
}

server.listen(PORT, HOST, () => {
  console.log(`bui-mobile listening on http://${HOST}:${PORT}`);
});
