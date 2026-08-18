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
// NO storage and NO external resources: inline styles only, safe in the
// sandboxed opaque origin where localStorage/sessionStorage throw. The icon is
// the REAL Manta mark (src/renderer/assets/manta-mark-128.png) inlined as a
// data URI — the same artwork the transcript loader draws. It is NEVER a
// hand-drawn SVG stand-in (docs/brand/README.md: one mark, and it is an
// image). SPEC — do not redesign. The only substitution is `HREF`.
function overlayHtml(href) {
  return `
<div style="position:fixed;right:16px;bottom:16px;z-index:2147483647;display:inline-flex;align-items:center;gap:9px;padding:8px 14px 8px 10px;border-radius:999px;background:rgba(15,20,38,.86);border:1px solid rgba(255,255,255,.16);box-shadow:0 6px 20px rgba(0,0,0,.28);font:600 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <a href="${href}" target="_blank" rel="noopener noreferrer" title="Built with MantaAI" style="display:inline-flex;align-items:center;gap:8px;text-decoration:none;color:#fff;">
    <img src="data:image/png;base64,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" width="18" height="18" alt="" aria-hidden="true" style="flex:none;object-fit:contain">
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
