// planDoc.mjs — deterministic single-HTML plan renderer (part of the
// "single-HTML plan" plan). The manta-plan agent authors ONE complete,
// standalone HTML page: a small `<script type="application/json" id="plan-meta">`
// (title + section list) plus a fully model-authored rich HTML document with its
// own `<head>`/`<style>`/`<body>`. THIS module is the deterministic renderer: it
// parses the meta, strips it, validates the section anchors, and serves the
// model's page AS-IS (no branded shell, no header, no theme, no token
// stylesheet — the model's full page IS the plan). The ONLY addition is a
// minimal self-contained "Powered by Manta" overlay (fixed, bottom-right, own
// opaque background, links to https://mantaui.com with the box id as `?ref=`).
//
// Two pure functions, node:test-friendly, no npm deps beyond what planPage
// imports. Reuses `escapeHtml` from ./planPage.mjs — no redefined tokens, no
// reimplemented escaping.

import { escapeHtml } from "./planPage.mjs";

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
// renderPlanDoc — serve the model's page as-is + one branded overlay
// ---------------------------------------------------------------------------

// The minimal, self-contained "Powered by Manta" overlay. Single constant, own
// opaque dark background (visible on any page background), fixed bottom-right.
// NO storage and NO external resources: inline styles + inline SVG only, safe
// in the sandboxed opaque origin where localStorage/sessionStorage throw.
// SPEC — do not redesign. The only substitution is `HREF`.
function overlayHtml(href) {
  return `
<div style="position:fixed;right:16px;bottom:16px;z-index:2147483647;display:inline-flex;align-items:center;gap:9px;padding:8px 14px 8px 10px;border-radius:999px;background:rgba(15,20,38,.86);border:1px solid rgba(255,255,255,.16);box-shadow:0 6px 20px rgba(0,0,0,.28);font:600 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <a href="${href}" target="_blank" rel="noopener noreferrer" title="Built with MantaAI" style="display:inline-flex;align-items:center;gap:8px;text-decoration:none;color:#fff;">
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" style="flex:none"><rect width="24" height="24" rx="6" fill="#1F55D6"/><text x="12" y="16.5" font-size="13" font-weight="700" text-anchor="middle" fill="#fff" font-family="-apple-system,Segoe UI,Roboto,Arial,sans-serif">M</text></svg>
    <span style="color:#fff;">Powered by Manta</span>
  </a>
</div>
`.trim();
}

/**
 * Render a single valid HTML plan document from a parsed bundle.
 *
 * - Validates that every `section.id` has a matching `id="<id>"` anchor in the
 *   body — fail-fast on the first missing one.
 * - Serves the model `body` VERBATIM (after the meta is stripped) — it is the
 *   model's full, self-contained authoring. Deliberately NOT re-escaped, NOT
 *   wrapped in any chrome/theme, and NOT sanitized beyond the anchor check.
 * - If the body is a fragment (no closing `</body>`), wraps it in a minimal
 *   valid document. If it is a full standalone page, keeps its doctype/head/
 *   title/style/body exactly.
 * - Appends ONLY the "Powered by Manta" overlay, immediately before `</body>`
 *   (or at the very end), with `href = https://mantaui.com` plus
 *   `?ref=<encoded ref>` when `ref` is a non-empty string.
 *
 * @param {{ title:string, sections:Array<{id:string,heading:string}>, body:string, ref?:string }} input
 * @returns {{ ok:true, html:string }} | {{ ok:false, error:string }}
 */
export function renderPlanDoc({ title, sections, body, ref }) {
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

  const href =
    typeof ref === "string" && ref.length > 0
      ? `https://mantaui.com?ref=${encodeURIComponent(ref)}`
      : "https://mantaui.com";
  const overlay = overlayHtml(href);

  let html;
  if (body.includes("</body>")) {
    // Full standalone page — preserve it verbatim, inject exactly one overlay
    // immediately before the LAST </body>.
    const last = body.lastIndexOf("</body>");
    html = body.slice(0, last) + overlay + "\n" + body.slice(last);
  } else {
    // Fragment — wrap in a minimal valid document with the overlay inside.
    html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
${body}
${overlay}
</body>
</html>
`;
  }

  return { ok: true, html };
}
