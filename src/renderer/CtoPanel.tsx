// BET-1384: the Adaptive CTO overview pane shell (§10.2). This issue ships the
// pane skeleton only — header row (title, ⚙), the "Settings & health" bare
// page, the fixed 960px column, and the resting state (§10.6-1). Section
// content (needs-you cards, rails, tonight line) lands in later issues (A11);
// §10.2's section scaffolds render nothing while empty, which is exactly what
// this skeleton does.
//
// Everything renders from the single `ctoState` the App holds (subscribed to
// the `{kind:"ctoState"}` bus event + a `GET /api/cto/state` initial read) —
// no polling.
//
// The §10.2 "Digest now" button is intentionally NOT rendered in this issue:
// its action is `POST /api/cto/digest`, which ships in BET-1383 and is not yet
// merged. Per the no-dead-controls rule a control whose dependency isn't
// merged is not rendered — it reappears with BET-1383. The scroll-to-resting
// line on generation-completion below still reacts to the server's real
// `generationInFlight` (covers server-initiated regeneration).
import { useEffect, useRef, useState } from "react";
import { backfillCardView, digestBusy, formatEta } from "./ctoView";
import type { CtoState } from "../shared/api.js";

export function CtoPanel({
  state,
}: {
  state: CtoState | null;
}) {
  // ⚙ switches to a bare "Settings & health" page (a back button, no cards —
  // the setting cards themselves land in a later issue). Back returns to the
  // overview.
  const [view, setView] = useState<"overview" | "settings">("overview");

  const busy = digestBusy(state);
  const restingRef = useRef<HTMLDivElement>(null);
  const wasBusyRef = useRef(busy);

  // On generation completion (generationInFlight true → false) scroll to the
  // resting line when the digest section is empty (§10.2) — there is no digest
  // content in this issue, so the resting line is the target.
  useEffect(() => {
    const prev = wasBusyRef.current;
    wasBusyRef.current = busy;
    if (prev && !busy) {
      restingRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [busy]);

  if (view === "settings") {
    return (
      <div className="h-full w-full overflow-y-auto bg-bg">
        <div
          className="mx-auto px-6 py-8"
          style={{ maxWidth: "var(--cto-col-max-w)" }}
        >
          <button
            type="button"
            onClick={() => setView("overview")}
            className="rounded-md p-2 text-text-muted hover:bg-fill-hover hover:text-text"
            aria-label="Back to the CTO overview"
          >
            ← Back to CTO
          </button>
          <h2 className="mt-4 text-lg font-semibold text-text">Settings &amp; health</h2>
          <p className="mt-2 text-sm text-text-faint">
            Settings &amp; health cards will land in a later issue.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-bg">
      <div
        className="mx-auto px-6 py-8"
        style={{ maxWidth: "var(--cto-col-max-w)" }}
      >
        {/* Header row (§10.2): title · spacer · ⚙. (Digest now is gated out —
            its POST /api/cto/digest endpoint ships in BET-1383.) */}
        <div className="flex items-center gap-2 pb-4">
          <h1 className="text-lg font-semibold text-text">CTO</h1>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setView("settings")}
            className="rounded-md p-2 text-text-muted hover:bg-fill-hover hover:text-text"
            title="Settings & health"
            aria-label="Open CTO settings & health"
          >
            ⚙
          </button>
        </div>

        {/* §10.2 section scaffolds — each collapses to nothing when empty; the
            actual cards/rails land in later issues. */}
        <div className="space-y-8">
          {/* Learning card (§10.6-4): cold-start backfill progress. Reuses the
              needs-you card's neutral-surface styling with a `learning` chip —
              informational, so it never counts into the sidebar badge. */}
          <BackfillCard state={state} />
        </div>

        {/* Resting state (§10.6-1): no needs-you items → a single centered
            "Nothing needs you ✓" line with a one-line context summary. Only
            rendered when the needs-you count is zero; with open needs-you
            items the (not-yet-shipped) needs-you section takes over. */}
        {(state?.needsYouCount ?? 0) === 0 && (
          <div ref={restingRef} className="flex flex-col items-center gap-1 py-12">
            <div className="text-text-muted">
              Nothing needs you <span aria-hidden>✓</span>
            </div>
            <div className="text-sm text-text-faint">
              I&rsquo;ll surface anything that needs your attention here.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// The cold-start learning card (§10.6-4). Renders only while a backfill is
// running or was stopped by its spend bound. Neutral border (informational —
// NOT a needs-you item, so it does not count into the sidebar badge).
function BackfillCard({ state }: { state: CtoState | null }) {
  const view = backfillCardView(state);
  if (!view || !view.show) return null;
  const eta = formatEta(view.etaMs);
  const pctLabel =
    view.total > 0 ? Math.round(view.pct * 100) + "%" : view.done > 0 ? "100%" : "…";

  return (
    <div
      className="rounded-lg border border-border-subtle bg-bg-soft p-4"
      data-cto-card="learning"
    >
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-fill px-2 py-1 text-xs font-medium text-text-muted">
          learning
        </span>
        {view.stopped ? (
          <span className="text-sm font-medium text-text">Backfill stopped</span>
        ) : (
          <span className="text-sm font-medium text-text">Backfilling history</span>
        )}
      </div>

      {view.stopped ? (
        <p className="mt-2 text-sm text-text-faint">
          {view.reason === "budget"
            ? `Reached the one-time spend cap at ~${view.stoppedAtDepthDays ?? "some"} days of history (${view.done} of ${view.total} sessions processed).`
            : "History backfilling was interrupted."}
        </p>
      ) : (
        <div className="mt-2">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-text-muted">
              Session {view.done} of {view.total} · {pctLabel}
            </span>
            {eta && <span className="text-text-faint">ETA {eta}</span>}
          </div>
          <div
            role="progressbar"
            aria-valuenow={Math.round(view.pct * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-fill"
          >
            <div
              className="h-full rounded-full bg-info"
              style={{ width: `${Math.max(0, Math.min(100, view.pct * 100))}%` }}
            />
          </div>
        </div>
      )}

      <p className="mt-2 text-xs text-text-faint">
        Ask-only while learning — I&rsquo;ll suggest, not act, until there&rsquo;s a track record.
      </p>
    </div>
  );
}
