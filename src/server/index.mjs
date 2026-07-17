// bui mobile server — runs on the Linux box, exposes tmux over HTTP+WS.
// Serves a touch-friendly single-page client at /.
//
// Why local-exec (not the SSH wrapper from src/main/pty.ts):
//   This process IS the remote. tmux + node-pty run in the same box, so we
//   skip the ssh hop entirely. One less moving part, one less auth surface.

import { createServer } from "node:http";
import { readFile, stat, mkdir, rm } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { pipeline } from "node:stream/promises";
import { UPLOAD_DIRNAME, OUTBOX_DIRNAME } from "../shared/paths.mjs";
import { WebSocketServer } from "ws";
import * as tmux from "./tmux.mjs";
import * as oc from "./opencode.mjs";
import * as pty from "./pty.mjs";
import * as local from "./local.mjs";
import { createBus, handleEventsRequest, attachEventsWs } from "./events.mjs";
import { attachPtyWs } from "./ptyWs.mjs";
import { buildHandlers, handleRpcRequest } from "./rpc.mjs";
import { startStatusPoller } from "./status.mjs";
import { startOutboxPoller } from "./outbox.mjs";
import { startSchedulePoller, createJob, listJobs, deleteJob } from "./schedule.mjs";
import {
  startFileServer,
  startCleanupPoller,
  registerPage,
  unregisterPage,
  listPages,
} from "./servePage.mjs";
import { listPeers, inspectPeer, sendPeerMessage, resolveWorkspace } from "./peers.mjs";
import { setSecret, deleteSecret, listSecrets, provideSecret } from "./secrets.mjs";
import {
  createWebhookEngine,
  createHook,
  listHooks,
  deleteHook,
  createRateLimiter,
} from "./webhooks.mjs";
import {
  ensureAuth,
  createAuthEngine,
  isLocalDirectRequest,
  authorizationForRequest,
  AUTH_RL_CAPACITY,
  AUTH_RL_REFILL_PER_SEC,
} from "./auth.mjs";
import { createRelayAgent, shouldStartRelayAgent } from "../relay/agent/index.mjs";
import * as push from "./push.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
// The web client is the React renderer built by `npm run build:mobile` into
// mobile/www/ (index.html + hashed /assets/* + PWA manifest/icons). The old
// vanilla src/server/public/ client was removed 2026-05-17.
const PUBLIC_DIR = join(PROJECT_ROOT, "mobile", "www");

const bus = createBus();
// Shared deps passed to store-mutating helpers so they can publish the
// `*.updated` bus event the renderer cards listen for (JobCard, WebhooksCard,
// etc). Single source of truth — every endpoint that creates/deletes a
// store entry uses this same deps object.
const BUS_PUBLISH_DEPS = { publish: (evt) => bus.publish(evt) };

// DELETE handler for /api/<store> endpoints: `?id=<id>` → store.deleteFn(id,
// BUS_PUBLISH_DEPS) → 200 {deleted:bool}. The boilerplate (id-required 400,
// the await + publish-deps call, the success response) is identical across
// /api/schedule, /api/webhook, and /api/secrets — extracting it removes a
// 22-line intra-file clone jscpd flagged in BET-155.
async function handleApiDelete(req, url, res, deleteFn) {
  const id = url.searchParams.get("id");
  if (!id) {
    respondJson(res, 400, { error: "id is required" });
    return;
  }
  const result = await deleteFn(id, BUS_PUBLISH_DEPS);
  respondJson(res, 200, { deleted: result.deleted });
}

const rpcHandlers = buildHandlers({ tmux, oc, pty, bus, local });

// Resolve a caller's bui project (tmux session) name from its opencode
// sessionID and/or cwd, so project-scoped secrets resolve to the right
// workspace. Reuses the same logic peers.mjs uses. Best-effort: returns null
// if tmux is unreachable or the session/dir isn't matched.
async function resolveProjectName({ sessionID, directory }) {
  if (!sessionID && !directory) return null;
  try {
    const projects = await tmux.listProjects();
    const ws = resolveWorkspace(projects, sessionID, directory);
    return ws?.project?.tmuxSession ?? null;
  } catch {
    return null;
  }
}

// Desktop notification leg: the notification router (push.mjs) publishes a
// `desktopNotify` bus envelope when it decides the desktop should be notified.
// The Electron app subscribes to GET /events and renders it as an OS
// Notification. push.mjs stays bus-decoupled via this sink.
push.setDesktopSink((payload) =>
  bus.publish({ kind: "desktopNotify", payload }),
);

// Periodically capture every tmux pane and push WindowStatus[] batches so the
// mobile sidebar's activity/attention dots work (parity with desktop status.ts).
// eslint-disable-next-line no-unused-vars
const { stop: stopStatusPoller } = startStatusPoller(bus, { intervalMs: 2000 });

// Agent → device file push: watch ~/.manta-outbox/ for files the AI drops and
// publish `agentFile` bus events so connected devices show a "Save" toast
// (parity with the desktop outbox poller; see src/server/outbox.mjs).
// eslint-disable-next-line no-unused-vars
const { stop: stopOutboxPoller } = startOutboxPoller(bus, { intervalMs: 3000 });

// Scheduled-prompt engine: durable jobs in ~/.manta/schedule.json, fired
// by re-submitting the stored prompt into its opencode session via
// oc.sendPrompt — the scheduled work then streams into the user's open
// ChatPanel as a new turn. Server-owned (survives Mac-app-close / reboot).
// The remote AI creates jobs via the global opencode `schedule` tool →
// POST /api/schedule (below). See src/server/schedule.mjs + docs/.
// eslint-disable-next-line no-unused-vars
const { stop: stopSchedulePoller } = startSchedulePoller(
  {
    sendPrompt: (args) => oc.sendPrompt(args),
    publish: (evt) => bus.publish(evt),
  },
  { intervalMs: 30000 },
);

// Inbound webhook engine: external actors POST to the public /hook/<token>
// route (below) to wake a chat session with an event — the push counterpart to
// the schedule poller. The engine owns the rate limiter + the defer-until-idle
// queue, and tracks per-session busy state from the opencode event firehose
// (observeEvent, called in the pump below). See src/server/webhooks.mjs + docs.
const webhookEngine = createWebhookEngine({
  sendPrompt: (args) => oc.sendPrompt(args),
  publish: (evt) => bus.publish(evt),
});

// Single-box auth gate (M1, job zero). Every request must carry the box_token
// as `Authorization: Bearer <token>` except the pairing handshake (/auth/*) and
// the public webhook delivery leg (/hook/<token>, self-authenticated). The box
// identity ({box_id, box_token}) is generated + persisted 0600 on first run.
//
// Enforcement is ON by default. MANTA_AUTH_DISABLED=1 is an escape hatch for an
// existing self-hoster mid-upgrade who hasn't paired yet — it disables the gate
// and prints a loud warning. New deployments should never set it.
const authEnforced = process.env.MANTA_AUTH_DISABLED !== "1";
const boxAuth = await ensureAuth();
const authEngine = createAuthEngine({ auth: boxAuth, enforce: authEnforced });
// Rate limiter for the unauthenticated /auth/* surface (the brute-force target).
const authRateLimit = createRateLimiter({
  capacity: AUTH_RL_CAPACITY,
  refillPerSec: AUTH_RL_REFILL_PER_SEC,
});
if (!authEnforced) {
  console.warn(
    "[auth] ⚠️  MANTA_AUTH_DISABLED=1 — the box server is UNAUTHENTICATED. " +
      "Anyone who can reach this port has full access. Unset it and pair a device.",
  );
} else {
  console.log(`[auth] gate enabled — box_id ${boxAuth.box_id}`);
}

// Relay-agent handle (BET-151 ADR-1). Populated below in the listen() callback
// when shouldStartRelayAgent(config) returns true. Read by GET /relay/status
// (loopback-only) so install.sh can poll for the handshake without standing up
// its own websocket. Null = agent never started (config opted out, or the
// listener never got that far — in either case /relay/status returns
// `connected: false`).
let relayAgent = null;

// Serve-page file server: lightweight HTTP server on 127.0.0.1:20080 that
// serves HTML pages from ~/.manta/pages/<subdomain>/index.html. Caddy
// reverse-proxies *.pages.mantaui.com to this port. Pages are registered by
// the remote AI's global opencode `serve_page` tool → POST /api/serve-page.
// See src/server/servePage.mjs + docs/.
// eslint-disable-next-line no-unused-vars
const { stop: stopFileServer } = startFileServer();

// Cleanup sweep for expired pages (runs every 5 min).
// eslint-disable-next-line no-unused-vars
const { stop: stopServePageCleanup } = startCleanupPoller();

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
  // Track per-session busy state for the webhook defer-until-idle queue. Cheap,
  // runs for every event; never throws into the pump.
  try {
    webhookEngine.observeEvent(evt);
  } catch (e) {
    console.warn("[webhook] observeEvent failed:", e?.message ?? e);
  }
  if (evt && evt.type === "permission.asked") {
    (async () => {
      try {
        const cfg = await local.configGet();
        if (cfg.chatAutoAllow) {
          const permId = evt.properties?.id;
          // Scope the reply to the permission's session directory. Without
          // this the unscoped reply 404s (PermissionNotFoundError) — the
          // exact failure seen in the bui-server logs — so trust-mode
          // auto-allow never actually allowed the tool and the turn hung.
          const permSessionId = evt.properties?.sessionID;
          if (permId) {
            try {
              await oc.replyPermission({
                requestId: permId,
                reply: "always",
                sessionId: permSessionId,
              });
            } catch (e) {
              console.warn("[opencode-pump] auto-allow failed:", e?.message ?? e);
              // Fall back: forward the event so the user can approve manually.
              bus.publish({ kind: "opencode", payload: evt });
            }
            // Suppress: don't publish when auto-allow succeeded (mirrors desktop continue).
            // No push either — there's nothing for the user to act on.
            return;
          }
        }
      } catch (e) {
        console.warn("[opencode-pump] trust-mode config read failed:", e?.message ?? e);
        // Fall back: forward the event so the user can approve manually.
      }
      // chatAutoAllow is false, or permId was missing, or configGet threw — publish normally.
      bus.publish({ kind: "opencode", payload: evt });
      // The user must approve manually → notify (best-effort, never throws).
      push.firePush(evt);
    })().catch((e) => {
      console.warn("[opencode-pump] unexpected error:", e?.message ?? e);
    });
    return;
  }
  bus.publish({ kind: "opencode", payload: evt });
  // Notify on question/error/done (and track busy→idle). firePush decides
  // what (if anything) to send; permission.asked is handled in the branch
  // above so it isn't double-fired here.
  push.firePush(evt);
});

const PORT = Number(process.env.MANTA_MOBILE_PORT ?? 8787);
const HOST = process.env.MANTA_MOBILE_HOST ?? "0.0.0.0";

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
    const ext = extname(filePath);
    // HTML entry point + manifest are unhashed and must NEVER be cached, or an
    // installed iOS PWA keeps booting a stale bundle that references old asset
    // hashes — features land server-side but the phone never sees them.
    // `no-cache` only forces revalidation, and with no ETag/Last-Modified the
    // WKWebView sometimes serves its snapshot anyway; `no-store` is the
    // belt-and-suspenders that guarantees a fresh fetch on every launch.
    // sw.js is also unhashed AND its updates must propagate immediately —
    // Cloudflare otherwise edge-caches .js for hours, delaying SW updates.
    // Vite's JS/CSS are content-hashed (immutable), so they stay cacheable.
    const base = filePath.split("/").pop() ?? "";
    const noStore =
      ext === ".html" || ext === ".webmanifest" || base === "sw.js";
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": noStore
        ? "no-store, must-revalidate"
        : "no-cache",
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

// Read a request body, capped at 64KB (push subscriptions are ~1KB; the cap
// guards against a runaway/hostile body).
//   parse=true  → JSON.parse the bytes (the common path for /api/* POSTs).
//   parse=false → return the EXACT UTF-8 string (webhook delivery needs the
//                 raw bytes to recompute the HMAC; parsing + re-serializing
//                 would change whitespace).
function readBody(req, { parse = true, limit = 64 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!parse) return resolve(raw);
      const trimmed = raw.trim();
      if (!trimmed) return resolve({});
      try {
        resolve(JSON.parse(trimmed));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// JSON-parse variant. Thin shim kept for the /api/* call sites so each one
// reads as `await readJsonBody(req)` instead of `await readBody(req, { parse: true })`.
const readJsonBody = (req, limit) => readBody(req, { parse: true, limit });
// Raw-bytes variant for webhook HMAC. Thin shim — see `readBody` for why we
// need exact bytes (parsing + re-serializing would change whitespace).
const readRawBody = (req, limit) => readBody(req, { parse: false, limit });

// ---------- tiny HTTP helpers ----------
//
// respondJson — write a JSON response (the most common response shape in this
// file). Pulling it out eliminates a verbatim writeHead+end boilerplate that
// the duplication-gate flagged between /auth/pair and /relay/status
// (10-27 line clones) — every JSON-shaped handler in this file now goes
// through here. Status code + body shape stay identical to the inline
// versions they replace.
//
// requireLoopback — gate a handler on the loopback-direct check used by
// /auth/pair and /relay/status. Returns true (proceed) when the request is
// loopback-direct; on a non-loopback caller it writes the standard 403 and
// returns false, so the caller MUST `return` immediately. The error message
// is passed in so each endpoint can phrase the rejection for its own
// surface (a pairing-code mint vs. a relay-status read need different hints).
// The check itself is unchanged (isLocalDirectRequest in auth.mjs) — this
// is a pure refactor, the loopback gate's semantics are preserved bit-for-bit.
function respondJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function requireLoopback(req, res, errorMessage) {
  if (
    isLocalDirectRequest({
      remoteAddress: req.socket?.remoteAddress,
      headers: req.headers,
    })
  ) {
    return true;
  }
  respondJson(res, 403, { error: errorMessage });
  return false;
}

// ---------- uploads ----------
//
// Layout matches the Electron path (~/.manta-uploads/<session>/<ts>/<file>) so
// the existing cleanup conventions apply. Client sends one request per file
// with raw bytes; filename + batch id come in headers. No multipart parser.

const UPLOAD_ROOT = join(homedir(), UPLOAD_DIRNAME);
// Agent → device download root. The mobile mirror of the desktop outbox pull:
// the device fetches a server-local file the AI dropped here. Constrained to
// this dir so a crafted ?path= can't read arbitrary files off the box.
const OUTBOX_ROOT = join(homedir(), OUTBOX_DIRNAME);
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
    respondJson(res, 400, { error: "bad session" });
    return;
  }
  const rawName = req.headers["x-filename"];
  if (typeof rawName !== "string" || !rawName) {
    respondJson(res, 400, { error: "missing X-Filename" });
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
    respondJson(res, 500, { error: String(e?.message ?? e) });
    return;
  }
  respondJson(res, 200, { path: target });
}

// Agent → device download: stream a file from ~/.manta-outbox/ back to the
// device as a browser download. Path-traversal guarded — the resolved path
// must stay inside OUTBOX_ROOT. Deletes the source on success so the outbox
// stays a one-shot mailbox, matching the desktop pullToDownloads semantics.
async function handleDownload(req, res, url) {
  const raw = url.searchParams.get("path") ?? "";
  const resolved = resolve(raw);
  if (resolved !== OUTBOX_ROOT && !resolved.startsWith(OUTBOX_ROOT + "/")) {
    respondJson(res, 403, { error: "path outside outbox" });
    return;
  }
  try {
    const st = await stat(resolved);
    if (!st.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(st.size),
      "content-disposition": `attachment; filename="${basename(resolved).replace(/"/g, "")}"`,
    });
    await pipeline(createReadStream(resolved), res);
    // Best-effort one-shot cleanup (ignore failure — re-download is harmless).
    await rm(resolved, { force: true }).catch(() => {});
  } catch (e) {
    if (!res.headersSent) {
      respondJson(res, 404, { error: String(e?.message ?? e) });
    } else {
      res.destroy();
    }
  }
}

// ---------- HTTP ----------

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  // The Capacitor shell loads from http://localhost and calls this server
  // cross-origin. Allow any origin (the server is the user's own box) and
  // answer CORS preflight so the mobile WebView's fetch() isn't blocked.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Filename, Authorization",
  );
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  // ---------- Auth pairing handshake (UNAUTHENTICATED, rate-limited) ----------
  // GET  /auth/pair            → {pairing_code, box_id, expiresAt}
  //                              Mint a one-time, ~5-min code. The desktop shows
  //                              it (and encodes box_id+code in a QR for mobile).
  // POST /auth/claim {pairing_code} → {box_token, box_id}
  //                              Exchange a valid code for the bearer token.
  //                              One-time; 403 on wrong/expired/reused code.
  // These are the ONLY pre-token surface, so they're the brute-force target and
  // are throttled by a shared token-bucket limiter (per client IP). See auth.mjs.
  if (path === "/auth/pair" || path === "/auth/claim") {
    const ip =
      (typeof req.headers["x-forwarded-for"] === "string" &&
        req.headers["x-forwarded-for"].split(",")[0].trim()) ||
      req.socket?.remoteAddress ||
      "unknown";
    if (!authRateLimit(ip)) {
      respondJson(res, 429, { error: "rate limited" });
      return;
    }
    try {
      if (req.method === "GET" && path === "/auth/pair") {
        // Minting a code is LOCAL-ONLY (the `bui pair` CLI / SSH forward).
        // Remote-reachable minting would let anyone claim the box_token in two
        // requests. Loopback alone is insufficient — cloudflared proxies public
        // traffic from 127.0.0.1 — so also reject proxy-injected forwarding
        // headers. See isLocalDirectRequest in auth.mjs (reused via
        // requireLoopback below).
        if (
          !requireLoopback(
            req,
            res,
            "pairing codes can only be minted from the box itself (run `bui pair` locally)",
          )
        ) {
          return;
        }
        const result = authEngine.pair();
        respondJson(res, 200, {
          pairing_code: result.pairing_code,
          box_id: result.box_id,
          expiresAt: result.expiresAt,
        });
        return;
      }
      if (req.method === "POST" && path === "/auth/claim") {
        const body = await readJsonBody(req);
        const result = authEngine.claim({ pairing_code: body?.pairing_code });
        if (!result.ok) {
          respondJson(res, result.status ?? 400, { error: result.error });
          return;
        }
        respondJson(res, 200, { box_token: result.box_token, box_id: result.box_id });
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- Relay status (LOOPBACK-ONLY) ----------
  // GET /relay/status → { enabled, connected }
  //
  // Loopback-gated (same check /auth/pair uses) because the answer leaks
  // whether this box has reached the relay — useful intel for an attacker
  // probing the box's outbound posture, and not needed by any remote client.
  // The renderer never calls this; it's consumed by `install.sh` (and any
  // future ops tooling on the box itself).
  //
  //   enabled   — true iff `shouldStartRelayAgent(config)` (config-derived;
  //                absent key → true, see agent/index.mjs)
  //   connected — true iff the agent's `status()` is "connected" right now
  //                (the live WS handshake to relay.mantaui.com succeeded).
  //                "connecting" / "stopped" both collapse to false — install.sh
  //                treats anything-but-connected as "not yet" and re-polls.
  if (req.method === "GET" && path === "/relay/status") {
    if (
      !requireLoopback(req, res, "relay status is loopback-only (run this from the box)")
    ) {
      return;
    }
    const cfg = await local.configGet();
    const enabled = shouldStartRelayAgent(cfg);
    const connected = relayAgent ? relayAgent.status() === "connected" : false;
    respondJson(res, 200, { enabled, connected });
    return;
  }

  // ---------- Auth gate ----------
  // Every route below this line requires a valid box_token, EXCEPT the public
  // webhook delivery leg (/hook/<token>, self-authenticated via its own
  // token+HMAC). /auth/* handled above; OPTIONS handled above. When the gate is
  // disabled (MANTA_AUTH_DISABLED=1) authorize() allows everything.
  {
    // The HTTP /events route can also be consumed as an EventSource (SSE) by a
    // non-WS client, which likewise can't set an Authorization header — so honor
    // the ?token= fallback here too, scoped to /events ONLY. Every other
    // route ignores ?token= and still requires a real Bearer header.
    const gate = authEngine.authorize({
      method: req.method,
      path,
      authorization: authorizationForRequest(
        path,
        req.headers["authorization"],
        url.searchParams.get("token"),
      ),
    });
    if (!gate.ok) {
      res.writeHead(gate.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: gate.error }));
      return;
    }
  }

  // ---------- Auth status (AUTHENTICATED) ----------
  // GET /auth/status → {authenticated:true, box_id, enforced}
  // Reaching here means the gate already passed, so the caller is authenticated
  // (or the gate is disabled). Lets a paired client confirm its token still works.
  if (req.method === "GET" && path === "/auth/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        authenticated: true,
        box_id: authEngine.box_id,
        enforced: authEngine.enforce,
      }),
    );
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
      respondJson(res, 200, projects);
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  if (req.method === "POST" && path === "/api/upload") {
    return handleUpload(req, res, url);
  }

  if (req.method === "GET" && path === "/api/download") {
    return handleDownload(req, res, url);
  }

  // ---------- File peek (HTTP-mode desktop) ----------
  // GET /api/peek?path=<url-encoded-absolute-path>
  // Streams the file bytes back to the caller. The desktop main process
  // fetches this, writes to a temp file, and opens with shell.openPath.
  // Path is resolved against the caller's home dir (~ expansion) and
  // constrained to stay inside it (path-traversal guard). Content-Type is
  // inferred from the file extension; falls back to application/octet-stream.
  if (req.method === "GET" && path === "/api/peek") {
    const raw = url.searchParams.get("path") ?? "";
    if (!raw) {
      respondJson(res, 400, { error: "path is required" });
      return;
    }
    // Expand ~ to $HOME so callers can pass ~/foo/bar.
    let resolved = raw;
    if (resolved === "~") resolved = homedir() + "/";
    else if (resolved.startsWith("~/")) resolved = homedir() + resolved.slice(1);
    else resolved = resolve(resolved);
    // Guard: resolved path must stay inside the user's home dir.
    const home = homedir() + "/";
    if (resolved !== home && !resolved.startsWith(home)) {
      respondJson(res, 403, { error: "path outside home directory" });
      return;
    }
    let s;
    try {
      s = await stat(resolved);
    } catch (e) {
      if (e?.code === "ENOENT") {
        respondJson(res, 404, { error: "not found" });
        return;
      }
      respondJson(res, 500, { error: String(e?.message ?? e) });
      return;
    }
    if (!s.isFile()) {
      respondJson(res, 404, { error: "not a file" });
      return;
    }
    const ext = extname(resolved);
    const contentType = MIME[ext] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": String(s.size),
      "content-disposition": `inline; filename="${basename(resolved).replace(/"/g, "")}"`,
    });
    try {
      await pipeline(createReadStream(resolved), res);
    } catch (e) {
      if (!res.headersSent) {
        respondJson(res, 500, { error: String(e?.message ?? e) });
      } else {
        res.destroy();
      }
    }
    return;
  }

  // ---------- Scheduled prompts ----------
  // POST   /api/schedule        body {cron, prompt, recurring, label, sessionID,
  //                             directory} → {id, cron, recurring} (400 bad cron)
  // GET    /api/schedule?sessionID=  → {jobs:[...]} (filtered when sessionID set)
  // DELETE /api/schedule?id=     → {deleted:bool}
  // Created by the remote AI's global opencode `schedule` tool; listed/deleted
  // by the ScheduledTasksCard UI (via schedule:* window.api channels → rpc.mjs,
  // and by the desktop over its SSH -L 18787 forward). Store mutations publish a
  // `schedule.updated` bus event so the card refetches live.
  if (path === "/api/schedule") {
    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const result = await createJob(
          {
            cron: body?.cron,
            prompt: body?.prompt,
            recurring: body?.recurring,
            label: body?.label,
            sessionID: body?.sessionID,
            directory: body?.directory,
          },
          BUS_PUBLISH_DEPS,
        );
        if (!result.ok) {
          respondJson(res, 400, { error: result.error });
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: result.job.id,
            cron: result.job.cron,
            recurring: result.job.recurring,
          }),
        );
        return;
      }
      if (req.method === "GET") {
        const sessionID = url.searchParams.get("sessionID") || undefined;
        const jobs = await listJobs(sessionID);
        respondJson(res, 200, { jobs });
        return;
      }
      if (req.method === "DELETE") {
        await handleApiDelete(req, url, res, deleteJob);
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- Inbound webhooks (management) ----------
  // POST   /api/webhook        body {label, instructions, sessionID, directory,
  //                            unsigned?} → {id, url, secret} (secret returned ONCE)
  // GET    /api/webhook?sessionID=  → {hooks:[meta...]} (secret + token stripped)
  // DELETE /api/webhook?id=    → {deleted:bool}
  // Created by the remote AI's global opencode `webhook` tool; listed/deleted by
  // the WebhooksCard UI (webhook:* window.api channels → rpc.mjs, and by the
  // desktop over its SSH -L 18787 forward). The PUBLIC delivery route is
  // POST /hook/<token> (separate, below). Store mutations publish a
  // `webhook.updated` bus event so the card refetches live.
  if (path === "/api/webhook") {
    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const result = await createHook(
          {
            label: body?.label,
            instructions: body?.instructions,
            sessionID: body?.sessionID,
            directory: body?.directory,
            unsigned: body?.unsigned,
          },
          BUS_PUBLISH_DEPS,
        );
        if (!result.ok) {
          respondJson(res, 400, { error: result.error });
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ id: result.hook.id, url: result.url, secret: result.secret }),
        );
        return;
      }
      if (req.method === "GET") {
        const sessionID = url.searchParams.get("sessionID") || undefined;
        const hooks = await listHooks(sessionID);
        respondJson(res, 200, { hooks });
        return;
      }
      if (req.method === "DELETE") {
        await handleApiDelete(req, url, res, deleteHook);
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- Inbound webhook delivery (PUBLIC) ----------
  // POST /hook/<token>  — the ONLY externally-reachable bui route. The raw body
  // is read verbatim (HMAC needs the exact bytes); the engine resolves the
  // token, rate-limits, verifies the signature (unless the hook is unsigned),
  // and wakes the session (or defers until idle if it's busy). Status codes:
  // 200 delivered · 202 queued · 400 bad body · 401 bad sig · 404 unknown ·
  // 429 rate-limited. See src/server/webhooks.mjs.
  if (path.startsWith("/hook/")) {
    if (req.method !== "POST") {
      respondJson(res, 405, { error: "method not allowed" });
      return;
    }
    const token = path.slice("/hook/".length);
    try {
      const rawBody = await readRawBody(req);
      const signatureHeader = req.headers["x-bui-signature"];
      const result = await webhookEngine.deliver({
        token,
        rawBody,
        signatureHeader: typeof signatureHeader === "string" ? signatureHeader : "",
      });
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          result.ok ? { ok: true, queued: !!result.queued } : { error: result.error },
        ),
      );
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- Serve page (web page hosting) ----------
  // POST   /api/serve-page        body {subdomain, filePath, ttlHours, sessionID}
  //                             → {ok, url, subdomain, expiresAt} (400 bad request)
  // GET    /api/serve-page        → {pages:[{subdomain, url, expiresAt, ...}]}
  // DELETE /api/serve-page?subdomain= → {deleted:bool}
  // Created by the remote AI's global opencode `serve_page` tool. Source files
  // are copied into ~/.manta/pages/<subdomain>/index.html and served by the
  // in-process file server on 127.0.0.1:20080. Caddy reverse-proxies
  // *.pages.mantaui.com to that port. Pages expire after TTL (default 24h).
  if (path === "/api/serve-page") {
    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const result = await registerPage(
          {
            subdomain: body?.subdomain,
            filePath: body?.filePath,
            ttlHours: body?.ttlHours,
            sessionID: body?.sessionID,
          },
          BUS_PUBLISH_DEPS,
        );
        if (!result.ok) {
          respondJson(res, 400, { error: result.error });
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            url: result.url,
            subdomain: result.subdomain,
            expiresAt: result.expiresAt,
          }),
        );
        return;
      }
      if (req.method === "GET") {
        const pages = listPages();
        respondJson(res, 200, { pages });
        return;
      }
      if (req.method === "DELETE") {
        const subdomain = url.searchParams.get("subdomain");
        if (!subdomain) {
          respondJson(res, 400, { error: "subdomain is required" });
          return;
        }
        const result = await unregisterPage(subdomain, BUS_PUBLISH_DEPS);
        respondJson(res, 200, { deleted: result.deleted });
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- Notify (AI-triggered notification) ----------
  // POST /api/notify  body {message, title?, urgent?, sessionID}
  //                 → {ok:true}  (400 if message missing)
  // Created by the remote AI's global opencode `notify` tool. Runs through the
  // same cross-device router as opencode events (push.mjs fireNotify →
  // routeNotification): desktop OS notification and/or mobile Web Push, with
  // desktop-first escalation when away. See docs/bui-tools-notify.md.
  if (path === "/api/notify") {
    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const message = typeof body?.message === "string" ? body.message.trim() : "";
        if (!message) {
          respondJson(res, 400, { error: "message is required" });
          return;
        }
        await push.fireNotify({
          message,
          title: typeof body?.title === "string" ? body.title : undefined,
          urgent: !!body?.urgent,
          sessionID: body?.sessionID,
        });
        respondJson(res, 200, { ok: true });
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- Peer-session awareness ----------
  // GET  /api/peers?sessionID=&directory=          → {ok, workspace, self, peers:[...]}
  // GET  /api/peers?sessionID=&directory=&target=  → {ok, peer:{...}} (deep inspect)
  // POST /api/peers  body {sessionID, directory, target, message}
  //                  → {ok, workspace, from, to, targetSessionId} (inject a
  //                    message into a peer chat session as a new turn)
  // Lets an opencode session see what OTHER sessions in the same workspace (tmux
  // session) are doing, and message them. Called by the remote AI's global
  // opencode `peers_list` / `peers_inspect` / `peers_message` tools.
  // See src/server/peers.mjs.
  if (path === "/api/peers") {
    try {
      if (req.method === "GET") {
        const sessionID = url.searchParams.get("sessionID") || undefined;
        const directory = url.searchParams.get("directory") || undefined;
        const target = url.searchParams.get("target") || undefined;
        const result = target
          ? await inspectPeer({ sessionID, directory, target })
          : await listPeers({ sessionID, directory });
        if (!result.ok) {
          respondJson(res, 400, { error: result.error });
          return;
        }
        respondJson(res, 200, result);
        return;
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const result = await sendPeerMessage({
          sessionID: body?.sessionID,
          directory: body?.directory,
          target: body?.target,
          message: body?.message,
        });
        if (!result.ok) {
          respondJson(res, 400, { error: result.error });
          return;
        }
        respondJson(res, 200, result);
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- Secrets (secure key→value store) ----------
  // The user stores secrets (a GitHub PAT, an API key…) via the bui UI; the
  // value lives ONLY here on the box and is NEVER returned to the AI. The
  // remote AI's global opencode `secret_list` / `secret_provide` tools read
  // through here. `secret_provide` materializes the value to a 0600 file and
  // returns ONLY the path, so nothing secret reaches the transcript.
  //
  // GET    /api/secrets?sessionID=         → {secrets:[meta...]}  (values stripped;
  //                                          shared + this session's scoped)
  // GET    /api/secrets?all=1              → {secrets:[meta...]}  (everything, for the
  //                                          desktop "all" management view)
  // POST   /api/secrets        body {key, value, scope, sessionID, hint}
  //                                          → {ok, meta}  (400 bad input)  — UI only
  // POST   /api/secrets/provide body {key, sessionID}
  //                                          → {ok, path, key, hint}  — AI tool only
  // DELETE /api/secrets?id=                → {deleted:bool}  — UI only
  // Store mutations publish a `secrets.updated` bus event so the SecretsCard
  // refetches live. See src/server/secrets.mjs.
  if (path === "/api/secrets/provide") {
    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const project = await resolveProjectName({
          sessionID: body?.sessionID,
          directory: body?.directory,
        });
        const result = await provideSecret({
          key: body?.key,
          sessionID: body?.sessionID,
          project,
        });
        if (!result.ok) {
          respondJson(res, 400, { error: result.error });
          return;
        }
        respondJson(res, 200, { path: result.path, key: result.key, hint: result.hint });
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }
  if (path === "/api/secrets") {
    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        // Project scope: use an explicit project (migration script) or resolve
        // it from the caller's session/dir (the "this project" UI option).
        let project = body?.project || null;
        if (body?.scope === "project" && !project) {
          project = await resolveProjectName({
            sessionID: body?.sessionID,
            directory: body?.directory,
          });
        }
        const result = await setSecret(
          {
            key: body?.key,
            value: body?.value,
            scope: body?.scope,
            sessionID: body?.sessionID,
            project,
            hint: body?.hint,
          },
          BUS_PUBLISH_DEPS,
        );
        if (!result.ok) {
          respondJson(res, 400, { error: result.error });
          return;
        }
        respondJson(res, 200, { meta: result.meta });
        return;
      }
      if (req.method === "GET") {
        const sessionID = url.searchParams.get("sessionID") || undefined;
        const directory = url.searchParams.get("directory") || undefined;
        const all = url.searchParams.get("all") === "1";
        const project = all ? null : await resolveProjectName({ sessionID, directory });
        const secrets = listSecrets({ sessionID, project, includeAll: all });
        respondJson(res, 200, { secrets });
        return;
      }
      if (req.method === "DELETE") {
        await handleApiDelete(req, url, res, deleteSecret);
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- Web Push ----------
  // GET  /push/vapid       → { key }            (public VAPID key for subscribe)
  // POST /push/subscribe   body = PushSubscription JSON
  // POST /push/unsubscribe body = { endpoint }
  // POST /push/focus       body = { sessionId, visible }  (suppress "done" for
  //                        the session the user is actively viewing)
  // POST /push/desktop-presence body = { visible }  (desktop Electron heartbeat;
  //                        suppress mobile "done" while active on desktop)
  if (req.method === "GET" && path === "/push/vapid") {
    try {
      const key = await push.getVapidPublic();
      respondJson(res, 200, { key });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }
  if (req.method === "POST" && path.startsWith("/push/")) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      respondJson(res, 400, { error: "bad json" });
      return;
    }
    try {
      let result = { ok: true };
      if (path === "/push/subscribe") {
        result = await push.addSubscription(body);
      } else if (path === "/push/unsubscribe") {
        result = await push.removeSubscription(body?.endpoint);
      } else if (path === "/push/focus") {
        result = push.setFocus({
          sessionId: body?.sessionId,
          visible: body?.visible,
        });
      } else if (path === "/push/desktop-presence") {
        // Desktop (Electron) heartbeat: suppress mobile "done" pushes while
        // the user is active on desktop. Posted on focus/blur/system-idle.
        result = push.setDesktopPresence({ visible: body?.visible });
        console.log(`[push] desktop-presence visible=${!!body?.visible}`);
      } else if (path === "/push/answer") {
        // Direct reply to a Question tool from a notification action button.
        // answers is string[][] (one array per question); the SW sends
        // [[label]] for the single-question quick-reply case.
        await oc.replyQuestion({
          requestId: body?.requestId,
          answers: body?.answers,
          sessionId: body?.sessionId,
        });
        result = { ok: true };
      } else {
        respondJson(res, 404, { error: "not found" });
        return;
      }
      respondJson(res, 200, result);
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // Static fallback for the React + PWA bundle in mobile/www/. All backend
  // routes (/events, /rpc/*, /api/*) were matched above, so this
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

// ---------- WebSocket: /events live stream + /pty terminal bridge ----------
//
// /events — SSE alternative for iOS standalone PWAs, which can't reliably
// receive EventSource. Same bus + envelope as the HTTP /events SSE route.
//
// /pty (BET-158) — binary-safe terminal WS. Bridges to the ephemeral
// pty module (src/server/pty.mjs) the same way Terminal.tsx uses pty:* RPC
// channels, but over a single low-latency WS so the relay can forward raw
// bytes frame-by-frame through STREAM_* mux frames with enc:"b64". Client→
// server is JSON control strings (typed messages: data/resize); server→
// client is raw terminal bytes. The endpoint is gated like the rest of the
// surface; browsers without an Authorization header use ?token=<box_token>.

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Auth gate for WS upgrades. Browsers can't set an Authorization header on a
  // WebSocket, so the token also travels as a ?token= query param; non-browser
  // clients may still use the header. /events + /pty are gated. The ?token=
  // fallback is scoped to those paths ONLY by authorizationForRequest (a
  // header always wins; the query token is honored only on the allowlisted
  // stream paths). Reject with an HTTP 401 handshake response before the
  // upgrade.
  const wsAuth = authEngine.authorize({
    method: "GET",
    path: url.pathname,
    authorization: authorizationForRequest(
      url.pathname,
      req.headers["authorization"],
      url.searchParams.get("token"),
    ),
  });
  if (!wsAuth.ok) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  if (url.pathname === "/events") {
    // Live event stream over WS (SSE alternative for iOS standalone PWAs,
    // which can't reliably receive EventSource). Same bus + envelope.
    wss.handleUpgrade(req, socket, head, (ws) => attachEventsWs(bus, ws));
    return;
  }
  if (url.pathname === "/pty") {
    // Binary-safe terminal bridge (BET-158). Driven by the relay's agent
    // (ws://127.0.0.1:8787/pty?<query>&token=<box_token>) so devices on the
    // other side of the relay get a single muxed WS to their box. Direct
    // clients (no relay) can connect here with either a header bearer or
    // ?token=<box_token>.
    wss.handleUpgrade(req, socket, head, (ws) => attachPtyWs(ws, url));
    return;
  }
  socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`manta listening on http://${HOST}:${PORT}`);

  // Start the box-side relay agent (BET-151 ADR-1 / BET-155). The agent dials
  // OUT to relay.mantaui.com from this box and authenticates with boxAuth, so
  // it MUST be created after ensureAuth() has run (which it has — see above)
  // and AFTER the box server is listening (so the agent's first request proxy
  // can land). Fire-and-forget: the agent's reconnect/backoff loop runs on its
  // own timers and never blocks this path — a slow relay handshake must NOT
  // hold up the HTTP server, and a relay outage must NOT crash the box server.
  //
  // Opt-out: write `"relayEnabled": false` to ~/.manta/config.json
  // (shouldStartRelayAgent() handles the default-on case). No env override —
  // configGet() is the single switch, mirroring how chatAutoAllow is gated.
  //
  // The agent owns its own reconnect/backoff — do NOT add another retry loop.
  // The agent already logs `[relay-agent] connected …` / `tunnel closed;
  // reconnecting`; we only log the one-shot boot decision here.
  local
    .configGet()
    .then((cfg) => {
      if (!shouldStartRelayAgent(cfg)) {
        console.log(
          "[relay-agent] disabled via config (relayEnabled=false); box reachable only via direct ingress.",
        );
        return;
      }
      let agent;
      try {
        agent = createRelayAgent({ localBase: `http://127.0.0.1:${PORT}` });
      } catch (err) {
        console.warn(
          `[relay-agent] could not construct (auth missing?): ${String(err?.message ?? err)}`,
        );
        return;
      }
      relayAgent = agent;
      agent.start().catch((err) => {
        console.warn(
          `[relay-agent] first connect rejected: ${String(err?.message ?? err)}`,
        );
      });
      console.log(
        `[relay-agent] dialing ${agent.boxId.slice(0, 8)}… (relay.mantaui.com)`,
      );
    })
    .catch((err) => {
      console.warn(
        `[relay-agent] could not start (config read failed): ${String(err?.message ?? err)}`,
      );
    });
});
