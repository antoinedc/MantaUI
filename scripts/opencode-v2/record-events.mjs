#!/usr/bin/env node
// Record the raw OpenCode V2 event stream of the corpus scenarios, for the
// stream-interpreter golden corpus (src/server/fixtures/opencodeV2Events/).
//
//   ANTHROPIC_API_KEY=… node scripts/opencode-v2/record-events.mjs [outDir] [scenario…]
//
// Everything runs inside a throwaway SANDBOX (scripts/opencode-v2/sandbox.mjs: a
// fresh HOME + XDG dirs, a random OPENCODE_PASSWORD, a free port — never the
// live opencode on :4096 or manta-server on :8787). The live model is Haiku
// (a few cents per scenario). Output per scenario:
//   <NN-name>.jsonl         one raw `GET /api/event` payload per line, only the
//                           events of the scenario's session (and its children)
//   <NN-name>.timeline.json the session timeline (`GET /api/session/{id}/message`,
//                           chronological) — the input of the transcript mapper tests
// Scrubbed before it is written: the sandbox root becomes /tmp/manta-rec, any
// credential-looking field is dropped, and opaque provider signatures are cut.
//
// The V1 recorder this replaces is scripts/record-opencode-events.mjs.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBinary } from "./fetch-binary.mjs";
import { startSandbox } from "./sandbox.mjs";
import { startFakeMantaServer } from "./fake-manta-server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, "..", "..", "docs", "opencode-plugins-v2", "manta");
const MODEL = { providerID: "anthropic", id: "claude-haiku-4-5" };
const SECRET_KEY_RE = /^(auth|token|accesstoken|refreshtoken|apikey|api_key|secret|password|authorization|credentials?|signature)$/i;
const SCRATCH_PUBLIC = "/tmp/manta-rec";

/** Scrub one value (deep copy). Pure — exported for tests. */
export function scrub(value, { root, home = process.env.HOME ?? "" }) {
  const rep = (s, needle, to) => (needle ? s.split(needle).join(to) : s);
  const walk = (v) => {
    if (typeof v === "string") return rep(rep(v, root, SCRATCH_PUBLIC), home, "/home/user").replace(/\/home\/dev\b/g, "/home/user");
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (SECRET_KEY_RE.test(k)) continue;
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

/** Every session id an event refers to (for the ownership filter). Pure. */
export function eventSessionIds(ev) {
  const d = ev?.data ?? {};
  const ids = new Set();
  const add = (x) => typeof x === "string" && x && ids.add(x);
  add(d.sessionID);
  add(d.form?.sessionID);
  add(d.info?.metadata?.sessionID);
  return ids;
}

const SCENARIOS = [
  { name: "01-plain-text", prompt: "Reply with exactly these words: The corpus says hello." },
  {
    name: "02-slow-bash",
    prompt: "Run exactly this shell command and nothing else: for i in 1 2 3 4 5; do echo line$i; sleep 1; done . Then reply with the single word done.",
  },
  {
    name: "03-edit-todo",
    prompt:
      "Do these in order: 1) call todo_write with 2 todos (read notes.txt: in_progress, edit it: pending). 2) read notes.txt with the read tool. 3) use the edit tool to change 'beta' to 'BETA' in notes.txt. 4) call todo_write again marking both completed. Then reply done.",
  },
  {
    name: "04-task-subagent",
    prompt: "Use the subagent tool (agent: explore) to find which file defines the function `greet`, then tell me the file name.",
  },
  { name: "05-question", prompt: "Use the question tool to ask me which colour I prefer (options: Red, Green, Blue), then tell me the colour I picked.", answer: true },
  {
    name: "06-abort",
    prompt: "Run exactly this shell command and nothing else: for i in 1 2 3 4 5 6 7 8 9 10; do echo tick$i; sleep 1; done . Then reply with the single word done.",
    interruptAfterToolMs: 2500,
  },
  { name: "07-command-compact", command: "rec-cmd", prompt: "please", compact: true },
  {
    name: "08-permission",
    prompt: "Run exactly this shell command and nothing else: echo permission-ok . Then reply with the single word done.",
    permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    decision: "once",
  },
];

async function main() {
  const outDir = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "src/server/fixtures/opencodeV2Events";
  const only = new Set(process.argv.slice(3));
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("set ANTHROPIC_API_KEY (by reference: $(cat …))");
  mkdirSync(outDir, { recursive: true });

  const binary = await ensureBinary({ log: (m) => console.error(`[binary] ${m}`) });
  const fake = await startFakeMantaServer({ token: "ab12".repeat(8) });
  const sb = await startSandbox({
    binary,
    plugins: [PLUGIN_DIR], // todo_write
    dirs: ["repo"],
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, MANTA_SERVER_URL: fake.url, MANTA_BOX_TOKEN: "ab12".repeat(8) },
    config: {
      command: { "rec-cmd": { template: "Reply with exactly these words and nothing else: command ran ok. Extra: $ARGUMENTS", description: "recording command" } },
    },
  });
  const root = sb.root;
  const api = async (method, path, body) => {
    const r = await fetch(sb.url + path, {
      method,
      headers: { authorization: sb.auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${t.slice(0, 300)}`);
    return t ? JSON.parse(t) : undefined;
  };

  const repo = sb.dirs.repo;
  writeFileSync(join(repo, "notes.txt"), "alpha\nbeta\ngamma\n");
  writeFileSync(join(repo, "greet.js"), "export function greet(name) {\n  return 'hello ' + name;\n}\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=r@x.invalid", "-c", "user.name=r", "add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=r@x.invalid", "-c", "user.name=r", "commit", "-qm", "init"], { cwd: repo });

  try {
    for (const sc of SCENARIOS) {
      if (only.size && !only.has(sc.name)) continue;
      console.error(`[rec] ${sc.name}`);
      const owned = new Set();
      const shells = new Set();
      const kept = [];
      const all = [];
      const ac = new AbortController();
      const stream = (async () => {
        const res = await fetch(sb.url + "/api/event", { signal: ac.signal, headers: { authorization: sb.auth, accept: "text/event-stream" } });
        const dec = new TextDecoder();
        let buf = "";
        try {
          for await (const ch of res.body) {
            buf += dec.decode(ch, { stream: true });
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const frame = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
              if (!data) continue;
              let ev;
              try { ev = JSON.parse(data); } catch { continue; }
              all.push(ev);
              // learn children before the ownership check
              if (ev.type === "session.created" && owned.has(ev.data?.parentID)) owned.add(ev.data.sessionID);
              if (ev.type === "shell.created" && owned.has(ev.data?.info?.metadata?.sessionID)) shells.add(ev.data.info.id);
              const mine = [...eventSessionIds(ev)].some((x) => owned.has(x)) || (ev.type?.startsWith("shell.") && shells.has(ev.data?.id));
              if (mine) kept.push(ev);
            }
          }
        } catch { /* aborted */ }
      })();
      await new Promise((r) => setTimeout(r, 400));

      const body = { location: { directory: repo }, model: MODEL, ...(sc.permissions ? { permissions: sc.permissions } : {}) };
      const sid = (await api("POST", "/api/session", body)).data.id;
      owned.add(sid);
      await new Promise((r) => setTimeout(r, 200));
      if (sc.command) await api("POST", `/api/session/${sid}/command`, { name: sc.command, text: sc.prompt });
      else await api("POST", `/api/session/${sid}/prompt`, { text: sc.prompt });

      const t0 = Date.now();
      const done = new Set();
      let toolAt = null;
      let interrupted = false;
      const ended = () => all.some((e) => e.data?.sessionID === sid && /^session\.execution\.(succeeded|failed|interrupted)$/.test(e.type));
      while (Date.now() - t0 < 120_000) {
        await new Promise((r) => setTimeout(r, 250));
        for (const e of all) {
          if (done.has(e.id)) continue;
          if (e.type === "form.created" && sc.answer) {
            done.add(e.id);
            const f = e.data.form;
            const answer = Object.fromEntries(f.fields.map((x) => [x.key, x.options?.[0]?.value ?? "ok"]));
            await api("POST", `/api/session/${f.sessionID}/form/${f.id}/reply`, { answer });
          }
          if (e.type === "permission.asked" && sc.decision) {
            done.add(e.id);
            await api("POST", `/api/session/${e.data.sessionID}/permission/${e.data.id}/reply`, { decision: sc.decision });
          }
          if (e.type === "session.tool.progress" && e.data.sessionID === sid && toolAt == null) toolAt = Date.now();
        }
        if (sc.interruptAfterToolMs != null && !interrupted && toolAt != null && Date.now() - toolAt >= sc.interruptAfterToolMs) {
          interrupted = true;
          await api("POST", `/api/session/${sid}/interrupt?resume=false`);
        }
        if (ended()) {
          await new Promise((r) => setTimeout(r, 700));
          break;
        }
      }
      if (!ended()) throw new Error(`${sc.name}: the turn never finished`);
      if (sc.compact) {
        await api("POST", `/api/session/${sid}/compact`, {});
        const c0 = Date.now();
        while (Date.now() - c0 < 60_000 && !all.some((e) => e.type === "session.compaction.ended")) await new Promise((r) => setTimeout(r, 300));
        await new Promise((r) => setTimeout(r, 1200));
      }
      ac.abort();
      await stream;

      const timeline = (await api("GET", `/api/session/${sid}/message?order=asc&limit=200`)).data;
      const opts = { root };
      writeFileSync(join(outDir, `${sc.name}.jsonl`), kept.map((e) => JSON.stringify(scrub(e, opts))).join("\n") + "\n");
      writeFileSync(join(outDir, `${sc.name}.timeline.json`), JSON.stringify(scrub(timeline, opts), null, 1) + "\n");
      console.error(`[rec]   ${kept.length} events, ${timeline.length} timeline records`);
    }
  } finally {
    await sb.stop();
    await fake.close?.();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0), (e) => {
    console.error(e?.stack ?? e);
    process.exit(1);
  });
}
