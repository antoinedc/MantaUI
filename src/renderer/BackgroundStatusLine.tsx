// One line of background-work budget status plus a "Change" link that opens Settings at the budget card.
// Used by the Knowledge card and the CTO pane (spec 2026-11-17-background-work-budget.md §10); the words come
// from backgroundWorkFormat so they match the card and the CTO thrifty banner.

import { LABEL_CLS } from "./Field";
import { shareLine, summaryLine } from "./backgroundWorkFormat";
import { openBackgroundWorkSettings, type BackgroundStatusState } from "./useBackgroundStatus";

const TONE_CLS = { info: "text-text-muted", warn: "text-warn" } as const;

export const CHANGE_LINK_CLS =
  "text-meta text-accent underline hover:text-accent-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

export function ChangeBudgetLink() {
  return (
    <button type="button" onClick={openBackgroundWorkSettings} aria-label="Change background work budget" className={CHANGE_LINK_CLS}>
      Change
    </button>
  );
}

export function BackgroundStatusLine({
  state,
  onRetry,
  share,
  label,
  testId = "background-status",
}: {
  /** A small heading shown above the line, only when there is a line to show. */
  label?: string;
  state: BackgroundStatusState;
  onRetry?: () => void;
  /** Also show this subsystem's own use today, e.g. { workTypes: KNOWLEDGE_WORK_TYPES, noun: "Knowledge work" }. */
  share?: { workTypes: readonly string[]; noun: string };
  testId?: string;
}) {
  if (state.kind === "unsupported") return null; // an older box has no budget to describe
  const heading = label ? <div className={`${LABEL_CLS} mb-1`}>{label}</div> : null;
  if (state.kind === "loading") {
    return (
      <div data-testid={testId}>
        {heading}
        <div className="text-meta text-text-faint">Reading the background work budget…</div>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div data-testid={testId}>
        {heading}
        <div className="flex flex-wrap items-baseline gap-2 text-meta">
          <span role="alert" className="text-danger break-words">
            Couldn't read the background work budget: {state.message}
          </span>
          {onRetry && (
            <button type="button" onClick={onRetry} className="text-meta text-accent underline hover:text-accent-strong">
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }
  const line = summaryLine(state.status);
  const mine = share ? shareLine(state.status, share.workTypes, share.noun) : null;
  // Nothing connected → nothing to describe or change. With an account but no figures yet, still offer the link.
  const hasAccounts = state.status.plans.length > 0 || state.status.payg.providers.length > 0;
  if (!line && !mine && !hasAccounts) return null;
  return (
    <div className="space-y-1" data-testid={testId}>
      {heading}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={`text-meta break-words ${TONE_CLS[line?.tone ?? "info"]}`} data-status={line?.id}>
          {line?.text ?? "Background work is within its budget."}
        </span>
        <ChangeBudgetLink />
      </div>
      {mine && <div className="text-meta text-text-faint">{mine}</div>}
    </div>
  );
}
