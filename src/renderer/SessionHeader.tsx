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

import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { GitBranch, MoreHorizontal, GitFork, Minimize2, Eraser, Trash2, Terminal, Bot, MessageSquare, Clock, PanelRight, Loader2 } from "lucide-react";
import {
  ctxStageColor,
  cssVar,
  moveMenuHighlight,
  selectStatusItems,
  checksChipDescriptor,
  countsForChecks,
  checkTone,
  orderChecks,
  shouldOfferForgeConnect,
  failuresToAgentPrompt,
  branchPanelState,
  resolveShipState,
  ShipState,
  canMerge,
  type ChecksChipTone,
  type ContextBreakdown,
  type StaleCacheResult,
  type StatusItem,
} from "./chatUtils";
import type { SessionMode } from "./chatShared";
import type { AvailableLauncher, CheckRollup, ForgeCheckRun, PullRequest } from "../shared/types";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { Pill } from "./Pill";
import { Tag } from "./Tag";
import { Chip } from "./Chip";
import { StatusDot } from "./StatusDot";
import { Callout } from "./Callout";
import { ForgeMark, hasForgeMark } from "./ForgeMark";
import { Dropdown, MenuItem } from "./MenuItem";
import { Popover } from "./Popover";
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
  hiddenStatusItems,
  pr,
  checks,
  checksRollup,
  forgeConnected,
  forgeKind,
  forgeConnectOfferDismissed,
  onOpenExternal,
  onReviewChanges,
  onFillComposer,
  onDismissForgeConnect,
  onConnectForge,
  onMerge,
  mergeBusy,
  mergeError,
  shipBusy,
  shipError,
  shipBase,
  shipFileCount,
  shipTitle,
  justShipped,
  base,
  aheadCount,
  onCreatePr,
  onEnsureShipPreview,
}: {
  branch: string | null;
  ctxBreakdown: ContextBreakdown;
  ctxLimit: number | null;
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
  // BET-782: ids of registry items the user has permanently hidden (see
  // AppConfig.hiddenStatusItems). An id in this list is never rendered, in the
  // bar or the overflow. Optional so the prop doesn't break callers that
  // haven't wired the setting yet.
  hiddenStatusItems?: string[];
  // BET-789: forge read path, consumed from ChatPanel (which owns the fetch)
  // and threaded down so this component stays presentational. `pr` + `checks`
  // + `checksRollup` drive the PR-on-branch suffix and the checks chip;
  // `forgeConnected` + the session origin's `forgeKind` + the permanently-
  // dismissed flag drive the one-line connect offer. All optional with
  // forge-absent defaults so non-forge callers (tests, mobile) stay
  // byte-identical to today.
  pr?: PullRequest | null;
  checks?: ForgeCheckRun[];
  checksRollup?: CheckRollup;
  forgeConnected?: boolean;
  forgeKind?: string | null;
  forgeConnectOfferDismissed?: boolean;
  onOpenExternal?: (url: string) => void;
  // BET-869: from the PR-present branch popover, "Review changes" opens the
  // artifacts panel on its Review tab. ChatPanel wires this to the
  // `manta-open-review` window event.
  onReviewChanges?: () => void;
  onFillComposer?: (text: string) => void;
  onDismissForgeConnect?: () => void;
  // BET-943: wires the ConnectOffer's "Connect" chip. When omitted (tests,
  // non-forge callers), the offer renders the × only — a chip that looks like
  // a button and does nothing is the bug this issue fixes.
  onConnectForge?: () => void;
  // BET-867: the branch chip's popover is the ONE git surface. Merge + ship
  // live here now (the pinned forge card is deleted), so ChatPanel threads the
  // ship/merge state + handlers down. All optional so non-forge callers / tests
  // stay byte-identical.
  onMerge?: () => void;
  mergeBusy?: boolean;
  mergeError?: string | null;
  shipBusy?: boolean;
  shipError?: string | null;
  // The ship preview's default base branch + file count (fetched once when the
  // no-PR popover opens). null while the preview is still loading → rows render
  // "—".
  shipBase?: string | null;
  shipFileCount?: number | null;
  // The ship preview's resolved PR title. NULL means the preview has not landed
  // yet (the box drafts it with the session's model, out of band) — the popover
  // shows a skeleton and holds the Create button disabled until it arrives.
  shipTitle?: string | null;
  // True for a few seconds after a PR is created from this popover, so the PR
  // state can affirm what just happened instead of silently swapping.
  justShipped?: boolean;
  // The ship gate (BET-892): the session's current branch, the repo default
  // base branch, and commits ahead — supplied by the forge:pull-request poll
  // (no second poll) so the popover can decide whether a Create-PR action is
  // even shown before anything is clicked.
  base?: string | null;
  aheadCount?: number | null;
  // Opens the (single) Create-PR confirmation. Optional so non-forge callers /
  // tests stay byte-identical.
  onCreatePr?: () => void;
  onEnsureShipPreview?: () => void;
}) {
  const { pct, hasLimit, segments, freshInput, cacheRead, cacheWrite, totalInput } =
    ctxBreakdown;
  const fill = ctxStageColor(hasLimit && pct !== null ? pct : 0);
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
  // BET-968: the single confirm-dialog state. Clear has TWO triggers (the
  // context pill's stale-cache block and the ⋯ menu) and Delete has one — both
  // dialogs are hoisted here so SessionMenu stops owning dialog state and the
  // stale-cache "Clear session" path (previously instant) now confirms.
  const [confirm, setConfirm] = useState<"clear" | "delete" | null>(null);

  // BET-789: the checks chip is the ONE new status item, registered only when
  // there is a PR with checks and a non-empty rollup. No PR / no checks / forge
  // not connected → the descriptor is null → nothing is registered (§4.3 [C2]):
  // connecting GitHub adds no chrome by itself.
  const checksCounts = countsForChecks(checks ?? []);
  const checksDesc =
    pr && checks && checks.length > 0
      ? checksChipDescriptor(checksRollup ?? "none", checksCounts)
      : null;
  // The one-line connect offer — only in a forge-origin session while the
  // forge is disconnected and the offer has not been permanently dismissed.
  const offerConnect = shouldOfferForgeConnect({
    connected: forgeConnected ?? false,
    forgeKind: forgeKind ?? null,
    dismissed: forgeConnectOfferDismissed ?? false,
  });

  // BET-867: the one decision driving the branch chip — plain non-interactive
  // Tag (no branch / no forge) vs. the interactive branch popover in its
  // no-PR or PR state.
  const branchState = branchPanelState({
    pr: pr ?? null,
    forgeConnected: forgeConnected ?? false,
    branch,
  });

  // ===== Status-item registry (BET-782) =====
  // The right group is a REGISTRY, not hand-ordered JSX. Each entry is a
  // stable id + priority + render function; `selectStatusItems` (chatUtils)
  // sorts descending by priority and decides, for the measured pane width +
  // the user's hide list, what renders in the bar vs the `⋯ +N` overflow.
  // `branch` and `breadcrumb` stay in the LEFT group and are NOT registered.
  const headerRef = useRef<HTMLDivElement>(null);
  // The cut container width, measured by a ResizeObserver on the header
  // element (BET-811). The pre-BET-811 per-render layout-effect re-measure went
  // stale the moment the pane resized without a React re-render (OS-window
  // resize, sidebar-splitter drag) — the exact case the overflow exists for.
  // The observer reacts to any size change of the header itself, whatever the
  // cause, so the cut stays current under both React and non-React resizes.
  // This measures the PANE, not the viewport — the container-query spirit the
  // original rule (forbid window.innerWidth / media query) was written to
  // enforce. A zero/unknown width (jsdom, pre-layout) is treated as "everything
  // fits" to preserve today's wide-width render.
  const [paneWidth, setPaneWidth] = useState<number>(Infinity);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      const effective = w > 0 ? w : Infinity;
      setPaneWidth((prev) => (prev === effective ? prev : effective));
    };
    // Measure once so the first render reflects the actual width — the observer
    // only fires on a subsequent change.
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const registry: StatusItem[] = [];
  // Checks sits FIRST in construction order so it is the leftmost item of the
  // right group at wide widths (§4.5① [C3]: checks, context, artifacts, menu).
  // Its priority is a function of state (§4.3): red is pinned (never auto-hidden,
  // so it survives the narrow layout while the branch chip is displaced), green/
  // yellow overflow first.
  if (checksDesc) {
    registry.push({
      id: "checks",
      priority: checksDesc.priority,
      render: () => (
        <ChecksChip
          descriptor={checksDesc}
          checks={checks ?? []}
          pr={pr ?? null}
          forgeKind={forgeKind ?? null}
          onOpenExternal={onOpenExternal}
          onFillComposer={onFillComposer}
        />
      ),
    });
  }
  if (showContext) {
    registry.push({
      id: "context",
      priority: 60,
      render: () => (
        <ContextPill
          pct={pct}
          hasLimit={hasLimit}
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
          onRequestClear={() => setConfirm("clear")}
        />
      ),
    });
  }
  if (artifactsToggle) {
    registry.push({
      id: "artifacts",
      priority: 80,
      render: () => (
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
      ),
    });
  }
  if (hasSession && !readOnly) {
    registry.push({
      id: "menu",
      priority: 100,
      render: () => (
        <SessionMenu
          mode={mode}
          onModeChange={onModeChange}
          availableLaunchers={availableLaunchers}
          onFork={onFork}
          onCompact={onCompact}
          onRequestClear={() => setConfirm("clear")}
          onRequestDelete={() => setConfirm("delete")}
        />
      ),
    });
  }

  const { visible, overflow } = selectStatusItems(
    registry,
    paneWidth,
    hiddenStatusItems ?? [],
  );

  return (
    <>
      <div
        ref={headerRef}
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
            metadata beside the breadcrumb rather than as a control. When the
            forge is connected the chip opens the ONE git surface — the branch
            popover [BET-867] — carrying either the PR (merge surface) or the
            Create-PR offer gated on branch state (BET-892); a scratch dir
            with no forge keeps the plain non-interactive Tag (byte-identical
            to today). */}
      {branchState !== "none" ? (
        <BranchChip
          branch={branch ?? ""}
          pr={pr ?? null}
          checksRollup={checksRollup ?? "none"}
          mergeBusy={mergeBusy ?? false}
          mergeError={mergeError ?? null}
          onMerge={onMerge}
          shipBusy={shipBusy ?? false}
          shipError={shipError ?? null}
          shipBase={shipBase ?? null}
          shipFileCount={shipFileCount ?? null}
          shipTitle={shipTitle ?? null}
          justShipped={justShipped ?? false}
          forgeKind={forgeKind ?? null}
          base={base ?? null}
          aheadCount={aheadCount ?? null}
          onCreatePr={onCreatePr}
          onEnsureShipPreview={onEnsureShipPreview}
          onOpenExternal={onOpenExternal}
          onReviewChanges={onReviewChanges}
        />
      ) : branch ? (
        <Tag
          size="sm"
          icon={<GitBranch size={11} aria-hidden="true" className="shrink-0" />}
          title={`Current branch: ${branch}`}
        >
            <span className="shrink-0 truncate max-w-[200px]">{branch}</span>
          </Tag>
        ) : null}

      {/* Right group — the registry's visible items + the overflow trigger.
            Order preserves today's wide-width visual (context, artifacts,
            menu — acceptance #1); priority drives only the overflow cut.
            Opts out of the header's drag region so the controls stay
            clickable. */}
      <div
        className="ml-auto flex items-center gap-2"
        style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
      >
        {visible.map((it) => (
          <Fragment key={it.id}>{it.render()}</Fragment>
        ))}

        {overflow.length > 0 && <StatusOverflow items={overflow} />}
      </div>
      </div>

      {/* BET-789 §4.5 [S10]: the one-line contextual connect offer, under the
            header bar (never a modal / toast / Settings badge). Only in a
            forge-origin session while disconnected and not dismissed. */}
      {offerConnect && (
        <ConnectOffer onDismiss={onDismissForgeConnect} onConnect={onConnectForge} />
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
    </>
  );
}

// ===== Right-group overflow (BET-782) =====
//
// The `⋯ +N` trigger + Dropdown that holds registry items the pane is too
// narrow to show in the bar. It is a SEPARATE control from the session `⋯`
// menu — they are never merged. N is the hidden count, which the spec insists
// on ("a bare ⋯ is explicitly wrong — the count is the point").
function StatusOverflow({ items }: { items: StatusItem[] }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${items.length} more status item${items.length === 1 ? "" : "s"}`}
        title={`${items.length} more status item${items.length === 1 ? "" : "s"}`}
        className="manta-status-overflow-trigger inline-flex items-center gap-1 rounded-md p-1 text-text-faint hover:bg-fill-hover hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        <MoreHorizontal size={16} aria-hidden="true" />
        <span className="text-meta font-semibold tabular-nums">+{items.length}</span>
      </button>
      {/* Portalled via Dropdown → Popover, so this surface is never clipped by
          the overflow menu that hosts these items at narrow pane widths. */}
      <Dropdown
        hook="manta-status-overflow-dropdown"
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
      >
        {items.map((it) => (
          <div key={it.id} className="px-1 py-1">
            {it.render()}
          </div>
        ))}
      </Dropdown>
    </>
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
  hasLimit,
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
  onRequestClear,
}: {
  pct: number | null;
  hasLimit: boolean;
  segments: ContextBreakdown["segments"];
  fill: string;
  stale: boolean;
  totalInput: number;
  ctxLimit: number | null;
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  modelName: string | null;
  staleCache: StaleCacheResult;
  onRequestClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const segColor = (kind: ContextBreakdown["segments"][number]["kind"]) => {
    if (kind === "fresh") return fill;
    if (kind === "cacheWrite") return CACHE_WRITE_COLOR;
    return CACHE_READ_COLOR;
  };

  return (
    <>
      <button
        ref={triggerRef}
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
        title={
          stale
            ? `Cache cold — ${formatTokensCompact(staleCache.staleTokens)} tokens re-billed on your next message. Click for details`
            : "Context usage — click for details"
        }
      >
        <Pill tone={stale ? "warn" : "neutral"}>
          {hasLimit ? (
            <>
              {/* Mini segmented bar inside the pill — same segment order/colors
                  as the popover's bar but at pill scale (w-16 h-2 rounded-full). */}
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
            </>
          ) : (
            // Unknown context window — a solid full-width green fill with no
            // percentage (rendering one would fabricate a number).
            <span
              className="w-16 h-2 rounded-full"
              style={{ backgroundColor: fill }}
            />
          )}
          {stale && (
            <span className="tabular-nums font-mono font-semibold">
              {formatTokensCompact(staleCache.staleTokens)} cold
            </span>
          )}
        </Pill>
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        role="dialog"
        ariaLabel="Context usage"
        hook="manta-ctx-popover"
        surfaceClassName="w-[340px] p-4"
      >
          {hasLimit ? (
            <>
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
            </>
          ) : (
            // Unknown context window — no fabricated percentage is ever shown.
            // Surface the "no max context" message plus the tokens-used totals
            // (reusing the breakdown's computed counts) with no bar and no %.
            <div className="flex flex-col gap-1 mb-4">
              <div className="text-prose font-semibold text-text mb-2">
                No max context info for this model
              </div>
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
          )}

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
                    onRequestClear();
                  }}
                >
                  Clear session
                </Button>
              </div>
            </div>
          )}
      </Popover>
    </>
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
  onRequestClear,
  onRequestDelete,
}: {
  mode?: SessionMode;
  onModeChange?: (m: SessionMode) => void;
  availableLaunchers?: AvailableLauncher[];
  onFork: () => void;
  onCompact: () => void;
  onRequestClear: () => void;
  onRequestDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // WAI-ARIA menu-button pattern (BET-741): real DOM focus replaces the
  // BET-726 active-descendant stand-in (a role="button" can't carry one).
  // On open, focus moves into the
  // `role="menu"` surface; the arrow keys rove across the `role="menuitem"`
  // rows (roving tabIndex: the focused row is the only tabbable one) and the
  // visual highlight is MenuItem's own `:focus` fill — no highlight state.
  // `focusedIndexRef` tracks the roved row so tabIndex can rove with it.
  const focusedIndexRef = useRef(-1);

  const menuRows = () =>
    Array.from(
      panelRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]') ?? [],
    );

  // Focus the row at `idx` (wrapping handled by the caller) and rove
  // tabIndex so only it is tabbable while the menu is open.
  const focusRow = (idx: number) => {
    const rows = menuRows();
    const prev = rows[focusedIndexRef.current];
    const next = rows[idx];
    if (prev && prev !== next) prev.tabIndex = -1;
    if (next) next.tabIndex = 0;
    next?.focus();
    focusedIndexRef.current = idx;
  };

  // On open, move focus into the menu surface and reset the roving tabIndex
  // so no stale row from a previous open is left tabbable. Focus lands on the
  // surface, not a row; the first arrow key then drops it onto a row.
  useEffect(() => {
    if (!open) return;
    const menu = panelRef.current;
    menu?.querySelectorAll('button[role="menuitem"]').forEach((el) => {
      (el as HTMLButtonElement).tabIndex = -1;
    });
    focusedIndexRef.current = -1;
    if (menu) {
      menu.tabIndex = -1;
      menu.focus();
    }
  }, [open]);

  const hasMode = !!onModeChange;
  const isActive = (m: SessionMode) => mode === m;

  // The menu closes after any action; a mode change just re-points mode
  // (a no-op when already in that mode, so re-clicking the current row is a
  // harmless close).
  const switchMode = (m: SessionMode) => {
    if (onModeChange) onModeChange(m);
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    const rows = menuRows();
    if (rows.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(moveMenuHighlight(focusedIndexRef.current, 1, rows.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(moveMenuHighlight(focusedIndexRef.current, -1, rows.length));
    } else if (e.key === "Home") {
      e.preventDefault();
      focusRow(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusRow(rows.length - 1);
    } else if (e.key === "Enter") {
      // Activate the focused row the same path a click takes: rows are real
      // `<button role="menuitem">`, so Enter natively fires the focused
      // button's click → onSelect → closes + activates. Guard on focus
      // actually being on a row — right after open (surface focused, nothing
      // roved yet) Enter is ignored, matching the pre-BET-741 behaviour where
      // Enter with no highlight did nothing.
      const focused = rows[focusedIndexRef.current];
      if (focused && document.activeElement === focused) {
        e.preventDefault();
        focused.click();
      }
    }
    // Escape is Popover's job now (closes + returns focus to the trigger).
  };

  const item = (
    icon: React.ReactElement,
    label: string,
    onClick: () => void,
    danger = false,
  ) => (
    <MenuItem
      icon={icon}
      variant={danger ? "danger" : "normal"}
      onSelect={() => {
        setOpen(false);
        onClick();
      }}
    >
      {label}
    </MenuItem>
  );

  const modeItem = (
    icon: React.ReactElement,
    label: string,
    m: SessionMode,
  ) => {
    const active = isActive(m);
    return (
      <MenuItem
        icon={icon}
        variant={active ? "active" : "normal"}
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
    <>
      <IconButton
        buttonRef={triggerRef}
        icon={<MoreHorizontal />}
        label="Session actions"
        hook="manta-session-menu-trigger"
        onClick={() => setOpen((v) => !v)}
        ariaHaspopup="menu"
        ariaExpanded={open}
      />
      <Dropdown
        hook="manta-session-menu-dropdown"
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        panelRef={panelRef}
        onKeyDown={onMenuKeyDown}
      >
        {hasMode && (
          <>
            <div className={`${GROUP_LABEL} pt-1`} role="presentation">
              Mode
            </div>
            {modeItem(<MessageSquare size={14} aria-hidden="true" />, "Chat", "chat")}
            {modeItem(<Terminal size={14} aria-hidden="true" />, "Terminal", "terminal")}
            {availableLaunchers && availableLaunchers.length > 0 && (
              <>
                <div className={`${GROUP_LABEL} pt-3`} role="presentation">
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
            <div className="my-1 border-t border-border-subtle" role="separator" />
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
          onRequestClear,
        )}
        <div className="my-1 border-t border-border-subtle" role="separator" />
        {item(
          <Trash2 size={14} aria-hidden="true" />,
          "Delete session",
          onRequestDelete,
          true,
        )}
      </Dropdown>
    </>
  );
}

// ===== Click-popover chips (BET-789) =====
//
// The interactive header chips (branch with a PR, and the checks chip) are now
// plain trigger buttons + a `Popover`: the shared PopoverChip shell that used
// to own the wrapper, click-away, Escape-focus and the panel surface is gone
// (BET-865) — Popover owns all of that. Each chip keeps its own trigger button
// chrome; the portalled panel exists only while open.

// ===== Branch + PR popover chip (BET-789 [C3] [C7] → BET-867) =====
//
// The branch chip is the ONE git surface: the PR rides the branch (an
// attribute, not a peer — no second PR chip). With the forge connected it
// opens the branch popover in two states — the branch has a PR ([F1]: title,
// state, refs, reviewers, threads, mergeability + Merge / Review changes /
// open-on-forge), or it does not ([F2]: the ship gate gated on branch state —
// BET-892: Base / Changes + a single primary Create pull request when ready,
// or "Nothing to ship" on the base branch, detached HEAD, unknown base, or no-
// commits-ahead). BET-867 is an
// owner-approved departure from BET-789's [C2]: the no-PR branch now opens a
// popover where it previously stayed a plain non-interactive Tag; a scratch dir
// with no forge keeps the Tag unchanged (branchPanelState == "none").
//
// The panel props are shared by BranchChip and BranchPanel (the chip passes
// them straight through) — one type, no parallel re-declaration.
type BranchPanelProps = {
  branch: string;
  pr: PullRequest | null;
  checksRollup: CheckRollup;
  mergeBusy: boolean;
  mergeError: string | null;
  onMerge?: () => void;
  shipBusy: boolean;
  shipError: string | null;
  shipBase: string | null;
  shipFileCount: number | null;
  shipTitle: string | null;
  justShipped: boolean;
  forgeKind: string | null;
  base: string | null;
  aheadCount: number | null;
  onCreatePr?: () => void;
  onOpenExternal?: (url: string) => void;
  onReviewChanges?: () => void;
};

function BranchChip({
  onEnsureShipPreview,
  ...panelProps
}: BranchPanelProps & { onEnsureShipPreview?: () => void }) {
  const { branch, pr } = panelProps;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const label = pr
    ? `Pull request #${pr.number}: ${pr.title}`
    : `Current branch: ${branch}`;
  // The no-PR state shows the ship preview (Base / Changes); fetch it once
  // when the popover opens — click-only surface, never polled.
  useEffect(() => {
    if (open && !pr) onEnsureShipPreview?.();
  }, [open, pr, onEnsureShipPreview]);
  return (
    <>
      {/* The chip sits in the header's drag region (the left group), so the
          trigger opts OUT of it to stay clickable — the old PopoverChip
          wrapper's no-drag, kept on the trigger now that the wrapper is gone. */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        className="manta-branch-chip rounded-full p-0 border-0 bg-transparent transition-colors hover:bg-fill-hover"
        style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
      >
        <Tag
          size="sm"
          icon={<GitBranch size={11} aria-hidden="true" className="shrink-0" />}
          title={label}
        >
          <span className="shrink-0 truncate max-w-[200px]">
            {branch}
            {pr ? ` · #${pr.number}` : ""}
          </span>
        </Tag>
      </button>
      <Popover
        open={open}
        // BET-925: a click-away while a PR is being created would tear down the
        // only surface reporting it. Held open until the write settles.
        onClose={() => { if (!panelProps.shipBusy) setOpen(false); }}
        anchorRef={triggerRef}
        role="dialog"
        ariaLabel={label}
        hook="manta-branch-popover"
        surfaceClassName="w-[360px]"
      >
        <BranchPanel {...panelProps} />
      </Popover>
    </>
  );
}

// One definition-list row in the PR popover: label left in faint, value
// right-aligned in muted; the mergeability value is the one that takes a
// colour (that colour IS the payload, §8.4 [C7]).
function PanelRow({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center gap-2 py-1 text-[13px]">
      <span className="text-text-faint">{label}</span>
      <span
        className={`ml-auto min-w-0 truncate font-mono text-xs font-medium text-text-muted ${
          valueClass ?? ""
        }`}
      >
        {value}
      </span>
    </div>
  );
}

// The branch popover's single surface, branching on `pr` presence (BET-867).
// PR present → the merge surface [F1]; no PR → the ship gate (BET-892) gated
// on branch state: a single primary "Create pull request" when there are
// commits ahead of base, "Nothing to ship" when there aren't, and no PR
// surface at all "on" the base branch, a detached HEAD, or an unknown base.
// PanelRow is reused verbatim for both states' rows.

// The three states where a pull request cannot exist for this branch: the
// popover shows the branch and why, and offers no action.
const NO_SHIP_COPY: Partial<Record<ShipState, string>> = {
  "on-base": "On the base branch — nothing to ship.",
  detached: "Detached HEAD — nothing to ship.",
  unknown: "Base branch unknown — nothing to ship.",
};

function BranchPanel({
  branch,
  pr,
  checksRollup,
  mergeBusy,
  mergeError,
  onMerge,
  shipBusy,
  shipError,
  shipBase,
  shipFileCount,
  shipTitle,
  justShipped,
  forgeKind,
  base,
  aheadCount,
  onCreatePr,
  onOpenExternal,
  onReviewChanges,
}: BranchPanelProps) {
  if (!pr) {
    // No pull request on this branch — the ship gate. On the base branch, a
    // detached HEAD, or an unknown base there is no PR to open, so no PR
    // surface renders at all.
    const shipState = resolveShipState({ branch, base, aheadCount, hasPr: false });
    const noShip = NO_SHIP_COPY[shipState];
    if (noShip) {
      return (
        <div className="p-3">
          <div className="mb-[3px] truncate text-[13.5px] font-semibold leading-snug text-text">
            {branch}
          </div>
          <div className="text-xs text-text-faint">{noShip}</div>
        </div>
      );
    }
    return (
      <div className="p-3">
        <div className="mb-[3px] truncate text-[13.5px] font-semibold leading-snug text-text">
          {branch}
        </div>
        {shipError ? (
          <div className="mb-2 break-words text-xs text-danger">{shipError}</div>
        ) : shipState === "no-commits" ? (
          <div className="mb-2 text-xs text-text-faint">
            Nothing to ship — no commits ahead of {base}
          </div>
        ) : shipState === "ready" ? (
          <>
            <div className="mb-2 text-xs text-text-faint">
              {branch} <span className="text-accent-tx">→</span> {shipBase ?? base ?? "—"}
              {shipFileCount != null
                ? ` · ${shipFileCount} file${shipFileCount === 1 ? "" : "s"}`
                : ""}
            </div>
            <div className="rounded-sm bg-fill p-2">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-[.08em] text-text-quiet">
                Title
              </div>
              {shipTitle != null ? (
                <div className="text-meta text-text">{shipTitle}</div>
              ) : (
                <>
                  <div className="mb-1 h-[9px] rounded-xs bg-fill-hover animate-pulse" />
                  <div className="h-[9px] w-12 rounded-xs bg-fill-hover animate-pulse" />
                </>
              )}
            </div>
            <div className="mt-3 flex flex-nowrap items-center gap-2">
              <Button tone="primary" disabled={shipBusy || shipTitle == null} onClick={onCreatePr}>
                {shipBusy ? (
                  <>
                    <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Creating…
                  </>
                ) : (
                  <>
                    <ForgeMark kind={forgeKind} /> Create pull request
                  </>
                )}
              </Button>
              {!shipBusy && shipTitle == null && !shipError && (
                <span className="text-[11px] text-text-quiet">Drafting title…</span>
              )}
            </div>
          </>
        ) : null}
      </div>
    );
  }
  // PR present — the merge surface [F1]. The merge gate is the existing
  // canMerge: green rollup + no unresolved threads + mergeable true are ALL
  // required (BET-867, do not re-derive).
  const merge = canMerge({
    rollup: checksRollup,
    unresolvedThreads: pr.unresolvedThreads,
    mergeable: pr.mergeable,
  });
  // mergeBlockedReason is the payload — "checks failing", "conflicts",
  // "review required", "draft" — displayed in danger. Only when there is no
  // reason does it fall back to a status the forge itself reports.
  const mergeable = pr.mergeBlockedReason
    ? { text: pr.mergeBlockedReason, className: "text-danger" }
    : pr.mergeable === true
      ? { text: "mergeable", className: "text-ok" }
      : { text: "computing…", className: "text-text-faint" };
  return (
    <div className="p-3">
      {justShipped && (
        <div className="mb-2">
          <Callout tone="ok">Opened #{pr.number}</Callout>
        </div>
      )}
      <div className="mb-[3px] truncate text-[13.5px] font-semibold leading-snug text-text">
        #{pr.number} {pr.title}
      </div>
      <div className="mb-2 text-xs text-text-faint">
        {pr.state} · {pr.headRef} → {pr.baseRef}
      </div>
      <div className="flex flex-col">
        <PanelRow
          label="Reviewers"
          value={pr.reviewers.length > 0 ? pr.reviewers.join(", ") : "none"}
        />
        <PanelRow label="Unresolved threads" value={String(pr.unresolvedThreads)} />
        <PanelRow label="Mergeable" value={mergeable.text} valueClass={mergeable.className} />
      </div>
      {mergeError && (
        <div className="mt-1 break-words text-xs text-danger">{mergeError}</div>
      )}
      <div className="mt-3 flex flex-nowrap items-center gap-2">
        <Button
          tone="primary"
          disabled={!merge.can || mergeBusy}
          onClick={onMerge}
          title={merge.can ? "Merge this pull request" : merge.reason ?? "not mergeable"}
        >
          {mergeBusy ? "Merging…" : (<><ForgeMark kind={forgeKind} /> Merge</>)}
        </Button>
        <Button tone="default" onClick={onReviewChanges}>Review changes</Button>
        {onOpenExternal && (
          <Button tone="ghost" title="Open on GitHub" onClick={() => onOpenExternal(pr.url)}>
            <ForgeMark kind={forgeKind} />
          </Button>
        )}
      </div>
    </div>
  );
}

// ===== Checks chip + popover (BET-789 [C3] [C4] [C6]) =====
//
// The checks chip is the ONE new status item (§4.3): colour AND glyph, never
// colour alone — `✓ 7`, `✗ 2 failed`, `◐ 3 running`. Its tone + priority are
// a function of state (see checksChipDescriptor). It opens on CLICK (never
// hover — it carries a link + an action), and its popover lists EVERY check in
// one flat list — the dot carries the state and `orderChecks` carries the
// failed → running → passed grouping, each name a link to its own log (BET-926).
const CHECK_TONE_CLASS: Record<ChecksChipTone, string> = {
  ok: "border-ok/40 bg-ok-bg text-ok",
  warn: "border-warn/40 bg-warn-bg text-warn",
  danger: "border-danger/40 bg-danger-bg text-danger",
};

function ChecksChip({
  descriptor,
  checks,
  pr,
  forgeKind,
  onOpenExternal,
  onFillComposer,
}: {
  descriptor: { label: string; tone: ChecksChipTone; priority: number };
  checks: ForgeCheckRun[];
  pr: PullRequest | null;
  forgeKind?: string | null;
  onOpenExternal?: (url: string) => void;
  onFillComposer?: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const label = `Checks: ${descriptor.label}`;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        className={`manta-checks-chip inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full border px-2 font-mono text-[11px] font-medium leading-none ${CHECK_TONE_CLASS[descriptor.tone]}`}
      >
        {hasForgeMark(forgeKind) && (
          <>
            <ForgeMark kind={forgeKind} size={11} />
            <span className="h-[11px] w-px bg-current opacity-40" aria-hidden="true" />
          </>
        )}
        <span>{descriptor.label}</span>
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        role="dialog"
        ariaLabel={label}
        hook="manta-checks-popover"
        surfaceClassName="w-[360px]"
      >
        <ChecksPanel
          checks={checks}
          pr={pr}
          forgeKind={forgeKind}
          onOpenExternal={onOpenExternal}
          onFillComposer={onFillComposer}
        />
      </Popover>
    </>
  );
}

function CheckRow({
  check,
  onOpenExternal,
}: {
  check: ForgeCheckRun;
  onOpenExternal?: (url: string) => void;
}) {
  // The dropped status label lives on as the tooltip — it is the only place the
  // failure/cancelled/timed-out distinction survives (decision 6).
  const detail = check.conclusion ?? check.status ?? "";
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-2 text-label text-text-muted hover:bg-fill-hover">
      <StatusDot tone={checkTone(check)} />
      {check.url && onOpenExternal ? (
        <button
          type="button"
          title={detail}
          onClick={() => onOpenExternal(check.url!)}
          className="min-w-0 flex-1 truncate text-left font-medium text-text hover:underline"
        >
          {check.name}
        </button>
      ) : (
        <span title={detail} className="min-w-0 flex-1 truncate font-medium text-text">
          {check.name}
        </span>
      )}
    </div>
  );
}

function ChecksPanel({
  checks,
  pr,
  forgeKind,
  onOpenExternal,
  onFillComposer,
}: {
  checks: ForgeCheckRun[];
  pr: PullRequest | null;
  forgeKind?: string | null;
  onOpenExternal?: (url: string) => void;
  onFillComposer?: (text: string) => void;
}) {
  const ordered = orderChecks(checks);
  const prompt = failuresToAgentPrompt(checks);
  const logUrl =
    ordered.find((c) => checkTone(c) === "error" && c.url)?.url ??
    checks.find((c) => c.url)?.url ??
    pr?.url;
  return (
    <div className="p-2">
      <div className="mb-1 flex items-center gap-2 border-b border-border-subtle px-2 pb-2">
        {hasForgeMark(forgeKind) && (
          <>
            <ForgeMark kind={forgeKind} size={13} />
            <span className="h-[11px] w-px bg-border" aria-hidden="true" />
          </>
        )}
        <span className="text-meta font-semibold text-text">Checks</span>
        <span className="ml-auto font-mono text-[11px] font-medium text-text-quiet">
          {checks.length}
        </span>
      </div>
      <div className="max-h-[260px] overflow-y-auto">
        {ordered.map((c) => (
          <CheckRow key={c.name} check={c} onOpenExternal={onOpenExternal} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border-subtle px-1 pt-2">
        {prompt && onFillComposer && (
          <Chip on onClick={() => onFillComposer(prompt)}>
            ↻ Send failures to the agent
          </Chip>
        )}
        {logUrl && onOpenExternal && (
          <Button tone="default" onClick={() => onOpenExternal(logUrl)}>
            Open logs ↗
          </Button>
        )}
      </div>
    </div>
  );
}

// ===== Connect offer (BET-789 §4.5 [S10]) =====
//
// The ENTIRE visible chrome delta for the project's existing-user acquisition
// path: one dismissible Callout line under the header, in a forge-origin
// session while the forge is disconnected. "Connect" opens the device-code
// modal (wired by ChatPanel's onConnectForge); the × dismisses permanently,
// per-box, via the store + configUpdate
// (wired by ChatPanel's onDismissForgeConnect — the offer only re-appears when
// the config flag is cleared).
function ConnectOffer({
  onDismiss,
  onConnect,
}: {
  onDismiss?: () => void;
  onConnect?: () => void;
}) {
  return (
    <div className="px-3 pb-2">
      <Callout tone="info">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-[180px] flex-1">
            Connect GitHub to see checks and pull requests for this repo.
          </span>
          <span className="flex items-center gap-2">
            {onConnect && <Chip onClick={onConnect}>Connect</Chip>}
            {onDismiss && (
              <Chip onClick={onDismiss} title="Dismiss">
                ×
              </Chip>
            )}
          </span>
        </div>
      </Callout>
    </div>
  );
}
