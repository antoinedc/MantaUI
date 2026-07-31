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

import { useRef, useState } from "react";
import { GitBranch, MoreHorizontal, GitFork, Minimize2, Eraser, Trash2 } from "lucide-react";
import {
  ctxStageColor,
  cssVar,
  type ContextBreakdown,
  type StaleCacheResult,
} from "./chatUtils";
import { useClickAway } from "./hooks/useClickAway";

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
  onFork,
  onCompact,
  onClear,
  onDelete,
}: {
  branch: string | null;
  ctxBreakdown: ContextBreakdown;
  ctxLimit: number;
  staleCache: StaleCacheResult;
  modelName: string | null;
  // When false (no owning tmux window) the session menu is hidden — fork /
  // clear / delete all need a tmux window to target.
  hasSession: boolean;
  onFork: () => void;
  onCompact: () => void;
  onClear: () => void;
  onDelete: () => void;
}) {
  const { pct, segments, freshInput, cacheRead, cacheWrite, totalInput } =
    ctxBreakdown;
  const fill = ctxStageColor(pct);
  const showContext = totalInput > 0;
  const stale = staleCache.isStale;

  return (
    <div className="manta-session-header flex items-center gap-2 px-4 h-12 border-b border-border shrink-0">
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

      {/* Context pill — clickable, opens the breakdown popover. Amber tint
          when the cache is stale so the user has a peripheral signal before
          clicking. */}
      <div className="ml-auto flex items-center gap-2">
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

        {/* Session menu — Fork / Compact / Clear / Delete. No badge on the
            button (per BET-415 Do-NOT #2). Hidden when there is no owning
            tmux window. */}
        {hasSession && (
          <SessionMenu
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
        "manta-ctx-pill inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-meta transition-colors " +
        (stale
          ? "bg-warn-bg hover:bg-warn-bg"
          : "hover:bg-fill")
      }
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
                className="px-2 py-0.5 rounded text-bg text-meta font-medium"
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

function SessionMenu({
  onFork,
  onCompact,
  onClear,
  onDelete,
}: {
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
        "w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-bg-soft text-meta " +
        (danger ? "text-danger hover:bg-danger-bg" : "text-text")
      }
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div ref={rootRef} className="manta-session-menu relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="manta-session-menu-trigger text-text-faint hover:text-text rounded p-1 inline-flex items-center"
        title="Session actions"
        aria-label="Session actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          className="manta-session-menu-dropdown absolute right-0 top-full mt-1 z-30 min-w-[180px] rounded-lg border border-border bg-bg-elev shadow-md py-1"
        >
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
