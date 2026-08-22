// Shared site chrome — single source of truth for header/footer/theme.
// Regenerates the <head> theme block, <header>, and <footer> of every
// marketing page from website/chrome/*.html so all pages stay identical
// (previously each page hand-duplicated them, and only the homepage had the
// theme toggle). Idempotent: running twice yields the same output.
//
// Usage: node scripts/build-site-chrome.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const website = join(root, "website");
const chrome = join(website, "chrome");

const HEAD = readFileSync(join(chrome, "head.html"), "utf8").trim();
const HEADER = readFileSync(join(chrome, "header.html"), "utf8").trim();
const FOOTER = readFileSync(join(chrome, "footer.html"), "utf8").trim();

const files = readdirSync(website).filter(
  (f) => f.endsWith(".html") && !f.startsWith("chrome")
);

let changed = 0;
for (const f of files) {
  const path = join(website, f);
  let html = readFileSync(path, "utf8");
  const before = html;

  // 1. Drop any pre-existing theme-stamp script. SAFE: consider only each
  //    self-contained <script>...</script> block and remove it iff it contains
  //    "manta-theme". Never span across tags (a lazy regex across <script>
  //    boundaries deleted the homepage body once).
  html = html.replace(/<script(\s[^>]*)?>[\s\S]*?<\/script>/g, (block) =>
    block.includes("manta-theme") ? "" : block
  );
  // 2. Drop any pre-existing theme-color meta (now owned by chrome/head.html).
  html = html.replace(/<meta name="theme-color"[^>]*>\s*/g, "");
  // 3. Replace the fonts+site.css block with the shared head chrome.
  html = html.replace(
    /<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">[\s\S]*?<link rel="stylesheet" href="\/site\.css">/,
    HEAD
  );
  // 4. Replace header + footer.
  html = html.replace(/<header>[\s\S]*?<\/header>\s*/, HEADER + "\n");
  html = html.replace(/<footer>[\s\S]*?<\/footer>[\s\S]*?(<\/body>)/, FOOTER + "\n\n$1");

  if (html !== before) {
    writeFileSync(path, html);
    changed++;
  }
}
console.log(`build-site-chrome: regenerated ${changed}/${files.length} pages`);
