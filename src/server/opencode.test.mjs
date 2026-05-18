import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apiUrl,
  parseSseFrame,
  sendPrompt,
  runCommand,
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

// Regression guard: prompt_async / command MUST NOT carry ?directory=.
// opencode's /event SSE stream is project-scoped — adding ?directory= to a
// mutating request routes its events to the scoped channel, and our global
// /event subscription sees nothing (assistant text never streams to the
// renderer). This silently breaks streaming, so we assert URL shape.

function withMockFetch(handler, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

test("sendPrompt URL has no ?directory= (would silence /event stream)", async () => {
  let promptUrl = "";
  await withMockFetch(
    async (url) => {
      promptUrl = String(url);
      return new Response(null, { status: 204 });
    },
    async () => {
      await sendPrompt({ sessionId: "ses_abc", text: "hi" });
    },
  );
  assert.ok(promptUrl.endsWith("/session/ses_abc/prompt_async"), promptUrl);
  assert.ok(!promptUrl.includes("directory="), promptUrl);
});

test("runCommand URL has no ?directory= (would silence /event stream)", async () => {
  let commandUrl = "";
  await withMockFetch(
    async (url) => {
      commandUrl = String(url);
      return new Response(null, { status: 204 });
    },
    async () => {
      await runCommand({ sessionId: "ses_q", command: "refactor", arguments: "" });
    },
  );
  assert.ok(commandUrl.endsWith("/session/ses_q/command"), commandUrl);
  assert.ok(!commandUrl.includes("directory="), commandUrl);
});
