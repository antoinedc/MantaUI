#!/usr/bin/env node
// scripts/gen-swift-tokens.mjs
// Reads src/renderer/tokens.css — the single source of truth for design
// tokens — and writes generated/swift/Theme.swift, the generated Swift token
// file. Deterministic: same input in, byte-identical output out. No timestamp,
// version, or hostname is emitted.
//
// Usage:
//   node scripts/gen-swift-tokens.mjs        write (regenerate if different)
//   node scripts/gen-swift-tokens.mjs --check regenerate in memory and fail
//                                          (exit 1) if the committed file drifts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = resolve(here, "../src/renderer/tokens.css");
const SWIFT_PATH = resolve(here, "../generated/swift/Theme.swift");

// Swift token properties in struct declaration order. The API is fixed —
// call sites (views) must not change.
const TOKENS = [
  "canvas", "panel", "card", "raised", "inset",
  "borderSubtle", "border", "borderStrong",
  "tx1", "tx2", "tx3", "tx4",
  "accent", "accentTx", "accentSolid", "onAccent",
  "ok", "warn", "danger", "info",
  "fill", "fillActive",
];

// Tokens(...) initializer argument grouping — pure formatting only.
const GROUPS = [
  ["canvas", "panel", "card"],
  ["raised", "inset"],
  ["borderSubtle", "border", "borderStrong"],
  ["tx1", "tx2", "tx3", "tx4"],
  ["accent", "accentTx", "accentSolid", "onAccent"],
  ["ok", "warn", "danger", "info"],
  ["fill", "fillActive"],
];

const camelToKebab = (s) => s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

function parseThemes(css) {
  const themes = {};
  const blockRe = /\[data-theme="(light|dark)"\]\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = blockRe.exec(css))) {
    const vars = {};
    const varRe = /--([a-zA-Z0-9-]+):\s*([^;]+);/g;
    let v;
    while ((v = varRe.exec(m[2]))) vars[v[1]] = v[2].trim();
    themes[m[1]] = vars;
  }
  return themes;
}

// Theme-independent metric/typography tokens live in the :root block, NOT in a
// data-theme block. The Swift Values are resolved from exactly the tokens the
// CSS names; a token with no counterpart here dies loudly rather than being
// silently dropped.
function parseRoot(css) {
  const vars = {};
  const re = /:root\s*\{([\s\S]*?)\}/g;
  const m = re.exec(css);
  if (!m) return vars;
  const varRe = /--([a-zA-Z0-9-]+):\s*([^;]+);/g;
  let v;
  while ((v = varRe.exec(m[1]))) vars[v[1]] = v[2].trim();
  return vars;
}

// Spacing scale: CSS --sp-N -> Swift field `spN` (--sp-px -> `spPx`).
const SPACING_MAP = [
  ["sp0", "sp-0"], ["spPx", "sp-px"], ["sp1", "sp-1"], ["sp2", "sp-2"],
  ["sp3", "sp-3"], ["sp4", "sp-4"], ["sp5", "sp-5"], ["sp6", "sp-6"],
  ["sp8", "sp-8"], ["sp10", "sp-10"], ["sp12", "sp-12"],
];
// Corner radii: --r-N -> Swift field `rN`.
const RADIUS_MAP = [
  ["xs", "r-xs"], ["sm", "r-sm"], ["md", "r-md"],
  ["lg", "r-lg"], ["xl", "r-xl"], ["full", "r-full"],
];
// Typography: { swiftField: cssToken }. The sans/mono FAMILIES are declared
// separately (typed String) below; this map is the numeric/weight/leading set.
const TYPE_MAP = {
  body: "font-size-body", small: "font-size-small",
  xs: "font-size-xs", twoXS: "font-size-2xs",
  medium: "weight-medium", semibold: "weight-semibold",
  proseLineHeight: "prose-lh", uiLineHeight: "ui-lh",
};
// Off-grid layout paddings the mockup fixes (§8 / transcript-mockup.html).
const LAYOUT_MAP = { stepRowY: "step-row-y", stepDot: "step-dot" };

// CSS allows a leading-dot decimal (".035"); Swift requires a leading zero
// ("0.035"). Normalize so the emitted Swift literals always compile.
const swiftNumber = (n) => (n.startsWith(".") ? "0" + n : n);

// A metric value from a CSS token: either a pixel length ("12px") or a
// unitless multiplier ("1.55"). Both become a CGFloat literal.
function swiftCGFloat(value, name) {
  const m = value.match(/^(-?[\d.]+)px$/);
  if (m) return swiftNumber(m[1]);
  if (/^-?[\d.]+$/.test(value)) return swiftNumber(value);
  throw new Error(
    `metric token '${name}' (value '${value}') is not a px length or unitless number`,
  );
}

// A string value from a CSS token (a quoted font-family list) kept as a raw
// Swift string (the comma-list kept intact; callers pick their face).
function swiftString(value) {
  return JSON.stringify(value.replace(/"/g, ""));
}

function typeValue(root, field, css) {
  const v = root[css];
  if (v === undefined) throw new Error(`type token '--${css}' missing from :root`);
  if (css === "font-sans" || css === "font-mono") return swiftString(v);
  return swiftCGFloat(v, css);
}

function metricsBody(root) {
  const lines = [];

  lines.push("struct Spacing {");
  for (const [field, css] of SPACING_MAP) {
    const v = root[css];
    if (v === undefined) throw new Error(`spacing token '--${css}' missing from :root`);
    lines.push(`    let ${field}: CGFloat`);
  }
  lines.push("}");
  lines.push("");

  lines.push("struct Radius {");
  for (const [field, css] of RADIUS_MAP) {
    const v = root[css];
    if (v === undefined) throw new Error(`radius token '--${css}' missing from :root`);
    lines.push(`    let ${field}: CGFloat`);
  }
  lines.push("}");
  lines.push("");

  lines.push("struct TypeMetrics {");
  for (const css of ["font-sans", "font-mono"]) {
    const v = root[css];
    if (v === undefined) throw new Error(`type token '--${css}' missing from :root`);
    lines.push(`    let ${css === "font-sans" ? "sans" : "mono"}: String`);
  }
  for (const [field, css] of Object.entries(TYPE_MAP)) {
    const v = root[css];
    if (v === undefined) throw new Error(`type token '--${css}' missing from :root`);
    lines.push(`    let ${field}: ${css === "font-sans" || css === "font-mono" ? "String" : "CGFloat"}`);
  }
  for (const [field, css] of Object.entries(LAYOUT_MAP)) {
    const v = root[css];
    if (v === undefined) throw new Error(`layout token '--${css}' missing from :root`);
    lines.push(`    let ${field}: CGFloat`);
  }
  lines.push("}");
  lines.push("");

  const spacingArgs = SPACING_MAP.map(([field, css]) => `${field}: ${swiftCGFloat(root[css], css)}`).join(", ");
  const radiusArgs = RADIUS_MAP.map(([field, css]) => `${field}: ${swiftCGFloat(root[css], css)}`).join(", ");
  const typeArgs = Object.entries({ sans: "font-sans", mono: "font-mono", ...TYPE_MAP, ...LAYOUT_MAP })
    .map(([field, css]) => `${field}: ${typeValue(root, field, css)}`)
    .join(", ");

  lines.push("enum Metrics {");
  lines.push(`    static let spacing = Spacing(${spacingArgs})`);
  lines.push(`    static let radius = Radius(${radiusArgs})`);
  lines.push(`    static let type = TypeMetrics(${typeArgs})`);
  lines.push("}");
  return lines.join("\n");
}

function swiftExpr(name, value) {
  const rgba = value.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)$/,
  );
  if (rgba) {
    const [, r, g, b, a] = rgba;
    return `Color(red: ${swiftNumber(r)}/255, green: ${swiftNumber(g)}/255, blue: ${swiftNumber(b)}/255, opacity: ${swiftNumber(a)})`;
  }
  if (value.startsWith("#")) return `Color(hex: \"${value}\")`;
  throw new Error(
    `token '${name}' (value '${value}') in tokens.css is neither a hex colour nor an rgba() colour`,
  );
}

function schemeBody(themeName, vars) {
  const lines = [`    private static var ${themeName}Tokens: Tokens {`];
  for (const name of TOKENS) {
    const value = vars[camelToKebab(name)];
    if (value === undefined) {
      throw new Error(
        `token '${name}' (--${camelToKebab(name)}) has no counterpart in the ${themeName} theme of ${CSS_PATH}`,
      );
    }
    lines.push(`        let ${name}: Color = ${swiftExpr(name, value)}`);
  }
  lines.push("        return Tokens(");
  for (const group of GROUPS) {
    lines.push("            " + group.map((n) => `${n}: ${n}`).join(", ") + ",");
  }
  lines.push("        )");
  lines.push("    }");
  return lines.join("\n");
}

export function generate(css) {
  const themes = parseThemes(css);
  const root = parseRoot(css);

  return `// GENERATED FILE — do not edit by hand.
// Generated by scripts/gen-swift-tokens.mjs from src/renderer/tokens.css
// (the single source of truth for design tokens). Re-run the generator
// (node scripts/gen-swift-tokens.mjs) to regenerate.

import SwiftUI

struct Tokens {
    let canvas: Color
    let panel: Color
    let card: Color
    let raised: Color
    let inset: Color
    let borderSubtle: Color
    let border: Color
    let borderStrong: Color
    let tx1: Color
    let tx2: Color
    let tx3: Color
    let tx4: Color
    let accent: Color
    let accentTx: Color
    let accentSolid: Color
    let onAccent: Color
    let ok: Color
    let warn: Color
    let danger: Color
    let info: Color
    let fill: Color
    let fillActive: Color

    static func scheme(_ scheme: ColorScheme) -> Tokens {
        switch scheme {
        case .light:
            return lightTokens
        case .dark:
            return darkTokens
        @unknown default:
            return darkTokens
        }
    }

${schemeBody("light", themes.light)}

${schemeBody("dark", themes.dark)}
}

// ---- Theme-independent metric + typography tokens --------------------------
// Generated from tokens.css :root. These are the non-colour half of the design
// substrate: spacing scale, corner radii, type faces/sizes/weights and the
// prose/UI leading. They are theme-independent (unlike the color Tokens).
${metricsBody(root)}

extension Color {
    init(hex: String, opacity: Double = 1) {
        var hexSanitized = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        hexSanitized = hexSanitized.hasPrefix("#") ? String(hexSanitized.dropFirst()) : hexSanitized
        var r: UInt64 = 0, g: UInt64 = 0, b: UInt64 = 0
        var int: UInt64 = 0
        Scanner(string: hexSanitized).scanHexInt64(&int)
        let length = hexSanitized.count
        if length == 6 {
            r = (int >> 16) & 0xFF
            g = (int >> 8) & 0xFF
            b = int & 0xFF
        }
        self.init(
            .sRGB,
            red: Double(r) / 255,
            green: Double(g) / 255,
            blue: Double(b) / 255,
            opacity: opacity
        )
    }
}
`;
}

// Minimal deterministic unified diff. Sufficient for the gate's job (reporting
// which committed lines drifted, not reimplementing `diff`), and avoids both a
// runtime dependency and shelling out to the system `diff` binary.
export function unifiedDiff(oldText, newText, oldName = "a", newName = "b", context = 3) {
  const a = (oldText ?? "").split("\n");
  const b = (newText ?? "").split("\n");
  const n = a.length;
  const m = b.length;

  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // ops: {type: "=" | "-" | "+", line}
  const ops = [];
  {
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push({ type: "=", line: a[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ type: "-", line: a[i] });
        i++;
      } else {
        ops.push({ type: "+", line: b[j] });
        j++;
      }
    }
    while (i < n) {
      ops.push({ type: "-", line: a[i] });
      i++;
    }
    while (j < m) {
      ops.push({ type: "+", line: b[j] });
      j++;
    }
  }

  // Group changed ranges (with `context` surrounding lines) into hunks.
  const changed = ops.map((o) => o.type !== "=");
  const hunks = [];
  {
    let i = 0;
    while (i < ops.length) {
      if (!changed[i]) {
        i++;
        continue;
      }
      let start = Math.max(0, i - context);
      let end = i;
      while (end < ops.length && (changed[end] || end - i < 2 * context)) {
        if (changed[end]) i = end;
        end++;
      }
      end = Math.min(ops.length, end + context);
      hunks.push([start, end]);
      i = end;
    }
  }

  const lines = [`--- ${oldName}`, `+++ ${newName}`];
  for (const [start, end] of hunks) {
    let oldLine = 0;
    let newLine = 0;
    let oldCount = 0;
    let newCount = 0;
    for (let k = 0; k < start; k++) {
      if (ops[k].type !== "+") oldLine++;
      if (ops[k].type !== "-") newLine++;
    }
    for (let k = start; k < end; k++) {
      if (ops[k].type !== "+") oldCount++;
      if (ops[k].type !== "-") newCount++;
    }
    lines.push(`@@ -${oldLine + 1},${oldCount} +${newLine + 1},${newCount} @@`);
    for (let k = start; k < end; k++) {
      const o = ops[k];
      lines.push(`${o.type === "=" ? " " : o.type}${o.line}`);
    }
  }
  return lines.join("\n");
}

export function run({
  cssPath = CSS_PATH,
  swiftPath = SWIFT_PATH,
  readFile = (p) => readFileSync(p, "utf8"),
  writeFile = (p, data) => writeFileSync(p, data),
  diff = unifiedDiff,
  check = false,
  log = (s) => console.log(s),
} = {}) {
  const css = readFile(cssPath);
  const out = generate(css);

  let existing = null;
  try {
    existing = readFile(swiftPath);
  } catch {
    existing = null;
  }

  if (existing === out) {
    if (check) log("Swift tokens are up to date.");
    return 0;
  }

  if (check) {
    log(swiftPath);
    log(diff(existing ?? "", out, swiftPath, "<generated>"));
    log("");
    log(
      "Swift tokens are out of date. To fix: run `npm run gen:swift-tokens` " +
        "(no --check) and commit the result.",
    );
    return 1;
  }

  mkdirSync(dirname(swiftPath), { recursive: true });
  writeFile(swiftPath, out);
  log(`wrote ${swiftPath} (${out.split("\n").length - 1} lines)`);
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  process.exitCode = run({ check });
}
