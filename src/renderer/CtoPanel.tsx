// BET-1384: the Adaptive CTO overview pane shell (§10.2). This issue ships the
// pane skeleton only — header row (title, Digest-now, ⚙), the fixed 960px
// column, and the resting state (§10.6-1). Section content (needs-you cards,
// rails, tonight line) lands in later issues (A11); §10.2's section scaffolds
// render nothing while empty, which is exactly what this skeleton does.
//
// Everything renders from the single `ctoState` the App holds (subscribed to
// the `{kind:"ctoState"}` bus event + a `GET /api/cto/state` initial read) —
// no polling. Digest-now joins/starts the server's §5.5 single-flight
// generation and renders the server's `generationInFlight` as its spinner.
import { useEffect, useRef } from "react";
import { useStore } from "./store";
import { digestBusy } from "./ctoView";
import type { CtoState } from "../shared/api.js";

export function CtoPanel({
  state,
  onOpenSettings,
}: {
  state: CtoState | null;
  onOpenSettings: () => void;
}) {
  const pushAppToast = useStore((s) => s.pushAppToast);

  const busy = digestBusy(state);
  const restingRef = useRef<HTMLDivElement>(null);
  const wasBusyRef = useRef(busy);

  // On completion (generationInFlight true → false) scroll to the resting line
  // when the digest section is empty (§10.2) — there is no digest content in
  // this issue, so the resting line is the target.
  useEffect(() => {
    const prev = wasBusyRef.current;
    wasBusyRef.current = busy;
    if (prev && !busy) {
      restingRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [busy]);

  const onDigestNow = async () => {
    if (busy) return; // single-flight — never double-generate
    const res = await window.api.ctoDigestNow();
    if (!res.ok) {
      pushAppToast({
        tone: "error",
        message: res.error ? `Digest failed: ${res.error}` : "Digest generation failed",
      });
    }
  };

  return (
    <div className="h-full w-full overflow-y-auto bg-bg">
      <div
        className="mx-auto px-6 py-8"
        style={{ maxWidth: "var(--cto-col-max-w)" }}
      >
        {/* Header row (§10.2): title · spacer · Digest now · ⚙ */}
        <div className="flex items-center gap-2 pb-4">
          <h1 className="text-lg font-semibold text-text">CTO</h1>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => void onDigestNow()}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-bg-elev px-3 py-1.5 text-sm font-medium text-text hover:bg-fill-hover disabled:cursor-not-allowed disabled:opacity-60"
            title={
              busy
                ? "A digest is already being generated"
                : "Generate a fresh digest now"
            }
          >
            {busy && (
              <span
                className="h-3 w-3 rounded-full border-2 border-text-faint border-t-transparent animate-spin"
                aria-hidden
              />
            )}
            Digest now
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="rounded-md p-2 text-text-muted hover:bg-fill-hover hover:text-text"
            title="Settings & health"
            aria-label="Open CTO settings & health"
          >
            ⚙
          </button>
        </div>

        {/* §10.2 section scaffolds — each collapses to nothing when empty; the
            actual cards/rails land in later issues. */}
        <div className="space-y-8" />

        {/* Resting state (§10.6-1): no needs-you items → a single centered
            "Nothing needs you ✓" line with a one-line context summary. */}
        <div ref={restingRef} className="flex flex-col items-center gap-1 py-16">
          <div className="text-text-muted">
            Nothing needs you <span aria-hidden>✓</span>
          </div>
          <div className="text-sm text-text-faint">
            I&rsquo;ll surface anything that needs your attention here.
          </div>
        </div>
      </div>
    </div>
  );
}
