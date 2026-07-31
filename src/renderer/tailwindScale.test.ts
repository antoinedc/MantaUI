import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .js config, no types.
import tailwindConfig from "../../tailwind.config.js";

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
});
