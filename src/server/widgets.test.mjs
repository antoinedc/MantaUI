// Tests for widgets.mjs pure logic + injected-I/O paths — no live HTTP, no
// real disk outside the sandbox (MANTA_STATE_HOME). Run via `npm run
// test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  isValidWidgetId,
  WIDGET_CSP,
  genWidgetId,
  widgetUrl,
  registerWidget,
  readWidget,
  createCleanupSweep,
} from "./widgets.mjs";
import { sandboxedHtmlHeaders } from "./htmlHeaders.mjs";
import { pageResponseHeaders } from "./servePage.mjs";
import { STATE_DIRNAME } from "../shared/paths.mjs";

// ---------------------------------------------------------------------------
// isValidWidgetId — the id is a security boundary (registry key AND
// path-traversal guard). 32 bytes = 64 hex chars.
// ---------------------------------------------------------------------------

test("isValidWidgetId accepts a real 64-hex id", () => {
  const id = genWidgetId();
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(isValidWidgetId(id), true);
  assert.equal(isValidWidgetId("a".repeat(64)), true);
});

test("isValidWidgetId rejects traversal, uppercase, wrong length, empty", () => {
  // A path-traversal attempt must be rejected by the same validator used
  // before touching the filesystem.
  assert.equal(isValidWidgetId("../"), false);
  assert.equal(isValidWidgetId(".."), false);
  assert.equal(isValidWidgetId("../../etc/passwd"), false);
  assert.equal(isValidWidgetId("a/bc"), false);
  // Uppercase is not a valid hex widget id (lowercase only).
  assert.equal(isValidWidgetId("A".repeat(64)), false);
  // Wrong length.
  assert.equal(isValidWidgetId("a".repeat(63)), false);
  assert.equal(isValidWidgetId("a".repeat(65)), false);
  // Empty / non-string.
  assert.equal(isValidWidgetId(""), false);
  assert.equal(isValidWidgetId(null), false);
  assert.equal(isValidWidgetId(123), false);
});

// ---------------------------------------------------------------------------
// WIDGET_CSP — the load-bearing security invariants. The one that matters
// most: `connect-src 'none'` (the whole exfiltration defence) is present and
// `allow-same-origin` is ABSENT (a sandbox escape).
// ---------------------------------------------------------------------------

test("WIDGET_CSP has connect-src 'none' and NEVER allow-same-origin", () => {
  assert.match(WIDGET_CSP, /connect-src 'none'/);
  // The sandbox-same-origin escape: `allow-scripts allow-same-origin` makes a
  // sandboxed frame same-origin with its embedder, so it could rewrite its own
  // sandbox attribute. It must never appear.
  assert.equal(WIDGET_CSP.includes("allow-same-origin"), false);
  assert.match(WIDGET_CSP, /^sandbox allow-scripts/);
});

// ---------------------------------------------------------------------------
// sandboxedHtmlHeaders — the ONE header builder. servePage's policy must pass
// through it unchanged (pure refactor).
// ---------------------------------------------------------------------------

test("sandboxedHtmlHeaders returns all five defensive headers", () => {
  const h = sandboxedHtmlHeaders(WIDGET_CSP);
  assert.equal(h["Content-Type"], "text/html; charset=utf-8");
  assert.equal(h["Content-Security-Policy"], WIDGET_CSP);
  assert.equal(h["Cache-Control"], "no-store");
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(h["Referrer-Policy"], "no-referrer");
});

test("servePage policy is unchanged through the refactor", () => {
  // servePage keeps its exact long-standing CSP (pinned by servePage.test.mjs).
  const h = pageResponseHeaders();
  assert.equal(h["Content-Security-Policy"], "sandbox allow-scripts allow-forms allow-popups allow-modals");
  assert.equal(h["Content-Type"], "text/html; charset=utf-8");
  assert.equal(h["Cache-Control"], "no-store");
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(h["Referrer-Policy"], "no-referrer");
  assert.equal(h["Content-Security-Policy"].includes("allow-same-origin"), false);
});

// ---------------------------------------------------------------------------
// register / read round trip + the no-baseUrl guard
// ---------------------------------------------------------------------------

async function cleanup(id) {
  try {
    await rm(join(homedir(), STATE_DIRNAME, "widgets", id), { recursive: true, force: true });
  } catch {
    // best-effort — widget dir may not have been created
  }
}

test("registerWidget stores a widget, publishes the bus event, and reads back", async () => {
  const source = "<html><body>chart</body></html>";
  let saved = null;
  let published = null;
  const r = await registerWidget(
    {
      html: source,
      title: "Chart",
      width: 800,
      height: 400,
      aspectRatio: 2,
      ttlHours: 1,
      sessionId: "ses_a",
      messageId: "msg_1",
    },
    {
      baseUrl: "https://0123abc.boxes.mantaui.com",
      load: () => [],
      save: async (w) => {
        saved = w;
      },
      publish: (p) => {
        published = p;
      },
    },
  );
  assert.equal(r.ok, true);
  assert.match(r.id, /^[0-9a-f]{64}$/);
  assert.equal(r.url, `https://0123abc.boxes.mantaui.com/widgets/${r.id}`);

  assert.ok(saved && saved.length === 1);
  assert.equal(saved[0].id, r.id);
  assert.equal(saved[0].sessionId, "ses_a");
  assert.equal(saved[0].title, "Chart");
  assert.equal(saved[0].width, 800);
  assert.equal(saved[0].height, 400);
  assert.equal(saved[0].aspectRatio, 2);
  assert.ok(saved[0].createdAt > 0);
  assert.ok(saved[0].expiresAt > saved[0].createdAt);

  // The announcement mirrors media: one kind, `widget`, with an action
  // discriminator. The publish callback here receives the bare payload (index
  // wraps it in { kind: "widget", payload }).
  assert.equal(published.action, "show");
  assert.equal(published.id, r.id);
  assert.equal(published.url, r.url);
  assert.equal(published.sessionId, "ses_a");
  assert.equal(published.messageId, "msg_1");
  assert.equal(published.title, "Chart");
  assert.equal(published.width, 800);
  assert.equal(published.aspectRatio, 2);

  // Round trip: the HTML was written to ~/.manta/widgets/<id>/index.html on
  // the (sandboxed) real filesystem, so readWidget with default I/O reads it
  // back byte-for-byte.
  const read = await readWidget(r.id);
  assert.equal(read.ok, true);
  assert.equal(read.html.toString("utf-8"), source);
  await cleanup(r.id);
});

test("registerWidget rejects empty baseUrl without writing", async () => {
  let saveCalled = false;
  const r = await registerWidget(
    { html: "<html></html>", ttlHours: 1 },
    {
      baseUrl: "",
      load: () => [],
      save: async () => {
        saveCalled = true;
      },
    },
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /hostname/i);
  assert.equal(saveCalled, false);
});

test("registerWidget requires html", async () => {
  const r = await registerWidget({}, { baseUrl: "https://x.test" });
  assert.equal(r.ok, false);
  assert.match(r.error, /html is required/);
});

// ---------------------------------------------------------------------------
// readWidget — prunes a registry entry whose file is missing (may have been
// swept or removed externally), matching readPage.
// ---------------------------------------------------------------------------

test("readWidget returns ok:false and prunes the entry when the file is missing", async () => {
  const id = genWidgetId(); // no on-disk file
  const widgets = [{ id, expiresAt: Date.now() + 60_000 }];
  let saved = null;
  const result = await readWidget(id, {
    load: () => widgets,
    save: async (next) => {
      saved = next;
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(saved, [], "the missing widget's registry entry must be pruned");
});

// ---------------------------------------------------------------------------
// createCleanupSweep — expiry filtering (injected load/save, no real FS)
// ---------------------------------------------------------------------------

test("cleanup sweep removes expired entries and leaves live / never-expiry ones", async () => {
  const NOW = 1_000_000;
  const widgets = [
    { id: "a".repeat(64), expiresAt: NOW + 10_000 },
    { id: "b".repeat(64), expiresAt: NOW - 10_000 },
    { id: "c".repeat(64), expiresAt: null }, // 0 = never expires
  ];
  let saved = null;
  const { sweep } = createCleanupSweep({
    load: () => widgets,
    save: async (next) => {
      saved = next;
    },
    now: () => new Date(NOW),
  });
  await sweep();
  assert.deepEqual(
    saved.map((w) => w.id),
    ["a".repeat(64), "c".repeat(64)],
  );
});

test("widgetUrl builds the widget URL under the box's base URL", () => {
  assert.equal(
    widgetUrl("https://0123abc.boxes.mantaui.com", "a".repeat(64)),
    `https://0123abc.boxes.mantaui.com/widgets/${"a".repeat(64)}`,
  );
});
