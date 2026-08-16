// ConnectPanel.tsx — the consolidated four-zone onboarding step-1 panel
// (BET-961). Renders the ConnectPanelState descriptor that connectPanel.ts
// derives from SshInstallStep's state.
//
// One panel, four fixed zones, in a fixed order: A·target (the host picker
// ReactNode — collapsing to a one-line summary once committed), B·status
// (tone, text, meta, bar, sub — omitted entirely when there is nothing to
// say), C·details (failures / hint — or the inline prompt children), D·actions
// (centred). The install log is its OWN quiet pane BELOW the panel, never a
// fifth zone. Nothing moves between states; every state reuses the same slots.
//
// Presentational only: the only local state is the log open/closed toggle,
// which auto-resets to each log phase's `defaultOpen` when the log phase
// changes. Every colour/size/radius below maps to an existing token.

import { useEffect, useRef, useState, type ReactNode } from "react";
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
  connect: "Connect",
  discard: "Discard",
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
  targetSummary,
  logLines,
  onAction,
  children,
  onCopyDiagnostics,
}: {
  state: ConnectPanelState;
  /** Zone A body — the host picker. Placed inside the panel's zone A. */
  target: ReactNode;
  /** Zone A body once the target is committed — replaces `target` when
   *  `state.targetCollapsed` (the picker is not rendered at all). */
  targetSummary: ReactNode;
  /** Live install log lines for the log pane BELOW the panel. */
  logLines: string[];
  onAction: (id: ConnectActionId) => void;
  /** Zone-C prompt slot (fingerprint / passphrase cards). */
  children?: ReactNode;
  /** Wires the "Copy diagnostics" button (shown only on install failure). */
  onCopyDiagnostics?: () => void | Promise<void>;
}): JSX.Element {
  const { status, details, log, actions, disabledActions, targetCollapsed } = state;

  // Log open/closed toggle, auto-reset to each log phase's defaultOpen.
  const [logOpen, setLogOpen] = useState(log?.defaultOpen ?? false);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Reset the toggle when the log PHASE changes (pane presence / defaultOpen
  // / copy flag), not on every re-render — the derived `log` object is fresh
  // each render, so comparing identities is useless; compare the phase-
  // relevant fields instead.
  const prevLogRef = useRef(log);
  useEffect(() => {
    const prev = prevLogRef.current;
    const changed =
      (prev === null) !== (log === null) ||
      Boolean(
        prev &&
          log &&
          (prev.defaultOpen !== log.defaultOpen ||
            prev.showCopyDiagnostics !== log.showCopyDiagnostics),
      );
    if (changed) setLogOpen(log ? log.defaultOpen : false);
    prevLogRef.current = log;
  }, [log]);

  // Auto-scroll the log to the bottom on new lines (matches ProcessPanel).
  useEffect(() => {
    if (logOpen && logRef.current && logLines.length > 0) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines, logOpen]);

  const actionDisabled = (id: ConnectActionId): boolean =>
    Boolean(disabledActions?.includes(id));

  const showZoneC = details.kind !== "none" || Boolean(children);

  return (
    <>
      <section className="bg-bg-soft border border-border rounded-lg overflow-hidden shadow-sm">
        {/* ZONE A — the picker, or a one-line summary once the target is committed */}
        <div className="px-4 py-3">{targetCollapsed ? targetSummary : target}</div>

        {/* ZONE B — status. Omitted entirely when there is nothing to say. */}
        {status && (
          <>
            <div className="mx-4 h-px bg-border-subtle" />
            <div className="px-4 py-3">
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
          </>
        )}

        {/* ZONE C — failures / hint / prompt children */}
        {showZoneC && (
          <>
            <div className="mx-4 h-px bg-border-subtle" />
            <div className="px-4 py-3">
              {children ??
                (details.kind === "failures" ? (
                  <div>
                    <ul className="flex flex-col gap-2">
                      {details.items.map((f, i) => (
                        <li
                          key={i}
                          className="border border-danger bg-danger-bg rounded-sm px-3 py-2"
                        >
                          <div className="text-body font-medium text-danger">
                            {f.cause}
                          </div>
                          <div className="text-meta text-text-faint mt-px">
                            {f.action}
                          </div>
                        </li>
                      ))}
                    </ul>
                    <p className="text-meta text-text-faint mt-2">
                      Nothing was installed or changed — the checks run before
                      any write.
                    </p>
                  </div>
                ) : details.kind === "hint" ? (
                  <p className="text-meta text-text-faint">
                    {renderHintSegments(details.text)}
                  </p>
                ) : null)}
            </div>
          </>
        )}

        {/* ZONE D — actions, centred, one size larger */}
        <div className="mx-4 h-px bg-border-subtle" />
        <div className="px-4 py-3">
          <div className="flex items-center justify-center gap-2 flex-wrap">
            {actions.map((id, i) => (
              <Button
                key={id}
                size="lg"
                tone={i === 0 ? "primary" : "default"}
                disabled={actionDisabled(id)}
                onClick={() => onAction(id)}
              >
                {actionLabel(id, i)}
              </Button>
            ))}
          </div>
        </div>
      </section>

      {/* The install log — its own quiet pane BELOW the panel, never inside it. */}
      {log && logLines.length > 0 && (
        <section className="mt-3 rounded-md border border-border-subtle bg-inset overflow-hidden">
          <div className="flex items-center gap-3 px-3 py-2 border-b border-border-subtle">
            <span className="text-meta font-medium text-text-faint">Install log</span>
            {log.showCopyDiagnostics && (
              <button
                type="button"
                onClick={() => void onCopyDiagnostics?.()}
                className="text-meta text-text-faint underline underline-offset-2 hover:text-text"
              >
                Copy diagnostics
              </button>
            )}
            <button
              type="button"
              onClick={() => setLogOpen((o) => !o)}
              aria-expanded={logOpen}
              className="ml-auto text-meta text-text-faint hover:text-text"
            >
              {logOpen ? "Hide" : "Show"}
            </button>
          </div>
          {logOpen && (
            <div
              ref={logRef}
              className="px-3 py-2 font-mono text-meta text-text-faint overflow-y-auto"
              style={{ maxHeight: 150 }}
            >
              {logLines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}
