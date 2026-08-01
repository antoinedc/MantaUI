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

import { useRef, useState, type CSSProperties } from "react";
import { GitBranch, MoreHorizontal, GitFork, Minimize2, Eraser, Trash2, Terminal, Bot, MessageSquare } from "lucide-react";
import {
  ctxStageColor,
  cssVar,
  type ContextBreakdown,
  type StaleCacheResult,
} from "./chatUtils";
import { useClickAway } from "./hooks/useClickAway";
import type { SessionMode } from "./chatShared";
import type { AvailableLauncher } from "../shared/types";
import { IconButton } from "./IconButton";

// Cache-segment colors — same palette as ContextBar so the header pill and
// the (retired) footer bar stay in sync visually.
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
}) {
  const { pct, segments, freshInput, cacheRead, cacheWrite, totalInput } =
    ctxBreakdown;
  const fill = ctxStageColor(pct);
  const showContext = totalInput > 0;
  const stale = staleCache.isStale;
  const crumb = breadcrumb
    ? breadcrumb.window
      ? `${breadcrumb.project} / ${breadcrumb.window}`
      : breadcrumb.project
    : "";
  // The mode toggle is a single terminal glyph (BET-459): the accessible name
  // names the mode you'll switch TO, so it stays nameable in the structure
  // snapshot ("Terminal" from chat, "Chat" from terminal).
  const isTerminal = mode === "terminal";
  const targetMode: SessionMode = isTerminal ? "chat" : "terminal";
  const modeLabel = isTerminal ? "Chat" : "Terminal";

  return (
    <div
      className="manta-session-header flex items-center gap-2 h-11 px-3 border-b border-border shrink-0 min-w-0"
      style={{ WebkitAppRegion: "drag" } as CSSProperties}
    >
      {/* Breadcrumb — project / window (the cwd path was dropped, BET-459) */}
      {crumb && (
        <span
          className="manta-session-crumb text-label text-text-faint shrink-0 truncate max-w-[200px]"
          title={crumb}
        >
          {crumb}
        </span>
      )}

      {/* Branch chip — session state, lives in the header not the composer. */}
      {branch && (
        <span
          className="manta-session-branch text-text-faint font-mono shrink-0 truncate max-w-[200px] inline-flex items-center gap-1"
          title={`Current branch: ${branch}`}
        >
          <GitBranch size={14} aria-hidden="true" className="shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      )}

      {/* Right group — context pill, mode toggle, session menu (8px items).
            opt out of the header's drag region so they stay clickable. The
            left cluster (breadcrumb + branch) is separated from this group by
            the 16px group gap the auto-margin reserves. */}
      <div
        className="ml-auto flex items-center gap-2"
        style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
      >
        {/* Context pill — clickable, opens the breakdown popover. Amber tint
            when the cache is stale so the user has a peripheral signal before
            clicking. */}
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

        {/* Mode toggle (BET-459): a terminal glyph that swaps Chat ↔
            Terminal — the presentation of the old mode <select>, keeping its
            accessible name. Omitted when the caller owns mode elsewhere
            (mobile SessionScreen has its own toggle). */}
        {onModeChange && (
          <IconButton
            icon={<Terminal />}
            label={modeLabel}
            title={`Switch to ${modeLabel}`}
            hook="manta-session-mode-toggle"
            onClick={() => onModeChange(targetMode)}
          />
        )}

        {/* Session menu — mode (Chat / Terminal / AI-CLI launchers) + Fork /
            Compact / Clear / Delete. No badge on the button (per BET-415
            Do-NOT #2). Hidden when there is no owning tmux window, and when
            the view is read-only (BET-418 §D: a background-job session — Stop
            in ReadOnlyJobBar is the only live action). */}
        {hasSession && !readOnly && (
          <SessionMenu
            mode={mode}
            onModeChange={onModeChange}
            availableLaunchers={availableLaunchers}
            onFork={onFork}
            onCompact={onCompact}
            onClear={onClear}
            onDelete={onDelete}
          />
        )}
      </div>
    </div>
  );
}

// ===== Segmented context bar =====
//
// Renders the fresh / cache-write / cache-read segments as proportional
// inline slices of a track. Used twice in ContextPill (mini bar in the pill,
// larger bar in the popover) — extracted to clear the self-clone.

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
    <span className={className} style={{ backgroundColor: "var(--card)" }}>
      {segments.map((s, i) =>
        s.pct > 0 ? (
          <span
            key={s.kind}
            className="inline-block h-full align-top"
            style={{
              width: `${s.pct}%`,
              backgroundColor: segColor(s.kind),
              boxShadow: i > 0 ? "inset 1px 0 0 rgba(0,0,0,0.35)" : undefined,
            }}
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
  const rootRef = useRef<HTMLButtonElement>(null);
  useClickAway(rootRef, open, () => setOpen(false));

  const segColor = (kind: ContextBreakdown["segments"][number]["kind"]) => {
    if (kind === "fresh") return fill;
    if (kind === "cacheWrite") return CACHE_WRITE_COLOR;
    return CACHE_READ_COLOR;
  };

  return (
    <button
      ref={rootRef}
      type="button"
      onClick={() => setOpen((v) => !v)}
      className={
        "manta-ctx-pill inline-flex items-center gap-2 rounded-full px-2 py-px text-meta transition-colors " +
        (stale
          ? "bg-warn-bg hover:bg-warn-bg"
          : "hover:bg-fill-hover")
      }
      aria-haspopup="dialog"
      aria-expanded={open}
      title={stale ? "Context stale — click for details" : "Context usage — click for details"}
    >
      {/* Mini segmented bar inside the pill — same segment order/colors as
          ContextBar but at pill scale (w-16 h-2). */}
      <SegmentedBar
        segments={segments}
        segColor={segColor}
        className="manta-ctx-track inline-block w-16 h-2 rounded-full overflow-hidden align-middle"
      />
      <span
        className="tabular-nums text-meta font-mono font-semibold"
        style={{ color: stale ? CACHE_WRITE_COLOR : fill }}
      >
        {pct}%
      </span>

      {open && (
        <span
          className="manta-ctx-popover absolute right-0 top-full mt-1 z-30 w-80 rounded-lg border border-border bg-bg-elev shadow-md text-meta text-text"
          // Stop the pill's onClick from toggling when interacting with the
          // popover contents (it's inside the button element).
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header line */}
          <div className="px-3 py-2 border-b border-border font-medium">
            {totalInput.toLocaleString()} / {ctxLimit.toLocaleString()} tokens
            <span className="text-text-faint ml-1">({pct}%)</span>
          </div>

          {/* Segmented bar — larger version for the popover */}
          <div className="px-3 py-2">
            <SegmentedBar
              segments={segments}
              segColor={segColor}
              className="inline-block w-full h-3 rounded overflow-hidden"
            />
          </div>

          {/* Legend with per-segment counts */}
          <div className="px-3 pb-2 space-y-1">
            <LegendRow
              color={fill}
              label="Fresh input"
              count={freshInput}
              hint="uncached, paid full rate"
            />
            <LegendRow
              color={CACHE_WRITE_COLOR}
              label="Cache write"
              count={cacheWrite}
              hint="warm-up, full rate + surcharge"
            />
            <LegendRow
              color={CACHE_READ_COLOR}
              label="Cache read"
              count={cacheRead}
              hint="cached, ~10% cost"
            />
          </div>

          {modelName && (
            <div className="px-3 pb-2 text-text-faint">
              Model window: {modelName}
            </div>
          )}

          {/* Stale-cache warning — only when actually stale. The amber tint
              on the pill above is the peripheral cue; this is the detail +
              the Clear-session action. */}
          {stale && (
            <div className="px-3 py-2 border-t border-border bg-warn-bg">
              <div className="text-warn font-medium mb-1">
                ⚠ Prompt cache expired
              </div>
              <div className="text-text-muted mb-2">
                Session idle for {formatIdleDuration(staleCache.idleMs)}.
                {" "}
                {formatTokensCompact(staleCache.staleTokens)} tokens currently in
                cache will be re-billed as cache_creation_input_tokens on your
                next message (full input rate + 25% surcharge).
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  onClear();
                }}
                className="px-2 py-px rounded text-bg text-meta font-medium"
                style={{ backgroundColor: "var(--warn)" }}
              >
                Clear session
              </button>
            </div>
          )}
        </span>
      )}
    </button>
  );
}

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
    <div className="flex items-center gap-2">
      <span
        className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
        style={{ backgroundColor: color }}
      />
      <span className="text-text min-w-0">{label}</span>
      <span className="tabular-nums text-text-faint ml-auto shrink-0">
        {count.toLocaleString()}
      </span>
      <span className="text-text-faint text-label truncate max-w-[120px]" title={hint}>
        {hint}
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

function SessionMenu({
  mode,
  onModeChange,
  availableLaunchers,
  onFork,
  onCompact,
  onClear,
  onDelete,
}: {
  mode?: SessionMode;
  onModeChange?: (m: SessionMode) => void;
  availableLaunchers?: AvailableLauncher[];
  onFork: () => void;
  onCompact: () => void;
  onClear: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useClickAway(rootRef, open, () => setOpen(false));

  const item = (
    icon: React.ReactNode,
    label: string,
    onClick: () => void,
    danger = false,
  ) => (
    <button
      type="button"
      onClick={() => {
        setOpen(false);
        onClick();
      }}
      className={
        "w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-bg-soft text-meta " +
        (danger ? "text-danger hover:bg-danger-bg" : "text-text")
      }
    >
      {icon}
      {label}
    </button>
  );

  // The menu closes after any action; a mode change just re-points mode
  // (a no-op when already in that mode, so re-clicking the current row is a
  // harmless close).
  const switchMode = (m: SessionMode) => {
    if (onModeChange) onModeChange(m);
  };

  const isActive = (m: SessionMode) => mode === m;

  const modeItem = (
    icon: React.ReactNode,
    label: string,
    m: SessionMode,
  ) => {
    const active = isActive(m);
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          switchMode(m);
        }}
        className={
          "w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-bg-soft text-meta " +
          (active ? "text-accent" : "text-text")
        }
      >
        {icon}
        <span className="flex-1">{label}</span>
        {active && <span className="text-text-faint" aria-hidden="true">✓</span>}
      </button>
    );
  };

  const hasMode = !!onModeChange;

  return (
    <div ref={rootRef} className="manta-session-menu relative shrink-0">
      <IconButton
        icon={<MoreHorizontal />}
        label="Session actions"
        hook="manta-session-menu-trigger"
        onClick={() => setOpen((v) => !v)}
        ariaHaspopup="menu"
        ariaExpanded={open}
      />
      {open && (
        <div
          role="menu"
          className="manta-session-menu-dropdown absolute right-0 top-full mt-1 z-30 min-w-[180px] rounded-lg border border-border bg-bg-elev shadow-md py-1"
        >
          {hasMode && (
            <>
              <div className="px-3 pt-1 pb-0.5 text-label text-text-faint select-none" role="presentation">
                Mode
              </div>
              {modeItem(<MessageSquare size={14} aria-hidden="true" />, "Chat", "chat")}
              {modeItem(<Terminal size={14} aria-hidden="true" />, "Terminal", "terminal")}
              {availableLaunchers && availableLaunchers.length > 0 && (
                <>
                  <div className="px-3 pt-2 pb-0.5 text-label text-text-faint select-none" role="presentation">
                    AI-CLI
                  </div>
                  {availableLaunchers.map((l) =>
                    modeItem(
                      <Bot size={14} aria-hidden="true" />,
                      l.label,
                      `tui:${l.id}` as SessionMode,
                    ),
                  )}
                </>
              )}
              <div className="my-1 border-t border-border" />
            </>
          )}

          {item(
            <GitFork size={14} aria-hidden="true" />,
            "Fork session",
            onFork,
          )}
          {item(
            <Minimize2 size={14} aria-hidden="true" />,
            "Compact context",
            onCompact,
          )}
          {item(
            <Eraser size={14} aria-hidden="true" />,
            "Clear session",
            onClear,
          )}
          <div className="my-1 border-t border-border" />
          {item(
            <Trash2 size={14} aria-hidden="true" />,
            "Delete session",
            onDelete,
            true,
          )}
        </div>
      )}
    </div>
  );
}
