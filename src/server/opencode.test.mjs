import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apiUrl,
  parseSseFrame,
  createSession,
  sendPrompt,
  listMessages,
  runCommand,
  forkSession,
  compactSession,
  abortSession,
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
} from "./opencode.mjs";

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

test("createSession primes directory cache; sendPrompt then appends ?directory=", async () => {
  _resetSessionDirectoryCache();
  const calls = [];
  await withMockFetch(
    async (url, opts) => {
      calls.push({ url: String(url), method: opts?.method ?? "GET" });
      if (String(url).startsWith("http://127.0.0.1:4096/session?directory=")) {
        return new Response(JSON.stringify({
          id: "ses_x",
          title: "t",
          directory: "/work/proj",
          projectID: "pid",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    },
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
  _resetSessionDirectoryCache();
  const calls = [];
  await withMockFetch(
    async (url, opts) => {
      calls.push({ url: String(url), method: opts?.method ?? "GET" });
      if (String(url).startsWith("http://127.0.0.1:4096/session?directory=")) {
        return new Response(JSON.stringify({
          id: "ses_q",
          title: "t",
          directory: "/work/repo",
          projectID: "pid",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    },
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

test("listMessages awaits the scoped stream ready gate BEFORE fetching the transcript", async () => {
  // Regression: listMessages used to fire-and-forget getSessionDirectoryQuery,
  // so the /message snapshot could be fetched (and events lost) before the
  // scoped stream was actually connected. This asserts the ready gate is
  // awaited — the /message GET must never fire until the scoped stream
  // connects — mirroring the write-path readiness gate test above.
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
        const listDone = listMessages("ses_msg_gate").then((msgs) => {
          calls.push({ marker: "list-resolved" });
          return msgs;
        });
        // Let microtasks/timers run without advancing past the gate — the
        // scoped stream hasn't connected, so the /message GET must not have
        // fired yet.
        await new Promise((r) => setTimeout(r, 30));
        assert.ok(
          !calls.some((c) => c.url?.includes("/message")),
          "listMessages fetched the transcript before the scoped stream connected",
        );
        releaseConnect();
        const msgs = await listDone;
        assert.ok(
          calls.some((c) => c.url?.includes("/message")),
          "listMessages never fetched the transcript after the scoped stream connected",
        );
        assert.deepEqual(msgs, [{ id: "m1" }]);
      },
    );
  } finally {
    stop();
    _setEventStreamTransport(null);
    _resetStreamReadyState();
  }
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
