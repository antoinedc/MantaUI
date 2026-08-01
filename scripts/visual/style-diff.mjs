#!/usr/bin/env node
/**
 * scripts/visual/style-diff.mjs — app-vs-mockup COMPUTED-STYLE diff in token
 * names (layer 4 of the visual toolchain).
 *
 * compare.mjs writes two PNGs that a text-only agent cannot read; this script
 * is the conformance judgement rendered as text a model can act on. It captures
 * the app and its mockup under the exact same conditions as compare.mjs (same
 * viewport, deviceScaleFactor, reducedMotion, colorScheme, same harness), reads
 * back the COMPUTED STYLES of every tracked element inside the region, resolves
 * each value through the design-token reverse-map built from
 * src/renderer/tokens.css, and reports the deltas in TOKEN NAMES.
 *
 * Why token names and not pixel values: the two blocking layers are blind to a
 * misapplied token. The accessibility tree sees elements, order and labels; the
 * pixel baseline diffs the app against itself and was recorded from whatever
 * render (right or wrong) was current when it was baselined. Neither sees
 * "the design says --border-strong, the app uses --border". This tool's job is
 * to surface exactly that.
 *
 * Output: .visual-out/<id>.styles.md (already gitignored — the report is the
 * deliverable of this PoC, NOT a committed artifact).
 *
 * Usage:
 *   npm run visual:styles                    # every screen with a mockup
 *   node scripts/visual/style-diff.mjs session-header settings-general
 *
 * Exit codes: 0 = reports written; 1 = a capture or report failed.
 *
 * This is a PoC (BET-523) — deliberately no product-code change, no width
 * normalisation (the width confound is REPORTED, not corrected), no decision
 * about which side is right (the mockup is the design; the redo issue acts).
 */

import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LAUNCH_OPTIONS,
  RENDERER_DIR,
  ROOT,
  preparePage,
  startStaticServer,
} from "./harness.mjs";
import { SCREENS, getScreen } from "./screens.mjs";

const OUT_DIR = join(ROOT, ".visual-out");
const TOKENS_CSS = join(ROOT, "src/renderer/tokens.css");

/**
 * The property list — explicit, not "spacing and a few things". Exactly these
 * properties are extracted on every examined element, and no others.
 */
const PROPERTIES = [
  "color",
  "background-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-radius",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "gap",
  "row-gap",
  "column-gap",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "box-shadow",
  "opacity",
];

/** Group a property for Section A's per-group token counts. */
const GROUP_OF = {
  color: "color",
  "background-color": "background-color",
  "border-top-color": "border-*-color",
  "border-right-color": "border-*-color",
  "border-bottom-color": "border-*-color",
  "border-left-color": "border-*-color",
  "border-top-width": "border-*-width",
  "border-right-width": "border-*-width",
  "border-bottom-width": "border-*-width",
  "border-left-width": "border-*-width",
  "border-radius": "border-radius",
  "padding-top": "padding-*",
  "padding-right": "padding-*",
  "padding-bottom": "padding-*",
  "padding-left": "padding-*",
  gap: "gap",
  "row-gap": "gap",
  "column-gap": "gap",
  "font-family": "font-*",
  "font-size": "font-*",
  "font-weight": "font-*",
  "line-height": "font-*",
  "letter-spacing": "font-*",
  "box-shadow": "box-shadow",
  opacity: "opacity",
};

/**
 * Which token family is the AUTHORITATIVE match for each property's value
 * type, used to disambiguate spacing/radius collisions (BET-530).
 *
 * `border-radius` takes radius tokens (`--r-*`); `padding-*`/`gap` take
 * spacing tokens (`--sp-*`). Every OTHER property takes neither — a
 * `--sp-*`/`--r-*` token matching it is a category error, not a close call
 * (a 12px font-size is not a `--sp-3|--r-lg` collision). This is ground
 * truth from the CSS property, not a token-name heuristic.
 *
 * A property whose type matches no token family (e.g. font-size, font-weight,
 * opacity, z-index, line-height) therefore renders as NO match, never as a
 * bucket and never by falling back to the both-families behaviour.
 */
const FAMILY_PREFIX = {
  "border-radius": "r-",
  "padding-top": "sp-",
  "padding-right": "sp-",
  "padding-bottom": "sp-",
  "padding-left": "sp-",
  gap: "sp-",
  "row-gap": "sp-",
  "column-gap": "sp-",
};

/**
 * Properties whose value type maps to NO token family at all — a font size
 * is not a spacing, radius, or border token. A resolved token matching one
 * of these is a category error, so per the BET-530 constraint they render as
 * NO match (never a bucket, never a fall-through to another family).
 * `z-index` is in the issue but isn't one of the tracked PROPERTIES.
 */
const NO_FAMILY_PROPERTIES = new Set([
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "opacity",
]);

/**
 * The browser-default sentinel per property. A property is SKIPPED when BOTH
 * sides sit at the default (otherwise the report is thousands of lines of
 * transparent/0px/normal noise). `null` = never default-skippable (inherited
 * values like color and font-* are meaningful wherever they appear).
 */
const DEFAULTS = {
  color: null,
  "background-color": "rgba(0, 0, 0, 0)",
  "border-top-color": "rgba(0, 0, 0, 0)",
  "border-right-color": "rgba(0, 0, 0, 0)",
  "border-bottom-color": "rgba(0, 0, 0, 0)",
  "border-left-color": "rgba(0, 0, 0, 0)",
  "border-top-width": "0px",
  "border-right-width": "0px",
  "border-bottom-width": "0px",
  "border-left-width": "0px",
  "border-radius": "0px",
  "padding-top": "0px",
  "padding-right": "0px",
  "padding-bottom": "0px",
  "padding-left": "0px",
  gap: "normal",
  "row-gap": "normal",
  "column-gap": "normal",
  "font-family": null,
  "font-size": null,
  "font-weight": null,
  "line-height": "normal",
  "letter-spacing": "normal",
  "box-shadow": "none",
  opacity: "1",
};

function log(msg) {
  process.stdout.write(`[visual:styles] ${msg}\n`);
}

/* ------------------------------------------------------------------ *
 *  Colour normalisation — getComputedStyle returns rgb(...) while
 *  tokens.css is hex; both are reduced to the same lowercase rgb() form
 *  before matching, or every colour looks like a mismatch.
 * ------------------------------------------------------------------ */

function fmtRgb(r, g, b, a) {
  r = Math.round(r);
  g = Math.round(g);
  b = Math.round(b);
  if (a == null || a >= 0.999) return `rgb(${r}, ${g}, ${b})`;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Normalise ANY colour spelling to one lowercase rgb()/rgba() string, or
 * `null` when it is not a colour we can parse.
 */
export function canonColor(s) {
  s = String(s).trim().replace(/\s+/g, " ");
  let m;
  if ((m = s.match(/^#([0-9a-f]{3,8})$/i))) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length === 6) h += "ff";
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = parseInt(h.slice(6, 8), 16) / 255;
    return fmtRgb(r, g, b, a);
  }
  const pct = (v) => (v.endsWith("%") ? (parseFloat(v) / 100) * 255 : +v);
  if (
    (m = s.match(
      /^rgba?\(\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*,\s*([\d.]+%?)(?:\s*,\s*([\d.]+))?\s*\)$/i,
    ))
  ) {
    const a = m[4] != null ? +m[4] : 1;
    return fmtRgb(pct(m[1]), pct(m[2]), pct(m[3]), a);
  }
  if (
    (m = s.match(
      /^rgba?\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+%?)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i,
    ))
  ) {
    let a = m[4] != null ? parseFloat(m[4]) : 1;
    if (m[4] != null && m[4].endsWith("%")) a /= 100;
    return fmtRgb(pct(m[1]), pct(m[2]), pct(m[3]), a);
  }
  return null;
}

function isColorLike(value) {
  return /^(#|rgba?\()/i.test(value.trim());
}

/* ------------------------------------------------------------------ *
 *  Token reverse-map — parse tokens.css once into value → token names.
 * ------------------------------------------------------------------ */

/**
 * Build `canonical-key → Set<tokenName>` from every `--name: value` in
 * tokens.css (both themes + :root). Keys are the raw value for lengths /
 * numbers (a computed "8px" matches "--sp-3: 8px" verbatim), and the
 * canonicalised colour for hex/rgb values.
 */
export function buildTokenMap(css) {
  const map = new Map();
  const add = (key, name) => {
    if (key == null || key === "") return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(name);
  };
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(css))) {
    const value = m[2].trim();
    add(value, m[1]);
    if (isColorLike(value)) add(canonColor(value), m[1]);
  }
  return map;
}

/**
 * Resolve a computed value through the map → array of token names, or
 * `null` for a raw literal with no matching token (`[no token]`).
 */
export function resolveToken(value, map) {
  const v = String(value).trim();
  if (map.has(v)) return [...map.get(v)];
  if (isColorLike(v)) {
    const c = canonColor(v);
    if (c && map.has(c)) return [...map.get(c)];
  }
  return null;
}

/* ------------------------------------------------------------------ *
 *  In-page extraction — walk a region, tagging each tracked element with
 *  its computed ARIA role and its ordinal within that role.
 * ------------------------------------------------------------------ */

/** Which border-*-width property gates each border-*-color property. */
const BORDER_WIDTH_OF_COLOR = {
  "border-top-color": "border-top-width",
  "border-right-color": "border-right-width",
  "border-bottom-color": "border-bottom-width",
  "border-left-color": "border-left-width",
};

function isDefault(prop, value) {
  const d = DEFAULTS[prop];
  if (d == null) return false;
  return value === d;
}

/**
 * A border-*-color is PHANTOM — CSS computes it to the element's own text
 * colour (currentColor) even when the border doesn't exist — unless that
 * side actually renders a border. Gate on the computed border-*-width being
 * `0px`: the width is the ground truth for whether a border exists, not the
 * colour spelling and not any token-name heuristic.
 */
function isPhantomBorderColor(prop, props) {
  const widthProp = BORDER_WIDTH_OF_COLOR[prop];
  if (!widthProp) return false;
  return props[widthProp] === "0px";
}

async function extractRegion(page, selector) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout: 30_000 });
  const box = await loc.boundingBox();
  const records = await loc.evaluate(
    (root, propList) => {
      // Resolve a tracked role (the pairing key + report label), else null.
      function roleOf(el) {
        const explicit = el.getAttribute && el.getAttribute("role");
        if (explicit) return explicit;
        const tag = el.tagName ? el.tagName.toLowerCase() : "";
        if (tag === "button") return "button";
        if (tag === "nav") return "nav";
        if (/^h[1-6]$/.test(tag)) return "heading";
        if (tag === "input" || tag === "textarea") return "textbox";
        if (tag === "ul" || tag === "ol") return "list";
        if (tag === "li") return "listitem";
        if (tag === "a") return "link";
        if (tag === "img") return "img";
        if (tag === "div" || tag === "span") {
          const cs = getComputedStyle(el);
          const hasBg = cs.backgroundColor !== "rgba(0, 0, 0, 0)";
          const hasBorder =
            parseFloat(cs.borderTopWidth) +
              parseFloat(cs.borderRightWidth) +
              parseFloat(cs.borderBottomWidth) +
              parseFloat(cs.borderLeftWidth) >
            0;
          if (hasBg || hasBorder) return "generic";
        }
        return null;
      }

      const out = [];
      const ordinals = Object.create(null);
      function walk(el) {
        const role = roleOf(el);
        if (role) {
          ordinals[role] = (ordinals[role] || 0) + 1;
          const cs = getComputedStyle(el);
          const props = {};
          for (const p of propList) props[p] = cs.getPropertyValue(p);
          out.push({ role, ordinal: ordinals[role], props });
        }
        for (const child of el.children) walk(child);
      }
      walk(root);
      return out;
    },
    PROPERTIES,
  );
  return { box, records };
}

async function captureSide(page, baseURL, { url, ready, final, actions, region }) {
  await preparePage(page, {
    url: `${baseURL}${url}`,
    readySelector: ready,
    finalSelector: final,
    actions,
  });
  return extractRegion(page, region);
}

/* ------------------------------------------------------------------ *
 *  Report rendering.
 * ------------------------------------------------------------------ */

/** `--border (rgb(51, 64, 107))` or `[no token] (rgb(...))`. */
function fmtValue(value, map) {
  const toks = resolveToken(value, map);
  return toks && toks.length
    ? `${toks.join("|")} (${value})`
    : `[no token] (${value})`;
}

/**
 * Filter a resolved token name-set down to the ones legitimately matching
 * `prop`'s value type (BET-530). A property with an explicit family
 * (FAMILY_PREFIX) keeps only that family's tokens; a property whose type
 * matches no token family (NO_FAMILY_PROPERTIES) keeps nothing (no match);
 * every other property is left unchanged. An empty result means "no match".
 */
export function matchFamilyTokens(prop, toks) {
  if (NO_FAMILY_PROPERTIES.has(prop)) return [];
  const prefix = FAMILY_PREFIX[prop];
  if (!prefix) return toks;
  return toks.filter((t) => t.startsWith(`--${prefix}`));
}

export function renderSectionA(appRecords, mockRecords, map) {
  const counts = new Map(); // group -> side -> token -> count
  const bump = (group, side, token) => {
    if (!counts.has(group)) counts.set(group, new Map());
    const bySide = counts.get(group);
    if (!bySide.has(side)) bySide.set(side, new Map());
    const byTok = bySide.get(side);
    byTok.set(token, (byTok.get(token) || 0) + 1);
  };
  for (const [side, records] of [
    ["app", appRecords],
    ["mockup", mockRecords],
  ]) {
    for (const rec of records) {
      for (const [prop, value] of Object.entries(rec.props)) {
        if (isDefault(prop, value)) continue;
        if (isPhantomBorderColor(prop, rec.props)) continue;
        const toks = resolveToken(value, map);
        if (!toks) continue;
        // Disambiguate spacing/radius collisions by property family (BET-530).
        // A token family that doesn't match the property's type is a category
        // error, not a candidate: drop it. If nothing legitimate remains, the
        // value is "no match" for this property — don't count it and don't
        // fall back to an honest-but-wrong cross-family bucket.
        const famToks = matchFamilyTokens(prop, toks);
        if (famToks.length === 0) continue;
        // A value that maps to several colliding tokens WITHIN its family is
        // ONE observation — count the candidate set as a single bucket
        // (`--sp-a|--sp-b`), not each token separately (which would multiply
        // one element into N).
        const bucket = famToks.length > 1 ? famToks.join("|") : famToks[0];
        bump(GROUP_OF[prop], side, bucket);
      }
    }
  }

  const lines = [];
  const GROUP_ORDER = [
    "color",
    "background-color",
    "border-*-color",
    "border-*-width",
    "border-radius",
    "padding-*",
    "gap",
    "font-*",
    "box-shadow",
    "opacity",
  ];
  for (const group of GROUP_ORDER) {
    const bySide = counts.get(group);
    const total = [
      ...(bySide?.get("app")?.values() ?? []),
      ...(bySide?.get("mockup")?.values() ?? []),
    ].reduce((a, b) => a + b, 0);
    if (!bySide || total === 0) continue;
    lines.push(group);
    for (const side of ["app", "mockup"]) {
      const toks = bySide.get(side);
      if (!toks || toks.size === 0) {
        lines.push(`  ${side}: (none)`);
        continue;
      }
      const parts = [...toks.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([t, c]) => `${t} ×${c}`);
      lines.push(`  ${side}: ${parts.join(", ")}`);
    }
  }
  return lines.length ? lines.join("\n") : "No token-mapped styling on either side.";
}

function renderSectionB(appRecords, mockRecords, map) {
  const lines = [];
  const key = (r) => `${r.role}#${r.ordinal}`;
  const appIdx = new Map(appRecords.map((r) => [key(r), r]));
  const mockIdx = new Map(mockRecords.map((r) => [key(r), r]));

  const matched = new Set();
  for (const rec of appRecords) {
    const other = mockIdx.get(key(rec));
    if (!other) continue;
    matched.add(key(rec));
    const deltas = [];
    for (const prop of PROPERTIES) {
      const av = rec.props[prop];
      const mv = other.props[prop];
      if (isDefault(prop, av) && isDefault(prop, mv)) continue;
      // Skip a border-colour delta when either side has no border on that
      // side: the border doesn't render, so the colour is phantom (a
      // borderless element still computes currentColor). The width delta —
      // when both widths differ — already reports the real structural gap.
      if (isPhantomBorderColor(prop, rec.props) || isPhantomBorderColor(prop, other.props)) continue;
      if (av !== mv) {
        deltas.push(
          `  ${prop.padEnd(20)} app ${fmtValue(av, map)}   mockup ${fmtValue(mv, map)}`,
        );
      }
    }
    if (deltas.length) {
      lines.push(`[${rec.ordinal}] ${rec.role}`);
      lines.push(...deltas);
    }
  }

  const appUnmatched = appRecords
    .filter((r) => !matched.has(key(r)))
    .map((r) => `[${r.ordinal}] ${r.role}`);
  const mockUnmatched = mockRecords
    .filter((r) => !appIdx.has(key(r)))
    .map((r) => `[${r.ordinal}] ${r.role}`);

  if (appUnmatched.length) {
    lines.push("");
    lines.push(`Unmatched (app only): ${appUnmatched.join(", ")}`);
  }
  if (mockUnmatched.length) {
    lines.push("");
    lines.push(`Unmatched (mockup only): ${mockUnmatched.join(", ")}`);
  }
  return lines.length ? lines.join("\n") : "No paired style deltas.";
}

function fmtBox(box) {
  if (!box) return "(no box)";
  return `${Math.round(box.width)}×${Math.round(box.height)} @ (${Math.round(
    box.x,
  )},${Math.round(box.y)})`;
}

function renderReport({ id, appRecords, mockRecords, appBox, mockBox, map }) {
  const sA = renderSectionA(appRecords, mockRecords, map);
  const sB = renderSectionB(appRecords, mockRecords, map);
  return [
    `# ${id} — computed-style diff (app vs mockup)`,
    ``,
    `## Geometry (read first)`,
    `app region ${fmtBox(appBox)} · mockup region ${fmtBox(mockBox)}`,
    `The region captures are systematically wider on the mockup side. LAYOUT-DEPENDENT VALUES (padding, insets, gaps, line-height) may differ for that reason alone. COLOUR, border-width, border-radius, font-weight and font-size are unaffected by the width difference.`,
    ``,
    `## Section A — token usage per property group`,
    sA,
    ``,
    `## Section B — paired element deltas`,
    sB,
    ``,
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 *  Main.
 * ------------------------------------------------------------------ */

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const screenIds = only.length
    ? only
    : SCREENS.filter((s) => s.mockup).map((s) => s.id);
  const screens = screenIds.map(getScreen);

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  if (!existsSync(join(RENDERER_DIR, "index.html"))) {
    throw new Error(
      `no built renderer at ${RENDERER_DIR} — run \`npm run build:mobile\` first`,
    );
  }

  const tokenMap = buildTokenMap(readFileSync(TOKENS_CSS, "utf8"));
  log(`reverse-map: ${tokenMap.size} canonical values → token names`);

  const { server, baseURL } = await startStaticServer({
    "/app": RENDERER_DIR,
    "/": ROOT,
  });
  const browser = await chromium.launch(LAUNCH_OPTIONS);
  try {
    for (const screen of screens) {
      log(`--- ${screen.id}: ${screen.title}`);
      if (!screen.mockup) continue;
      if (!existsSync(join(ROOT, screen.mockup))) {
        throw new Error(
          `screen "${screen.id}" points at a missing mockup: ${screen.mockup}`,
        );
      }

      const appCtx = await browser.newContext({
        viewport: screen.viewport,
        deviceScaleFactor: 2,
        reducedMotion: "reduce",
        colorScheme: "light",
      });
      const appPage = await appCtx.newPage();
      let app;
      try {
        await preparePage(appPage, {
          url: `${baseURL}${screen.url}`,
          readySelector: screen.ready,
          finalSelector: screen.final,
          actions: screen.actions,
        });
        app = await extractRegion(appPage, screen.region ?? "[data-screen]");
      } finally {
        await appCtx.close();
      }

      const mockCtx = await browser.newContext({
        viewport: screen.viewport,
        deviceScaleFactor: 2,
        reducedMotion: "reduce",
        colorScheme: "light",
      });
      const mockPage = await mockCtx.newPage();
      let mock;
      try {
        await preparePage(mockPage, {
          url: `${baseURL}/${screen.mockup}`,
          readySelector: "[data-screen]",
          actions: screen.mockupActions,
        });
        mock = await extractRegion(
          mockPage,
          screen.mockupRegion ?? screen.region ?? "[data-screen]",
        );
      } finally {
        await mockCtx.close();
      }

      log(
        `  app ${app.records.length} tracked elements · mockup ${mock.records.length}`,
      );
      const md = renderReport({
        id: screen.id,
        appRecords: app.records,
        mockRecords: mock.records,
        appBox: app.box,
        mockBox: mock.box,
        map: tokenMap,
      });
      const outPath = join(OUT_DIR, `${screen.id}.styles.md`);
      await writeFile(outPath, md);
      log(`  wrote → .visual-out/${screen.id}.styles.md`);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  main().catch((e) => {
    process.stderr.write(`[visual:styles] FAILED: ${e?.stack ?? e}\n`);
    process.exit(1);
  });
}
