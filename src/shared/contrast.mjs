// Contrast gate (BET-410). Pure WCAG luminance + ratio helpers plus a
// `checkContrast(theme)` that reads the live CSS custom properties out of
// `src/renderer/tokens.css` and fails any (foreground, background) pair that
// drops below its minimum. The test `contrast.test.ts` asserts zero failures
// for both themes — that test IS the CI gate (the repo runs one self-hosted
// runner, so no separate workflow job).
//
// Reading the values straight from tokens.css (rather than redeclaring the
// palette here) is what makes the test a real gate: retuning a token in the
// CSS without re-verifying contrast turns the test red. A second copy of the
// palette in JS would silently drift.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// tokens.css is THE token substrate — the same file the app @imports and
// every design mockup <link>s. Pointing the gate at it (rather than at
// index.css, which now only holds component rules) keeps "retune a token"
// and "re-verify contrast" the same action.
const CSS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "renderer",
  "tokens.css",
);

/** Parse a #RRGGBB or #RRGGBBAA hex string into [r, g, b] (0–255). */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex);
  if (!m) throw new Error(`not a 6/8-digit hex: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG 2.x relative luminance of a #RRGGBB hex (0–1). */
export function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two #RRGGBB hexes (1–21, always ≥ 1). */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// Every (foreground, background, minimum) triple the gate enforces, per
// theme. Token NAMES — resolved against the parsed CSS vars at check time.
//   - 4.5:1 → WCAG 1.4.3 AA for text (tx1/tx2/tx3, accent-tx, on-accent, and
//     the ok/warn/danger/info status colours used as foreground text).
//   - 3:1   → WCAG 1.4.11 for control boundaries (border-strong) and the
//     single decorative tier (tx4).
export const TOKEN_PAIRS = [
  // Readable text tiers on every surface a user reads against.
  ...["tx1", "tx2", "tx3"].flatMap((fg) =>
    ["canvas", "panel", "card", "raised"].map((bg) => ({ fg, bg, min: 4.5 })),
  ),
  // Accent-coloured text (links, accent labels).
  { fg: "accent-tx", bg: "canvas", min: 4.5 },
  { fg: "accent-tx", bg: "panel", min: 4.5 },
  // Text sitting on a filled accent button.
  { fg: "on-accent", bg: "accent-solid", min: 4.5 },
  // Status colours used as foreground text on the two flat surfaces.
  ...["ok", "warn", "danger", "info"].flatMap((fg) =>
    ["canvas", "panel"].map((bg) => ({ fg, bg, min: 4.5 })),
  ),
  // Control-boundary borders (WCAG 1.4.11).
  { fg: "border-strong", bg: "canvas", min: 3 },
  { fg: "border-strong", bg: "panel", min: 3 },
  { fg: "border-strong", bg: "card", min: 3 },
  // Decorative tier — the only sub-AA text, must still clear 3:1.
  { fg: "tx4", bg: "canvas", min: 3 },
];

/** Strip /* … *​/ comments from a CSS snippet. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Extract the `--token: #hex;` vars from a `[data-theme="<theme>"]` block. */
export function parseThemeVars(theme, css = readFileSync(CSS_PATH, "utf8")) {
  const clean = stripComments(css);
  const re = new RegExp(
    `\\[data-theme=["']${theme}["']\\]\\s*\\{([^}]*)\\}`,
  );
  const m = re.exec(clean);
  if (!m) throw new Error(`theme "${theme}" block not found in ${CSS_PATH}`);
  const vars = {};
  for (const decl of m[1].split(";")) {
    const d = decl.match(/^\s*--([\w-]+)\s*:\s*(#?[0-9a-fA-F]+)\s*$/);
    if (d) vars[d[1]] = d[2].startsWith("#") ? d[2] : `#${d[2]}`;
  }
  return vars;
}

/**
 * Check every TOKEN_PAIR against the given theme. Returns an array of
 * failure objects (empty = pass). Each failure carries the pair, the
 * resolved hexes, the measured ratio, and the minimum that was missed.
 */
export function checkContrast(theme, vars = parseThemeVars(theme)) {
  const failures = [];
  for (const p of TOKEN_PAIRS) {
    const fgHex = vars[p.fg];
    const bgHex = vars[p.bg];
    if (!fgHex || !bgHex) {
      failures.push({ ...p, reason: "missing-token", fgHex, bgHex });
      continue;
    }
    const ratio = contrastRatio(fgHex, bgHex);
    if (ratio + 1e-9 < p.min) {
      failures.push({ ...p, fgHex, bgHex, ratio: round(ratio) });
    }
  }
  return failures;
}

function round(n) {
  return Math.round(n * 100) / 100;
}
