// CHANGELOG.md → the entries the desktop's "What's new" window shows.
// Spec: docs/superpowers/specs/2026-11-03-whats-new-modal.md
//
// `parseChangelog` is pure (text in, entries + warnings out) and is shared with
// scripts/release/check-changelog.mjs, so what the release skill validates is
// exactly what the server will serve. Warnings never throw: the server logs
// them and carries on, the check script fails on them.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { parse as parseYaml } from "yaml";
import { isWhatsNewAction, normalizeWhatsNewIcon, WHATS_NEW_ICONS } from "../shared/whatsNewAllowlist.mjs";

export const MAX_ENTRIES = 10;
export const MAX_HIGHLIGHTS = 3;

// The file is read relative to this module, never the process cwd.
export const CHANGELOG_PATH = fileURLToPath(new URL("../../CHANGELOG.md", import.meta.url));

const VERSION_RE = /^\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?/;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;
const HIGHLIGHTS_RE = /^<!--\s*highlights\b([\s\S]*?)-->/;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v.trim() !== "";

// "Box + Desktop · iOS 1.2.0" → ["server","desktop","ios"]
function parseComponents(headingText) {
  let rest = headingText.replace(VERSION_RE, "").replace(DATE_RE, "");
  rest = rest.replace(/^[\s—–-]+|[\s—–-]+$/g, "");
  const out = [];
  for (const part of rest.split(/[+·,&/]/)) {
    const word = part.match(/[A-Za-z][A-Za-z]*/)?.[0]?.toLowerCase();
    if (!word) continue;
    const name = word === "box" ? "server" : word;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

// Returns { headline, highlights } or { error } for an unusable block, plus
// `warnings` for items repaired in place (unknown icon, invalid action).
function parseHighlightsBlock(body) {
  let doc;
  try {
    doc = parseYaml(body);
  } catch (e) {
    return { error: `not valid YAML (${String(e?.message ?? e).split("\n")[0]})` };
  }
  if (!isObject(doc)) return { error: "must be a YAML mapping with an `items` list" };
  if (doc.headline != null && !isText(doc.headline)) return { error: "`headline` must be a non-empty string" };
  if (!Array.isArray(doc.items) || doc.items.length === 0) return { error: "`items` must be a non-empty list" };
  if (doc.items.length > MAX_HIGHLIGHTS) return { error: `at most ${MAX_HIGHLIGHTS} items allowed, found ${doc.items.length}` };
  const warnings = [];
  const highlights = [];
  for (const [i, item] of doc.items.entries()) {
    if (!isObject(item) || !isText(item.title) || !isText(item.text)) {
      return { error: `item ${i + 1} needs a non-empty \`title\` and \`text\`` };
    }
    let icon = "sparkles";
    if (item.icon != null) {
      icon = normalizeWhatsNewIcon(item.icon);
      if (icon !== item.icon) {
        warnings.push(`item ${i + 1}: unknown icon ${JSON.stringify(item.icon)} (allowed: ${WHATS_NEW_ICONS.join(", ")}) — shown as sparkles`);
      }
    }
    let action = null;
    if (item.action != null) {
      if (isWhatsNewAction(item.action)) {
        action = item.action;
      } else {
        warnings.push(`item ${i + 1}: invalid action ${JSON.stringify(item.action)} — shown without a link`);
      }
    }
    highlights.push({ title: item.title.trim(), text: item.text.trim(), icon, action });
  }
  return { headline: isText(doc.headline) ? doc.headline.trim() : null, highlights, warnings };
}

/**
 * @param {string} text  the CHANGELOG.md contents
 * @param {{ log?: (message: string) => void, maxEntries?: number }} [opts]
 *        `log` is called once per warning.
 * @returns {{ entries: object[], warnings: string[] }}
 */
export function parseChangelog(text, { log, maxEntries = MAX_ENTRIES } = {}) {
  const warnings = [];
  const warn = (message) => {
    warnings.push(message);
    log?.(message);
  };
  const tree = unified().use(remarkParse).parse(text);
  const nodes = tree.children;
  const entries = [];

  for (let i = 0; i < nodes.length && entries.length < maxEntries; i++) {
    const heading = nodes[i];
    if (heading.type !== "heading" || heading.depth !== 2) continue;
    const start = heading.position.start.offset;
    const headingEnd = heading.position.end.offset;
    const headingText = text.slice(start, headingEnd).replace(/^##\s*/, "").trim();
    const version = headingText.match(VERSION_RE)?.[1];
    if (!version) continue;

    let j = i + 1;
    while (j < nodes.length && !(nodes[j].type === "heading" && nodes[j].depth <= 2)) j++;
    const end = j < nodes.length ? nodes[j].position.start.offset : text.length;
    const raw = text.slice(start, end).trimEnd();

    const removals = [];
    let headline = null;
    let highlights = [];
    let shipsRemoved = false;
    let blockSeen = false;
    for (const node of nodes.slice(i + 1, j)) {
      const nodeRange = [node.position.start.offset, node.position.end.offset];
      if (node.type === "html" && HIGHLIGHTS_RE.test(node.value)) {
        removals.push(nodeRange);
        if (blockSeen) {
          warn(`${version}: more than one highlights block — only the first is used`);
          continue;
        }
        blockSeen = true;
        const parsed = parseHighlightsBlock(node.value.match(HIGHLIGHTS_RE)[1]);
        if (parsed.error) {
          warn(`${version}: highlights block ignored — ${parsed.error}`);
        } else {
          headline = parsed.headline;
          highlights = parsed.highlights;
          for (const w of parsed.warnings) warn(`${version}: ${w}`);
        }
      } else if (!shipsRemoved && node.type === "paragraph" && text.slice(...nodeRange).startsWith("Ships:")) {
        shipsRemoved = true;
        removals.push(nodeRange);
      }
    }

    let markdown = "";
    let cursor = headingEnd;
    for (const [from, to] of removals) {
      markdown += text.slice(cursor, from);
      cursor = to;
    }
    markdown += text.slice(cursor, end);
    markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();

    entries.push({
      version,
      date: headingText.match(DATE_RE)?.[1] ?? null,
      components: parseComponents(headingText),
      fingerprint: createHash("sha256").update(raw).digest("hex"),
      headline,
      highlights,
      markdown,
    });
  }
  return { entries, warnings };
}

/**
 * A loader that re-reads the file only when its mtime/size changed. A missing,
 * unreadable or unparseable file answers `{ entries: [], unavailable: true }`
 * and logs; it never throws.
 */
export function createChangelogLoader({
  path = CHANGELOG_PATH,
  readFileImpl = readFile,
  statImpl = stat,
  log = (message) => console.warn(`[changelog] ${message}`),
} = {}) {
  let cache = null;
  return async function load() {
    try {
      const st = await statImpl(path);
      const key = `${st.mtimeMs}:${st.size}`;
      if (cache && cache.key === key) return cache.value;
      const text = await readFileImpl(path, "utf8");
      const { entries } = parseChangelog(text, { log });
      const value = { entries };
      cache = { key, value };
      return value;
    } catch (e) {
      log(`CHANGELOG.md unavailable: ${String(e?.message ?? e)}`);
      return { entries: [], unavailable: true };
    }
  };
}

export const loadChangelog = createChangelogLoader();
