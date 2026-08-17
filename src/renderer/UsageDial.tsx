// ===== Usage dial + popover (BET-738) =====
//
// The composer icon row's subscription-usage meter: a 16px ring trigger plus
// a detail popover. Renders through the shared portalled Popover primitive
// (BET-865) — trigger and panel stay siblings, and the panel is portalled to
// <body> so it can never be clipped or stacked behind the transcript.
//
// THIS IS NOT THE CONTEXT-WINDOW PILL. ContextPill (SessionHeader.tsx) is
// per-CONVERSATION token usage; this is per-SUBSCRIPTION plan usage (BET-737's
// engine). Different data source, different colour scale, different
// placement — the whole point is that the two meters can never be confused.
// Never share code, colours, or thresholds between them.

import { memo, useRef, useState } from "react";
import type { UsageWindow } from "../shared/types";
import {
  cssVar,
  formatUpdatedAgo,
  formatWindowReset,
  selectUsageSnapshot,
  usageDialState,
  usageStale,
  usageTone,
  type UsageDialTone,
} from "./chatUtils";
import { useStore } from "./store";
import { Popover } from "./Popover";

// Lucide icons render a 24-unit viewBox scaled to size. A stroked circle
// draws r ± strokeWidth/2 (the stroke straddles the path), so at size 16 the
// Clock's outer disc spans (2·10 + 2)/24·16 = 22/24 of the box and its ring
// is 2/24 of the box. The dial mirrors that drawn geometry exactly.
const ICON_PX = 16;
import { mbtn } from "./ComposerParts";

// The ONLY provider-name-aware thing in this file — an icon/label lookup
// table, explicitly the one exception the spec allows ("nothing in the
// renderer may know a provider name beyond an icon/label lookup table").
// Falls back to Title-Casing the snapshot's own `provider` id for any
// adapter this table doesn't know about yet, so a 4th adapter needs no
// renderer change. Exported so the usage escalation toasts (BET-739) reuse
// the same single lookup instead of duplicating it.
const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  kimi: "Kimi",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

// The ONE usage colour ladder — the ring and every popover row go through it,
// so a user glancing at the ring and then opening the popover can never see
// two different colours for the same number. (An earlier spec kept the ring
// off --ok below 70 so it read as "pay attention only"; that produced a grey
// ring above a green bar.)
function toneRingColor(tone: UsageDialTone): string {
  if (tone === "over" || tone === "danger") return cssVar("--danger");
  if (tone === "warn") return cssVar("--warn");
  return cssVar("--ok");
}

type UsageDialProps = {
  // The active model's opencode providerID (e.g. "anthropic"), already
  // resolved by ChatPanel via resolveActiveModel and threaded through
  // InputArea — this component never re-resolves the model itself.
  providerID: string | null;
};

export const UsageDial = memo(function UsageDial({ providerID }: UsageDialProps) {
  const snapshots = useStore((s) => s.usage);
  const alwaysShow = useStore((s) => s.alwaysShowUsage);
  const [open, setOpen] = useState(false);
  // Snapshotted at open time (not a ticking clock) — cheap, deterministic,
  // and accurate enough for a short-lived popover.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const triggerRef = useRef<HTMLButtonElement>(null);

  const snapshot = selectUsageSnapshot(snapshots, providerID);
  const state = usageDialState(snapshot, alwaysShow);

  // No data / no matching snapshot / adapter failed / below threshold with
  // the opt-in off → render nothing. Absence is the healthy signal.
  if (!snapshot || !state.visible) return null;

  const ringColor = toneRingColor(state.tone);
  const trackColor = cssVar("--border-subtle");
  const pctClamped = Math.max(0, Math.min(100, state.pct));
  const label = providerLabel(snapshot.provider);
  const windowLabel = state.window?.label ?? "usage";
  const resetLine = formatWindowReset(state.window?.resetsAt, nowMs);
  const title = state.awaitingReset
    ? `${label} · the ${windowLabel} quota is resetting · click for details`
    : `${label} · ${pctClamped}% of the ${windowLabel}` +
      (resetLine ? ` — ${resetLine}` : "") +
      " · click for details";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setNowMs(Date.now());
          setOpen((v) => !v);
        }}
        className={`manta-usage-dial ${mbtn}${open ? " bg-fill-active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="plan usage"
        title={title}
      >
        {/* A 16×16 BOX holding a disc sized to a stroked lucide circle. The
            box keeps the button's metrics identical to the 16px lucide icons
            beside it (so the row does not shift), while the disc matches what
            those icons actually DRAW: a lucide circle is r=10 stroked at
            strokeWidth=2 in a 24 viewBox, and the stroke straddles the path,
            so the drawn outer is (2·10 + 2)/24 of the box and the ring is
            2/24 of the box, both scaled by the 16px icon size. */}
        <span
          aria-hidden="true"
          className={
            "inline-flex items-center justify-center" +
            (state.awaitingReset ? " animate-pulse" : "")
          }
          style={{ width: 16, height: 16 }}
        >
          <span
            aria-hidden="true"
            className="block rounded-full"
            style={{
              width: (22 / 24) * ICON_PX,
              height: (22 / 24) * ICON_PX,
              background:
                state.tone === "over"
                  ? ringColor
                  : `conic-gradient(${ringColor} 0% ${pctClamped}%, ${trackColor} ${pctClamped}% 100%)`,
            }}
          >
            {/* Inner disc in the surrounding surface colour turns the pie into
                a ring — skipped for tone "over" (>=100%), which is a solid
                disc with no hole per the design spec. The stroke straddles
                the circle path, so the inner hole is (2·10 - 2)/24 of the box
                and sits in by the ring width 2/24, both scaled by the 16px
                icon size — matching the neighbours' strokeWidth={2}
                (unchanged from BET-756). */}
            {state.tone !== "over" && (
              <span
                aria-hidden="true"
                className="block rounded-full bg-bg"
                style={{
                  width: (18 / 24) * ICON_PX,
                  height: (18 / 24) * ICON_PX,
                  margin: (2 / 24) * ICON_PX,
                }}
              />
            )}
          </span>
        </span>
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        placement="above"
        align="end"
        role="dialog"
        ariaLabel="Plan usage"
        hook="manta-usage-popover"
        surfaceClassName="w-[320px] p-4"
      >
          <div className="flex items-baseline justify-between gap-2 mb-3">
            <span className="text-prose font-semibold text-text">{label}</span>
            {snapshot.planLabel && (
              <span className="text-meta text-text-faint">{snapshot.planLabel}</span>
            )}
          </div>

          {state.awaitingReset && (
            <div className="mb-3 text-meta text-text-faint">
              Quota is being reset. Usage numbers might look off for a few minutes.
            </div>
          )}

          <div className="flex flex-col gap-3">
            {snapshot.windows.map((w) => (
              <UsageWindowRow key={w.kind} usageWindow={w} nowMs={nowMs} />
            ))}
          </div>

          {snapshot.extras && snapshot.extras.length > 0 && (
            <div className="mt-3 pt-3 border-t border-border-subtle flex flex-col gap-1">
              {snapshot.extras.map((e) => (
                <div key={e.label} className="flex items-center justify-between text-meta">
                  <span className="text-text-faint">{e.label}</span>
                  <span className="text-text-muted font-mono">{e.value}</span>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 pt-3 border-t border-border-subtle flex items-center justify-end">
            <span
              className={
                "text-meta " +
                (usageStale(snapshot.fetchedAt, nowMs) ? "text-warn" : "text-text-faint")
              }
            >
              {formatUpdatedAgo(snapshot.fetchedAt, nowMs)}
            </span>
          </div>
      </Popover>
    </>
  );
});

// One window's row in the popover: label, right-aligned value, a 7px track
// + fill, and a reset line. The component iterates `snapshot.windows` — it
// never hardcodes "session"/"weekly" so a provider with a third window (or a
// daily one) renders with zero changes here.
function UsageWindowRow({ usageWindow: w, nowMs }: { usageWindow: UsageWindow; nowMs: number }) {
  // Awaiting its replacement numbers: show no value and no fill rather than a
  // figure we know is the previous window's. The notice above the list says
  // why, and formatWindowReset already renders "resetting…" below.
  const awaitingReset = w.stale === true;
  const pctClamped = awaitingReset ? 0 : Math.max(0, Math.min(100, w.pct));
  const fill = toneRingColor(usageTone(pctClamped));
  const value = awaitingReset
    ? "—"
    : w.used != null && w.limit != null
      ? `${w.used.toLocaleString()} / ${w.limit.toLocaleString()} · ${pctClamped}%`
      : `${pctClamped}%`;
  const resetLine = formatWindowReset(w.resetsAt, nowMs);

  return (
    <div>
      <div className="flex items-center justify-between text-meta mb-1">
        <span className="text-text-muted">{w.label}</span>
        <span className="font-mono font-medium text-text tabular-nums">{value}</span>
      </div>
      <div className="w-full h-[7px] rounded-xs bg-fill-active overflow-hidden">
        <span
          className="block h-full"
          style={{ width: `${pctClamped}%`, backgroundColor: fill }}
        />
      </div>
      {resetLine && (
        <div className="mt-1 text-label text-text-faint">
          {resetLine}
          {w.binding ? " · binding limit" : ""}
        </div>
      )}
    </div>
  );
}
