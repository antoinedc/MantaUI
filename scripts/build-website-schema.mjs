#!/usr/bin/env node
// scripts/build-website-schema.mjs
//
// Idempotently regenerate the head/meta and JSON-LD blocks in every
// website/*.html from website/schema/meta.json. Run before committing
// any change to meta.json.
//
// Usage:
//   node scripts/build-website-schema.mjs
//
// Behaviour:
//   - For each page listed in meta.json#pages, find the
//     <!-- BEGIN:head-meta -->...<!-- END:head-meta --> marker pair in
//     <head> and replace the content between them with the canonical
//     + Open Graph + Twitter Card tags derived from that page's entry.
//   - Same for <!-- BEGIN:head-schema -->...<!-- END:head-schema -->,
//     which holds the JSON-LD <script type="application/ld+json"> blocks.
//   - If the marker pair is absent, it is inserted right before </head>.
//   - If meta.json is unchanged and the script is unchanged, output is
//     byte-identical to the previous run (verified by `npm test`).

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SCHEMA_PATH = join(ROOT, "website/schema/meta.json");
const WEBSITE_DIR = join(ROOT, "website");

const META_BEGIN = "<!-- BEGIN:head-meta -->";
const META_END = "<!-- END:head-meta -->";
const SCHEMA_BEGIN = "<!-- BEGIN:head-schema -->";
const SCHEMA_END = "<!-- END:head-schema -->";

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function buildHeadMeta(page, site) {
  const lines = [];
  lines.push(`<link rel="canonical" href="${escapeAttr(page.canonical)}">`);
  const og = [
    ["og:title", page.title],
    ["og:description", page.description],
    ["og:url", page.canonical],
    ["og:type", "website"],
    ["og:image", site.ogImage],
    ["og:image:width", "1200"],
    ["og:image:height", "630"],
    ["og:site_name", site.name],
  ];
  for (const [k, v] of og) {
    lines.push(`<meta property="${k}" content="${escapeAttr(v)}">`);
  }
  const tw = [
    ["twitter:card", "summary_large_image"],
    ["twitter:title", page.title],
    ["twitter:description", page.description],
    ["twitter:image", site.ogImage],
  ];
  if (site.twitterHandle) tw.push(["twitter:site", site.twitterHandle]);
  for (const [k, v] of tw) {
    lines.push(`<meta name="${k}" content="${escapeAttr(v)}">`);
  }
  return lines.join("\n");
}

function buildHeadSchema(page) {
  if (!Array.isArray(page.jsonLd) || page.jsonLd.length === 0) return "";
  return page.jsonLd
    .map((block) => {
      const body = JSON.stringify(block, null, 2);
      return `<script type="application/ld+json">\n${body}\n</script>`;
    })
    .join("\n");
}

function replaceOrInsert(html, beginMarker, endMarker, content) {
  const beginIdx = html.indexOf(beginMarker);
  const endIdx = html.indexOf(endMarker);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = html.slice(0, beginIdx + beginMarker.length);
    const after = html.slice(endIdx);
    return before + "\n" + content + "\n" + after;
  }
  const closeHead = html.indexOf("</head>");
  if (closeHead === -1) {
    throw new Error(`no </head> in ${html.length}-byte document and no markers found`);
  }
  const block = `\n${beginMarker}\n${content}\n${endMarker}\n`;
  return html.slice(0, closeHead) + block + html.slice(closeHead);
}

function processPage(filePath, pageEntry, site) {
  const original = readFileSync(filePath, "utf8");
  const metaContent = buildHeadMeta(pageEntry, site);
  const schemaContent = buildHeadSchema(pageEntry);
  let next = replaceOrInsert(original, META_BEGIN, META_END, metaContent);
  next = replaceOrInsert(next, SCHEMA_BEGIN, SCHEMA_END, schemaContent);
  if (next !== original) {
    writeFileSync(filePath, next, "utf8");
    return { changed: true, path: filePath };
  }
  return { changed: false, path: filePath };
}

function main() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const site = schema.site;
  const pages = schema.pages;
  if (!pages) throw new Error("meta.json missing #pages");

  const htmlFiles = readdirSync(WEBSITE_DIR).filter((f) => f.endsWith(".html"));
  const results = [];
  for (const f of htmlFiles) {
    const entry = pages[f];
    if (!entry) {
      // Page present in website/ but absent from meta.json — surface loudly
      // so a hand-added page is forced into the schema rather than silently
      // shipped without canonical / OG / JSON-LD.
      results.push({ changed: false, path: f, missing: true });
      continue;
    }
    const r = processPage(join(WEBSITE_DIR, f), entry, site);
    results.push(r);
  }

  // Also surface pages in meta.json that have no .html — same reason, in
  // reverse.
  for (const f of Object.keys(pages)) {
    if (!htmlFiles.includes(f)) {
      results.push({ path: f, orphan: true });
    }
  }

  let changed = 0;
  let missing = 0;
  let orphan = 0;
  for (const r of results) {
    if (r.changed) {
      changed++;
      console.log(`updated  ${relative(ROOT, r.path)}`);
    } else if (r.missing) {
      missing++;
      console.error(`MISSING in meta.json: ${r.path}`);
    } else if (r.orphan) {
      orphan++;
      console.error(`ORPHAN in meta.json (no .html): ${r.path}`);
    } else {
      console.log(`unchanged  ${relative(ROOT, r.path)}`);
    }
  }
  if (missing || orphan) {
    console.error(`\n${missing} page(s) missing from meta.json, ${orphan} orphan(s).`);
    process.exit(1);
  }
  console.log(`\n${changed} page(s) updated, ${htmlFiles.length - changed} unchanged.`);
}

main();
