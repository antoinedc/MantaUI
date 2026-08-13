import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apiUrl,
  parseSseFrame,
  createSession,
  sendPrompt,
  listMessages,
  getMessage,
  slimTranscript,
  stripDuplicateToolOutput,
  runCommand,
  forkSession,
  compactSession,
  abortSession,
  sessionExists,
  listPermissions,
  listQuestions,
  replyPermission,
  subscribeEvents,
  selectStreamsToEvict,
  isStreamDeaf,
  LIVENESS_TIMEOUT_MS,
  STREAM_IDLE_MS,
  STREAM_MAX,
  _resetSessionDirectoryCache,
  _onSessionDirectoryAdded,
  _setOcTransport,
  _setEventStreamTransport,
  _setReadinessTimeoutMs,
  _resetStreamReadyState,
  _getOcAgent,
  _pooledOcRequest,
  discardBody,
  getProviders,
  getDefaultModel,
  listModels,
  claudeCliStatus,
  parseProviderApiKey,
  readProviderApiKey,
  opencodeAuthPath,
} from "./opencode.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

test("apiUrl targets local opencode port 4096", () => {
  assert.equal(apiUrl("/session"), "http://127.0.0.1:4096/session");
});

test("parseSseFrame extracts JSON from data: lines", () => {
  const evt = parseSseFrame('data: {"type":"message.updated","x":1}');
  assert.equal(evt.type, "message.updated");
});

test("parseSseFrame returns null for comments/keepalive", () => {
  assert.equal(parseSseFrame(": keep-alive"), null);
});

// ---------------------------------------------------------------------------
// parseProviderApiKey (BET-737) — pure parse of opencode's own auth store,
// same split as parseCredentials/readCredsSnapshot. Never touches a real
// file.
// ---------------------------------------------------------------------------

test("parseProviderApiKey extracts the key from an api-type entry", () => {
  const raw = JSON.stringify({ "kimi-for-coding": { type: "api", key: "fake-test-key" } });
  assert.equal(parseProviderApiKey(raw, "kimi-for-coding"), "fake-test-key");
});

test("parseProviderApiKey returns \"\" for a provider with no entry", () => {
  const raw = JSON.stringify({ anthropic: { type: "oauth", access: "x", refresh: "y" } });
  assert.equal(parseProviderApiKey(raw, "kimi-for-coding"), "");
});

test("parseProviderApiKey returns \"\" for an oauth-type entry (no `key` field)", () => {
  const raw = JSON.stringify({ "kimi-for-coding": { type: "oauth", access: "x", refresh: "y" } });
  assert.equal(parseProviderApiKey(raw, "kimi-for-coding"), "");
});

test("parseProviderApiKey returns \"\" for a non-api entry even when it carries a non-empty `key` (type gate)", () => {
  // type === "api" is the discriminant — a stray `key` on an oauth/common
  // entry must never be trusted as a Bearer credential.
  const raw = JSON.stringify({ "kimi-for-coding": { type: "oauth", key: "should-not-leak", access: "x" } });
  assert.equal(parseProviderApiKey(raw, "kimi-for-coding"), "");
  const rawCoding = JSON.stringify({ "kimi-for-coding": { key: "still-no-type" } });
  assert.equal(parseProviderApiKey(rawCoding, "kimi-for-coding"), "");
});

test("parseProviderApiKey returns \"\" for an empty-string key", () => {
  const raw = JSON.stringify({ "kimi-for-coding": { type: "api", key: "" } });
  assert.equal(parseProviderApiKey(raw, "kimi-for-coding"), "");
});

test("parseProviderApiKey returns \"\" for invalid JSON", () => {
  assert.equal(parseProviderApiKey("not json{", "kimi-for-coding"), "");
});

test("parseProviderApiKey returns \"\" for an empty auth store", () => {
  assert.equal(parseProviderApiKey("{}", "kimi-for-coding"), "");
});

test("parseProviderApiKey never echoes the key into an exception (it doesn't throw at all)", () => {
  // Malformed input that would throw if a naive implementation destructured
  // without guarding — assert it degrades to "" instead of leaking anything.
  assert.equal(parseProviderApiKey("null", "kimi-for-coding"), "");
  assert.equal(parseProviderApiKey("[]", "kimi-for-coding"), "");
  assert.equal(parseProviderApiKey('"just a string"', "kimi-for-coding"), "");
});

// readProviderApiKey (BET-740) — the IO wrapper around parseProviderApiKey,
// driven with an INJECTED reader so no case here can touch a real auth store
// on the live box. Missing file / unparseable bytes / absent provider / oauth
// entry all degrade to "" (never throw); a valid api entry returns the key.
const readVia = (text) => readProviderApiKey("kimi-for-coding", {
  readFile: () => text,
});

test("readProviderApiKey returns \"\" when the auth store file is missing (reader throws)", async () => {
  assert.equal(
    await readProviderApiKey("kimi-for-coding", { readFile: () => { throw new Error("ENOENT"); } }),
    "",
  );
});

test("readProviderApiKey returns \"\" for unparseable JSON", async () => {
  assert.equal(await readVia("not json{"), "");
});

test("readProviderApiKey returns \"\" for a provider with no entry", async () => {
  assert.equal(await readVia(JSON.stringify({ anthropic: { type: "oauth", access: "x" } })), "");
});

test("readProviderApiKey returns \"\" for an oauth-type entry (no `key` field)", async () => {
  assert.equal(
    await readVia(JSON.stringify({ "kimi-for-coding": { type: "oauth", access: "x", refresh: "y" } })),
    "",
  );
});

test("readProviderApiKey returns \"\" for a non-api entry even when it carries a non-empty `key` (type gate)", async () => {
  assert.equal(
    await readVia(JSON.stringify({ "kimi-for-coding": { type: "oauth", key: "should-not-leak", access: "x" } })),
    "",
  );
});

test("readProviderApiKey returns the key for a valid api-type entry", async () => {
  assert.equal(
    await readVia(JSON.stringify({ "kimi-for-coding": { type: "api", key: "kimi-provider-key" } })),
    "kimi-provider-key",
  );
});

// opencodeAuthPath (review cycle 2 Nit): mirrors messageSearch.mjs's
// resolveDbPath() for the SAME opencode XDG data directory — XDG_DATA_HOME
// first when set, else homedir()-based. Save/restore the env var so this
// test can't leak state into any other test in the process.
test("opencodeAuthPath resolves under homedir() by default", () => {
  const saved = process.env.XDG_DATA_HOME;
  delete process.env.XDG_DATA_HOME;
  try {
    assert.equal(
      opencodeAuthPath(),
      join(homedir(), ".local", "share", "opencode", "auth.json"),
    );
  } finally {
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
  }
});

test("opencodeAuthPath honours XDG_DATA_HOME when set, like resolveDbPath does", () => {
  const saved = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = "/tmp/xdg-test-home";
  try {
    assert.equal(opencodeAuthPath(), join("/tmp/xdg-test-home", "opencode", "auth.json"));
  } finally {
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
  }
});

// ---------------------------------------------------------------------------
// Session-directory scope
//
// Each session-mutating request (prompt_async, command, fork, compact) must
// carry `?directory=<session.directory>` so opencode:
//   1. runs tools in the project worktree (not the server's startup cwd), AND
//   2. emits its SSE events on the matching scoped /event subscription.
//
// The directory comes from `sessionDirectoryCache`, populated by
// createSession / forkSession / listSessions, and lazy-fetched via
// `GET /session/{id}` on a miss.
// ---------------------------------------------------------------------------

// The non-streaming opencode calls now route through ocFetch → a pooled
// node:http transport (NOT globalThis.fetch, which undici won't let us pool).
// Install the test handler as the ocFetch transport instead. Handler signature
// is unchanged: (url, init) => Promise<Response>.
function withMockFetch(handler, fn) {
  _setOcTransport(handler);
  return fn().finally(() => {
    _setOcTransport(null);
  });
}

// Shared mock-fetch helper for the single-message splice tests: a GET to
// /message/m1 returns `raw` as JSON and everything else 204s. Deduplicates the
// boilerplate the two `getMessage` tests share (duplication-gate, min-tokens 70).
function withMessageFetch(raw, body) {
  return withMockFetch(
    async (url) =>
      String(url).includes("/message/m1")
        ? new Response(JSON.stringify(raw), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response(null, { status: 204 }),
    body,
  );
}

// Shared mock-fetch helper for the cached-session tests: seeds a fresh
// directory cache and serves a GET /session?directory= returning `template`,
// recording every call so the caller can assert on it after the body runs.
// Collapses the createSession/runCommand test setup prefix (duplication-gate).
async function withSessionDirectoryMock(template, body) {
  _resetSessionDirectoryCache();
  const calls = [];
  await withMockFetch(
    async (url, opts) => {
      calls.push({ url: String(url), method: opts?.method ?? "GET" });
      if (String(url).startsWith("http://127.0.0.1:4096/session?directory=")) {
        return new Response(JSON.stringify(template), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    },
    body,
  );
  return { calls };
}

// Shared stream-transport capture preamble for the subscribeEvents tests:
// arms the event stream transport to record every URL it is asked to open,
// resets directory-cache/stream-ready state, and returns callers their
// `openedUrls` plus a `cleanup` that tears the transport down. Collapses the
// three tests' identical setup blocks (duplication-gate).
function setupEventStreamCapture() {
  const openedUrls = [];
  _setEventStreamTransport(async (url) => {
    openedUrls.push(String(url));
    return { ok: true, body: { getReader: () => ({ read: () => new Promise(() => {}), releaseLock() {} }) } };
  });
  _resetSessionDirectoryCache();
  _resetStreamReadyState();
  return { openedUrls, cleanup: () => _setEventStreamTransport(null) };
}

test("createSession primes directory cache; sendPrompt then appends ?directory=", async () => {
  const { calls } = await withSessionDirectoryMock(
    { id: "ses_x", title: "t", directory: "/work/proj", projectID: "pid" },
    async () => {
      await createSession({ directory: "/work/proj", title: "t" });
      await sendPrompt({ sessionId: "ses_x", text: "hi" });
    },
  );
  const prompt = calls.find((c) => c.url.includes("/prompt_async"));
  assert.ok(prompt, `expected prompt_async call, got ${JSON.stringify(calls)}`);
  assert.ok(
    prompt.url.includes("directory=%2Fwork%2Fproj"),
    `prompt URL missing scoped directory: ${prompt.url}`,
  );
});

test("createSession expands a leading ~ before POSTing (no /home/$USER/~ corruption)", async () => {
  // Regression: resolveProjectCwd (/clear, /fork) returns raw `~/projects/x`.
  // createSession passed it straight to opencode, which resolves the tilde
  // against its OWN server cwd ($HOME) and persists `/home/<user>/~/projects/x`.
  // The fix expands `~` here at the creation chokepoint. Assert the POSTed
  // ?directory= is the absolute home-expanded path and contains no literal `~`.
  _resetSessionDirectoryCache();
  const calls = [];
  const home = (await import("node:os")).homedir();
  await withMockFetch(
    async (url, opts) => {
      calls.push({ url: String(url), method: opts?.method ?? "GET" });
      if (String(url).startsWith("http://127.0.0.1:4096/session?directory=")) {
        // Echo back whatever directory we were sent so the test asserts on
        // OUR input, not a server-canonicalized value.
        const sent = decodeURIComponent(
          String(url).split("?directory=")[1].split("&")[0],
        );
        return new Response(
          JSON.stringify({ id: "ses_t", title: "t", directory: sent, projectID: "p" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    },
    async () => {
      await createSession({ directory: "~/projects/better-ui", title: "t" });
    },
  );
  const create = calls.find((c) =>
    c.url.startsWith("http://127.0.0.1:4096/session?directory="),
  );
  assert.ok(create, "expected a /session create call");
  const sentDir = decodeURIComponent(
    create.url.split("?directory=")[1].split("&")[0],
  );
  assert.equal(
    sentDir,
    `${home}/projects/better-ui`,
    "createSession must expand ~ to an absolute path",
  );
  assert.ok(
    !sentDir.includes("~"),
    `directory still contains a literal tilde: ${sentDir}`,
  );
});

test("createSession leaves an already-absolute directory untouched", async () => {
  _resetSessionDirectoryCache();
  const calls = [];
  await withMockFetch(
    async (url, opts) => {
      calls.push(String(url));
      if (String(url).startsWith("http://127.0.0.1:4096/session?directory=")) {
        return new Response(
          JSON.stringify({ id: "ses_a", title: "t", directory: "/srv/app", projectID: "p" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    },
    async () => {
      await createSession({ directory: "/srv/app", title: "t" });
    },
  );
  const create = calls.find((u) =>
    u.startsWith("http://127.0.0.1:4096/session?directory="),
  );
  const sentDir = decodeURIComponent(create.split("?directory=")[1].split("&")[0]);
  assert.equal(sentDir, "/srv/app", "absolute dir must pass through unchanged");
});

test("runCommand carries ?directory= from cached session", async () => {
  const { calls } = await withSessionDirectoryMock(
    { id: "ses_q", title: "t", directory: "/work/repo", projectID: "pid" },
    async () => {
      await createSession({ directory: "/work/repo", title: "t" });
      await runCommand({ sessionId: "ses_q", command: "do", arguments: "" });
    },
  );
  const cmd = calls.find((c) => c.url.includes("/command"));
  assert.ok(cmd, "expected /command call");
  assert.ok(
    cmd.url.includes("directory=%2Fwork%2Frepo"),
    `command URL missing scoped directory: ${cmd.url}`,
  );
});

test("sendPrompt lazy-fetches directory via GET /session/{id} on cache miss", async () => {
  _resetSessionDirectoryCache();
  const calls = [];
  await withMockFetch(
    async (url, opts) => {
      calls.push({ url: String(url), method: opts?.method ?? "GET" });
      if (
        String(url) === "http://127.0.0.1:4096/session/ses_miss" &&
        (opts?.method ?? "GET") === "GET"
      ) {
        return new Response(JSON.stringify({
          id: "ses_miss",
          directory: "/restored/dir",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    },
    async () => {
      await sendPrompt({ sessionId: "ses_miss", text: "hi" });
    },
  );
  const lookup = calls.find((c) => c.url === "http://127.0.0.1:4096/session/ses_miss" && c.method === "GET");
  assert.ok(lookup, "expected lazy GET /session/{id}");
  const prompt = calls.find((c) => c.url.includes("/prompt_async"));
  assert.ok(prompt && prompt.url.includes("directory=%2Frestored%2Fdir"), `prompt URL: ${prompt?.url}`);
});

test("sendPrompt lazy-fetch notifies directory listeners (opens scoped SSE stream)", async () => {
  // Regression: the lazy-fetch branch used a bare sessionDirectoryCache.set,
  // skipping rememberSessionDirectory — so directoryListeners never fired and
  // the scoped /event?directory= stream for an existing session was never
  // opened. opencode then emitted that prompt's response events onto a stream
  // with no subscriber: SSE "broken in existing sessions". This asserts the
  // listener now fires with the resolved directory.
  _resetSessionDirectoryCache();
  const notified = [];
  const unsub = _onSessionDirectoryAdded((dir) => notified.push(dir));
  try {
    await withMockFetch(
      async (url, opts) => {
        if (
          String(url) === "http://127.0.0.1:4096/session/ses_existing" &&
          (opts?.method ?? "GET") === "GET"
        ) {
          return new Response(
            JSON.stringify({ id: "ses_existing", directory: "/proj/worktree" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(null, { status: 204 });
      },
      async () => {
        await sendPrompt({ sessionId: "ses_existing", text: "hi" });
      },
    );
  } finally {
    unsub();
  }
  assert.deepEqual(
    notified,
    ["/proj/worktree"],
    "lazy-fetch must notify directory listeners exactly once with the resolved dir",
  );
});

test("sendPrompt omits ?directory= when session is unknown (best-effort)", async () => {
  _resetSessionDirectoryCache();
  let promptUrl = "";
  await withMockFetch(
    async (url, opts) => {
      const u = String(url);
      if (u === "http://127.0.0.1:4096/session/ses_unknown" && (opts?.method ?? "GET") === "GET") {
        return new Response("not found", { status: 404 });
      }
      if (u.includes("/prompt_async")) promptUrl = u;
      return new Response(null, { status: 204 });
    },
    async () => {
      await sendPrompt({ sessionId: "ses_unknown", text: "hi" });
    },
  );
  assert.ok(promptUrl.endsWith("/session/ses_unknown/prompt_async"), promptUrl);
  assert.ok(!promptUrl.includes("directory="), `unknown session should not append directory: ${promptUrl}`);
});

test("forkSession carries parent ?directory= and caches it for the new session", async () => {
  _resetSessionDirectoryCache();
  const calls = [];
  await withMockFetch(
    async (url, opts) => {
      const u = String(url);
      calls.push({ url: u, method: opts?.method ?? "GET" });
      if (u.startsWith("http://127.0.0.1:4096/session?directory=")) {
        return new Response(JSON.stringify({
          id: "ses_parent",
          title: "p",
          directory: "/proj/a",
          projectID: "pid",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/fork")) {
        return new Response(JSON.stringify({
          id: "ses_child",
          title: "c",
          directory: "/proj/a",
          projectID: "pid",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    },
    async () => {
      await createSession({ directory: "/proj/a", title: "p" });
      await forkSession({ sessionId: "ses_parent" });
      // Sending a prompt to the new session should use the cached dir.
      await sendPrompt({ sessionId: "ses_child", text: "hi" });
    },
  );
  const fork = calls.find((c) => c.url.includes("/fork"));
  const childPrompt = calls.find((c) => c.url.includes("/ses_child/prompt_async"));
  assert.ok(fork.url.includes("directory=%2Fproj%2Fa"), fork.url);
  assert.ok(
    childPrompt.url.includes("directory=%2Fproj%2Fa"),
    `child prompt missing scoped directory: ${childPrompt.url}`,
  );
});

test("abortSession appends ?directory= from cache", async () => {
  // Regression: without ?directory= the abort POST lands on the wrong
  // (un-scoped) worker. opencode emits some idle signal so the UI's
  // running indicator clears, but the per-directory worker keeps
  // generating tokens. ESC felt like a no-op server-side.
  _resetSessionDirectoryCache();
  let abortUrl = "";
  await withMockFetch(
    async (url, opts) => {
      const u = String(url);
      if (u.startsWith("http://127.0.0.1:4096/session?directory=")) {
        return new Response(JSON.stringify({
          id: "ses_ab",
          title: "t",
          directory: "/proj/ab",
          projectID: "pid",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/abort")) abortUrl = u;
      return new Response(null, { status: 204 });
    },
    async () => {
      await createSession({ directory: "/proj/ab", title: "t" });
      await abortSession("ses_ab");
    },
  );
  assert.ok(
    abortUrl.includes("directory=%2Fproj%2Fab"),
    `abort URL missing scoped directory: ${abortUrl}`,
  );
});

test("abortSession lazy-fetches directory via GET /session/{id} on cache miss", async () => {
  _resetSessionDirectoryCache();
  const calls = [];
  await withMockFetch(
    async (url, opts) => {
      const u = String(url);
      calls.push({ url: u, method: opts?.method ?? "GET" });
      if (u === "http://127.0.0.1:4096/session/ses_amiss" && (opts?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({ id: "ses_amiss", directory: "/restored/abort" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    },
    async () => {
      await abortSession("ses_amiss");
    },
  );
  const abort = calls.find((c) => c.url.includes("/abort"));
  assert.ok(abort, "expected /abort call");
  assert.ok(
    abort.url.includes("directory=%2Frestored%2Fabort"),
    `abort URL missing scoped directory after lazy fetch: ${abort.url}`,
  );
});

test("compactSession appends ?directory= from cache", async () => {
  _resetSessionDirectoryCache();
  let compactUrl = "";
  await withMockFetch(
    async (url, opts) => {
      const u = String(url);
      if (u.startsWith("http://127.0.0.1:4096/session?directory=")) {
        return new Response(JSON.stringify({
          id: "ses_z",
          title: "t",
          directory: "/proj/z",
          projectID: "pid",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/compact")) compactUrl = u;
      return new Response(null, { status: 204 });
    },
    async () => {
      await createSession({ directory: "/proj/z", title: "t" });
      await compactSession("ses_z");
    },
  );
  assert.ok(
    compactUrl.includes("directory=%2Fproj%2Fz"),
    `compact URL missing scoped directory: ${compactUrl}`,
  );
});

// ---------------------------------------------------------------------------
// Permission flow scope
//
// Regression: opencode's WorkspaceRoutingMiddleware returns [] from the
// UNSCOPED /permission list (and 404s an unscoped reply) for a session bound
// to a non-default directory. Without ?directory= the mobile PermissionCard
// never appeared and trust-mode auto-allow failed with
// PermissionNotFoundError — either way the turn hung. Same root cause as the
// question scoping regression (an UNSCOPED call returns 200 / 404 without
// reaching the session).
// ---------------------------------------------------------------------------

test("listPermissions appends ?directory= from cache", async () => {
  _resetSessionDirectoryCache();
  let permUrl = "";
  await withMockFetch(
    async (url) => {
      const u = String(url);
      if (u.startsWith("http://127.0.0.1:4096/session?directory=")) {
        return new Response(JSON.stringify({
          id: "ses_p",
          title: "t",
          directory: "/proj/perm",
          projectID: "pid",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/permission")) {
        permUrl = u;
        return new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    },
    async () => {
      await createSession({ directory: "/proj/perm", title: "t" });
      await listPermissions("ses_p");
    },
  );
  assert.ok(
    permUrl.includes("directory=%2Fproj%2Fperm"),
    `listPermissions URL missing scoped directory: ${permUrl}`,
  );
});

test("listPermissions omits ?directory= when no sessionId given", async () => {
  _resetSessionDirectoryCache();
  let permUrl = "";
  await withMockFetch(
    async (url) => {
      permUrl = String(url);
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async () => {
      await listPermissions();
    },
  );
  assert.ok(
    !permUrl.includes("directory="),
    `unscoped listPermissions should not append directory: ${permUrl}`,
  );
});

test("replyPermission appends ?directory= from cache (auto-allow path)", async () => {
  _resetSessionDirectoryCache();
  let replyUrl = "";
  await withMockFetch(
    async (url) => {
      const u = String(url);
      if (u.startsWith("http://127.0.0.1:4096/session?directory=")) {
        return new Response(JSON.stringify({
          id: "ses_pr",
          title: "t",
          directory: "/proj/preply",
          projectID: "pid",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/reply")) replyUrl = u;
      return new Response(null, { status: 204 });
    },
    async () => {
      await createSession({ directory: "/proj/preply", title: "t" });
      await replyPermission({
        requestId: "per_123",
        reply: "always",
        sessionId: "ses_pr",
      });
    },
  );
  assert.ok(
    replyUrl.includes("/permission/per_123/reply"),
    `reply URL wrong path: ${replyUrl}`,
  );
  assert.ok(
    replyUrl.includes("directory=%2Fproj%2Fpreply"),
    `replyPermission URL missing scoped directory: ${replyUrl}`,
  );
});

// ---------------------------------------------------------------------------
// Session-scoped filtering for listQuestions / listPermissions (BET-110)
//
// opencode's /question and /permission endpoints are `?directory=`-scoped, not
// session-scoped. A directory can hold pending items from multiple sessions
// (including orphan/subagent sessions). listQuestions/listPermissions must
// filter the directory-wide response down to the requested sessionId so callers
// never see cross-session leaks or stale/orphan asks.
// ---------------------------------------------------------------------------

test("listPermissions filters directory-wide response to the requested sessionId", async () => {
  _resetSessionDirectoryCache();
  const calls = [];
  await withMockFetch(
    async (url, opts) => {
      calls.push(String(url));
      // getSessionDirectoryQuery lazy-fetches the session's directory.
      if (String(url) === "http://127.0.0.1:4096/session/ses_B") {
        return new Response(
          JSON.stringify({ id: "ses_B", directory: "/shared/dir" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(url).startsWith("http://127.0.0.1:4096/permission?directory=")) {
        // Directory-wide response: permissions from THREE different sessions.
        return new Response(
          JSON.stringify([
            { id: "per_a", sessionID: "ses_A", permission: "Bash", reply: null },
            { id: "per_b", sessionID: "ses_B", permission: "Write", reply: null },
            { id: "per_c", sessionID: "ses_C", permission: "Bash", reply: null },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    },
    async () => {
      const result = await listPermissions("ses_B");
      assert.deepEqual(
        result,
        [{ id: "per_b", sessionID: "ses_B", permission: "Write", reply: null }],
        "must return only the requested session's permissions",
      );
    },
  );
});

test("listQuestions filters directory-wide response to the requested sessionId", async () => {
  _resetSessionDirectoryCache();
  await withMockFetch(
    async (url, opts) => {
      // getSessionDirectoryQuery lazy-fetches the session's directory.
      if (String(url) === "http://127.0.0.1:4096/session/ses_B") {
        return new Response(
          JSON.stringify({ id: "ses_B", directory: "/shared/dir" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(url).startsWith("http://127.0.0.1:4096/question?directory=")) {
        // Directory-wide response: questions from THREE different sessions,
        // plus an orphan session (ses_orphan) that should be dropped.
        return new Response(
          JSON.stringify([
            { id: "que_1", sessionID: "ses_A", questions: [{ question: "OK?", answers: [] }] },
            { id: "que_2", sessionID: "ses_B", questions: [{ question: "Your move?", answers: [] }] },
            { id: "que_3", sessionID: "ses_orphan", questions: [{ question: "stale", answers: [] }] },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    },
    async () => {
      const result = await listQuestions("ses_B");
      assert.deepEqual(
        result,
        [{ id: "que_2", sessionID: "ses_B", questions: [{ question: "Your move?", answers: [] }] }],
        "must return only the requested session's questions",
      );
    },
  );
});

test("listPermissions without sessionId returns unfiltered directory-wide list", async () => {
  _resetSessionDirectoryCache();
  await withMockFetch(
    async (url) => {
      if (String(url).startsWith("http://127.0.0.1:4096/permission")) {
        return new Response(
          JSON.stringify([
            { id: "per_x", sessionID: "ses_X", permission: "Bash", reply: null },
            { id: "per_y", sessionID: "ses_Y", permission: "Write", reply: null },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    },
    async () => {
      const result = await listPermissions(null);
      assert.equal(result.length, 2, "unscoped call returns full list");
    },
  );
});

test("listQuestions without sessionId returns unfiltered directory-wide list", async () => {
  _resetSessionDirectoryCache();
  await withMockFetch(
    async (url) => {
      if (String(url).startsWith("http://127.0.0.1:4096/question")) {
        return new Response(
          JSON.stringify([
            { id: "que_x", sessionID: "ses_X", questions: [{ question: "q?", answers: [] }] },
            { id: "que_y", sessionID: "ses_Y", questions: [{ question: "q2?", answers: [] }] },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    },
    async () => {
      const result = await listQuestions(null);
      assert.equal(result.length, 2, "unscoped call returns full list");
    },
  );
});

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

// ---------------------------------------------------------------------------
// getProviders — live provider state from opencode's GET /provider
// (BET-309 follow-up: BET-318). Feeds the `opencode:provider-auth` `status`
// action. Must never throw — transport failures degrade to
// `{ connected: [] }` so the caller's `connected[]` reads stay safe.
// ---------------------------------------------------------------------------

test("getProviders returns {connected:[...]} for a 200 with a populated connected[]", async () => {
  await withMockFetch(
    async () =>
      new Response(
        JSON.stringify({
          connected: ["anthropic", "openai"],
          all: [{ id: "anthropic" }, { id: "openai" }, { id: "deepseek" }],
          default: { anthropic: "claude-sonnet-4-6", openai: "gpt-5" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const out = await getProviders();
      assert.deepEqual(out.connected, ["anthropic", "openai"]);
      assert.equal(out.all.length, 3);
      assert.equal(out.default.anthropic, "claude-sonnet-4-6");
    },
  );
});

test("getProviders returns {connected:[]} on a non-2xx response", async () => {
  await withMockFetch(
    async () => new Response("server gone", { status: 503 }),
    async () => {
      const out = await getProviders();
      assert.deepEqual(out.connected, []);
    },
  );
});

test("getProviders returns {connected:[]} on a transport throw", async () => {
  await withMockFetch(
    async () => { throw new Error("ECONNREFUSED"); },
    async () => {
      const out = await getProviders();
      assert.deepEqual(out.connected, []);
    },
  );
});

test("getProviders coerces a non-array connected[] to []", async () => {
  // Defensive: opencode has been observed to return shapes that drift over
  // versions; the renderer's `connected.includes(id)` check must not break
  // when the server returns e.g. `{connected: "anthropic"}`.
  await withMockFetch(
    async () =>
      new Response(
        JSON.stringify({ connected: "anthropic", all: null, default: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const out = await getProviders();
      assert.deepEqual(out.connected, []);
    },
  );
});

// ---------------------------------------------------------------------------
// getDefaultModel — picks the first connected provider with a default model.
//
// BET-320 follow-up: getDefaultModel used to inline its own `GET /provider`
// fetch alongside `getProviders()`. The two paths were byte-identical for any
// 2xx opencode response, but a future drift in defensive handling between
// them would be a silent bug. The refactor routes getDefaultModel through
// getProviders() so there is exactly one fetch site for /provider.
// ---------------------------------------------------------------------------

test("getDefaultModel returns the first connected provider's default", async () => {
  await withMockFetch(
    async () =>
      new Response(
        JSON.stringify({
          connected: ["anthropic", "openai"],
          default: { anthropic: "claude-sonnet-4-6", openai: "gpt-5" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      assert.deepEqual(
        await getDefaultModel(),
        { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      );
    },
  );
});

test("getDefaultModel returns null when no connected provider has a default", async () => {
  await withMockFetch(
    async () =>
      new Response(
        JSON.stringify({
          connected: ["anthropic", "openai"],
          default: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      assert.equal(await getDefaultModel(), null);
    },
  );
});

test("getDefaultModel skips connected providers with no recorded default", async () => {
  // anthropic is connected but has no default; openai does. We expect
  // openai's model — proves we iterate, not just take the first key.
  await withMockFetch(
    async () =>
      new Response(
        JSON.stringify({
          connected: ["anthropic", "openai"],
          default: { openai: "gpt-5" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      assert.deepEqual(
        await getDefaultModel(),
        { providerID: "openai", modelID: "gpt-5" },
      );
    },
  );
});

test("getDefaultModel returns null on a non-2xx response", async () => {
  await withMockFetch(
    async () => new Response("server gone", { status: 503 }),
    async () => {
      assert.equal(await getDefaultModel(), null);
    },
  );
});

test("getDefaultModel returns null on a transport throw (never re-throws)", async () => {
  await withMockFetch(
    async () => { throw new Error("ECONNREFUSED"); },
    async () => {
      assert.equal(await getDefaultModel(), null);
    },
  );
});

test("getDefaultModel returns null when default is missing from the payload", async () => {
  // `default` field absent — getProviders() returns { connected, default: undefined }.
  await withMockFetch(
    async () =>
      new Response(
        JSON.stringify({ connected: ["anthropic"] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      assert.equal(await getDefaultModel(), null);
    },
  );
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// listModels — flattens connected providers into a normalized model list.
//
// BET-342 follow-up: listModels used to inline its own `GET /provider` fetch
// alongside `getProviders()`. The two paths were byte-identical for any 2xx
// opencode response, but a future drift in defensive handling between them
// would be a silent bug. The refactor routes listModels through
// getProviders() so there is exactly one fetch site for /provider.
// ---------------------------------------------------------------------------

test("listModels returns normalized models for every connected provider", async () => {
  await withMockFetch(
    async () =>
      new Response(
        JSON.stringify({
          connected: ["anthropic", "openai"],
          all: [
            {
              id: "anthropic",
              models: {
                "claude-sonnet-4-6": { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
              },
            },
            {
              id: "openai",
              models: {
                "gpt-5": { id: "gpt-5", name: "GPT-5" },
              },
            },
            {
              id: "deepseek",
              models: { "deepseek-chat": { id: "deepseek-chat" } },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const out = await listModels();
      const ids = out.map((m) => `${m.providerID}/${m.id}`).sort();
      // deepseek is in `all` but not in `connected` → must be filtered out.
      assert.deepEqual(ids, ["anthropic/claude-sonnet-4-6", "openai/gpt-5"]);
      const anthropic = out.find((m) => m.providerID === "anthropic");
      assert.equal(anthropic.name, "Claude Sonnet 4.6");
      const openai = out.find((m) => m.providerID === "openai");
      assert.equal(openai.name, "GPT-5");
    },
  );
});

test("listModels returns [] when no providers are connected", async () => {
  // `connected` empty → every provider in `all` is filtered out → empty out.
  await withMockFetch(
    async () =>
      new Response(
        JSON.stringify({
          connected: [],
          all: [
            { id: "anthropic", models: { "claude-sonnet-4-6": { id: "claude-sonnet-4-6" } } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const out = await listModels();
      assert.deepEqual(out, []);
    },
  );
});

test("listModels returns [] on a transport throw (never re-throws)", async () => {
  await withMockFetch(
    async () => { throw new Error("ECONNREFUSED"); },
    async () => {
      const out = await listModels();
      assert.deepEqual(out, []);
    },
  );
});

// Scoped-stream readiness gate (BET-115 fix C)
//
// sendPrompt (via getSessionDirectoryQuery) must not POST to opencode before
// the scoped `/event?directory=` subscription it depends on has actually
// connected upstream — otherwise events emitted in response to the prompt
// land on a subscription that isn't listening yet and are lost forever.
// ---------------------------------------------------------------------------

/** A ReadableStream that never emits or closes — models an SSE body that's
 *  "connected" but has delivered no frames yet. */
function openStreamBody() {
  return new ReadableStream({ start() {} });
}

test("readiness gate: sendPrompt does not POST before the scoped stream connects", async () => {
  _resetSessionDirectoryCache();
  _resetStreamReadyState();
  let releaseConnect;
  const connectGate = new Promise((r) => { releaseConnect = r; });
  _setEventStreamTransport(async (url) => {
    if (String(url).includes("directory=")) {
      await connectGate; // hold the scoped stream "connecting" until released
    }
    return new Response(openStreamBody(), { status: 200 });
  });

  const calls = [];
  const stop = subscribeEvents(() => {});
  try {
    await withMockFetch(
      async (url, opts) => {
        calls.push({ url: String(url), method: opts?.method ?? "GET" });
        if (String(url).endsWith("/session/ses_gate")) {
          return new Response(JSON.stringify({ directory: "/work/gate" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(null, { status: 204 });
      },
      async () => {
        const promptDone = sendPrompt({ sessionId: "ses_gate", text: "hi" }).then(
          () => { calls.push({ marker: "prompt-resolved" }); },
        );
        // Let microtasks/timers run without advancing past the gate — the
        // scoped stream hasn't connected, so the POST must not have fired.
        await new Promise((r) => setTimeout(r, 30));
        assert.ok(
          !calls.some((c) => c.url?.includes("prompt_async")),
          "sendPrompt POSTed before the scoped stream connected",
        );
        releaseConnect();
        await promptDone;
        assert.ok(
          calls.some((c) => c.url?.includes("prompt_async")),
          "sendPrompt never POSTed after the scoped stream connected",
        );
      },
    );
  } finally {
    stop();
    _setEventStreamTransport(null);
    _resetStreamReadyState();
  }
});

test("readiness gate: degrades to sending after the bound elapses (wedged stream)", async () => {
  _resetSessionDirectoryCache();
  _resetStreamReadyState();
  _setReadinessTimeoutMs(30); // don't make the test sleep 5s for real
  // The scoped stream never connects (transport hangs forever) — the gate
  // must still let the prompt through once the bound elapses.
  _setEventStreamTransport(() => new Promise(() => {}));

  const calls = [];
  const stop = subscribeEvents(() => {});
  try {
    await withMockFetch(
      async (url, opts) => {
        calls.push({ url: String(url), method: opts?.method ?? "GET" });
        if (String(url).endsWith("/session/ses_wedge")) {
          return new Response(JSON.stringify({ directory: "/work/wedge" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(null, { status: 204 });
      },
      async () => {
        await sendPrompt({ sessionId: "ses_wedge", text: "hi" });
      },
    );
  } finally {
    stop();
    _setEventStreamTransport(null);
    _setReadinessTimeoutMs(null);
    _resetStreamReadyState();
  }
  assert.ok(
    calls.some((c) => c.url?.includes("prompt_async")),
    "sendPrompt never degraded to sending once the readiness bound elapsed",
  );
});

test("listMessages OPENS the scoped stream but does NOT wait for it", async () => {
  // The readiness gate is a WRITE-path guarantee: a session-mutating call must
  // not race ahead of its own event subscription and lose the reply. A READ has
  // no reply to lose, and on a cold or LRU-evicted stream the wait costs up to
  // 5s — paid in front of every transcript fetch, it was the single largest
  // component of a slow session open on mobile.
  //
  // So this pins BOTH halves of the current contract: the scoped stream is
  // still opened (events keep flowing), and the /message GET does NOT wait for
  // it to connect. The write-path gate test above is what keeps the guarantee
  // that actually matters; do not "restore symmetry" by re-awaiting here.
  _resetSessionDirectoryCache();
  _resetStreamReadyState();
  const streamUrls = [];
  _setEventStreamTransport(async (url) => {
    streamUrls.push(String(url));
    if (String(url).includes("directory=")) {
      await new Promise(() => {}); // scoped stream never finishes connecting
    }
    return new Response(openStreamBody(), { status: 200 });
  });

  const stop = subscribeEvents(() => {});
  try {
    await withMockFetch(
      async (url) => {
        if (String(url).endsWith("/session/ses_msg_gate")) {
          return new Response(JSON.stringify({ directory: "/work/msg-gate" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (String(url).includes("/message")) {
          return new Response(JSON.stringify([{ id: "m1" }]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(null, { status: 204 });
      },
      async () => {
        // Resolves even though the scoped stream never connects, and without
        // the readiness bound having to elapse.
        const msgs = await listMessages("ses_msg_gate");
        assert.deepEqual(msgs, [{ id: "m1" }]);
        assert.ok(
          streamUrls.some((u) => u.includes("directory=")),
          "listMessages never opened the session's scoped event stream",
        );
      },
    );
  } finally {
    stop();
    _setEventStreamTransport(null);
    _resetStreamReadyState();
  }
});

test("listMessages passes ?limit through and leaves the tail slim-untouched by default", async () => {
  _resetSessionDirectoryCache();
  _resetStreamReadyState();
  const urls = [];
  const raw = [
    {
      id: "m1",
      parts: [
        { type: "step-start" },
        { type: "text", text: "hi" },
        { type: "tool", state: { output: "OUT", metadata: { output: "META", exit: 0 } } },
      ],
    },
  ];
  await withMockFetch(
    async (url) => {
      urls.push(String(url));
      if (String(url).includes("/message")) {
        return new Response(JSON.stringify(raw), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    },
    async () => {
      const full = await listMessages("ses_lim");
      assert.ok(!urls.some((u) => u.includes("limit=")), "a no-opts call must not add ?limit");
      assert.deepEqual(full, raw, "a no-opts call must return the payload verbatim (desktop)");

      urls.length = 0;
      await listMessages("ses_lim", { limit: 20 });
      assert.ok(urls.some((u) => u.includes("limit=20")), "limit was not forwarded to opencode");

      urls.length = 0;
      await listMessages("ses_lim", { limit: 0 });
      assert.ok(!urls.some((u) => u.includes("limit=")), "a non-positive limit must be ignored");
    },
  );
});

test("listMessages ALWAYS strips a byte-identical tool stdout duplicate (no slim needed)", async () => {
  _resetSessionDirectoryCache();
  _resetStreamReadyState();
  const raw = [
    {
      id: "m1",
      parts: [
        { type: "text", text: "hi" },
        { type: "tool", state: { output: "OUT", metadata: { output: "OUT", exit: 0 } } },
      ],
    },
  ];
  await withMockFetch(
    async (url) => {
      if (String(url).includes("/message")) {
        return new Response(JSON.stringify(raw), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    },
    async () => {
      const full = await listMessages("ses_strip_dup");
      assert.deepEqual(
        full[0].parts[1].state,
        { output: "OUT", metadata: { exit: 0 } },
        "the duplicate metadata.output must be dropped for every client",
      );
      assert.equal(full[0].parts[0].type, "text", "non-tool parts untouched");
      assert.equal(
        raw[0].parts[1].state.metadata.output,
        "OUT",
        "the input fixture must not be mutated",
      );
    },
  );
});

test("getMessage strips a byte-identical tool stdout duplicate (splice path)", async () => {
  const raw = {
    id: "m1",
    parts: [
      { type: "tool", state: { output: "OUT", metadata: { output: "OUT", exit: 0 } } },
    ],
  };
  await withMessageFetch(raw, async () => {
    const msg = await getMessage("ses_get_strip", "m1");
    assert.deepEqual(
      msg.parts[0].state,
      { output: "OUT", metadata: { exit: 0 } },
      "the duplicate metadata.output must be dropped in the single-message splice too",
    );
  });
});

test("getMessage leaves a NON-identical metadata.output (live streaming) untouched", async () => {
  const raw = {
    id: "m1",
    parts: [
      { type: "tool", state: { output: "final", metadata: { output: "partial", exit: 0 } } },
    ],
  };
  await withMessageFetch(raw, async () => {
    const msg = await getMessage("ses_get_live", "m1");
    assert.deepEqual(
      msg.parts[0].state.metadata.output,
      "partial",
      "different metadata.output must survive (running tool)",
    );
  });
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

test("listMessages still returns the transcript when the readiness gate times out", async () => {
  // Degradation case: a wedged opencode (scoped stream never connects) must
  // never turn the transcript fetch into a hang — the bounded gate elapses
  // and listMessages still resolves with the fetched messages.
  _resetSessionDirectoryCache();
  _resetStreamReadyState();
  _setReadinessTimeoutMs(30); // don't make the test sleep 5s for real
  _setEventStreamTransport(() => new Promise(() => {})); // never connects

  const stop = subscribeEvents(() => {});
  let msgs;
  try {
    await withMockFetch(
      async (url) => {
        if (String(url).endsWith("/session/ses_msg_wedge")) {
          return new Response(JSON.stringify({ directory: "/work/msg-wedge" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (String(url).includes("/message")) {
          return new Response(JSON.stringify([{ id: "m2" }]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(null, { status: 204 });
      },
      async () => {
        msgs = await listMessages("ses_msg_wedge");
      },
    );
  } finally {
    stop();
    _setEventStreamTransport(null);
    _setReadinessTimeoutMs(null);
    _resetStreamReadyState();
  }
  assert.deepEqual(
    msgs,
    [{ id: "m2" }],
    "listMessages never degraded to fetching the transcript once the readiness bound elapsed",
  );
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

// ---------------------------------------------------------------------------
// selectStreamsToEvict — scoped-stream eviction (unbounded-growth fix)
// ---------------------------------------------------------------------------

test("selectStreamsToEvict never evicts the global stream ('')", () => {
  const now = 1_000_000_000;
  const out = selectStreamsToEvict({
    keys: ["", "/a", "/b"],
    lastActivity: new Map([["", 0], ["/a", now], ["/b", now]]),
    existsFn: () => true,
    now,
  });
  assert.equal(out.includes(""), false, "global key must never be evicted");
});

test("selectStreamsToEvict evicts a directory that no longer exists on disk", () => {
  const now = 1_000_000_000;
  const out = selectStreamsToEvict({
    keys: ["", "/live", "/gone"],
    // both recently active, so only the missing-dir rule can evict
    lastActivity: new Map([["/live", now], ["/gone", now]]),
    existsFn: (dir) => dir === "/live",
    now,
  });
  assert.deepEqual(out, ["/gone"]);
});

test("selectStreamsToEvict evicts a directory idle past the threshold", () => {
  const now = 10 * STREAM_IDLE_MS;
  const out = selectStreamsToEvict({
    keys: ["", "/fresh", "/stale"],
    lastActivity: new Map([
      ["/fresh", now - 1000], // just used
      ["/stale", now - STREAM_IDLE_MS - 1], // idle past 2h
    ]),
    existsFn: () => true,
    now,
  });
  assert.deepEqual(out, ["/stale"]);
});

test("selectStreamsToEvict keeps a busy dir even if its last event is old (activity bumps on use)", () => {
  const now = 10 * STREAM_IDLE_MS;
  const out = selectStreamsToEvict({
    keys: ["", "/busy"],
    lastActivity: new Map([["/busy", now]]), // touched now
    existsFn: () => true,
    now,
  });
  assert.deepEqual(out, []);
});

test("selectStreamsToEvict enforces the LRU cap, dropping least-recently-active first", () => {
  const now = 1_000_000_000;
  // 5 live+existing streams, cap of 2 → keep the 2 most-recently-active,
  // evict the other 3.
  const keys = ["", "/k1", "/k2", "/k3", "/k4", "/k5"];
  const lastActivity = new Map([
    ["/k1", now - 50],
    ["/k2", now - 40],
    ["/k3", now - 30],
    ["/k4", now - 20],
    ["/k5", now - 10], // most recent
  ]);
  const out = selectStreamsToEvict({
    keys,
    lastActivity,
    existsFn: () => true,
    now,
    idleMs: STREAM_IDLE_MS, // none idle
    maxStreams: 2,
  });
  // Keep /k5 (10) and /k4 (20); evict /k1,/k2,/k3.
  assert.deepEqual(out.sort(), ["/k1", "/k2", "/k3"]);
});

test("selectStreamsToEvict: missing-dir + idle + LRU compose without double-listing", () => {
  const now = 10 * STREAM_IDLE_MS;
  const keys = ["", "/gone", "/stale", "/a", "/b", "/c"];
  const lastActivity = new Map([
    ["/gone", now], // exists=false → evicted regardless of recency
    ["/stale", now - STREAM_IDLE_MS - 1], // idle → evicted
    ["/a", now - 3],
    ["/b", now - 2],
    ["/c", now - 1],
  ]);
  const out = selectStreamsToEvict({
    keys,
    lastActivity,
    existsFn: (d) => d !== "/gone",
    now,
    maxStreams: 2, // survivors /a,/b,/c → keep /c,/b, evict /a
  });
  const set = new Set(out);
  assert.equal(set.has("/gone"), true);
  assert.equal(set.has("/stale"), true);
  assert.equal(set.has("/a"), true);
  assert.equal(set.has("/c"), false, "most-recent survivor retained");
  assert.equal(out.length, new Set(out).size, "no duplicate keys");
});

test("selectStreamsToEvict: a throwing existsFn keeps the stream (not proof it's gone)", () => {
  const now = 1_000_000_000;
  const out = selectStreamsToEvict({
    keys: ["", "/x"],
    lastActivity: new Map([["/x", now]]),
    existsFn: () => { throw new Error("stat failed"); },
    now,
  });
  assert.deepEqual(out, [], "existsFn error must not evict");
});

// ---------------------------------------------------------------------------
// isStreamDeaf + liveness watchdog (scoped-SSE deafness fix)
// ---------------------------------------------------------------------------

test("isStreamDeaf: false within the timeout, true past it", () => {
  const now = 1_000_000_000;
  assert.equal(isStreamDeaf(now - 10_000, now, 45_000), false, "10s of silence is fine (heartbeat ~10s)");
  assert.equal(isStreamDeaf(now - 44_000, now, 45_000), false, "just under the threshold");
  assert.equal(isStreamDeaf(now - 46_000, now, 45_000), true, "past the threshold → deaf");
  assert.equal(isStreamDeaf(now, now, 45_000), false, "a byte just arrived → alive");
});

test("openEventStream: a deaf (silent) scoped stream is aborted + reconnected", async () => {
  // A stalled reader: the first connection's read() never resolves (no bytes,
  // no done) — exactly the deafness signature (opencode stops publishing but
  // keeps the TCP open). The liveness watchdog must abort it and the loop must
  // reconnect (a SECOND fetch is issued), proving self-heal.
  _resetSessionDirectoryCache();
  _resetStreamReadyState();

  let connectCount = 0;
  let disconnects = 0;
  const controllers = [];
  _setEventStreamTransport(async (_url, init) => {
    connectCount += 1;
    const signal = init?.signal;
    // Reader that only resolves when the fetch is aborted (mirrors how
    // undici's reader rejects on AbortController.abort()).
    const reader = {
      read: () =>
        new Promise((_resolve, reject) => {
          if (signal) {
            if (signal.aborted) return reject(new Error("aborted"));
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }
          // else: never resolves (only the watchdog abort ends it)
        }),
      releaseLock() {},
    };
    controllers.push(signal);
    return { ok: true, body: { getReader: () => reader } };
  });

  // Drive openEventStream indirectly via subscribeEvents' global stream, with a
  // tiny liveness window so the test runs fast. subscribeEvents passes opts
  // through to openEventStream for the global + scoped opens.
  const stop = subscribeEvents(() => {}, {
    sweepIntervalMs: 0,
    // liveness knobs plumbed to openEventStream:
    livenessTimeoutMs: 40,
    livenessCheckMs: 10,
  });
  try {
    // Wait long enough for: connect #1 → watchdog fires (~40ms deaf) → abort →
    // reconnect #1 → connect #2. Poll for the second connect.
    const deadline = Date.now() + 2000;
    while (connectCount < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(connectCount >= 2, `deaf stream must reconnect (connects=${connectCount})`);
  } finally {
    stop();
    _setEventStreamTransport(null);
  }
});

test("subscribeEvents _sweep evicts a dead/idle scoped stream but keeps global + live, and re-open works", () => {
  // Drive the sweep directly (sweepIntervalMs:0 disables the real timer).
  // Inject a fake event transport: a stream whose reader never resolves, so an
  // "open" stays open and no real opencode connection is made.
  _setEventStreamTransport(async () => ({
    ok: true,
    body: {
      getReader: () => ({
        read: () => new Promise(() => {}),
        releaseLock() {},
      }),
    },
  }));
  _resetSessionDirectoryCache();
  _resetStreamReadyState();
  const existing = new Set(["/keep"]); // "/gone" will be reported missing
  const stop = subscribeEvents(() => {}, {
    existsFn: (d) => existing.has(d),
    sweepIntervalMs: 0,
    idleMs: STREAM_IDLE_MS,
  });
  try {
    // Open two scoped streams via the exposed opener (what the query path uses).
    stop._openFor("/keep", "/keep");
    stop._openFor("/gone", "/gone");
    let keys = stop._streamKeys();
    assert.ok(keys.includes("") && keys.includes("/keep") && keys.includes("/gone"),
      "global + both scoped streams open");

    // Sweep: /gone's directory doesn't exist → evicted; /keep + global stay.
    stop._sweep();
    keys = stop._streamKeys();
    assert.equal(keys.includes(""), true, "global survives");
    assert.equal(keys.includes("/keep"), true, "live dir survives");
    assert.equal(keys.includes("/gone"), false, "missing dir evicted");

    // Re-open works after eviction (idempotent open, gate re-arms).
    existing.add("/gone");
    stop._openFor("/gone", "/gone");
    assert.equal(stop._streamKeys().includes("/gone"), true, "re-open after eviction");
  } finally {
    stop();
    _setEventStreamTransport(null);
  }
});

// ---------------------------------------------------------------------------
// Eager scoped-stream open at startup (BET-253 first-turn SSE race fix)
//
// On a fresh box, the first chat turn's events were lost because the scoped
// `/event?directory=<dir>` subscription for a live chat window wasn't open
// when the prompt POSTed. subscribeEvents now accepts an `eagerDirectories()`
// callback (e.g. live chat-session directories from tmux.listProjects()) and
// pre-opens those streams during the bootstrap IIFE — the full catalog stays
// quietly cached (the many-workspace flood fix). These tests pin the
// behaviour: eager open fires for the supplied dirs at startup, de-dup/empty
// filtering skips no-ops, and the default (no opts) preserves the flood fix
// (only the global /event stream is opened at startup).
// ---------------------------------------------------------------------------

test("subscribeEvents eagerly opens scoped streams for supplied eagerDirectories at startup", async () => {
  // Capture every SSE URL the stream transport is asked to open. The eager
  // open fires from the bootstrap IIFE — no prompt, no session use, just
  // startup. Assert both /work/a and /work/b scoped URLs show up in the URL
  // list, alongside the global /event URL.
  const { openedUrls, cleanup } = setupEventStreamCapture();

  const stop = subscribeEvents(() => {}, {
    sweepIntervalMs: 0,
    eagerDirectories: () => ["/work/a", "/work/b"],
  });
  try {
    // The bootstrap IIFE is async; wait until both eager URLs have been
    // requested (or a short deadline elapses) before asserting.
    const deadline = Date.now() + 1000;
    while (
      Date.now() < deadline &&
      !(openedUrls.some((u) => u.includes("directory=%2Fwork%2Fa")) &&
        openedUrls.some((u) => u.includes("directory=%2Fwork%2Fb")))
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(
      openedUrls.some((u) => u.endsWith("/event?directory=%2Fwork%2Fa")),
      `expected /event?directory=/work/a to be opened eagerly; saw ${JSON.stringify(openedUrls)}`,
    );
    assert.ok(
      openedUrls.some((u) => u.endsWith("/event?directory=%2Fwork%2Fb")),
      `expected /event?directory=/work/b to be opened eagerly; saw ${JSON.stringify(openedUrls)}`,
    );
    assert.ok(
      openedUrls.some((u) => u.endsWith("/event") && !u.includes("directory=")),
      `expected the unscoped global /event to also be opened; saw ${JSON.stringify(openedUrls)}`,
    );
    // Stream keys reflect the same set.
    const keys = stop._streamKeys();
    assert.ok(keys.includes(""), "global stream key present");
    assert.ok(keys.includes("/work/a"), "/work/a eager stream key present");
    assert.ok(keys.includes("/work/b"), "/work/b eager stream key present");
  } finally {
    stop();
    cleanup();
  }
});

test("subscribeEvents eager open de-dupes and skips empty/null entries", async () => {
  // The eagerDirectories set is a small bounded list, but callers may still
  // pass dupes or blanks by accident (e.g. a chat window whose
  // paneCurrentPath is empty). The eager loop must:
  //   - open /work/a exactly once even when listed twice,
  //   - skip "" and null entries without throwing or opening a bogus stream.
  const { openedUrls, cleanup } = setupEventStreamCapture();

  const stop = subscribeEvents(() => {}, {
    sweepIntervalMs: 0,
    eagerDirectories: () => ["/work/a", "/work/a", "", null, "/work/a"],
  });
  try {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !openedUrls.some((u) => u.includes("directory=%2Fwork%2Fa"))) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const aOpens = openedUrls.filter((u) => u.endsWith("/event?directory=%2Fwork%2Fa"));
    assert.equal(aOpens.length, 1, `expected /work/a opened exactly once, saw ${aOpens.length} (${JSON.stringify(openedUrls)})`);
    assert.ok(
      !openedUrls.some((u) => u.includes("directory=") && (u.endsWith("directory=") || u.endsWith("directory=&") || u.includes("directory=null"))),
      `empty/null entries must not produce scoped stream URLs; saw ${JSON.stringify(openedUrls)}`,
    );
  } finally {
    stop();
    cleanup();
  }
});

test("subscribeEvents default (no eagerDirectories) opens NO scoped stream at startup — flood fix preserved", async () => {
  // Regression guard: the many-workspace flood fix relied on the catalog
  // being cached quietly (no per-session open). Eager open is opt-in via
  // `opts.eagerDirectories`. When the caller doesn't supply it, only the
  // global /event stream must be opened at startup — no scoped /event
  // requests, no per-catalog flood.
  const { openedUrls, cleanup } = setupEventStreamCapture();

  const stop = subscribeEvents(() => {}, { sweepIntervalMs: 0 });
  try {
    // Give the bootstrap IIFE a moment to settle (it tries listSessions and
    // catches; the empty eagerDirectories path completes a tick later).
    await new Promise((r) => setTimeout(r, 50));
    const scoped = openedUrls.filter((u) => u.includes("directory="));
    assert.deepEqual(
      scoped,
      [],
      `no scoped /event?directory= should be opened at startup when eagerDirectories is absent; saw ${JSON.stringify(scoped)}`,
    );
    const globals = openedUrls.filter((u) => u.endsWith("/event") && !u.includes("directory="));
    assert.equal(globals.length, 1, `expected exactly one unscoped global /event open; saw ${globals.length} (${JSON.stringify(openedUrls)})`);
    const keys = stop._streamKeys();
    assert.deepEqual(keys, [""], `only the global key should be live at startup; saw ${JSON.stringify(keys)}`);
  } finally {
    stop();
    cleanup();
  }
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

// ---------------------------------------------------------------------------
// sessionExists — the delegate sweeper's "is the parent still alive?" probe.
//
// THE BUG THIS LOCKS IN: this used to scan `listSessions()`. opencode caps
// `GET /session` at 100 records and the unscoped form is box-wide, so on a box
// with real history a healthy parent simply isn't in that page — the scan said
// "gone", the sweeper stopped the background job as orphaned (BET-418 §B) and
// stamped it `stopped by user`. Every delegated job died within a sweep tick.
// ---------------------------------------------------------------------------

test("sessionExists: 200 → alive, via a DIRECT lookup (never a capped list scan)", async () => {
  const calls = [];
  await withMockFetch(
    async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ id: "ses_parent" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async () => {
      assert.equal(await sessionExists("ses_parent"), true);
    },
  );
  assert.equal(calls.length, 1, "one request, not a list scan");
  assert.ok(
    calls[0].endsWith("/session/ses_parent"),
    `expected a direct /session/{id} lookup, got ${calls[0]}`,
  );
  assert.ok(
    !calls[0].match(/\/session(\?|$)/),
    `must NOT hit the capped collection endpoint: ${calls[0]}`,
  );
});

test("sessionExists: REGRESSION — alive even when absent from the 100-record list page", async () => {
  // The exact production shape: the collection endpoint returns a full page of
  // 100 OTHER sessions and does not contain the parent. The old scan-based
  // implementation returned false here and killed the job.
  const page = Array.from({ length: 100 }, (_, i) => ({ id: `ses_other_${i}` }));
  await withMockFetch(
    async (url) => {
      const u = String(url);
      if (u.endsWith("/session")) {
        return new Response(JSON.stringify(page), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // The direct lookup still resolves it — that is the whole point.
      return new Response(JSON.stringify({ id: "ses_parent" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async () => {
      assert.equal(await sessionExists("ses_parent"), true);
    },
  );
});

// The remaining cases share one shape — stub a single response, assert the
// verdict — so they are table-driven rather than five copies of the same body.
// The asymmetry IS the contract: only a definitive 404 is allowed to be
// destructive, because that verdict stops a running job and tears down its
// window and worktree.
for (const { name, respond, expected } of [
  {
    name: "404 → gone (the only negative)",
    respond: () => new Response(JSON.stringify({ name: "NotFoundError" }), { status: 404 }),
    expected: false,
  },
  {
    name: "5xx → assume alive (a blip must never orphan a healthy job)",
    respond: () => new Response("boom", { status: 500 }),
    expected: true,
  },
  {
    name: "transport throw → assume alive",
    respond: () => {
      throw new Error("ECONNREFUSED");
    },
    expected: true,
  },
]) {
  test(`sessionExists: ${name}`, async () => {
    await withMockFetch(
      async () => respond(),
      async () => {
        assert.equal(await sessionExists("ses_probe"), expected);
      },
    );
  });
}

test("sessionExists: empty id → false without any request", async () => {
  let called = 0;
  await withMockFetch(
    async () => {
      called++;
      return new Response(null, { status: 200 });
    },
    async () => {
      assert.equal(await sessionExists(""), false);
    },
  );
  assert.equal(called, 0);
});
