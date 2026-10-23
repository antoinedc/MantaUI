import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "../shared/paths.mjs";
import {
  apiUrl,
  _setApiBase,
  opencodeAuthHeader,
  parseSseFrame,
  createSseFramer,
  createSession,
  sendPrompt,
  getAndClearSessionRefusal,
  getSessionAgent,
  getSessionDirectory,
  readSession,
  listMessages,
  getMessage,
  slimTranscript,
  stripDuplicateToolOutput,
  runCommand,
  forkSession,
  compactSession,
  abortSession,
  deleteSessionRaw,
  getSessionStatus,
  listSessionStatuses,
  listActiveSessionIds,
  readShellOutput,
  knownSessionDirectories,
  cachedSessionDirectory,
  listSessions,
  sessionExists,
  listPermissions,
  listQuestions,
  replyPermission,
  replyQuestion,
  rejectQuestion,
  subscribeEvents,
  interruptSession,
  listInbox,
  cancelInboxItem,
  getCommandCorrelator,
  setCommandCorrelator,
  _resetSessionDirectoryCache,
  _setOcTransport,
  _setEventStreamTransport,
  _getOcAgent,
  listReferences,
  findFiles,
  listCommands,
  listAgents,
  _pooledOcRequest,
  discardBody,
  getProviders,
  getDefaultModel,
  generateSessionTitle,
  generateText,
  pickCheapModel,
  runThrowawayAgent,
  estimateMessageListTokens,
  listModels,
  listRoutableModels,
  _normalizeProviderModel,
  claudeCliStatus,
  readProviderApiKey,
  readProviderOAuthToken,
  readAuthedProviderIds,
  setProviderApiKey,
  removeProviderAuth,
  listProviderAuthMethods,
  startProviderOauth,
  completeProviderOauth,
  readLiveCodexEntry,
  codexEntryFromCredential,
} from "./opencode.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// A tiny V2 router: `routes` maps "METHOD /path" (exact pathname) to a handler
// `({url, query, body}) => body | Response`. Everything not listed is a 599, so
// an unexpected request fails the test loudly. Every request is recorded.
// ---------------------------------------------------------------------------

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

async function withV2(routes, fn) {
  const calls = [];
  _setOcTransport(async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = { method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, headers: init.headers ?? {}, signal: init.signal };
    calls.push(call);
    const h = routes[`${method} ${u.pathname}`];
    if (h === undefined) return new Response(`unexpected ${method} ${u.pathname}`, { status: 599 });
    const out = typeof h === "function" ? await h(call) : h;
    if (out instanceof Response) return out;
    return out === undefined || out === null ? new Response(null, { status: 204 }) : json(out);
  });
  try {
    await fn(calls);
  } finally {
    _setOcTransport(null);
    _resetSessionDirectoryCache();
  }
  return calls;
}
const withMockFetch = (handler, fn) => {
  _setOcTransport(handler);
  return fn().finally(() => _setOcTransport(null));
};
const only = (calls, method, path) => calls.filter((c) => c.method === method && c.path === path);

const SESSION = (extra = {}) => ({
  id: "ses_a",
  projectID: "p",
  model: { providerID: "anthropic", id: "claude-haiku-4-5", variant: "default" },
  location: { directory: "/work/proj" },
  ...extra,
});

afterEach(() => {
  _setApiBase(null);
  delete process.env.MANTA_OPENCODE_PASSWORD;
});

// ---------------------------------------------------------------------------
// K1: endpoint + authentication
// ---------------------------------------------------------------------------

test("apiUrl targets local opencode port 4096 (V2 /api/* routes)", () => {
  assert.equal(apiUrl("/api/session"), "http://127.0.0.1:4096/api/session");
});

test("opencodeAuthHeader: MANTA_OPENCODE_PASSWORD overrides; Basic base64('opencode:'+password)", async () => {
  process.env.MANTA_OPENCODE_PASSWORD = "s3cret";
  assert.equal(await opencodeAuthHeader(), `Basic ${Buffer.from("opencode:s3cret").toString("base64")}`);
});

test("opencodeAuthHeader re-reads ~/.manta/opencode-password on EVERY call (file may appear after boot; nothing is cached)", async () => {
  const file = statePath("opencode-password");
  rmSync(file, { force: true });
  try {
    assert.equal(await opencodeAuthHeader(), undefined, "no file yet → no header, no throw");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "filepw\n", { mode: 0o600 });
    assert.equal(await opencodeAuthHeader(), `Basic ${Buffer.from("opencode:filepw").toString("base64")}`);
    writeFileSync(file, "changed\n");
    assert.equal(await opencodeAuthHeader(), `Basic ${Buffer.from("opencode:changed").toString("base64")}`, "a rotated password is picked up by the next call");
  } finally {
    rmSync(file, { force: true });
  }
});

test("every request carries the Authorization header; an explicit one is not overridden", async () => {
  process.env.MANTA_OPENCODE_PASSWORD = "pw";
  const want = `Basic ${Buffer.from("opencode:pw").toString("base64")}`;
  const calls = await withV2({ "GET /api/session/active": { data: {} } }, async () => {
    await listActiveSessionIds();
  });
  assert.equal(calls[0].headers.authorization, want);
});

test("the SSE request carries the Authorization header too", async () => {
  process.env.MANTA_OPENCODE_PASSWORD = "pw";
  let seen;
  _setEventStreamTransport(async (url, init) => {
    seen = { url: String(url), headers: init.headers };
    return { ok: false, status: 503, statusText: "x" };
  });
  const stop = subscribeEvents(() => {}, { reconnectMs: 60_000 });
  await new Promise((r) => setTimeout(r, 30));
  stop();
  _setEventStreamTransport(null);
  assert.equal(seen.url, "http://127.0.0.1:4096/api/event");
  assert.equal(seen.headers.authorization, `Basic ${Buffer.from("opencode:pw").toString("base64")}`);
});

test("_setApiBase points the client at another opencode (the sandbox smoke)", () => {
  _setApiBase("http://127.0.0.1:5555/");
  assert.equal(apiUrl("/api/info"), "http://127.0.0.1:5555/api/info");
});

test("parseSseFrame extracts JSON from data: lines; comments/heartbeats are null", () => {
  assert.equal(parseSseFrame('data: {"type":"x","a":1}').type, "x");
  assert.equal(parseSseFrame(": heartbeat"), null);
});

// ---------------------------------------------------------------------------
// auth-store readers (credentials live behind GET /api/credential now)
// ---------------------------------------------------------------------------

const creds = (list) => async () => list;

test("readProviderApiKey returns the ACTIVE key credential, else the first; '' when none / wrong type / unreadable", async () => {
  const list = [
    { id: "c1", integrationID: "kimi", active: false, value: { type: "key", key: "k-old" } },
    { id: "c2", integrationID: "kimi", active: true, value: { type: "key", key: "k-live" } },
    { id: "c3", integrationID: "openai", active: true, value: { type: "oauth", access: "a", refresh: "r", expires: 1 } },
  ];
  assert.equal(await readProviderApiKey("kimi", { listCredentials: creds(list) }), "k-live");
  assert.equal(await readProviderApiKey("openai", { listCredentials: creds(list) }), "", "an oauth credential never supplies a key");
  assert.equal(await readProviderApiKey("nobody", { listCredentials: creds(list) }), "");
  assert.equal(await readProviderApiKey("kimi", { listCredentials: async () => { throw new Error("down"); } }), "");
});

test("readProviderOAuthToken returns the access token of an oauth credential only", async () => {
  const list = [
    { id: "c1", integrationID: "openai", active: true, value: { type: "oauth", access: "tok", refresh: "r", expires: 1 } },
    { id: "c2", integrationID: "kimi", active: true, value: { type: "key", key: "k" } },
  ];
  assert.equal(await readProviderOAuthToken("openai", { listCredentials: creds(list) }), "tok");
  assert.equal(await readProviderOAuthToken("kimi", { listCredentials: creds(list) }), "");
  assert.equal(await readProviderOAuthToken("openai", { listCredentials: async () => { throw new Error("x"); } }), "");
});

test("readAuthedProviderIds lists the distinct integrations holding a credential; [] when unreadable", async () => {
  const list = [{ integrationID: "a" }, { integrationID: "b" }, { integrationID: "a" }];
  assert.deepEqual(await readAuthedProviderIds({ listCredentials: creds(list) }), ["a", "b"]);
  assert.deepEqual(await readAuthedProviderIds({ listCredentials: async () => { throw new Error("x"); } }), []);
});

test("the credential readers go through GET /api/credential by default", async () => {
  const calls = await withV2(
    { "GET /api/credential": { data: [{ id: "c", integrationID: "kimi", active: true, value: { type: "key", key: "KK" } }] } },
    async () => {
      assert.equal(await readProviderApiKey("kimi"), "KK");
    },
  );
  assert.equal(calls.length, 1);
});

// ---- the LIVE Codex login lives in V2's credential store, not in V1's auth.json -----------------

const cred = (over = {}) => ({ id: "cred_1", integrationID: "openai", label: "default", active: true, value: { type: "oauth", methodID: "chatgpt-token-sharing", refresh: "R", access: "A", expires: 123, metadata: { accountID: "acct-1" } }, ...over });

test("codexEntryFromCredential: V2 credential → the V1-shaped entry (metadata.accountID → accountId, enterpriseUrl kept)", () => {
  assert.deepEqual(codexEntryFromCredential(cred()), { type: "oauth", access: "A", refresh: "R", expires: 123, accountId: "acct-1" });
  assert.deepEqual(
    codexEntryFromCredential(cred({ value: { type: "oauth", methodID: "m", refresh: "R", access: "A", expires: 1, metadata: { enterpriseUrl: "https://e.example", accountID: "" } } })),
    { type: "oauth", access: "A", refresh: "R", expires: 1, enterpriseUrl: "https://e.example" },
    "an empty account id is not an id",
  );
  assert.deepEqual(codexEntryFromCredential(cred({ value: { type: "oauth", methodID: "m", refresh: "R", access: "A", expires: 1 } })), { type: "oauth", access: "A", refresh: "R", expires: 1 });
  // not a usable ChatGPT login
  for (const bad of [null, undefined, {}, cred({ value: { type: "key", key: "sk" } }), cred({ value: { type: "external", methodID: "x" } }), cred({ value: { type: "oauth", refresh: "R", access: "", expires: 1 } })]) {
    assert.equal(codexEntryFromCredential(bad), null);
  }
});

test("readLiveCodexEntry: the ACTIVE openai credential wins over stale (rotated-out) rows, whatever the order", async () => {
  const stale = (n) => cred({ id: `cred_old${n}`, active: false, value: { type: "oauth", methodID: "m", refresh: `OLD-R${n}`, access: `OLD-A${n}`, expires: 1, metadata: { accountID: "acct-1" } } });
  const live = cred({ id: "cred_live", value: { type: "oauth", methodID: "m", refresh: "LIVE-R", access: "LIVE-A", expires: 9, metadata: { accountID: "acct-1" } } });
  const other = cred({ id: "cred_x", integrationID: "anthropic", value: { type: "oauth", methodID: "m", refresh: "X", access: "X", expires: 1 } });
  for (const rows of [[stale(1), live, stale(2), other], [other, stale(1), stale(2), live], [live, stale(1)]]) {
    const e = await readLiveCodexEntry({ listCredentials: async () => rows });
    assert.equal(e.access, "LIVE-A");
    assert.equal(e.refresh, "LIVE-R");
  }
});

test("readLiveCodexEntry: no active openai oauth → null (none, only stale rows, an active API key, other providers); a failing store → null, never a throw", async () => {
  const none = (rows) => readLiveCodexEntry({ listCredentials: async () => rows });
  assert.equal(await none([]), null);
  assert.equal(await none([cred({ active: false })]), null, "inactive rows hold burned tokens");
  assert.equal(await none([cred({ value: { type: "key", key: "sk-1" } })]), null, "an API key is not a ChatGPT login");
  assert.equal(await none([cred({ integrationID: "anthropic" })]), null);
  assert.equal(await readLiveCodexEntry({ listCredentials: async () => { throw new Error("down"); } }), null);
});

test("readLiveCodexEntry reads GET /api/credential (the default source) and nothing else", async () => {
  const calls = await withV2({ "GET /api/credential": { data: [cred({ active: false }), cred({ id: "cred_2", value: { type: "oauth", methodID: "m", refresh: "R2", access: "A2", expires: 2 } })] } }, async () => {
    assert.equal((await readLiveCodexEntry()).access, "A2");
  });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /api/credential"]);
});

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

test("createSession POSTs /api/session with the location, returns the V1-shaped record and primes the directory cache", async () => {
  const calls = await withV2({ "POST /api/session": () => ({ data: SESSION({ title: "t" }) }) }, async () => {
    const s = await createSession({ directory: "/work/proj", title: "t" });
    assert.equal(s.id, "ses_a");
    assert.equal(s.directory, "/work/proj");
    assert.equal(s.title, "t");
    assert.equal(cachedSessionDirectory("ses_a"), "/work/proj");
    assert.deepEqual(knownSessionDirectories(), ["/work/proj"]);
  });
  assert.deepEqual(calls[0].body, { location: { directory: "/work/proj" }, title: "t" });
});

test("createSession omits an empty title (V2 titles the session itself)", async () => {
  const calls = await withV2({ "POST /api/session": { data: SESSION() } }, async () => {
    await createSession({ directory: "/work/proj" });
  });
  assert.equal("title" in calls[0].body, false);
});

test("createSession expands a leading ~ before POSTing (no /home/$USER/~ corruption)", async () => {
  const calls = await withV2({ "POST /api/session": () => ({ data: SESSION({ location: { directory: join(homedir(), "projects/x") } }) }) }, async () => {
    await createSession({ directory: "~/projects/x" });
  });
  assert.equal(calls[0].body.location.directory, join(homedir(), "projects/x"));
  const bare = await withV2({ "POST /api/session": { data: SESSION() } }, async () => {
    await createSession({ directory: "~" });
  });
  assert.equal(bare[0].body.location.directory, homedir());
});

test("createSession leaves an already-absolute directory untouched", async () => {
  const calls = await withV2({ "POST /api/session": { data: SESSION() } }, async () => {
    await createSession({ directory: "/srv/app" });
  });
  assert.equal(calls[0].body.location.directory, "/srv/app");
});

test("createSession forwards the metadata marker and rejects a non-object one", async () => {
  const calls = await withV2({ "POST /api/session": { data: SESSION({ metadata: { role: "cto" } }) } }, async () => {
    const s = await createSession({ directory: "/w", metadata: { role: "cto" } });
    assert.deepEqual(s.metadata, { role: "cto" });
    await assert.rejects(createSession({ directory: "/w", metadata: [1] }), /plain object/);
  });
  assert.deepEqual(calls[0].body.metadata, { role: "cto" });
});

test("createSession translates the Manta permission ruleset to V2 rules (catch-all deny FIRST, bash→shell)", async () => {
  const calls = await withV2({ "POST /api/session": { data: SESSION() } }, async () => {
    await createSession({
      directory: "/w",
      permission: [
        { permission: "*", pattern: "**", action: "deny" },
        { permission: "bash", pattern: "**", action: "allow" },
        { permission: "edit", pattern: "src/*", action: "allow" },
      ],
    });
  });
  assert.deepEqual(calls[0].body.permissions, [
    { action: "*", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "allow" },
    { action: "edit", resource: "src/*", effect: "allow" },
  ]);
});

test("createSession non-2xx carries err.status (4xx = definitive rejection)", async () => {
  await withV2({ "POST /api/session": () => new Response("bad", { status: 400 }) }, async () => {
    await assert.rejects(createSession({ directory: "/w" }), (e) => e.status === 400 && /createSession 400/.test(e.message));
  });
});

test("readSession: 200 found (mapped), 404 missing, anything else unknown", async () => {
  for (const [status, state] of [[404, "missing"], [500, "unknown"]]) {
    await withV2({ "GET /api/session/ses_a": () => new Response("x", { status }) }, async () => {
      assert.equal((await readSession("ses_a")).state, state);
    });
  }
  await withV2({ "GET /api/session/ses_a": { data: SESSION({ metadata: { m: 1 } }) } }, async () => {
    const r = await readSession("ses_a");
    assert.equal(r.state, "found");
    assert.equal(r.session.directory, "/work/proj");
    assert.deepEqual(r.session.metadata, { m: 1 });
  });
  assert.equal((await readSession("")).state, "missing");
});

test("sessionExists: direct lookup — 200 alive, 404 gone, 5xx/network assume alive; empty id → false with no request", async () => {
  await withV2({ "GET /api/session/ses_a": { data: SESSION() } }, async () => assert.equal(await sessionExists("ses_a"), true));
  await withV2({ "GET /api/session/ses_a": () => new Response("x", { status: 404 }) }, async () => assert.equal(await sessionExists("ses_a"), false));
  await withV2({ "GET /api/session/ses_a": () => new Response("x", { status: 503 }) }, async () => assert.equal(await sessionExists("ses_a"), true));
  _setOcTransport(async () => { throw new Error("ECONNRESET"); });
  assert.equal(await sessionExists("ses_a"), true);
  _setOcTransport(async () => { throw new Error("must not be called"); });
  assert.equal(await sessionExists(""), false);
  _setOcTransport(null);
});

test("getSessionAgent / getSessionDirectory read the session record (null on miss)", async () => {
  await withV2({ "GET /api/session/ses_a": { data: SESSION({ agent: "plan" }) } }, async () => {
    assert.equal(await getSessionAgent("ses_a"), "plan");
    assert.equal(await getSessionDirectory("ses_a"), "/work/proj");
  });
  await withV2({ "GET /api/session/ses_a": { data: SESSION() } }, async () => assert.equal(await getSessionAgent("ses_a"), null));
  await withV2({ "GET /api/session/ses_a": () => new Response("x", { status: 404 }) }, async () => {
    assert.equal(await getSessionAgent("ses_a"), null);
    assert.equal(await getSessionDirectory("ses_a"), null);
  });
});

test("listSessions maps records, passes the directory filter, follows pages and primes the cache", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => SESSION({ id: `ses_${i}` }));
  const calls = await withV2(
    {
      "GET /api/session": ({ query }) =>
        query.cursor ? { data: [SESSION({ id: "ses_last" })], cursor: { next: null } } : { data: page1, cursor: { next: "CUR" } },
    },
    async () => {
      const out = await listSessions("/work/proj");
      assert.equal(out.length, 101);
      assert.equal(out[0].directory, "/work/proj");
      assert.equal(cachedSessionDirectory("ses_last"), "/work/proj");
    },
  );
  assert.equal(calls[0].query.directory, "/work/proj");
  assert.equal(calls[1].query.cursor, "CUR");
});

test("forkSession posts {before} and returns the NEW session (read from the fork response)", async () => {
  const calls = await withV2(
    { "POST /api/session/ses_a/fork": { data: SESSION({ id: "ses_child", fork: { sessionID: "ses_a" } }) } },
    async () => {
      const s = await forkSession({ sessionId: "ses_a", messageID: "msg_9" });
      assert.equal(s.id, "ses_child");
      assert.equal(cachedSessionDirectory("ses_child"), "/work/proj");
    },
  );
  assert.deepEqual(calls[0].body, { before: "msg_9" });
});

test("compactSession / deleteSessionRaw / abortSession hit the V2 routes", async () => {
  const calls = await withV2(
    {
      "POST /api/session/ses_a/compact": null,
      "DELETE /api/session/ses_a": null,
      "POST /api/session/ses_a/interrupt": { interrupted: true },
    },
    async () => {
      await compactSession("ses_a");
      await abortSession("ses_a");
      await deleteSessionRaw("ses_a");
    },
  );
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /api/session/ses_a/compact", "POST /api/session/ses_a/interrupt", "DELETE /api/session/ses_a"]);
  assert.equal(calls[1].query.resume, "false");
});

test("abortSession carries a caller's bounded signal and throws on non-2xx", async () => {
  const ac = new AbortController();
  const calls = await withV2({ "POST /api/session/ses_a/interrupt": { interrupted: false } }, async () => {
    await abortSession("ses_a", { signal: ac.signal });
  });
  assert.equal(calls[0].signal, ac.signal);
  await withV2({ "POST /api/session/ses_a/interrupt": () => new Response("no", { status: 500 }) }, async () => {
    await assert.rejects(abortSession("ses_a"), /abortSession 500/);
  });
});

test("interruptSession passes resume through; abortSession is the resume=false wrapper", async () => {
  const calls = await withV2({ "POST /api/session/ses_a/interrupt": { data: { interrupted: true } } }, async () => {
    await interruptSession("ses_a", { resume: true });
    await interruptSession("ses_a");
    await abortSession("ses_a");
  });
  assert.deepEqual(calls.map((c) => c.query.resume), ["true", "false", "false"]);
});

test("listInbox / cancelInboxItem hit the V2 inbox routes", async () => {
  const items = [{ id: "msg_1", type: "user", payload: { text: "hi" }, delivery: "steer", time: { created: 5 } }];
  const calls = await withV2(
    { "GET /api/session/ses_a/inbox": { data: items }, "DELETE /api/session/ses_a/inbox/msg_1": null },
    async () => {
      assert.deepEqual(await listInbox("ses_a"), items);
      await cancelInboxItem("ses_a", "msg_1");
    },
  );
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /api/session/ses_a/inbox", "DELETE /api/session/ses_a/inbox/msg_1"]);
  await withV2({ "GET /api/session/ses_a/inbox": () => new Response("no", { status: 500 }) }, async () => {
    await assert.rejects(listInbox("ses_a"), /listInbox 500/);
  });
});

test("subscribeEvents calls onDisconnect when an established stream drops", async () => {
  const events = [];
  let n = 0;
  _setEventStreamTransport(async () => {
    n++;
    if (n === 1) {
      const enc = new TextEncoder();
      return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode("data: {\"type\":\"x\"}\n\n")); c.close(); } }), { status: 200 });
    }
    return new Promise(() => {}); // the reconnect hangs
  });
  const stop = subscribeEvents(() => events.push("event"), { reconnectMs: 5, onConnect: () => events.push("connect"), onDisconnect: () => events.push("disconnect") });
  try {
    await new Promise((r) => setTimeout(r, 120));
  } finally {
    stop();
    _setEventStreamTransport(null);
  }
  assert.deepEqual(events.slice(0, 3), ["connect", "event", "disconnect"]);
});

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

test("sendPrompt POSTs {text} to /api/session/{id}/prompt; no model/agent → no model/agent request", async () => {
  const calls = await withV2(
    { "GET /api/session/ses_a": { data: SESSION() }, "POST /api/session/ses_a/prompt": { data: {} } },
    async () => {
      await sendPrompt({ sessionId: "ses_a", text: "hi" });
    },
  );
  const body = only(calls, "POST", "/api/session/ses_a/prompt")[0].body;
  assert.match(body.id, /^msg_./, "a prompt always carries a message id (minted when the caller gave none)");
  assert.deepEqual({ ...body, id: undefined }, { text: "hi", id: undefined });
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("sendPrompt with a delivery skips the model/agent sync entirely (a steered message never switches the session)", async () => {
  const calls = await withV2(
    { "GET /api/session/ses_a": { data: SESSION({ agent: "plan" }) }, "POST /api/session/ses_a/prompt": { data: {} } },
    async () => {
      await sendPrompt({ sessionId: "ses_a", text: "steer", delivery: "steer", model: { providerID: "anthropic", modelID: "claude-opus-4-8" }, agent: "build" });
    },
  );
  assert.equal(calls.filter((c) => c.method === "GET").length, 0, "the session is not even read");
  assert.equal(calls.filter((c) => c.path.endsWith("/model") || c.path.endsWith("/agent")).length, 0);
  assert.equal(only(calls, "POST", "/api/session/ses_a/prompt")[0].body.delivery, "steer");
});

test("sendPrompt registers its id as ours BEFORE the POST; a definitive 4xx drops it, a 5xx keeps it", async () => {
  const c = getCommandCorrelator();
  const seen = [];
  await withV2(
    {
      "GET /api/session/ses_a": { data: SESSION() },
      "POST /api/session/ses_a/prompt": (call) => {
        seen.push(c.isOurPromptId("ses_a", call.body.id));
        return call.body.id === "msg_bad" ? new Response("no", { status: 400 }) : call.body.id === "msg_5xx" ? new Response("boom", { status: 503 }) : { data: {} };
      },
    },
    async () => {
      await sendPrompt({ sessionId: "ses_a", text: "ok", messageID: "msg_ok" });
      await assert.rejects(sendPrompt({ sessionId: "ses_a", text: "x", messageID: "msg_bad" }), (e) => e.status === 400);
      await assert.rejects(sendPrompt({ sessionId: "ses_a", text: "x", messageID: "msg_5xx" }), (e) => e.status === 503);
    },
  );
  assert.deepEqual(seen, [true, true, true], "registered before each POST went out");
  assert.equal(c.isOurPromptId("ses_a", "msg_ok"), true, "stays until its enqueue is observed");
  assert.equal(c.isOurPromptId("ses_a", "msg_bad"), false, "a definitive refusal never reached the inbox");
  assert.equal(c.isOurPromptId("ses_a", "msg_5xx"), true, "a 5xx might have been accepted");
});

test("sendPrompt: attachments → files, mentions → agents, messageID → id, delivery passed through", async () => {
  const calls = await withV2(
    { "GET /api/session/ses_a": { data: SESSION() }, "POST /api/session/ses_a/prompt": { data: {} } },
    async () => {
      await sendPrompt({
        sessionId: "ses_a",
        text: "look @explore",
        attachments: [{ remotePath: "/up/a.png", mime: "image/png", filename: "a.png" }],
        mentions: [{ name: "explore", source: { value: "@explore", start: 5, end: 13 } }],
        messageID: "msg_x",
        delivery: "queue",
      });
    },
  );
  assert.deepEqual(only(calls, "POST", "/api/session/ses_a/prompt")[0].body, {
    text: "look @explore",
    files: [{ uri: "file:///up/a.png", name: "a.png" }],
    agents: [{ name: "explore", mention: { start: 5, end: 13, text: "@explore" } }],
    id: "msg_x",
    delivery: "queue",
  });
});

test("sendPrompt sets the session MODEL only when it differs (V2 keeps the model on the session)", async () => {
  const model = { providerID: "anthropic", modelID: "claude-opus-5-5", variant: "high" };
  const calls = await withV2(
    { "GET /api/session/ses_a": { data: SESSION() }, "POST /api/session/ses_a/model": null, "POST /api/session/ses_a/prompt": { data: {} } },
    async () => {
      await sendPrompt({ sessionId: "ses_a", text: "x", model });
      await sendPrompt({ sessionId: "ses_a", text: "y", model: { providerID: "anthropic", modelID: "claude-haiku-4-5" } });
    },
  );
  const sets = only(calls, "POST", "/api/session/ses_a/model");
  assert.equal(sets.length, 1, "the second prompt names the model the session already has");
  assert.deepEqual(sets[0].body, { model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" } });
  assert.equal("model" in only(calls, "POST", "/api/session/ses_a/prompt")[0].body, false, "the prompt body never carries a model");
});

test("sendPrompt agent: an explicit agent is set when different; omitting it after plan mode returns to build", async () => {
  const state = { agent: undefined };
  const calls = await withV2(
    {
      "GET /api/session/ses_a": () => ({ data: SESSION({ agent: state.agent }) }),
      "POST /api/session/ses_a/agent": ({ body }) => { state.agent = body.agent; return null; },
      "POST /api/session/ses_a/prompt": { data: {} },
    },
    async () => {
      await sendPrompt({ sessionId: "ses_a", text: "plan it", agent: "plan" });
      await sendPrompt({ sessionId: "ses_a", text: "again", agent: "plan" });
      await sendPrompt({ sessionId: "ses_a", text: "now build" });
      await sendPrompt({ sessionId: "ses_a", text: "and again" });
    },
  );
  assert.deepEqual(only(calls, "POST", "/api/session/ses_a/agent").map((c) => c.body.agent), ["plan", "build"]);
});

test("sendPrompt non-2xx carries status + Retry-After (BET-1230) and records the transport refusal (BET-1270 6c)", async () => {
  await withV2(
    {
      "GET /api/session/ses_a": { data: SESSION() },
      "POST /api/session/ses_a/prompt": () => new Response("limit", { status: 429, headers: { "retry-after": "7" } }),
    },
    async () => {
      await assert.rejects(sendPrompt({ sessionId: "ses_a", text: "x" }), (e) => e.status === 429 && e.retryAfterMs === 7000);
      assert.deepEqual(getAndClearSessionRefusal("ses_a"), { httpStatus: 429, retryAfterMs: 7000 });
      assert.equal(getAndClearSessionRefusal("ses_a"), undefined, "read-and-clear");
    },
  );
});

test("sendPrompt on an unknown session fails with the 404 (nothing is posted)", async () => {
  const calls = await withV2({ "GET /api/session/ses_gone": () => new Response("nf", { status: 404 }) }, async () => {
    await assert.rejects(sendPrompt({ sessionId: "ses_gone", text: "x" }), (e) => e.status === 404);
  });
  assert.equal(calls.length, 1);
});

test("runCommand POSTs {name, text} to the command route", async () => {
  const calls = await withV2(
    { "GET /api/session/ses_a": { data: SESSION() }, "POST /api/session/ses_a/command": null },
    async () => {
      await runCommand({ sessionId: "ses_a", command: "init", arguments: "now" });
    },
  );
  assert.deepEqual(only(calls, "POST", "/api/session/ses_a/command")[0].body, { name: "init", text: "now" });
});

test("runCommand with a delivery forwards it and skips the model/agent sync", async () => {
  const calls = await withV2({ "POST /api/session/ses_a/command": null }, async () => {
    await runCommand({ sessionId: "ses_a", command: "review", arguments: "HEAD~1", delivery: "steer", agent: "build" });
  });
  assert.deepEqual(only(calls, "POST", "/api/session/ses_a/command")[0].body, { name: "review", text: "HEAD~1", delivery: "steer" });
  assert.equal(calls.filter((c) => c.method === "GET").length, 0);
});

test("runCommand opens a correlation window around the POST and finishes it on success AND on failure", async () => {
  const log = [];
  const prev = getCommandCorrelator();
  setCommandCorrelator({
    openWindow: (sid, a) => {
      log.push(["open", sid, a.name, a.arguments]);
      return { finish: (r) => log.push(["finish", r.ok, r.status]) };
    },
    originOf: () => null,
  });
  try {
    await withV2({ "GET /api/session/ses_a": { data: SESSION() }, "POST /api/session/ses_a/command": null }, async () => {
      await runCommand({ sessionId: "ses_a", command: "init", arguments: "now" });
    });
    await withV2({ "GET /api/session/ses_a": { data: SESSION() }, "POST /api/session/ses_a/command": () => new Response("bad", { status: 404 }) }, async () => {
      await assert.rejects(runCommand({ sessionId: "ses_a", command: "nope", arguments: "" }));
    });
    await withV2({ "GET /api/session/ses_a": { data: SESSION() }, "POST /api/session/ses_a/command": () => { throw new Error("socket hang up"); } }, async () => {
      await assert.rejects(runCommand({ sessionId: "ses_a", command: "net", arguments: "" }));
    });
  } finally {
    setCommandCorrelator(prev);
  }
  assert.deepEqual(log, [
    ["open", "ses_a", "init", "now"], ["finish", true, undefined],
    ["open", "ses_a", "nope", ""], ["finish", false, 404],
    ["open", "ses_a", "net", ""], ["finish", false, undefined],
  ]);
});

test("listMessages / getMessage stamp info.command on user messages with a recorded origin", async () => {
  const prev = getCommandCorrelator();
  setCommandCorrelator({ ...prev, originOf: (id) => (id === "msg_u" ? { name: "review", arguments: "HEAD~1" } : null) });
  try {
    const record = { id: "msg_u", type: "user", text: "expanded template", time: { created: 1 } };
    const timeline = { "GET /api/session/ses_a": { data: SESSION() }, "GET /api/session/ses_a/message": { data: [record] }, "GET /api/session/ses_a/message/msg_u": { data: record } };
    await withV2(timeline, async () => {
      const list = await listMessages("ses_a");
      assert.deepEqual(list[0].info.command, { name: "review", arguments: "HEAD~1" });
      const one = await getMessage("ses_a", "msg_u");
      assert.deepEqual(one.info.command, { name: "review", arguments: "HEAD~1" });
    });
  } finally {
    setCommandCorrelator(prev);
  }
});

test("runCommand non-2xx carries err.status (admission: definitive 4xx vs unknown)", async () => {
  await withV2(
    { "GET /api/session/ses_a": { data: SESSION() }, "POST /api/session/ses_a/command": () => new Response("bad", { status: 400 }) },
    async () => {
      await assert.rejects(runCommand({ sessionId: "ses_a", command: "nope", arguments: "" }), (e) => e.status === 400);
    },
  );
});

// ---------------------------------------------------------------------------
// running state
// ---------------------------------------------------------------------------

test("getSessionStatus / listActiveSessionIds / listSessionStatuses read GET /api/session/active", async () => {
  await withV2({ "GET /api/session/active": { data: { ses_a: { type: "running" }, ses_b: { type: "running" } } } }, async () => {
    _resetSessionDirectoryCache();
    assert.equal(await getSessionStatus("ses_a"), "busy");
    assert.equal(await getSessionStatus("ses_zzz"), "idle");
    assert.deepEqual((await listActiveSessionIds()).sort(), ["ses_a", "ses_b"]);
    assert.deepEqual(Object.keys(await listSessionStatuses("/work/proj")).sort(), ["ses_a", "ses_b"], "unknown directories are not filtered out");
  });
});

test("listSessionStatuses narrows to sessions known to live in the directory; a directory is required; non-2xx throws", async () => {
  await withV2(
    { "POST /api/session": () => ({ data: SESSION({ id: "ses_a" }) }), "GET /api/session/active": { data: { ses_a: {}, ses_other: {} } } },
    async () => {
      await createSession({ directory: "/work/proj" });
      _setOcTransport(async () => json({ data: { ses_a: {}, ses_other: {} } }));
      assert.deepEqual(Object.keys(await listSessionStatuses("/work/proj")), ["ses_a", "ses_other"]);
      assert.deepEqual(Object.keys(await listSessionStatuses("/elsewhere")), ["ses_other"]);
    },
  );
  await assert.rejects(listSessionStatuses(""), /directory required/);
  await withV2({ "GET /api/session/active": () => new Response("x", { status: 500 }) }, async () => {
    await assert.rejects(getSessionStatus("ses_a"), /session\/active 500/);
  });
});

test("readShellOutput reads from a cursor; null once the shell is gone", async () => {
  const calls = await withV2(
    {
      "GET /api/shell/sh_1/output": ({ query }) => query["location[directory]"] === "/w" ? { data: { output: query.cursor === "0" ? "tick1\n" : "", cursor: 6, size: 6, truncated: false } } : new Response("nf", { status: 404 }),
      "GET /api/shell/sh_gone/output": () => new Response("nf", { status: 404 }),
    },
    async () => {
      assert.deepEqual(await readShellOutput({ shellID: "sh_1", cursor: 0, directory: "/w" }), { output: "tick1\n", cursor: 6, truncated: false });
      assert.equal((await readShellOutput({ shellID: "sh_1", cursor: 6, directory: "/w" })).output, "");
      assert.equal(await readShellOutput({ shellID: "sh_1", cursor: 0 }), null, "location-scoped: no directory → the shell is not found");
      assert.equal(await readShellOutput({ shellID: "sh_gone" }), null);
    },
  );
  assert.equal(calls[0].query.cursor, "0");
});

// ---------------------------------------------------------------------------
// transcript
// ---------------------------------------------------------------------------

const U = (id, text) => ({ id, type: "user", text, time: { created: 1 } });
const A = (id, content, extra = {}) => ({ id, type: "assistant", agent: "build", model: { id: "m", providerID: "p" }, time: { created: 2, completed: 3 }, content, ...extra });
const IDLE = (id) => ({ id, type: "idle", outcome: "succeeded", time: { created: 4 } });

test("listMessages maps the V2 timeline (newest-first pages) to chronological {info, parts}", async () => {
  const calls = await withV2(
    { "GET /api/session/ses_a/message": () => ({ data: [IDLE("msg_4"), A("msg_3", [{ type: "text", text: "hello" }], { finish: "stop", tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 3, write: 4 } } }), U("msg_1", "hi")], cursor: { next: null } }) },
    async () => {
      const msgs = await listMessages("ses_a");
      assert.deepEqual(msgs.map((m) => m.info.role), ["user", "assistant"]);
      assert.equal(msgs[1].info.modelID, "m");
      assert.equal(msgs[1].info.providerID, "p");
      assert.equal(msgs[1].info.parentID, "msg_1");
      assert.equal(msgs[1].info.time.completed, 3);
      assert.deepEqual(msgs[1].info.tokens, { input: 1, output: 2, reasoning: 0, cache: { read: 3, write: 4 } });
      assert.equal(msgs[1].parts.find((p) => p.type === "text").text, "hello");
      assert.equal(msgs[1].parts.at(-1).type, "step-finish");
    },
  );
  assert.equal(calls[0].query.order, "desc");
});

test("listMessages {limit}: stops reading pages once enough conversation records are seen, returns the TAIL", async () => {
  let page = 0;
  const calls = await withV2(
    {
      "GET /api/session/ses_a/message": ({ query }) => {
        page++;
        if (!query.cursor) return { data: [IDLE("i3"), A("a3", [{ type: "text", text: "3" }]), U("u3", "3")], cursor: { next: "C1" } };
        return { data: [A("a2", [{ type: "text", text: "2" }]), U("u2", "2")], cursor: { next: null } };
      },
    },
    async () => {
      const two = await listMessages("ses_a", { limit: 2 });
      assert.deepEqual(two.map((m) => m.info.id), ["u3", "a3"]);
      assert.equal(page, 1, "the first page already held 2 conversation records");
      page = 0;
      const four = await listMessages("ses_a", { limit: 4 });
      assert.deepEqual(four.map((m) => m.info.id), ["u2", "a2", "u3", "a3"]);
      assert.equal(page, 2);
    },
  );
  assert.equal(calls.filter((c) => c.query.cursor).length, 1);
});

test("listMessages non-2xx throws", async () => {
  await withV2({ "GET /api/session/ses_a/message": () => new Response("x", { status: 500 }) }, async () => {
    await assert.rejects(listMessages("ses_a"), /listMessages 500/);
  });
});

test("tool blocks map to V1 tool parts: names, input spellings, output, metadata, subagent child id", async () => {
  const timeline = [
    A("a1", [
      { type: "tool", id: "toolu_1", name: "shell", state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "a\nb\n" }], metadata: { exit: 0 } }, time: { created: 1, ran: 2, completed: 3 } },
      { type: "tool", id: "toolu_2", name: "edit", state: { status: "completed", input: { path: "n.txt" }, content: [{ type: "text", text: "Edited" }], metadata: { files: [{ file: "n.txt", patch: "@@ P", additions: 1, deletions: 0 }] } }, time: { created: 1 } },
      { type: "tool", id: "toolu_3", name: "subagent", state: { status: "completed", input: { agent: "explore", description: "d" }, content: [{ type: "text", text: '<subagent sessionID="ses_c" state="completed">\nanswer\n</subagent>' }], metadata: { sessionID: "ses_c", status: "completed" } }, time: { created: 1 } },
      { type: "tool", id: "toolu_4", name: "shell", state: { status: "error", input: { command: "x" }, error: { type: "aborted", message: "Tool execution interrupted" } }, time: { created: 1 } },
      { type: "tool", id: "toolu_5", name: "read", state: { status: "streaming", input: '{"pa' }, time: { created: 1 } },
    ]),
  ];
  await withV2({ "GET /api/session/ses_a/message": { data: timeline.slice().reverse(), cursor: { next: null } } }, async () => {
    const parts = (await listMessages("ses_a"))[0].parts.filter((p) => p.type === "tool");
    const [sh, ed, sub, err, pending] = parts;
    assert.equal(sh.tool, "bash");
    assert.equal(sh.callID, "toolu_1");
    assert.equal(sh.state.status, "completed");
    assert.equal(sh.state.output, "a\nb\n");
    assert.equal(ed.state.input.filePath, "n.txt", "the V1 spelling the renderer reads");
    assert.equal(ed.state.metadata.diff, "@@ P");
    assert.equal(ed.state.metadata.filediff.additions, 1);
    assert.equal(sub.tool, "task");
    assert.equal(sub.state.metadata.sessionId, "ses_c");
    assert.equal(sub.state.input.subagent_type, "explore");
    assert.equal(sub.state.output, "answer", "the <subagent> wrapper is unwrapped");
    assert.equal(err.state.status, "error");
    assert.equal(err.state.error, "Tool execution interrupted");
    assert.equal(pending.state.status, "pending");
  });
});

test("reasoning blocks map to reasoning parts; ids are stable per message+ordinal", async () => {
  await withV2({ "GET /api/session/ses_a/message": { data: [A("a1", [{ type: "reasoning", text: "think" }, { type: "text", text: "ans" }, { type: "text", text: "more" }])], cursor: { next: null } } }, async () => {
    const parts = (await listMessages("ses_a"))[0].parts;
    assert.deepEqual(parts.map((p) => [p.id, p.type]), [["a1:reasoning:0", "reasoning"], ["a1:text:0", "text"], ["a1:text:1", "text"]]);
  });
});

test("a RUNNING shell tool's live output is hydrated from GET /api/shell/{id}/output (a refetch keeps the tail)", async () => {
  const timeline = [A("a1", [{ type: "tool", id: "toolu_1", name: "shell", state: { status: "running", input: { command: "loop" }, metadata: { shellID: "sh_1" } }, time: { created: 1 } }], { time: { created: 2 } })];
  await withV2(
    { "GET /api/session/ses_a/message": { data: timeline, cursor: { next: null } }, "GET /api/session/ses_a": { data: SESSION() }, "GET /api/shell/sh_1/output": ({ query }) => query["location[directory]"] === "/work/proj" ? { data: { output: "tick1\ntick2\n", cursor: 12, size: 12, truncated: false } } : new Response("nf", { status: 404 }) },
    async () => {
      const part = (await listMessages("ses_a"))[0].parts[0];
      assert.equal(part.state.status, "running");
      assert.equal(part.state.metadata.output, "tick1\ntick2\n");
    },
  );
});

test("a completed compaction becomes a summary message", async () => {
  await withV2({ "GET /api/session/ses_a/message": { data: [{ id: "c1", type: "compaction", status: "completed", reason: "manual", summary: "## Objective", time: { created: 5 } }, U("u1", "x")], cursor: { next: null } } }, async () => {
    const msgs = await listMessages("ses_a");
    assert.equal(msgs[1].info.summary, true);
    assert.equal(msgs[1].parts[0].text, "## Objective");
  });
});

test("listMessages ALWAYS strips a byte-identical tool stdout duplicate (no slim needed)", async () => {
  const timeline = [A("a1", [{ type: "tool", id: "t", name: "shell", state: { status: "completed", input: {}, content: [{ type: "text", text: "OUT" }], metadata: { output: "OUT", exit: 0 } } }])];
  await withV2({ "GET /api/session/ses_a/message": { data: timeline, cursor: { next: null } } }, async () => {
    const st = (await listMessages("ses_a"))[0].parts[0].state;
    assert.equal(st.output, "OUT");
    assert.equal("output" in st.metadata, false);
    assert.equal(st.metadata.exit, 0);
  });
});

test("listMessages {slim:true} drops the part types the iOS client never renders", async () => {
  await withV2({ "GET /api/session/ses_a/message": { data: [A("a1", [{ type: "reasoning", text: "r" }, { type: "text", text: "t" }], { tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } })], cursor: { next: null } } }, async () => {
    assert.deepEqual((await listMessages("ses_a", { slim: true }))[0].parts.map((p) => p.type), ["text"]);
    assert.deepEqual((await listMessages("ses_a"))[0].parts.map((p) => p.type), ["reasoning", "text", "step-finish"]);
  });
});

test("getMessage maps ONE record (the splice / receipt path); null on a miss or error", async () => {
  await withV2({ "GET /api/session/ses_a/message/msg_1": { data: U("msg_1", "hi") }, "GET /api/session/ses_a/message/msg_nope": () => new Response("nf", { status: 404 }) }, async () => {
    const m = await getMessage("ses_a", "msg_1");
    assert.equal(m.info.id, "msg_1");
    assert.equal(m.info.role, "user");
    assert.equal(m.parts[0].text, "hi");
    assert.equal(await getMessage("ses_a", "msg_nope"), null);
  });
  _setOcTransport(async () => { throw new Error("down"); });
  assert.equal(await getMessage("ses_a", "msg_1"), null);
  _setOcTransport(null);
});

// ---------------------------------------------------------------------------
// permissions + questions (forms)
// ---------------------------------------------------------------------------

const PERM = (id, sid = "ses_a") => ({ id, sessionID: sid, action: "shell", resources: ["echo hi"], save: ["echo *"], source: { type: "tool", messageID: "msg_1", id: "toolu_1" } });
const FORM = (id, kind = "question") => ({
  id,
  sessionID: "ses_a",
  title: "Questions",
  metadata: { kind, tool: { messageID: "msg_1", id: "toolu_q" } },
  fields: [
    { key: "q0", title: "Colour", description: "Which colour?", type: "string", options: [{ value: "Red", label: "Red", description: "warm" }, { value: "Blue", label: "Blue" }], custom: true },
    { key: "q1", title: "Sizes", description: "Pick sizes", type: "multiselect", options: [{ value: "S", label: "S" }, { value: "L", label: "L" }] },
  ],
});

test("listPermissions: per-session route, mapped to the PermissionCard shape; without a session → the global list", async () => {
  await withV2({ "GET /api/session/ses_a/permission": { data: [PERM("per_1")] }, "GET /api/permission/request": { data: [PERM("per_1"), PERM("per_2", "ses_b")] } }, async () => {
    const [p] = await listPermissions("ses_a");
    assert.equal(p.id, "per_1");
    assert.equal(p.permission, "bash");
    assert.deepEqual(p.patterns, ["echo hi"]);
    assert.deepEqual(p.always, ["echo *"]);
    assert.equal(p.metadata.command, "echo hi");
    assert.deepEqual(p.tool, { messageID: "msg_1", callID: "toolu_1" });
    assert.equal((await listPermissions()).length, 2);
  });
});

test("listPermissions / listQuestions return [] on a non-OK and do not throw", async () => {
  const bad = () => new Response("bad", { status: 400 });
  await withV2({ "GET /api/session/ses_a/permission": bad, "GET /api/session/ses_a/form": bad }, async () => {
    assert.deepEqual(await listPermissions("ses_a"), []);
    assert.deepEqual(await listQuestions("ses_a"), []);
  });
});

test("replyPermission POSTs {decision} on the session route; a trust-mode reply with no session looks it up", async () => {
  const calls = await withV2(
    { "POST /api/session/ses_a/permission/per_1/reply": null, "GET /api/permission/request": { data: [PERM("per_1")] } },
    async () => {
      await replyPermission({ requestId: "per_1", reply: "always", sessionId: "ses_a" });
      await replyPermission({ requestId: "per_1", reply: "once" });
    },
  );
  const posts = only(calls, "POST", "/api/session/ses_a/permission/per_1/reply");
  assert.deepEqual(posts.map((c) => c.body), [{ decision: "always" }, { decision: "once" }]);
});

test("replyPermission throws on a non-OK reply and when the request is unknown", async () => {
  await withV2({ "POST /api/session/ses_a/permission/per_1/reply": () => new Response("no", { status: 404 }) }, async () => {
    await assert.rejects(replyPermission({ requestId: "per_1", reply: "once", sessionId: "ses_a" }), /replyPermission 404/);
  });
  await withV2({ "GET /api/permission/request": { data: [] } }, async () => {
    await assert.rejects(replyPermission({ requestId: "per_x", reply: "once" }), /no pending permission/);
  });
});

test("listQuestions: only `question` forms, mapped to the QuestionRequest shape (form id = request id)", async () => {
  await withV2({ "GET /api/session/ses_a/form": { data: [FORM("frm_1"), FORM("frm_2", "oauth")] } }, async () => {
    const qs = await listQuestions("ses_a");
    assert.equal(qs.length, 1);
    assert.equal(qs[0].id, "frm_1");
    assert.deepEqual(qs[0].tool, { messageID: "msg_1", callID: "toolu_q" });
    assert.equal(qs[0].questions[0].question, "Which colour?");
    assert.equal(qs[0].questions[0].header, "Colour");
    assert.deepEqual(qs[0].questions[0].options, [{ label: "Red", description: "warm" }, { label: "Blue" }]);
    assert.equal(qs[0].questions[1].multiple, true);
  });
});

test("replyQuestion maps answers[][] onto the form's field keys: {answer:{q0:'Red', q1:['S','L']}}", async () => {
  const calls = await withV2(
    { "GET /api/session/ses_a/form/frm_1": { data: FORM("frm_1") }, "POST /api/session/ses_a/form/frm_1/reply": null },
    async () => {
      await replyQuestion({ requestId: "frm_1", sessionId: "ses_a", answers: [["Red"], ["S", "L"]] });
    },
  );
  assert.deepEqual(only(calls, "POST", "/api/session/ses_a/form/frm_1/reply")[0].body, { answer: { q0: "Red", q1: ["S", "L"] } });
});

test("replyQuestion: a picked option AND a typed clarification both reach the model; unanswered fields are ''", async () => {
  const calls = await withV2(
    { "GET /api/session/ses_a/form/frm_1": { data: FORM("frm_1") }, "POST /api/session/ses_a/form/frm_1/reply": null },
    async () => {
      await replyQuestion({ requestId: "frm_1", sessionId: "ses_a", answers: [["Red", "but darker"]] });
    },
  );
  assert.deepEqual(only(calls, "POST", "/api/session/ses_a/form/frm_1/reply")[0].body.answer, { q0: "Red, but darker", q1: [] });
});

test("replyQuestion without a session finds the form in the global list; rejectQuestion DELETEs it", async () => {
  const calls = await withV2(
    {
      "GET /api/form": { data: [FORM("frm_1")] },
      "POST /api/session/ses_a/form/frm_1/reply": null,
      "DELETE /api/session/ses_a/form/frm_1": null,
    },
    async () => {
      await replyQuestion({ requestId: "frm_1", answers: [["Red"]] });
      await rejectQuestion({ requestId: "frm_1" });
      await rejectQuestion({ requestId: "frm_1", sessionId: "ses_a" });
    },
  );
  assert.equal(only(calls, "DELETE", "/api/session/ses_a/form/frm_1").length, 2);
  await withV2({ "POST /api/session/ses_a/form/frm_1/reply": () => new Response("no", { status: 409 }), "GET /api/session/ses_a/form/frm_1": { data: FORM("frm_1") } }, async () => {
    await assert.rejects(replyQuestion({ requestId: "frm_1", sessionId: "ses_a", answers: [["Red"]] }), /replyQuestion 409/);
  });
});

// ---------------------------------------------------------------------------
// models / providers
// ---------------------------------------------------------------------------

const PROVIDER_ROUTES = (extra = {}) => ({
  "GET /api/provider": { data: [{ id: "anthropic", integrationID: "anthropic", name: "Anthropic", activation: "auto" }, { id: "fake", name: "Fake", activation: "enabled" }, { id: "idle", integrationID: "idle", name: "Idle", activation: "auto" }] },
  "GET /api/integration": { data: [{ id: "anthropic", methods: [], connections: [{ type: "env", name: "K" }] }, { id: "idle", methods: [], connections: [] }] },
  "GET /api/model": {
    data: [
      { id: "claude-haiku-4-5", modelID: "claude-haiku-4-5", providerID: "anthropic", package: "@opencode/ai/providers/anthropic", name: "Haiku", family: "claude-haiku", status: "active", enabled: true, limit: { context: 200000, output: 64000 }, capabilities: { tools: true, input: ["text", "image"], output: ["text"] }, cost: [{ input: 1, output: 5, cache: { read: 0.1, write: 1.25 } }, { tier: { type: "context", size: 1 }, input: 9, output: 9, cache: { read: 9, write: 9 } }], variants: [{ id: "high" }] },
      { id: "fm", modelID: "fm", providerID: "fake", name: "fm" },
    ],
  },
  "GET /api/model/default": { data: { id: "claude-haiku-4-5", modelID: "claude-haiku-4-5", providerID: "anthropic" } },
  ...extra,
});

test("getProviders: connected = credential/env-backed or always-enabled; all carries models in the normalizer's shape; default from /model/default", async () => {
  await withV2(PROVIDER_ROUTES(), async () => {
    const p = await getProviders();
    assert.deepEqual(p.connected, ["anthropic", "fake"]);
    assert.deepEqual(p.all.map((x) => x.id), ["anthropic", "fake", "idle"]);
    const m = p.all[0].models["claude-haiku-4-5"];
    assert.equal(m.capabilities.toolcall, true);
    assert.equal(m.capabilities.attachment, true);
    assert.equal(m.capabilities.reasoning, true, "variants imply reasoning");
    assert.deepEqual(m.cost, { input: 1, output: 5, cache: { read: 0.1, write: 1.25 } }, "the base tier");
    assert.equal(m.package, "@opencode/ai/providers/anthropic", "the serving package survives (the Anthropic-SDK signal the 1h cache price needs)");
    assert.equal(p.all[1].models.fm.package, undefined);
    assert.deepEqual(p.default, { anthropic: "claude-haiku-4-5" });
  });
});

test("getProviders returns {connected:[]} on a non-2xx response and on a transport throw", async () => {
  await withV2({ "GET /api/provider": () => new Response("x", { status: 500 }), "GET /api/integration": { data: [] }, "GET /api/model": { data: [] }, "GET /api/model/default": () => new Response("x", { status: 404 }) }, async () => {
    assert.deepEqual(await getProviders(), { connected: [] });
  });
  _setOcTransport(async () => { throw new Error("down"); });
  assert.deepEqual(await getProviders(), { connected: [] });
  _setOcTransport(null);
});

test("getProviders coalesces concurrent callers into ONE read of the catalogue, and refetches afterwards", async () => {
  // Settings → Models fires ~6 of these at once; opencode answers them serially, which used to
  // queue past the renderer's 15 s timeout.
  let release;
  const gate = new Promise((r) => { release = r; });
  const routes = PROVIDER_ROUTES({ "GET /api/provider": async () => { await gate; return PROVIDER_ROUTES()["GET /api/provider"]; } });
  const calls = await withV2(routes, async (calls) => {
    const pending = Array.from({ length: 6 }, () => getProviders());
    release();
    const results = await Promise.all(pending);
    assert.equal(only(calls, "GET", "/api/provider").length, 1, "six concurrent callers share one read");
    for (const r of results) assert.deepEqual(r.connected, ["anthropic", "fake"]);
    // Nothing is cached past completion: the next call reads opencode again.
    await getProviders();
    assert.equal(only(calls, "GET", "/api/provider").length, 2);
  });
  assert.equal(only(calls, "GET", "/api/model").length, 2);
});

test("getDefaultModel: the default of the first connected provider that has one; null otherwise (never re-throws)", async () => {
  await withV2(PROVIDER_ROUTES(), async () => {
    assert.deepEqual(await getDefaultModel(), { providerID: "anthropic", modelID: "claude-haiku-4-5" });
  });
  await withV2(PROVIDER_ROUTES({ "GET /api/model/default": () => new Response("x", { status: 404 }) }), async () => {
    assert.equal(await getDefaultModel(), null);
  });
  _setOcTransport(async () => { throw new Error("down"); });
  assert.equal(await getDefaultModel(), null);
  _setOcTransport(null);
});

test("listModels: normalized models for CONNECTED providers only; overrides applied by providerID/modelID", async () => {
  await withV2(PROVIDER_ROUTES(), async () => {
    const out = await listModels({ "anthropic/claude-haiku-4-5": { name: "Mine", context: 500000 } });
    assert.deepEqual(out.map((m) => `${m.providerID}/${m.id}`), ["anthropic/claude-haiku-4-5", "fake/fm"]);
    assert.equal(out[0].name, "Mine");
    assert.equal(out[0].limit.context, 500000);
    assert.deepEqual(out[0].variants, [{ id: "high" }]);
    assert.equal(out[0].cost.cacheWrite, 1.25);
  });
});

test("listModels returns [] when nothing is connected and on a transport throw", async () => {
  await withV2({ "GET /api/provider": { data: [] }, "GET /api/integration": { data: [] }, "GET /api/model": { data: [] }, "GET /api/model/default": { data: null } }, async () => {
    assert.deepEqual(await listModels(), []);
  });
  _setOcTransport(async () => { throw new Error("down"); });
  assert.deepEqual(await listModels(), []);
  _setOcTransport(null);
});

test("pickCheapModel prefers a small-model name on a real (non-free-tier) provider, cheapest first", async () => {
  const models = [
    { providerID: "opencode", id: "free", cost: { input: 0 } },
    { providerID: "anthropic", id: "claude-opus-5-5", cost: { input: 5 } },
    { providerID: "anthropic", id: "claude-haiku-5-5", cost: { input: 1 } },
    { providerID: "openai", id: "gpt-mini", cost: { input: 0.5 } },
    { providerID: "anthropic", id: "old-haiku", status: "deprecated", cost: { input: 0.1 } },
  ];
  assert.equal((await pickCheapModel(async () => models)).id, "gpt-mini");
  assert.equal(await pickCheapModel(async () => []), null);
  assert.equal(await pickCheapModel(async () => { throw new Error("x"); }), null);
  assert.equal((await pickCheapModel(async () => [{ providerID: "a", id: "big", cost: { input: 3 } }, { providerID: "a", id: "bigger", cost: { input: 4 } }])).id, "big");
});

// ---------------------------------------------------------------------------
// one-shot text (auto-rename / constraint extraction)
// ---------------------------------------------------------------------------

test("generateSessionTitle uses POST /api/experimental/generate on a cheap connected model — no session is created", async () => {
  const calls = await withV2(
    { ...PROVIDER_ROUTES(), "POST /api/experimental/generate": { data: { text: "Fix login bug" } } },
    async () => {
      assert.equal(await generateSessionTitle({ directory: "/w", instruction: "title this" }), "Fix login bug");
    },
  );
  const gen = only(calls, "POST", "/api/experimental/generate")[0];
  assert.equal(gen.body.prompt, "title this");
  assert.deepEqual(gen.body.model, { providerID: "anthropic", id: "claude-haiku-4-5" });
  assert.equal(calls.some((c) => c.path === "/api/session"), false);
  assert.equal("format" in gen.body, false, "never a structured-output field");
});

test("generateText returns '' on any failure; an explicit model is used as given; runThrowawayAgent delegates", async () => {
  await withV2({ "POST /api/experimental/generate": () => new Response("x", { status: 503 }) }, async () => {
    assert.equal(await generateText({ instruction: "x", model: { providerID: "p", id: "m" } }), "");
  });
  const calls = await withV2({ "POST /api/experimental/generate": { data: { text: "ok" } } }, async () => {
    assert.equal(await generateText({ instruction: "x", model: { providerID: "p", modelID: "m" } }), "ok");
    assert.equal(await runThrowawayAgent({ directory: "/w", instruction: "y", agent: "title" }) !== undefined, true);
  });
  assert.deepEqual(calls[0].body.model, { providerID: "p", id: "m" });
});

// ---------------------------------------------------------------------------
// the throwaway SESSION primitive (still a real session: CTO ephemerals, health probes)
// ---------------------------------------------------------------------------

test("headless primitive records provenance before prompt and returns safe structured errors", async () => {
  const { runSynchronousSession } = await import("./opencode.mjs");
  const { resolvePipelineSession } = await import("./internalSessions.mjs");
  let deleted = false;
  await withMockFetch(async (url, opts) => {
    const u = String(url);
    if (opts?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
    if (u.endsWith("/prompt")) {
      assert.equal((await resolvePipelineSession("internal-error", async () => [])).owner, "cto");
      return new Response("SECRET provider response", { status: 503 });
    }
    if (opts?.method === "POST" && u.endsWith("/api/session")) return json({ data: { id: "internal-error" } });
    return json({ data: { id: "internal-error" } });
  }, async () => {
    const result = await runSynchronousSession({ directory: "/work", instruction: "summarize" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "prompt-http");
    assert.ok(!JSON.stringify(result).includes("SECRET"));
  });
  assert.equal(deleted, true);
  assert.equal((await resolvePipelineSession("internal-error", async () => [])).owner, "cto");
});

for (const final of ["complete", "error"]) {
  test(`headless primitive waits through partial text before terminal ${final}`, async () => {
    const { runSynchronousSession } = await import("./opencode.mjs");
    let polls = 0;
    let deleted = 0;
    await withMockFetch(async (url, opts) => {
      const u = String(url);
      if (opts?.method === "DELETE") {
        assert.equal(polls, 2, "must not delete during partial output");
        deleted++;
        return new Response(null, { status: 204 });
      }
      if (u.endsWith("/prompt")) return new Response(null, { status: 204 });
      if (u.includes("/message")) {
        polls++;
        const done = polls === 2;
        const row = { id: "m1", type: "assistant", time: done ? { created: 1, completed: 2 } : { created: 1 }, content: [{ type: "text", text: polls === 1 ? "part" : "complete" }] };
        if (done) {
          row.finish = final === "error" ? "error" : "stop";
          if (final === "error") row.error = { type: "provider.internal", message: "SECRET" };
        }
        return json({ data: [row], cursor: { next: null } });
      }
      return json({ data: { id: `partial-${final}` } });
    }, async () => {
      const result = await runSynchronousSession({ directory: "/work", instruction: "test", pollIntervalMs: 0, maxAttempts: 3 });
      assert.equal(result.ok, final === "complete");
      assert.equal(result.text, final === "complete" ? "complete" : "");
      if (final === "error") assert.equal(result.code, "model-error");
      assert.ok(!JSON.stringify(result).includes("SECRET"));
    });
    assert.equal(deleted, 1);
  });
}

for (const cleanupFails of [false, true]) {
  test(`provenance write failure never prompts and reports cleanup failure=${cleanupFails}`, async () => {
    const { runSynchronousSession } = await import("./opencode.mjs");
    let deleted = false;
    await withMockFetch(async (url, opts) => {
      assert.ok(!String(url).endsWith("/prompt"));
      if (opts?.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: cleanupFails ? 503 : 204 });
      }
      return json({ data: { id: "provenance-failed" } });
    }, async () => {
      const result = await runSynchronousSession({ directory: "/work", instruction: "test",
        trackCreation: () => async () => { throw new Error("SECRET disk failure"); },
      });
      assert.equal(result.code, "provenance-error");
      assert.equal(result.cleanupCode, cleanupFails ? "cleanup-error" : undefined);
      assert.equal(result.ok, false);
    });
    assert.equal(deleted, true);
  });
}

// ---------------------------------------------------------------------------
// provider connect flows
// ---------------------------------------------------------------------------

test("listProviderAuthMethods maps V2 methods onto the resolveAuthMethod vocabulary (key → api)", async () => {
  await withV2({ "GET /api/integration": { data: [{ id: "openai", methods: [{ id: "chatgpt", type: "oauth", label: "ChatGPT" }, { type: "key" }], connections: [] }] } }, async () => {
    const r = await listProviderAuthMethods();
    assert.equal(r.ok, true);
    assert.deepEqual(r.methods.openai.map((m) => m.type), ["oauth", "api"]);
    assert.equal(r.methods.openai[0].label, "ChatGPT");
  });
  await withV2({ "GET /api/integration": () => new Response("x", { status: 500 }) }, async () => {
    assert.equal((await listProviderAuthMethods()).error, "bad_response");
  });
});

test("startProviderOauth resolves the method index to its id, returns url/mode; completeProviderOauth finishes THAT attempt", async () => {
  const calls = await withV2(
    {
      "GET /api/integration/openai": { data: { id: "openai", methods: [{ id: "chatgpt", type: "oauth", label: "x" }] } },
      "POST /api/integration/openai/connect/oauth": { data: { attemptID: "att_1", url: "https://auth/x", instructions: "enter code", mode: "code" } },
      "POST /api/integration/openai/connect/oauth/att_1/complete": null,
    },
    async () => {
      const s = await startProviderOauth("openai", 0);
      assert.deepEqual(s, { ok: true, url: "https://auth/x", method: "code", instructions: "enter code" });
      assert.deepEqual(await completeProviderOauth("openai", 0, "ABCD"), { ok: true });
      assert.equal((await completeProviderOauth("openai", 0, "")).ok, false, "the attempt is consumed");
    },
  );
  assert.deepEqual(only(calls, "POST", "/api/integration/openai/connect/oauth")[0].body, { methodID: "chatgpt" });
  assert.deepEqual(only(calls, "POST", "/api/integration/openai/connect/oauth/att_1/complete")[0].body, { code: "ABCD" });
});

test("completeProviderOauth omits code for an auto-mode flow; a 401 is `unauthorized`", async () => {
  const calls = await withV2(
    {
      "GET /api/integration/openai": { data: { id: "openai", methods: [{ id: "dev", type: "oauth" }] } },
      "POST /api/integration/openai/connect/oauth": { data: { attemptID: "att_2", url: "u", instructions: "", mode: "auto" } },
      "POST /api/integration/openai/connect/oauth/att_2/complete": null,
    },
    async () => {
      assert.equal((await startProviderOauth("openai", 0)).method, "auto");
      assert.deepEqual(await completeProviderOauth("openai", 0, ""), { ok: true });
    },
  );
  assert.deepEqual(only(calls, "POST", "/api/integration/openai/connect/oauth/att_2/complete")[0].body, {});
  await withV2(
    {
      "GET /api/integration/openai": { data: { id: "openai", methods: [{ id: "dev", type: "oauth" }] } },
      "POST /api/integration/openai/connect/oauth": { data: { attemptID: "att_3", url: "u", instructions: "", mode: "code" } },
      "POST /api/integration/openai/connect/oauth/att_3/complete": () => new Response("bad", { status: 401 }),
    },
    async () => {
      await startProviderOauth("openai", 0);
      assert.equal((await completeProviderOauth("openai", 0, "x")).error, "unauthorized");
    },
  );
});

test("setProviderApiKey POSTs the key and never echoes it; removeProviderAuth deletes every stored credential (idempotent)", async () => {
  const calls = await withV2(
    {
      "POST /api/integration/kimi/connect/key": null,
      "GET /api/credential": { data: [{ id: "c1", integrationID: "kimi" }, { id: "c2", integrationID: "other" }, { id: "c3", integrationID: "kimi" }] },
      "DELETE /api/credential/c1": null,
      "DELETE /api/credential/c3": null,
    },
    async () => {
      const r = await setProviderApiKey("kimi", "sk-secret");
      assert.deepEqual(r, { ok: true });
      assert.ok(!JSON.stringify(r).includes("sk-secret"));
      assert.deepEqual(await removeProviderAuth("kimi"), { ok: true });
    },
  );
  assert.deepEqual(only(calls, "POST", "/api/integration/kimi/connect/key")[0].body, { key: "sk-secret" });
  assert.deepEqual(calls.filter((c) => c.method === "DELETE").map((c) => c.path), ["/api/credential/c1", "/api/credential/c3"]);
  await withV2({ "GET /api/credential": { data: [] } }, async () => assert.deepEqual(await removeProviderAuth("kimi"), { ok: true }));
  await withV2({ "POST /api/integration/kimi/connect/key": () => new Response("no", { status: 401 }) }, async () => {
    assert.equal((await setProviderApiKey("kimi", "k")).error, "unauthorized");
  });
});

// ---------------------------------------------------------------------------
// commands, agents, files, references
// ---------------------------------------------------------------------------

test("listCommands / listAgents / findFiles / listReferences read the V2 routes in the old shapes", async () => {
  await withV2(
    {
      "GET /api/command": { data: [{ name: "init", description: "setup" }] },
      "GET /api/agent": { data: [{ id: "build", mode: "primary", description: "d" }, { id: "plan", mode: "primary" }] },
      "GET /api/fs/find": { data: [{ path: "notes.txt", type: "file" }, { path: "src", type: "directory" }] },
      "GET /api/reference": { data: [{ name: "docs", path: "/d", source: { type: "local", path: "/d" } }, { name: "lib", source: { type: "git", repository: "https://g/x", branch: "main" }, description: "L" }] },
    },
    async () => {
      assert.deepEqual((await listCommands()).map((c) => [c.name, c.description]), [["init", "setup"]]);
      assert.deepEqual((await listAgents()).map((a) => [a.name, a.mode]), [["build", "primary"], ["plan", "primary"]]);
      assert.deepEqual(await findFiles({ query: "no", directory: "/w" }), ["notes.txt", "src"]);
      assert.deepEqual(await listReferences(), [{ name: "docs", path: "/d" }, { name: "lib", description: "L", repository: "https://g/x", branch: "main" }]);
    },
  );
});

test("findFiles scopes the search with location[directory]", async () => {
  const calls = await withV2({ "GET /api/fs/find": { data: [] } }, async () => {
    await findFiles({ query: "a b", directory: "/w x" });
  });
  assert.equal(calls[0].query["location[directory]"], "/w x");
  assert.equal(calls[0].query.query, "a b");
});

test("listReferences degrades to [] when the payload has no data array", async () => {
  await withV2({ "GET /api/reference": {} }, async () => assert.deepEqual(await listReferences(), []));
});

// ---------------------------------------------------------------------------
// the event stream
// ---------------------------------------------------------------------------

const sseBody = (chunks) =>
  new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  });

test("subscribeEvents: ONE global /api/event stream; frames are parsed, heartbeats ignored; onConnect(reconnect) fires per connect", async () => {
  const urls = [];
  const connects = [];
  const got = [];
  let n = 0;
  _setEventStreamTransport(async (url) => {
    urls.push(String(url));
    n++;
    return { ok: true, body: sseBody(n === 1 ? [': heartbeat\n\ndata: {"id":"e1","type":"server.connected","data":{}}\n\n', 'data: {"id":"e2","type":"session.text.delta","da', 'ta":{"delta":"hi"}}\n\n'] : ['data: {"id":"e3","type":"x","data":{}}\n\n']) };
  });
  const stop = subscribeEvents((e) => got.push(e.id), { onConnect: (i) => connects.push(i.reconnect), reconnectMs: 10 });
  await new Promise((r) => setTimeout(r, 120));
  stop();
  _setEventStreamTransport(null);
  assert.deepEqual(got.slice(0, 3), ["e1", "e2", "e3"], "split frames are re-assembled");
  assert.deepEqual(connects.slice(0, 2), [false, true]);
  assert.ok(urls.every((u) => u === "http://127.0.0.1:4096/api/event"), "never a per-directory stream");
});

test("subscribeEvents: a non-OK connect retries; stop() ends the loop and aborts the connection", async () => {
  let attempts = 0;
  let aborted = false;
  _setEventStreamTransport(async (_url, init) => {
    attempts++;
    init.signal.addEventListener("abort", () => { aborted = true; });
    if (attempts === 1) return { ok: false, status: 503, statusText: "no" };
    return { ok: true, body: new ReadableStream({ start() {} }) };
  });
  const stop = subscribeEvents(() => {}, { reconnectMs: 10 });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(attempts, 2);
  stop();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(aborted, true);
  const before = attempts;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(attempts, before);
  _setEventStreamTransport(null);
});

test("a throwing onEvent or onConnect never kills the stream", async () => {
  _setEventStreamTransport(async () => ({ ok: true, body: sseBody(['data: {"id":"a","type":"x","data":{}}\n\ndata: {"id":"b","type":"x","data":{}}\n\n']) }));
  const got = [];
  const stop = subscribeEvents((e) => { got.push(e.id); if (e.id === "a") throw new Error("boom"); }, { onConnect: () => { throw new Error("c"); }, reconnectMs: 60_000 });
  await new Promise((r) => setTimeout(r, 40));
  stop();
  _setEventStreamTransport(null);
  assert.deepEqual(got, ["a", "b"]);
});

test("knownSessionDirectories / cachedSessionDirectory read the session→directory cache (distinct dirs, optional filter)", async () => {
  await withV2({ "POST /api/session": () => ({ data: SESSION({ id: `ses_${Math.random().toString(36).slice(2, 8)}` }) }) }, async () => {
    _resetSessionDirectoryCache();
    const a = await createSession({ directory: "/work/proj" });
    const b = await createSession({ directory: "/work/proj" });
    assert.deepEqual(knownSessionDirectories(), ["/work/proj"], "distinct");
    assert.deepEqual(knownSessionDirectories((id) => id === a.id), ["/work/proj"]);
    assert.deepEqual(knownSessionDirectories(() => false), []);
    assert.equal(cachedSessionDirectory(b.id), "/work/proj");
    assert.equal(cachedSessionDirectory("ses_none"), null);
  });
});


// ---------------------------------------------------------------------------
// unchanged by the V2 cutover
// ---------------------------------------------------------------------------

// Loopback connection pooling (BET-65)
//
// Global fetch (undici) opened a fresh 127.0.0.1:4096 socket per call that
// lingered in TIME_WAIT; a list/reconcile sweep exhausted the loopback
// ephemeral-port range (EADDRNOTAVAIL). ocFetch now routes through a shared
// keep-alive http.Agent so sockets are reused. These guard the pool config and
// the body-drain helper that keeps pooled sockets from being pinned open.
// ---------------------------------------------------------------------------

test("ocFetch keep-alive agent is a single module-scope instance", () => {
  // Referential stability across calls — the pool must not be re-created per
  // request (that would defeat reuse and re-introduce socket churn).
  assert.equal(_getOcAgent(), _getOcAgent());
});

test("ocFetch agent is keep-alive and capped at 16 sockets", () => {
  const agent = _getOcAgent();
  assert.equal(agent.keepAlive, true, "agent must keep sockets alive for reuse");
  assert.equal(agent.maxSockets, 16, "pool must be capped at 16 sockets");
  assert.equal(agent.maxFreeSockets, 16, "free-socket cap should match maxSockets");
});

test("discardBody cancels an unread body (frees the pooled socket)", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const res = new Response(body, { status: 500 });
  await discardBody(res);
  assert.equal(cancelled, true, "discardBody must cancel the response body");
});

test("discardBody is a no-op on a bodyless response (no throw)", async () => {
  const res = new Response(null, { status: 204 });
  await discardBody(res); // must not throw
  assert.ok(true);
});

test("discardBody swallows errors on an already-consumed body", async () => {
  const res = new Response("already read", { status: 500 });
  await res.text(); // consume it
  await discardBody(res); // cancelling a used body would throw — must be swallowed
  assert.ok(true);
});

test("pooled ocFetch reuses one socket across sequential calls", async () => {
  // A real local server: N sequential ocFetch calls must reuse a bounded
  // number of sockets (not open N), proving the keep-alive pool works.
  const { createServer } = await import("node:http");
  const remotePorts = new Set();
  const server = createServer((req, res) => {
    remotePorts.add(req.socket.remotePort);
    res.end("ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 25; i++) {
      const res = await _pooledOcRequest(base + "/x");
      await res.text();
    }
    assert.ok(
      remotePorts.size <= 2,
      `expected sequential calls to reuse ~1 socket, saw ${remotePorts.size}`,
    );
  } finally {
    server.close();
  }
});


// listRoutableModels — the single routable-catalogue helper (BET-1229). Auto's
// consent set: a model is routable only when it is connected AND active AND
// enabled AND not deactivated for the surface AND opted-in if deprecated. The
// user's ticks are the only consent expression, so this filters the raw
// connected catalogue for whoever routes.
// ---------------------------------------------------------------------------

const routableCatalogue = [
  // connected + active + enabled → routable everywhere
  { providerID: "anthropic", id: "claude-opus-4", name: "Opus 4", status: "active", enabled: true },
  // `status` absent → routable
  { providerID: "anthropic", id: "claude-sonnet-4", name: "Sonnet 4" },
  // `enabled: false` → never routable
  { providerID: "anthropic", id: "claude-haiku-4", name: "Haiku 4", status: "active", enabled: false },
  // `status: "deprecated"` → only with opt-in
  { providerID: "anthropic", id: "claude-low-1", name: "Low 1", status: "deprecated" },
  // `status` some other non-active value → never routable
  { providerID: "openai", id: "gpt-5", name: "GPT-5", status: "retired" },
];

test("listRoutableModels: empty/absent config excludes nothing (fresh box)", async () => {
  const out = await listRoutableModels("sub", undefined, async () => routableCatalogue);
  const keys = out.map((m) => `${m.providerID}/${m.id}`).sort();
  // openai/gpt-5 is retired and anthropic/claude-haiku-4 is disabled → still
  // excluded by status/enabled; everything else survives an empty config.
  assert.deepEqual(keys, ["anthropic/claude-opus-4", "anthropic/claude-sonnet-4"]);
});

test("listRoutableModels: main/surface deactivation are independent", async () => {
  const cfg = {
    deactivatedMainModels: ["anthropic/claude-opus-4"],
    deactivatedSubagents: ["anthropic/claude-sonnet-4"],
  };
  const main = await listRoutableModels("main", cfg, async () => routableCatalogue);
  const mainKeys = main.map((m) => `${m.providerID}/${m.id}`);
  // opus-4 is deactivated for main (absent) but sonnet-4 (not in main's set) survives.
  assert.ok(!mainKeys.includes("anthropic/claude-opus-4"), "main must drop main-deactivated opus-4");
  assert.ok(mainKeys.includes("anthropic/claude-sonnet-4"), "main keeps sub-only-deactivated sonnet-4");

  const sub = await listRoutableModels("sub", cfg, async () => routableCatalogue);
  const subKeys = sub.map((m) => `${m.providerID}/${m.id}`);
  // vice-versa: sub drops sub-deactivated sonnet-4, keeps opus-4.
  assert.ok(!subKeys.includes("anthropic/claude-sonnet-4"), "sub must drop sub-deactivated sonnet-4");
  assert.ok(subKeys.includes("anthropic/claude-opus-4"), "sub keeps main-only-deactivated opus-4");
});

test("listRoutableModels: deprecated model requires opt-in", async () => {
  // claude-low-1 is deprecated; without opt-in it is dropped, with opt-in kept.
  const noOptIn = await listRoutableModels("sub", {}, async () => routableCatalogue);
  assert.ok(!noOptIn.some((m) => m.id === "claude-low-1"), "deprecated absent without opt-in");

  const opted = await listRoutableModels(
    "sub",
    { optInModels: ["anthropic/claude-low-1"] },
    async () => routableCatalogue,
  );
  assert.ok(opted.some((m) => m.id === "claude-low-1"), "deprecated present once opted-in");
});

test("listRoutableModels: status != active and enabled:false are always excluded", async () => {
  const out = await listRoutableModels("main", {}, async () => routableCatalogue);
  const keys = out.map((m) => `${m.providerID}/${m.id}`);
  assert.ok(!keys.includes("anthropic/claude-haiku-4"), "enabled:false excluded");
  assert.ok(!keys.includes("openai/gpt-5"), "status retired excluded");
});

// _normalizeProviderModel — the single chokepoint every raw provider model
// passes through. BET-1228: it must CARRY price (incl. cache rates), expose
// `toolcall` under its own name (not the renamed `tools`), and preserve
// `reasoning`. The absence of price is invisible at runtime (every model
// scores equal), so these tests are the only thing pinning it.
// ---------------------------------------------------------------------------

test("_normalizeProviderModel carries price and cache rates through", () => {
  const m = _normalizeProviderModel("anthropic", "claude-opus-4-7", {
    id: "claude-opus-4-7",
    cost: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
  });
  assert.deepEqual(m.cost, {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
  });
});

test("_normalizeProviderModel distinguishes 0 from missing cost (never 0 for unknown)", () => {
  const zero = _normalizeProviderModel("p", "m0", { id: "m0", cost: { input: 0 } });
  assert.equal(zero.cost.input, 0);
  assert.equal(zero.cost.output, undefined);

  const missing = _normalizeProviderModel("p", "m1", { id: "m1", cost: {} });
  assert.equal(missing.cost.input, undefined);
  assert.equal(missing.cost.output, undefined);

  const absent = _normalizeProviderModel("p", "m2", { id: "m2" });
  assert.equal(absent.cost.input, undefined);
  assert.equal(absent.cost.output, undefined);
});

test("_normalizeProviderModel drops NaN and negative cost values (to undefined)", () => {
  const m = _normalizeProviderModel("p", "m", {
    id: "m",
    cost: { input: NaN, output: -3, cache: { read: Infinity } },
  });
  assert.equal(m.cost.input, undefined);
  assert.equal(m.cost.output, undefined);
  assert.equal(m.cost.cacheRead, undefined);
  assert.equal(m.cost.cacheWrite, undefined);
});

test("_normalizeProviderModel keeps toolcall under its own name and preserves false", () => {
  const m = _normalizeProviderModel("p", "m", {
    id: "m",
    capabilities: { toolcall: false, attachment: true },
  });
  assert.equal(m.capabilities.toolcall, false);
  assert.equal(m.capabilities.tools, undefined);
  assert.equal(m.capabilities.attachment, true);
});

test("_normalizeProviderModel carries reasoning through", () => {
  const m = _normalizeProviderModel("p", "m", {
    id: "m",
    capabilities: { reasoning: true },
  });
  assert.equal(m.capabilities.reasoning, true);
});

test("stripDuplicateToolOutput is lossless and tolerant", () => {
  // Exact duplicate removed.
  assert.deepEqual(
    stripDuplicateToolOutput({
      id: "m",
      parts: [{ type: "tool", state: { output: "X", metadata: { output: "X", a: 1 } } }],
    }).parts[0].state,
    { output: "X", metadata: { a: 1 } },
  );
  // Not an object / missing → left alone.
  assert.deepEqual(stripDuplicateToolOutput({ id: "m" }), { id: "m" });
  assert.deepEqual(stripDuplicateToolOutput(null), null);
  assert.deepEqual(stripDuplicateToolOutput({ id: "m", parts: [{ type: "tool" }] }), {
    id: "m",
    parts: [{ type: "tool" }],
  });
});

test("slimTranscript drops unrendered parts + the duplicated tool stdout", () => {
  const messages = [
    {
      id: "m1",
      info: { role: "assistant" },
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "x".repeat(500) },
        { type: "step-finish" },
        { type: "text", text: "hello" },
        { type: "tool", state: { output: "OUT", metadata: { output: "OUT", exit: 0 } } },
      ],
    },
  ];
  const slim = slimTranscript(messages);
  assert.deepEqual(
    slim[0].parts.map((p) => p.type),
    ["text", "tool"],
    "only the part types the client renders survive",
  );
  assert.deepEqual(
    slim[0].parts[1].state,
    { output: "OUT", metadata: { exit: 0 } },
    "the duplicate metadata.output is dropped, the rest of metadata kept",
  );
  assert.equal(messages[0].parts.length, 5, "the input must not be mutated");
});

test("slimTranscript keeps a RUNNING tool's live output", () => {
  // While a tool runs, state.output does not exist yet and metadata.output IS
  // the live stream — dropping it would blank the running tool's body. Only
  // the exact-duplicate case is removed.
  const slim = slimTranscript([
    { id: "m1", parts: [{ type: "tool", state: { status: "running", metadata: { output: "live…" } } }] },
  ]);
  assert.equal(slim[0].parts[0].state.metadata.output, "live…");

  // Different strings are also both kept — never assume they duplicate.
  const differing = slimTranscript([
    { id: "m2", parts: [{ type: "tool", state: { output: "final", metadata: { output: "partial" } } }] },
  ]);
  assert.equal(differing[0].parts[0].state.metadata.output, "partial");
});

test("slimTranscript is a DENY-list — an unknown future part type survives", () => {
  const slim = slimTranscript([{ id: "m1", parts: [{ type: "brand-new-thing", v: 1 }] }]);
  assert.deepEqual(slim[0].parts, [{ type: "brand-new-thing", v: 1 }]);
});

test("slimTranscript tolerates malformed payloads", () => {
  assert.deepEqual(slimTranscript([]), []);
  assert.equal(slimTranscript(null), null);
  assert.deepEqual(slimTranscript([{ id: "m1" }]), [{ id: "m1" }]);
  assert.deepEqual(slimTranscript([{ id: "m1", parts: [{ type: "tool" }] }]), [
    { id: "m1", parts: [{ type: "tool" }] },
  ]);
});

// content and never inflate the estimate.
test("estimateMessageListTokens: 0 for empty/missing input", () => {
  assert.equal(estimateMessageListTokens(undefined), 0);
  assert.equal(estimateMessageListTokens(null), 0);
  assert.equal(estimateMessageListTokens([]), 0);
});

test("estimateMessageListTokens: sums part text with ~4 chars/token", () => {
  const messages = [
    {
      info: { role: "assistant", id: "m1", tokens: { input: 128_000, cache: { write: 0 } } },
      parts: [
        { type: "text", text: "this is a summary of the whole conversation" },
        { type: "tool", state: { title: "Bash", output: "hello world one two" } },
      ],
    },
    {
      info: { role: "user", id: "m2" },
      parts: [{ type: "text", text: "short user reply" }],
    },
  ];
  // chars of all string values ÷ 4, ceil
  const chars = "this is a summary of the whole conversation".length
    + "Bash".length
    + "hello world one two".length
    + "short user reply".length;
  assert.equal(estimateMessageListTokens(messages), Math.ceil(chars / 4));
  // Asserts the big numeric token count does NOT inflate the estimate.
  assert.ok(estimateMessageListTokens(messages) < 128_000);
});

test("estimateMessageListTokens: a single empty text message yields 0 not a tiny-to-inflate artifact", () => {
  assert.equal(estimateMessageListTokens([{ info: { role: "user" }, parts: [{ type: "text", text: "" }] }]), 0);
});

// ===== claudeCliStatus (BET-421 §E) =====

test("claudeCliStatus reports installed when a candidate binary exists", () => {
  const status = claudeCliStatus({
    existsFn: (p) => p === "/usr/local/bin/claude",
  });
  assert.equal(status.installed, true);
  assert.equal(status.path, "/usr/local/bin/claude");
});

test("claudeCliStatus reports not-installed when no candidate exists", () => {
  const status = claudeCliStatus({ existsFn: () => false });
  assert.equal(status.installed, false);
  // Falls back to the bare name, which is NOT "installed".
  assert.equal(status.path, "claude");
});

test("claudeCliStatus prefers ~/.local/bin/claude over /usr/local/bin/claude", () => {
  const status = claudeCliStatus({ existsFn: () => true });
  // resolveClaudeBinExists walks candidates in order; the home-dir path wins.
  assert.match(status.path, /\.local\/bin\/claude$/);
  assert.equal(status.installed, true);
});
