// pages.mjs — page formats (spec §6.4): YAML front matter and Markdown section edits.
//
//   • Front matter is parsed with `yaml` between `---` fences (~10 lines, spec §10:
//     gray-matter is unmaintained and a second YAML parser).
//   • A section edit splices by mdast source positions (unified + remark-parse)
//     into the ORIGINAL source, so the rest of the page keeps its exact
//     formatting — no stringify round trip, and a `#` inside a code fence is never
//     mistaken for a heading.

import YAML from "yaml";
import { unified } from "unified";
import remarkParse from "remark-parse";

const FENCE = /^---[ \t]*\r?\n/;

/**
 * Split a page into front matter and body.
 * @returns {{ frontMatter: object|null, body: string, bodyOffset: number, raw: string|null }}
 *   `bodyOffset` is the index of `body` inside the source.
 */
export function parsePage(source) {
  const text = String(source ?? "");
  const open = FENCE.exec(text);
  if (!open) return { frontMatter: null, body: text, bodyOffset: 0, raw: null };
  const rest = text.slice(open[0].length);
  const close = /(^|\r?\n)---[ \t]*(\r?\n|$)/.exec(rest);
  if (!close) return { frontMatter: null, body: text, bodyOffset: 0, raw: null };
  const raw = rest.slice(0, close.index);
  let fm = null;
  try {
    const parsed = YAML.parse(raw);
    fm = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { frontMatter: null, body: text, bodyOffset: 0, raw: null };
  }
  const bodyOffset = open[0].length + close.index + close[0].length;
  return { frontMatter: fm, body: text.slice(bodyOffset), bodyOffset, raw };
}

/** `---\n<yaml>---\n` for a plain object ('' for an empty one). Dates stay ISO strings. */
export function renderFrontMatter(fm) {
  if (!fm || typeof fm !== "object" || Object.keys(fm).length === 0) return "";
  return `---\n${YAML.stringify(fm, { lineWidth: 0 })}---\n`;
}

/** Source text from front matter + body. */
export function renderPage({ frontMatter, body }) {
  return `${renderFrontMatter(frontMatter)}${body ?? ""}`;
}

/** Update only the given front-matter keys, keeping the body byte-for-byte. */
export function updateFrontMatter(source, patch) {
  const p = parsePage(source);
  return renderPage({ frontMatter: { ...(p.frontMatter ?? {}), ...patch }, body: p.body });
}

const processor = unified().use(remarkParse);

function headings(body) {
  const tree = processor.parse(body);
  const out = [];
  for (const node of tree.children) {
    if (node.type !== "heading") continue;
    const text = body.slice(node.position.start.offset, node.position.end.offset).replace(/^#{1,6}[ \t]+/, "").replace(/[ \t]+#+[ \t]*$/, "").trim();
    out.push({ depth: node.depth, text, start: node.position.start.offset, end: node.position.end.offset });
  }
  return out;
}

const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, " ");

/** Top-level headings of a page: `[{depth, text}]`. */
export function listSections(source) {
  return headings(parsePage(source).body).map(({ depth, text }) => ({ depth, text }));
}

function locate(body, heading) {
  const hs = headings(body);
  const i = hs.findIndex((h) => norm(h.text) === norm(heading));
  if (i < 0) return null;
  const h = hs[i];
  let endOfSection = body.length;
  for (let j = i + 1; j < hs.length; j++) {
    if (hs[j].depth <= h.depth) {
      endOfSection = hs[j].start;
      break;
    }
  }
  let contentStart = h.end;
  if (body[contentStart] === "\r") contentStart++;
  if (body[contentStart] === "\n") contentStart++;
  return { h, contentStart, endOfSection };
}

/** The text under `heading` (up to the next heading of the same or shallower depth), or null. */
export function getSection(source, heading) {
  const { body } = parsePage(source);
  const loc = locate(body, heading);
  return loc ? body.slice(loc.contentStart, loc.endOfSection) : null;
}

/**
 * Replace (or append to, with `mode: "append"`) the body of section `heading`.
 * A missing section is created at the end of the page with `## <heading>` (or
 * `depth`). The splice touches nothing outside the section.
 */
export function spliceSection(source, heading, content, { mode = "replace", depth = 2 } = {}) {
  const page = parsePage(source);
  const { body } = page;
  const loc = locate(body, heading);
  const block = String(content ?? "").replace(/\s+$/g, "");
  let nextBody;
  if (!loc) {
    const sep = body === "" ? "" : body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
    nextBody = `${body}${sep}${"#".repeat(depth)} ${heading}\n\n${block}\n`;
  } else {
    const before = body.slice(0, loc.contentStart);
    const current = body.slice(loc.contentStart, loc.endOfSection);
    const after = body.slice(loc.endOfSection);
    const trailingGap = /(\r?\n)*$/.exec(current)?.[0] ?? "";
    const keepGap = after === "" ? "\n" : trailingGap.length >= 2 ? trailingGap : "\n\n";
    const existing = current.replace(/^(\r?\n)+/, "").replace(/\s+$/g, "");
    const merged = mode === "append" ? `${existing}${existing === "" ? "" : "\n"}${block}` : block;
    nextBody = `${before}${before.endsWith("\n\n") || merged === "" ? "" : "\n"}${merged}${keepGap}${after}`;
  }
  return `${source.slice(0, page.bodyOffset)}${nextBody}`;
}

/** A safe store-relative page path: `<area>/…​.md`, no `..`, no absolute, no dotfiles. */
export function isSafePagePath(rel) {
  if (typeof rel !== "string" || rel === "" || rel.length > 200) return false;
  if (rel.startsWith("/") || rel.includes("\\") || rel.includes("\0")) return false;
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith("."))) return false;
  if (!rel.endsWith(".md")) return false;
  return /^(user|commons|projects\/[a-z0-9-]{1,40}-[0-9a-f]{10})\//.test(rel) || /^(user|commons)\/[^/]+\.md$/.test(rel);
}

/** `{area, slug}` of a page path (`projects/<slug>/…` | `user/…` | `commons/…`) or null. */
export function pageArea(rel) {
  if (!isSafePagePath(rel)) return null;
  const parts = rel.split("/");
  if (parts[0] === "projects") return { area: "project", slug: parts[1] };
  return { area: parts[0], slug: null };
}

/** First sentence-ish line of a body, for briefing/search summaries (≤ `max` chars). */
export function summarizeBody(body, max = 120) {
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#") || t.startsWith("```") || t.startsWith("---")) continue;
    const plain = t.replace(/^[-*>\d.\s]+/, "").replace(/[`*_]/g, "");
    return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
  }
  return "";
}

/** A page's display title: front-matter `title`, else its first `# ` heading, else the file name. */
export function pageTitle(source, rel) {
  const p = parsePage(source);
  if (typeof p.frontMatter?.title === "string" && p.frontMatter.title.trim()) return p.frontMatter.title.trim();
  const h = headings(p.body).find((x) => x.depth === 1);
  if (h) return h.text;
  return String(rel ?? "").split("/").pop().replace(/\.md$/, "");
}
