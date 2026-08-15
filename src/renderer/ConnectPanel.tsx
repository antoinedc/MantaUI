// ConnectPanel.tsx — the consolidated four-zone onboarding step-1 panel
// (BET-961). Renders the ConnectPanelState descriptor that connectPanel.ts
// derives from SshInstallStep's state.
//
// One panel, four fixed zones, in a fixed order: A·target (the host picker
// ReactNode passed in), B·status (tone, text, meta, bar, sub), C·details
// (log / failures / hint — or the inline prompt children), D·actions
// (primary + at most one secondary, plus an optional right-aligned hint).
// Nothing moves between states; every state reuses the same four slots.
//
// Presentational only: the only local state is the log open/closed toggle,
// which auto-resets to each state's `defaultOpen` when the details phase
// changes. Every colour/size/radius below maps to an existing token.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import { Button } from "./Button";
import type { ConnectActionId, ConnectPanelState } from "./connectPanelLogic";

// ---- tone -> colour maps: the ONLY place tone becomes colour ----
const DOT: Record<string, string> = {
  idle: "bg-text-quiet",
  neutral: "bg-text-quiet",
  running: "bg-accent animate-pulse",
  attention: "bg-warn animate-pulse",
  ok: "bg-ok",
  error: "bg-danger",
};
const TEXT: Record<string, string> = {
  idle: "text-text-faint",
  neutral: "text-text-faint",
  running: "text-text",
  attention: "text-warn",
  ok: "text-ok",
  error: "text-danger",
};
const BAR: Record<string, string> = {
  idle: "var(--accent)",
  neutral: "var(--accent)",
  running: "var(--accent)",
  attention: "var(--accent)",
  ok: "var(--ok)",
  error: "var(--danger)",
};

const ACTION_LABEL: Record<ConnectActionId, string> = {
  install: "Install & pair",
  cancel: "Cancel",
  next: "Next →",
  retry: "Try again",
  editTarget: "Edit target",
  pairManually: "Pair manually",
};

function actionLabel(id: ConnectActionId, index: number): string {
  // Row 4 leads with "Enter code manually", row 5 trails with "Pair manually".
  // The pairManually action's label depends on whether it's the primary — the
  // exact distinction the table encodes.
  if (id === "pairManually" && index === 0) return "Enter code manually";
  return ACTION_LABEL[id];
}

/**
 * Split a hint on backtick-delimited code spans so `manta pair` renders as
 * inline <code>. Generic — any future backticked command works too.
 */
function renderHintSegments(text: string) {
  return text.split(/(`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={i}
          className="font-mono text-label bg-bg rounded-xs px-2 py-px text-text-muted"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export function ConnectPanel({
  state,
  target,
  logLines,
  onAction,
  children,
  onCopyDiagnostics,
}: {
  state: ConnectPanelState;
  /** Zone A body — the host picker. Placed inside the panel's zone A. */
  target: ReactNode;
  /** Live install log lines for the zone-C log pane. */
  logLines: string[];
  onAction: (id: ConnectActionId) => void;
  /** Zone-C prompt slot (fingerprint / passphrase cards). */
  children?: ReactNode;
  /** Wires the "Copy diagnostics" button (shown only on install failure). */
  onCopyDiagnostics?: () => void | Promise<void>;
}): JSX.Element {
  const { status, details, actions, hint } = state;

  // Log open/closed toggle, auto-reset to each details phase's defaultOpen.
  const [logOpen, setLogOpen] = useState(
    details.kind === "log" ? details.defaultOpen : false,
  );
  const logRef = useRef<HTMLDivElement | null>(null);

  // Reset the toggle when the details PHASE changes (kind / defaultOpen /
  // copy flag), not on every re-render — the derived `details` object is
  // fresh each render (elapsed-seconds ticks), so comparing identities is
  // useless; compare the phase-relevant fields instead. This is what auto-
  // opens the log on failure ("row 5") while leaving the user free to open/
  // close it during an install without the next tick slamming it shut.
  const prevDetailsRef = useRef(details);
  useEffect(() => {
    const prev = prevDetailsRef.current;
    let phaseChanged = prev.kind !== details.kind;
    if (!phaseChanged && details.kind === "log" && prev.kind === "log") {
      phaseChanged =
        prev.defaultOpen !== details.defaultOpen ||
        prev.showCopyDiagnostics !== details.showCopyDiagnostics;
    }
    if (phaseChanged) {
      setLogOpen(details.kind === "log" ? details.defaultOpen : false);
    }
    prevDetailsRef.current = details;
  }, [details]);

  // Auto-scroll the log to the bottom on new lines (matches ProcessPanel).
  useEffect(() => {
    if (logOpen && logRef.current && logLines.length > 0) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines, logOpen]);

  // Row 9/10 (hosts not loaded / invalid target) and row 3 (cancelled, meta
  // set) all offer `install`. The only ready one is row 11, which is the only
  // one that carries the "takes about a minute" hint and no in-flight meta —
  // that combination is exactly when the button becomes clickable.
  const installDisabled = status.progress === null && !hint;

  const showZoneC = details.kind !== "none" || Boolean(children);

  return (
    <section className="bg-bg-elev border border-border rounded-lg overflow-hidden shadow-sm">
      {/* ZONE A — target (host picker) */}
      <div className="px-4 py-3 border-b border-border-subtle">{target}</div>

      {/* ZONE B — status */}
      <div className="px-4 py-3 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={`w-2 h-2 rounded-full shrink-0 ${DOT[status.tone]}`}
          />
          <span className={`text-body flex-1 min-w-0 ${TEXT[status.tone]}`}>
            {status.text}
          </span>
          {status.meta && (
            <span className="text-meta font-mono text-text-quiet whitespace-nowrap">
              {status.meta}
            </span>
          )}
        </div>
        {status.progress !== null && (
          <div className="h-[3px] rounded-full bg-border-subtle mt-3 overflow-hidden">
            <div
              className="h-full rounded-full transition-[width] duration-300"
              style={{
                width: `${Math.round(status.progress * 100)}%`,
                background: BAR[status.tone],
              }}
            />
          </div>
        )}
        {status.sub && (
          <div className="text-meta text-text-quiet mt-2">{status.sub}</div>
        )}
      </div>

      {/* ZONE C — details (omitted entirely when there's nothing to show) */}
      {showZoneC && (
        <div className="px-4 py-3 border-b border-border-subtle">
          {children ??
            (details.kind === "log" ? (
              <div>
                <button
                  type="button"
                  onClick={() => setLogOpen((o) => !o)}
                  aria-expanded={logOpen}
                  className="flex items-center gap-2 text-meta text-text-faint hover:text-text"
                >
                  {logOpen ? (
                    <ChevronUp size={12} aria-hidden />
                  ) : (
                    <ChevronDown size={12} aria-hidden />
                  )}
                  {logOpen ? "Hide log" : "Show log"}
                </button>
                {logOpen && (
                  <div
                    ref={logRef}
                    className="mt-2 bg-bg-elev border border-border-subtle rounded-sm px-3 py-2 font-mono text-meta text-text-faint overflow-y-auto"
                    style={{ maxHeight: 172 }}
                  >
                    {logLines.map((l, i) => (
                      <div key={i}>{l}</div>
                    ))}
                  </div>
                )}
                {details.showCopyDiagnostics && (
                  <div className="mt-2">
                    <Button tone="default" onClick={() => void onCopyDiagnostics?.()}>
                      Copy diagnostics
                    </Button>
                  </div>
                )}
              </div>
            ) : details.kind === "failures" ? (
              <div>
                <ul className="flex flex-col gap-2">
                  {details.items.map((f, i) => (
                    <li
                      key={i}
                      className="border border-danger bg-danger-bg rounded-sm px-3 py-2"
                    >
                      <div className="text-body font-medium text-danger">{f.cause}</div>
                      <div className="text-meta text-text-faint mt-px">{f.action}</div>
                    </li>
                  ))}
                </ul>
                <p className="text-meta text-text-faint mt-2">
                  Nothing was installed or changed — the checks run before any
                  write.
                </p>
              </div>
            ) : details.kind === "hint" ? (
              <p className="text-meta text-text-faint">
                {renderHintSegments(details.text)}
              </p>
            ) : null)}
        </div>
      )}

      {/* ZONE D — actions */}
      <div className="px-4 py-3">
        <div className="flex items-center gap-2 flex-wrap">
          {actions.map((id, i) => (
            <Button
              key={id}
              tone={i === 0 ? "primary" : "default"}
              disabled={id === "install" && installDisabled}
              onClick={() => onAction(id)}
            >
              {actionLabel(id, i)}
            </Button>
          ))}
          {hint && (
            <span className="text-meta text-text-quiet ml-auto">{hint}</span>
          )}
        </div>
      </div>
    </section>
  );
}
