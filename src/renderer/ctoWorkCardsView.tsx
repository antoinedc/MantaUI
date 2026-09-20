// ===== §11 work-lifecycle cards — view =====
//
// Purpose-built cards for the work lifecycle in the CTO surfaces (spec §11,
// §15 P3b): review state (reviewer model + pinned head SHA + blocked vs
// approved), the merge gate (matching-head precondition + required-check
// refusals), release/verify progress (the claim ladder, kept honest — a
// pipeline claim is labelled a claim and only an on-target observation reads
// as verified, U05), and the parked state with its visible reason. An
// ambiguous target fails visibly (U07).
//
// Modeled on the pinned card pattern (PermissionCard / ScheduledTasksCard in
// PanelCards): plain chrome over the shared design tokens, one card per work,
// rendered identically on desktop and mobile — a CARD in a section/stack, not
// a footer item. The component is presentational; the data arrives from
// useCtoWorkCards (ctoWorkCards.ts), which reads the existing cto work tools.

import { memo } from "react";
import type { CtoWorkCard } from "./ctoWorkCards";

const TIER_TONE: Record<string, string> = {
  approved: "text-teal",
  merged: "text-teal",
  verified: "text-teal",
  published: "text-teal",
  blocked: "text-danger",
  failed: "text-danger",
  reviewing: "text-text-muted",
  running: "text-text-muted",
  pending: "text-text-faint",
  "not-started": "text-text-faint",
  "not-needed": "text-text-faint",
};

function statusWord(tier: string, status: string): string {
  if (tier === "Merge") {
    if (status === "blocked") return "blocked — gate refused";
    return status === "not-needed" ? "not needed" : status;
  }
  return status === "not-needed" ? "not needed" : status;
}

const TierRow = memo(function TierRow({
  tier,
  status,
  detail,
  meta,
  sha,
}: {
  tier: string;
  status: string;
  detail: string | null;
  meta?: string | null;
  sha?: string | null;
}) {
  return (
    <div className="flex items-start gap-2 text-xs leading-5">
      <span className="w-14 shrink-0 text-text-faint">{tier}</span>
      <span className={`shrink-0 ${TIER_TONE[status] ?? "text-text-muted"}`}>{statusWord(tier, status)}</span>
      <span className="min-w-0 flex-1 text-text-muted">
        {detail}
        {sha ? (
          <span className="ml-1 font-mono text-text-faint" title="pinned head">
            {sha}
          </span>
        ) : null}
      </span>
      {meta ? <span className="shrink-0 text-text-faint">{meta}</span> : null}
    </div>
  );
});

const StatePill = memo(function StatePill({ label, state }: { label: string; state: string }) {
  const tone =
    state === "failed"
      ? "text-danger"
      : state === "waiting" || state === "needs_decision" || state === "paused"
        ? "text-warn"
        : "text-text-muted";
  return <span className={`shrink-0 rounded-full bg-fill-active px-2 py-1 text-[11px] font-medium ${tone}`}>{label}</span>;
});

const WorkCard = memo(function WorkCard({ card }: { card: CtoWorkCard }) {
  return (
    <div className="rounded-md border border-strong bg-fill px-3 py-2">
      <div className="flex items-center gap-2">
        <StatePill label={card.stateLabel} state={card.state} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text" title={card.title}>
          {card.title}
        </span>
        <span className="shrink-0 text-[11px] text-text-faint">for {card.deliveryTargetLabel}</span>
      </div>
      {card.state === "waiting" && card.waitingReasonDetail ? (
        <div className="mt-1 text-xs text-warn">⏸ {card.waitingReasonDetail}</div>
      ) : null}
      {card.targetLiveDetail ? (
        <div
          className={`mt-1 text-xs ${card.targetLive === false || card.targetLive === "ambiguous" ? "text-warn" : "text-text-faint"}`}
        >
          {card.targetLive === "ambiguous" || card.targetLive === false ? "⚠ " : ""}
          {card.targetLiveDetail}
        </div>
      ) : null}
      <div className="mt-2 space-y-1 border-t border-border-subtle pt-2">
        <TierRow
          tier="Review"
          status={card.review.status}
          detail={card.review.detail}
          meta={card.review.reviewerModel ? `reviewer ${card.review.reviewerModel}` : null}
          sha={card.review.headSha}
        />
        <TierRow
          tier="Merge"
          status={card.merge.status}
          detail={card.merge.detail}
          sha={card.merge.headSha}
          meta={card.merge.prNumber != null ? `PR #${card.merge.prNumber}` : null}
        />
        {card.release.status !== "not-needed" && (
          <TierRow
            tier="Release"
            status={card.release.status}
            detail={card.release.detail}
            meta={card.release.artifact ?? null}
          />
        )}
        {card.verify.status !== "not-needed" && (
          <TierRow tier="Verify" status={card.verify.status} detail={card.verify.detail} />
        )}
      </div>
    </div>
  );
});

// The pinned stack CtoChat renders above the composer (and WorkSection reuses
// below). Quiet when there is nothing to show: no fabricated empty card, no
// spinner for an empty queue — silence IS the empty state.
export const WorkStageCards = memo(function WorkStageCards({
  cards,
  error,
}: {
  cards: CtoWorkCard[];
  error?: string | null;
}) {
  if (cards.length === 0 && !error) return null;
  return (
    <div className="space-y-2" aria-label="Work lifecycle">
      {error ? (
        <div className="rounded-md border border-border-subtle bg-fill-active px-3 py-2 text-xs text-text-faint">
          Work state unavailable — retrying… ({error})
        </div>
      ) : null}
      {cards.map((c) => (
        <WorkCard key={c.workId} card={c} />
      ))}
    </div>
  );
});

// The CtoPanel overview section — the same cards in a titled section, the way
// NowRail / TonightSection read. Hidden entirely when there is nothing active.
export const WorkSection = memo(function WorkSection({
  cards,
  error,
}: {
  cards: CtoWorkCard[];
  error?: string | null;
}) {
  if (cards.length === 0 && !error) return null;
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">Work</h2>
      <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
        <WorkStageCards cards={cards} error={error} />
      </div>
    </section>
  );
});
