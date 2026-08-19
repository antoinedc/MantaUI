#!/usr/bin/env node
// manta-probe — talk to the manta box on THIS machine (alphaclaw) from an agent
// session: create a chat session, send a prompt, read the reply, mint a pairing
// code for a phone/simulator.
//
// WHY THIS EXISTS
// Implementer agents kept failing to verify anything live: the RPC body shape,
// the auth header, the async prompt + poll loop and the loopback-only pairing
// endpoint are each easy to get subtly wrong, and a half-working curl looks
// exactly like a broken feature. This is the one supported way in.
//
// THE MODEL IS NOT A CHOICE. Every prompt runs on voska/default. There is no
// flag to change it and no env var to override it — a constraint that is
// enforced cannot be forgotten, and this box's other providers are metered.
//
// THE TOKEN NEVER LEAVES THE BOX. It is read from ~/.manta/auth.json inside
// this process and used only as an Authorization header. It is never printed,
// never logged, never placed in argv. Callers on other machines invoke this
// over ssh so the value is substituted remotely:
//     ssh dev@alphaclaw manta-probe ask "hello"

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BOX = process.env.MANTA_PROBE_BOX || "http://127.0.0.1:8787";
const MODEL = { providerID: "voska", modelID: "default" }; // deliberately const
const AUTH = path.join(os.homedir(), ".manta", "auth.json");
const SCRATCH = path.join(os.homedir(), ".manta-probe");
const PROJECT = "manta-probe";

function die(msg, code = 1) {
  process.stderr.write(`manta-probe: ${msg}\n`);
  process.exit(code);
}

function auth() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(AUTH, "utf8"));
  } catch (e) {
    die(`cannot read ${AUTH} (${e.code || e.message}). Are you on the box, as the right user?`);
  }
  if (!raw.box_token) die(`${AUTH} has no box_token — this box is not paired/initialised.`);
  return { token: raw.box_token, host: raw.gateway_host || null };
}

async function rpc(channel, args) {
  const { token } = auth();
  let res;
  try {
    res = await fetch(`${BOX}/rpc/${channel}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ args }),
    });
  } catch (e) {
    die(`cannot reach manta-server at ${BOX} (${e.cause?.code || e.message}).\n` +
        `  Check it is up:  systemctl --user status manta-server`);
  }
  if (res.status === 401) die("unauthorized — the box token was rejected. Is ~/.manta/auth.json current?");
  const text = await res.text();
  if (!res.ok) die(`${channel} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    die(`${channel} returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (body && body.error) die(`${channel} error: ${JSON.stringify(body.error).slice(0, 300)}`);
  return body && "result" in body ? body.result : body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function projects() {
  return (await rpc("tmux:list", [])) || [];
}

// Every probe session is a window in ONE tmux project so they are trivially
// findable and trivially cleaned up, and never pollute a real project.
async function newSession(label) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const name = label || `probe-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
  const existing = (await projects()).find((p) => p.tmuxSession === PROJECT);
  const res = existing
    ? await rpc("tmux:new-window", [
        { sessionName: PROJECT, windowName: name, cwd: SCRATCH, chatMode: true },
      ])
    : await rpc("tmux:new-session", [
        { name: PROJECT, windowName: name, cwd: SCRATCH, createDir: true, chatMode: true },
      ]);
  const sid = res && res.sessionId;
  if (!sid) die(`session created but no opencode session id came back: ${JSON.stringify(res).slice(0, 200)}`);
  return sid;
}

// The prompt endpoint is ASYNC: it returns null immediately and the answer
// arrives on the transcript. Anything that "sends a prompt" must then poll.
async function sendPrompt(sessionId, text) {
  await rpc("opencode:prompt", [{ sessionId, text, model: MODEL }]);
}

async function readReply(sessionId, { timeoutMs = 180000, quiet = false } = {}) {
  const started = Date.now();
  let lastLen = -1;
  while (Date.now() - started < timeoutMs) {
    await sleep(2000);
    const msgs = (await rpc("opencode:messages", [sessionId, {}])) || [];
    const assistants = msgs.filter((m) => m.info && m.info.role === "assistant");
    if (!assistants.length) continue;
    const last = assistants[assistants.length - 1];
    const text = (last.parts || [])
      .filter((p) => p.type === "text" && !p.ignored && !p.synthetic)
      .map((p) => p.text || "")
      .join("")
      .trim();
    const done = Boolean(last.info.time && last.info.time.completed);
    if (!quiet && text.length !== lastLen) {
      process.stderr.write(`  … ${done ? "done" : "running"} (${text.length} chars)\n`);
      lastLen = text.length;
    }
    if (done) return { text, model: `${last.info.providerID || "?"}/${last.info.modelID || "?"}` };
  }
  die(`no completed reply within ${Math.round(timeoutMs / 1000)}s — the turn may still be running. ` +
      `Inspect with:  manta-probe messages ${sessionId}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    // The one-shot most callers want: fresh session, prompt, wait, print reply.
    case "ask": {
      const text = rest.filter((a) => !a.startsWith("--")).join(" ");
      if (!text) die('usage: manta-probe ask "your prompt"  [--keep]');
      const keep = rest.includes("--keep");
      const sid = await newSession();
      process.stderr.write(`session ${sid}\n`);
      await sendPrompt(sid, text);
      const reply = await readReply(sid);
      process.stdout.write(reply.text + "\n");
      process.stderr.write(`model ${reply.model}\n`);
      if (!keep) await rpc("tmux:kill-session", [PROJECT]).catch(() => {});
      else process.stderr.write(`kept — clean up with:  manta-probe clean\n`);
      return;
    }

    case "new": {
      const sid = await newSession(rest[0]);
      process.stdout.write(sid + "\n");
      return;
    }

    case "prompt": {
      const [sid, ...words] = rest;
      const text = words.join(" ");
      if (!sid || !text) die('usage: manta-probe prompt <sessionId> "your prompt"');
      await sendPrompt(sid, text);
      const reply = await readReply(sid);
      process.stdout.write(reply.text + "\n");
      return;
    }

    case "messages": {
      const sid = rest[0];
      if (!sid) die("usage: manta-probe messages <sessionId>");
      const msgs = (await rpc("opencode:messages", [sid, {}])) || [];
      for (const m of msgs) {
        const role = m.info?.role || "?";
        const body = (m.parts || [])
          .map((p) => (p.type === "text" ? p.text : `[${p.type}${p.tool ? ":" + p.tool : ""}]`))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        process.stdout.write(`${role.padEnd(9)} ${body.slice(0, 300)}\n`);
      }
      return;
    }

    // Pair a phone or a Simulator. /auth/pair is loopback-only BY DESIGN, so
    // this must run ON the box — over ssh from a Mac, never against the public
    // hostname (which correctly answers 403).
    case "pair": {
      const { host } = auth();
      const res = await fetch(`${BOX}/auth/pair`).catch((e) => die(`cannot reach ${BOX} (${e.message})`));
      const body = await res.json().catch(() => die("pairing endpoint returned non-JSON"));
      if (!body.pairing_code) die(`no pairing code in response: ${JSON.stringify(body).slice(0, 200)}`);
      const url = host ? `https://${host}` : "(no gateway_host on this box)";
      process.stdout.write(`code   ${body.pairing_code}\nserver ${url}\n`);
      process.stderr.write("codes expire in minutes — use it immediately\n");
      return;
    }

    // The ZERO-TYPING pairing path. The app registers the `manta://` scheme and
    // auto-CLAIMS a deep-linked payload (MantaAppRoot.onOpenURL →
    // MantaPairingRouter.route → flow.receive → startLinking) — there is no
    // "Continue" to tap and no code to type. Opening this URL on a booted
    // Simulator pairs it outright.
    //
    // NOTE the `server=` param is deliberately NOT emitted: the app REFUSES a
    // non-private server URL (MantaPairing.isPrivateServerURL), and this box is
    // reached over its public gateway hostname. With `box=` alone the app
    // derives https://<boxId>.boxes.mantaui.com itself, which is what we want.
    case "pair-url": {
      const res = await fetch(`${BOX}/auth/pair`).catch((e) => die(`cannot reach ${BOX} (${e.message})`));
      const body = await res.json().catch(() => die("pairing endpoint returned non-JSON"));
      if (!body.pairing_code || !body.box_id) {
        die(`unexpected pairing response: ${JSON.stringify(body).slice(0, 200)}`);
      }
      const url = `manta://pair?box=${body.box_id}&code=${body.pairing_code}`;
      if (rest.includes("--simctl")) {
        process.stdout.write(`xcrun simctl openurl booted '${url}'\n`);
      } else {
        process.stdout.write(url + "\n");
      }
      process.stderr.write("expires in minutes — open it now\n");
      return;
    }

    case "server": {
      const { host } = auth();
      process.stdout.write((host ? `https://${host}` : "") + "\n");
      return;
    }

    case "list": {
      const p = (await projects()).find((x) => x.tmuxSession === PROJECT);
      if (!p) return process.stdout.write("no probe sessions\n");
      for (const w of p.windows) {
        process.stdout.write(`${String(w.index).padEnd(4)} ${(w.name || "").padEnd(24)} ${w.opencodeSessionId || "-"}\n`);
      }
      return;
    }

    case "clean": {
      const p = (await projects()).find((x) => x.tmuxSession === PROJECT);
      if (!p) return process.stdout.write("nothing to clean\n");
      await rpc("tmux:kill-session", [PROJECT]);
      process.stdout.write(`removed ${p.windows.length} probe session(s)\n`);
      return;
    }

    default:
      process.stdout.write(
        [
          "manta-probe — live box access for agent verification. Model is always voska/default.",
          "",
          '  ask "<prompt>" [--keep]   fresh session, prompt, wait, print the reply',
          "  new [label]               create a chat session, print its id",
          '  prompt <sid> "<text>"     prompt an existing session, print the reply',
          "  messages <sid>            dump a session transcript",
          "  pair-url [--simctl]       ONE-STEP pairing: a manta:// link the app auto-claims",
          "  pair                      mint a raw code + server URL (manual entry fallback)",
          "  server                    print this box's public server URL",
          "  list                      list probe sessions",
          "  clean                     delete every probe session",
          "",
          "From a Mac:  ssh dev@alphaclaw manta-probe ask \"hello\"",
        ].join("\n") + "\n",
      );
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => die(e && e.stack ? e.stack.split("\n")[0] : String(e)));
