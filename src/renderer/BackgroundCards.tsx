// ===== Background-run cards (v2-next Stage B, N4 + N5) =====
//
// Two surfaces, one visual language (docs/superpowers/specs/
// 2026-10-23-opencode-v2-next/bg-commands-mockup.html):
//
//   - BackgroundRunCards: the running / uncertain / failed cards under the
//     transcript, driven by the box's job store (N5). A job's card is REPLACED
//     by its finished card once the result is in the transcript, so it never
//     shows twice (the pairing lives in backgroundRun.deriveBackgroundCards).
//   - BackgroundResultCard: the finished card for a `background-result` part
//     (N4): the result text, its state and "Open session →". The same card
//     renders V2-native background commands and background `task` subagents.
//
// "Open session" is an action, so both outcomes are shown on the card itself:
// the window is selected on success, and a refusal / failure leaves a visible
// error under the card (AGENTS.md: never stub a control).

import { memo, useCallback, useState } from "react";
import { useStore } from "./store";
import { renderMarkdown } from "./MarkdownBody";
import {
  backgroundApi,
  openJobSession,
  resultStateLabel,
  resultTitle,
  resultTone,
  type BackgroundCard,
  type BackgroundResultPart,
  type ResultTone,
} from "./backgroundRun";

/** The "Open session" action for a job, with its own in-flight + error state. */
function useOpenSession(jobId: string | null | undefined) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = useCallback(async () => {
    if (!jobId || busy) return;
    setBusy(true);
    setError(null);
    const r = await openJobSession(jobId, {
      open: (input) => backgroundApi().delegateOpenSession(input),
      // Same selection every sidebar row uses; the window may be one the box
      // just re-created, so re-list the tree first.
      select: async (tmuxSession, windowIndex) => {
        const st = useStore.getState();
        await st.refresh();
        await st.activateWindow(tmuxSession, windowIndex);
      },
    });
    setBusy(false);
    if (!r.ok) setError(r.error);
  }, [jobId, busy]);
  return { open, busy, error };
}

function OpenSessionButton({
  onOpen,
  busy,
  arrow = false,
  className = "",
}: {
  onOpen: () => void;
  busy: boolean;
  arrow?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={busy}
      className={`shrink-0 whitespace-nowrap text-accent-tx hover:underline disabled:opacity-50 ${className}`}
      title="Open the background session"
      data-testid="background-open-session"
    >
      {busy ? "Opening…" : arrow ? "Open session →" : "Open session"}
    </button>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <div role="alert" className="mt-1 text-meta text-danger break-words" data-testid="background-open-error">
      {message}
    </div>
  );
}

const TONE_DOT: Record<ResultTone, string> = {
  ok: "bg-ok",
  danger: "bg-danger",
  neutral: "bg-text-faint",
};

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="w-2.5 h-2.5 shrink-0 rounded-full border-2 border-accent/35 border-t-accent-tx animate-spin motion-reduce:animate-none"
    />
  );
}

const RunCard = memo(function RunCard({ card }: { card: BackgroundCard }) {
  const { open, busy, error } = useOpenSession(card.jobId);
  const failed = card.kind === "failed";
  const text =
    card.kind === "uncertain"
      ? "Couldn't confirm this started — open the session to check"
      : card.kind === "failed"
        ? "Failed to start"
        : card.kind === "settling"
          ? "Finished in background"
          : card.paused
            ? "Paused in background"
            : "Running in background";
  return (
    <div
      className={
        "rounded-lg border bg-bg-soft px-3 py-2 text-meta " +
        (failed ? "border-danger/40" : "border-accent/35")
      }
      data-testid="background-card"
      data-kind={card.kind}
    >
      <div className="flex items-center gap-2 min-w-0">
        {card.kind === "running" && !card.paused ? (
          <Spinner />
        ) : (
          <span
            aria-hidden="true"
            className={`w-2 h-2 shrink-0 rounded-full ${failed ? "bg-danger" : card.kind === "uncertain" ? "bg-warn" : "bg-text-faint"}`}
          />
        )}
        <span className="text-text-muted shrink-0">
          {text}
          {card.kind === "uncertain" ? "" : ":"}
        </span>
        {card.kind !== "uncertain" && (
          <span className="font-mono text-accent-tx truncate min-w-0" title={card.name}>
            {card.name}
          </span>
        )}
        {card.kind === "settling" && (
          <span className="text-text-faint truncate min-w-0">— the result arrives when this turn ends</span>
        )}
        <span className="text-text-faint shrink-0">·</span>
        <OpenSessionButton onOpen={() => void open()} busy={busy} />
      </div>
      {card.kind === "failed" && (
        <div className="mt-1 text-danger break-words" data-testid="background-failure">
          {card.error}
        </div>
      )}
      {error && <ErrorLine message={error} />}
    </div>
  );
});

/** The cards under the transcript (N5). Rendered in the transcript tail. */
export const BackgroundRunCards = memo(function BackgroundRunCards({
  cards,
}: {
  cards: ReadonlyArray<BackgroundCard>;
}) {
  return (
    <div className="flex flex-col" style={{ gap: "var(--block-gap)" }} data-testid="background-cards">
      {cards.map((c) => (
        <RunCard key={c.key} card={c} />
      ))}
    </div>
  );
});

/** The finished card for a N4 `background-result` part. */
export const BackgroundResultCard = memo(function BackgroundResultCard({
  part,
}: {
  part: BackgroundResultPart;
}) {
  // Parts the box didn't stamp with a jobId (V2-native children, background
  // `task` subagents) are still tracked as job rows, keyed by their child id.
  const jobId = useStore((s) => part.jobId || s.jobs[part.childSessionId]?.id || null);
  const { open, busy, error } = useOpenSession(jobId);
  const tone = resultTone(part.state);
  const text = (part.text ?? "").trim();
  return (
    <div
      className="rounded-lg border border-border bg-bg-soft px-3 py-2"
      data-testid="background-result-card"
      data-state={part.state}
    >
      <div className="flex items-center gap-2 text-meta text-text-muted min-w-0">
        <span aria-hidden="true" className={`w-2 h-2 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
        <b className="font-semibold text-text shrink-0">Background</b>
        <span className="font-mono text-accent-tx truncate min-w-0" title={resultTitle(part)}>
          {resultTitle(part)}
        </span>
        <span className="shrink-0">· {resultStateLabel(part.state)}</span>
        {jobId && <OpenSessionButton onOpen={() => void open()} busy={busy} arrow className="ml-auto" />}
      </div>
      {text && <div className="mt-1 break-words text-text">{renderMarkdown(text)}</div>}
      {error && <ErrorLine message={error} />}
    </div>
  );
});
