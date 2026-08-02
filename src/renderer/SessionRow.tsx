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
//     center; gap: --sp-2`, radius `--r-md`, `margin-bottom: 4px`, hover
//     `--fill-hover`.
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
  "group relative flex cursor-pointer items-center gap-2 rounded-md mb-1 " +
  "min-h-[var(--row-h)] px-[var(--row-px)] py-[var(--row-py)] " +
  "transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1";

// Selected (`.on`): `--raised` surface + the C3 marker at left:-8px.
const ROW_SELECTED =
  "bg-raised before:absolute before:content-[''] before:left-[-8px] " +
  "before:top-1/2 before:-translate-y-1/2 before:h-4 before:w-[3px] " +
  "before:rounded-r-[3px] before:bg-accent";

// Resting: the spec'd hover fill.
const ROW_REST = "hover:bg-fill-hover";

// Child (`.child`): 26px indent + the `left:13px` tree connectors. The
// horizontal connector reuses ::before, the vertical uses ::after.
const ROW_CHILD =
  "pl-[26px] " +
  "before:absolute before:content-[''] before:left-[13px] before:top-1/2 " +
  "before:h-px before:w-[7px] before:bg-border " +
  "after:absolute after:content-[''] after:left-[13px] after:top-0 after:bottom-1/2 " +
  "after:w-px after:bg-border";

// Selected child: the connectors turn `--accent` (`.srow.child.on`), replacing
// the normal row's marker.
const ROW_CHILD_SELECTED =
  "pl-[26px] " +
  "before:absolute before:content-[''] before:left-[13px] before:top-1/2 " +
  "before:h-px before:w-[7px] before:bg-accent " +
  "after:absolute after:content-[''] after:left-[13px] after:top-0 after:bottom-1/2 " +
  "after:w-px after:bg-accent";

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
  const row =
    ROW_BASE +
    " " +
    (child ? (selected ? ROW_CHILD_SELECTED : ROW_CHILD) : selected ? ROW_SELECTED : ROW_REST);
  return (
    <div
      role="treeitem"
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
