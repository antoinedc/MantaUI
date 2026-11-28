// SuggestionCard — Manta's "this might deserve an agent" offer, under the message that carried the third handoff (design:
// docs/screens/research/decisions.md §21–25; states: profile-and-suggestion.html). It renders the STORED offer (never only a live event) and
// acknowledges itself once it is actually on screen: `onVisible` fires once, when at least half of the card is in the viewport — the
// transcript is virtualised, so mounting alone proves nothing and an offer in an off-screen part of a long chat must not count as shown.
//
// Every control reports its outcome (a click shows a busy line, a refusal an alert that keeps the buttons). Native elements: <section
// role="group"> labelled by its question, <button>s, and a status/alert line (modern-web-guidance `accessibility`: status messages, 24 px
// targets, decorative icons hidden; `efficient-background-processing`: IntersectionObserver for on-screen detection).

import { memo, useEffect, useId, useRef } from "react";
import { Check, Sparkles, TriangleAlert } from "lucide-react";
import { Button } from "./Button";
import { ACTION_LABEL, viewOf, type LocalAct } from "./agentSuggestion";
import type { AgentSuggestion, AgentSuggestionAction } from "../shared/types";

export type SuggestionCardProps = {
  offer: AgentSuggestion;
  local: LocalAct | null;
  onAct: (action: AgentSuggestionAction) => void;
  /** The card is at least half on screen (called once per mount). */
  onVisible: () => void;
};

const TONE_CLS = { busy: "text-text-muted", ok: "text-ok", error: "text-danger", neutral: "text-text-muted" } as const;

export const SuggestionCard = memo(function SuggestionCard({ offer, local, onAct, onVisible }: SuggestionCardProps) {
  const view = viewOf(offer, local);
  const qid = useId();
  const root = useRef<HTMLElement | null>(null);
  const reported = useRef(false);
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;

  useEffect(() => {
    const el = root.current;
    if (!el || reported.current) return;
    const report = () => {
      if (reported.current) return;
      reported.current = true;
      onVisibleRef.current();
    };
    if (typeof IntersectionObserver === "undefined") return; // no way to know it was seen: never claim it
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting && e.intersectionRatio >= 0.5)) {
          io.disconnect();
          report();
        }
      },
      { threshold: [0.5] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const resolved = offer.state === "answered";
  const first = view.primary;
  const second = first === "agent" ? "skill" : "agent";
  const btn = (action: "agent" | "skill") => (
    <Button key={action} tone={action === first ? "primary" : "default"} disabled={view.busy} onClick={() => onAct(action)} hook={`manta-suggestion-${action}`}>
      {ACTION_LABEL[action]}
    </Button>
  );

  return (
    <section
      ref={root}
      role="group"
      aria-labelledby={qid}
      data-testid="agent-suggestion"
      data-state={resolved ? "answered" : "pending"}
      className={`grid max-w-[68ch] grid-cols-[16px_minmax(0,1fr)] gap-x-2 rounded-md border px-3 py-[10px] text-meta ${resolved ? "border-border-subtle bg-bg-soft" : "bg-bg-elev"}`}
      style={resolved ? undefined : { borderColor: "rgb(var(--accent-rgb) / 0.33)" }}
    >
      <Sparkles size={16} aria-hidden="true" className={`mt-[3px] ${resolved ? "text-text-faint" : "text-accent"}`} />
      <div className="min-w-0">
        <p id={qid} className={`m-0 ${resolved ? "text-text-muted" : "text-text"}`}>
          {view.question.before}
          <b className="font-semibold">{view.question.label}</b>
          {view.question.after}
        </p>
        {!resolved && view.why && <p className="m-0 mt-[2px] text-label text-text-faint">{view.why}</p>}
        {view.showActions && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {btn(first)}
            {btn(second)}
            <Button tone="ghost" disabled={view.busy} onClick={() => onAct("later")} hook="manta-suggestion-later">
              {ACTION_LABEL.later}
            </Button>
            <button
              type="button"
              onClick={() => onAct("never")}
              disabled={view.busy}
              className="manta-suggestion-never ml-auto min-h-6 rounded-xs px-1 text-label text-text-faint hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 max-[460px]:ml-0 max-[460px]:basis-full max-[460px]:text-left"
            >
              {ACTION_LABEL.never}
            </button>
          </div>
        )}
        {view.status && (
          <p role={view.status.live} data-testid="agent-suggestion-status" className={`m-0 mt-2 flex flex-wrap items-start gap-x-2 gap-y-1 text-label ${TONE_CLS[view.status.tone]}`}>
            {view.status.tone === "busy" && <span aria-hidden="true" className="mt-[3px] inline-block size-[10px] shrink-0 animate-spin rounded-full border-2 border-accent/35 border-t-accent motion-reduce:animate-none" />}
            {view.status.tone === "ok" && <Check size={14} aria-hidden="true" className="mt-[2px] shrink-0" />}
            {view.status.tone === "error" && <TriangleAlert size={14} aria-hidden="true" className="mt-[2px] shrink-0" />}
            <span className="min-w-0 flex-[1_1_220px]">{view.status.text}</span>
            {view.status.retry && (
              <Button tone="default" onClick={() => onAct(offer.answer === "skill" ? "skill" : "agent")} hook="manta-suggestion-retry">
                Retry
              </Button>
            )}
          </p>
        )}
      </div>
    </section>
  );
});
