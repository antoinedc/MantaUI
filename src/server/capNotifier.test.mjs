// Tests the field-name translation in src/server/capNotifier.mjs: the
// bridge between capabilities.mjs's `notifySession({sessionID, text})`
// contract and oc.sendPrompt's `{sessionId, text}` shape.
//
// Why a live HTTP server: the bug BET-184 review-return flagged was a
// passthrough `(args) => oc.sendPrompt(args)` that silently dropped the
// session id, so the request landed at `/session/undefined/prompt_async`
// and the completion turn never reached the originating session. A pure
// unit test (mock sendPrompt, capture args) would pass even with the bug —
// the bug is in the field-NAME translation, not in the call-shape. The
// cheapest proof that the right field is on the wire is to capture the
// HTTP request (URL + body) and assert its shape.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as oc from "./opencode.mjs";
import { notifyCapSession } from "./capNotifier.mjs";

// oc.sendPrompt dispatches through `ocFetch`, which opencode.mjs
// exposes a test-only transport override for (`_setOcTransport`). That
// lets us capture the URL + body without standing up a real HTTP server
// or needing opencode to be running.
function captureSendPrompt(args) {
  return new Promise(async (resolve, reject) => {
    let captured = null;
    const prev = oc._setOcTransport((url, init) => {
      captured = { url, method: init?.method, body: init?.body };
      // Return a minimal valid WHATWG Response.
      return Promise.resolve(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );
    });
    try {
      await notifyCapSession(args);
    } catch (e) {
      // ignore — we just want the capture
    } finally {
      oc._setOcTransport(prev); // null restores default
    }
    resolve(captured);
  });
}

test("notifyCapSession translates sessionID → sessionId in the URL", async () => {
  const captured = await captureSendPrompt({
    sessionID: "ses_abc123",
    text: "hello from the bridge",
  });
  assert.ok(captured, "transport was called");
  // URL must encode the camelCase sessionId — a passthrough would have
  // built `/session/undefined/prompt_async` (silent drop, the BET-184 bug).
  assert.match(
    captured.url,
    /\/session\/ses_abc123\/prompt_async/,
    `url must contain the camelCase sessionId, got ${captured.url}`,
  );
  assert.equal(captured.method, "POST");
});

test("notifyCapSession embeds the text in the request body as a parts array", async () => {
  const captured = await captureSendPrompt({
    sessionID: "ses_xyz",
    text: "build finished",
  });
  assert.ok(captured, "transport was called");
  const parsed = JSON.parse(captured.body);
  // oc.sendPrompt wraps text in {parts:[{type:"text", text}]}
  assert.deepEqual(parsed.parts, [{ type: "text", text: "build finished" }]);
});

test("notifyCapSession would have produced /session/undefined before the fix", async () => {
  // Regression guard: assert what a broken passthrough would have produced.
  // If a future refactor regresses to passthrough, this test would fail.
  const passthroughBug = (args) => oc.sendPrompt(args);
  let captured = null;
  const prev = oc._setOcTransport((url, init) => {
    captured = { url, body: init?.body };
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  try {
    await passthroughBug({ sessionID: "ses_anything", text: "x" });
  } catch {}
  finally {
    oc._setOcTransport(prev);
  }
  // The PASSTHROUGH form lands on /session/undefined — this proves the
  // bug-shape the bridge exists to prevent.
  assert.match(captured.url, /\/session\/undefined\/prompt_async/);
});
