// planDoc.mjs — deterministic single-HTML plan renderer (part of the
// "single-HTML plan" plan). The manta-plan agent authors ONE HTML file: a small
// `<script type="application/json" id="plan-meta">` (title + section list) plus
// a fully model-authored rich HTML body. THIS module is the deterministic
// renderer: it parses the meta, renders the fixed branded chrome (header,
// dark/light toggle, summary/TOC, base token stylesheet) from that meta, and
// injects the model body as `<main>`. Structure is guaranteed by the template;
// the body stays 100% AI-authored.
//
// Two pure functions, node:test-friendly, no npm deps beyond what planPage
// imports. Reuses `escapeHtml`, `LIGHT_TOKENS`, `DARK_TOKENS` from
// ./planPage.mjs — no redefined tokens, no reimplemented escaping.

import { escapeHtml, LIGHT_TOKENS, DARK_TOKENS } from "./planPage.mjs";

// ---------------------------------------------------------------------------
// parsePlanBundle — find + parse the meta block, strip it from the body
// ---------------------------------------------------------------------------

const OPEN_TAG = /<\s*script\b([^>]*)>/gi;
const CLOSE_TAG = /<\s*\/\s*script\s*>/gi;

// Whether the given opening-tag attribute string is the plan-meta block.
// Tolerates attribute-order variation and whitespace; tag name handled
// case-insensitively by the caller's regex.
function isMetaTag(attrs) {
  return (
    /\bid\s*=\s*["']plan-meta["']/i.test(attrs) &&
    /\btype\s*=\s*["']application\/json["']/i.test(attrs)
  );
}

// Locate the FIRST `<script type="application/json" id="plan-meta">...</script>`
// block. Returns `{ inner, openStart, closeEnd }` where `inner` is the JSON
// text between the tags and `[openStart, closeEnd)` is the whole block to drop
// from the body. Returns null when no meta block is found.
function findMetaBlock(text) {
  OPEN_TAG.lastIndex = 0;
  let m;
  while ((m = OPEN_TAG.exec(text)) !== null) {
    if (!isMetaTag(m[1] ?? "")) continue;
    const openStart = m.index;
    const openEnd = m.index + m[0].length;
    CLOSE_TAG.lastIndex = openEnd;
    const c = CLOSE_TAG.exec(text);
    if (!c) return null;
    return {
      inner: text.slice(openEnd, c.index),
      openStart,
      closeEnd: c.index + c[0].length,
    };
  }
  return null;
}

/**
 * Parse a single-HTML plan bundle into `{ title, sections, body }`.
 *
 * `title` is a non-empty string; `sections` is an array of
 * `{ id: non-empty string, heading: non-empty string }`. `body` is the input
 * text with the ENTIRE meta `<script>` block removed (the model body minus the
 * meta).
 *
 * @param {unknown} text - the full plan HTML text.
 * @returns {{ ok:true, title:string, sections:Array<{id:string,heading:string}>, body:string }}
 *   | {{ ok:false, error:string }}
 */
export function parsePlanBundle(text) {
  if (typeof text !== "string") {
    return { ok: false, error: "plan bundle must be a string" };
  }
  const meta = findMetaBlock(text);
  if (!meta) {
    return { ok: false, error: "no plan-meta" };
  }
  let obj;
  try {
    obj = JSON.parse(meta.inner);
  } catch {
    return { ok: false, error: "plan-meta is not valid JSON" };
  }
  const title = obj && typeof obj.title === "string" ? obj.title.trim() : "";
  if (!title) {
    return { ok: false, error: "plan-meta title must be a non-empty string" };
  }
  const sections = obj && Array.isArray(obj.sections) ? obj.sections : null;
  if (!sections) {
    return { ok: false, error: "plan-meta sections must be an array" };
  }
  for (const s of sections) {
    if (
      !s ||
      typeof s.id !== "string" ||
      s.id.length === 0 ||
      typeof s.heading !== "string" ||
      s.heading.length === 0
    ) {
      return {
        ok: false,
        error: "each plan-meta section must have a non-empty id and heading",
      };
    }
  }
  const body = text.slice(0, meta.openStart) + text.slice(meta.closeEnd);
  return { ok: true, title, sections, body };
}

// ---------------------------------------------------------------------------
// renderPlanDoc — the deterministic branded document
// ---------------------------------------------------------------------------

// The theme toggle script — inline, self-contained, in-memory only. Sets the
// theme from a variable (falling back to prefers-color-scheme) on load, and
// flips `data-theme` on <html> when the header button is clicked. Deliberately
// NO localStorage: the page is served in an opaque-origin sandbox (serve-page
// CSP without allow-same-origin), where localStorage throws.
const THEME_SCRIPT = `
<script>
(function () {
  var theme = "";
  var root = document.documentElement;
  function apply() {
    if (!theme) {
      theme = (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches)
        ? "dark" : "light";
    }
    root.setAttribute("data-theme", theme);
  }
  apply();
  var toggle = document.getElementById("plan-theme-toggle");
  if (toggle) toggle.addEventListener("click", function () {
    theme = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", theme);
  });
})();
</script>
`.trim();

// Minimal prose typography + header/summary styling, all referenced via the
// imported token blocks (no copied planPage body stylesheet, no external
// resources).
const BASE_STYLE = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--canvas);
    color: var(--tx1);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .doc-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 24px;
    background: var(--inset);
    border-bottom: 1px solid var(--border-subtle);
  }
  .brand {
    font-weight: 700;
    color: var(--accent-tx);
    letter-spacing: 0.02em;
  }
  .doc-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--tx2);
    font-size: 14px;
  }
  .doc-header button {
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--tx1);
    border-radius: var(--r-sm);
    padding: 4px 8px;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
  }
  .doc-header button:hover { border-color: var(--border-strong); }
  .wrap { max-width: 720px; margin: 0 auto; padding: 28px; }
  .summary {
    margin: 0 0 28px;
    padding: 14px 18px;
    background: var(--inset);
    border: 1px solid var(--border-subtle);
    border-radius: var(--r-sm);
  }
  .summary-title {
    margin: 0 0 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--tx4);
  }
  .summary ul { margin: 0; padding: 0; list-style: none; }
  .summary li { margin: 3px 0; font-size: 13.5px; }
  .summary a { color: var(--tx2); text-decoration: none; }
  .summary a:hover { color: var(--accent-tx); text-decoration: underline; }
  main { color: var(--tx1); }
  main h1, main h2, main h3, main h4, main h5, main h6 {
    color: var(--tx1);
    line-height: 1.3;
    margin: 1.4em 0 0.6em;
  }
  main h1 { font-size: 22px; }
  main h2 { font-size: 19px; }
  main h3 { font-size: 16px; }
  main p { margin: 0.6em 0; }
  main ul, main ol { margin: 0.6em 0; padding-left: 1.6em; }
  main li { margin: 0.25em 0; }
  main a { color: var(--accent-tx); text-decoration: none; }
  main a:hover { text-decoration: underline; }
  code {
    font-family: var(--mono);
    font-size: 0.9em;
    background: var(--inset);
    border: 1px solid var(--border-subtle);
    border-radius: var(--r-xs);
    padding: 0.1em 0.35em;
  }
  pre {
    background: var(--inset);
    border: 1px solid var(--border-subtle);
    border-radius: var(--r-sm);
    padding: 14px 16px;
    overflow-x: auto;
    margin: 0.8em 0;
  }
  pre code { background: none; border: 0; padding: 0; }
`.trim();

/**
 * Render a full, self-contained HTML plan document from a parsed bundle.
 *
 * - Validates that every `section.id` has a matching `id="<id>"` anchor in the
 *   body (so TOC links never dead-end) — fail-fast on the first missing one.
 * - The model `body` is injected VERBATIM (after the meta is stripped); it is
 *   deliberately NOT re-escaped — it is the model's authored HTML.
 * - Title, headings, and header text are escaped via `escapeHtml`.
 * - The only `<script>` is the theme toggle; no iframe, no external resources,
 *   no localStorage.
 *
 * @param {{ title:string, sections:Array<{id:string,heading:string}>, body:string }} input
 * @returns {{ ok:true, html:string }} | {{ ok:false, error:string }}
 */
export function renderPlanDoc({ title, sections, body }) {
  if (typeof title !== "string" || title.length === 0) {
    return { ok: false, error: "a non-empty title is required" };
  }
  if (!Array.isArray(sections)) {
    return { ok: false, error: "sections must be an array" };
  }
  if (typeof body !== "string") {
    return { ok: false, error: "body must be a string" };
  }

  for (const s of sections) {
    if (typeof s?.id !== "string" || !s.id) continue;
    if (!body.includes(`id="${s.id}"`)) {
      return { ok: false, error: `section id '${s.id}' not found in body` };
    }
  }

  const tocHtml =
    sections.length > 1
      ? `<nav class="summary" aria-label="Summary">
  <p class="summary-title">Summary</p>
  <ul>
${sections
  .map(
    (s) => `    <li><a href="#${escapeHtml(s.id)}">${escapeHtml(s.heading)}</a></li>`,
  )
  .join("\n")}
  </ul>
</nav>`
      : "";

  const html = `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    ${LIGHT_TOKENS}
  }
  [data-theme="dark"] {
    ${DARK_TOKENS}
  }
  ${BASE_STYLE}
</style>
</head>
<body>
  <header class="doc-header">
    <span class="brand">Manta</span>
    <span class="doc-title">${escapeHtml(title)}</span>
    <button id="plan-theme-toggle" type="button" title="Toggle theme">&#9680;</button>
  </header>
  <div class="wrap">
    ${tocHtml}
    <main>
${body}
    </main>
  </div>
  ${THEME_SCRIPT}
</body>
</html>
`;

  return { ok: true, html };
}
