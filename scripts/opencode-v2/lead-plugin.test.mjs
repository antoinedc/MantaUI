// Agents Phase 2 plugin half (spec docs/superpowers/specs/2026-11-22-agents-phase2.md §5, §7, §8):
//   - lib/lead.ts: the lead brief per session — cache (an empty answer too), fail-open, 503 caches nothing, forget on
//     compaction / deletion, one fetch for concurrent requests;
//   - the plugin entry: ONE context hook, lead text first, then the knowledge briefing, each failing open alone;
//   - tools/agents.ts: agent_handoff request + relayed sentences; lib/context.ts keeps the call id;
//   - routine tools: the optional / nullable `agent`.
// Pure — no network, no opencode binary.

import { after, afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transpileTree } from "./ts-loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANTA_DIR = join(HERE, "..", "..", "docs", "opencode-plugins-v2", "manta");
const stub = (code) =>
  code.replace(/from\s+["']@opencode\/plugin["']/, `from "${pathToFileURL(join(HERE, "v2-plugin-stub.mjs")).href}"`);

const TOKEN = "9a8b".repeat(8);
process.env.MANTA_SERVER_URL = "http://manta.test";
process.env.MANTA_BOX_TOKEN = TOKEN;

const tree = await transpileTree(MANTA_DIR, { rewrite: stub });
after(() => tree.cleanup());
const imp = (rel) => import(pathToFileURL(join(tree.dir, rel)).href);
const { createLead, AUTONOMY_FALLBACK } = await imp("lib/lead.mjs");
const { resolveToolContext } = await imp("lib/context.mjs");
const { allTools } = await imp("tools/index.mjs");
const pluginDef = (await imp("index.mjs")).default;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IDENTITY = { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." };
const LEAD = "You are Manta, the lead of this chat.\n\n## Your team\n...";
const KNOWLEDGE = "Standing rules from the user for this project:\n- use pnpm";

/** A fake manta-server: `routes` maps "METHOD /path" → handler(call) → { status?, body } (may be async). */
function fakeServer(routes) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(String(url));
    const call = { method: init.method ?? "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), headers: { ...init.headers }, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const h = routes[`${call.method} ${call.path}`];
    if (!h) return new Response("{}", { status: 404 });
    // like a real fetch, give up when the caller's signal aborts
    const aborted = init.signal ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))) : null;
    const out = await (aborted ? Promise.race([Promise.resolve().then(() => h(call)), aborted]) : h(call));
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
  };
  return { calls, fetchFn };
}

function leadWith(routes, extra = {}) {
  const srv = fakeServer(routes);
  const lead = createLead({
    fetch: srv.fetchFn,
    base: () => "http://manta.test",
    headers: () => ({ authorization: `Bearer ${TOKEN}` }),
    ...extra,
  });
  return { srv, lead };
}
const ev = (sessionID, system = [IDENTITY]) => ({ sessionID, system, messages: [] });
const texts = (system) => system.map((b) => b.text);

describe("lead brief: fetch, cache, fail open", () => {
  test("appends the brief after the existing blocks, with the session id and the bearer token", async () => {
    const { srv, lead } = leadWith({ "GET /api/agents/lead-brief": () => ({ body: { text: LEAD } }) });
    const e = ev("ses_a", [IDENTITY, { type: "text", text: "prompt" }]);
    await lead.onContext(e);
    assert.deepEqual(texts(e.system), [IDENTITY.text, "prompt", LEAD]);
    assert.deepEqual(srv.calls.map((c) => c.query), [{ sessionID: "ses_a" }]);
    assert.equal(srv.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  });

  test("later requests of the session append the SAME bytes without asking again", async () => {
    const { srv, lead } = leadWith({ "GET /api/agents/lead-brief": () => ({ body: { text: LEAD } }) });
    const first = ev("ses_a");
    const second = ev("ses_a");
    await lead.onContext(first);
    await lead.onContext(second);
    assert.equal(srv.calls.length, 1);
    assert.equal(texts(second.system).at(-1), LEAD);
    assert.equal(texts(first.system).at(-1), texts(second.system).at(-1));
    await lead.onContext(second); // already there: not appended twice
    assert.equal(second.system.length, 2);
  });

  test("an empty answer (the chat is not led) is cached too and appends nothing", async () => {
    const { srv, lead } = leadWith({ "GET /api/agents/lead-brief": () => ({ body: { text: "" } }) });
    const e = ev("ses_a");
    await lead.onContext(e);
    await lead.onContext(e);
    assert.deepEqual(e.system, [IDENTITY]);
    assert.equal(srv.calls.length, 1, "asked once, not on every request");
  });

  test("a 503 that says the autonomy settings couldn't be read appends the fixed fallback for that turn and caches nothing", async () => {
    let n = 0;
    const { srv, lead } = leadWith({
      "GET /api/agents/lead-brief": () => (++n === 1 ? { status: 503, body: { error: "couldn't read the autonomy settings right now", autonomy: "unreadable" } } : { body: { text: LEAD } }),
    });
    const a = ev("ses_a");
    await lead.onContext(a);
    assert.deepEqual(texts(a.system), [IDENTITY.text, AUTONOMY_FALLBACK]);
    assert.match(AUTONOMY_FALLBACK, /^Your lead settings couldn't be loaded for this turn\. Don't hand off work, and don't merge, deploy, publish, send anything outside this box, delete data or spend money this turn\.$/);
    const b = ev("ses_a");
    await lead.onContext(b);
    assert.deepEqual(texts(b.system), [IDENTITY.text, LEAD], "the next request asked again and got the real brief");
    assert.equal(srv.calls.length, 2);
  });

  test("an ordinary 503 (couldn't classify) appends nothing — the fallback is only for unreadable settings", async () => {
    const { lead } = leadWith({ "GET /api/agents/lead-brief": () => ({ status: 503, body: { error: "couldn't classify this chat right now" } }) });
    const a = ev("ses_a");
    await lead.onContext(a);
    assert.deepEqual(a.system, [IDENTITY]);
  });

  test("a 503 caches nothing: the next request asks again and gets the brief", async () => {
    let n = 0;
    const { srv, lead } = leadWith({ "GET /api/agents/lead-brief": () => (++n === 1 ? { status: 503, body: { error: "couldn't classify" } } : { body: { text: LEAD } }) });
    const a = ev("ses_a");
    await lead.onContext(a);
    assert.deepEqual(a.system, [IDENTITY]);
    const b = ev("ses_a");
    await lead.onContext(b);
    assert.equal(texts(b.system).at(-1), LEAD);
    assert.equal(srv.calls.length, 2);
  });

  test("a transport error, a bad body, a 500 or a timeout: nothing appended, nothing cached, never thrown", async () => {
    for (const bad of [
      () => {
        throw new Error("ECONNREFUSED");
      },
      () => ({ body: { nope: 1 } }),
      () => ({ status: 500, body: { error: "kaboom" } }),
      () => sleep(80).then(() => ({ body: { text: LEAD } })),
    ]) {
      const { srv, lead } = leadWith({ "GET /api/agents/lead-brief": bad }, { timeoutMs: 20 });
      const e = ev("ses_a");
      await lead.onContext(e);
      assert.deepEqual(e.system, [IDENTITY]);
      await lead.onContext(e);
      assert.equal(srv.calls.length, 2, "asked again: nothing was cached");
    }
    const { lead } = leadWith({});
    await lead.onContext({ sessionID: 42, system: "nope" }); // garbage events are ignored
    await lead.onContext(undefined);
  });

  test("concurrent first requests of one session share one fetch", async () => {
    const { srv, lead } = leadWith({ "GET /api/agents/lead-brief": () => sleep(10).then(() => ({ body: { text: LEAD } })) });
    const [a, b] = [ev("ses_a"), ev("ses_a")];
    await Promise.all([lead.onContext(a), lead.onContext(b)]);
    assert.equal(srv.calls.length, 1);
    assert.equal(texts(a.system).at(-1), LEAD);
    assert.equal(texts(b.system).at(-1), LEAD);
  });

  test("session.compacted and session.deleted forget the session; other events and other sessions do not", async () => {
    let text = LEAD;
    const { srv, lead } = leadWith({ "GET /api/agents/lead-brief": () => ({ body: { text } }) });
    await lead.onContext(ev("ses_a"));
    await lead.onContext(ev("ses_b"));
    lead.onEvent({ type: "session.text.delta", data: { sessionID: "ses_a" } });
    lead.onEvent({ type: "session.compaction.failed", data: { sessionID: "ses_a" } });
    await lead.onContext(ev("ses_a"));
    assert.equal(srv.calls.length, 2, "a failed compaction forgets nothing");
    text = "NEW ROSTER";
    lead.onEvent({ type: "session.compacted", data: { sessionID: "ses_a" } });
    const a = ev("ses_a");
    await lead.onContext(a);
    assert.equal(texts(a.system).at(-1), "NEW ROSTER", "refetched after the compaction");
    const b = ev("ses_b");
    await lead.onContext(b);
    assert.equal(texts(b.system).at(-1), LEAD, "another session keeps its bytes");
    lead.onEvent({ type: "session.deleted", data: { sessionID: "ses_b" } });
    await lead.onContext(ev("ses_b"));
    assert.equal(srv.calls.filter((c) => c.query.sessionID === "ses_b").length, 2);
  });

  test("an answer fetched across a compaction is used for that request but not kept", async () => {
    let n = 0;
    const { srv, lead } = leadWith({
      "GET /api/agents/lead-brief": async () => {
        n++;
        await sleep(15);
        return { body: { text: `v${n}` } };
      },
    });
    const e = ev("ses_a");
    const pending = lead.onContext(e);
    lead.onEvent({ type: "session.compacted", data: { sessionID: "ses_a" } });
    await pending;
    assert.equal(texts(e.system).at(-1), "v1");
    const next = ev("ses_a");
    await lead.onContext(next);
    assert.equal(texts(next.system).at(-1), "v2", "asked again");
    assert.equal(srv.calls.length, 2);
  });

  test("the cache is bounded (least recently used sessions are forgotten)", async () => {
    const { srv, lead } = leadWith({ "GET /api/agents/lead-brief": () => ({ body: { text: LEAD } }) });
    for (let i = 0; i < 520; i++) await lead.onContext(ev(`ses_${i}`));
    const before = srv.calls.length;
    await lead.onContext(ev("ses_519"));
    assert.equal(srv.calls.length, before, "a recent session is still cached");
    await lead.onContext(ev("ses_0"));
    assert.equal(srv.calls.length, before + 1, "the oldest was forgotten");
  });
});

describe("plugin entry: one composed context hook", () => {
  function pluginCtx(events = []) {
    const hooks = {};
    return {
      hooks,
      location: { directory: "/work/proj" },
      tool: { transform: async (cb) => cb({ add() {} }) },
      session: { hook: async (kind, fn, opts) => void (hooks[kind] = { fn, opts }) },
      event: { subscribe: () => (async function* () { for (const e of events) yield e; })() },
    };
  }
  const routes = (over = {}) => ({
    "GET /api/agents/lead-brief": () => ({ body: { text: LEAD } }),
    "GET /api/knowledge/briefing": () => ({ body: { text: KNOWLEDGE, token: "tok1" } }),
    "POST /api/knowledge/briefing/ack": () => ({ body: { ok: true } }),
    "POST /api/knowledge/briefing/reset": () => ({ body: { ok: true } }),
    ...over,
  });

  test("registers exactly one context hook and the compaction hook (never title / generate)", async () => {
    const ctx = pluginCtx();
    await pluginDef.setup(ctx);
    assert.deepEqual(Object.keys(ctx.hooks).sort(), ["compaction", "context"]);
    assert.equal(ctx.hooks.context.opts, undefined, "no providerID filter");
  });

  test("lead text first, then the knowledge briefing, after the existing blocks; both byte-stable on the next request", async () => {
    const srv = fakeServer(routes());
    globalThis.fetch = srv.fetchFn;
    const ctx = pluginCtx();
    await pluginDef.setup(ctx);
    const first = ev("ses_a", [IDENTITY, { type: "text", text: "prompt" }]);
    await ctx.hooks.context.fn(first);
    assert.deepEqual(texts(first.system), [IDENTITY.text, "prompt", LEAD, KNOWLEDGE]);
    const second = ev("ses_a", [IDENTITY, { type: "text", text: "prompt" }]);
    await ctx.hooks.context.fn(second);
    assert.deepEqual(texts(second.system), texts(first.system));
  });

  test("each fails open alone: a dead lead endpoint still gets the briefing, and the reverse", async () => {
    let srv = fakeServer(routes({ "GET /api/agents/lead-brief": () => ({ status: 503, body: { error: "x" } }) }));
    globalThis.fetch = srv.fetchFn;
    let ctx = pluginCtx();
    await pluginDef.setup(ctx);
    let e = ev("ses_a");
    await ctx.hooks.context.fn(e);
    assert.deepEqual(texts(e.system), [IDENTITY.text, KNOWLEDGE]);

    srv = fakeServer(routes({ "GET /api/knowledge/briefing": () => ({ status: 500, body: {} }) }));
    globalThis.fetch = srv.fetchFn;
    ctx = pluginCtx();
    await pluginDef.setup(ctx);
    e = ev("ses_b");
    await ctx.hooks.context.fn(e);
    assert.deepEqual(texts(e.system), [IDENTITY.text, LEAD]);
  });

  test("the plugin's event stream reaches the lead (an unrelated session's compaction keeps this session's cached bytes)", async () => {
    let text = LEAD;
    const srv = fakeServer(routes({ "GET /api/agents/lead-brief": () => ({ body: { text } }) }));
    globalThis.fetch = srv.fetchFn;
    const ctx = pluginCtx([{ type: "session.compacted", data: { sessionID: "ses_other" } }]);
    await pluginDef.setup(ctx);
    await sleep(20);
    const e = ev("ses_a");
    await ctx.hooks.context.fn(e);
    text = "CHANGED";
    const again = ev("ses_a");
    await ctx.hooks.context.fn(again);
    assert.equal(texts(again.system).includes(LEAD), true, "cached bytes until a compaction");
    assert.equal(srv.calls.filter((c) => c.path === "/api/agents/lead-brief").length, 1);
  });
});

describe("agent_handoff tool", () => {
  const tool = allTools.find((t) => t.name === "agent_handoff");
  const CTX = { sessionID: "ses_t1", messageID: "msg_1", callID: "call_9", directory: "/work/proj" };
  function server(status, body) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ method: init.method, path: new URL(String(url)).pathname, headers: { ...init.headers }, body: init.body ? JSON.parse(init.body) : undefined });
      if (status === "throw") throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify(body), { status });
    };
    return calls;
  }

  test("registered with the pinned input: agent, title, brief required; continueJob optional and LAST", () => {
    assert.ok(tool);
    assert.deepEqual(Object.keys(tool.input.properties), ["agent", "title", "brief", "continueJob"]);
    assert.deepEqual([...tool.input.required].sort(), ["agent", "brief", "title"]);
    assert.equal(tool.input.additionalProperties, false);
    assert.match(tool.description, /Hand a piece of real work to one of your team's agents/);
    assert.match(tool.description, /do not guess it/);
  });

  test("posts the call identity and the arguments; returns the pinned sentence on ok", async () => {
    const calls = server(200, { ok: true, jobId: "ab12cd34", agentName: "Dev" });
    const out = await tool.execute({ agent: "dev", title: "Fix login", brief: "Fix it." }, CTX);
    assert.equal(out, "Handed to Dev (job ab12cd34). Its result will arrive as a later message; tell the user in one line and stop.");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].path, "/api/agents/handoff");
    assert.deepEqual(calls[0].body, { sessionID: "ses_t1", messageID: "msg_1", callID: "call_9", agent: "dev", title: "Fix login", brief: "Fix it." });
    assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
  });

  test("continueJob is forwarded only when given", async () => {
    const calls = server(200, { ok: true, jobId: "x", agentName: "Dev" });
    await tool.execute({ agent: "dev", title: "t", brief: "b", continueJob: "abcd1234" }, CTX);
    assert.equal(calls[0].body.continueJob, "abcd1234");
  });

  test("a refusal is relayed as a sentence, never thrown; so is a transport / HTTP failure", async () => {
    server(200, { ok: false, error: "Only the lead can hand off work" });
    assert.equal(await tool.execute({ agent: "dev", title: "t", brief: "b" }, CTX), "Not handed off: Only the lead can hand off work");
    server(500, { error: "kaboom" });
    assert.equal(await tool.execute({ agent: "dev", title: "t", brief: "b" }, CTX), "Not handed off: kaboom");
    server("throw");
    assert.match(await tool.execute({ agent: "dev", title: "t", brief: "b" }, CTX), /^Not handed off: /);
    server(200, {});
    assert.match(await tool.execute({ agent: "dev", title: "t", brief: "b" }, CTX), /^Not handed off: /);
  });

  test("resolveToolContext keeps the execute context's call id", async () => {
    const c = await resolveToolContext({ location: { directory: "/d" } }, { sessionID: "s", messageID: "m", id: "call_1" });
    assert.deepEqual(c, { sessionID: "s", messageID: "m", callID: "call_1", directory: "/d" });
    assert.equal((await resolveToolContext({ location: { directory: "/d" } }, { sessionID: "s" })).callID, undefined);
  });
});

describe("routine tools: agent", () => {
  const create = allTools.find((t) => t.name === "routine_create");
  const update = allTools.find((t) => t.name === "routine_update");
  const CTX = { sessionID: "ses_t1", messageID: "msg_1", directory: "/work/proj" };
  function server(body) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ method: init.method, path: new URL(String(url)).pathname, body: init.body ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify(body), { status: 200 });
    };
    return calls;
  }
  const routine = { routine: { id: "r1", name: "Daily", cron: "0 9 * * *", enabled: true, nextRunAt: 1 } };

  test("the schema carries an optional, nullable agent (optional keys stay after the required ones)", () => {
    for (const t of [create, update]) {
      assert.deepEqual(t.input.properties.agent.type, ["string", "null"]);
      assert.ok(!t.input.required.includes("agent"));
    }
    const keys = Object.keys(create.input.properties);
    assert.deepEqual(keys.slice(0, 3), ["name", "prompt", "cron"]);
    assert.deepEqual(create.input.required, ["name", "prompt", "cron"]);
  });

  test("create passes a given agent and omits it otherwise", async () => {
    let calls = server(routine);
    await create.execute({ name: "Daily", prompt: "p", cron: "0 9 * * *", agent: "seo" }, CTX);
    assert.equal(calls[0].body.agent, "seo");
    calls = server(routine);
    await create.execute({ name: "Daily", prompt: "p", cron: "0 9 * * *" }, CTX);
    assert.equal("agent" in calls[0].body, false);
  });

  test("update passes the agent through, null included (null clears it)", async () => {
    let calls = server(routine);
    await update.execute({ id: "abcd1234", agent: null }, CTX);
    assert.deepEqual(calls[0].body, { agent: null });
    calls = server(routine);
    await update.execute({ id: "abcd1234", agent: "dev", name: "N" }, CTX);
    assert.deepEqual(calls[0].body, { agent: "dev", name: "N" });
    calls = server(routine);
    await update.execute({ id: "abcd1234", name: "N" }, CTX);
    assert.deepEqual(calls[0].body, { name: "N" }, "omitted = unchanged");
  });
});
