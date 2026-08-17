// manta capture-fixture box — a self-contained local stand-in for the box
// server, built ONLY to drive the native iOS app through the BET-627 overflow
// surface on the simulator so a deterministic screen store can be captured.
//
// It is capture infrastructure, not a product feature. It implements exactly
// the wire the native app speaks (S2 pairing claim + the `rpc/<channel>` JSON
// envelope + POST /api/upload) and returns fixture data: one project with one
// chat window, a small transcript, one scheduled job (so the overflow sheet's
// live-count badge is non-zero) and one secret (metadata only). Nothing here
// talks to tmux, opencode, the gateway or any real box.
//
// The app connects over the simulator's own loopback, so start it with
//   node mobile/native/capture-fixture/fixture-box.mjs
// it binds 127.0.0.1:8787 (same port the real box uses locally) and prints a
// fresh 6-digit pairing code on each start. Pair the app with that code and
// server URL http://127.0.0.1:8787, then the session list / chat / overflow
// sheet render from these fixtures.

import http from "node:http";
import crypto from "node:crypto";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.FIXTURE_PORT || 8787);
const HOST = "127.0.0.1";

// BET-630: how long the `opencode:messages` RPC sleeps before answering. The
// refetch capture needs the app's `refreshing` window (which drives the ambient
// composer-hairline sweep) to last long enough to be caught, so the capture
// runs set this to a few seconds. The mid-turn capture needs it fast so the
// chat opens promptly.
const MSGS_DELAY_MS = Number(process.env.FIXTURE_MSGS_DELAY_MS || 0);

const SESSION_ID = "session-1";
const PROJECT = "Demo";
const CWD = `/Users/${process.env.USER || "demo"}/demo`;

// One-time pairing code, fresh per server start (mirrors the real box's
// short-lived single-use code). Overridable with FIXTURE_CODE so a capture
// run can pin a known code and type it deterministically.
const pairingCode = process.env.FIXTURE_CODE || String(Math.floor(100000 + Math.random() * 900000));
const BOX_ID = randomBytes(16).toString("hex");
const BOX_TOKEN = randomBytes(16).toString("hex");

const now = Math.floor(Date.now() / 1000);

const PROJECTS = [
  {
    tmuxSession: PROJECT,
    defaultCwd: CWD,
    attached: false,
    mantaOwned: true,
    windows: [
      {
        index: 0,
        name: "Chat",
        active: true,
        paneCurrentPath: CWD,
        opencodeSessionId: SESSION_ID,
      },
    ],
  },
];

const MESSAGES = [
  {
    info: {
      id: "m1",
      sessionID: SESSION_ID,
      role: "user",
      time: { created: now },
    },
    parts: [
      {
        type: "text",
        id: "p1",
        messageID: "m1",
        text: "Can this sheet show attach, a live scheduled-task count and secrets?",
      },
    ],
  },
  {
    info: {
      id: "m2",
      sessionID: SESSION_ID,
      role: "assistant",
      time: { created: now, completed: now + 2 },
    },
    parts: [
      {
        type: "text",
        id: "p2",
        messageID: "m2",
        text: "Yes — tap the ellipsis in the header. Scheduled tasks carries a live count, and secrets lists names without ever sending a value to the phone.",
      },
    ],
  },
];

const SCHEDULES = [
  {
    id: "sch-1",
    cron: "0 9 * * *",
    prompt: "Give a one-paragraph standup summary of this session.",
    recurring: true,
    label: "Morning standup",
    sessionID: SESSION_ID,
    directory: CWD,
    createdAt: now,
    lastFiredMinute: "9:00",
  },
];

const SECRETS = [
  {
    id: "sec-1",
    key: "GITHUB_TOKEN",
    scope: "session",
    sessionID: SESSION_ID,
    project: PROJECT,
    hint: "Used for gh pr",
    hasValue: true,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "sec-2",
    key: "DEPLOY_KEY",
    scope: "shared",
    hint: "Release signing",
    hasValue: true,
    createdAt: now,
    updatedAt: now,
  },
];

function rpcResult(result) {
  return JSON.stringify({ result: result === undefined ? null : result });
}

function rpc(channel, args) {
  switch (channel) {
    case "tmux:list":
      return PROJECTS;
    case "opencode:messages":
      return new Promise((resolve) => {
        setTimeout(() => resolve(MESSAGES), MSGS_DELAY_MS);
      });
    case "opencode:list-sessions":
      return [
        {
          id: SESSION_ID,
          slug: "chat",
          title: "Chat",
          model: { id: "claude-sonnet-4-6", providerID: "anthropic" },
          cost: 0.312,
          tokens: { input: 8123, output: 342 },
          time: { created: now, updated: now },
        },
      ];
    case "schedule:list":
      return SCHEDULES;
    case "secrets:list":
      return SECRETS;
    case "config:get":
      // BET-1028: expose a Groq key so the composer's mic button is available
      // (it is hidden otherwise — the mic gate reads `groqApiKey` from here).
      return { pinnedWindows: [], hapticsEnabled: true, groqApiKey: "fixture-groq-key" };
    case "config:update":
      return {};
    case "opencode:models":
      return [];
    case "opencode:default-model":
      return null;
    case "opencode:permissions":
      return [];
    case "opencode:questions":
      return [];
    case "opencode:vcs-branch":
      // NOTE: the app's `MantaAPIClient.decode` crashes (uncaught
      // NSJSONSerialization dataWithJSONObject: exception) when asked to decode
      // a top-level String — which is what a real git branch name produces. To
      // let the capture reach the overflow sheet we return null (no branch),
      // matching what the box reports for a folder that is not a git repo.
      return null;
    case "git:list-worktrees":
      return [];
    case "fs:list-dirs":
      return [];
    case "voice:transcribe":
      return null;
    case "voice:classify-command":
      return null;
    default:
      // No-op channels (prompt, replies, abort, compact, clear, fork, delete,
      // tmux mutations, …) — the surfaces we capture never rely on their reply.
      return null;
  }
}

const server = http.createServer((req, res) => {
  console.error(`[req] ${req.method} ${req.url}`);
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const { pathname } = url;

  // S2 pairing — the app claims after a human enters the code + server URL.
  if (pathname === "/auth/pair" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: pairingCode }));
    return;
  }

  if (pathname === "/auth/claim" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch {
        /* ignore */
      }
      const code = payload.pairing_code || payload.code;
      if (code === pairingCode) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            box_token: BOX_TOKEN,
            box_id: BOX_ID,
            device_id: "fixture-device",
          })
        );
      } else {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "wrong code" }));
      }
    });
    return;
  }

  if (pathname === "/api/upload" && req.method === "POST") {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: `${CWD}/uploads/fixture.bin` }));
    });
    return;
  }

  if (pathname === "/push/register-apns" && req.method === "POST") {
    req.resume();
    req.on("end", () => res.writeHead(200).end());
    return;
  }

  if (pathname === "/api/health" || pathname === "/health" || pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, fixture: true }));
    return;
  }

  // JSON-RPC envelope: POST /rpc/<channel> with {"args": [...]}.
  if (pathname.startsWith("/rpc/") && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let args = [];
      try {
        args = JSON.parse(body).args || [];
      } catch {
        /* ignore */
      }
      const channel = decodeURIComponent(pathname.slice("/rpc/".length));
      Promise.resolve(rpc(channel, args)).then((result) => {
        console.error(`[rpc] ${channel} args=${JSON.stringify(args)} -> ${JSON.stringify(result).slice(0, 80)}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(rpcResult(result));
      });
    });
    return;
  }

  // Post-a-POST direct control channel — the capture driver hits this to drive
  // the app's live-stream states deterministically (BET-630). A real box would
  // emit these as interpreted stream frames; this lets a UI test trigger the
  // exact running / refetch transition instead of gambling on real model output.
  if (pathname === "/__control" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let action = "";
      try {
        action = JSON.parse(body).action || "";
      } catch {
        /* ignore */
      }
      console.error(`[control] ${action}`);
      switch (action) {
        case "baseline": // first frame: idle, so the next transition is not the first snapshot
          wsSend(wsFrame("running", { running: false }));
          wsSend(wsFrame("turnComplete", { complete: false, running: false }));
          break;
        case "start-turn": // running row appears above the composer (BET-630 D1)
          wsSend(wsFrame("running", { running: true }));
          break;
        case "end-turn": // finished: running=false + turnComplete -> canonical refetch (sweep)
          wsSend(wsFrame("running", { running: false }));
          wsSend(wsFrame("turnComplete", { complete: true, running: false }));
          break;
        case "context": // BET-889: emit a known context/cache reading (what a
          // real box's `message.updated` interpreter publishes). Lets a UI test
          // verify the iOS context strip renders deterministically on-device.
          wsSend(wsFrame("context", {
            freshInput: 4200,
            cacheRead: 50800,
            cacheWrite: 0,
            totalInput: 55000,
            pct: 55,
            segments: [],
          }));
          wsSend(wsFrame("cache", {
            isStale: true,
            idleMs: 1_800_000,
            staleTokens: 12400,
            ttlMs: 3_600_000,
          }));
          break;
        default:
          break;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, action }));
    });
    return;
  }

  // /events is a WebSocket the app attaches for live streaming. It is a real
  // upgrade (so the app's stream reaches `connected` and drop→connect can
  // resync) but carries no frames unless the /__control channel asks it to
  // (BET-630 keeps the running row / refetch sweep fully deterministic).
  if (pathname === "/events") {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("upgrade required");
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

function wsFrame(sub, payload) {
  return { kind: "stream", sub, sessionId: SESSION_ID, payload };
}

function wsSend(obj) {
  const sock = currentSocket;
  if (!sock || sock.destroyed) return;
  const payload = Buffer.from(JSON.stringify(obj));
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  } else {
    const b = Buffer.alloc(10);
    b[0] = 0x81;
    b[1] = 127;
    b.writeUInt32BE(len, 6);
    header = b;
  }
  sock.write(Buffer.concat([header, payload]));
}

// Minimal RFC 6455 server handshake + server→client text framing (no masking
// needed on the server→client leg). Enough for the app's URLSessionWebSocket
// client to attach; we never have to decode a client frame.
server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname !== "/events") {
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " +
      accept +
      "\r\n\r\n"
  );
  currentSocket = socket;
  socket.on("close", () => {
    if (currentSocket === socket) currentSocket = null;
  });
  socket.on("error", () => {});
});

let currentSocket = null;

server.listen(PORT, HOST, () => {
  console.log(`fixture-box listening on http://${HOST}:${PORT}`);
  console.log(`FIXTURE_CODE=${pairingCode}`);
  console.log(`FIXTURE_BOX_ID=${BOX_ID}`);
  console.log(`FIXTURE_TOKEN=${BOX_TOKEN}`);
});
