// Stage D: the typed OpenCode V2 client behind opencode.mjs / opencodeUpgradeCalls.mjs.
// Pins: the N8 version lock, per-request auth / base URL / pooling / signals through the client's
// custom fetch, the err.status contract, the wire shape of every migrated call, and that every
// operation Manta calls exists in the pinned client.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCode } from "@opencode/client";
import { OPENCODE_V2_VERSION } from "../../scripts/opencode-v2/version.mjs";
import { permissionKeyToV2 } from "../shared/opencodeV2.mjs";
import { createUpgradeV2Calls } from "./opencodeUpgradeCalls.mjs";
import * as oc from "./opencode.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Route table "METHOD /path" → body | Response | (call) => …; anything else is a 599. Records every request. */
async function withV2(routes, fn) {
  const calls = [];
  oc._setOcTransport(async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";
    const call = {
      method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers ?? {},
      signal: init.signal,
      url: String(url),
    };
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
    oc._setOcTransport(null);
    oc._resetSessionDirectoryCache();
  }
  return calls;
}

afterEach(() => {
  oc._setApiBase(null);
  delete process.env.MANTA_OPENCODE_PASSWORD;
});

// ---------------------------------------------------------------------------
// N8: the pin
// ---------------------------------------------------------------------------

test("N8: package.json pins @opencode/client to EXACTLY OPENCODE_V2_VERSION (no range)", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.dependencies["@opencode/client"], OPENCODE_V2_VERSION);
  assert.match(pkg.dependencies["@opencode/client"], /^\d+\.\d+\.\d+$/);
});

test("N8: the lockfile and the installed package are the pinned version too", () => {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  assert.equal(lock.packages["node_modules/@opencode/client"].version, OPENCODE_V2_VERSION);
  assert.equal(lock.packages[""].dependencies["@opencode/client"], OPENCODE_V2_VERSION);
  const installed = JSON.parse(readFileSync(join(ROOT, "node_modules", "@opencode", "client", "package.json"), "utf8"));
  assert.equal(installed.version, OPENCODE_V2_VERSION);
});

// ---------------------------------------------------------------------------
// The custom fetch: per-request auth, per-request base URL, pooling, signals
// ---------------------------------------------------------------------------

test("auth is applied PER REQUEST: a password rotated after the client exists reaches the next call", async () => {
  const auth = () => `Basic ${Buffer.from(`opencode:${process.env.MANTA_OPENCODE_PASSWORD}`).toString("base64")}`;
  process.env.MANTA_OPENCODE_PASSWORD = "one";
  const calls = await withV2({ "GET /api/session/active": { data: {} } }, async () => {
    await oc.listActiveSessionIds();
    const first = auth();
    process.env.MANTA_OPENCODE_PASSWORD = "two";
    await oc.listActiveSessionIds();
    assert.notEqual(first, auth());
  });
  assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from("opencode:one").toString("base64")}`);
  assert.equal(calls[1].headers.authorization, `Basic ${Buffer.from("opencode:two").toString("base64")}`);
});

test("_setApiBase after the client exists re-points the NEXT call (base URL resolved per request)", async () => {
  const calls = await withV2({ "GET /api/session/active": { data: {} } }, async () => {
    await oc.listActiveSessionIds();
    oc._setApiBase("http://127.0.0.1:5555/");
    await oc.listActiveSessionIds();
    oc._setApiBase(null);
    await oc.listActiveSessionIds();
  });
  assert.deepEqual(calls.map((c) => new URL(c.url).origin), ["http://127.0.0.1:4096", "http://127.0.0.1:5555", "http://127.0.0.1:4096"]);
});

test("the client's internal call-context header never leaves the process, and headers reach the transport as a plain object", async () => {
  const calls = await withV2({ "POST /api/session/ses_a/compact": { data: {} } }, async () => {
    await oc.compactSession("ses_a");
  });
  assert.equal(Object.getPrototypeOf(calls[0].headers), Object.prototype);
  assert.equal(calls[0].headers["x-manta-call"], undefined);
  assert.equal(calls[0].headers["content-type"], "application/json");
});

test("the caller's own AbortSignal reaches the transport unchanged", async () => {
  const ac = new AbortController();
  const calls = await withV2({ "GET /api/session/ses_a/inbox": { data: [] } }, async () => {
    await oc.listInbox("ses_a", { signal: ac.signal });
  });
  assert.equal(calls[0].signal, ac.signal);
});

test("typed calls ride the keep-alive pool: two sequential calls reuse ONE socket", async () => {
  let sockets = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: {} }));
  });
  server.on("connection", () => sockets++);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    process.env.MANTA_OPENCODE_PASSWORD = "pw";
    oc._setApiBase(`http://127.0.0.1:${server.address().port}`);
    await oc.listActiveSessionIds();
    await oc.listActiveSessionIds();
    await oc.listActiveSessionIds();
    assert.equal(sockets, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("a transport failure and an abort surface as themselves, not as client wrappers", async () => {
  oc._setOcTransport(async () => {
    const e = new Error("connect ECONNREFUSED");
    e.code = "ECONNREFUSED";
    throw e;
  });
  try {
    await assert.rejects(() => oc.compactSession("ses_a"), (e) => e.code === "ECONNREFUSED" && e.status === undefined && e.name === "Error");
    oc._setOcTransport(
      (url, init) =>
        new Promise((_, rej) => {
          if (init.signal.aborted) return rej(init.signal.reason);
          init.signal.addEventListener("abort", () => rej(init.signal.reason));
        }),
    );
    const ac = new AbortController();
    const p = oc.abortSession("ses_a", { signal: ac.signal });
    ac.abort();
    await assert.rejects(p, (e) => e.name === "AbortError");
  } finally {
    oc._setOcTransport(null);
  }
});

// ---------------------------------------------------------------------------
// err.status classification (load-bearing for job admission)
// ---------------------------------------------------------------------------

test("a non-2xx throws `opencode <label> <status>: <body>` with status + retryAfterMs", async () => {
  await withV2({ "POST /api/session": () => new Response("nope", { status: 429, headers: { "retry-after": "7" } }) }, async () => {
    await assert.rejects(
      () => oc.createSession({ directory: "/d" }),
      (e) => e.message === "opencode createSession 429: nope" && e.status === 429 && e.retryAfterMs === 7000,
    );
  });
  await withV2({ "POST /api/session": () => json({ _tag: "InvalidRequestError", message: "bad" }, 400) }, async () => {
    await assert.rejects(() => oc.createSession({ directory: "/d" }), (e) => e.status === 400 && /^opencode createSession 400: /.test(e.message));
  });
  await withV2({ "POST /api/session": () => new Response("boom", { status: 503 }) }, async () => {
    await assert.rejects(() => oc.createSession({ directory: "/d" }), (e) => e.status === 503 && e.retryAfterMs === undefined);
  });
});

test("the raw-read errors stay status-less, as before (callers treat them as unknown outcomes)", async () => {
  const gone = () => new Response("missing", { status: 404 });
  await withV2(
    {
      "GET /api/session/ses_a/message": gone,
      "GET /api/session": gone,
      "GET /api/session/active": gone,
      "GET /api/reference": gone,
    },
    async () => {
      for (const [fn, msg] of [
        [() => oc.listMessages("ses_a"), "opencode listMessages 404: missing"],
        [() => oc.listRawTimeline("ses_a"), "opencode listRawTimeline 404: missing"],
        [() => oc.listSessions("/d"), "opencode listSessions 404: missing"],
        [() => oc.listChildSessions("ses_p"), "opencode listChildSessions 404: missing"],
        [() => oc.listActiveSessionIds(), "opencode session/active 404: missing"],
        [() => oc.listReferences(), "opencode reference 404: missing"],
      ]) {
        await assert.rejects(fn, (e) => e.message === msg && !("status" in e), msg);
      }
    },
  );
});

test("concurrent calls never see each other's failure", async () => {
  await withV2(
    {
      "GET /api/session/ses_ok": { data: { id: "ses_ok", location: { directory: "/d" } } },
      "GET /api/session/ses_gone": async () => {
        await new Promise((r) => setTimeout(r, 15));
        return new Response("gone", { status: 404 });
      },
    },
    async () => {
      const [a, b, c] = await Promise.all([oc.readSession("ses_gone"), oc.readSession("ses_ok"), oc.sessionExists("ses_gone")]);
      assert.deepEqual(a, { state: "missing" });
      assert.equal(b.state, "found");
      assert.equal(c, false);
    },
  );
});

test("a void operation succeeds on ANY 2xx (the client alone would only take a 204)", async () => {
  for (const reply of [() => new Response(null, { status: 204 }), () => json({ data: true }), () => json({ ok: true }, 201), () => new Response("true", { status: 200 })]) {
    await withV2({ "DELETE /api/session/ses_a": reply, "POST /api/session/ses_a/interrupt": reply }, async () => {
      await oc.deleteSessionRaw("ses_a");
      await oc.abortSession("ses_a");
    });
  }
});

// ---------------------------------------------------------------------------
// The wire: method, path, query and body of every migrated call
// ---------------------------------------------------------------------------

const SES = { id: "ses_a", location: { directory: "/work/proj" }, model: { providerID: "anthropic", id: "claude-haiku-4-5" } };

/** [name, routes, run, expected request list as [METHOD, path, query?, body?] (extra requests allowed only where listed)] */
const WIRE = [
  [
    "createSession (every field)",
    { "POST /api/session": { data: SES } },
    () =>
      oc.createSession({
        directory: "/a",
        title: "t",
        id: "ses_x",
        parentID: "ses_p",
        agent: "build",
        model: { providerID: "p", modelID: "m", variant: "v" },
        permission: [{ permission: "bash", pattern: "**", action: "deny" }],
        metadata: { k: 1 },
      }),
    [
      [
        "POST",
        "/api/session",
        {},
        {
          location: { directory: "/a" },
          id: "ses_x",
          parentID: "ses_p",
          agent: "build",
          model: { providerID: "p", id: "m", variant: "v" },
          title: "t",
          permissions: [{ action: permissionKeyToV2("bash"), resource: "*", effect: "deny" }],
          metadata: { k: 1 },
        },
      ],
    ],
  ],
  ["createSession (minimal)", { "POST /api/session": { data: SES } }, () => oc.createSession({ directory: "/a" }), [["POST", "/api/session", {}, { location: { directory: "/a" } }]]],
  ["moveSession", { "POST /api/session/ses_a/move": null }, () => oc.moveSession("ses_a", "/x"), [["POST", "/api/session/ses_a/move", {}, { directory: "/x" }]]],
  [
    "listMessages (first page, then the cursor)",
    {
      "GET /api/session/ses_a/message": (c) => (c.query.cursor ? { data: [], cursor: {} } : { data: [{ id: "m1", type: "user", content: [] }], cursor: { next: "c1" } }),
      "GET /api/session/ses_a": { data: SES },
    },
    () => oc.listMessages("ses_a"),
    [
      ["GET", "/api/session/ses_a/message", { order: "desc", limit: "200" }],
      ["GET", "/api/session/ses_a/message", { cursor: "c1", limit: "200" }],
      ["GET", "/api/session/ses_a"], // the session's directory, for the titles
    ],
  ],
  [
    "getMessage",
    { "GET /api/session/ses_a/message/msg_1": { data: { id: "msg_1", type: "user", content: [] } }, "GET /api/session/ses_a": { data: SES } },
    () => oc.getMessage("ses_a", "msg_1"),
    [["GET", "/api/session/ses_a/message/msg_1"], ["GET", "/api/session/ses_a"]],
  ],
  [
    "sendPrompt (idle: syncs agent + model, then posts every field)",
    {
      "GET /api/session/ses_a": { data: SES },
      "POST /api/session/ses_a/agent": null,
      "POST /api/session/ses_a/model": null,
      "POST /api/session/ses_a/prompt": { data: { id: "msg_1" } },
    },
    () =>
      oc.sendPrompt({
        sessionId: "ses_a",
        text: "hi",
        agent: "plan",
        model: { providerID: "p", modelID: "m", variant: "high" },
        attachments: [{ remotePath: "/p/a.png", mime: "image/png", filename: "a.png" }],
        mentions: [{ name: "explore", source: { value: "@explore", start: 0, end: 8 } }],
        skills: [{ id: "sk", value: "/sk", start: 0, end: 3 }],
        messageID: "msg_1",
      }),
    [
      ["GET", "/api/session/ses_a"],
      ["POST", "/api/session/ses_a/agent", {}, { agent: "plan" }],
      ["POST", "/api/session/ses_a/model", {}, { model: { providerID: "p", id: "m", variant: "high" } }],
      [
        "POST",
        "/api/session/ses_a/prompt",
        {},
        {
          text: "hi",
          files: [{ uri: "file:///p/a.png", name: "a.png" }],
          agents: [{ name: "explore", mention: { start: 0, end: 8, text: "@explore" } }],
          skills: [{ id: "sk", mention: { start: 0, end: 3, text: "/sk" } }],
          id: "msg_1",
        },
      ],
    ],
  ],
  [
    "sendPrompt (steer: no sync, delivery rides along)",
    { "POST /api/session/ses_a/prompt": { data: {} } },
    () => oc.sendPrompt({ sessionId: "ses_a", text: "now", messageID: "msg_2", delivery: "steer" }),
    [["POST", "/api/session/ses_a/prompt", {}, { text: "now", id: "msg_2", delivery: "steer" }]],
  ],
  ["abortSession", { "POST /api/session/ses_a/interrupt": { data: {} } }, () => oc.abortSession("ses_a"), [["POST", "/api/session/ses_a/interrupt", { resume: "false" }]]],
  ["interruptSession (resume)", { "POST /api/session/ses_a/interrupt": { data: {} } }, () => oc.interruptSession("ses_a", { resume: true }), [["POST", "/api/session/ses_a/interrupt", { resume: "true" }]]],
  ["listInbox", { "GET /api/session/ses_a/inbox": { data: [] } }, () => oc.listInbox("ses_a"), [["GET", "/api/session/ses_a/inbox"]]],
  ["cancelInboxItem", { "DELETE /api/session/ses_a/inbox/inb_1": null }, () => oc.cancelInboxItem("ses_a", "inb_1"), [["DELETE", "/api/session/ses_a/inbox/inb_1"]]],
  ["setInboxDelivery", { "PATCH /api/session/ses_a/inbox/inb_1": null }, () => oc.setInboxDelivery("ses_a", "inb_1", "queue"), [["PATCH", "/api/session/ses_a/inbox/inb_1", {}, { delivery: "queue" }]]],
  ["listActiveSessionIds", { "GET /api/session/active": { data: { ses_a: { type: "running" } } } }, () => oc.listActiveSessionIds(), [["GET", "/api/session/active"]]],
  [
    "readShellOutput",
    { "GET /api/shell/shl_1/output": { data: { output: "x", cursor: 6, size: 6, truncated: false } } },
    () => oc.readShellOutput({ shellID: "shl_1", cursor: 5, directory: "/d" }),
    [["GET", "/api/shell/shl_1/output", { cursor: "5", "location[directory]": "/d" }]],
  ],
  [
    "listSessions (scoped, paged)",
    { "GET /api/session": (c) => (c.query.cursor ? { data: [] } : { data: Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, location: { directory: "/d" } })), cursor: { next: "n1" } }) },
    () => oc.listSessions("/d"),
    [
      ["GET", "/api/session", { limit: "100", directory: "/d" }],
      ["GET", "/api/session", { limit: "100", directory: "/d", cursor: "n1" }],
    ],
  ],
  ["listChildSessions", { "GET /api/session": { data: [] } }, () => oc.listChildSessions("ses_p"), [["GET", "/api/session", { parentID: "ses_p", limit: "100" }]]],
  [
    "listRawTimeline (typed)",
    { "GET /api/session/ses_a/message": { data: [], cursor: {} } },
    () => oc.listRawTimeline("ses_a", { type: "synthetic" }),
    [["GET", "/api/session/ses_a/message", { order: "desc", limit: "200", type: "synthetic" }]],
  ],
  [
    "postSynthetic",
    { "POST /api/session/ses_a/synthetic": { data: {} } },
    () => oc.postSynthetic("ses_a", { id: "msg_1", text: "t", description: "d", metadata: { a: 1 }, delivery: "queue", resume: true }),
    [["POST", "/api/session/ses_a/synthetic", {}, { id: "msg_1", text: "t", description: "d", metadata: { a: 1 }, delivery: "queue", resume: true }]],
  ],
  [
    "forkSession (with and without a cut point)",
    { "POST /api/session/ses_a/fork": { data: { ...SES, id: "ses_b" } } },
    async () => {
      await oc.forkSession({ sessionId: "ses_a", messageID: "msg_9" });
      await oc.forkSession({ sessionId: "ses_a" });
    },
    [
      ["POST", "/api/session/ses_a/fork", {}, { before: "msg_9" }],
      ["POST", "/api/session/ses_a/fork", {}, {}],
    ],
  ],
  ["compactSession", { "POST /api/session/ses_a/compact": { data: {} } }, () => oc.compactSession("ses_a"), [["POST", "/api/session/ses_a/compact", {}, {}]]],
  ["deleteSessionRaw", { "DELETE /api/session/ses_a": null }, () => oc.deleteSessionRaw("ses_a"), [["DELETE", "/api/session/ses_a"]]],
  [
    "generateText",
    { "POST /api/experimental/generate": { data: { text: "ok" } } },
    () => oc.generateText({ instruction: "name it", model: { providerID: "p", modelID: "m" } }),
    [["POST", "/api/experimental/generate", {}, { prompt: "name it", model: { providerID: "p", id: "m" } }]],
  ],
  ["listPermissions (all)", { "GET /api/permission/request": { data: [] } }, () => oc.listPermissions(), [["GET", "/api/permission/request"]]],
  ["listPermissions (one session)", { "GET /api/session/ses_a/permission": { data: [] } }, () => oc.listPermissions("ses_a"), [["GET", "/api/session/ses_a/permission"]]],
  [
    "replyPermission",
    { "POST /api/session/ses_a/permission/per_1/reply": null },
    () => oc.replyPermission({ requestId: "per_1", reply: "once", sessionId: "ses_a" }),
    [["POST", "/api/session/ses_a/permission/per_1/reply", {}, { decision: "once" }]],
  ],
  ["listQuestions (all)", { "GET /api/form": { data: [] } }, () => oc.listQuestions(), [["GET", "/api/form"]]],
  ["listQuestions (one session)", { "GET /api/session/ses_a/form": { data: [] } }, () => oc.listQuestions("ses_a"), [["GET", "/api/session/ses_a/form"]]],
  [
    "replyQuestion / rejectQuestion",
    {
      "GET /api/session/ses_a/form/frm_1": { data: { id: "frm_1", sessionID: "ses_a", title: "Q", metadata: { kind: "question" }, fields: [{ key: "q0", type: "select", title: "Pick", options: [{ value: "a" }] }] } },
      "POST /api/session/ses_a/form/frm_1/reply": null,
      "DELETE /api/session/ses_a/form/frm_1": null,
    },
    async () => {
      await oc.replyQuestion({ requestId: "frm_1", answers: [["a"]], sessionId: "ses_a" });
      await oc.rejectQuestion({ requestId: "frm_1", sessionId: "ses_a" });
    },
    [
      ["GET", "/api/session/ses_a/form/frm_1"],
      ["POST", "/api/session/ses_a/form/frm_1/reply", {}, { answer: { q0: "a" } }],
      ["DELETE", "/api/session/ses_a/form/frm_1"],
    ],
  ],
  [
    "getProviders",
    {
      "GET /api/provider": { data: [] },
      "GET /api/integration": { data: [] },
      "GET /api/model": { data: [] },
      "GET /api/model/default": { data: null },
    },
    () => oc.getProviders(),
    [["GET", "/api/provider"], ["GET", "/api/integration"], ["GET", "/api/model"], ["GET", "/api/model/default"]],
  ],
  ["listProviderAuthMethods", { "GET /api/integration": { data: [{ id: "openai", methods: [{ type: "key" }] }] } }, () => oc.listProviderAuthMethods(), [["GET", "/api/integration"]]],
  [
    "startProviderOauth + completeProviderOauth (code, then auto)",
    {
      "GET /api/integration/openai": { data: { methods: [{ type: "oauth", id: "oa1" }] } },
      "POST /api/integration/openai/connect/oauth": { data: { attemptID: "att_1", url: "u", mode: "code" } },
      "POST /api/integration/openai/connect/oauth/att_1/complete": null,
    },
    async () => {
      assert.equal((await oc.startProviderOauth("openai", 0)).ok, true);
      assert.deepEqual(await oc.completeProviderOauth("openai", 0, "zzz"), { ok: true });
      assert.equal((await oc.startProviderOauth("openai", 0)).ok, true);
      assert.deepEqual(await oc.completeProviderOauth("openai", 0, ""), { ok: true });
    },
    [
      ["GET", "/api/integration/openai"],
      ["POST", "/api/integration/openai/connect/oauth", {}, { methodID: "oa1" }],
      ["POST", "/api/integration/openai/connect/oauth/att_1/complete", {}, { code: "zzz" }],
      ["GET", "/api/integration/openai"],
      ["POST", "/api/integration/openai/connect/oauth", {}, { methodID: "oa1" }],
      ["POST", "/api/integration/openai/connect/oauth/att_1/complete", {}, {}],
    ],
  ],
  [
    "setProviderApiKey",
    { "POST /api/integration/openai/connect/key": null },
    async () => assert.deepEqual(await oc.setProviderApiKey("openai", "sk-x"), { ok: true }),
    [["POST", "/api/integration/openai/connect/key", {}, { key: "sk-x" }]],
  ],
  [
    "setProviderAuthEntry (oauth)",
    { "GET /api/integration/openai": { data: { methods: [{ type: "oauth", id: "oa1" }] } }, "POST /api/credential": { id: "cred_1", integrationID: "openai", value: {} } },
    async () => assert.deepEqual(await oc.setProviderAuthEntry("openai", { type: "oauth", access: "a", refresh: "r", expires: 5, accountId: "acct" }), { ok: true }),
    [
      ["GET", "/api/integration/openai"],
      ["POST", "/api/credential", {}, { integrationID: "openai", activate: true, value: { type: "oauth", methodID: "oa1", refresh: "r", access: "a", expires: 5, metadata: { accountID: "acct" } } }],
    ],
  ],
  [
    "removeProviderAuth (a 404 is fine)",
    {
      "GET /api/credential": { data: [{ id: "c1", integrationID: "openai" }, { id: "c/2", integrationID: "openai" }] },
      "DELETE /api/credential/c1": () => new Response("x", { status: 404 }),
      "DELETE /api/credential/c%2F2": null,
    },
    async () => assert.deepEqual(await oc.removeProviderAuth("openai"), { ok: true }),
    [["GET", "/api/credential"], ["DELETE", "/api/credential/c1"], ["DELETE", "/api/credential/c%2F2"]],
  ],
  [
    "listCommands (project-scoped) / listAgents / findFiles / listReferences",
    {
      "GET /api/command": { data: [] },
      "GET /api/skill": { data: [] },
      "GET /api/agent": { data: [] },
      "GET /api/fs/find": { data: [] },
      "GET /api/reference": { data: [] },
    },
    async () => {
      await oc.listCommands({ directory: "/d" });
      await oc.listAgents();
      await oc.findFiles({ query: "a b", directory: "/d" });
      await oc.listReferences();
    },
    [
      ["GET", "/api/command", { "location[directory]": "/d" }],
      ["GET", "/api/skill", { "location[directory]": "/d" }],
      ["GET", "/api/agent"],
      ["GET", "/api/fs/find", { "location[directory]": "/d", query: "a b", limit: "50" }],
      ["GET", "/api/reference"],
    ],
    { unordered: true },
  ],
  [
    "runCommand",
    {
      "GET /api/skill": { data: [] },
      "GET /api/session/ses_a": { data: SES },
      "POST /api/session/ses_a/command": null,
    },
    () =>
      oc.runCommand({
        sessionId: "ses_a",
        command: "smoke",
        arguments: "go",
        attachments: [{ remotePath: "/p/a.png", mime: "image/png" }],
        delivery: "queue",
      }),
    [
      ["GET", "/api/skill"],
      ["POST", "/api/session/ses_a/command", {}, { name: "smoke", text: "go", files: [{ uri: "file:///p/a.png" }], delivery: "queue" }],
    ],
  ],
  [
    "runSynchronousSession (create → agent → prompt → poll → delete)",
    {
      "POST /api/session": { data: { id: "ses_t" } },
      "GET /api/session/ses_t": { data: { ...SES, id: "ses_t" } },
      "POST /api/session/ses_t/agent": null,
      "POST /api/session/ses_t/prompt": null,
      "GET /api/session/ses_t/message": { data: [{ id: "m1", type: "assistant", time: { created: 1, completed: 2 }, finish: "stop", content: [{ type: "text", text: "ok" }] }], cursor: {} },
      "DELETE /api/session/ses_t": null,
    },
    async () => {
      const r = await oc.runSynchronousSession({
        directory: "/work",
        instruction: "x",
        pollIntervalMs: 0,
        maxAttempts: 2,
        trackCreation: () => async () => {},
        attempts: { beginOperation: async () => {}, markDispatched: async () => {}, recordProviderAttempt: async () => {}, terminalizeOperation: async () => {} },
      });
      assert.equal(r.ok, true);
    },
    [
      ["POST", "/api/session", {}, { location: { directory: "/work" }, title: "manta-throwaway" }],
      ["GET", "/api/session/ses_t"],
      ["POST", "/api/session/ses_t/agent", {}, { agent: "title" }],
      ["POST", "/api/session/ses_t/prompt", {}, { text: "x" }], // + the minted id, checked separately
    ],
    { prefix: true },
  ],
];

for (const [name, routes, run, expected, opts = {}] of WIRE) {
  test(`wire: ${name}`, async () => {
    const calls = await withV2(routes, async () => {
      await run();
    });
    const strip = (c) => [c.method, c.path, c.query, c.body];
    let actual = calls.map(strip);
    let want = expected.map(([m, p, q = {}, b]) => [m, p, q, b]);
    if (opts.prefix) {
      actual = actual.slice(0, want.length);
      // a minted prompt id is the one field the caller does not choose
      const i = want.findIndex(([, p]) => p.endsWith("/prompt"));
      assert.match(actual[i][3].id, /^msg_/);
      delete actual[i][3].id;
    }
    if (opts.unordered) {
      const key = (r) => JSON.stringify(r);
      assert.deepEqual(actual.map(key).sort(), want.map(key).sort());
    } else {
      assert.deepEqual(actual, want);
    }
  });
}

// ---------------------------------------------------------------------------
// The upgrade's own calls (own base URL / fetch / password; V2 messages kept)
// ---------------------------------------------------------------------------

test("upgrade calls: wire shape, own base URL + per-request password, and the `<METHOD> <path> → <status>` error", async () => {
  const seen = [];
  let pw = "one";
  const fetchImpl = async (url, init) => {
    const u = new URL(String(url));
    seen.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.authorization, origin: u.origin, signal: !!init.signal });
    if (u.pathname === "/api/experimental/migration/v1") return json({ status: "completed" });
    if (u.pathname === "/api/plugin") return json({ location: {}, data: ["a", { id: "b", state: { status: "failed" } }, { id: "c", state: { status: "active" } }] });
    if (u.pathname === "/api/session" && init.method === "POST") return json({ data: { id: "ses_u" } });
    if (u.pathname.endsWith("/message")) return json({ data: [{ type: "assistant", content: [{ type: "text", text: "ok" }] }], cursor: {} });
    if (u.pathname.endsWith("/prompt")) return new Response(null, { status: 204 });
    if (u.pathname.endsWith("/wait")) return new Response(null, { status: 204 });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return new Response("unexpected", { status: 599 });
  };
  const calls = createUpgradeV2Calls({ fetchImpl, opencodeUrl: "http://127.0.0.1:9999", password: async () => pw, home: "/home/u" });
  assert.deepEqual(await calls.migrationStatus(), { status: "completed" });
  pw = "two";
  assert.deepEqual(await calls.pluginIds(), ["a", "c"]);
  assert.deepEqual(await calls.tinyTurn(), { ok: true });
  assert.ok(seen.every((r) => r.origin === "http://127.0.0.1:9999" && r.signal));
  assert.equal(seen[0].auth, `Basic ${Buffer.from("opencode:one").toString("base64")}`);
  assert.equal(seen[1].auth, `Basic ${Buffer.from("opencode:two").toString("base64")}`);
  assert.deepEqual(
    seen.map((r) => [r.method, r.path, r.query, r.body]),
    [
      ["GET", "/api/experimental/migration/v1", {}, undefined],
      ["GET", "/api/plugin", { "location[directory]": "/home/u" }, undefined],
      ["POST", "/api/session", {}, { location: { directory: "/home/u" }, model: { providerID: "anthropic", id: "claude-haiku-4-5" } }],
      ["POST", "/api/session/ses_u/prompt", {}, { text: "Reply with the single word: ok" }],
      ["POST", "/api/experimental/session/ses_u/wait", {}, undefined],
      ["GET", "/api/session/ses_u/message", { limit: "20" }, undefined],
      ["DELETE", "/api/session/ses_u", {}, undefined],
    ],
  );
  const failing = createUpgradeV2Calls({ fetchImpl: async () => new Response("x".repeat(500), { status: 500 }), opencodeUrl: "http://127.0.0.1:9999", password: async () => "p", home: "/h" });
  await assert.rejects(() => failing.migrationStatus(), (e) => e.message === `GET /api/experimental/migration/v1 → 500 ${"x".repeat(200)}`);
  assert.deepEqual(await failing.tinyTurn(), { ok: false, error: `POST /api/session → 500 ${"x".repeat(200)}` });
});

// ---------------------------------------------------------------------------
// Contract: every operation Manta calls exists in the pinned client
// ---------------------------------------------------------------------------

test("contract: every client operation opencode.mjs / opencodeUpgradeCalls.mjs call exists in the pinned @opencode/client", () => {
  const client = OpenCode.make({ baseUrl: "http://x" });
  const namespaces = Object.keys(client).join("|");
  const re = new RegExp(`\\bc\\.((?:${namespaces})(?:\\.[a-zA-Z]+)+)\\(`, "g");
  const used = new Set();
  for (const file of ["opencode.mjs", "opencodeUpgradeCalls.mjs"]) {
    const src = readFileSync(join(ROOT, "src", "server", file), "utf8");
    for (const m of src.matchAll(re)) used.add(m[1]);
  }
  assert.ok(used.size >= 35, `expected to find the client operations in the sources, found ${used.size}`);
  const missing = [...used].filter((p) => typeof p.split(".").reduce((o, k) => o?.[k], client) !== "function");
  assert.deepEqual(missing, [], `operations missing from @opencode/client ${OPENCODE_V2_VERSION}`);
});

test("contract: no hand-written /api request is left outside the SSE pump", () => {
  const src = readFileSync(join(ROOT, "src", "server", "opencode.mjs"), "utf8");
  const raw = src
    .split("\n")
    .map((l, i) => [i + 1, l.trim()])
    .filter(([, l]) => !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*") && /["'`]\/api\//.test(l));
  assert.equal(raw.length, 1, `unexpected raw /api requests:\n${raw.map(([i, l]) => `${i}: ${l}`).join("\n")}`);
  assert.match(raw[0][1], /\/api\/event/);
});

test("the tsconfig.server.json gate covers the client modules", () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, "tsconfig.server.json"), "utf8"));
  for (const f of ["opencode.mjs", "opencodeClient.mjs", "opencodeUpgradeCalls.mjs"]) {
    assert.ok(cfg.include.includes(`src/server/${f}`), f);
    assert.match(readFileSync(join(ROOT, "src", "server", f), "utf8"), /^\/\/ @ts-check/, `${f} opts in to checking`);
  }
  assert.ok(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts.typecheck.includes("tsconfig.server.json"));
  assert.ok(readdirSync(join(ROOT, "src", "server")).includes("opencodeClient.mjs"));
});
