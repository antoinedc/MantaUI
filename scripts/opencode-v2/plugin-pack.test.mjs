// Parity tests for the `manta` V2 plugin (docs/opencode-plugins-v2/manta) against
// the V1 tools it replaces (docs/opencode-tools/*.ts). Pure — no network, no
// opencode binary. The V1 tool files are imported for real (stubbed
// `@opencode-ai/plugin`, real zod), so:
//   - the V2 name set is compared with the set parsed from the V1 sources;
//   - every V2 input schema is diffed against the V1 zod schema converted to
//     JSON Schema (field names, types, enums, optionality, descriptions);
//   - every tool is RUN through both implementations against the same fake
//     manta-server and must send identical requests and return (or throw) the
//     identical string.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { transpileTree } from "./ts-loader.mjs";
import { loadV1Tools, parseV1Inventory, v1ToolName } from "./v1-tools.mjs";
import { cannedResponse } from "./fake-manta-server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, "..", "..", "docs", "opencode-plugins-v2", "manta");
const TOKEN = "ab12".repeat(8); // 32 hex chars, built so no key-shaped literal sits in the source
const CTX = { sessionID: "ses_test123", messageID: "msg_test456", directory: "/work/proj" };

// V1 reads MANTA_SERVER_URL at import time; set before loadV1Tools().
process.env.MANTA_SERVER_URL = "http://manta.test";
process.env.MANTA_BOX_TOKEN = TOKEN;
process.env.MANTA_RESOURCE_SNAPSHOT_TIMEOUT_MS = "2000";

const realFetch = globalThis.fetch;
function installFakeFetch(handler = cannedResponse) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? "GET", url: String(url), headers: { ...init.headers }, body });
    const out = handler({
      method: init.method ?? "GET",
      pathname: u.pathname,
      query: u.searchParams,
      body,
    });
    return new Response(JSON.stringify(out.body), { status: out.status });
  };
  return calls;
}

const v1 = await loadV1Tools();
const v2Tree = await transpileTree(PLUGIN_DIR, {
  rewrite: (code) =>
    code.replace(
      /from\s+"@opencode\/plugin"/g,
      `from "${pathToFileURL(join(HERE, "v2-plugin-stub.mjs")).href}"`,
    ),
});
const toolsMod = await import(pathToFileURL(join(v2Tree.dir, "tools", "index.mjs")).href);
const v2 = { allTools: toolsMod.allTools, indexUrl: pathToFileURL(join(v2Tree.dir, "index.mjs")).href };

after(async () => {
  globalThis.fetch = realFetch;
  await v1.cleanup();
  await v2Tree.cleanup();
});

describe("tool inventory", () => {
  test("V1 inventory is the 44 tools the spec names", async () => {
    const inv = await parseV1Inventory();
    assert.equal(inv.length, 44);
    assert.equal(new Set(inv.map((i) => i.name)).size, 44, "V1 names are unique");
  });

  test("V1 name derivation: <file>_<export> unless the export is already the full name", () => {
    assert.equal(v1ToolName("schedule", "create"), "schedule_create");
    assert.equal(v1ToolName("peers", "list"), "peers_list");
    assert.equal(v1ToolName("secrets", "provide"), "secrets_provide");
    assert.equal(v1ToolName("webhook", "remove"), "webhook_remove");
    assert.equal(v1ToolName("notify", "notify"), "notify");
    assert.equal(v1ToolName("cto", "cto"), "cto");
    assert.equal(v1ToolName("cto-fact", "cto_fact"), "cto_fact");
    assert.equal(v1ToolName("media", "media_show"), "media_show");
    assert.equal(v1ToolName("manta-app", "manta_compact_session"), "manta_compact_session");
    assert.equal(v1ToolName("delegate", "delegate_list"), "delegate_list");
  });

  test("V2 tool-name set equals the V1 tool-name set (plus todo_write)", async () => {
    const inv = await parseV1Inventory();
    const v1Names = new Set(inv.map((i) => i.name));
    const v2Names = new Set(v2.allTools.map((t) => t.name));
    assert.deepEqual([...v1Names].filter((n) => !v2Names.has(n)).sort(), [], "V1 tools missing in V2");
    assert.deepEqual(
      [...v2Names].filter((n) => !v1Names.has(n)).sort(),
      ["todo_write"],
      "V2 adds exactly todo_write",
    );
    assert.equal(v2.allTools.length, 45);
    assert.ok(!v2Names.has("todowrite"), "todowrite is reserved by V2");
  });

  test("every V1 export has a V2 twin loaded from the real V1 module", () => {
    for (const t of v2.allTools) {
      if (t.name === "todo_write") continue;
      assert.ok(v1.tools[t.name], `V1 module for ${t.name}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Schema parity
// ---------------------------------------------------------------------------

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Reduce a JSON Schema to the facts we compare (see header comment of the file). */
function normalize(s) {
  if (Array.isArray(s)) return s.map(normalize);
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "$schema" || k === "propertyNames") continue;
    if ((k === "maximum" && v === MAX_SAFE) || (k === "minimum" && v === -MAX_SAFE)) continue;
    if (k === "additionalProperties") {
      // strict (false / unset) is not a V1 fact; "open" (true / {}) is.
      if (v === false || v === undefined) continue;
      out[k] = true;
      continue;
    }
    if (k === "required") {
      out[k] = [...v].sort();
      continue;
    }
    if (k === "properties") {
      out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, normalize(pv)]));
      continue;
    }
    out[k] = normalize(v);
  }
  return out;
}

describe("input schema parity (V2 JSON Schema vs the V1 zod args)", () => {
  test("every V2 tool input is a strict top-level object", () => {
    for (const t of v2.allTools) {
      assert.equal(t.input.type, "object", t.name);
      assert.equal(t.input.additionalProperties, false, `${t.name} additionalProperties:false`);
    }
  });

  for (const name of Object.keys(v1.tools)) {
    test(`${name}: schema + description match V1`, () => {
      const twin = v2.allTools.find((t) => t.name === name);
      assert.ok(twin, `${name} registered in V2`);
      const old = v1.tools[name];
      assert.equal(twin.description, old.description, "description is verbatim");
      const want = normalize(z.toJSONSchema(z.object(old.args), { io: "input" }));
      const got = normalize(twin.input);
      assert.deepEqual(got, want);
    });
  }

  test("required / optional fields are exactly V1's for the awkward shapes", () => {
    const by = (n) => v2.allTools.find((t) => t.name === n).input;
    assert.deepEqual([...by("schedule_create").required].sort(), ["cron", "prompt", "recurring"]);
    assert.deepEqual([...by("delegate").required], ["prompt"]);
    assert.deepEqual([...by("cto").required].sort(), ["args", "tool"]);
    assert.deepEqual([...by("cto_verdict").required].sort(), ["id", "type", "verdict"]);
    assert.equal(by("media_begin").properties.kind.enum.join(), "image,video");
    assert.equal(by("schedule_list").required, undefined);
  });
});

describe("todo_write", () => {
  test("input is identical to V1 TodoWrite and the result is `Todos updated`", async () => {
    const t = v2.allTools.find((x) => x.name === "todo_write");
    const item = t.input.properties.todos.items;
    assert.deepEqual(t.input.required, ["todos"]);
    assert.deepEqual([...item.required].sort(), ["content", "priority", "status"]);
    assert.deepEqual(item.properties.status.enum, ["pending", "in_progress", "completed", "cancelled"]);
    assert.deepEqual(item.properties.priority.enum, ["high", "medium", "low"]);
    assert.equal(item.properties.content.type, "string");
    const calls = installFakeFetch();
    assert.equal(await t.execute({ todos: [] }, CTX), "Todos updated");
    assert.equal(calls.length, 0, "todo_write makes no manta-server call");
  });
});

// ---------------------------------------------------------------------------
// Behavioural parity: same fake server, same inputs → same requests, same text.
// ---------------------------------------------------------------------------

const err = (status, error) => () => ({ status, body: { error } });
const only = (route, out) => (req) =>
  `${req.method} ${req.pathname}` === route ? out : cannedResponse(req);

/** [toolName, args, optional fake-server handler override]. */
const SCENARIOS = [
  ["schedule_create", { cron: "*/5 * * * *", prompt: "check", recurring: true, label: "deploy" }],
  ["schedule_create", { cron: "30 14 15 3 *", prompt: "once", recurring: false }],
  ["schedule_create", { cron: "* * * * *", prompt: "x", recurring: true }, err(400, "bad cron")],
  ["schedule_list", {}],
  ["schedule_list", {}, only("GET /api/schedule", { status: 200, body: { jobs: [] } })],
  ["schedule_cancel", { id: "job12345" }],
  ["schedule_cancel", { id: "nope0000" }],
  ["notify", { message: "hello" }],
  ["notify", { message: "now!", title: "T", urgent: true }],
  ["secrets_list", {}],
  ["secrets_list", {}, only("GET /api/secrets", { status: 200, body: { secrets: [] } })],
  ["secrets_provide", { key: "github_pat" }],
  ["secrets_provide", { key: "x" }, err(404, "no such secret")],
  ["webhook_create", { label: "ci" }],
  ["webhook_create", { label: "ci", instructions: "do it", unsigned: true }],
  ["webhook_list", {}],
  ["webhook_list", {}, only("GET /api/webhook", { status: 200, body: {} })],
  ["webhook_remove", { id: "hook1234" }],
  ["webhook_remove", { id: "nope0000" }],
  ["delegate", { prompt: "do the thing", model: "openai/gpt-6-sol", subagent_type: "general", tools: [{ permission: "bash", pattern: "**" }] }],
  ["delegate", { prompt: "decline-me" }],
  ["delegate_list", {}],
  ["delegate_list", {}, only("GET /api/delegate", { status: 200, body: { jobs: [] } })],
  ["delegate_stop", { id: "abc12345" }],
  ["delegate_stop", { id: "boom0000" }],
  ["peers_list", {}],
  ["peers_list", {}, only("GET /api/peers", { status: 200, body: { workspace: "ws", peers: [] } })],
  ["peers_inspect", { target: "peer-a" }],
  ["peers_message", { target: "peer-a", message: "rebase please" }],
  ["media_save", { sourcePath: "/home/u/x.png" }],
  ["media_begin", { kind: "image", width: 640, height: 480 }],
  ["media_show", { path: "/home/u/x.png", handle: "mh_1", title: "t" }],
  ["plan_render", { file: "plan.html" }],
  ["progress_report", { label: "step 1 of 3", step: 1, total: 3, state: "working" }],
  ["progress_report", {}, only("POST /api/progress", { status: 200, body: { ok: false } })],
  ["send_file", { path: "/tmp/export.csv", notify: true, ttlHours: 2 }],
  ["send_file", { path: "/tmp/export.csv" }, only("POST /api/outbox/push", { status: 200, body: { row: {} } })],
  ["send_to_cto", { message: "blocked on CI" }],
  ["send_to_cto", { message: "fyi", kind: "fyi", refs: ["BET-1"], tag: "t" }],
  ["serve_page", { subdomain: "preview", filePath: "/tmp/p/index.html" }],
  ["serve_page", { subdomain: "preview", filePath: "/tmp/p/index.html", ttlHours: 0 }],
  ["serve_page", { subdomain: "preview", filePath: "/tmp/p/index.html", ttlHours: 6 }],
  ["stop_page", { subdomain: "preview" }],
  ["stop_page", { subdomain: "nope" }],
  ["list_pages", {}],
  ["list_pages", {}, only("GET /api/serve-page", { status: 200, body: { pages: [] } })],
  ["widget_show", { html: "<html></html>", width: 400, height: 300, title: "w" }],
  ["plugin_list", {}],
  ["plugin_list", {}, only("GET /api/plugins/registry", { status: 200, body: { rows: [] } })],
  ["plugin_get", { name: "ios-app" }],
  ["plugin_get", { name: "broken" }],
  ["plugin_get", { name: "zzz" }],
  ["plugin_save", { name: "ios-app", yaml: "name: ios-app\n" }],
  ["plugin_save", { name: "x", yaml: "y" }, (req) =>
    req.pathname === "/api/cap/job1" ? { status: 200, body: { status: "failed", error: "bad manifest" } } : cannedResponse(req)],
  ["plugin_save", { name: "x", yaml: "y" }, only("POST /api/cap", { status: 200, body: {} })],
  ["plugin_run", { name: "ios-app", inputs: { scheme: "App" } }],
  ["plugin_run", { name: "ios-app" }],
  ["plugin_run", { name: "broken" }],
  ["plugin_run", { name: "nope" }],
  ["plugin_status", { id: "job1" }],
  ["plugin_status", { id: "job1" }, (req) =>
    req.pathname === "/api/cap/job1" ? { status: 200, body: { id: "job1", capability: "c", status: "failed", error: "boom" } } : cannedResponse(req)],
  ["plugin_docs", {}],
  ["forge_rules_save", { repo: "github.com/o/r", yaml: "on: {}\n" }],
  ["forge_rules_save", { repo: "github.com/o/r", yaml: "invalid" }],
  ["forge_rules_save", { repo: "github.com/o/r", yaml: "z" }, only("POST /api/forge-rules", { status: 200, body: { ok: true, webhook: { error: "no token" } } })],
  ["forge_rules_save", { repo: "github.com/o/r", yaml: "z" }, only("POST /api/forge-rules", { status: 200, body: { ok: true } })],
  ["forge_rules_get", { repo: "github.com/o/r" }],
  ["forge_rules_get", { repo: "github.com/o/missing" }],
  ["forge_rules_list", {}],
  ["forge_rules_list", {}, only("GET /api/forge-rules", { status: 200, body: { rules: [] } })],
  ["forge_rules_docs", {}],
  ["manta_compact_session", {}],
  ["manta_compact_session", {}, only("POST /api/app-control", { status: 200, body: { ok: false } })],
  ["manta_switch_model", { query: "opus" }],
  ["manta_switch_model", { query: "nomodel" }],
  ["manta_rename_session", { name: "new name" }],
  ["manta_list_sessions", {}],
  ["cto", { tool: "list_sessions", args: {} }],
  ["cto", { tool: "work_dispatch", args: { a: 1 }, approve: "ap_1" }],
  ["cto", { tool: "x", args: {} }, () => ({ status: 409, body: { ok: false, error: "denied", code: "plan_mode", retrySafe: true } })],
  ["cto", { tool: "x", args: {} }, () => ({ status: 500, body: {} })],
  ["cto_fact", { project: "p", kind: "status", statement: "s", refs: ["abc123"], valid_until: "2027-01-01", supersedes: "f1" }],
  ["cto_fact", { project: "p", kind: "status", statement: "s" }],
  ["cto_fact", { project: "p", kind: "blocker", statement: "s", refs: ["r"] }, only("POST /api/cto/facts", { status: 200, body: { queued: true, proposalId: "p9" } })],
  ["cto_verdict", { type: "fact", id: "f1", verdict: "accept" }],
  ["cto_verdict", { type: "fact", id: "f1", verdict: "dismiss", class: "proj", sender: { sessionID: "ses_x" }, never: true }],
  ["cto_verdict", { type: "fact", id: "f1", verdict: "open" }, only("POST /api/cto/verdict", { status: 200, body: {} })],
  ["resource_snapshot", {}],
  ["resource_snapshot", {}, only("GET /api/resource-snapshot", { status: 200, body: { capturedAt: "t", status: "critical", memory: {}, cpu: {}, disk: {}, containers: { available: false } } })],
  ["resource_snapshot", {}, err(503, "snapshot unavailable")],
];

async function settle(fn) {
  try {
    return { ok: await fn() };
  } catch (e) {
    return { threw: String(e?.message ?? e) };
  }
}

describe("behavioural parity (V1 vs V2 against the same fake manta-server)", () => {
  SCENARIOS.forEach(([name, args, handler], i) => {
    test(`#${i} ${name} ${JSON.stringify(args).slice(0, 60)}`, async () => {
      const twin = v2.allTools.find((t) => t.name === name);
      assert.ok(twin, `${name} registered`);

      const v1Calls = installFakeFetch(handler);
      const v1Result = await settle(() => v1.tools[name].execute(structuredClone(args), { ...CTX }));
      const v2Calls = installFakeFetch(handler);
      const v2Result = await settle(() => twin.execute(structuredClone(args), { ...CTX }));

      assert.deepEqual(v2Calls, v1Calls, "identical manta-server requests (method, url, headers, body)");
      assert.deepEqual(v2Result, v1Result, "identical returned string / thrown message");
      for (const c of v2Calls) {
        assert.equal(c.headers.authorization, `Bearer ${TOKEN}`, "bearer token sent");
      }
    });
  });

  test("every V1 tool has at least one behavioural scenario", async () => {
    const inv = await parseV1Inventory();
    const have = new Set(SCENARIOS.map((s) => s[0]));
    for (const i of inv) assert.ok(have.has(i.name), `no scenario for ${i.name}`);
  });
});

// ---------------------------------------------------------------------------
// Plugin entry (index.ts) wiring
// ---------------------------------------------------------------------------

describe("plugin entry", () => {
  test("setup registers all 45 tools once, wrapping results as { content }", async () => {
    const mod = await import(v2.indexUrl);
    const def = mod.default;
    assert.equal(def.id, "manta");
    const added = [];
    let transformCalls = 0;
    const pluginCtx = {
      location: { directory: "/work/proj" },
      tool: {
        transform: async (cb) => {
          transformCalls++;
          cb({ add: (t) => added.push(t) });
        },
      },
    };
    await def.setup(pluginCtx);
    assert.equal(transformCalls, 1);
    assert.equal(added.length, 45);
    assert.equal(new Set(added.map((t) => t.name)).size, 45);

    const calls = installFakeFetch();
    const sched = added.find((t) => t.name === "schedule_list");
    const out = await sched.execute({}, { sessionID: "ses_abc", messageID: "msg_1" });
    assert.equal(typeof out.content, "string");
    assert.match(out.content, /job12345/);
    assert.equal(calls[0].url, "http://manta.test/api/schedule?sessionID=ses_abc");

    // directory comes from the plugin's location, not the execute context
    const secrets = added.find((t) => t.name === "secrets_list");
    await secrets.execute({}, { sessionID: "ses_abc", messageID: "msg_1" });
    assert.equal(new URL(calls[1].url).searchParams.get("directory"), "/work/proj");

    // failures propagate as thrown errors with the V1 message
    installFakeFetch(err(500, "kaboom"));
    await assert.rejects(() => added.find((t) => t.name === "schedule_cancel").execute({ id: "x" }, { sessionID: "s" }), /kaboom/);
  });
});
