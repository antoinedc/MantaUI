// planPage.mjs — publish a plan (markdown) to a readable URL (BET-954).
//
// The web client is a thin, scrollable column: a 40-120 line structured plan
// competes with tool cards and scrolls away, and on a phone it is worse. The
// box is remote and the reader may be on a phone, so a URL is the right
// primitive. This module renders a plan's markdown to a self-contained HTML
// document and registers it through the EXISTING serve-page subsystem
// (`servePage.registerPage`) — no second page mechanism, no second registry,
// no new port.
//
// Design contract (do not regress):
//   - Subdomain is `plan-<shortSessionId>` — a stable name per session, so the
//     SAME link stays the same link across plan revisions (re-registering a
//     subdomain replaces the snapshot, which servePage already supports).
//   - Subdomain goes through `servePage.isValidSubdomain` (the path-traversal
//     guard). We derive it but never reconstitute that guard.
//   - TTL is 7 days (PLAN_TTL_HOURS) — a plan approved Monday and revisited
//     Thursday is normal — not the serve-page 24h default.
//   - We never construct the URL. `registerPage()`/`publicBaseUrl()` return
//     it, and it may be a public https:// host OR a tailnet-only address
//     depending on how the box is reached (BET-343). Echo what it returns.
//   - The served page keeps the serve-page response headers (sandbox CSP
//     WITHOUT `allow-same-origin`, nosniff, no-referrer, no-store). We do NOT
//     weaken the CSP. No external fonts, no CDN scripts, no JavaScript —
//     inline CSS only, a self-contained document.

import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { statePath } from "../shared/paths.mjs";
import { registerPage } from "./servePage.mjs";

// 7 days — matching the artifact mailbox, not the 24h serve-page default.
export const PLAN_TTL_HOURS = 168;

// How many [a-z0-9] chars of the session id survive into the subdomain. Kept
// short so `plan-` + shortId never approaches the 63-char ceiling.
const SHORT_ID_LEN = 20;

// Directory the rendered source HTML is staged into before registerPage copies
// it into the durable pages tree. Goes through statePath() (state-file rule).
function planSrcDir() {
  return statePath("plan-pages");
}

// ---------------------------------------------------------------------------
// Subdomain derivation — pure
// ---------------------------------------------------------------------------

/**
 * The stable subdomain for a session's plan page: `plan-<shortSessionId>`.
 * `shortSessionId` is the session id lowercased, non-alphanumerics stripped,
 * truncated to SHORT_ID_LEN chars. Returns null when the input yields no
 * usable slug (caller must refuse, matching the "never hand back a 404 URL"
 * rule). The result always satisfies isValidSubdomain.
 */
export function planSubdomain(sessionID) {
  if (typeof sessionID !== "string" || sessionID.length === 0) return null;
  const slug = sessionID
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, SHORT_ID_LEN);
  if (!slug) return null;
  return `plan-${slug}`;
}

// ---------------------------------------------------------------------------
// Light-theme tokens — copied from src/renderer/tokens.css `[data-theme="light"]`
// (lines 284-349). Inline so the page looks native and is self-contained; we
// do NOT import the app's stylesheet and do not invent a palette.
// ---------------------------------------------------------------------------

const LIGHT_TOKENS = `
  --canvas: #FAF9F7;
  --panel: #F2F0EC;
  --card: #FFFFFF;
  --raised: #EAE7E1;
  --inset: #F5F3EF;
  --border-subtle: #E8E4DD;
  --border: #DAD5CC;
  --border-strong: #857C6E;
  --tx1: #33302B;
  --tx2: #48433C;
  --tx3: #665F55;
  --tx4: #8A8275;
  --accent: #2E6BFF;
  --accent-tx: #1F55D6;
  --accent-solid: #1F55D6;
  --on-accent: #FFFFFF;
  --accent-soft: #DFE8FF;
  --ok: #0A7A53;
  --warn: #6E6200;
  --danger: #BE2F3C;
  --info: #0B6E85;
  --ok-bg: #0A7A5314;
  --warn-bg: #6E620014;
  --danger-bg: #BE2F3C14;
  --accent-bg: #2E6BFF14;
  --fill: rgba(26, 24, 21, .035);
  --fill-hover: rgba(26, 24, 21, .06);
  --fill-active: rgba(26, 24, 21, .09);
  --diff-add: #E4F4E9;
  --diff-del: #FCEAEC;
  --shadow-sm: 0 1px 2px rgb(26 24 21 / 0.06);
  --shadow-md: 0 8px 24px rgb(26 24 21 / 0.10);
  --shadow-lg: 0 20px 56px rgb(26 24 21 / 0.14);
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
`.trim();

// ---------------------------------------------------------------------------
// Markdown → HTML — pure, self-contained, no JS
// ---------------------------------------------------------------------------

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Inline formatting for a single line's inner text: HTML is escaped FIRST (so
// raw tags in the source can never survive as markup), then code spans (so
// backticks shield their content from bold/italic), then links, bold, italic.
function renderInline(text) {
  let out = escapeHtml(text);
  // Code spans — content already escaped by the pass above.
  out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  // Links: [label](url) — url already attribute-escaped above.
  out = out.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    (_, label, url) => `<a href="${url}">${label}</a>`,
  );
  // Bold.
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italic.
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?![*])/g, "$1<em>$2</em>");
  return out;
}

function isCodeFence(line) {
  const m = /^```/.exec(line);
  if (!m) return null;
  const lang = line.replace(/^```/, "").trim();
  return lang;
}

/**
 * Render plan markdown to HTML `<body>` inner markup. Pure: no side effects.
 * Handles fenced code blocks (monospace, surfaced), ATX headings 1-6, bullet &
 * ordered lists, and inline code / links / bold / italic. Runs only inside
 * renderPlanHtml (never user-controlled substitution beyond what it escapes).
 */
export function renderPlanMarkdown(markdown) {
  const lines = String(markdown).split("\n");
  const out = [];
  let i = 0;
  let inCode = false;
  let codeLang = "";
  let codeBuf = [];

  const flushCode = () => {
    const langAttr = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : "";
    out.push(
      `<pre><code${langAttr}>${codeBuf.map(escapeHtml).join("\n")}</code></pre>`,
    );
    codeBuf = [];
    codeLang = "";
    inCode = false;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!inCode && isCodeFence(line) !== null) {
      inCode = true;
      codeLang = isCodeFence(line);
      i += 1;
      continue;
    }
    if (inCode) {
      if (isCodeFence(line) !== null) {
        flushCode();
        i += 1;
        continue;
      }
      codeBuf.push(line);
      i += 1;
      continue;
    }

    const trimmed = line.trim();
    const heading = /^(#{1,6})[ \t]+(.*)$/.exec(line);
    const hr = /^-{3,}$/.test(trimmed);
    const listItem = /^([ \t]*)[-*+][ \t]+(.*)$/.exec(line);
    const orderedItem = /^([ \t]*)\d+[.)][ \t]+(.*)$/.exec(line);

    if (heading) {
      const level = Math.min(heading[1].length, 6);
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (hr) {
      out.push("<hr>");
      i += 1;
      continue;
    }

    // Lists: collect a run of consecutive list items into ONE <ul>/<ol>.
    if (listItem || orderedItem) {
      const ordered = Boolean(orderedItem);
      const tag = ordered ? "ol" : "ul";
      const items = [];
      while (i < lines.length) {
        const li = /^([ \t]*)[-*+][ \t]+(.*)$/.exec(lines[i]);
        const oli = /^([ \t]*)\d+[.)][ \t]+(.*)$/.exec(lines[i]);
        if (ordered) {
          if (!oli) break;
          items.push(oli[2]);
        } else {
          if (!li) break;
          items.push(li[2]);
        }
        i += 1;
      }
      const lis = items.map((t) => `<li>${renderInline(t)}</li>`).join("\n");
      out.push(`<${tag}>\n${lis}\n</${tag}>`);
      continue;
    }

    // Paragraph: collect consecutive non-empty lines.
    const para = [];
    while (i < lines.length && lines[i].trim() !== "") {
      para.push(lines[i]);
      i += 1;
    }
    if (para.length) {
      out.push(`<p>${para.map(renderInline).join("\n")}</p>`);
    }
    // skip blank separator
    if (lines[i]?.trim() === "") i += 1;
  }

  if (inCode) flushCode();
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Plan metadata helpers — pure
// ---------------------------------------------------------------------------

/**
 * The metrics line derived from the plan text: `N steps · N files`. A clause
 * is OMITTED (never `0`) when not derivable — matching the plan card's own
 * metrics rules (chatUtils.planMetrics). `steps` counts "Step"/numbered
 * headings; `files` counts bullet items whose text is a backticked path.
 */
export function planMetrics(markdown) {
  const md = String(markdown);
  const out = {};
  const stepHeading = md.match(/^#{1,6}[ \t]+step[ \t]+/gim)?.length ?? 0;
  const numberedHeading = md.match(/^#{1,6}[ \t]+\d+[.)]/gm)?.length ?? 0;
  const steps = stepHeading || numberedHeading;
  if (steps > 0) out.steps = steps;
  const files = md.match(/^[ \t]*[-*][ \t]+`[^`]+`[ \t]*$/gm)?.length ?? 0;
  if (files > 0) out.files = files;
  return out;
}

/**
 * The plan's title: the first markdown heading, falling back to the first
 * non-empty line, then "Plan". Mirrors the plan card's title derivation.
 */
export function derivePlanTitle(markdown) {
  const heading = String(markdown).match(/^#{1,6}[ \t]+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  const first = String(markdown)
    .split("\n")
    .find((l) => l.trim())?.trim();
  return first || "Plan";
}

// Drop the leading ATX heading so the page's own <h1> title isn't duplicated
// by the body's first heading.
function stripFirstHeading(markdown) {
  const lines = String(markdown).split("\n");
  if (lines.length && /^#{1,6}[ \t]+/.test(lines[0].trim())) {
    lines.shift();
  }
  return lines.join("\n");
}

function formatGeneratedAt(ts) {
  if (!ts) return "";
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// The document — pure
// ---------------------------------------------------------------------------

/**
 * Render the full standalone HTML document for a plan. Self-contained: inline
 * CSS carrying the app's light-theme tokens, no external fetch, no JS. Content
 * in order: plan title · metrics line · rendered markdown body · the file path
 * it came from · a generated-at timestamp. `generatedAt` may be a Date or
 * ms/s ISO string; when omitted it stays empty (the caller supplies it so the
 * page is deterministic for tests).
 */
export function renderPlanHtml({ title: titleIn, markdown, path, generatedAt }) {
  const md = String(markdown ?? "");
  const title = titleIn ?? derivePlanTitle(md);
  const metrics = planMetrics(md);
  const metricsLine = [
    metrics.steps ? `${metrics.steps} steps` : null,
    metrics.files ? `${metrics.files} files` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const body = renderPlanMarkdown(stripFirstHeading(md));
  const stamp = formatGeneratedAt(generatedAt);

  const metricsHtml = metricsLine
    ? `<p class="metrics">${escapeHtml(metricsLine)}</p>`
    : "";
  const pathHtml = path
    ? `<div class="meta"><span class="meta-label">Plan file</span><code>${escapeHtml(
        path,
      )}</code></div>`
    : "";
  const stampHtml = stamp
    ? `<div class="meta"><span class="meta-label">Generated</span><span class="mono">${escapeHtml(
        stamp,
      )}</span></div>`
    : "";

  return `<!DOCTYPE html>
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
  .wrap {
    max-width: 720px;
    margin: 0 auto;
    padding: 48px 28px 72px;
  }
  h1 {
    font-size: 26px;
    line-height: 1.25;
    margin: 0 0 4px;
    color: var(--tx1);
  }
  .metrics { color: var(--tx4); margin: 0 0 28px; font-size: 13px; }
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
  main hr { border: 0; border-top: 1px solid var(--border); margin: 1.6em 0; }
  code {
    font-family: var(--mono);
    font-size: 0.9em;
    background: var(--inset);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 0.1em 0.35em;
    color: var(--tx2);
  }
  pre {
    background: var(--inset);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 14px 16px;
    overflow-x: auto;
    margin: 0.8em 0;
  }
  pre code {
    display: block;
    background: none;
    border: 0;
    padding: 0;
    color: var(--tx2);
    font-size: 12.5px;
    line-height: 1.5;
  }
  footer {
    margin-top: 48px;
    padding-top: 20px;
    border-top: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--tx3);
    font-size: 12.5px;
  }
  .meta-label {
    color: var(--tx4);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 11px;
  }
  .meta code { font-size: 12px; }
  .mono { font-family: var(--mono); }
</style>
</head>
<body>
  <div class="wrap">
    <h1>${escapeHtml(title)}</h1>
    ${metricsHtml}
    <main>
${body}
    </main>
    <footer>
      ${pathHtml}
      ${stampHtml}
    </footer>
  </div>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Publish — the server-facing entry used by the /api/plan-page route
// ---------------------------------------------------------------------------

/**
 * Render a plan's markdown to a standalone HTML document and register it under
 * the stable `plan-<shortSessionId>` subdomain via the existing serve-page
 * subsystem (TTL 7 days, replacing any prior revision of the same session).
 * Returns whatever `registerPage` returns — the URL comes from there /
 * `baseUrl`, never hand-built here.
 *
 * @param {object} input             - { sessionID, markdown, path?, title?,
 *                                      generatedAt? }
 * @param {object} [deps]
 * @param {string} [deps.baseUrl]    - the box's published base URL (from
 *                                     publicBaseUrl()); required or the call
 *                                     refuses (no silent-404 URL).
 * @param {Function} [deps.register] - defaults to servePage.registerPage.
 * @param {Function} [deps.writeFile] - defaults to node:fs/promises writeFile.
 * @param {Function} [deps.mkdir]    - defaults to node:fs/promises mkdir.
 * @param {Function} [deps.srcDir]   - where the staged HTML is written;
 *                                     defaults to statePath("plan-pages").
 */
export async function publishPlanPage(
  { sessionID, markdown, path, title, generatedAt },
  {
    baseUrl,
    register = registerPage,
    writeFile = writeFileImpl,
    mkdir = mkdirImpl,
    srcDir = planSrcDir,
    ...registerDeps
  } = {},
) {
  const subdomain = planSubdomain(sessionID);
  if (!subdomain) {
    return {
      ok: false,
      error: "A valid session id is required to publish a plan page.",
    };
  }
  if (typeof markdown !== "string" || !markdown.trim()) {
    return { ok: false, error: "Plan markdown is required." };
  }
  if (!baseUrl) {
    return {
      ok: false,
      error:
        "This box has no published public hostname (it has not registered with " +
        "the gateway), so a hosted plan page would not be reachable from anywhere. " +
        "Page hosting is unavailable on this box.",
    };
  }

  const html = renderPlanHtml({ title, markdown, path, generatedAt });
  const srcFile = join(srcDir(), `${subdomain}.html`);
  await mkdir(dirname(srcFile), { recursive: true });
  await writeFile(srcFile, html);

  return register(
    { subdomain, filePath: srcFile, ttlHours: PLAN_TTL_HOURS, sessionID },
    { baseUrl, ...registerDeps },
  );
}

const writeFileImpl = writeFile;
const mkdirImpl = mkdir;
