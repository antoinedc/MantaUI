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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve, sep } from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeHighlight from "rehype-highlight";
import { visit } from "unist-util-visit";
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
  --r-xs: 4px;
  --r-sm: 6px;
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

// Dark-theme tokens — copied VERBATIM from `[data-theme="dark"]` in
// `src/renderer/tokens.css` (do not retune). Only the tokens this page uses.
// Radii (`--r-xs`/`--r-sm`) and the font stacks are theme-independent and stay
// in `:root` only, so they are not repeated here.
const DARK_TOKENS = `
  --canvas: #0B1020;
  --inset: #070B16;
  --border-subtle: #222C49;
  --border: #33406B;
  --tx1: #E3E8F2;
  --tx2: #BDC7DB;
  --tx3: #939FB8;
  --tx4: #6B7690;
  --accent-tx: #7BA0FF;
  --accent-solid: #5A88FF;
  --fill: rgba(255, 255, 255, .04);
  --ok: #3DD9A4;
  --warn: #FACC15;
  --danger: #FF6B7A;
  --info: #49D7F5;
  --diff-add: #12351f;
  --diff-del: #3a1720;
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

/**
 * Render plan markdown to HTML `<body>` inner markup.
 *
 * The SAME engine the in-app transcript uses (react-markdown is remark/rehype,
 * with the same remark-gfm), so a plan reads identically in the chat panel and
 * on its shared page. Pure and synchronous — `renderPlanHtml` is a pure
 * function and its tests depend on that.
 *
 * SECURITY: `remark-rehype` DROPS raw HTML by default, so markup embedded in a
 * plan can never reach the page. Do NOT add `allowDangerousHtml` or
 * `rehype-raw` — that is the whole sanitisation story, and the page's sandbox
 * CSP is a second line, not the first.
 *
 * Pipeline order is load-bearing: `rehype-slug` gives every heading a stable
 * `id`, THEN the collector reads clean heading text (before
 * `rehype-autolink-headings` wraps it), then autolink makes each heading
 * text link to its own anchor, then `rehype-highlight` adds `hljs-*` spans to
 * fenced code.
 *
 * @returns {{ html: string, headings: Array<{level:number,id:string,text:string}> }}
 *   `headings` lists the `h2`/`h3` headings (the page title is `h1`, and
 *   `h4+` is too fine to list), in document order.
 */
export function renderPlanMarkdown(markdown) {
  const headings = [];
  const html = String(
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(rehypeSlug)
      .use(collectHeadings(headings))
      .use(rehypeAutolinkHeadings, { behavior: "wrap" })
      .use(rehypeHighlight)
      .use(rehypeStringify)
      .processSync(String(markdown)),
  );
  return { html, headings };
}

// Rehype plugin that collects `h2`/`h3` headings into the given array. Runs
// BEFORE autolink so `text` is the clean, unwrapped heading text.
function collectHeadings(headings) {
  return () => (tree) => {
    visit(tree, "element", (node) => {
      if (!/^h[23]$/.test(node.tagName ?? "")) return;
      const id = node.properties?.id;
      if (!id) return;
      const text = (node.children ?? [])
        .map((child) => (typeof child.value === "string" ? child.value : ""))
        .join("")
        .trim();
      headings.push({ level: Number(node.tagName[1]), id, text });
    });
  };
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
  const { html: body, headings } = renderPlanMarkdown(stripFirstHeading(md));
  const stamp = formatGeneratedAt(generatedAt);

  const metricsHtml = metricsLine
    ? `<p class="metrics">${escapeHtml(metricsLine)}</p>`
    : "";
  // "On this page" nav — only when there are enough headings that it is not
  // noise (below 3 it is). Deliberately a static block, not sticky and not a
  // sidebar: it reads correctly at every width, including a phone, with no
  // layout machinery.
  const tocHtml =
    headings.length >= 3
      ? `<nav class="toc" aria-label="On this page">
  <p class="toc-title">On this page</p>
  <ul>
${headings
  .map(
    (h) =>
      `    <li${h.level === 3 ? ' class="toc-l3"' : ""}><a href="#${escapeHtml(
        h.id,
      )}">${escapeHtml(h.text)}</a></li>`,
  )
  .join("\n")}
  </ul>
</nav>`
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
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    ${LIGHT_TOKENS}
  }
  @media (prefers-color-scheme: dark) {
    :root {
      ${DARK_TOKENS}
    }
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
    border-radius: var(--r-xs);
    padding: 0.1em 0.35em;
    color: var(--tx2);
  }
  pre {
    background: var(--inset);
    border: 1px solid var(--border-subtle);
    border-radius: var(--r-sm);
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
  main blockquote {
    margin: 0.8em 0;
    padding: 0.1em 0 0.1em 14px;
    border-left: 2px solid var(--border);
    color: var(--tx3);
  }
  main ul ul, main ul ol, main ol ul, main ol ol { margin: 0.25em 0; }
  main li > p { margin: 0.25em 0; }
  /* GFM task list: the checkbox replaces the marker, so the item un-indents
     back to the list's own left edge. */
  main li:has(> input[type="checkbox"]) {
    list-style: none;
    margin-left: -1.4em;
  }
  main li > input[type="checkbox"] {
    margin: 0 6px 0 0;
    vertical-align: baseline;
    accent-color: var(--accent-solid);
  }
  main del { color: var(--tx4); }
  main img { max-width: 100%; height: auto; border-radius: var(--r-sm); }
  main table {
    display: block;
    overflow-x: auto;
    max-width: 100%;
    border-collapse: collapse;
    margin: 0.9em 0;
    font-size: 13.5px;
  }
  main th, main td {
    border: 1px solid var(--border-subtle);
    padding: 6px 10px;
    text-align: left;
    vertical-align: top;
  }
  main th { background: var(--inset); color: var(--tx2); font-weight: 600; }
  main tr:nth-child(even) td { background: var(--fill); }
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
  /* Code theme — highlight.js classes mapped onto the app's semantic tokens,
     so the page needs no third-party stylesheet and follows the colour scheme
     above without a second theme. */
  .hljs-comment, .hljs-quote { color: var(--tx4); font-style: italic; }
  .hljs-keyword, .hljs-selector-tag, .hljs-built_in,
  .hljs-meta, .hljs-doctag { color: var(--accent-tx); }
  .hljs-string, .hljs-regexp, .hljs-symbol { color: var(--ok); }
  .hljs-number, .hljs-literal { color: var(--warn); }
  .hljs-title, .hljs-title.function_, .hljs-title.class_,
  .hljs-section, .hljs-name { color: var(--info); }
  .hljs-attr, .hljs-attribute, .hljs-property,
  .hljs-variable, .hljs-params { color: var(--tx2); }
  .hljs-addition { color: var(--ok); background: var(--diff-add); }
  .hljs-deletion { color: var(--danger); background: var(--diff-del); }
  .hljs-emphasis { font-style: italic; }
  .hljs-strong { font-weight: 600; }
  /* "On this page" nav — a static block above <main>, shown only when there
     are 3+ headings. */
  .toc {
    margin: 0 0 32px;
    padding: 14px 18px;
    background: var(--inset);
    border: 1px solid var(--border-subtle);
    border-radius: var(--r-sm);
  }
  .toc-title {
    margin: 0 0 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--tx4);
  }
  .toc ul { margin: 0; padding: 0; list-style: none; }
  .toc li { margin: 3px 0; font-size: 13.5px; }
  .toc-l3 { padding-left: 16px; }
  .toc a { color: var(--tx2); text-decoration: none; }
  .toc a:hover { color: var(--accent-tx); text-decoration: underline; }
  main h1 a, main h2 a, main h3 a,
  main h4 a, main h5 a, main h6 a { color: inherit; text-decoration: none; }
  main h1 a:hover, main h2 a:hover, main h3 a:hover,
  main h4 a:hover, main h5 a:hover, main h6 a:hover { text-decoration: underline; }
  @media print {
    .toc, footer { display: none; }
    body { background: #fff; color: #000; font-size: 11pt; }
    .wrap { max-width: none; padding: 0; }
    a { color: #000; text-decoration: underline; }
    pre, blockquote, table { break-inside: avoid; page-break-inside: avoid; }
    h1, h2, h3 { break-after: avoid; page-break-after: avoid; }
    pre { border: 1px solid #ccc; background: #fff; }
    [class^="hljs-"], [class*=" hljs-"] { color: #000 !important; background: none !important; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1>${escapeHtml(title)}</h1>
    ${metricsHtml}
    ${tocHtml}
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
const readFileImpl = readFile;

// ---------------------------------------------------------------------------
// Reading the plan markdown off disk (server-side file resolution)
// ---------------------------------------------------------------------------

/**
 * Read a plan's markdown off disk, confined to the session's own directory.
 *
 * The path comes from the client (the `plan_exit` tool's input), so it is
 * UNTRUSTED: it is resolved against the session directory — which makes both
 * a relative `.opencode/plans/x.md` and an absolute path inside the project
 * work — and then rejected unless the result is still inside that directory.
 * `.md` only. Returns `{ ok, markdown }` | `{ ok:false, error }`.
 *
 * @param {{ path?: unknown, sessionDir?: unknown }} input
 * @param {object} [deps]
 * @param {Function} [deps.readFile] - defaults to node:fs/promises readFile.
 */
export async function readPlanMarkdown(
  { path, sessionDir },
  { readFile: readFileDep = readFileImpl } = {},
) {
  if (!sessionDir || typeof sessionDir !== "string" || sessionDir.length === 0) {
    return { ok: false, error: "A session directory is required to read the plan file." };
  }
  if (typeof path !== "string" || path.length === 0) {
    return { ok: false, error: "A plan file path is required." };
  }
  if (!path.endsWith(".md")) {
    return { ok: false, error: "Only .md plan files can be published." };
  }
  const abs = resolve(sessionDir, path);
  const root = resolve(sessionDir) + sep;
  if (abs !== resolve(sessionDir) && !abs.startsWith(root)) {
    return { ok: false, error: "Plan file path is outside the session directory." };
  }
  try {
    const markdown = await readFileDep(abs, "utf8");
    return { ok: true, markdown };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
