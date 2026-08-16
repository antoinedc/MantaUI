// Tests for planPage.mjs — the shared HTML-escaping helper (BET-1004). The
// markdown plan render/publish pipeline was retired; `escapeHtml` is the only
// export left and is still exercised by planDoc.mjs's renderer.
// Run via `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml } from "./planPage.mjs";

test("escapeHtml escapes &, <, >, and double quotes", () => {
  assert.equal(escapeHtml(`a & b < c > d "e"`), "a &amp; b &lt; c &gt; d &quot;e&quot;");
});

test("escapeHtml maps every occurrence, not just the first", () => {
  assert.equal(escapeHtml("<<x && y>>"), "&lt;&lt;x &amp;&amp; y&gt;&gt;");
});

test("escapeHtml leaves plain text untouched", () => {
  assert.equal(escapeHtml("plain text 123"), "plain text 123");
});

test("escapeHtml coerces non-string input via String()", () => {
  assert.equal(escapeHtml(42), "42");
  assert.equal(escapeHtml(null), "null");
});
