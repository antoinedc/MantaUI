// M527.Enforce — the epic's three mechanical rules, as tests (BET-541, last stage).
//
// These are the "a rule with no test decays" net for the M527 primitive layer,
// mirroring the repo's three prior answers to that question
// (`tailwindScale.test.ts`, `DEMO_UNIMPLEMENTED`, `surfacesClosed`): a cheap
// test that fails naming the offender instead of a rule someone must remember.
//
// Three cases:
//   1a. no `className` escape hatch  (epic standing decision 3)
//   1b. two-adopter rule             (epic standing decision 2)
//   1c. no raw colour / off-grid px  (the drift that started the epic)
//
// The per-component `@ts-expect-error` guards in each primitive's OWN test are
// compile-time and stronger; this file is the net that catches a primitive
// added WITHOUT one. The doc (`docs/components.md` inventory) follows this test,
// never the reverse.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Every primitive in the M527 inventory. Adding one here is the whole cost of
// putting it under the epic's rules.
const PRIMITIVES = ["Card", "IconButton", "Field", "Pill", "MenuItem", "SessionRow"] as const;

const RENDERER = fileURLToPath(new URL(".", import.meta.url));

function rendererFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(e.name)) out.push(path.relative(RENDERER, p));
    }
  };
  walk(RENDERER);
  return out;
}

function source(p: string): string {
  return readFileSync(path.join(RENDERER, `${p}.tsx`), "utf8");
}

/** Return the balanced `{ ... }` starting at `openIdx` (must be a `{`). */
function balancedBrace(content: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < content.length; i++) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") {
      depth--;
      if (depth === 0) return content.slice(openIdx, i + 1);
    }
  }
  return "";
}

/**
 * Extract the props type literal of `export function <component>({ ... })`.
 * Handles both forms used by the M527 primitives:
 *   - inline: `}: { artA; artB }`  (Card, IconButton, Pill, MenuItem, SessionRow)
 *   - name alias: `}: FieldProps)` with `type FieldProps = { ... }`  (Field)
 * Returns null when neither form is parseable (caller skips, never lies).
 */
function propsLiteral(content: string, component: string): string | null {
  const fn = content.indexOf(`export function ${component}(`);
  if (fn === -1) return null;
  const inline = content.indexOf(`}: {`, fn);
  if (inline !== -1) return balancedBrace(content, inline + 3);
  const alias = content.slice(fn).match(/\}\s*:\s*([A-Za-z_$]\w*)\s*\)\s*\{/);
  if (alias) {
    const typeIdx = content.indexOf(`type ${alias[1]} = {`);
    if (typeIdx !== -1) return balancedBrace(content, content.indexOf("{", typeIdx));
  }
  return null;
}

/** Impoter filenames for `p` per the epic's rule (excludes own source + test). */
function importers(p: string): string[] {
  const re = new RegExp(`import\\s*\\{[^}]*\\b${p}\\b[^}]*\\}\\s*from\\s*["'][^"']*\\/${p}["']`);
  return rendererFiles().filter((f) => {
    if (f === `${p}.tsx` || f === `${p}.test.tsx`) return false;
    return re.test(readFileSync(path.join(RENDERER, f), "utf8"));
  });
}

/** The rendered code, with comments removed (comments legitimately document chrome). */
function sourceCode(p: string): string {
  return source(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Line numbers (1-based) whose text matches `re` — used to make a rule failure
 * name the primitive, the rule, AND the offending line, per the epic's
 * requirement that the message be actionable without opening the file.
 */
function offendingLines(content: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const [i, line] of content.split("\n").entries()) {
    if (re.test(line)) out.push(`${i + 1}: ${line.trim()}`);
  }
  return out;
}

// Bet-546 landed the second adopting files for IconButton (NewSessionScreen,
// BET-538), Field (CustomProviderForm) and MenuItem (the mobile SessionScreen ⋯
// sheet), so all three now assert the two-adopter rule ACTIVELY.
//
// SINGLE_SURFACE is a FORMAL, owner-approved exemption from the two-adopter
// rule (BET-546, option (a) confirmed by the owner 2026-08-01) — not a pending
// finding. SessionRow is a density-scoped primitive (C2): its metrics resolve
// only under a [data-density] ancestor, and the sole density-scoped session-row
// surface in the renderer is the desktop rail (Sidebar.tsx). The only other
// session list (mobile/SessionListScreen) is chrome-incompatible (56px two-line
// rows, no [data-density] scope), so adopting the primitive there is a redesign,
// not a no-visual-change migration. Its 2nd adopter is deferred to the BET-527
// mobile-consolidation follow-up.
const SINGLE_SURFACE: Set<string> = new Set(["SessionRow"]);

// Spec-authorized off-grid px values, per primitive, that rule 1c consults
// instead of skipping the primitive (BET-547). SessionRow's .srow chrome is
// owner-accepted spec chrome, NOT off-grid drift — BET-536 C6 ("off-grid spec
// chrome — spec+pre-existing, not invented"): the 7px status dot, 3px ring,
// -8px selection marker, 13px child connectors, 26px child indent and 20px age
// slot are real values from the redesign spec's `.srow` definition. A value
// listed here is spec chrome; a value NOT listed fails 1c and is reported
// verbatim, so the rule stays active — it just has a documented allow-list for
// the one spec-authorized component.
const OFF_GRID_PX_ALLOWLIST: Record<string, number[]> = {
  SessionRow: [3, 7, 8, 13, 20, 26],
};

const SKIP_REASON: Record<string, string> = {
  SessionRow:
    "single-density-surface primitive: 1 adopting file (Sidebar.tsx) — the only [data-density]-scoped session-row surface. The second session list (mobile/SessionListScreen) uses incompatible card chrome (56px two-line rows, no [data-density] ancestor), so adopting the primitive there is a redesign, not a no-visual-change migration. Owner-approved formal exemption from the two-adopter rule (BET-546); 2nd adopter deferred to the BET-527 follow-up.",
};

describe("M527 primitive rules", () => {
  describe("1a — no className escape hatch (standing decision 3)", () => {
    for (const p of PRIMITIVES) {
      const props = propsLiteral(source(p), p);
      const label = `${p} props type has no className member`;
      if (props === null) {
        // Defensive: if a future primitive's props shape defeats the extractor,
        // skip explicitly rather than emit a fragile regex false negative.
        it.skip(label, () => {});
      } else {
        it(label, () => {
          expect(props.match(/className\??:/), `${p}: no className in its props type`).toBeNull();
        });
      }
    }
  });

  describe("1b — two-adopter rule (standing decision 2)", () => {
    for (const p of PRIMITIVES) {
      const label = `${p} has at least two adopting files`;
      if (SINGLE_SURFACE.has(p)) {
        // Owner-approved formal exemption from the two-adopter rule as a
        // single-density-surface primitive (BET-546) — see SINGLE_SURFACE.
        it.skip(label, () => {
          void SKIP_REASON[p];
        });
      } else {
        it(label, () => {
          const adopters = importers(p);
          expect(
            adopters.length,
            `${p}: two-adopter rule needs >=2 files importing it; found ${JSON.stringify(adopters)}`,
          ).toBeGreaterThanOrEqual(2);
        });
      }
    }
  });

  describe("1c — no raw colour / off-grid px in the primitive's own code", () => {
    for (const p of PRIMITIVES) {
      const label = `${p} code has no raw colour or off-grid pixel literal`;
      it(label, () => {
        const code = sourceCode(p);
        const hex = offendingLines(code, /#[0-9a-fA-F]{3,8}\b/);
        const rgba = offendingLines(code, /rgba?\(/);
        const allowed = OFF_GRID_PX_ALLOWLIST[p] ?? [];
        const px = offendingLines(code, /\b\d+px\b/).filter((line) => {
          const values = [...line.matchAll(/\d+px/g)].map((m) => parseInt(m[0], 10));
          return values.some((v) => !allowed.includes(v));
        });
        expect(
          hex,
          `${p} [rule 1c — raw colour] has no raw hex; offending line(s): ${hex.join(" | ") || "none"}`,
        ).toEqual([]);
        expect(
          rgba,
          `${p} [rule 1c — raw colour] has no rgba(); offending line(s): ${rgba.join(" | ") || "none"}`,
        ).toEqual([]);
        expect(
          px,
          `${p} [rule 1c — off-grid px] has no px value off the spec allow-list; offending line(s): ${px.join(" | ") || "none"}`,
        ).toEqual([]);
      });
    }
  });
});
