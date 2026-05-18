import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apiUrl,
  parseSseFrame,
  createSession,
  sendPrompt,
  runCommand,
  _resetSessionDirectoryCache,
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

// ===== ?directory=... session-scope plumbing =====
//
// opencode requires the directory query param on every session-mutating
// request, otherwise tool execution falls back to the server's startup cwd.
// These tests stub global fetch and assert the URL constructed for each
// session-touching call carries `?directory=` resolved against the cache
// populated by createSession.

function withMockFetch(handler, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

test("createSession caches session directory for later sends", async () => {
  _resetSessionDirectoryCache();
  let createUrl = "";
  let promptUrl = "";
  await withMockFetch(
    async (url, opts) => {
      const u = String(url);
      if (u.includes("/session?directory=")) {
        createUrl = u;
        return new Response(
          JSON.stringify({
            id: "ses_abc",
            title: "t",
            directory: "/home/dev/projects/foo",
            projectID: "p",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.includes("/session/ses_abc/prompt_async")) {
        promptUrl = u;
        return new Response(null, { status: 204 });
      }
      throw new Error("unexpected url: " + u);
    },
    async () => {
      await createSession({ directory: "/home/dev/projects/foo", title: "t" });
      await sendPrompt({ sessionId: "ses_abc", text: "hi" });
    },
  );
  assert.ok(
    createUrl.endsWith("/session?directory=%2Fhome%2Fdev%2Fprojects%2Ffoo"),
    "create url: " + createUrl,
  );
  assert.ok(
    promptUrl.includes("?directory=%2Fhome%2Fdev%2Fprojects%2Ffoo"),
    "prompt url: " + promptUrl,
  );
});

test("sendPrompt falls back to GET /session when cache misses", async () => {
  _resetSessionDirectoryCache();
  let lookups = 0;
  let promptUrl = "";
  await withMockFetch(
    async (url) => {
      const u = String(url);
      if (u === "http://127.0.0.1:4096/session/ses_xyz") {
        lookups += 1;
        return new Response(
          JSON.stringify({ id: "ses_xyz", directory: "/var/x" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.includes("/session/ses_xyz/prompt_async")) {
        promptUrl = u;
        return new Response(null, { status: 204 });
      }
      throw new Error("unexpected url: " + u);
    },
    async () => {
      await sendPrompt({ sessionId: "ses_xyz", text: "hi" });
      // Second send should hit cache (no extra GET).
      await sendPrompt({ sessionId: "ses_xyz", text: "again" });
    },
  );
  assert.equal(lookups, 1, "should fetch session metadata only once");
  assert.ok(promptUrl.includes("?directory=%2Fvar%2Fx"), promptUrl);
});

test("runCommand carries the same ?directory= scope", async () => {
  _resetSessionDirectoryCache();
  let commandUrl = "";
  await withMockFetch(
    async (url) => {
      const u = String(url);
      if (u === "http://127.0.0.1:4096/session/ses_q") {
        return new Response(JSON.stringify({ id: "ses_q", directory: "/p" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/session/ses_q/command")) {
        commandUrl = u;
        return new Response(null, { status: 204 });
      }
      throw new Error("unexpected url: " + u);
    },
    async () => {
      await runCommand({ sessionId: "ses_q", command: "refactor", arguments: "" });
    },
  );
  assert.ok(commandUrl.endsWith("?directory=%2Fp"), commandUrl);
});

test("sendPrompt omits ?directory= when session lookup fails", async () => {
  _resetSessionDirectoryCache();
  let promptUrl = "";
  await withMockFetch(
    async (url) => {
      const u = String(url);
      if (u === "http://127.0.0.1:4096/session/ses_404") {
        return new Response("not found", { status: 404 });
      }
      if (u.includes("/session/ses_404/prompt_async")) {
        promptUrl = u;
        return new Response(null, { status: 204 });
      }
      throw new Error("unexpected url: " + u);
    },
    async () => {
      // Should not throw — failure to resolve directory just drops the scope.
      await sendPrompt({ sessionId: "ses_404", text: "hi" });
    },
  );
  assert.ok(!promptUrl.includes("directory="), promptUrl);
});
