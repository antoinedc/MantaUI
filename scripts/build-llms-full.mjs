#!/usr/bin/env node
// scripts/build-llms-full.mjs
//
// Regenerate website/llms-full.txt by concatenating every website/*.html as
// markdown, each preceded by its canonical URL. This is the full corpus for
// RAG, summarisation, and any agent that needs the whole site in one fetch
// (as opposed to the short index at website/llms.txt).
//
// Usage:
//   node scripts/build-llms-full.mjs
//
// Idempotency:
//   - Re-running on identical input (HTML files + meta.json) produces
//     byte-identical output. Verified by `npm test`.
//   - Concatenation order is the sorted order of the entries in
//     website/schema/meta.json#pages, which is deterministic.
//
// HTML → markdown:
//   This is a small in-house converter that handles only the tags actually
//   present in website/*.html (h1-h4, p, li, ul, ol, a, code, pre, q, em, b,
//   strong, i, small, br, div, span, table, footer/header/nav/section). It
//   deliberately does NOT try to be a general converter — only what the
//   marketing site uses. Adding a new tag to the pages requires updating
//   this script.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SCHEMA_PATH = join(ROOT, "website/schema/meta.json");
const OUT_PATH = join(ROOT, "website/llms-full.txt");

const HEADING = { h1: "#", h2: "##", h3: "###", h4: "####" };

// Tags to strip entirely (no content kept).
const SKIP_TAGS = new Set(["script", "style", "noscript", "head"]);
// Void elements — emit a single space inline, or a newline at block level.
const VOID_INLINE = new Set(["br"]);
const VOID_BLOCK = new Set(["hr"]);
// Self-closing media that have alt text — keep the alt.
const MEDIA = new Set(["img", "svg", "path", "circle", "rect"]);
// Tags treated as transparent containers — recurse into children.
const TRANSPARENT = new Set([
  "html", "body",
  "div", "section", "article", "header", "footer", "nav", "main", "aside",
  "figure", "figcaption",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "ul", "ol",
]);
// Inline text-level tags that contribute only their text content.
const INLINE = new Set([
  "span", "small", "em", "i", "b", "strong", "q", "button", "label",
]);
// Block-level structural tags — each opens with a blank line before/after.
const BLOCK_HEADINGS = new Set(Object.keys(HEADING));
const BLOCK_PARAGRAPH = "p";
const BLOCK_LIST_ITEM = "li";
const BLOCK_CODE = "pre";
const BLOCK_PREFORMATTED_INLINE = "code"; // <code> outside <pre>

function stripDoctype(html) {
  return html.replace(/^<!DOCTYPE[^>]*>\s*/i, "");
}

function dropNoise(html) {
  let out = html;
  out = out.replace(/<head\b[\s\S]*?<\/head>/gi, "");
  out = out.replace(/<script\b[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<style\b[\s\S]*?<\/style>/gi, "");
  out = out.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "");
  return out;
}

function tokenise(html) {
  const tokens = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      const tail = html.slice(i);
      if (tail.length) tokens.push({ kind: "text", text: tail });
      break;
    }
    if (lt > i) {
      tokens.push({ kind: "text", text: html.slice(i, lt) });
    }
    const gt = html.indexOf(">", lt);
    if (gt === -1) break;
    const raw = html.slice(lt + 1, gt);
    if (raw.startsWith("!--") || raw.startsWith("!")) {
      i = gt + 1;
      continue;
    }
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().split(/\s/)[0].toLowerCase();
      tokens.push({ kind: "close", tag: name });
      i = gt + 1;
      continue;
    }
    const selfClose = raw.endsWith("/");
    const clean = selfClose ? raw.slice(0, -1).trim() : raw.trim();
    const m = clean.match(/^([a-zA-Z][a-zA-Z0-9]*)\b([\s\S]*)$/);
    if (!m) {
      i = gt + 1;
      continue;
    }
    tokens.push({ kind: "open", tag: m[1].toLowerCase(), attrs: m[2] || "" });
    i = gt + 1;
  }
  return tokens;
}

function getAttr(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i");
  const m = attrs.match(re);
  return m ? m[1] : null;
}

// Find the index of the matching close tag for the open at position `start`.
// Skips nested same-name tags. Returns the position of the close token, or
// tokens.length if no match.
function findMatchingClose(tokens, start) {
  const open = tokens[start];
  if (!open || open.kind !== "open") return start + 1;
  let depth = 1;
  let i = start + 1;
  while (i < tokens.length) {
    if (tokens[i].kind === "open" && tokens[i].tag === open.tag) depth++;
    else if (tokens[i].kind === "close" && tokens[i].tag === open.tag) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return tokens.length;
}

// Render the children of the element at index `start`. Returns {text, next}
// where `next` is the index AFTER the matching close token. Skips the open
// and close tokens — caller has already classified the open.
function renderChildren(tokens, start) {
  const closeIdx = findMatchingClose(tokens, start);
  let out = "";
  let i = start + 1;
  while (i < closeIdx) {
    const r = renderNode(tokens, i);
    out += r.text;
    i = r.next;
  }
  return { text: out, next: closeIdx + 1 };
}

// Render a single node at `i`. Returns {text, next} where `next` is the
// index AFTER this node (consuming the close token if any).
function renderNode(tokens, i) {
  const t = tokens[i];
  if (t.kind === "text") {
    return { text: t.text, next: i + 1 };
  }
  if (t.kind === "close") {
    return { text: "", next: i + 1 };
  }
  const tag = t.tag;
  if (SKIP_TAGS.has(tag)) {
    const closeIdx = findMatchingClose(tokens, i);
    return { text: "", next: closeIdx + 1 };
  }
  if (VOID_INLINE.has(tag)) {
    return { text: " ", next: i + 1 };
  }
  if (VOID_BLOCK.has(tag)) {
    return { text: "\n\n---\n\n", next: i + 1 };
  }
  if (MEDIA.has(tag)) {
    const alt = getAttr(t.attrs, "alt");
    return { text: alt ? alt : "", next: i + 1 };
  }
  if (HEADING[tag]) {
    const r = renderChildren(tokens, i);
    const headingText = r.text.replace(/\s+/g, " ").trim();
    return { text: `${HEADING[tag]} ${headingText}\n\n`, next: r.next };
  }
  if (tag === BLOCK_PARAGRAPH) {
    const r = renderChildren(tokens, i);
    const text = collapseInline(r.text);
    return { text: text ? text + "\n\n" : "", next: r.next };
  }
  if (tag === BLOCK_LIST_ITEM) {
    const r = renderChildren(tokens, i);
    const text = collapseInline(r.text);
    return { text: text ? `- ${text}\n` : "", next: r.next };
  }
  if (tag === BLOCK_CODE) {
    // Capture raw inner text — preserve newlines.
    const closeIdx = findMatchingClose(tokens, i);
    let body = "";
    for (let j = i + 1; j < closeIdx; j++) {
      if (tokens[j].kind === "text") body += tokens[j].text;
    }
    const trimmed = body.replace(/^\n+|\n+$/g, "");
    return { text: trimmed ? "```\n" + trimmed + "\n```\n\n" : "", next: closeIdx + 1 };
  }
  if (tag === BLOCK_PREFORMATTED_INLINE) {
    const closeIdx = findMatchingClose(tokens, i);
    let body = "";
    for (let j = i + 1; j < closeIdx; j++) {
      if (tokens[j].kind === "text") body += tokens[j].text;
    }
    return { text: "`" + body.replace(/`/g, "") + "`", next: closeIdx + 1 };
  }
  if (tag === "a") {
    const href = getAttr(t.attrs, "href") || "";
    const r = renderChildren(tokens, i);
    const text = collapseInline(r.text);
    if (!text || href.startsWith("#")) {
      return { text, next: r.next };
    }
    return { text: `[${text}](${href})`, next: r.next };
  }
  if (TRANSPARENT.has(tag)) {
    return renderChildren(tokens, i);
  }
  if (INLINE.has(tag)) {
    return renderChildren(tokens, i);
  }
  // Unknown — treat as transparent.
  return renderChildren(tokens, i);
}

function collapseInline(s) {
  return s.replace(/\s+/g, " ").trim();
}

const ENTITY = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
  "&copy;": "©",
  "&reg;": "®",
  "&trade;": "™",
};

function decodeEntities(s) {
  return s.replace(/&(?:lt|gt|amp|quot|apos|#39|nbsp|copy|reg|trade);/g, (m) => ENTITY[m] || m);
}

function htmlToMarkdown(html) {
  let body = dropNoise(stripDoctype(html));
  const tokens = tokenise(body);
  let out = "";
  let i = 0;
  while (i < tokens.length) {
    const r = renderNode(tokens, i);
    out += r.text;
    i = r.next;
  }
  out = decodeEntities(out);
  // Normalise whitespace.
  out = out.replace(/[ \t]+\n/g, "\n");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim() + "\n";
}

function main() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const files = Object.keys(schema.pages).sort();

  const sections = [];
  for (const f of files) {
    const page = schema.pages[f];
    const htmlPath = join(ROOT, "website", f);
    const html = readFileSync(htmlPath, "utf8");
    const md = htmlToMarkdown(html);
    sections.push(`# ${page.canonical}\n\n${md}`);
  }

  const out = sections.join("\n\n---\n\n") + "\n";
  writeFileSync(OUT_PATH, out, "utf8");
  console.log(`wrote ${files.length} pages (${out.length} bytes) to website/llms-full.txt`);
}

main();
