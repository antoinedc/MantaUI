// Tests for planPage.mjs — focused on the shared mockup-card section added in
// BET-985. `renderPlanHtml` is a pure function; `generatedAt` is supplied
// deterministically so the rendered document is byte-stable.
// Run via `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPlanHtml } from "./planPage.mjs";

// Deterministic timestamp — no clock reads in the rendered output.
const GENERATED = new Date("2026-01-01T00:00:00.000Z");

function render(markdown, overrides = {}) {
  return renderPlanHtml({ title: "Plan", markdown, generatedAt: GENERATED, ...overrides });
}

test("renderPlanHtml includes a Mockups section when markdown has a /pages/ reference", () => {
  const html = render(
    "# Plan\n\n- Step 1\n\n## Mockups\n\n[Settings](https://x.com/pages/settings)\n",
  );
  assert.match(html, /Mockups/);
  assert.equal(
    (html.match(/class="mockup-card"/g) ?? []).length,
    1,
    "exactly one mockup card",
  );
  assert.ok(
    html.includes(
      'class="mockup-card" href="https://x.com/pages/settings" target="_blank" rel="noopener"',
    ),
    "card links to the mockup URL",
  );
  assert.ok(html.includes("Settings"), "card shows the link title");
});

test("renderPlanHtml escapes mockup title and url", () => {
  const html = render(
    '# Plan\n\n[<img> "x"](https://x.com/pages/a&b)\n',
  );
  assert.ok(html.includes("&lt;img&gt; &quot;x&quot;"), "title escaped");
  assert.ok(html.includes('href="https://x.com/pages/a&amp;b"'), "url escaped");
});

test("renderPlanHtml adds no Mockups section when there are no references", () => {
  const html = render("# Plan\n\n- Step 1\n- Step 2\n");
  assert.ok(!html.includes('class="mockup-card"'), "no mockup cards");
  assert.ok(!html.includes('class="mockups"'), "no Mockups section");
});
