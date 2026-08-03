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
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.FIXTURE_PORT || 8787);
const HOST = "127.0.0.1";

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
      return MESSAGES;
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
      return { pinnedWindows: [], hapticsEnabled: true };
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
      const result = rpc(channel, args);
      console.error(`[rpc] ${channel} args=${JSON.stringify(args)} -> ${JSON.stringify(result).slice(0, 80)}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(rpcResult(result));
    });
    return;
  }

  // /events is a WebSocket the app tries to attach for live streaming. The
  // capture surfaces (sheet + cards) are fed entirely by the HTTP RPC above,
  // so we accept-and-close rather than implement WS framing. The app treats
  // the drop as a disconnected stream and keeps rendering from RPC.
  if (pathname === "/events") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("fixture (no event stream)");
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, HOST, () => {
  console.log(`fixture-box listening on http://${HOST}:${PORT}`);
  console.log(`FIXTURE_CODE=${pairingCode}`);
  console.log(`FIXTURE_BOX_ID=${BOX_ID}`);
  console.log(`FIXTURE_TOKEN=${BOX_TOKEN}`);
});
