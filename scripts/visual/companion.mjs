import { mkdirSync, writeFileSync } from "node:fs";
import { COMPONENTS } from "./components.mjs";

// The redesign spec is the source of truth for the companion. Every candidate
// primitive is rendered from the spec's own CSS, in both themes.
const SPEC_URL =
  "https://0d5784a7a43451f4ad70dd3d9ee5cf72.boxes.mantaui.com/pages/manta-redesign";

const v = process.argv.indexOf("--source");
const sourceUrl =
  v !== -1
    ? process.argv[v + 1]
    : process.argv.find((a) => a.startsWith("--source="))?.slice("--source=".length) ??
      SPEC_URL;

// Fetch the spec. A non-200 or a network failure fails loudly with the URL and
// exits 1 — a silently stale companion is worse than none. We deliberately do
// NOT fall back to a cached copy.
let res;
try {
  res = await fetch(sourceUrl);
} catch (err) {
  console.error(`companion: failed to fetch spec ${sourceUrl}: ${err.message}`);
  process.exit(1);
}
if (!res.ok) {
  console.error(`companion: failed to fetch spec ${sourceUrl} — HTTP ${res.status}`);
  process.exit(1);
}
const src = await res.text();

const css = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
const sprite = src.match(/<svg[^>]*(?:style="display:none"|hidden|aria-hidden="true")[^>]*>[\s\S]*?<\/svg>/)?.[0] ?? "";

const count = (cls) =>
  (src.match(new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"`, "g")) || []).length;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const themePanel = (c, theme) => `
  <div class="tp" data-theme="${theme}" data-density="comfortable">
    <div class="tlabel">${theme}${theme === "light" ? " — the theme the visual gate captures" : ""}</div>
    <div class="vs${c.full ? " one" : ""}">
      ${c.variants.map(([n, html]) => `<div class="v"><div class="vn">${esc(n)}</div><div class="demo">${c.wrap ? c.wrap(html) : html}</div></div>`).join("")}
    </div>
  </div>`;

const page = `<!doctype html><html data-theme="light"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MantaUI — component companion (from the redesign spec)</title>
<style>${css}</style>
<style>
  body{margin:0;background:var(--canvas);color:var(--tx1);font-family:var(--font-sans)}
  .cwrap{max-width:1400px;margin:0 auto;padding:28px 22px 90px}
  .chead h1{font-size:24px;margin:0 0 4px;letter-spacing:-.02em}
  .chead p{color:var(--tx3);margin:0 0 18px;max-width:76ch;font-size:14px;line-height:1.6}
  .comp{border:1px solid var(--border-subtle);border-radius:var(--r-lg);margin:0 0 22px;background:var(--panel);overflow:hidden}
  .comp>header{display:flex;align-items:baseline;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border-subtle);flex-wrap:wrap}
  .comp h3{margin:0;font-size:15px}
  .cnt{font:500 11px/1 var(--font-mono);color:var(--tx4)}
  .appst{margin-left:auto;font-size:11.5px;color:var(--tx3)}
  .appst.none{color:var(--warn)} .appst.priv{color:var(--accent-tx)}
  .cnote{padding:10px 16px;border-bottom:1px solid var(--border-subtle);font-size:12.5px;line-height:1.6;color:var(--tx2);background:var(--raised)}
  .cnote code{font-family:var(--font-mono);font-size:11.5px;color:var(--accent-tx)}
  .themes{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border-subtle)}
  .tp{background:var(--canvas);color:var(--tx1);padding:0 0 4px}
  .tlabel{font:500 10.5px/1 var(--font-mono);text-transform:uppercase;letter-spacing:.09em;color:var(--tx4);padding:10px 14px 4px}
  .vs{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
  .vs.one{grid-template-columns:1fr 1fr}
  .vs.one .demo{display:block}
  .v{padding:12px 14px 16px}
  .vn{font:500 10px/1 var(--font-mono);color:var(--tx4);text-transform:uppercase;letter-spacing:.07em;margin-bottom:11px}
  .demo{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:38px}
  details{border-top:1px solid var(--border-subtle);background:var(--panel)}
  summary{cursor:pointer;padding:9px 16px;font:500 11.5px/1 var(--font-sans);color:var(--tx3)}
  pre{margin:0;padding:0 16px 14px;overflow:auto;font:11.5px/1.6 var(--font-mono);color:var(--tx3)}
  .note{border:1px solid var(--border);border-radius:var(--r-md);padding:12px 14px;margin:0 0 22px;font-size:13px;color:var(--tx2);line-height:1.6}
  .note b{color:var(--tx1)} .note code{font-family:var(--font-mono);font-size:12px;color:var(--accent-tx)}
  @media(max-width:980px){.themes{grid-template-columns:1fr}}
</style></head><body>
${sprite}
<div class="cwrap">
<div class="chead">
  <h1>Component companion</h1>
  <p>Every candidate primitive from the redesign spec, rendered with the spec's own CSS, in <b>both themes side by side</b>. Each card shows how often the pattern appears in the spec and what exists in the app today.</p>
</div>
<div class="note">
  <b>Token audit — the spec and <code>src/renderer/tokens.css</code> agree.</b> Dark 29/29 identical, light 29/32, root 18/21 (those 3 are whitespace and font-stack fallbacks). The spec defines <b>no token the app lacks</b>. The one real divergence is the shadow scale: <code>--shadow-sm/md/lg</code> differ in both themes — light <code>--shadow-md</code> is <code>0 4px 12px</code> plus a second layer in the app vs <code>0 8px 24px</code> single-layer in the spec. A design decision, not drift to fix silently.
</div>
${COMPONENTS.map((c) => `
<div class="comp" id="${c.id}">
  <header>
    <h3>${c.name}</h3>
    <span class="cnt">.${c.cls} × ${count(c.cls)} in spec</span>
    <span class="appst ${c.app.startsWith("none") ? "none" : "priv"}">app: ${esc(c.app)}</span>
  </header>
  ${c.note ? `<div class="cnote">${c.note}</div>` : ""}
  <div class="themes">${themePanel(c, "light")}${themePanel(c, "dark")}</div>
  <details><summary>markup</summary><pre>${c.variants.map(([n, html]) => `/* ${n} */
${esc(html)}`).join("\n\n")}</pre></details>
</div>`).join("")}
</div></body></html>`;

mkdirSync(".visual-out", { recursive: true });
writeFileSync(".visual-out/companion.html", page);
console.log("wrote .visual-out/companion.html", (page.length / 1024).toFixed(0), "KB");
console.log("counts:", COMPONENTS.map((c) => `${c.cls}=${count(c.cls)}`).join(" "));
