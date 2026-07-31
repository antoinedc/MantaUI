// ProcessPanel.tsx — reusable "long opaque operation" surface (BET-421 §A).
//
// The SSH installer's progress section (SshInstallStep.tsx) is the best-
// designed thing in the product: named stages, an N-of-M counter, elapsed
// time, a progress bar, a live log, and a Copy diagnostics button. Every
// other slow operation (provider sign-in, verification, opencode restarts)
// showed a bare spinner instead. This component extracts that surface into
// one reusable element so all four render the same way.
//
// Render-only. The parent owns the stage list, the active index, the log
// buffer, and the elapsed timer — ProcessPanel just lays them out. Inline
// prompts (the SSH installer's fingerprint / passphrase cards) are passed
// as children and render between the bar and the log, exactly where they
// lived before.
//
// Props:
//   stages          ordered list of stage labels (drives "N of M" + bar width).
//   activeIndex     0-based index of the stage currently running. `stages.length`
//                   means "past the last stage" (done → full bar + check). Any
//                   index < stages.length while `status === "running"` shows the
//                   spinner on that stage.
//   status          "running" | "done" | "error". Done shows a check and fills
//                   the bar; error shows an X and freezes the bar at the failed
//                   stage.
//   elapsedSeconds  seconds since the operation started (parent ticks it).
//   logLines        live log lines (auto-scrolls while open).
//   onCopyDiagnostics  optional — renders a "Copy diagnostics" button. Present
//                      for every operation that can fail opaquely (installer,
//                      verify, restart).
//   children         optional inline prompts rendered between the bar and the
//                    log (the SSH installer's fingerprint / passphrase cards).
//   logHeight        log pane height in px (defaults to the SSH installer's 172).
//   copyLabel        override the Copy diagnostics button label.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, X, ChevronUp, ChevronDown } from "lucide-react";

const ACCENT = "var(--accent)";
const ACCENT_SOLID = "var(--accent-solid)";
const DANGER = "var(--danger)";
const OK_GREEN = "var(--ok)";

export type ProcessPanelStatus = "running" | "done" | "error";

export function ProcessPanel({
  stages,
  activeIndex,
  status,
  elapsedSeconds,
  logLines,
  onCopyDiagnostics,
  children,
  logHeight = 172,
  copyLabel = "Copy diagnostics",
}: {
  stages: string[];
  activeIndex: number;
  status: ProcessPanelStatus;
  elapsedSeconds: number;
  logLines: string[];
  onCopyDiagnostics?: () => void | Promise<void>;
  children?: ReactNode;
  logHeight?: number;
  copyLabel?: string;
}): JSX.Element {
  const [logOpen, setLogOpen] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll the log to the bottom while it's open — matches a terminal
  // user's "stick to the tail" expectation.
  useEffect(() => {
    if (logOpen && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines, logOpen]);

  const total = stages.length;
  // Clamp the displayed index for the "N of M" line. While running, it's the
  // current stage (1-based); when done we show the last stage as completed.
  const displayIndex = Math.min(Math.max(activeIndex + 1, 1), total);
  const stageLabel =
    status === "done"
      ? stages[total - 1] ?? "Done"
      : (stages[activeIndex] ?? stages[0] ?? "");
  // Bar width: fraction of stages completed. Done → full. Error → frozen at
  // the failed stage's progress (displayIndex/total).
  const barFraction =
    status === "done" ? 1 : total > 0 ? displayIndex / total : 0;

  // The log only renders when there's something to show AND no inline prompt
  // is currently monopolizing the panel (mirrors the SSH installer, which
  // hides the log while a fingerprint / passphrase card is up).
  const showLog = logOpen && !children;

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 text-body">
        {status === "done" ? (
          <span aria-hidden style={{ color: OK_GREEN }} className="inline-flex items-center">
            <Check size={14} aria-hidden="true" />
          </span>
        ) : status === "error" ? (
          <span aria-hidden style={{ color: DANGER }} className="inline-flex items-center">
            <X size={14} aria-hidden="true" />
          </span>
        ) : (
          <span
            aria-hidden
            className="inline-block w-3 h-3 rounded-full border-2 animate-spin"
            style={{ borderColor: ACCENT, borderTopColor: "transparent" }}
          />
        )}
        <span>{stageLabel}</span>
        <span className="text-text-muted">
          {displayIndex} of {total} · {formatElapsed(elapsedSeconds)}
        </span>
        <button
          onClick={() => setLogOpen((o) => !o)}
          className="ml-auto text-meta text-text-muted hover:text-text inline-flex items-center gap-1"
          aria-expanded={logOpen}
        >
          {logOpen ? (
            <>Hide log <ChevronUp size={12} aria-hidden="true" /></>
          ) : (
            <>Show log <ChevronDown size={12} aria-hidden="true" /></>
          )}
        </button>
      </div>
      <div className="h-0.5 rounded-full overflow-hidden bg-bg-elev" aria-hidden>
        <div
          className="h-full"
          style={{
            width: `${barFraction * 100}%`,
            background: status === "error" ? DANGER : ACCENT_SOLID,
          }}
        />
      </div>
      {children}
      {showLog && (
        <div
          ref={logRef}
          style={{ height: logHeight, overflowY: "auto" }}
          className="rounded-md bg-bg-elev px-3 py-2 text-meta font-mono whitespace-pre-wrap"
        >
          {logLines.join("\n")}
        </div>
      )}
      {onCopyDiagnostics && (
        <div className="pt-px">
          <button
            type="button"
            onClick={() => void onCopyDiagnostics()}
            className="px-3 py-2 rounded-md text-meta"
            style={{ border: `1px solid ${DANGER}`, color: DANGER }}
          >
            {copyLabel}
          </button>
        </div>
      )}
    </section>
  );
}

export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
