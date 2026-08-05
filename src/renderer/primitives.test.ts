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
//   D4. chrome-ownership allowlist   (BET-588: a class belongs to one primitive)
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
const PRIMITIVES = ["Card", "IconButton", "Field", "Pill", "MenuItem", "MenuOption", "SessionRow", "Checkbox", "Button", "Chip", "SplitChip", "Toggle", "Callout", "Tag", "IconCard", "Eyebrow", "SettingsRow", "StatusDot", "OutputWell", "ToolCard", "MeasureColumn", "MessageBubble", "MantaLoader"] as const;

// A primitive component whose implementation lives in a differently-named
// module file. `Chip.tsx` exports BOTH `Chip` and `SplitChip` (they share the
// shell and must not diverge, BET-615), so both map to the one file. The
// two-adopter count for each is the set of files that import the `./Chip`
// module, which is how the rule stays honest for two components in one source.
const COMPONENT_FILE: Record<string, string> = { SplitChip: "Chip" };

const RENDERER = fileURLToPath(new URL(".", import.meta.url));

function rendererFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      // M527: the two-adopter scan must not count files under
      // src/renderer/mobile/** as adopters (owner-standing, BET-549). The
      // mobile-redesign deletes that whole tree (DECISIONS.md §12), so an
      // adopter there would mark a primitive satisfied via a file that
      // vanishes — hiding a real one-adopter gap. Exclude it from the walk.
      if (e.isDirectory()) {
        if (d === RENDERER && e.name === "mobile") continue;
        walk(path.join(d, e.name));
        continue;
      }
      if (/\.(tsx|ts)$/.test(e.name)) out.push(path.relative(RENDERER, path.join(d, e.name)));
    }
  };
  walk(RENDERER);
  return out;
}

function source(p: string): string {
  return readFileSync(path.join(RENDERER, `${COMPONENT_FILE[p] ?? p}.tsx`), "utf8");
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

/** Importer filenames for `p` per the epic's rule (excludes own source + test).
 *  Matches by MODULE import (any named export from `./<file>`), not by a
 *  single export name — Chip.tsx exports two components (Chip + SplitChip),
 *  and each is "adopted" by a file that imports the module either way, so the
 *  two-adopter count for both resolves to the same 2 files (ModelPicker +
 *  NewSessionScreen). For single-export modules this is equivalent to the old
 *  brace-name match. */
function importers(p: string): string[] {
  const file = COMPONENT_FILE[p] ?? p;
  const re = new RegExp(`from\\s*["'][^"']*\\/${file}["']`);
  return rendererFiles().filter((f) => {
    if (f === `${file}.tsx` || f === `${file}.test.tsx`) return false;
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

// SINGLE_SURFACE is a FORMAL, owner-approved exemption from the two-adopter
// rule (BET-546, option (a) confirmed by the owner 2026-08-01) — not a pending
// finding. It records the reason in SKIP_REASON so the exemption survives the
// BET-527 mobile consolidation.
//
// SessionRow stays a recorded single-surface exemption. Its sole web
// adopter is the desktop rail (Sidebar.tsx); its only other session list was
// mobile/SessionListScreen, which the mobile-redesign deletes wholesale
// (DECISIONS.md §12). The recorded reason cites that deletion rather than any
// chrome incompatibility, so the waiver survives the mobile removal.
//
// MenuItem gains a recorded waiver in BET-549. After the mobile exclusion,
// its only remaining web adopter is SessionHeader.tsx (the session menu /
// dropdown); its former second adopter was the excluded mobile SessionScreen
// sheet, which the mobile-redesign deletes. BET-644 resolves it: the model
// and effort menus (ModelMenu.tsx + EffortMenu.tsx) adopt the same Dropdown
// surface, so MenuItem now has three web adopters and leaves SINGLE_SURFACE.
const SINGLE_SURFACE: Set<string> = new Set(["SessionRow", "Toggle", "Tag", "IconCard", "Eyebrow", "SettingsRow", "MessageBubble"]);

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
  // MenuItem / Dropdown's verbatim spec chrome (BET-644): the four-region menu
  // surface's off-grid values — 340px wide/250px narrow panel widths, 460px
  // max-height and the 38px fixed search strip. The 11.25rem menu min-width
  // resolves through rem so it needs no entry. Real values from the redesign
  // spec's `.dd`, not drift.
  MenuItem: [38, 250, 340, 460],
  // MenuOption's verbatim spec chrome (BET-644): the 34px single-line and 44px
  // sub-line row densities (min-h-[34px]/min-h-[44px]), the 2px sub-line top
  // margin (mt-[2px], `.opt .sub`), and the decimal tail of the 11.5px sub-line
  // (text-[11.5px] → the `\d+px` scan reads it as 5). Real values from the
  // redesign spec's `.opt`, not drift. (The 16px check tick slot uses w-4, so
  // it resolves through Tailwind's scale and needs no entry.)
  MenuOption: [2, 5, 34, 44],
  // Button's verbatim spec chrome (BET-611 stage 1): 14px inline padding
  // (px-[14px]); 32px resolves via h-8, so it needs no entry. The 6px icon gap
  // (gap-[6px]) and the 12.5px label (text-[12.5px] → 5px after the decimal)
  // are the other spec pixel values in the BUTTON_BASE constant — all three
  // are real values from the redesign spec's button definition, not drift.
  Button: [5, 6, 14],
  // Chip / SplitChip share one source file with one chrome contract (BET-615):
  // 29px hit area (h-[29px]), 11px inline padding (px-[11px]) and a 6px gap
  // (gap-[6px]). Both names carry the same allowlist because rule 1c scans
  // the shared Chip.tsx for each, so both need the values listed.
  Chip: [6, 11, 29],
  SplitChip: [6, 11, 29],
  // Toggle's verbatim spec chrome (BET-614 stage 3): the 2px knob offset
  // (top-[2px]) and the 18px on-knob x-position (left-[18px] — 36px track
  // minus 14px knob minus 2×2px padding). Real values from the redesign
  // spec's `.sw` definition, not drift — the switch's hit-area/size resolve
  // via w-9/h-5/w-3.5 so they need no entry.
  Toggle: [2, 18],
  // Callout's verbatim spec chrome (BET-614 stage 3): the 3px left accent
  // bar (border-l-[3px]). The only off-grid px in CALLOUT_BASE.
  Callout: [3],
  // Tag's verbatim spec chrome (BET-614 stage 4): the 5px icon gap
  // (gap-[5px]) and the 23px pill hit area (h-[23px]). The 11.5px label
  // (text-[11.5px]) resolves through the `\d+px` scan's decimal skip, so it
  // needs no entry. Real values from the redesign spec's tag definition, not
  // drift. 11 is the `sm` size's label (text-[11px]) — the header-density
  // variant's one off-grid value; its 20px height resolves via `h-5` and its
  // 4px gap via `gap-1`, so neither needs an entry.
  Tag: [5, 11, 23],
  // IconCard's verbatim spec chrome (BET-614 stage 4): the 10.5px mono label
  // (text-[10.5px]) is its only off-grid value — the `\d+px` scan reads the
  // "5px" tail of the decimal 10.5, so 5 is the entry. Real spec value, not
  // drift.
  IconCard: [5],
  // Eyebrow's verbatim spec chrome (BET-614 stage 4): the 11px label
  // (text-[11px]) is its only off-grid px.
  Eyebrow: [11],
  // SettingsRow's verbatim spec chrome (BET-614 stage 5): the 2px control
  // top-padding (pt-[2px]) and the 3px help top-margin (mt-[3px]) are its two
  // off-grid values. The 12.5px help text (text-[12.5px]) reads as 5px through
  // the `\d+px` decimal-tail scan, so 5 is allow-listed too — the same
  // handling Button/Tag give their 12.5/11.5px labels. Real values from the
  // redesign spec's `.setrow` definition, not drift.
  SettingsRow: [2, 3, 5],
  // StatusDot's verbatim spec chrome (BET-636): the 6px status dot
  // (w-[6px] h-[6px]) — `.tool-h .g` from the session spec. The only off-grid
  // value the dot carries.
  StatusDot: [6],
  // OutputWell's verbatim spec chrome (BET-636): the 9px standalone vertical
  // padding (py-[9px], from `.ask-cmd`) and the decimal tail of the 12.5px
  // mono size (text-[12.5px] → the `\d+px` scan reads it as 5, same handling
  // Button/Tag give their decimal labels). Real values from `.tool-b` /
  // `.ask-cmd`, not drift.
  OutputWell: [9, 5],
  // ToolCard's verbatim spec chrome (BET-636): the 9px header vertical padding
  // (py-[9px], `.tool-h`), the 11px meta size (text-[11px], `.tool-h .r`), and
  // the 12.5px mono header size (text-[12.5px] → reads as 5). Real values
  // from `.tool`/`.tool-h`, not drift.
  ToolCard: [9, 11, 5],
  // MeasureColumn's verbatim spec chrome (BET-637): the 28px side inset
  // (px-[28px], `.wrap` / `.comp-in`) — the transcript/composer reading column
  // is padded 28px at the sides. The max-width resolves through the inline
  // `var(--measure)` so it needs no entry.
  MeasureColumn: [28],
  // MessageBubble's verbatim spec chrome (BET-637): the 11px vertical bubble
  // padding (py-[11px], `.umsg`). The 88% cap (max-w-[88%]) is a percentage,
  // so it needs no entry.
  MessageBubble: [11],
};

const SKIP_REASON: Record<string, string> = {
  SessionRow:
    "single-surface primitive: 1 web adopting file (Sidebar.tsx, the desktop session rail). Its only other session list lived in mobile/SessionListScreen, which the mobile-redesign deletes wholesale (DECISIONS.md §12) — so the two-adopter scan no longer counts it. Owner-approved formal exemption from the two-adopter rule (BET-546); the 2nd web adopter is deferred to the mobile-consolidation follow-up.",
  Toggle:
    "single-surface primitive: both boolean switch adopters (chatAutoAllow + allowAgentPush) are rows of the ONE settings form (Settings.tsx) — two call sites, one adopting file, so the file-counting two-adopter scan reads 1. The settings-toggle is a single surface (a live on/off setting in the settings panel); converting a second, unrelated file to satisfy the file-count would force the primitive into a UI where the spec doesn't place a switch. Recorded as a single-surface case like SessionRow/MenuItem, not a pending finding.",
  IconCard:
    "no adopting file this stage (BET-614 stage 4): neither named adopter (Settings.tsx, NewSessionScreen.tsx) contains an icon-above-label tile — Settings' rail tabs are horizontal, interactive nav rows (aria tablist) and NewSessionScreen has no such tile — so per the epic rule both are REPORTED here (BET-618). Registered under the enforce net (its 1a/1c/D4 checks still run) while the owner decides on real adopters; no call-site migration exists to assert.",
  Eyebrow:
    "single-web-adopter this stage (BET-614 stage 4): its one genuine home is Settings.tsx (the GroupCard uppercase section label). The second named adopter, NewSessionScreen.tsx, has no uppercase section label — REPORTED here (BET-618) rather than force-converted. Pending an owner decision on a real second web adopter before the waiver resolves.",
  SettingsRow:
    "no adopting file this stage (BET-614 stage 5): the premise that Settings.tsx's private SettingField already implements `.setrow` and only needs extracting does NOT hold — that SettingField is a Field-based text/password input (entry/value/onCommit/credential), not a row with name/help/children. Neither named adopter (Settings.tsx, ProvidersCard.tsx) carries a genuine `.setrow` row: Settings.tsx's schema rows hand-roll their own simpler chrome and ProvidersCard.tsx's rows are endpoint list items. Converting either to satisfy the count would change the settings panel's visual layout (adds row dividers + spec typography) or force-fit an unrelated element — both forbidden — so this stage builds + registers the owner-approved primitive and REPORTS both adopters (BET-619). Pending an owner decision on a real web adopter (a `.setrow` migration of the settings panel) before the waiver resolves.",
  MessageBubble:
    "single-surface primitive: 1 web adopting file (MessageRow.tsx, the user message in the transcript). The user message is the only bubble in the app today, and the transcript's tool chrome is now in scope — the owner wants THIS bubble's chrome owned by a primitive now rather than re-derived when mobile and any future review surface need the same right-aligned bubble (the user bubble is a LOCKED spec decision, Q7, not a preference). Owner-approved formal exemption from the two-adopter rule (BET-637), following the SessionRow/MenuItem precedent.",
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

  describe("D4 — chrome-ownership allowlist (BET-588)", () => {
    // Chrome that belongs to exactly one primitive. A call site that contains
    // one of these has re-implemented that primitive inline — the failure mode
    // this epic exists to close (BET-580). Add a row when a primitive lands;
    // never add a file to a row to make a red test green.
    const CHROME_OWNERS: Record<string, string[]> = {
      "bg-black/40": ["Modal.tsx"], // the modal overlay tint
      "shadow-lg": ["Modal.tsx", "MenuItem.tsx"], // the window-level floating surface (Modal) and the dropdown menu surface (Dropdown, BET-644) — two real owners, declared with their primitives
      "peer-focus-visible:outline-accent": ["Checkbox.tsx"], // checkbox focus ring (BET-589)
      "hover:brightness-110": ["Button.tsx"], // primary button hover brighten (BET-614)
      "h-[29px]": ["Chip.tsx"], // chip hit-area height — the one off-grid value both Chip + SplitChip carry (BET-615)
      "left-[18px]": ["Toggle.tsx"], // toggle knob on-position — the switch's travel signature (BET-614)
      "border-l-[3px]": ["Callout.tsx"], // the 3px callout accent bar (BET-614)
      "h-[23px]": ["Tag.tsx"], // the tag pill's 23px hit area — the mono metadata badge signature (BET-614)
      "text-[10.5px]": ["IconCard.tsx"], // the icon-card's mono label size (BET-614)
      "tracking-[.1em]": ["Eyebrow.tsx"], // the eyebrow's letter-spaced uppercase signature (BET-614)
      "last:border-b-0": ["SettingsRow.tsx"], // the settings-row trailing-border removal — the .setrow row-divider signature (BET-614)
      "w-[6px]": ["StatusDot.tsx"], // the real 6px status dot — `.tool-h .g` (BET-636)
      "bg-inset": ["OutputWell.tsx", "ArtifactsPanel.tsx"], // the recessed output well — `.tool-b`/`.ask-cmd` (BET-636); plus the Artifacts panel's segmented tab track, which uses the same recessed-inset surface per its conformance mockup (`.mk-tabs`, BET-659)
      "px-[28px]": ["MeasureColumn.tsx"], // the 28px reading-column side inset — `.wrap`/`.comp-in` (BET-637)
      "max-w-[min(88%,var(--measure))]": ["MessageBubble.tsx"], // the user bubble's 88%/measure min() cap — `.umsg` (BET-637, BET-646)
      "text-[12.5px]": ["ToolCard.tsx", "OutputWell.tsx", "Button.tsx", "SettingsRow.tsx"], // the 12.5px mono chrome — ToolCard header + OutputWell well (BET-636), plus the pre-existing Button label and SettingsRow help which already owned it before this primitive tracked it
    };

    it("no non-owner file contains a primitive's owned chrome", () => {
      const offenders: string[] = [];
      for (const file of rendererFiles()) {
        if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
        const content = readFileSync(path.join(RENDERER, file), "utf8");
        for (const [chrome, owners] of Object.entries(CHROME_OWNERS)) {
          if (!content.includes(chrome)) continue;
          if (owners.includes(file)) continue;
          offenders.push(
            `${file} contains "${chrome}" (owned only by ${owners.join(", ")})`,
          );
        }
      }
      expect(
        offenders,
        `chrome-ownership (BET-588): ${offenders.join("; ") || "none"}`,
      ).toEqual([]);
    });
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
