import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import resolveConfig from "tailwindcss/resolveConfig.js";
// @ts-expect-error — plain .js config, no types.
import tailwindConfig from "../../tailwind.config.js";

const resolvedTheme = resolveConfig(tailwindConfig).theme;

/**
 * A Tailwind utility whose scale key does not exist compiles to NOTHING.
 * No build error, no lint error, no test failure — the class stays in the
 * markup and simply has no effect. That failure mode has now bitten twice:
 *
 *   - BET-422 trimmed `theme.spacing` and, in the same pass, replaced
 *     `theme.width` / `theme.height` with a numeric-only scale that had no
 *     `full` key. `w-full` (73 usages) and `h-full` (17 usages) silently
 *     stopped being emitted, so every full-height flex chain in the app
 *     collapsed to content height — the sidebar stopped filling the window
 *     and the transcript container stopped scrolling.
 *   - An off-grid padding value in a visual-verification test compiled to
 *     nothing for the same reason.
 *
 * This test closes the hole for the dimension utilities: every `w-*` / `h-*`
 * class the renderer actually uses must resolve to a key in the configured
 * scale. It is pure (no build, no browser) so it fails on the offending PR,
 * in the fast job, rather than as a mystery pixel diff later.
 */

const RENDERER_DIR = resolve(dirname(fileURLToPath(import.meta.url)));

/**
 * `w-…` / `h-…` only when NOT preceded by another word char or a hyphen, so
 * `max-w-md` and `min-h-0` (different scales, not under test here) don't
 * masquerade as `w-md` / `h-0`.
 */
const UTILITY_RE = /(?<![-\w])([wh])-([A-Za-z0-9./]+)/g;

/** Arbitrary values (`w-[3px]`) and CSS-var forms bypass the scale entirely. */
function isScaleLookup(value: string): boolean {
  return !value.startsWith("[");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function usedUtilities(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const file of sourceFiles(RENDERER_DIR)) {
    const text = readFileSync(file, "utf8");
    for (const [, axis, value] of text.matchAll(UTILITY_RE)) {
      if (!isScaleLookup(value)) continue;
      const key = `${axis}-${value}`;
      const files = used.get(key) ?? [];
      if (!files.includes(file)) files.push(file);
      used.set(key, files);
    }
  }
  return used;
}

/** Non-colour `bg-*` utilities that are NOT background-colour classes. */
const BG_NON_COLOUR_PREFIXES = [
  "clip",
  "cover",
  "contain",
  "center",
  "top",
  "bottom",
  "left",
  "right",
  "repeat",
  "no-repeat",
  "fixed",
  "local",
  "scroll",
  "auto",
  "none",
  "gradient",
  "origin",
  "blend",
  "opacity",
];

/** `bg-…` classes used in the renderer, keyed by their scale name. */
const BG_RE = /(?<![-\w])bg-([A-Za-z0-9./\[\]-]+)/g;

function usedBgClasses(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const file of sourceFiles(RENDERER_DIR)) {
    const text = readFileSync(file, "utf8");
    for (const [, raw] of text.matchAll(BG_RE)) {
      if (raw.startsWith("[")) continue; // arbitrary value bypasses the scale
      const value = raw.replace(/\/.*$/, ""); // drop any /opacity suffix
      if (BG_NON_COLOUR_PREFIXES.some((p) => value === p || value.startsWith(`${p}-`)))
        continue;
      const files = used.get(value) ?? [];
      if (!files.includes(file)) files.push(file);
      used.set(value, files);
    }
  }
  return used;
}

/**
 * Flatten `theme.backgroundColor` into the set of valid `bg-<name>` suffix
 * names. A nested key named `DEFAULT` takes its parent's name; any other
 * nested key is `parent-<key>`; the root-level colour families are the
 * top-level parents.
 */
function backgroundColorNames(): Set<string> {
  const names = new Set<string>();
  const walk = (node: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(node)) {
      const name = k === "DEFAULT" ? prefix : prefix ? `${prefix}-${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        walk(v as Record<string, unknown>, name);
      } else {
        names.add(name);
      }
    }
  };
  walk(resolvedTheme.backgroundColor as Record<string, unknown>, "");
  return names;
}

/** Spacing axes, ordered so the longest alternative matches first. */
const SPACING_AXES = [
  "gap-x",
  "gap-y",
  "gap",
  "px",
  "py",
  "pt",
  "pb",
  "pl",
  "pr",
  "p",
  "mx",
  "my",
  "mt",
  "mb",
  "ml",
  "mr",
  "m",
  "space-x",
  "space-y",
];
const SPACING_RE = new RegExp(
  `(?<![\\-\\w])(${SPACING_AXES.join("|")})-([A-Za-z0-9./\\[\\]-]+)`,
  "g",
);
const MARGIN_AXES = new Set(["mx", "my", "mt", "mb", "ml", "mr", "m"]);

/** Spacing utilities used in the renderer, keyed by `axis--value`. */
function usedSpacingClasses(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const file of sourceFiles(RENDERER_DIR)) {
    const text = readFileSync(file, "utf8");
    for (const [, axis, raw] of text.matchAll(SPACING_RE)) {
      if (raw.startsWith("[")) continue; // arbitrary value bypasses the scale
      const value = raw.replace(/\/.*$/, ""); // drop any /opacity suffix
      if (value === "auto" && MARGIN_AXES.has(axis)) continue; // auto is valid for margins
      const key = `${axis}::${value}`;
      const files = used.get(key) ?? [];
      if (!files.includes(file)) files.push(file);
      used.set(key, files);
    }
  }
  return used;
}

describe("tailwind dimension scales", () => {
  it("emits every w-* / h-* utility the renderer uses", () => {
    const scales: Record<string, Record<string, string>> = {
      w: tailwindConfig.theme.width,
      h: tailwindConfig.theme.height,
    };

    const unresolved: string[] = [];
    for (const [utility, files] of usedUtilities()) {
      const [axis, value] = [utility.slice(0, 1), utility.slice(2)];
      if (!(value in scales[axis])) {
        const where = files
          .map((f) => f.replace(`${RENDERER_DIR}/`, ""))
          .join(", ");
        unresolved.push(`${utility} (used in ${where})`);
      }
    }

    expect(
      unresolved,
      `These classes are in the markup but compile to nothing — the key is ` +
        `missing from theme.width / theme.height in tailwind.config.js:\n` +
        unresolved.map((u) => `  ${u}`).join("\n"),
    ).toEqual([]);
  });

  it("keeps the non-numeric dimension keys every layout depends on", () => {
    // `full` is the one that actually collapsed the app (BET-422). The others
    // are pinned so a future scale edit cannot quietly drop them either.
    for (const scale of ["width", "height", "minHeight", "maxHeight"] as const) {
      expect(
        Object.keys(tailwindConfig.theme[scale]),
        `theme.${scale} lost a non-numeric key`,
      ).toEqual(expect.arrayContaining(["full", "screen", "min", "max"]));
    }
  });

  it("resolves every bg-* colour utility the renderer uses", () => {
    const valid = backgroundColorNames();
    const unresolved: string[] = [];
    for (const [value, files] of usedBgClasses()) {
      if (!valid.has(value)) {
        const where = files
          .map((f) => f.replace(`${RENDERER_DIR}/`, ""))
          .join(", ");
        unresolved.push(`bg-${value} (used in ${where})`);
      }
    }

    expect(
      unresolved,
      `These classes are in the markup but compile to nothing — the key is ` +
        `missing from theme.backgroundColor in tailwind.config.js:\n` +
        unresolved.map((u) => `  ${u}`).join("\n"),
    ).toEqual([]);
  });

  it("resolves every spacing utility the renderer uses", () => {
    const spacing = resolvedTheme.spacing as Record<string, string>;
    const unresolved: string[] = [];
    for (const [key, files] of usedSpacingClasses()) {
      const value = key.split("::")[1];
      if (!(value in spacing)) {
        const where = files
          .map((f) => f.replace(`${RENDERER_DIR}/`, ""))
          .join(", ");
        unresolved.push(`${key} (used in ${where})`);
      }
    }

    expect(
      unresolved,
      `These classes are in the markup but compile to nothing — the key is ` +
        `missing from theme.spacing in tailwind.config.js:\n` +
        unresolved.map((u) => `  ${u}`).join("\n"),
    ).toEqual([]);
  });
});

/** `rounded(-…)?` only when NOT preceded by another word char or a hyphen. */
const ROUNDED_RE = /(?<![-\w])rounded(-[A-Za-z0-9[\]/.-]+)?/g;

/** Scalar `rounded-<key>` classes used in the renderer, keyed by scale name. */
function usedRadiusClasses(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const file of sourceFiles(RENDERER_DIR)) {
    const text = readFileSync(file, "utf8");
    for (const [, suffix] of text.matchAll(ROUNDED_RE)) {
      if (!suffix) continue; // bare `rounded` — handled by the bare check below
      if (suffix.includes("[")) continue; // arbitrary value bypasses the scale
      const key = suffix.slice(1); // drop the leading '-'
      const files = used.get(key) ?? [];
      if (!files.includes(file)) files.push(file);
      used.set(key, files);
    }
  }
  return used;
}

describe("tailwind border radius scale", () => {
  it("resolves every rounded-* class the renderer uses", () => {
    const radius = resolvedTheme.borderRadius as Record<string, string>;
    const unresolved: string[] = [];
    for (const [key, files] of usedRadiusClasses()) {
      if (!(key in radius)) {
        const where = files
          .map((f) => f.replace(`${RENDERER_DIR}/`, ""))
          .join(", ");
        unresolved.push(`rounded-${key} (used in ${where})`);
      }
    }

    expect(
      unresolved,
      `These classes are in the markup but compile to nothing — the key is ` +
        `missing from theme.borderRadius in tailwind.config.js:\n` +
        unresolved.map((u) => `  ${u}`).join("\n"),
    ).toEqual([]);
  });

  it("fails on a bare `rounded` with no explicit scale step", () => {
    const bare: { file: string; key: string }[] = [];
    for (const file of sourceFiles(RENDERER_DIR)) {
      const text = readFileSync(file, "utf8");
      for (const [, suffix] of text.matchAll(ROUNDED_RE)) {
        if (!suffix) {
          bare.push({
            file: file.replace(`${RENDERER_DIR}/`, ""),
            key: suffix as string,
          });
        }
      }
    }

    expect(
      bare,
      `theme.borderRadius has no DEFAULT key, so a bare \`rounded\` names no ` +
        `radius step and compiles to nothing — rename it to an explicit step ` +
        `(\`rounded-xs\` … \`rounded-full\`) in:\n` +
        bare.map((b) => `  ${b.file}`).join("\n"),
    ).toEqual([]);
  });
});
