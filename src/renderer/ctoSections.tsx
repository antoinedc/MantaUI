// BET-1385: the Adaptive CTO overview section components (§10.3 Blocker cards,
// §10.4 Now rail, Just-finished rail, "While you were away" digest). Every
// component here is a memoized, pure leaf — it renders data it is given and
// calls back for actions; none of them fetch or mutate. Data composition +
// effects live in `CtoPanel.tsx`.
//
// Design tokens (tokens.css): the four §10.7 dimensional vars --cto-card-min-w
// / --cto-col-max-w / --need-edge-w / --tier-col-w, plus the shared accent /
// danger / fill utilities. Only configured Tailwind scale steps are used
// (enforced by tailwindScale.test). Controls are never stubbed: an action whose
// dependency isn't merged is simply not rendered (no-dead-controls rule).
import { memo, useState } from "react";
import {
  relativeTime,
  digestExpandable,
  finishedVariant,
  type BlockerCard,
  type FinishedVariant,
} from "./ctoView";
import type { CtoFinishedItem, CtoDigest } from "../shared/api.js";

// ---------------------------------------------------------------------------
// Blocker section (§10.3)
// ---------------------------------------------------------------------------

export const BlockerSection = memo(function BlockerSection({
  cards,
  now,
  onAnswer,
}: {
  cards: BlockerCard[];
  now: number;
  onAnswer: (card: BlockerCard) => void;
}) {
  if (cards.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">Blocker</h2>
      <div className="space-y-2">
        {cards.map((card) => (
          <div
            key={card.id}
            className="flex items-start gap-3 rounded-md border border-strong bg-fill px-3 py-3"
            style={{
              borderLeftWidth: "var(--need-edge-w)",
              borderLeftColor: "color-mix(in srgb, var(--danger) 45%, transparent)",
            }}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium text-text">{card.title}</span>
                <span className="text-xs text-text-faint">{relativeTime(card.pendingSince, now)}</span>
              </div>
              {card.body ? <p className="mt-1 text-sm text-text-muted">{card.body}</p> : null}
            </div>
            <button
              type="button"
              onClick={() => onAnswer(card)}
              className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-text hover:bg-fill-hover"
              aria-label={`Answer now: ${card.title}`}
            >
              Answer now <span aria-hidden>→</span>
            </button>
          </div>
        ))}
      </div>
    </section>
  );
});

// Minimal inline modal for the Answer-now "target missing" fallback (§10.3):
// opens the matching ledger entry. The full ledger page ships with the settings
// issue; until then the modal keeps the fallback branch honest without a dead
// navigation target. Uses an inline backdrop color to avoid the dim-overlay
// class owned by the Modal primitive (chrome-ownership rule).
export const LedgerFallbackModal = memo(function LedgerFallbackModal({
  card,
  onClose,
}: {
  card: BlockerCard;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0, 0, 0, 0.4)" }}
      role="dialog"
      aria-modal="true"
      aria-label="Ledger entry"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg border border-strong bg-bg p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-text">{card.title}</h3>
        <p className="mt-1 text-sm text-text-muted">{card.body || "No additional detail."}</p>
        <p className="mt-2 text-xs text-text-faint">
          Ledger entry (source {card.sourceKind}
          {card.sourceId ? ` ${card.sourceId}` : ""}) — the full ledger page
          lands with the Settings issue.
        </p>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-text hover:bg-fill-hover"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
});

// Inline logs surface for a gate-failed Just-finished job (§10.4 Logs action,
// BET-1385 review). Shows the delegate job's failure / stop reason (the box's
// authoritative record); full terminal logs live in the job's session.
export const JobLogsModal = memo(function JobLogsModal({
  name,
  detail,
  onClose,
}: {
  name: string;
  detail: string | null;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0, 0, 0, 0.4)" }}
      role="dialog"
      aria-modal="true"
      aria-label={`Job logs: ${name}`}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-strong bg-bg p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-text">Job logs — {name}</h3>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-fill-active p-2 text-xs text-text-muted">
          {detail || "No failure detail recorded."}
        </pre>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-text hover:bg-fill-hover"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Now rail (§10.4)
// ---------------------------------------------------------------------------

export type NowCard = {
  id: string;
  name: string;
  state: "working" | "blocked";
  step: string | null;
  meta: string; // "project · elapsed"
  onClick: () => void;
};

export const NowRail = memo(function NowRail({ cards }: { cards: NowCard[] }) {
  if (cards.length === 0) return null;
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">Now</h2>
      <div
        className="mt-2 grid gap-2"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(var(--cto-card-min-w), 1fr))` }}
      >
        {cards.map((card) => (
          <button
            key={card.id}
            type="button"
            onClick={card.onClick}
            className="flex flex-col gap-2 rounded-md border border-strong bg-fill p-3 text-left hover:bg-fill-hover"
          >
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${card.state === "blocked" ? "bg-danger" : "bg-accent"}`}
              />
              <span className="truncate text-sm font-medium text-text">{card.name}</span>
              <span className="ml-auto shrink-0 rounded-full bg-fill-active px-2 py-1 text-[11px] font-medium capitalize text-text-muted">
                {card.state}
              </span>
            </div>
            {card.state === "blocked" ? (
              <span className="text-xs text-text-faint">blocked — question above ↑</span>
            ) : card.step ? (
              <span className="truncate text-xs text-text-muted">{card.step}</span>
            ) : (
              <span className="truncate text-xs text-text-faint">{card.meta}</span>
            )}
          </button>
        ))}
      </div>
    </section>
  );
});

// ---------------------------------------------------------------------------
// Just-finished rail (§10.4)
// ---------------------------------------------------------------------------

export const JustFinishedRail = memo(function JustFinishedRail({
  items,
  now,
  onOpen,
}: {
  items: CtoFinishedItem[];
  now: number;
  onOpen: (item: CtoFinishedItem, variant: FinishedVariant) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">Just finished</h2>
      <div className="mt-2 space-y-2">
        {items.map((item) => {
          const variant = finishedVariant(item);
          const label = item.kind === "job" ? (item.status === "failed" ? "failed" : "done") : "turn";
          return (
            <div
              key={item.kind === "job" ? item.id : item.sessionID}
              className="flex items-center gap-2 rounded-md border border-strong bg-fill px-3 py-2"
            >
              <span
                className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-medium ${
                  label === "failed" ? "bg-danger text-white" : "bg-fill-active text-text-muted"
                }`}
              >
                {label}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-text">
                  {item.kind === "job" ? item.name : item.oneLiner}
                </div>
                <div className="text-xs text-text-faint">
                  {item.kind === "turn" ? item.sessionID : item.branch ? `branch ${item.branch}` : item.name}
                  {" · "}
                  {relativeTime(item.ts, now)}
                </div>
              </div>
              {variant.action !== "none" ? (
                <button
                  type="button"
                  onClick={() => onOpen(item, variant)}
                  className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-text hover:bg-fill-hover"
                >
                  {variant.action === "logs" ? "Logs" : "Open"}
                  <span aria-hidden> →</span>
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
});

// ---------------------------------------------------------------------------
// "While you were away" digest section (§10.4)
// ---------------------------------------------------------------------------

export const DigestSection = memo(function DigestSection({
  digest,
  busy,
  onRegen,
  onItemOpen,
  onItemExpand,
}: {
  digest: CtoDigest | null;
  busy: boolean;
  onRegen: () => void;
  onItemOpen: (item: { id: string; text: string; refs?: string[] }) => void;
  onItemExpand: (item: { id: string }) => void;
}) {
  if (!digest) return null;
  const items = Array.isArray(digest.items) ? digest.items : [];
  return (
    <section>
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">While you were away</h2>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onRegen}
          disabled={busy}
          className="rounded-md px-2 py-1 text-xs font-medium text-text hover:bg-fill-hover disabled:opacity-60"
          aria-label="Regenerate digest"
        >
          {busy ? "Generating…" : "Digest now"}
        </button>
      </div>
      <div className="mt-2 space-y-2">
        {items.map((item, i) => (
          <DigestRow key={`${item.text}-${i}`} item={item} onOpen={onItemOpen} onExpand={onItemExpand} />
        ))}
      </div>
    </section>
  );
});

// A single digest row. The "technical detail ▸" control and the /opened expand
// instrumentation are ONE control (BET-1385 review nit): clicking toggles the
// inline detail and fires the expand event exactly on the first open.
const DigestRow = memo(function DigestRow({
  item,
  onOpen,
  onExpand,
}: {
  item: { tier: string; text: string; sub?: string; refs?: string[]; deep?: string };
  onOpen: (item: { id: string; text: string; refs?: string[] }) => void;
  onExpand: (item: { id: string }) => void;
}) {
  const expandable = digestExpandable(item);
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex gap-2 rounded-md border border-strong bg-fill px-3 py-2">
      <div
        className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium capitalize text-text-muted"
        style={{ width: "var(--tier-col-w)", background: "var(--fill-active)" }}
      >
        {item.tier}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-text">{item.text}</div>
        {item.sub ? <div className="mt-1 text-xs text-text-muted">{item.sub}</div> : null}
        <div className="mt-1 flex items-center gap-2">
          {Array.isArray(item.refs) && item.refs.length > 0 ? (
            <button
              type="button"
              onClick={() => onOpen({ id: item.refs![0], text: item.text, refs: item.refs })}
              className="rounded-md bg-fill-active px-2 py-1 text-[11px] text-text-muted hover:text-text"
            >
              view evidence →
            </button>
          ) : null}
          {expandable && item.deep ? (
            <button
              type="button"
              onClick={() => {
                if (!expanded) onExpand({ id: item.text });
                setExpanded((e) => !e);
              }}
              className="rounded-md bg-fill-active px-2 py-1 text-[11px] text-text-muted hover:text-text"
              aria-expanded={expanded}
            >
              technical detail {expanded ? "▾" : "▸"}
            </button>
          ) : null}
        </div>
        {expanded && item.deep ? (
          <pre className="mt-1 whitespace-pre-wrap rounded-md bg-fill-active p-2 text-xs text-text-muted">
            {item.deep}
          </pre>
        ) : null}
      </div>
    </div>
  );
});
