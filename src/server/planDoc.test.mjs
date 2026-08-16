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

function renderSample(ref) {
  const parsed = parsePlanBundle(SAMPLE_BUNDLE);
  assert.equal(parsed.ok, true);
  return renderPlanDoc({ ...parsed, ref });
}

const FULL_DOC_SAMPLE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Model's Own Title</title>
<script type="application/json" id="plan-meta">
{"title":"Meta Title","sections":[{"id":"intro","heading":"Intro"},{"id":"steps","heading":"Steps"}]}
</script>
<style>body { color: #111; }</style>
</head>
<body>
<h1 id="intro">Intro</h1>
<p>model authored <strong>content</strong>.</p>
<h2 id="steps">Steps</h2>
</body>
</html>`;

test("renderPlanDoc: full-doc body is preserved verbatim with one overlay before </body>", () => {
  const parsed = parsePlanBundle(FULL_DOC_SAMPLE);
  assert.equal(parsed.ok, true);
  const r = renderPlanDoc({ ...parsed, ref: "box123" });
  assert.equal(r.ok, true);
  // The model's own document structure is intact — own title + style preserved.
  assert.ok(r.html.startsWith("<!DOCTYPE html>"));
  assert.ok(r.html.includes("<html lang=\"en\">"));
  assert.ok(r.html.includes("<title>Model's Own Title</title>"), "model's own <title> intact");
  assert.ok(r.html.includes("<style>body { color: #111; }</style>"), "model's own <style> intact");
  assert.ok(!r.html.includes("Meta Title</title>"), "renderer did not inject its own title");
  // Exactly one overlay, injected before the LAST </body>.
  const overlays = r.html.match(/Powered by Manta/g) ?? [];
  assert.equal(overlays.length, 1, "exactly one overlay");
  assert.ok(r.html.includes("<a href=\"https://mantaui.com?ref=box123\""));
  const bodyLoc = r.html.lastIndexOf("</body>");
  const overlayLoc = r.html.lastIndexOf("Powered by Manta");
  assert.ok(overlayLoc < bodyLoc, "overlay injected before </body>");
});

test("renderPlanDoc: fragment body is wrapped in a single valid doc with the meta title", () => {
  const r = renderPlanDoc({
    title: "Fragment Plan",
    sections: [{ id: "a", heading: "A" }],
    body: "<h2 id=\"a\">A</h2><p>hello</p>",
    ref: "box9",
  });
  assert.equal(r.ok, true);
  assert.ok(r.html.startsWith("<!DOCTYPE html>\n<html lang=\"en\">"));
  assert.ok(r.html.includes("<meta name=\"viewport\""));
  assert.ok(r.html.includes("<title>Fragment Plan</title>"), "meta title used");
  assert.ok(r.html.includes("<h2 id=\"a\">A</h2><p>hello</p>"), "fragment body preserved");
  assert.ok(r.html.includes("\n</body>\n</html>\n"), "wrapped as one valid doc");
  assert.ok(r.html.includes("<a href=\"https://mantaui.com?ref=box9\""));
});

test("renderPlanDoc: non-empty ref adds ?ref=<encoded id> to the overlay href", () => {
  const r = renderSample("a b&c");
  assert.equal(r.ok, true);
  assert.ok(r.html.includes("https://mantaui.com?ref=a%20b%26c"), "ref URL-encoded");
});

test("renderPlanDoc: empty / absent ref yields plain https://mantaui.com with no ?ref=", () => {
  for (const ref of ["", undefined]) {
    const r = renderSample(ref);
    assert.equal(r.ok, true);
    assert.ok(r.html.includes("<a href=\"https://mantaui.com\""), "plain href when ref empty/absent");
    assert.ok(!r.html.includes("?ref="), "no ?ref query when ref empty/absent");
  }
});

test("renderPlanDoc: renders NO Summary nav even when sections.length > 1", () => {
  const parsed = parsePlanBundle(SAMPLE_BUNDLE);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.sections.length > 1, "sample has multiple sections");
  const r = renderSample("box");
  assert.equal(r.ok, true);
  assert.ok(!r.html.includes("Summary"));
  assert.ok(!r.html.includes("class=\"summary\""));
  assert.ok(!r.html.includes("aria-label=\"Summary\""));
});

test("renderPlanDoc: output contains NO shell / theme / token / storage remnants", () => {
  const r = renderSample("box1");
  assert.equal(r.ok, true);
  const lower = r.html.toLowerCase();
  assert.ok(!r.html.includes("plan-theme-toggle"), "no theme toggle");
  assert.ok(!r.html.includes("doc-header"), "no doc header");
  assert.ok(!lower.includes("data-theme"), "no data-theme");
  assert.ok(!r.html.includes("LIGHT_TOKENS"), "no light token block");
  assert.ok(!r.html.includes("DARK_TOKENS"), "no dark token block");
  assert.ok(!lower.includes("localstorage"), "no localStorage");
  assert.ok(!lower.includes("sessionstorage"), "no sessionStorage");
  assert.ok(!r.html.includes("THEME_SCRIPT"), "no theme script");
  assert.ok(!r.html.includes("BASE_STYLE"), "no base style");
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
