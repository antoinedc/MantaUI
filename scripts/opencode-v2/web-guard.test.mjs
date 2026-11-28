// Unit tests for the plugin's web-tool guard (docs/opencode-plugins-v2/manta/lib/webGuard.ts + the `execute.before` registration in
// index.ts; research layer spec §6.3a, AC-2.8 / AC-2.9b). Pure — no network, no opencode binary. The binary-level proof that a throw in
// this hook stops the built-in tool with no outgoing request is scripts/opencode-v2/web-guard.e2e.mjs.

import { after, afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transpileTree } from "./ts-loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANTA_DIR = join(HERE, "..", "..", "docs", "opencode-plugins-v2", "manta");
const stub = (code) => code.replace(/from\s+["']@opencode\/plugin["']/, `from "${pathToFileURL(join(HERE, "v2-plugin-stub.mjs")).href}"`);

const TOKEN = "9a8b".repeat(8);
process.env.MANTA_SERVER_URL = "http://manta.test";
process.env.MANTA_BOX_TOKEN = TOKEN;

const tree = await transpileTree(MANTA_DIR, { rewrite: stub });
after(() => tree.cleanup());
const imp = (rel) => import(pathToFileURL(join(tree.dir, rel)).href);
const { createWebGuard, guardedInput, CHECK_UNAVAILABLE, WEB_GUARD_TIMEOUT_MS } = await imp("lib/webGuard.mjs");
const pluginDef = (await imp("index.mjs")).default;

const REFUSAL = "This query would send private material to an outside source; rephrase it in general terms, or use a private source";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function guardWith(answer) {
  const calls = [];
  const guard = createWebGuard({
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      if (typeof answer === "function") return answer(url, init);
      return answer;
    },
    base: () => "http://manta.test",
    headers: (body) => ({ "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...(body ? {} : {}) }),
  });
  return { guard, calls };
}
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe("webGuard: what is asked", () => {
  test("a websearch posts its query and a webfetch its URL — only that, with the session id, to the outside-check route with the box token", async () => {
    const { guard, calls } = guardWith(json({ ok: true }));
    await guard.beforeExecute({ tool: "websearch", sessionID: "ses_1", input: { query: "postgres queue library", extra: "x" } });
    await guard.beforeExecute({ tool: "webfetch", sessionID: "ses_1", input: { url: "https://example.com/docs", format: "markdown", timeout: 30 } });
    assert.equal(calls[0].url, "http://manta.test/api/research/outside-check");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(calls[0].body, { sessionID: "ses_1", tool: "websearch", input: { query: "postgres queue library" } });
    assert.deepEqual(calls[1].body, { sessionID: "ses_1", tool: "webfetch", input: { url: "https://example.com/docs" } });
    assert.ok(calls[0].init.signal instanceof AbortSignal, "a timeout is armed");
    assert.equal(WEB_GUARD_TIMEOUT_MS, 5000);
  });

  test("any other tool is not the guard's business: nothing is asked", async () => {
    const { guard, calls } = guardWith(json({ ok: true }));
    for (const tool of ["read", "bash", "research_search", "execute", "websearch2"]) await guard.beforeExecute({ tool, sessionID: "ses_1", input: { query: "x" } });
    assert.equal(calls.length, 0);
    assert.equal(guardedInput({ tool: "read", input: {} }), null);
  });

  test("a malformed input is sent as an empty string, so the server decides (it fails closed on it)", () => {
    assert.deepEqual(guardedInput({ tool: "websearch", input: { query: 5 } }), { tool: "websearch", input: { query: "" } });
    assert.deepEqual(guardedInput({ tool: "webfetch", input: null }), { tool: "webfetch", input: { url: "" } });
  });
});

describe("webGuard: the verdict (AC-2.8) and failing closed (AC-2.9b)", () => {
  test("ok:true lets the call run; ok:false throws the server's sentence", async () => {
    await guardWith(json({ ok: true })).guard.beforeExecute({ tool: "websearch", sessionID: "s", input: { query: "x" } });
    await assert.rejects(guardWith(json({ ok: false, error: REFUSAL })).guard.beforeExecute({ tool: "websearch", sessionID: "s", input: { query: "x" } }), { message: REFUSAL });
    await assert.rejects(guardWith(json({ ok: false, error: 'The source "web" is turned off in Settings → Research sources' })).guard.beforeExecute({ tool: "websearch", sessionID: "s", input: { query: "x" } }), /turned off in Settings/);
  });

  test("every way the check can fail is a refusal: unreachable, timeout, HTTP error, an answer that isn't {ok:true}, an unreadable body", async () => {
    const cases = {
      unreachable: () => {
        throw new TypeError("fetch failed");
      },
      timeout: () => {
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      },
      "HTTP 500": () => json({ error: "boom" }, 500),
      "HTTP 401": () => json({ error: "unauthorized" }, 401),
      "no ok": () => json({}),
      "ok as a string": () => json({ ok: "true" }),
      "bad body": () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("not json"); } }),
      null: () => json(null),
    };
    for (const [name, answer] of Object.entries(cases)) {
      await assert.rejects(guardWith(answer).guard.beforeExecute({ tool: "webfetch", sessionID: "s", input: { url: "https://example.com/" } }), { message: CHECK_UNAVAILABLE }, name);
    }
    assert.equal(CHECK_UNAVAILABLE, "Couldn't check this query for private material; try again");
  });

  test("a refusal without a sentence still refuses, with the 'couldn't check' one", async () => {
    await assert.rejects(guardWith(json({ ok: false })).guard.beforeExecute({ tool: "websearch", sessionID: "s", input: { query: "x" } }), { message: CHECK_UNAVAILABLE });
  });
});

describe("plugin entry: the execute.before hook", () => {
  const ctxWith = (toolHook) => ({ location: { directory: "/work/proj" }, tool: { transform: async (cb) => cb({ add() {}, update() {} }), ...(toolHook ? { hook: toolHook } : {}) } });

  test("registers ONE blocking `execute.before` hook; the default guard asks this box's manta-server and throws a refusal", async () => {
    const registered = [];
    await pluginDef.setup(ctxWith(async (name, fn) => void registered.push({ name, fn })));
    assert.deepEqual(registered.map((r) => r.name), ["execute.before"]);
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
      return new Response(JSON.stringify({ ok: false, error: REFUSAL }), { status: 200 });
    };
    await assert.rejects(registered[0].fn({ tool: "websearch", sessionID: "ses_x", input: { query: "secret stuff" } }), { message: REFUSAL });
    assert.equal(seen[0].url, "http://manta.test/api/research/outside-check");
    assert.equal(seen[0].headers.authorization, `Bearer ${TOKEN}`);
    // another tool passes straight through
    await registered[0].fn({ tool: "read", sessionID: "ses_x", input: {} });
    assert.equal(seen.length, 1);
  });

  // a tool editor that records what the plugin does to the built-in web tools
  function editorCtx(toolHook) {
    const updates = {};
    const editor = { add() {}, update: (id, fn) => { const t = { execute: async () => "ran" }; fn(t); updates[id] = t; }, remove() {} };
    return { updates, ctx: { location: { directory: "/work/proj" }, tool: { transform: async (cb) => cb(editor), ...(toolHook ? { hook: toolHook } : {}) } } };
  }

  test("FAIL CLOSED: an instance without a tool hook, or one whose registration throws, still sets up — but websearch and webfetch are replaced by tools that refuse with the 'couldn't check' sentence", async () => {
    for (const toolHook of [null, async () => { throw new Error("no such hook"); }]) {
      const { ctx, updates } = editorCtx(toolHook);
      await pluginDef.setup(ctx);
      assert.deepEqual(Object.keys(updates).sort(), ["webfetch", "websearch"]);
      for (const id of ["websearch", "webfetch"]) await assert.rejects(updates[id].execute({ query: "x", url: "https://example.com/" }, {}), { message: CHECK_UNAVAILABLE }, id);
    }
  });

  test("with the hook registered the built-in web tools are left exactly as OpenCode ships them (the hook is the guard)", async () => {
    const { ctx, updates } = editorCtx(async () => undefined);
    await pluginDef.setup(ctx);
    assert.deepEqual(updates, {});
  });
});
