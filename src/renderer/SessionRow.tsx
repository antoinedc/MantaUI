// M527.SessionRow — the one-line session-row chrome primitive (BET-536, stage
// 7). Adopted by BET-529's inventory (`.srow` × 40 — the most-used pattern in
// the redesign spec, and the one BET-529 omitted).
//
// Owns the ONE shared session-row chrome with NO `className` escape hatch
// (epic standing decision 3): a caller cannot shear the density metrics,
// radius, selection surface/marker, child connectors, dot or name/age type —
// so the whole rail can only drift if SessionRow is retuned.
//
// Chrome contract (BET-529 inventory + the `.srow` spec):
//   - one line, `dot · name · age` — nothing else. Layout `flex; align-items:
//     center; gap: --sp-2`, radius `--r-md`, `margin-bottom: 4px`. The hover
//     `--fill-hover` is NOT painted by the row: the rail owns one gliding
//     highlight (src/renderer/RailGlide.tsx) that travels behind the rows.
//   - dot (`.st`) 7px circle: `run` → `--accent` + 3px `--accent-bg` ring +
//     pulse; `att` → `--danger` + `--danger-bg` ring + faster-proxied pulse;
//     `idle` → `--warn`; `ok` → `--ok`; `default` → `--tx4`.
//   - name (`.t`): `500 13px/1.4 --font-sans`, `--tx2`, one line with
//     ellipsis; selected → `--tx1`, weight 600.
//   - age (`.age`): `500 11px/1 --font-mono`, `--tx4`, tabular numerals,
//     never shrinks (min-width 20px, right-aligned).
//
// Two constraints make this primitive different — both hit by accident while
// building the companion page, both owned elsewhere:
//
// C2 (density). The row owns NONE of its own metrics. `--row-h` / `--row-px`
// / `--row-py` are consumed via token references (min-h-[var(--row-h)] etc.),
// never hardcoded — so the row must render inside a `[data-density]` ancestor
// to resolve them. Rendered outside a density scope the row collapses to an
// 18px unpadded line. The caller (the sidebar rail) is responsible for
// providing that density ancestor.
//
// C3 (container-owned inset). The selection marker (`.srow.on::before`) sits
// at `left:-8px` — it hangs OUTSIDE the row into the `--sp-2` padding owned by
// the scroll container (`.rail-scroll`). SessionRow does NOT own a left inset
// and the scroll container must keep its padding, or the marker clips.
//
// C4 (the dot is required). `status` is a REQUIRED prop with no default — a
// bare `<SessionRow>` without a status is a TYPE ERROR, not a dot-less row.

import type { ReactNode } from "react";

export type SessionStatus = "run" | "att" | "idle" | "ok" | "default";

// The row container. `group` is the identity hook for the call site's
// group-hover affordances (the pin reveal, the stale-age reveal); it styles
// nothing by itself and is not the forbidden `className` escape hatch.
// The rest is the spec'd row chrome, with ALL metrics token-referenced so the
// [data-density] ancestor owns them (C2).
const ROW_BASE =
  "group relative z-[1] flex cursor-pointer items-center gap-2 rounded-md mb-1 " +
  "min-h-[var(--row-h)] px-[var(--row-px)] py-[var(--row-py)] " +
  "transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1";

// Selected (`.on`): `--raised` surface + the C3 marker at left:-8px.
const ROW_SELECTED =
  "bg-raised before:absolute before:content-[''] before:left-[-8px] " +
  "before:top-1/2 before:-translate-y-1/2 before:h-4 before:w-[3px] " +
  "before:rounded-r-[3px] before:bg-accent";

// Child (`.child`): 26px indent + the `left:13px` tree connectors. The
// horizontal elbow stub is ::before, the vertical trunk is ::after. This is
// the geometry EVERY child shares; only the ink (rest vs selected) and the
// trunk's end (mid vs full row) vary, as the two pairs below.
//
// The trunk starts 4px ABOVE the row (`-top-1`, the exact negative of
// ROW_BASE's `mb-1` gutter), so it closes the gap to whatever sits above it —
// the parent row for the first child, the previous sibling for the rest.
const ROW_CHILD =
  "pl-[26px] " +
  "before:absolute before:content-[''] before:left-[13px] before:top-1/2 " +
  "before:h-px before:w-[7px] " +
  "after:absolute after:content-[''] after:left-[13px] after:-top-1 " +
  "after:w-px";

// Connector ink: --border at rest, --accent when the child is selected
// (`.srow.child.on`), replacing the normal row's marker.
const ROW_CHILD_INK = "before:bg-border after:bg-border";
const ROW_CHILD_INK_SELECTED = "before:bg-accent after:bg-accent";

// Trunk end. A child with a sibling below runs to its own bottom edge, where
// that sibling's `-top-1` picks it up, so the tree reads as one unbroken line.
// The LAST child stops at the elbow so the tree doesn't dangle past the group.
const ROW_CHILD_TRUNK = "after:bottom-0";
const ROW_CHILD_TRUNK_LAST = "after:bottom-1/2";

// The 7px status dot. The base carries no background — the variant owns the
// colour outright so two bg-* classes never fight over CSS source order. The
// ring+pulse echo the spec's box-shadow ring / running-blinking dot
// (`animate-pulse` is the app's shared status-dot pulse).
const DOT_BASE = "h-[7px] w-[7px] shrink-0 rounded-full";
const DOT: Record<SessionStatus, string> = {
  default: "bg-text-quiet",
  run: "bg-accent ring-[3px] ring-accent-bg animate-pulse",
  att: "bg-danger ring-[3px] ring-danger-bg animate-pulse",
  idle: "bg-warn",
  ok: "bg-ok",
};

// Name `.t`: one line, ellipsis; selected brightens + weights 600. The base
// and selected states are mutually exclusive in class terms so the weight /
// colour tokens never fight.
const NAME_REST = "flex-1 min-w-0 truncate text-label font-medium text-text-muted";
const NAME_SELECTED = "flex-1 min-w-0 truncate text-label font-semibold text-text";

// Age `.age`: mono tabular numerals, right-aligned, never shrinks. `ageStale`
// hides the slot at rest and reveals it on row hover (visibility-preserving,
// so revealing it shifts nothing).
const AGE_CHROME = "shrink-0 min-w-[20px] text-right font-mono tabular-nums text-micro text-text-quiet";

export function SessionRow({
  status,
  selected = false,
  child = false,
  lastChild = false,
  name,
  age,
  ageStale = false,
  statusTitle,
  trailing,
  title,
  tabIndex,
  ariaSelected,
  ariaLevel,
  onClick,
  onContextMenu,
}: {
  /** The status-dot variant. REQUIRED with no default (C4). */
  status: SessionStatus;
  /** `.on` — `--raised` surface + the C3 marker. */
  selected?: boolean;
  /** `.child` — 26px indent + the `left:13px` tree connectors. */
  child?: boolean;
  /** Last child in its group — the trunk stops at the elbow instead of
   *  running on to the next sibling. Ignored unless `child`. */
  lastChild?: boolean;
  /** The one-line name (`.t`). */
  name: ReactNode;
  /** The trailing age (`.age`). Empty in a reserved 20px slot when omitted. */
  age?: ReactNode;
  /** Age slot is `visibility:hidden` until the row is hovered. */
  ageStale?: boolean;
  /** Tooltip on the status dot (e.g. "Running · 2 subagents"). */
  statusTitle?: string;
  /** Right-aligned affordances after the age (e.g. the pin slot). */
  trailing?: ReactNode;
  /** Row `title`. */
  title?: string;
  tabIndex?: number;
  ariaSelected?: boolean;
  ariaLevel?: number;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const childChrome = [
    ROW_CHILD,
    selected ? ROW_CHILD_INK_SELECTED : ROW_CHILD_INK,
    lastChild ? ROW_CHILD_TRUNK_LAST : ROW_CHILD_TRUNK,
  ].join(" ");
  // No resting hover fill here: the rail owns ONE gliding highlight that
  // travels behind the rows (see src/renderer/RailGlide.tsx). A per-row
  // `hover:bg-fill-hover` would paint the fill a second time.
  const row = ROW_BASE + (child ? " " + childChrome : selected ? " " + ROW_SELECTED : "");
  return (
    <div
      role="treeitem"
      data-rail-row=""
      aria-selected={ariaSelected}
      aria-level={ariaLevel}
      tabIndex={tabIndex}
      title={title}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={row}
    >
      <span className={`${DOT_BASE} ${DOT[status]}`} title={statusTitle} aria-hidden="true" />
      <span className={selected ? NAME_SELECTED : NAME_REST}>{name}</span>
      <span className={AGE_CHROME + (ageStale ? " invisible group-hover:visible" : " visible")}>
        {age}
      </span>
      {trailing}
    </div>
  );
}
