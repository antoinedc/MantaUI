// ===== Usage dial + popover (BET-738) =====
//
// The composer icon row's subscription-usage meter: a 16px ring trigger plus
// a detail popover. Mirrors ContextPill's structure in SessionHeader.tsx
// (the canonical popover pattern in this codebase) — trigger and panel are
// SIBLINGS under a `relative` wrapper, dismissed via the shared useClickAway
// hook, never nested (a button-inside-a-button is invalid HTML).
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
  type UsageDialTone,
} from "./chatUtils";
import { useClickAway } from "./hooks/useClickAway";
import { useStore } from "./store";
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

// Ring colour per threshold (the dial trigger — never green, per the design
// spec: the dial signals "pay attention", not "all good").
function toneRingColor(tone: UsageDialTone): string {
  if (tone === "over" || tone === "danger") return cssVar("--danger");
  if (tone === "warn") return cssVar("--warn");
  return cssVar("--tx4");
}

// Popover fill colour per window threshold — same three thresholds as the
// dial, but --ok is allowed below 70 HERE: a labelled detail view, not an
// ambient glyph (the dial's ring never uses it).
function windowFillColor(pct: number): string {
  if (pct >= 90) return cssVar("--danger");
  if (pct >= 70) return cssVar("--warn");
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
  const rootRef = useRef<HTMLDivElement>(null);
  useClickAway(rootRef, open, () => setOpen(false));

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
  const title =
    `${label} · ${pctClamped}% of the ${windowLabel}` +
    (resetLine ? ` — ${resetLine}` : "") +
    " · click for details";

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
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
        <span
          aria-hidden="true"
          className="inline-block rounded-full"
          style={{
            width: 16,
            height: 16,
            background:
              state.tone === "over"
                ? ringColor
                : `conic-gradient(${ringColor} 0% ${pctClamped}%, ${trackColor} ${pctClamped}% 100%)`,
          }}
        >
          {/* Inner disc in the surrounding surface colour turns the pie into
              a ring — skipped for tone "over" (>=100%), which is a solid
              disc with no hole per the design spec. */}
          {state.tone !== "over" && (
            <span
              aria-hidden="true"
              className="block rounded-full bg-bg"
              style={{ width: 10, height: 10, margin: 3 }}
            />
          )}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Plan usage"
          className="manta-usage-popover absolute right-0 top-full mt-1 z-30 w-[320px] p-4 rounded-lg border border-border bg-bg-soft shadow-md"
        >
          <div className="flex items-baseline justify-between gap-2 mb-3">
            <span className="text-prose font-semibold text-text">{label}</span>
            {snapshot.planLabel && (
              <span className="text-meta text-text-faint">{snapshot.planLabel}</span>
            )}
          </div>

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
        </div>
      )}
    </div>
  );
});

// One window's row in the popover: label, right-aligned value, a 7px track
// + fill, and a reset line. The component iterates `snapshot.windows` — it
// never hardcodes "session"/"weekly" so a provider with a third window (or a
// daily one) renders with zero changes here.
function UsageWindowRow({ usageWindow: w, nowMs }: { usageWindow: UsageWindow; nowMs: number }) {
  const pctClamped = Math.max(0, Math.min(100, w.pct));
  const fill = windowFillColor(pctClamped);
  const value =
    w.used != null && w.limit != null
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
