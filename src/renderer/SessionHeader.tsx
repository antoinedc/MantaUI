// ===== Session header =====
//
// Owns SESSION STATE for the active chat panel: the git branch, the context-
// usage pill (clickable → popover with full breakdown + stale-cache warning),
// and the session menu (Fork / Compact / Clear / Delete). The organising
// principle from BET-415: if it describes the session you are in, it goes up
// here; the composer below owns only composing.
//
// Purely presentational — all data (branch, token breakdown, stale-cache
// result) and handlers (fork / compact / clear / delete) are passed in as
// props by ChatPanel, which owns the session lifecycle.

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { GitBranch, MoreHorizontal, GitFork, Minimize2, Eraser, Trash2, Terminal, Bot, MessageSquare, Clock, PanelRight } from "lucide-react";
import {
  ctxStageColor,
  cssVar,
  moveMenuHighlight,
  type ContextBreakdown,
  type StaleCacheResult,
} from "./chatUtils";
import { useClickAway } from "./hooks/useClickAway";
import type { SessionMode } from "./chatShared";
import type { AvailableLauncher } from "../shared/types";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { Pill } from "./Pill";
import { Tag } from "./Tag";
import { Dropdown, MenuItem } from "./MenuItem";
import { ConfirmModal } from "./ConfirmModal";

// Cache-segment colors for the header pill.
const CACHE_WRITE_COLOR = cssVar("--warn");
const CACHE_READ_COLOR = cssVar("--info");

function formatTokensCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function formatIdleDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${totalSec}s`;
}

export function SessionHeader({
  branch,
  ctxBreakdown,
  ctxLimit,
  staleCache,
  modelName,
  hasSession,
  readOnly,
  onFork,
  onCompact,
  onClear,
  onDelete,
  breadcrumb,
  mode,
  onModeChange,
  availableLaunchers,
  artifactsOpen,
  onToggleArtifacts,
}: {
  branch: string | null;
  ctxBreakdown: ContextBreakdown;
  ctxLimit: number;
  staleCache: StaleCacheResult;
  modelName: string | null;
  // When false (no owning tmux window) the session menu is hidden — fork /
  // clear / delete all need a tmux window to target.
  hasSession: boolean;
  // BET-418 §D: when true the session is a read-only background-job view —
  // the Fork/Compact/Clear/Delete menu is hidden (Stop, in ReadOnlyJobBar, is
  // the only live action). Branch + context pill still render as info.
  readOnly?: boolean;
  onFork: () => void;
  onCompact: () => void;
  onClear: () => void;
  onDelete: () => void;
  // BET-459: the session header is the single top-of-pane row. It inherits the
  // breadcrumb (project / window — the cwd path was dropped) and the
  // Chat↔Terminal mode toggle from the app chrome so nothing renders up there
  // twice. `onModeChange` is optional: when the caller owns mode elsewhere
  // (mobile SessionScreen) the toggle is omitted rather than duplicated.
  breadcrumb: { project: string; window: string | null } | null;
  mode?: SessionMode;
  onModeChange?: (m: SessionMode) => void;
  // BET-467: the box's AI-CLI launchers surfaced as switchable modes in the
  // session menu (the header glyph only toggles Chat ↔ Terminal). Empty /
  // omitted → no launcher entries (desktop callers supply it; mobile owns
  // mode via its own <select> and passes neither this nor onModeChange).
  availableLaunchers?: AvailableLauncher[];
  // BET-659: the Artifacts panel toggle. `artifactsOpen` labels + tints the
  // button; onToggle flips the App-owned panel open state. Optional so test
  // harnesses / non-desktop callers that don't own the panel omit them.
  artifactsOpen?: boolean;
  onToggleArtifacts?: () => void;
}) {
  const { pct, segments, freshInput, cacheRead, cacheWrite, totalInput } =
    ctxBreakdown;
  const fill = ctxStageColor(pct);
  const showContext = totalInput > 0;
  const stale = staleCache.isStale;
  const artifactsToggle = onToggleArtifacts
    ? { isOpen: artifactsOpen === true, toggle: onToggleArtifacts }
    : null;
  const crumb = breadcrumb
    ? breadcrumb.window
      ? `${breadcrumb.project} / ${breadcrumb.window}`
      : breadcrumb.project
    : "";
  // BET-724 §D7: the confirm dialogs for Delete/Clear name the session — the
  // window name reads better than the full "project / window" breadcrumb.
  const sessionName = breadcrumb?.window ?? breadcrumb?.project ?? "this session";

  return (
    <div
      className="manta-session-header flex items-center gap-2 h-11 pl-3 pr-[calc(var(--sp-3)+var(--titlebar-inset-right))] border-b border-border shrink-0 min-w-0"
      style={{ WebkitAppRegion: "drag" } as CSSProperties}
    >
      {/* Breadcrumb — workspace / session. This names WHERE YOU ARE, and it is
            the header's primary job: one window shows many sessions across
            many workspaces, and the branch alone does not identify one. It is
            not decoration, and nothing else in the desktop chrome carries it. */}
      {crumb && (
        <span
          className="text-label text-text-faint shrink-0 truncate max-w-[200px]"
          title={crumb}
        >
          {crumb}
        </span>
      )}

      {/* Branch chip — session state, at the `sm` tag density so it reads as
            metadata beside the breadcrumb rather than as a control. */}
      {branch && (
        <Tag
          size="sm"
          icon={<GitBranch size={11} aria-hidden="true" className="shrink-0" />}
          title={`Current branch: ${branch}`}
        >
          <span className="shrink-0 truncate max-w-[200px]">{branch}</span>
        </Tag>
      )}

      {/* Right group — context pill, session menu. Opts out of the header's
            drag region so the controls stay clickable. */}
      <div
        className="ml-auto flex items-center gap-2"
        style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
      >
        {showContext && (
          <ContextPill
            pct={pct}
            segments={segments}
            fill={fill}
            stale={stale}
            totalInput={totalInput}
            ctxLimit={ctxLimit}
            freshInput={freshInput}
            cacheRead={cacheRead}
            cacheWrite={cacheWrite}
            modelName={modelName}
            staleCache={staleCache}
            onClear={onClear}
          />
        )}

        {/* Artifacts toggle (BET-659): toggles a panel, not a popup — so no
            aria-haspopup (the visual gate scans for it) and no manta hook.
            Tinted when open. Sits in the no-drag right group so macOS gets the
            click. Omitted when the caller doesn't own the panel. */}
        {artifactsToggle && (
          <IconButton
            icon={
              <PanelRight
                className={artifactsToggle.isOpen ? "text-[var(--accent-tx)]" : undefined}
              />
            }
            label={artifactsToggle.isOpen ? "Hide artifacts" : "Show artifacts"}
            title={artifactsToggle.isOpen ? "Hide artifacts" : "Show artifacts"}
            onClick={artifactsToggle.toggle}
          />
        )}

        {hasSession && !readOnly && (
          <SessionMenu
            mode={mode}
            onModeChange={onModeChange}
            availableLaunchers={availableLaunchers}
            onFork={onFork}
            onCompact={onCompact}
            onClear={onClear}
            onDelete={onDelete}
            sessionName={sessionName}
          />
        )}
      </div>
    </div>
  );
}

// ===== Segmented context bar =====
//
// Renders the fresh / cache-write / cache-read segments as proportional
// slices of a track. Used twice in ContextPill (mini bar in the pill, larger
// bar in the popover) — extracted to clear the self-clone.
//
// THE TRACK IS A FLEX ROW, AND THAT IS LOAD-BEARING. The segments used to be
// `inline-block` spans, which made them inline content — so they inherited
// `text-align` from their ancestors, and the pill's host is a `<button>`,
// which the UA stylesheet centres. The result: the widths were computed
// correctly and the fill was then painted in the MIDDLE of the track with dead
// space on both sides, so a 19% reading rendered as a ~19%-wide block floating
// at ~40%. It reads as "the bar is wrong" but the arithmetic was never wrong;
// only the packing was. A flex row packs from the main-start edge and cannot
// inherit that, whatever surface the bar is later dropped into.
//
// `flex-none` pins each slice to its computed percentage: flex items are
// shrinkable by default, so once the segments sum near 100% the browser would
// otherwise scale them down and the fill would under-report.

function SegmentedBar({
  segments,
  segColor,
  className,
}: {
  segments: ContextBreakdown["segments"];
  segColor: (kind: ContextBreakdown["segments"][number]["kind"]) => string;
  className: string;
}) {
  return (
    <span className={`flex overflow-hidden bg-fill-active ${className}`}>
      {segments.map((s) =>
        s.pct > 0 ? (
          <span
            key={s.kind}
            className="h-full flex-none"
            style={{ width: `${s.pct}%`, backgroundColor: segColor(s.kind) }}
          />
        ) : null,
      )}
    </span>
  );
}

// ===== Context pill + popover =====

function ContextPill({
  pct,
  segments,
  fill,
  stale,
  totalInput,
  ctxLimit,
  freshInput,
  cacheRead,
  cacheWrite,
  modelName,
  staleCache,
  onClear,
}: {
  pct: number;
  segments: ContextBreakdown["segments"];
  fill: string;
  stale: boolean;
  totalInput: number;
  ctxLimit: number;
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  modelName: string | null;
  staleCache: StaleCacheResult;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useClickAway(rootRef, open, () => setOpen(false));

  const segColor = (kind: ContextBreakdown["segments"][number]["kind"]) => {
    if (kind === "fresh") return fill;
    if (kind === "cacheWrite") return CACHE_WRITE_COLOR;
    return CACHE_READ_COLOR;
  };

  // The trigger and the popover are SIBLINGS under a positioned wrapper, not
  // parent and child. The popover used to be rendered INSIDE the trigger
  // `<button>`, which put a `<button>` (Clear session) inside a `<button>` —
  // invalid HTML that browsers repair by splitting the element, and the reason
  // every interaction inside the panel needed a `stopPropagation` to stop the
  // trigger's own onClick from closing the thing being clicked. Splitting them
  // deletes both problems and the workarounds with them.
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          // The button is the interactive host (click + hover fill); the pill
          // chrome itself lives on the Pill below. `rounded-full` keeps the
          // resting-transparent hover fill capsule-shaped.
          "manta-ctx-pill text-meta rounded-full p-0 border-0 bg-transparent transition-colors " +
          (stale ? "" : "hover:bg-fill-hover")
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        title={stale ? "Context stale — click for details" : "Context usage — click for details"}
      >
        <Pill tone={stale ? "warn" : "neutral"}>
          {/* Mini segmented bar inside the pill — same segment order/colors as
              the popover's bar but at pill scale (w-16 h-2). */}
          <SegmentedBar
            segments={segments}
            segColor={segColor}
            className="w-16 h-2 rounded-full"
          />
          <span
            className="tabular-nums font-mono font-semibold"
            style={{ color: stale ? CACHE_WRITE_COLOR : fill }}
          >
            {pct}%
          </span>
        </Pill>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Context usage"
          className="manta-ctx-popover manta-menu-in absolute right-0 top-full mt-1 z-30 w-[340px] p-4 rounded-lg border border-border bg-bg-soft shadow-md"
        >
          {/* Headline — the percentage leads, the absolute counts qualify it.
              Baseline-aligned so the 15px metric and the 12px mono counts sit
              on one line rather than centring against each other. */}
          <div className="flex items-baseline gap-2 mb-3">
            <span className="text-prose font-semibold text-text leading-none">
              {pct}%
            </span>
            <span className="font-mono text-meta font-medium text-text-faint">
              {formatTokensCompact(totalInput)} / {formatTokensCompact(ctxLimit)} tokens
            </span>
          </div>

          {/* Segmented bar — the pill's mini bar at reading size. */}
          <SegmentedBar
            segments={segments}
            segColor={segColor}
            className="w-full h-[7px] rounded-xs mb-3"
          />

          {/* Legend with per-segment counts. */}
          <div className="flex flex-col gap-1 mb-4">
            <LegendRow
              color={fill}
              label="Fresh input"
              count={freshInput}
              hint="Uncached — billed at the full input rate."
            />
            <LegendRow
              color={CACHE_WRITE_COLOR}
              label="Cache write"
              count={cacheWrite}
              hint="Warming the prompt cache — full input rate plus a surcharge."
            />
            <LegendRow
              color={CACHE_READ_COLOR}
              label="Cache read"
              count={cacheRead}
              hint="Served from the prompt cache — around a tenth of the input rate."
            />
          </div>

          {modelName && (
            <div className="text-meta text-text-faint truncate" title={modelName}>
              Model window · {modelName}
            </div>
          )}

          {/* Stale-cache warning — only when actually stale. The amber tint on
              the pill is the peripheral cue; this is the detail plus the one
              action that resolves it. */}
          {stale && (
            <div className="mt-4 pt-3 border-t border-border-subtle">
              <div className="flex items-center gap-2">
                <span
                  className="grid place-items-center w-[26px] h-[26px] shrink-0 rounded-sm bg-warn-bg text-warn"
                  aria-hidden="true"
                >
                  <Clock size={14} />
                </span>
                <span className="flex-1 min-w-0 text-meta text-text-muted">
                  Cache went stale after {formatIdleDuration(staleCache.idleMs)}{" "}
                  idle — clearing saves{" "}
                  <strong className="font-semibold text-text">
                    {formatTokensCompact(staleCache.staleTokens)}
                  </strong>{" "}
                  tokens on your next message.
                </span>
              </div>
              <div className="mt-3">
                <Button
                  tone="default"
                  block
                  onClick={() => {
                    setOpen(false);
                    onClear();
                  }}
                >
                  Clear session
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// One legend line: swatch, name, count. The per-segment economics live in the
// row's `title` rather than a fourth column — at 340px the hint column was
// truncating to an unreadable stub on every row, which is a worse answer than
// a tooltip on hover.
function LegendRow({
  color,
  label,
  count,
  hint,
}: {
  color: string;
  label: string;
  count: number;
  hint: string;
}) {
  return (
    <div className="flex items-center gap-2 text-meta font-medium" title={hint}>
      <span
        className="w-[9px] h-[9px] rounded-xs shrink-0"
        style={{ backgroundColor: color }}
      />
      <span className="text-text-muted min-w-0 truncate">{label}</span>
      <span className="tabular-nums font-mono text-text-faint ml-auto shrink-0">
        {formatTokensCompact(count)}
      </span>
    </div>
  );
}

// ===== Session menu (MoreHorizontal) =====
//
// Mode switching (Chat / Terminal / one entry per AI-CLI launcher) + the
// session destruction/compact actions. The mode section is the menu's
// functional replacement for the header `<select>` BET-459 removed (BET-467):
// the header glyph only toggles Chat ↔ Terminal, so this is the entry point
// for entering a launcher (`tui:<id>`) mode from the running UI.

// The group label above a run of menu rows. Same chrome as the model menu's
// provider headings (`ModelMenu`'s `providerID` line) so the two dropdowns
// read as one family: 11px letter-spaced uppercase in `--tx3`, on the panel's
// own `p-2` grid rather than the rows' former `px-3`.
const GROUP_LABEL =
  "px-2 pb-2 text-micro font-semibold uppercase text-text-faint select-none";

function SessionMenu({
  mode,
  onModeChange,
  availableLaunchers,
  onFork,
  onCompact,
  onClear,
  onDelete,
  sessionName,
}: {
  mode?: SessionMode;
  onModeChange?: (m: SessionMode) => void;
  availableLaunchers?: AvailableLauncher[];
  onFork: () => void;
  onCompact: () => void;
  onClear: () => void;
  onDelete: () => void;
  // BET-724 §D7: names the session in the Delete confirm's body copy.
  sessionName: string;
}) {
  const [open, setOpen] = useState(false);
  // BET-724 §D7: Delete/Clear from this menu now confirm first, matching the
  // sidebar's inline delete confirm — previously both fired instantly.
  const [confirm, setConfirm] = useState<"delete" | "clear" | null>(null);
  // BET-726 Task 3.1: the roving keyboard highlight, same index-state shape
  // as ModelMenu's highlight loop (chatUtils' moveMenuHighlight) — adapted
  // from ModelMenu's search input to this menu's root div, since there is no
  // input here to hang the keydown on.
  const [highlight, setHighlight] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  useClickAway(rootRef, open, () => setOpen(false));

  // BET-726 review cycle 1 Question 1: the highlight above was visual-only —
  // a screen reader following the arrow keys heard nothing, because DOM
  // focus never leaves the ⋯ trigger (this menu has no input to move focus
  // into, unlike ModelMenu's search box). `aria-activedescendant` on the
  // element that DOES hold focus is exactly ModelMenu's own idiom (its
  // `<input>` carries `aria-activedescendant`, not the Dropdown surface) —
  // applied here to the trigger instead. `useId` keeps ids collision-safe
  // if more than one SessionHeader is ever mounted at once.
  const menuUid = useId();
  const dropdownDomId = `session-menu-${menuUid}`;
  const rowDomId = (rowId: string) => `session-menu-${menuUid}-${rowId.replace(/:/g, "-")}`;

  // Reset the roving highlight each time the menu (re)opens, so a stale
  // index from a previous open never carries over.
  useEffect(() => {
    if (open) setHighlight(-1);
  }, [open]);

  const hasMode = !!onModeChange;
  const isActive = (m: SessionMode) => mode === m;

  // The menu closes after any action; a mode change just re-points mode
  // (a no-op when already in that mode, so re-clicking the current row is a
  // harmless close).
  const switchMode = (m: SessionMode) => {
    if (onModeChange) onModeChange(m);
  };

  // The flat, keyboard-navigable row order — same order the rows render in
  // below, so `highlight`'s index lines up with the rendered row it lights.
  const rowIds: string[] = [
    ...(hasMode
      ? [
          "mode:chat",
          "mode:terminal",
          ...(availableLaunchers ?? []).map((l) => `mode:tui:${l.id}`),
        ]
      : []),
    "fork",
    "compact",
    "clear",
    "delete",
  ];
  const highlightedRow = highlight >= 0 ? rowIds[highlight] : undefined;

  const activateRow = (id: string | undefined) => {
    if (!id) return;
    if (id === "fork") { setOpen(false); onFork(); return; }
    if (id === "compact") { setOpen(false); onCompact(); return; }
    if (id === "clear") { setOpen(false); setConfirm("clear"); return; }
    if (id === "delete") { setOpen(false); setConfirm("delete"); return; }
    if (id.startsWith("mode:")) { setOpen(false); switchMode(id.slice("mode:".length) as SessionMode); }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => moveMenuHighlight(h, 1, rowIds.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => moveMenuHighlight(h, -1, rowIds.length));
    } else if (e.key === "Home") {
      if (rowIds.length > 0) {
        e.preventDefault();
        setHighlight(0);
      }
    } else if (e.key === "End") {
      if (rowIds.length > 0) {
        e.preventDefault();
        setHighlight(rowIds.length - 1);
      }
    } else if (e.key === "Enter") {
      if (highlightedRow) {
        e.preventDefault();
        activateRow(highlightedRow);
      }
    }
    // Escape already closes the menu via useClickAway's document keydown
    // listener (bound above, gated on `open`) — nothing to add here.
  };

  const item = (
    id: string,
    icon: React.ReactElement,
    label: string,
    onClick: () => void,
    danger = false,
  ) => (
    <MenuItem
      id={rowDomId(id)}
      icon={icon}
      variant={danger ? "danger" : "normal"}
      highlighted={highlightedRow === id}
      onSelect={() => {
        setOpen(false);
        onClick();
      }}
    >
      {label}
    </MenuItem>
  );

  const modeItem = (
    id: string,
    icon: React.ReactElement,
    label: string,
    m: SessionMode,
  ) => {
    const active = isActive(m);
    return (
      <MenuItem
        id={rowDomId(id)}
        icon={icon}
        variant={active ? "active" : "normal"}
        highlighted={highlightedRow === id}
        trailing={
          active ? (
            <span className="text-text-faint" aria-hidden="true">
              ✓
            </span>
          ) : undefined
        }
        onSelect={() => {
          setOpen(false);
          switchMode(m);
        }}
      >
        {label}
      </MenuItem>
    );
  };

  return (
    <div ref={rootRef} className="relative shrink-0" onKeyDown={onMenuKeyDown}>
      <IconButton
        icon={<MoreHorizontal />}
        label="Session actions"
        hook="manta-session-menu-trigger"
        onClick={() => setOpen((v) => !v)}
        ariaHaspopup="menu"
        ariaExpanded={open}
        ariaOwns={open ? dropdownDomId : undefined}
        ariaActiveDescendant={open ? (highlightedRow ? rowDomId(highlightedRow) : undefined) : undefined}
      />
      {open && (
        <Dropdown hook="manta-session-menu-dropdown" id={dropdownDomId}>
          {hasMode && (
            <>
              <div className={`${GROUP_LABEL} pt-1`} role="presentation">
                Mode
              </div>
              {modeItem("mode:chat", <MessageSquare size={14} aria-hidden="true" />, "Chat", "chat")}
              {modeItem("mode:terminal", <Terminal size={14} aria-hidden="true" />, "Terminal", "terminal")}
              {availableLaunchers && availableLaunchers.length > 0 && (
                <>
                  <div className={`${GROUP_LABEL} pt-3`} role="presentation">
                    AI-CLI
                  </div>
                  {availableLaunchers.map((l) =>
                    modeItem(
                      `mode:tui:${l.id}`,
                      <Bot size={14} aria-hidden="true" />,
                      l.label,
                      `tui:${l.id}` as SessionMode,
                    ),
                  )}
                </>
              )}
              <div className="my-1 border-t border-border-subtle" role="separator" />
            </>
          )}

          {item(
            "fork",
            <GitFork size={14} aria-hidden="true" />,
            "Fork session",
            onFork,
          )}
          {item(
            "compact",
            <Minimize2 size={14} aria-hidden="true" />,
            "Compact context",
            onCompact,
          )}
          {item(
            "clear",
            <Eraser size={14} aria-hidden="true" />,
            "Clear session",
            () => setConfirm("clear"),
          )}
          <div className="my-1 border-t border-border-subtle" role="separator" />
          {item(
            "delete",
            <Trash2 size={14} aria-hidden="true" />,
            "Delete session",
            () => setConfirm("delete"),
            true,
          )}
        </Dropdown>
      )}
      <ConfirmModal
        open={confirm === "delete"}
        title="Delete this session?"
        body={`“${sessionName}” and its tmux window will be killed on the box. This can't be undone.`}
        confirmLabel="Delete session"
        onConfirm={() => {
          setConfirm(null);
          onDelete();
        }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmModal
        open={confirm === "clear"}
        title="Clear this conversation?"
        body="The session keeps running but its context is gone."
        confirmLabel="Clear"
        onConfirm={() => {
          setConfirm(null);
          onClear();
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
