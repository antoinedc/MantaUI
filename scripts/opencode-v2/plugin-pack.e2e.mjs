#!/usr/bin/env node
// End-to-end proof of the `manta` V2 plugin on a REAL, pinned OpenCode V2 binary.
//
//   npm run test:opencode-v2          (needs ANTHROPIC_API_KEY; skips otherwise)
//
// What it does, all inside a throwaway sandbox (fresh HOME + XDG dirs, random
// OPENCODE_PASSWORD, free port — see sandbox.mjs; the live opencode on :4096 and
// manta-server on :8787 are never touched):
//   1. fetches/caches opencode 2.0.30 (fetch-binary.mjs, integrity-checked)
//   2. starts a fake manta-server that records every request
//   3. installs docs/opencode-plugins-v2/manta as a global plugin
//   4. drives live Haiku turns that call schedule_list, notify, todo_write,
//      secrets_list / schedule_create (directory-dependent), and a failing tool
//   5. asserts the plugin loaded, all 45 tools registered, and that the right
//      sessionID / directory reached the fake server for sessions created in
//      different directories (this is the directory-resolution proof).
//
// Spend: ~5 short Haiku turns, a few thousand tokens each — a few cents per run
// (hard cap asserted below: < $0.50).

import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBinary } from "./fetch-binary.mjs";
import { startSandbox } from "./sandbox.mjs";
import { startFakeMantaServer } from "./fake-manta-server.mjs";
import { parseV1Inventory } from "./v1-tools.mjs";
import { OPENCODE_V2_VERSION } from "./version.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, "..", "..", "docs", "opencode-plugins-v2", "manta");
const PROBE = join(HERE, "harness-probe-plugin.ts");
const MODEL = { providerID: "anthropic", id: "claude-haiku-4-5" };
const SPEND_CAP_USD = 0.5;
const TOKEN = "ab12".repeat(8); // 32 hex chars, built so no key-shaped literal sits in the source

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("SKIP test:opencode-v2 — set ANTHROPIC_API_KEY to run the live V2 plugin-pack e2e.");
  process.exit(0);
}

// ---------------------------------------------------------------- reporting
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${!ok && detail ? `\n       ${detail}` : ""}`);
}
const j = (v) => JSON.stringify(v) ?? "undefined";

// -------------------------------------------------------------- API helpers
let sb;
async function api(method, path, body) {
  const res = await fetch(sb.url + path, {
    method,
    headers: { authorization: sb.auth, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return data;
}

async function createSession(directory) {
  const r = await api("POST", "/api/session", { location: { directory }, model: MODEL });
  return r.data.id;
}

/** Send a prompt and wait for the turn to finish; return the session's messages. */
async function runTurn(sessionID, text) {
  await api("POST", `/api/session/${sessionID}/prompt`, { text });
  await Promise.race([
    api("POST", `/api/experimental/session/${sessionID}/wait`),
    new Promise((_, rej) => setTimeout(() => rej(new Error("turn timed out after 150s")), 150_000)),
  ]);
  const r = await api("GET", `/api/session/${sessionID}/message?limit=100`);
  return r.data ?? r;
}

/**
 * Every tool part in a message list, V2 shape:
 * { type:"tool", name, state:{ status, input, content:[{type:"text",text}] } }.
 */
function toolParts(messages) {
  return (messages ?? [])
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((p) => p.type === "tool");
}
const resultText = (part) => (part?.state?.content ?? []).map((c) => c.text ?? "").join("");

async function sessionCost(id) {
  return (await api("GET", `/api/session/${id}`)).data.cost ?? 0;
}

// ----------------------------------------------------------------- the run
const scratch = mkdtempSync(join(tmpdir(), "manta-v2-e2e-"));
let fake;
try {
  console.log(`opencode V2 ${OPENCODE_V2_VERSION} — plugin-pack e2e`);
  const binary = await ensureBinary({ log: (m) => console.log(`[binary] ${m}`) });

  fake = await startFakeMantaServer({ token: TOKEN });
  const probeFile = join(scratch, "probe.jsonl");
  sb = await startSandbox({
    binary,
    plugins: [PLUGIN_DIR, { src: PROBE, name: "zz-harness-probe.ts" }],
    dirs: ["a", "b", "repo"],
    env: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      MANTA_SERVER_URL: fake.url,
      MANTA_BOX_TOKEN: TOKEN,
      MANTA_PROBE_FILE: probeFile,
    },
  });
  console.log(`[sandbox] ${sb.url} (root ${sb.root})`);

  // A git repo with a nested directory — sessions there must report the exact cwd.
  const repo = sb.dirs.repo;
  const sub = join(repo, "pkg", "sub");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(repo, "pkg", "f.txt"), "x");
  execSync("git init -q && git add -A && git -c user.email=h@x -c user.name=h commit -qm init", { cwd: repo });

  const dirA = sb.dirs.a;
  const dirB = sb.dirs.b;
  const sidA = await createSession(dirA);
  const sidB = await createSession(dirB);
  const sidC = await createSession(sub);
  const sessions = [sidA, sidB, sidC];

  // ---- turn 1 (dir A): schedule_list + notify + todo_write + secrets_list
  console.log("\n[turn 1] session A — schedule_list, notify, todo_write, secrets_list");
  const msgsA = await runTurn(
    sidA,
    "Call these four tools, one after another, each exactly once (each is its own tool — do NOT go through the cto tool or any gateway), then reply with the single word done:\n" +
      "1. schedule_list (no arguments)\n" +
      '2. notify with message "harness ping"\n' +
      '3. todo_write with exactly two todos: {content:"first", status:"in_progress", priority:"high"} and {content:"second", status:"pending", priority:"low"}\n' +
      "4. secrets_list (no arguments)",
  );

  const reqA = fake.requests.filter((r) => r.query.sessionID === sidA || r.body?.sessionID === sidA);
  const sched = reqA.find((r) => r.method === "GET" && r.pathname === "/api/schedule");
  check("schedule_list reached the fake server with A's sessionID", sched?.query.sessionID === sidA, j(reqA));
  const ping = fake.requests.find((r) => r.pathname === "/api/notify");
  check(
    "notify reached the fake server with A's sessionID + message",
    ping?.body?.sessionID === sidA && ping.body.message === "harness ping" && ping.body.urgent === false,
    j(ping),
  );
  const secA = fake.requests.find((r) => r.pathname === "/api/secrets" && r.query.sessionID === sidA);
  check("secrets_list sent A's directory (directory-dependent tool)", secA?.query.directory === dirA, j(secA));
  check(
    "every manta-server request carried the bearer token",
    fake.requests.length > 0 && fake.requests.every((r) => r.authorization === `Bearer ${TOKEN}`),
  );

  const partsA = toolParts(msgsA);
  const todo = partsA.find((p) => p.name === "todo_write");
  const todoInput = todo?.state?.input;
  check(
    "todo_write was called with the 2 todos as input",
    Array.isArray(todoInput?.todos) && todoInput.todos.length === 2 && todoInput.todos[0].status === "in_progress",
    j(todo),
  );
  check("todo_write result text is `Todos updated`", resultText(todo) === "Todos updated", j(todo));
  check(
    "manta tools are DIRECT tool parts named like V1 (not folded into Code Mode `execute`)",
    ["schedule_list", "notify", "todo_write", "secrets_list"].every((n) => partsA.some((p) => p.name === n)) &&
      !partsA.some((p) => p.name === "execute"),
    j(partsA.map((p) => p.name)),
  );
  check(
    "schedule_list result text is V1's formatted job list",
    resultText(partsA.find((p) => p.name === "schedule_list")).startsWith("• [job12345] deploy check — */5 * * * * (recurring)"),
  );
  check(
    "no manta-server call was made for todo_write",
    !fake.requests.some((r) => /todo/i.test(r.pathname)),
  );

  // ---- turn 2 (dir B): directory differs from A
  console.log("\n[turn 2] session B (other directory) — secrets_list, schedule_create");
  fake.reset();
  await runTurn(
    sidB,
    "Call these two tools, each exactly once (each is its own tool — do NOT go through the cto tool), then reply done:\n" +
      "1. secrets_list (no arguments)\n" +
      '2. schedule_create with cron "0 9 * * 1-5", prompt "standup", recurring true',
  );
  const secB = fake.requests.find((r) => r.pathname === "/api/secrets");
  const schedB = fake.requests.find((r) => r.method === "POST" && r.pathname === "/api/schedule");
  check("B: secrets_list carried B's sessionID", secB?.query.sessionID === sidB, j(secB));
  check("B: secrets_list carried B's directory, not A's", secB?.query.directory === dirB, j(secB));
  check(
    "B: schedule_create body carried B's sessionID + directory",
    schedB?.body?.sessionID === sidB && schedB.body.directory === dirB && schedB.body.cron === "0 9 * * 1-5",
    j(schedB),
  );
  check("A and B directories really differ", dirA !== dirB);

  // ---- turn 3 (git subdirectory): directory is the exact cwd, not the repo root
  console.log("\n[turn 3] session C (git repo subdirectory) — secrets_list");
  fake.reset();
  await runTurn(sidC, "Call the secrets_list tool (no arguments) exactly once — it is its own tool, not part of cto — then reply done.");
  const secC = fake.requests.find((r) => r.pathname === "/api/secrets");
  check(
    "C: directory is the session's exact cwd (repo subdirectory), not the repo root",
    secC?.query.sessionID === sidC && secC.query.directory === sub && sub !== repo,
    j(secC),
  );

  // ---- turn 4: a manta-server failure surfaces to the model as a tool error
  console.log("\n[turn 4] session B — delegate_stop against a failing route");
  fake.reset();
  const msgsErr = await runTurn(
    sidB,
    'Call the delegate_stop tool with id "boom0000" exactly once (its own tool, not part of cto), then tell me the exact error text you got.',
  );
  const stopPart = toolParts(msgsErr).find((p) => p.name === "delegate_stop");
  const stop = fake.requests.find((r) => r.pathname === "/api/delegate/boom0000/stop");
  check("delegate_stop POSTed /api/delegate/boom0000/stop", stop?.method === "POST", j(fake.requests));
  check(
    "the V1 error message (`job boom0000 is not running`) reached the model as a tool error",
    stopPart?.state?.status === "error" && j(stopPart).includes("job boom0000 is not running"),
    j(stopPart),
  );

  // ---- registration: plugin loaded, all tools present in every location
  console.log("\n[registration]");
  const expected = [...(await parseV1Inventory()).map((i) => i.name), "todo_write"].sort();
  check("expected tool set is 44 V1 + todo_write = 45", expected.length === 45);
  const probes = readFileSync(probeFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (const dir of [dirA, dirB, sub]) {
    const p = probes.find((x) => x.directory === dir);
    const missing = p ? expected.filter((n) => !p.tools.includes(n)) : expected;
    check(`all 45 manta tools registered in location ${dir.replace(sb.root, "…")}`, p && missing.length === 0, `missing: ${j(missing)}`);
  }
  const pluginList = await api("GET", `/api/plugin?location[directory]=${encodeURIComponent(dirA)}`);
  const mantaPlugin = (pluginList.data ?? []).find((x) => x.id === "manta");
  check("GET /api/plugin lists the `manta` plugin", !!mantaPlugin, j(pluginList));
  console.log(`       plugin entry: ${j(mantaPlugin)}`);

  // ---- spend
  const costs = await Promise.all(sessions.map(sessionCost));
  const total = costs.reduce((a, b) => a + b, 0);
  console.log(`\n[spend] session costs ${costs.map((c) => `$${c.toFixed(4)}`).join(" + ")} = $${total.toFixed(4)}`);
  check(`total model spend < $${SPEND_CAP_USD}`, total < SPEND_CAP_USD);
} catch (e) {
  check("e2e ran to completion", false, e?.stack ?? String(e));
} finally {
  if (sb) {
    try {
      appendFileSync(join(scratch, "serve.log.copy"), readFileSync(sb.logPath));
    } catch {
      /* log may be gone */
    }
    await sb.stop().catch(() => {});
  }
  if (fake) await fake.stop().catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log(`serve log kept at ${join(scratch, "serve.log.copy")}`);
else rmSync(scratch, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
