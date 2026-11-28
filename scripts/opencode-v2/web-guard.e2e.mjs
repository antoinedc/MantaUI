#!/usr/bin/env node
// Proof for the research layer spec (docs/superpowers/specs/2026-11-28-research-layer.md AC-2.9 / §6.3a), on the REAL
// pinned OpenCode V2 binary, no API spend:
//
//   node scripts/opencode-v2/web-guard.e2e.mjs
//
// Question: does the `manta` plugin's blocking `execute.before` hook stop OpenCode's built-in `websearch` and `webfetch`
// BEFORE they send anything, and do both still work when the input is clean?
//
// How: the sandbox loads the REAL plugin (docs/opencode-plugins-v2/manta) plus a harness-only companion
// (web-guard-recorder-plugin.ts) that gives `websearch` a provider which makes one plain HTTP request to a LOCAL RECORDING
// SERVER (the default provider talks to mcp.exa.ai, which a probe must never reach). `webfetch` is pointed at the same
// recording server. The plugin's guard asks a stand-in manta-server (this script) that runs the REAL outside-query check
// (src/server/research/outsideQuery.mjs). A scripted stand-in for the model calls the tools with a query / an address that
// carries a secret value (and, for `webfetch`, ONLY in the path), and then with clean input.
//
// Asserted, for each session kind (a lead's chat, an agent's task, an agent's own conversation, a plain session):
//   - both tool parts end in an error carrying the refusal sentence, and the recording server received NO request;
//   - the same calls with clean input reach the recording server;
//   - with the `web` source turned off, websearch is refused with the Settings sentence and sends nothing (webfetch is unaffected);
//   - the guard hook cannot be registered (a patched plugin copy): the plugin loads but websearch / webfetch refuse every call, nothing is sent;
//   - fail closed: with the stand-in manta-server down, both calls are refused with the "couldn't check" sentence and
//     nothing reaches the recording server.
//
// SAFETY: sandbox only (sandbox.mjs: own port, random password, own HOME/XDG). The live opencode (:4096) and manta-server
// (:8787) are never contacted; the stand-in server and the recorder bind ephemeral loopback ports.

import { createServer } from "node:http";
import { mkdir, cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBinary } from "./fetch-binary.mjs";
import { startSandbox } from "./sandbox.mjs";
import { startMockAnthropic } from "./mock-anthropic.mjs";
import { mintSessionId } from "../../src/server/delegate.mjs";
import { buildAgentBlock } from "../../src/server/agents.mjs";
import { createOutsideCheck, OUTSIDE_REFUSAL, WEB_OFF } from "../../src/server/research/outsideQuery.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, "..", "..", "docs", "opencode-plugins-v2", "manta");
const RECORDER_PLUGIN = join(HERE, "web-guard-recorder-plugin.ts");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${!ok && detail ? `\n       ${String(detail).slice(0, 900)}` : ""}`);
};

const SECRET = "sk-probe-7f3a91c0d2e84b55a6";
const UNAVAILABLE = "Couldn't check this query for private material; try again";

// ---- the local recording server: every request any tool makes to it ----
const recorded = [];
const recorder = createServer((req, res) => {
  recorded.push(`${req.method} ${req.url}`);
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("RECORDED-PAGE\n");
});
await new Promise((r) => recorder.listen(0, "127.0.0.1", r));
const recorderUrl = `http://127.0.0.1:${recorder.address().port}`;

// ---- the stand-in manta-server: ONLY the check route, using the real check ----
let webOn = true;
const outside = createOutsideCheck({ loadSecrets: async () => [{ key: "PROBE_KEY", scope: "shared", value: SECRET }], privateAnswers: async () => [], folderOf: async () => null, webEnabled: async () => webOn });
let checkUp = true;
const checkCalls = [];
const standIn = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    /* ignore */
  }
  if (req.method === "POST" && req.url === "/api/research/outside-check" && checkUp) {
    checkCalls.push(body);
    const answer = await outside.check({ sessionID: body.sessionID, tool: body.tool, input: body.input });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer));
    return;
  }
  res.writeHead(checkUp ? 404 : 503, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise((r) => standIn.listen(0, "127.0.0.1", r));
const standInUrl = `http://127.0.0.1:${standIn.address().port}`;

// ---- the scripted "model" ----
let SCRIPT = [];
const stepOf = (body) => {
  let n = 0;
  for (const m of body.messages ?? []) if (Array.isArray(m.content)) n += m.content.filter((c) => c.type === "tool_result").length;
  return n;
};
const decideFn = (body) => {
  const call = SCRIPT[stepOf(body)];
  if (!call) return { kind: "text", text: "done" };
  const name = (body.tools ?? []).map((t) => t.name).find((n) => call.re.test(n));
  if (!name) return { kind: "text", text: `no tool ${call.re}` };
  return { kind: "tool", name, input: call.input };
};

const mock = await startMockAnthropic({ decideFn });
const oc = await import("../../src/server/opencode.mjs");
let sb;
let cwd;
const binary = await ensureBinary({ log: (m) => console.log(`[binary] ${m}`) });
/** A fresh sandbox running the real pinned binary with `pluginDir` as the manta plugin. */
async function boot(pluginDir) {
  const sbConfig = {
    provider: { anthropic: { options: { baseURL: `${mock.url}/v1`, apiKey: "mock" } } },
    permission: { websearch: "allow", webfetch: "allow" },
    agent: {},
  };
  sb = await startSandbox({
    binary,
    config: sbConfig,
    onRoot: (root) => {
      const real = buildAgentBlock({ dir: join(root, "home", ".manta/agents/dev"), meta: { description: "Dev probe", model: null, role: "specialist" }, home: join(root, "home") });
      sbConfig.agent["agent-dev"] = { ...real, prompt: "You are the Dev probe." };
    },
    plugins: [{ src: pluginDir, name: "manta" }, { src: RECORDER_PLUGIN, name: "zz-web-guard-recorder.ts" }],
    env: { ANTHROPIC_API_KEY: "mock", MANTA_SERVER_URL: standInUrl, MANTA_BOX_TOKEN: "ef12".repeat(8), WEB_GUARD_RECORDER_URL: recorderUrl },
  });
  process.env.MANTA_OPENCODE_PASSWORD = sb.password;
  oc._setApiBase(sb.url);
  cwd = sb.projectDir;
  await mkdir(join(cwd, "x"), { recursive: true });
}
let brokenCopy = null;
try {
  await boot(PLUGIN_DIR);

  const api = async (method, path, body) => {
    const res = await fetch(sb.url + path, { method, headers: { authorization: sb.auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : undefined;
  };

  /** Run SCRIPT in a fresh session of the given kind; the finished tool parts, in call order. */
  async function run(kind, script) {
    SCRIPT = script;
    const model = { providerID: "anthropic", modelID: "claude-haiku-4-5" };
    const base = { directory: cwd, model, title: `probe-${kind}` };
    let sess;
    if (kind === "lead chat") sess = await oc.createSession({ ...base, agent: "build" });
    else if (kind === "agent conversation") sess = await oc.createSession({ ...base, agent: "agent-dev" });
    else if (kind === "agent task") {
      const parent = await oc.createSession({ ...base, agent: "build", title: "parent" });
      sess = await oc.createSession({ ...base, agent: "agent-dev", parentID: parent.id, id: mintSessionId() });
    } else sess = await oc.createSession(base); // a plain session: no agent named
    await api("POST", `/api/session/${sess.id}/prompt`, { text: "go" });
    await Promise.race([api("POST", `/api/experimental/session/${sess.id}/wait`), new Promise((_, rej) => setTimeout(() => rej(new Error("turn timed out")), 90_000))]);
    const msgs = await oc.listMessages(sess.id, { limit: 200 });
    return msgs.flatMap((m) => m.parts ?? []).filter((p) => p.type === "tool");
  }
  const search = (query) => ({ re: /^websearch$/, input: { query } });
  const fetchUrl = (url) => ({ re: /^webfetch$/, input: { url, format: "text" } });
  const errorOf = (part) => (part?.state?.status === "error" ? String(part.state.error ?? "") : "");

  // 0. Settings → Test on the web row uses OpenCode's own route (POST /api/websearch) through the production client: it answers with the
  // default provider's results (here the recorder), which is what `research.testSource` relays after the outside-query check
  // (a location's providers load a moment after the server starts)
  for (let i = 0; i < 40; i++) {
    const listed = await api("GET", `/api/websearch/provider?location[directory]=${encodeURIComponent(cwd)}`).catch(() => null);
    if (listed?.data?.some((p) => p.id === "recorder")) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  recorded.length = 0;
  const viaRoute = await oc.webSearch({ query: "postgres job queue library for node", directory: cwd });
  check("oc.webSearch (POST /api/websearch) returns the provider's results as an array", Array.isArray(viaRoute) && viaRoute.length === 1 && viaRoute[0].url === `${recorderUrl}/result/1` && viaRoute[0].title === "Recorded result", JSON.stringify(viaRoute));
  check("oc.webSearch reached the provider (the recording server saw the query)", recorded.some((r) => r.startsWith("GET /provider-search?q=postgres")), recorded.join(" | "));

  for (const kind of ["lead chat", "agent task", "agent conversation", "plain session"]) {
    // 1. private material: a secret value in a query, and in the PATH of an address (no query string, no fragment)
    recorded.length = 0;
    checkCalls.length = 0;
    const blocked = await run(kind, [search(`pick a queue library for ${SECRET}`), fetchUrl(`${recorderUrl}/docs/${SECRET}/plans`)]);
    const [s1, f1] = [blocked.find((p) => p.tool === "websearch"), blocked.find((p) => p.tool === "webfetch")];
    check(`${kind}: websearch with a secret in the query is refused with the check's sentence`, errorOf(s1).includes(OUTSIDE_REFUSAL), JSON.stringify(s1?.state));
    check(`${kind}: webfetch with a secret only in the URL path is refused with the check's sentence`, errorOf(f1).includes(OUTSIDE_REFUSAL), JSON.stringify(f1?.state));
    check(`${kind}: the recording server received NO request for either`, recorded.length === 0, recorded.join(" | "));
    check(`${kind}: both calls reached the guard under their own names`, checkCalls.map((c) => c.tool).sort().join() === "webfetch,websearch", JSON.stringify(checkCalls));

    // 2. clean input goes through
    recorded.length = 0;
    const clean = await run(kind, [search("postgres job queue library for node"), fetchUrl(`${recorderUrl}/docs/pricing`)]);
    const [s2, f2] = [clean.find((p) => p.tool === "websearch"), clean.find((p) => p.tool === "webfetch")];
    check(`${kind}: a clean websearch completes and reaches the recording server`, s2?.state?.status === "completed" && recorded.some((r) => r.startsWith("GET /provider-search")), JSON.stringify(s2?.state) + recorded.join("|"));
    check(`${kind}: a clean webfetch completes and reaches the recording server`, f2?.state?.status === "completed" && recorded.includes("GET /docs/pricing"), JSON.stringify(f2?.state) + recorded.join("|"));
  }

  // 3. the web source turned off in Settings: websearch is refused for every session kind (webfetch is not affected)
  webOn = false;
  for (const kind of ["lead chat", "agent task", "agent conversation", "plain session"]) {
    recorded.length = 0;
    const off = await run(kind, [search("postgres job queue library for node"), fetchUrl(`${recorderUrl}/docs/pricing`)]);
    const [s3, f3] = [off.find((p) => p.tool === "websearch"), off.find((p) => p.tool === "webfetch")];
    check(`${kind}: with the web source off, websearch is refused with the Settings sentence and sends nothing`, errorOf(s3).includes(WEB_OFF) && !recorded.some((r) => r.startsWith("GET /provider-search")), JSON.stringify(s3?.state) + recorded.join("|"));
    check(`${kind}: with the web source off, webfetch still works`, f3?.state?.status === "completed" && recorded.includes("GET /docs/pricing"), JSON.stringify(f3?.state));
  }
  webOn = true;

  // 4. fail closed: the check is unreachable
  checkUp = false;
  recorded.length = 0;
  const down = await run("lead chat", [search("postgres job queue library for node"), fetchUrl(`${recorderUrl}/docs/pricing`)]);
  check("manta-server unreachable: websearch is refused with the 'couldn't check' sentence", errorOf(down.find((p) => p.tool === "websearch")).includes(UNAVAILABLE), JSON.stringify(down.find((p) => p.tool === "websearch")?.state));
  check("manta-server unreachable: webfetch is refused with the 'couldn't check' sentence", errorOf(down.find((p) => p.tool === "webfetch")).includes(UNAVAILABLE), JSON.stringify(down.find((p) => p.tool === "webfetch")?.state));
  check("manta-server unreachable: nothing reached the recording server", recorded.length === 0, recorded.join(" | "));

  // 5. the guard hook cannot be registered (a copy of the plugin whose registration throws, standing in for an instance without the
  // hook): the plugin still loads, but websearch and webfetch are REPLACED by tools that refuse — with the check server UP, so the
  // refusal can only come from the missing guard, never from a verdict
  await sb.stop().catch(() => {});
  brokenCopy = await mkdtemp(join(tmpdir(), "manta-web-guard-broken-"));
  await cp(PLUGIN_DIR, join(brokenCopy, "manta"), { recursive: true });
  const indexFile = join(brokenCopy, "manta", "index.ts");
  const original = await readFile(indexFile, "utf8");
  const hookCall = 'await ctx.tool.hook("execute.before", (event: any) => guard.beforeExecute(event));';
  check("the broken copy really replaces the hook registration", original.includes(hookCall));
  await writeFile(indexFile, original.replace(hookCall, 'throw new Error("hook registration unavailable");'));
  checkUp = true;
  checkCalls.length = 0;
  await boot(join(brokenCopy, "manta"));
  for (const kind of ["lead chat", "agent task", "agent conversation", "plain session"]) {
    recorded.length = 0;
    const out = await run(kind, [search("postgres job queue library for node"), fetchUrl(`${recorderUrl}/docs/pricing`)]);
    const [s5, f5] = [out.find((p) => p.tool === "websearch"), out.find((p) => p.tool === "webfetch")];
    check(`${kind}: hook registration failed — websearch is refused (fail closed), not left unguarded`, errorOf(s5).includes(UNAVAILABLE), JSON.stringify(s5?.state));
    check(`${kind}: hook registration failed — webfetch is refused (fail closed), not left unguarded`, errorOf(f5).includes(UNAVAILABLE), JSON.stringify(f5?.state));
    check(`${kind}: hook registration failed — nothing reached the recording server`, recorded.length === 0, recorded.join(" | "));
  }
  check("hook registration failed — the refusals did not come from the check server (it was never asked)", checkCalls.length === 0, JSON.stringify(checkCalls));
} finally {
  if (brokenCopy) await rm(brokenCopy, { recursive: true, force: true }).catch(() => {});
  await sb?.stop().catch(() => {});
  await mock.close().catch(() => {});
  await new Promise((r) => standIn.close(r));
  await new Promise((r) => recorder.close(r));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
