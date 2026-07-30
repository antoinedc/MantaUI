#!/usr/bin/env node
// scripts/build-website-sitemap.mjs
//
// Regenerate website/sitemap.xml from website/schema/meta.json. Extensionless
// URLs (https://mantaui.com/vs-orca, not .../vs-orca.html). Priorities and
// changefreq per the issue body:
//   - homepage        1.0  weekly
//   - comparison / use-case / open-source / pricing: 0.8 monthly
//   - privacy / terms: 0.3  yearly
//
// Usage:
//   node scripts/build-website-sitemap.mjs
//
// Idempotent: re-running with the same schema and the same git history
// produces byte-identical output.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SCHEMA_PATH = join(ROOT, "website/schema/meta.json");
const SITEMAP_PATH = join(ROOT, "website/sitemap.xml");

function lastmodIsoFor(relFile) {
  // Always emit UTC so re-running the generator on any machine/CI timezone
  // produces byte-identical output. `%cI` carries the committer's stored
  // timezone offset, which varies across machines and dirties sitemap.xml on
  // every test run; `%ct` is a timezone-independent unix epoch we normalize
  // to an ISO-8601 UTC string (`...Z`).
  try {
    const unix = execFileSync(
      "git",
      ["log", "-1", "--format=%ct", "--", relFile],
      { cwd: ROOT, encoding: "utf8" },
    ).trim();
    const sec = Number(unix);
    if (!Number.isFinite(sec) || sec <= 0) return new Date().toISOString();
    return new Date(sec * 1000).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function priorityFor(file) {
  if (file === "index.html") return 1.0;
  if (["privacy.html", "terms.html"].includes(file)) return 0.3;
  return 0.8;
}

function changefreqFor(file) {
  if (file === "index.html") return "weekly";
  if (["privacy.html", "terms.html"].includes(file)) return "yearly";
  return "monthly";
}

function canonicalToSitemapUrl(canonical, file) {
  // Schema stores the page canonical (e.g. https://mantaui.com/vs-orca).
  // Sitemap uses that as-is. For homepage we use the bare origin.
  if (file === "index.html") {
    return canonical.endsWith("/") ? canonical : canonical + "/";
  }
  return canonical;
}

function main() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const siteUrl = schema.site.url;
  const pages = schema.pages;
  const files = Object.keys(pages).sort();
  const now = new Date().toISOString();

  const urls = files.map((f) => {
    const page = pages[f];
    const loc = canonicalToSitemapUrl(page.canonical, f);
    return {
      loc,
      lastmod: lastmodIsoFor(`website/${f}`),
      changefreq: changefreqFor(f),
      priority: priorityFor(f).toFixed(1),
    };
  });

  const body =
    urls
      .map(
        (u) =>
          `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`,
      )
      .join("\n") + "\n";

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    body +
    `</urlset>\n`;

  writeFileSync(SITEMAP_PATH, xml, "utf8");
  console.log(`wrote ${urls.length} URLs to website/sitemap.xml`);
}

main();
