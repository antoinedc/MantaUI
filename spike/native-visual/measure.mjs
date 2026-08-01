#!/usr/bin/env node
/**
 * spike/native-visual/measure.mjs — the measurement layer of the native
 * visual-verification PoC (BET-454, the crux).
 *
 * Produces ONE JSON report with three sections per element:
 *   - spec        — measured from the mockup in the browser (computed styles +
 *                   bounding boxes), at a 402×874 viewport so CSS px == AX pt.
 *   - app         — parsed from the iOS accessibility hierarchy capture
 *                   (spike/native-visual/out/session-list-hierarchy.txt).
 *   - delta       — per property: `match` | `mismatch` (both values) |
 *                   `unavailable` (with a reason).
 *
 * The PURPOSE is finding out which properties a native render yields at all.
 * An `unavailable` here is the successful outcome for that property — it is
 * recorded, never inferred and never substituted with the spec's value.
 *
 * Reuse, never re-implement: browser launch options, the animation-disabling
 * CSS, the static file server and the page-preparation helper all come from
 * scripts/visual/harness.mjs (the same renderer the web process captures
 * against — a measurement is only comparable against another measurement from
 * the same renderer).
 *
 * Usage:
 *   node spike/native-visual/measure.mjs            # WRITE out/report.json
 *   MEASURE_OUT_DIR=/tmp node spike/native-visual/measure.mjs
 *   MEASURE_TOLERANCE=0.5 node spike/native-visual/measure.mjs
 *
 * Exit codes: 0 = report written; 1 = a measurement/parse step failed.
 */

import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LAUNCH_OPTIONS,
  ROOT,
  preparePage,
  startStaticServer,
} from "../../scripts/visual/harness.mjs";

// Coordinate contract: the AX capture is a 402×874 pt window whose origin is
// the top-left of the simulator screen INCLUDING the iOS status region. The
// mockup reserves that same origin via window-chrome bands, so we drive the
// browser at 402×874 CSS px, deviceScaleFactor 1 (so px == pt exactly).
const VIEWPORT = { width: 402, height: 874, deviceScaleFactor: 1 };

// Geometry delta is a "match" only within this px tolerance. 1px is above the
// sub-pixel noise of a cross-renderer layout but far below an injected defect
// (PoC 04), so it neither hides real deviance nor flags AA round-off.
const TOLERANCE = parseFloat(process.env.MEASURE_TOLERANCE ?? "1.0");

const MOCKUP_URL_PATH = "/spike/native-visual/mockup/session-list.html";
const HIER_PATH = join(ROOT, "spike/native-visual/out/session-list-hierarchy.txt");
const OUT_DIR = process.env.MEASURE_OUT_DIR
  ? process.env.MEASURE_OUT_DIR
  : join(ROOT, "spike/native-visual/out");
const REPORT_PATH = join(OUT_DIR, "report.json");

// Why a property is `unavailable` from the native side. This is the crux
// finding: the accessibility hierarchy reports geometry only.
const REASON = {
  fontSize:
    "accessibility hierarchy reports element geometry only; no font-size attribute",
  fontWeight:
    "accessibility hierarchy reports element geometry only; no type/weight attribute",
  textColour:
    "accessibility hierarchy reports element geometry only; no colour attribute",
  backgroundColor:
    "accessibility hierarchy reports element geometry only; no fill/background colour attribute",
  cornerRadius:
    "accessibility frame is an axis-aligned rectangle; no corner-radius attribute",
  dotAbsent:
    "the 8pt status Circle is not exposed as an accessibility element, so the dot and its colour are not measurable from the native side",
  circleAbsent:
    "the 40pt accentSolid Circle and its plus glyph's button box are not exposed as their own element; AX exposes only the plus glyph, so the button box geometry and its colour/radius are not measurable from native",
};

function classifyDelta(spec, app, { tolerance = TOLERANCE, kind = "number" } = {}) {
  // `unavailable` is the primary honest outcome — the native side could not
  // supply the property. Never infer, never substitute the spec's value.
  if (app === null || app === undefined) {
    return { delta: "unavailable", spec, app: null };
  }
  if (spec === null || spec === undefined) {
    return { delta: "n/a", spec: null, app };
  }
  if (kind === "number") {
    const s = parseFloat(spec);
    const a = parseFloat(app);
    const match = Number.isFinite(s) && Number.isFinite(a) && Math.abs(s - a) <= tolerance;
    return { delta: match ? "match" : "mismatch", spec, app };
  }
  if (kind === "point") {
    const { x: sx, y: sy } = spec;
    const { x: ax, y: ay } = app;
    const match = Math.abs(sx - ax) <= tolerance && Math.abs(sy - ay) <= tolerance;
    return { delta: match ? "match" : "mismatch", spec, app };
  }
  if (kind === "size") {
    const { width: sw, height: sh } = spec;
    const { width: aw, height: ah } = app;
    const match =
      Math.abs(sw - aw) <= tolerance && Math.abs(sh - ah) <= tolerance;
    return { delta: match ? "match" : "mismatch", spec, app };
  }
  if (kind === "color") {
    const match = String(spec) === String(app);
    return { delta: match ? "match" : "mismatch", spec, app };
  }
  return { delta: "n/a", spec, app };
}

// Parse the redacted AX dump. Every line that carries a frame + a label or
// identifier becomes an app element with its geometry. Container "Other" nodes
// (frame-only) are skipped; only labelled leaves are matched to spec elements.
function parseHierarchy(text) {
  const els = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*→?\s*/, "").trim();
    if (!line) continue;
    if (
      /^(Element subtree:|Attributes:|Path to element:|Query chain:|→Application|Application,)/.test(
        line,
      )
    ) {
      continue;
    }
    const m = line.match(
      /^([A-Za-z][A-Za-z ()]*?),\s*0xADDR,\s*\{\{([-\d.]+),\s*([-\d.]+)\},\s*\{([-\d.]+),\s*([-\d.]+)\}\}(.*)$/,
    );
    if (!m) continue;
    const [, type, x, y, w, h, rest] = m;
    const identifier = (rest.match(/identifier:\s*'([^']*)'/) || [])[1];
    const label = (rest.match(/label:\s*'([^']*)'/) || [])[1];
    els.push({
      type: type.trim(),
      frame: {
        x: parseFloat(x),
        y: parseFloat(y),
        w: parseFloat(w),
        h: parseFloat(h),
      },
      ...(label !== undefined ? { label } : {}),
      ...(identifier !== undefined ? { identifier } : {}),
    });
  }
  return els;
}

// Which of the eight properties apply to an element kind (text vs box) and
// which the native can measure. Availability of typography/colour/radius is the
// finding; it is expressed here as null app sources (unavailable), never
// guessed.
function propertyMatrix(role) {
  switch (role) {
    case "group-header":
    case "row-name":
    case "row-subtitle":
    case "row-timer":
    case "search-text":
      return ["position", "size", "fontSize", "fontWeight", "textColour", "spacingToNext"];
    case "row":
    case "searchbar":
      return ["position", "size", "backgroundColor", "cornerRadius", "spacingToNext"];
    case "row-dot":
      return ["position", "size", "backgroundColor"];
    case "search-icon":
      return ["position", "size"];
    case "search-plus":
      return ["position", "size", "backgroundColor", "cornerRadius"];
    case "search-plus-glyph":
      return ["position", "size"];
    default:
      return [];
  }
}

// -- spec measurement --------------------------------------------------------

// The AX capture reports a text element's CONTENT box (the line box), not the
// padded/stretched layout box the DOM exposes via getBoundingClientRect. To
// compare like-with-like, text roles are measured with a Range over their text
// (the rendered text box); box roles stay on their border box.
const TEXT_ROLES = new Set([
  "group-header",
  "row-name",
  "row-subtitle",
  "row-timer",
  "search-text",
]);

async function measureSpec(page) {
  return page.evaluate(() => {
    const TEXT_ROLES = new Set([
      "group-header",
      "row-name",
      "row-subtitle",
      "row-timer",
      "search-text",
    ]);
    const RGB_TO_KEY = (s) => {
      const m = /rgba?\(([^)]+)\)/.exec(s);
      if (!m) return s;
      const parts = m[1].split(",").map((x) => x.trim());
      const alpha = parts[3] !== undefined && parseFloat(parts[3]) === 0;
      if (alpha) return "transparent";
      return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
    };
    const WEIGHT_TO_NUM = (w) => {
      if (w === "normal") return 400;
      if (w === "bold") return 700;
      return parseFloat(w);
    };
    // Resolve a border-top-left-radius that may be a percentage to px.
    const RADIUS_PX = (cs, el) => {
      const v = cs.borderTopLeftRadius;
      if (v.endsWith("%")) {
        const pct = parseFloat(v);
        return Math.min(el.clientWidth, el.clientHeight) * (pct / 100);
      }
      return parseFloat(v) || 0;
    };
    // The rendered line box of the element's text (matches how AX reports it).
    const TEXT_BOX = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      const base = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return base;
      const nodeRect = r;
      return {
        x: nodeRect.x,
        y: nodeRect.y,
        width: nodeRect.width,
        height: nodeRect.height,
      };
    };
    const round1 = (n) => Math.round(n * 10) / 10;
    const out = [];
    for (const el of document.querySelectorAll("[data-role]")) {
      const role = el.dataset.role;
      const useTextBox = TEXT_ROLES.has(role);
      const r = useTextBox
        ? TEXT_BOX(el)
        : el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      out.push({
        role,
        label: el.dataset.label ?? "",
        text: (el.textContent ?? "").trim(),
        position: { x: round1(r.x), y: round1(r.y) },
        size: { width: round1(r.width), height: round1(r.height) },
        fontSize: parseFloat(cs.fontSize),
        fontWeight: WEIGHT_TO_NUM(cs.fontWeight),
        textColour: RGB_TO_KEY(cs.color),
        backgroundColor: RGB_TO_KEY(cs.backgroundColor),
        cornerRadius: round1(RADIUS_PX(cs, el)),
      });
    }
    return out;
  });
}

// The vertical list flow: group headers and rows in layout (y) order. This is
// the chain along which "spacing to the next element" is measured.
function listFlow(specEls) {
  return specEls
    .filter((e) => e.role === "group-header" || e.role === "row")
    .slice()
    .sort((a, b) => a.position.y - b.position.y);
}

function main_report({ specEls, parsed }) {
  const appStatic = parsed.filter((e) => e.type === "StaticText");
  const appButtons = parsed.filter((e) => e.type === "Button");
  const appImages = parsed.filter((e) => e.type === "Image");
  const specByKey = new Map(specEls.map((e) => [`${e.role}:${e.label}`, e]));

  const findApp = (role, label) => {
    switch (role) {
      case "group-header":
      case "row-name":
      case "row-subtitle":
      case "row-timer":
        return appStatic.find((s) => s.label === label) ?? null;
      case "row":
        return appButtons.find((b) => b.label && b.label.startsWith(label)) ?? null;
      case "search-text":
        return appStatic.find((s) => s.label === "Search") ?? null;
      case "search-icon":
        return appImages.find((s) => s.identifier === "magnifyingglass") ?? null;
      case "search-plus":
        // The 40pt accentSolid Circle itself is a non-accessible shape — AX
        // exposes only its plus glyph (handled by search-plus-glyph) — so the
        // circle has no app frame of its own.
        return null;
      case "search-plus-glyph":
        return appImages.find((s) => s.identifier === "plus") ?? null;
      default:
        return null; // row-dot — not exposed by SwiftUI's AX tree
    }
  };

  // -- spacing: native derives it from frames; hier frames are content bounds. --
  const flow = listFlow(specEls);
  const spacingSpec = {}; // key role:label -> px gap to next flow element
  for (let i = 0; i < flow.length - 1; i++) {
    const cur = flow[i];
    const next = flow[i + 1];
    spacingSpec[`${cur.role}:${cur.label}`] =
      Math.round((next.position.y - (cur.position.y + cur.size.height)) * 10) / 10;
  }
  // row-name -> row-subtitle within each row (where a subtitle exists).
  const nameSpacingSpec = {};
  for (const sub of specEls.filter((e) => e.role === "row-subtitle")) {
    const name = specByKey.get(`row-name:${sub.label}`);
    if (name) {
      nameSpacingSpec[sub.label] =
        Math.round((sub.position.y - (name.position.y + name.size.height)) * 10) / 10;
    }
  }

  // App-side spacing uses the matched app frames, in the SAME flow order.
  const appSpacing = {}; // role:label -> px gap
  for (let i = 0; i < flow.length - 1; i++) {
    const cur = flow[i];
    const next = flow[i + 1];
    const curApp = findApp(cur.role, cur.label);
    const nextApp = findApp(next.role, next.label);
    if (curApp && nextApp) {
      appSpacing[`${cur.role}:${cur.label}`] =
        Math.round((nextApp.frame.y - (curApp.frame.y + curApp.frame.h)) * 10) / 10;
    }
  }
  // app name->subtitle gap. A row's subtitle is the spec element with the same
  // data-label (session name) but its RENDERED text is the subtitle string, and
  // the app StaticText is labelled by that rendered string.
  const appNameSpacing = {};
  for (const d of specEls.filter((e) => e.role === "row-name")) {
    const sub = specEls.find(
      (e) => e.role === "row-subtitle" && e.label === d.label,
    );
    const nameApp = findApp("row-name", d.label);
    const subApp = sub ? appStatic.find((s) => s.label === sub.text) : null;
    if (nameApp && subApp) {
      appNameSpacing[d.label] =
        Math.round((subApp.frame.y - (nameApp.frame.y + nameApp.frame.h)) * 10) / 10;
    }
  }

  const elements = [];
  for (const spec of specEls) {
    const role = spec.role;
    const label = spec.label;
    const props = {};
    // Subtitle and timer AX elements are labelled by their RENDERED text
    // (e.g. 'running - opus 4.8', '1m'), not by the row/session data-label.
    const matchKey =
      role === "row-subtitle" || role === "row-timer" ? spec.text : label;
    const app = findApp(role, matchKey);
    const frame = app?.frame ?? null;

    const put = (key, specVal, appVal, kind, reason) => {
      if (appVal === null && reason) {
        props[key] = { delta: "unavailable", spec: specVal, app: null, reason };
        return;
      }
      const cls = classifyDelta(specVal, appVal, { kind });
      props[key] = { delta: cls.delta, spec: cls.spec, app: cls.app };
    };

    const appPos = frame ? { x: frame.x, y: frame.y } : null;
    const appSize = frame ? { width: frame.w, height: frame.h } : null;
    // Shapes SwiftUI does not expose to the AX tree: the status dot and the
    // 40pt accentSolid circle carry no app frame, so their box/colour are
    // unavailable from native (the only thing reported is their glyph/child).
    const notExposedReason =
      role === "row-dot"
        ? REASON.dotAbsent
        : role === "search-plus"
          ? REASON.circleAbsent
          : null;

    for (const key of propertyMatrix(role)) {
      switch (key) {
        case "position":
          put(key, spec.position, appPos, "point", notExposedReason);
          break;
        case "size":
          put(key, spec.size, appSize, "size", notExposedReason);
          break;
        case "fontSize":
          put(key, spec.fontSize, null, "number", REASON.fontSize);
          break;
        case "fontWeight":
          put(key, spec.fontWeight, null, "number", REASON.fontWeight);
          break;
        case "textColour":
          put(key, spec.textColour, null, "color", REASON.textColour);
          break;
        case "backgroundColor":
          put(
            key,
            spec.backgroundColor,
            null,
            "color",
            notExposedReason ?? REASON.backgroundColor,
          );
          break;
        case "cornerRadius":
          put(
            key,
            spec.cornerRadius,
            null,
            "number",
            notExposedReason ?? REASON.cornerRadius,
          );
          break;
        case "spacingToNext": {
          const keyId = `${role}:${label}`;
          if (role === "group-header" || role === "row") {
            if (spacingSpec[keyId] !== undefined) {
              put(key, spacingSpec[keyId], appSpacing[keyId], "number");
            } else {
              props[key] = {
                delta: "n/a",
                spec: null,
                app: null,
                reason: "no following element in the vertical list flow (last item)",
              };
            }
          } else if (role === "row-name") {
            if (nameSpacingSpec[label] !== undefined) {
              put(key, nameSpacingSpec[label], appNameSpacing[label], "number");
            } else {
              props[key] = {
                delta: "n/a",
                spec: null,
                app: null,
                reason: "row has no subtitle, so there is no name→subtitle gap",
              };
            }
          }
          break;
        }
        default:
          break;
      }
    }

    elements.push({ id: `${role}-${label}`, role, label, properties: props });
  }

  // summary: per-property counts across elements.
  const summary = {};
  for (const el of elements) {
    for (const [k, v] of Object.entries(el.properties)) {
      summary[k] = summary[k] || { match: 0, mismatch: 0, unavailable: 0, n_a: 0 };
      summary[k][v.delta === "n/a" ? "n_a" : v.delta]++;
    }
  }

  return { elements, summary };
}

// -- main --------------------------------------------------------------------

async function main() {
  if (!existsSync(HIER_PATH)) {
    throw new Error(
      `missing app capture ${HIER_PATH} — the iOS capture must run first (macos agent)`,
    );
  }
  const hierText = readFileSync(HIER_PATH, "utf8");
  const parsed = parseHierarchy(hierText);
  if (parsed.filter((e) => e.type === "StaticText").length === 0) {
    throw new Error(`no StaticText elements parsed from ${HIER_PATH} — format changed?`);
  }

  const { server, baseURL } = await startStaticServer({ "/": ROOT });
  let specEls;
  try {
    const browser = await chromium.launch(LAUNCH_OPTIONS);
    try {
      const ctx = await browser.newContext({
        viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
        deviceScaleFactor: VIEWPORT.deviceScaleFactor,
        reducedMotion: "reduce",
        colorScheme: "light",
      });
      const page = await ctx.newPage();
      await preparePage(page, {
        url: `${baseURL}${MOCKUP_URL_PATH}`,
        readySelector: "[data-screen]",
      });
      specEls = await measureSpec(page);
    } finally {
      await browser.close();
    }
  } finally {
    server.close();
  }

  const { elements, summary } = main_report({ specEls, parsed });

  const report = {
    report: "PoC 03 — native visual-verification measurement",
    coordinateContract: {
      viewport: `${VIEWPORT.width}x${VIEWPORT.height} CSS px = simulator pt`,
      deviceScaleFactor: VIEWPORT.deviceScaleFactor,
      note: "mockup origin == AX capture origin (window-chrome bands reproduce the iOS status/nav + home-indicator insets); geometry compared in px==pt",
      deltaTolerancePx: TOLERANCE,
      themeAssumed:
        "light (iOS default); reported colours come from the shared tokens, and app colour is unavailable regardless of theme",
    },
    sources: {
      spec: "spike/native-visual/mockup/session-list.html (Playwright Chromium, computed styles + bounding boxes)",
      app: "spike/native-visual/out/session-list-hierarchy.txt (iOS accessibility hierarchy, XCUITest debugDescription)",
    },
    elements,
    summary,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(`wrote ${REPORT_PATH}\n`);
}

main().catch((e) => {
  process.stderr.write(`[measure.mjs] FAILED: ${e?.stack ?? e}\n`);
  process.exit(1);
});
