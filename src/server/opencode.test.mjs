import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apiUrl,
  parseSseFrame,
  createSession,
  sendPrompt,
  runCommand,
  forkSession,
  compactSession,
  abortSession,
  listPermissions,
  replyPermission,
  _resetSessionDirectoryCache,
  _onSessionDirectoryAdded,
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

function withMockFetch(handler, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => {
    globalThis.fetch = orig;
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
// PermissionNotFoundError — either way the turn hung. Mirrors the question
// scoping + desktop src/main/opencode.ts.
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
