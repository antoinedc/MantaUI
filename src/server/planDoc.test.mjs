// Tests for planDoc.mjs — the deterministic single-HTML plan renderer.
// Pure logic only; run via `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlanBundle, renderPlanDoc } from "./planDoc.mjs";

const SAMPLE_BUNDLE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<script type="application/json" id="plan-meta">
{"title":"My Plan","sections":[{"id":"intro","heading":"Intro"},{"id":"steps","heading":"Steps"},{"id":"outro","heading":"Outro"}]}
</script>
</head>
<body>
<h1 id="intro">Intro</h1>
<p>Some <strong>bold</strong> text &amp; more.</p>
<h2 id="steps">Steps</h2>
<p>1 &lt; 2</p>
<h3 id="outro">Outro</h3>
</body>
</html>`;

// ---------------------------------------------------------------------------
// parsePlanBundle
// ---------------------------------------------------------------------------

test("parsePlanBundle: happy path returns title, sections, and body minus the meta", () => {
  const r = parsePlanBundle(SAMPLE_BUNDLE);
  assert.equal(r.ok, true);
  assert.equal(r.title, "My Plan");
  assert.deepEqual(r.sections, [
    { id: "intro", heading: "Intro" },
    { id: "steps", heading: "Steps" },
    { id: "outro", heading: "Outro" },
  ]);
  assert.ok(!r.body.includes("plan-meta"), "meta block removed from body");
  assert.ok(r.body.includes("<strong>bold</strong>"), "body content preserved");
  assert.ok(r.body.includes("&amp;"), "body content preserved (entity)");
});

test("parsePlanBundle: tolerant of attribute order and whitespace in the script tag", () => {
  const text = `A<script  id = "plan-meta" type = "application/json" >{"title":"T","sections":[{"id":"a","heading":"A"}]}</script >B`;
  const r = parsePlanBundle(text);
  assert.equal(r.ok, true);
  assert.equal(r.title, "T");
  assert.deepEqual(r.sections, [{ id: "a", heading: "A" }]);
  assert.equal(r.body, "AB");
});

test("parsePlanBundle: case-insensitive script tag name", () => {
  const text = `<SCRIPT TYPE="APPLICATION/JSON" ID="plan-meta">{"title":"T","sections":[{"id":"a","heading":"A"}]}</SCRIPT>`;
  const r = parsePlanBundle(text);
  assert.equal(r.ok, true);
  assert.equal(r.title, "T");
});

test("parsePlanBundle: missing meta block returns error", () => {
  const r = parsePlanBundle("<html><body>no meta here</body></html>");
  assert.equal(r.ok, false);
  assert.equal(r.error, "no plan-meta");
});

test("parsePlanBundle: malformed JSON returns error", () => {
  const text = `<script type="application/json" id="plan-meta">{not json}</script>body`;
  const r = parsePlanBundle(text);
  assert.equal(r.ok, false);
  assert.match(r.error, /not valid JSON/i);
});

test("parsePlanBundle: invalid section shapes return error", () => {
  const missingHeading = `<script type="application/json" id="plan-meta">{"title":"T","sections":[{"id":"a"}]}</script>`;
  assert.equal(parsePlanBundle(missingHeading).ok, false);

  const emptyId = `<script type="application/json" id="plan-meta">{"title":"T","sections":[{"id":"","heading":"H"}]}</script>`;
  assert.equal(parsePlanBundle(emptyId).ok, false);

  const noSections = `<script type="application/json" id="plan-meta">{"title":"T"}</script>`;
  assert.equal(parsePlanBundle(noSections).ok, false);

  const emptyTitle = `<script type="application/json" id="plan-meta">{"title":"","sections":[]}</script>`;
  assert.equal(parsePlanBundle(emptyTitle).ok, false);
});

test("parsePlanBundle: non-string input returns error", () => {
  assert.equal(parsePlanBundle(undefined).ok, false);
  assert.equal(parsePlanBundle(null).ok, false);
  assert.equal(parsePlanBundle(42).ok, false);
  assert.equal(parsePlanBundle({}).ok, false);
});

// ---------------------------------------------------------------------------
// renderPlanDoc
// ---------------------------------------------------------------------------

function renderSample() {
  const parsed = parsePlanBundle(SAMPLE_BUNDLE);
  assert.equal(parsed.ok, true);
  return renderPlanDoc(parsed);
}

test("renderPlanDoc: returns a full document with header, branding, and toggle", () => {
  const r = renderSample();
  assert.equal(r.ok, true);
  assert.ok(r.html.startsWith("<!DOCTYPE html>"));
  assert.ok(r.html.includes("<html lang=\"en\""));
  assert.ok(r.html.includes("<header"));
  assert.ok(r.html.includes(">Manta</span>"));
  assert.ok(r.html.includes("plan-theme-toggle"));
});

test("renderPlanDoc: includes the theme toggle script and no localStorage/iframe/external", () => {
  const r = renderSample();
  assert.ok(r.html.includes("prefers-color-scheme"));
  assert.ok(r.html.includes("data-theme"));
  assert.ok(r.html.includes("URLSearchParams"), "theme read via URLSearchParams");
  assert.ok(r.html.includes("history.replaceState"), "theme persisted via history.replaceState");
  assert.ok(r.html.includes("\"?theme=\" + next"), "replaceState writes ?theme= next");
  assert.ok(!r.html.toLowerCase().includes("localstorage"));
  assert.ok(!r.html.toLowerCase().includes("sessionstorage"));
  assert.ok(!r.html.toLowerCase().includes("<iframe"));
  assert.ok(!r.html.includes("http://"));
  assert.ok(!r.html.includes("https://"));
});

test("renderPlanDoc: renders NO Summary nav even when sections.length > 1", () => {
  const parsed = parsePlanBundle(SAMPLE_BUNDLE);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.sections.length > 1, "sample has multiple sections");
  const r = renderPlanDoc(parsed);
  assert.equal(r.ok, true);
  assert.ok(!r.html.includes("Summary"));
  assert.ok(!r.html.includes("class=\"summary\""));
  assert.ok(!r.html.includes("aria-label=\"Summary\""));
});

test("renderPlanDoc: base stylesheet widens the body container to 1080px", () => {
  const r = renderSample();
  assert.ok(r.html.includes(".wrap { max-width: 1080px; margin: 0 auto; padding: 32px 40px; }"));
  assert.ok(!r.html.includes("max-width: 720px"));
});

test("renderPlanDoc: renders NO Summary block when sections.length <= 1", () => {
  const body = "<p id=\"a\">only one section</p>";
  const one = renderPlanDoc({
    title: "Single",
    sections: [{ id: "a", heading: "A" }],
    body,
  });
  assert.equal(one.ok, true);
  assert.ok(!one.html.includes("Summary"));
  assert.ok(!one.html.includes("class=\"summary\""));

  const none = renderPlanDoc({ title: "Empty", sections: [], body: "<p>x</p>" });
  assert.equal(none.ok, true);
  assert.ok(!none.html.includes("Summary"));
});

test("renderPlanDoc: fails fast when a section id anchor is missing from the body", () => {
  const r = renderPlanDoc({
    title: "T",
    sections: [{ id: "ghost", heading: "Ghost" }],
    body: "<p>no anchor here</p>",
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "section id 'ghost' not found in body");
});

test("renderPlanDoc: injects the body verbatim without double-escaping sentinels", () => {
  const r = renderSample();
  assert.ok(r.html.includes("<strong>bold</strong>"), "HTML tag survives unescaped");
  assert.ok(r.html.includes("&amp;"), "& sentinel not double-escaped");
  assert.ok(!r.html.includes("&amp;amp;"), "& must not become &amp;amp;");
  assert.ok(r.html.includes("&lt;"), "< sentinel preserved");
  assert.ok(!r.html.includes("&amp;lt;"), "< must not become &amp;lt;");
});

test("renderPlanDoc: escapes title text", () => {
  const body = "<p id=\"x\">anchor</p><p id=\"y\">anchor2</p>";
  const r = renderPlanDoc({
    title: "A < Title & More",
    sections: [
      { id: "x", heading: "L < R" },
      { id: "y", heading: "Plain" },
    ],
    body,
  });
  assert.equal(r.ok, true);
  assert.ok(r.html.includes("A &lt; Title &amp; More"), "title escaped");
});
