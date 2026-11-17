// Shared-knowledge plugin half (spec docs/superpowers/specs/2026-11-16-shared-knowledge.md §7.1, §11.2, §11.3):
//   - the briefing: appended after existing system blocks, acked once, timeout → no ack,
//     compaction reset, byte-identical re-append, prefetch from session.created, wiring in the plugin entry;
//   - the knowledge_* tools: requests, output text, error mapping.
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

const TOKEN = "ef56".repeat(8);
process.env.MANTA_SERVER_URL = "http://manta.test";
process.env.MANTA_BOX_TOKEN = TOKEN;

const tree = await transpileTree(MANTA_DIR, { rewrite: stub });
after(() => tree.cleanup());
const imp = (rel) => import(pathToFileURL(join(tree.dir, rel)).href);
const { createBriefing, installBriefing } = await imp("lib/briefing.mjs");
const { allTools } = await imp("tools/index.mjs");
const pluginDef = (await imp("index.mjs")).default;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IDENTITY = { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." };
const BRIEF = "Standing rules from the user for this project:\n- use pnpm\n\nReference notes from earlier sessions.";

/** A fake manta-server for the briefing routes; `routes` maps "METHOD /path" → handler(req) → {status, body} | Promise. */
function fakeServer(routes) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = { method: init.method ?? "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), headers: { ...init.headers }, body };
    calls.push(call);
    const h = routes[`${call.method} ${call.path}`];
    if (!h) return new Response("{}", { status: 404 });
    const out = await h(call);
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
  };
  return { calls, fetchFn };
}

function briefingWith(routes, extra = {}) {
  const srv = fakeServer(routes);
  const b = createBriefing({
    fetch: srv.fetchFn,
    base: () => "http://manta.test",
    headers: (body) => ({ ...(body ? { "content-type": "application/json" } : {}), authorization: `Bearer ${TOKEN}` }),
    directory: () => "/work/proj",
    waitMs: 80,
    ...extra,
  });
  return { b, ...srv };
}

const ok = (body) => () => ({ status: 200, body });
const ev = (system, extra = {}) => ({ sessionID: "ses_a", system, messages: [], ...extra });
const count = (calls, route) => calls.filter((c) => `${c.method} ${c.path}` === route).length;

describe("briefing delivery", () => {
  test("appends AFTER the existing system blocks (identity stays first) and acks once", async () => {
    const { b, calls } = briefingWith({
      "GET /api/knowledge/briefing": ok({ text: BRIEF, token: "tok1" }),
      "POST /api/knowledge/briefing/ack": ok({ ok: true }),
    });
    const system = [IDENTITY, { type: "text", text: "agent prompt" }];
    await b.onContext(ev(system));
    assert.deepEqual(system, [IDENTITY, { type: "text", text: "agent prompt" }, { type: "text", text: BRIEF }]);
    await b.flush();
    const get = calls.find((c) => c.method === "GET");
    assert.deepEqual(get.query, { sessionID: "ses_a", assistantMessages: "0", directory: "/work/proj" });
    assert.equal(get.headers.authorization, `Bearer ${TOKEN}`);
    const ack = calls.find((c) => c.path.endsWith("/ack"));
    assert.deepEqual(ack.body, { sessionID: "ses_a", token: "tok1" });
  });

  test("later requests append the SAME bytes again without refetching or re-acking", async () => {
    const { b, calls } = briefingWith({
      "GET /api/knowledge/briefing": ok({ text: BRIEF, token: "tok1" }),
      "POST /api/knowledge/briefing/ack": ok({ ok: true }),
    });
    const first = [IDENTITY];
    await b.onContext(ev(first));
    await b.flush();
    const second = [IDENTITY, { type: "text", text: "agent prompt" }];
    await b.onContext(ev(second, { messages: [{ role: "user" }, { role: "assistant" }, { role: "user" }, { role: "assistant" }] }));
    assert.equal(second[2].text, BRIEF);
    assert.equal(count(calls, "GET /api/knowledge/briefing"), 1);
    assert.equal(count(calls, "POST /api/knowledge/briefing/ack"), 1);
    // the same event passed twice never doubles the block
    await b.onContext(ev(second));
    assert.equal(second.filter((x) => x.text === BRIEF).length, 1);
  });

  test("a failed ack is retried on the next request; a 409 is final", async () => {
    let status = 500;
    const { b, calls } = briefingWith({
      "GET /api/knowledge/briefing": ok({ text: BRIEF, token: "tok1" }),
      "POST /api/knowledge/briefing/ack": () => ({ status, body: {} }),
    });
    await b.onContext(ev([IDENTITY]));
    await b.flush();
    status = 409;
    await b.onContext(ev([IDENTITY]));
    await b.flush();
    await b.onContext(ev([IDENTITY]));
    await b.flush();
    assert.equal(count(calls, "POST /api/knowledge/briefing/ack"), 2);
  });

  test("a prefetch still pending after the wait is abandoned: nothing appended, no ack, no retry this start", async () => {
    const { b, calls } = briefingWith({
      "GET /api/knowledge/briefing": async () => {
        await sleep(300);
        return { status: 200, body: { text: BRIEF, token: "tok1" } };
      },
      "POST /api/knowledge/briefing/ack": ok({ ok: true }),
    });
    const system = [IDENTITY];
    const t0 = Date.now();
    await b.onContext(ev(system));
    assert.ok(Date.now() - t0 < 250, "the request is released at the wait, not at the server's pace");
    assert.deepEqual(system, [IDENTITY]);
    await sleep(350); // the abandoned answer arrives late
    await b.onContext(ev(system));
    await b.flush();
    assert.deepEqual(system, [IDENTITY], "a late answer is not used");
    assert.equal(count(calls, "POST /api/knowledge/briefing/ack"), 0);
    assert.equal(count(calls, "GET /api/knowledge/briefing"), 1);
  });

  test("server failure → no briefing now, retried on the next request", async () => {
    let fail = true;
    const { b, calls } = briefingWith({
      "GET /api/knowledge/briefing": () => (fail ? { status: 500, body: { text: "", token: null } } : { status: 200, body: { text: BRIEF, token: "t" } }),
      "POST /api/knowledge/briefing/ack": ok({ ok: true }),
    });
    const s1 = [IDENTITY];
    await b.onContext(ev(s1));
    assert.deepEqual(s1, [IDENTITY]);
    fail = false;
    const s2 = [IDENTITY];
    await b.onContext(ev(s2));
    await b.flush();
    assert.equal(s2.length, 2);
    assert.equal(count(calls, "GET /api/knowledge/briefing"), 2);
  });

  test("an empty answer (excluded session, disabled) appends nothing, acks nothing and is not refetched", async () => {
    const { b, calls } = briefingWith({
      "GET /api/knowledge/briefing": ok({ text: "", token: "t0" }),
    });
    const system = [IDENTITY];
    await b.onContext(ev(system));
    await b.onContext(ev(system));
    assert.deepEqual(system, [IDENTITY]);
    assert.equal(count(calls, "GET /api/knowledge/briefing"), 1);
    assert.equal(count(calls, "POST /api/knowledge/briefing/ack"), 0);
  });

  test("a session already past its first assistant message reports the real count", async () => {
    const { b, calls } = briefingWith({
      "GET /api/knowledge/briefing": ok({ text: "", token: "t0" }),
    });
    await b.onContext(ev([IDENTITY], { messages: [{ role: "assistant" }, { role: "user" }, { role: "assistant" }, { role: "assistant" }] }));
    assert.equal(calls[0].query.assistantMessages, "3");
  });

  test("a compaction resets only once it COMPLETED (session.compacted); the hook alone resets nothing", async () => {
    let n = 0;
    const { b, calls } = briefingWith({
      "GET /api/knowledge/briefing": () => ({ status: 200, body: { text: `${BRIEF} v${++n}`, token: `tok${n}` } }),
      "POST /api/knowledge/briefing/ack": ok({ ok: true }),
      "POST /api/knowledge/briefing/reset": ok({ ok: true }),
    });
    b.setEventsLive(true);
    await b.onContext(ev([IDENTITY]));
    await b.flush();
    await b.onCompaction({ sessionID: "ses_a", system: [] });
    assert.equal(count(calls, "POST /api/knowledge/briefing/reset"), 0, "the compaction began: nothing is reset yet");
    await b.onCompactionEnded("ses_a");
    assert.equal(count(calls, "POST /api/knowledge/briefing/reset"), 1);
    const system = [IDENTITY];
    await b.onContext(ev(system));
    await b.flush();
    assert.equal(system[1].text, `${BRIEF} v2`, "after the compaction completed the next request starts fresh");
    assert.deepEqual(calls.filter((c) => c.path.endsWith("/reset")).map((c) => c.body), [{ sessionID: "ses_a" }]);
    assert.deepEqual(calls.filter((c) => c.path.endsWith("/ack")).map((c) => c.body.token), ["tok1", "tok2"]);
  });

  test("a compaction that FAILED never resets, and the briefing stays byte-identical", async () => {
    const { b, calls } = briefingWith({
      "GET /api/knowledge/briefing": ok({ text: BRIEF, token: "tok1" }),
      "POST /api/knowledge/briefing/ack": ok({ ok: true }),
      "POST /api/knowledge/briefing/reset": ok({ ok: true }),
    });
    b.setEventsLive(true);
    await b.onContext(ev([IDENTITY]));
    await b.flush();
    await b.onCompaction({ sessionID: "ses_a" });
    b.onCompactionFailed("ses_a");
    const system = [IDENTITY];
    await b.onContext(ev(system, { messages: [{ role: "assistant" }, { role: "assistant" }, { role: "assistant" }] }));
    assert.equal(system[1].text, BRIEF);
    assert.equal(count(calls, "POST /api/knowledge/briefing/reset"), 0);
    assert.equal(count(calls, "GET /api/knowledge/briefing"), 1);
  });

  test("without the event stream the first request after a compaction event is the reset point (documented fallback)", async () => {
    let n = 0;
    const { b, calls } = briefingWith({
      "GET /api/knowledge/briefing": () => ({ status: 200, body: { text: `${BRIEF} v${++n}`, token: `tok${n}` } }),
      "POST /api/knowledge/briefing/ack": ok({ ok: true }),
      "POST /api/knowledge/briefing/reset": ok({ ok: true }),
    });
    await b.onContext(ev([IDENTITY]));
    await b.flush();
    await b.onCompaction({ sessionID: "ses_a", system: [] });
    assert.equal(count(calls, "POST /api/knowledge/briefing/reset"), 0);
    const system = [IDENTITY];
    await b.onContext(ev(system));
    await b.flush();
    assert.equal(count(calls, "POST /api/knowledge/briefing/reset"), 1);
    assert.equal(system[1].text, `${BRIEF} v2`);
  });

  test("a reset still in flight is awaited before the next briefing is fetched", async () => {
    const order = [];
    let n = 0;
    const { b } = briefingWith({
      "GET /api/knowledge/briefing": () => { order.push("get"); return { status: 200, body: { text: `${BRIEF} v${++n}`, token: `tok${n}` } }; },
      "POST /api/knowledge/briefing/ack": ok({ ok: true }),
      "POST /api/knowledge/briefing/reset": async () => { order.push("reset:start"); await sleep(80); order.push("reset:done"); return { status: 200, body: { ok: true } }; },
    });
    await b.onContext(ev([IDENTITY]));
    await b.flush();
    order.length = 0;
    void b.onCompactionEnded("ses_a"); // not awaited: the reset is on its way
    await b.onContext(ev([IDENTITY]));
    assert.deepEqual(order, ["reset:start", "reset:done", "get"]);
  });

  test("completion also clears an abandoned start", async () => {
    let slow = true;
    const { b } = briefingWith({
      "GET /api/knowledge/briefing": async () => {
        if (slow) await sleep(300);
        return { status: 200, body: { text: BRIEF, token: "t" } };
      },
      "POST /api/knowledge/briefing/ack": ok({ ok: true }),
      "POST /api/knowledge/briefing/reset": ok({ ok: true }),
    });
    await b.onContext(ev([IDENTITY]));
    slow = false;
    await b.onCompactionEnded("ses_a");
    const system = [IDENTITY];
    await b.onContext(ev(system));
    assert.equal(system.length, 2);
  });

  test("the empty / abandoned memories are bounded (LRU): a long-lived server does not grow them forever", async () => {
    const { b, calls } = briefingWith({ "GET /api/knowledge/briefing": ok({ text: "", token: null }) });
    for (let i = 0; i < 600; i++) await b.onContext({ sessionID: `ses_${i}`, system: [IDENTITY], messages: [] });
    assert.equal(calls.length, 600);
    await b.onContext({ sessionID: "ses_599", system: [IDENTITY], messages: [] });
    assert.equal(calls.length, 600, "a recent session is still remembered");
    await b.onContext({ sessionID: "ses_0", system: [IDENTITY], messages: [] });
    assert.equal(calls.length, 601, "the oldest was forgotten (asked again, not leaked)");
  });

  test("a deliberate empty (2xx, text '' — even with no token) is cached: ONE fetch over three requests; a transport/HTTP failure is retried", async () => {
    const { b, calls } = briefingWith({
      "GET /api/knowledge/briefing": ok({ text: "", token: null }),
    });
    const system = [IDENTITY];
    for (let i = 0; i < 3; i++) await b.onContext(ev(system));
    assert.deepEqual(system, [IDENTITY]);
    assert.equal(count(calls, "GET /api/knowledge/briefing"), 1);
    assert.equal(count(calls, "POST /api/knowledge/briefing/ack"), 0);

    let status = 500;
    const f = briefingWith({ "GET /api/knowledge/briefing": () => ({ status, body: {} }) });
    await f.b.onContext(ev([IDENTITY]));
    await f.b.onContext(ev([IDENTITY]));
    assert.equal(count(f.calls, "GET /api/knowledge/briefing"), 2, "an HTTP failure is not a verdict");
    status = 200;
  });

  test("session.created prefetch is used by the first context call (no second GET)", async () => {
    const { b, calls } = briefingWith({
      "GET /api/knowledge/briefing": ok({ text: BRIEF, token: "tok1" }),
      "POST /api/knowledge/briefing/ack": ok({ ok: true }),
    });
    b.onSessionCreated({ sessionID: "ses_a", location: { directory: "/work/proj" } });
    const system = [IDENTITY];
    await b.onContext(ev(system));
    await b.flush();
    assert.equal(system[1].text, BRIEF);
    assert.equal(count(calls, "GET /api/knowledge/briefing"), 1);
  });

  test("a prefetch made for another directory (job moved into its worktree) is not reused", async () => {
    const { b, calls } = briefingWith({
      "GET /api/knowledge/briefing": ok({ text: BRIEF, token: "tok1" }),
      "POST /api/knowledge/briefing/ack": ok({ ok: true }),
    });
    b.onSessionCreated({ sessionID: "ses_a", location: { directory: "/work/parent" } });
    await b.onContext(ev([IDENTITY]));
    await b.flush();
    assert.deepEqual(calls.filter((c) => c.method === "GET").map((c) => c.query.directory), ["/work/parent", "/work/proj"]);
  });

  test("a prefetch is not reused once the conversation has several assistant messages", async () => {
    const { b, calls } = briefingWith({
      "GET /api/knowledge/briefing": ok({ text: "", token: "t" }),
    });
    b.onSessionCreated({ sessionID: "ses_a", location: { directory: "/work/proj" } });
    await b.onContext(ev([IDENTITY], { messages: [{ role: "assistant" }, { role: "assistant" }] }));
    assert.deepEqual(calls.map((c) => c.query.assistantMessages), ["0", "2"]);
  });

  test("never throws on malformed events", async () => {
    const { b } = briefingWith({});
    await b.onContext(undefined);
    await b.onContext({ sessionID: "x" });
    await b.onContext({ system: [] });
    await b.onCompaction(null);
    b.onSessionCreated(null);
  });

  test("a server that cannot be reached leaves the request untouched", async () => {
    const b = createBriefing({
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      base: () => "http://manta.test",
      headers: () => ({}),
      directory: () => undefined,
      waitMs: 50,
    });
    const system = [IDENTITY];
    await b.onContext(ev(system));
    assert.deepEqual(system, [IDENTITY]);
  });
});

describe("installBriefing / plugin entry wiring", () => {
  function pluginCtx(events = []) {
    const hooks = {};
    return {
      hooks,
      location: { directory: "/work/proj" },
      tool: { transform: async (cb) => cb({ add() {} }) },
      session: { hook: async (kind, fn, opts) => void (hooks[kind] = { fn, opts }) },
      event: {
        subscribe: () =>
          (async function* () {
            for (const e of events) yield e;
          })(),
      },
    };
  }

  test("registers ONLY the context and compaction hooks (never title / generate), for every provider", async () => {
    const ctx = pluginCtx();
    await pluginDef.setup(ctx);
    assert.deepEqual(Object.keys(ctx.hooks).sort(), ["compaction", "context"]);
    assert.equal(ctx.hooks.context.opts, undefined, "no providerID filter");
  });

  test("a plugin context without session hooks still registers the tools", async () => {
    const added = [];
    await pluginDef.setup({ tool: { transform: async (cb) => cb({ add: (t) => added.push(t) }) } });
    assert.ok(added.some((t) => t.name === "knowledge_search"));
  });

  test("session.created from the event stream warms the briefing; the hook appends it", async () => {
    const srv = fakeServer({
      "GET /api/knowledge/briefing": ok({ text: BRIEF, token: "tok1" }),
      "POST /api/knowledge/briefing/ack": ok({ ok: true }),
      "POST /api/knowledge/briefing/reset": ok({ ok: true }),
    });
    globalThis.fetch = srv.fetchFn;
    const ctx = pluginCtx([
      { type: "session.created", data: { sessionID: "ses_a", location: { directory: "/work/proj" } } },
      { type: "session.created", data: { sessionID: "ses_other", location: { directory: "/elsewhere" } } },
      { type: "session.text.delta", data: {} },
    ]);
    await installBriefing(ctx);
    await sleep(20);
    assert.deepEqual(srv.calls.map((c) => c.query.sessionID), ["ses_a"], "events for other directories are ignored");
    const system = [IDENTITY, { type: "text", text: "prompt" }];
    await ctx.hooks.context.fn({ sessionID: "ses_a", system, messages: [] });
    assert.deepEqual(system.map((b) => b.text), [IDENTITY.text, "prompt", BRIEF]);
    assert.equal(count(srv.calls, "GET /api/knowledge/briefing"), 1);
    await ctx.hooks.compaction.fn({ sessionID: "ses_a", system: [] });
    assert.equal(count(srv.calls, "POST /api/knowledge/briefing/reset"), 0, "the hook alone does not reset");
  });

  test("session.compacted from the event stream posts the reset (compaction.failed resets nothing)", async () => {
    const srv = fakeServer({
      "GET /api/knowledge/briefing": ok({ text: BRIEF, token: "tok1" }),
      "POST /api/knowledge/briefing/ack": ok({ ok: true }),
      "POST /api/knowledge/briefing/reset": ok({ ok: true }),
    });
    globalThis.fetch = srv.fetchFn;
    const ctx = pluginCtx([
      { type: "session.compaction.failed", data: { sessionID: "ses_f" } },
      { type: "session.compaction.ended", data: { sessionID: "ses_x" } }, // not the box's end-of-compaction event: ignored
      { type: "session.compacted", data: { sessionID: "ses_a" } },
    ]);
    await installBriefing(ctx);
    await sleep(20);
    const resets = srv.calls.filter((c) => c.path.endsWith("/reset"));
    assert.deepEqual(resets.map((c) => c.body), [{ sessionID: "ses_a" }]);
    assert.equal(resets[0].headers.authorization, `Bearer ${TOKEN}`);
  });
});

// ------------------------------------------------------------------ tools

const CTX = { sessionID: "ses_t1", messageID: "msg_1", directory: "/work/proj" };
const tool = (name) => allTools.find((t) => t.name === name);

function toolServer(status, body) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: { ...init.headers }, body: init.body ? JSON.parse(init.body) : undefined });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return calls;
}

describe("knowledge tools: registration", () => {
  test("three tools with the §11.3 inputs", () => {
    const note = tool("knowledge_note");
    assert.deepEqual([...note.input.required].sort(), ["kind", "refs", "text"]);
    assert.deepEqual(note.input.properties.kind.enum, ["howto", "gotcha", "decision", "preference", "status"]);
    assert.equal(note.input.properties.text.maxLength, 400);
    assert.equal(note.input.properties.refs.minItems, 1);
    assert.equal(note.input.properties.refs.maxItems, 8);
    const search = tool("knowledge_search");
    assert.deepEqual(search.input.required, ["query"]);
    assert.equal(search.input.properties.limit.maximum, 20);
    assert.deepEqual(search.input.properties.scope.enum, ["project", "all"]);
    assert.ok(search.description.includes("Before non-trivial work, or when the user mentions something done before, search first."));
    assert.deepEqual(tool("knowledge_read").input.required, ["ref"]);
    assert.match(note.description, /refs are REQUIRED/i);
    assert.equal(note.input.additionalProperties, false);
  });
});

describe("knowledge_note", () => {
  test("POSTs the §11.2 payload with bearer auth; accepted → Noted.", async () => {
    const calls = toolServer(200, { accepted: true, id: "n_01" });
    const out = await tool("knowledge_note").execute({ kind: "gotcha", text: " tests need node 24 ", refs: ["commit:c4bbd906"] }, CTX);
    assert.equal(out, "Noted.");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].path, "/api/knowledge/notes");
    assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(calls[0].body, { sessionID: "ses_t1", kind: "gotcha", text: "tests need node 24", refs: ["commit:c4bbd906"] });
  });

  test("accepted:false carries the server's reason", async () => {
    toolServer(200, { accepted: false, reason: "duplicate of a recent note" });
    assert.equal(await tool("knowledge_note").execute({ kind: "howto", text: "x", refs: ["file:/a"] }, CTX), "Not noted: duplicate of a recent note");
  });

  test("missing refs / bad text never reach the server", async () => {
    const calls = toolServer(200, {});
    const t = tool("knowledge_note");
    assert.match(await t.execute({ kind: "howto", text: "x", refs: [] }, CTX), /^Not noted: attach 1–8 refs/);
    assert.match(await t.execute({ kind: "howto", text: "x".repeat(401), refs: ["file:/a"] }, CTX), /^Not noted: text must be 1–400/);
    assert.match(await t.execute({ kind: "howto", text: "x", refs: Array(9).fill("file:/a") }, CTX), /^Not noted: attach 1–8 refs/);
    assert.match(await t.execute({ kind: "bogus", text: "x", refs: ["file:/a"] }, CTX), /^Not noted: kind must be/);
    assert.equal(calls.length, 0);
  });

  test("server errors become text, never a throw", async () => {
    const t = tool("knowledge_note");
    const args = { kind: "howto", text: "x", refs: ["file:/a"] };
    toolServer(503, { error: "disabled" });
    assert.match(await t.execute(args, CTX), /^Not noted: Shared knowledge is switched off/);
    toolServer(400, { error: "invalid-note", reason: "ref grammar" });
    assert.match(await t.execute(args, CTX), /^Not noted: the note was rejected \(ref grammar\)/);
    toolServer(500, "boom");
    assert.match(await t.execute(args, CTX), /^Not noted: the knowledge service failed \(boom\)/);
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    assert.match(await t.execute(args, CTX), /^Not noted: The knowledge service is not reachable/);
  });
});

describe("knowledge_search", () => {
  test("sends the query params and renders hits with refs", async () => {
    const calls = toolServer(200, {
      hits: [
        { source: "wiki", project: "manta-1a2b3c4d5e", title: "Release and rollback", snippet: "tag server-v*\n then verify", ref: "page:projects/manta/release.md", at: "2026-11-10T08:00:00Z" },
        { source: "sessions", project: "manta-1a2b3c4d5e", title: "deploy chat", snippet: "we pushed it", ref: "msg:ses_1/msg_2", at: 1_700_000_000_000 },
      ],
      truncated: true,
    });
    const out = await tool("knowledge_search").execute({ query: " how to release ", scope: "all", sources: ["wiki", "sessions", "wiki"], limit: 50 }, CTX);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].path, "/api/knowledge/search");
    assert.deepEqual(calls[0].query, { sessionID: "ses_t1", query: "how to release", scope: "all", sources: "wiki,sessions", limit: "20" });
    assert.match(out, /^2 hits \(scope: all\)/);
    assert.match(out, /1\. \[wiki · manta-1a2b3c4d5e\] Release and rollback\n   tag server-v\* then verify\n   ref: page:projects\/manta\/release\.md · 2026-11-10/);
    assert.match(out, /ref: msg:ses_1\/msg_2 · 2023-11-14/);
    assert.match(out, /more results exist/);
  });

  test("defaults: scope project, no sources/limit params; empty result guides the next try", async () => {
    const calls = toolServer(200, { hits: [], truncated: false });
    const out = await tool("knowledge_search").execute({ query: "x" }, CTX);
    assert.deepEqual(calls[0].query, { sessionID: "ses_t1", query: "x", scope: "project" });
    assert.match(out, /^No matches in this project\./);
  });

  test("errors → text", async () => {
    const t = tool("knowledge_search");
    toolServer(503, { error: "disabled" });
    assert.match(await t.execute({ query: "x" }, CTX), /^Search failed: Shared knowledge is switched off/);
    toolServer(400, { error: "invalid-query" });
    assert.match(await t.execute({ query: "x" }, CTX), /^Search failed: the query was rejected/);
    assert.match(await t.execute({ query: "" }, CTX), /^Invalid query/);
    assert.match(await t.execute({ query: "x".repeat(201) }, CTX), /^Invalid query/);
  });
});

describe("knowledge_read", () => {
  test("renders a page", async () => {
    const calls = toolServer(200, { kind: "page", title: "Release", body: "1. tag it", verified: "2026-11-01", sources: ["commit:abc1234"] });
    const out = await tool("knowledge_read").execute({ ref: "page:projects/m/release.md" }, CTX);
    assert.deepEqual(calls[0].query, { sessionID: "ses_t1", ref: "page:projects/m/release.md" });
    assert.equal(calls[0].path, "/api/knowledge/page");
    assert.equal(out, "# Release\nverified: 2026-11-01 · sources: commit:abc1234\n\n1. tag it");
  });

  test("renders a session neighborhood", async () => {
    toolServer(200, { kind: "session", sessionID: "ses_9", messages: [{ id: "msg_1", role: "user", text: "deploy it", at: "2026-11-02T10:00:00Z" }, { id: "msg_2", role: "assistant", text: "done", at: "2026-11-02T10:01:00Z" }] });
    const out = await tool("knowledge_read").execute({ ref: "msg:ses_9/msg_1" }, CTX);
    assert.match(out, /^Session ses_9/);
    assert.match(out, /\[user · 2026-11-02 · msg_1\] deploy it\n\[assistant · 2026-11-02 · msg_2\] done$/);
  });

  test("not-found / not-shared / disabled become text", async () => {
    const t = tool("knowledge_read");
    toolServer(404, { error: "not-found" });
    assert.match(await t.execute({ ref: "page:x" }, CTX), /^Read failed: Not found/);
    toolServer(403, { error: "not-shared" });
    assert.match(await t.execute({ ref: "page:x" }, CTX), /^Read failed: Not shared/);
    toolServer(503, { error: "disabled" });
    assert.match(await t.execute({ ref: "page:x" }, CTX), /^Read failed: Shared knowledge is switched off/);
    assert.match(await t.execute({ ref: " " }, CTX), /^Read failed: give the ref/);
  });
});
