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
  countdownRemaining,
  digestExpandable,
  finishedVariant,
  nowRailMeta,
  runnableSuggestionOption,
  type BlockerCard,
  type DecisionCardRow,
  type FinishedVariant,
  type VetoCardRow,
} from "./ctoView";
import type { CtoFinishedItem, CtoDigest, CtoTonightTask } from "../shared/api.js";

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
// ---------------------------------------------------------------------------
// Suggestion / decision-card section (§9.1 + §10.3)
// ---------------------------------------------------------------------------

export type SuggestionOption = NonNullable<DecisionCardRow["options"]>[number];

// The §9.1 decision card. Accent edge (vs the Blocker's danger edge), a
// one-paragraph `why`, the bound-action option buttons (only runnable ones —
// queue-tonight / tool-write have no P2 executor → no dead control), a
// dismiss button (→ §9.5 verdict) and the "evidence ▸" expander. A
// `config-change` option opens a confirm modal showing payload.diff before the
// executor runs (no silent side-effecting config writes).
export const SuggestionSection = memo(function SuggestionSection({
  cards,
  onAction,
  onDismiss,
}: {
  cards: DecisionCardRow[];
  onAction: (card: DecisionCardRow, option: SuggestionOption) => void;
  onDismiss: (card: DecisionCardRow) => void;
}) {
  if (cards.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">Suggestions</h2>
      <div className="space-y-2">
        {cards.map((card) => (
          <SuggestionCard key={card.id} card={card} onAction={onAction} onDismiss={onDismiss} />
        ))}
      </div>
    </section>
  );
});

function SuggestionCard({
  card,
  onAction,
  onDismiss,
}: {
  card: DecisionCardRow;
  onAction: (card: DecisionCardRow, option: SuggestionOption) => void;
  onDismiss: (card: DecisionCardRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmOption, setConfirmOption] = useState<SuggestionOption | null>(null);
  const options = (card.options ?? []).filter((o) => runnableSuggestionOption(o));
  const needsConfirm = (o: SuggestionOption) => o.action?.type === "config-change";
  const evidence = Array.isArray(card.evidence) ? card.evidence : Array.isArray(card.refs) ? card.refs : [];

  const handleOption = (o: SuggestionOption) => {
    if (needsConfirm(o)) {
      setConfirmOption(o);
      return;
    }
    onAction(card, o);
  };

  return (
    <>
      <div
        className="rounded-md border border-strong bg-fill px-3 py-3"
        style={{
          borderLeftWidth: "var(--need-edge-w)",
          borderLeftColor: "color-mix(in srgb, var(--accent) 55%, transparent)",
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium text-text">{card.title}</span>
              {card.capped === true ? (
                <span className="rounded-full bg-fill-active px-2 py-1 text-[11px] font-medium text-text-faint" title="Cold-start learning">
                  learning
                </span>
              ) : null}
            </div>
            {card.why ? <p className="mt-1 text-sm text-text-muted">{card.why}</p> : null}
          </div>
          <button
            type="button"
            onClick={() => onDismiss(card)}
            className="shrink-0 rounded-md px-2 py-1 text-sm text-text-faint hover:bg-fill-hover hover:text-text"
            aria-label={`Dismiss suggestion: ${card.title}`}
          >
            Dismiss
          </button>
        </div>
        {options.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {options.map((o, i) => (
              <button
                key={`${o.label}-${i}`}
                type="button"
                onClick={() => handleOption(o)}
                className="rounded-md bg-accent-solid px-3 py-1 text-sm font-medium text-white hover:opacity-90"
              >
                {o.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="mt-2 flex items-center gap-2">
          {evidence.length > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="rounded-md bg-fill-active px-2 py-1 text-[11px] text-text-muted hover:text-text"
              aria-expanded={expanded}
            >
              evidence {expanded ? "▾" : "▸"} ({evidence.length})
            </button>
          ) : null}
          {card.cls && typeof card.score === "number" ? (
            <span className="text-[11px] text-text-faint">
              {card.cls} · {(card.score * 100).toFixed(0)}%
            </span>
          ) : null}
        </div>
        {expanded && evidence.length > 0 ? (
          <pre className="mt-1 whitespace-pre-wrap rounded-md bg-fill-active p-2 text-xs text-text-muted">
            {evidence.join("\n")}
          </pre>
        ) : null}
      </div>
      {confirmOption ? (
        <ConfigConfirmModal
          card={card}
          option={confirmOption}
          onConfirm={() => {
            onAction(card, confirmOption);
            setConfirmOption(null);
          }}
          onClose={() => setConfirmOption(null)}
        />
      ) : null}
    </>
  );
}

// Config-change confirm modal (§10.3 no-dead/silent-write rule): shows the
// payload.diff before the executor runs `configUpdate`.
export const ConfigConfirmModal = memo(function ConfigConfirmModal({
  card,
  option,
  onConfirm,
  onClose,
}: {
  card: DecisionCardRow;
  option: SuggestionOption;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const diff = typeof option.action?.payload?.diff === "string" ? (option.action.payload.diff as string) : "…";
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0, 0, 0, 0.4)" }}
      role="dialog"
      aria-modal="true"
      aria-label={`Confirm config change: ${option.label}`}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-strong bg-bg p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-text">Apply config change?</h3>
        <p className="mt-1 text-sm text-text-muted">“{card.title}”</p>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-fill-active p-2 text-xs text-text-muted">
          {diff}
        </pre>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-text hover:bg-fill-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-accent-solid px-3 py-1 text-sm font-medium text-white hover:opacity-90"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
});

// Now rail (§10.4)
// ---------------------------------------------------------------------------

export type NowCard = {
  id: string;
  name: string;
  state: "working" | "blocked";
  step: string | null;
  project: string;
  cost: string | null;
  elapsed: string | null;
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
              <span className="truncate text-xs text-text-faint">{nowRailMeta(card.project, card.cost, card.elapsed)}</span>
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
  onOpenHeld,
}: {
  digest: CtoDigest | null;
  busy: boolean;
  onRegen: () => void;
  onItemOpen: (item: { id: string; text: string; refs?: string[] }) => void;
  onItemExpand: (item: { id: string }) => void;
  // §14.3 silence audit: opens the gated-out held-list modal. Rendered as an
  // in-digest aside when the digest carried held suggestions (§9.1 held rows).
  onOpenHeld?: () => void;
}) {
  if (!digest) return null;
  const items = Array.isArray(digest.items) ? digest.items : [];
  const held = Number.isFinite(digest.heldSuggestions) ? (digest.heldSuggestions as number) : 0;
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
        {held > 0 ? (
          <div className="flex items-center gap-2 rounded-md border border-strong bg-fill px-3 py-2">
            <span className="text-sm text-text-muted">I held back {held} suggestion{held === 1 ? "" : "s"} while you were away.</span>
            {onOpenHeld ? (
              <button
                type="button"
                onClick={onOpenHeld}
                className="rounded-md bg-fill-active px-2 py-1 text-xs font-medium text-text hover:bg-fill-hover"
              >
                review →
              </button>
            ) : null}
          </div>
        ) : null}
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

// ---------------------------------------------------------------------------
// BET-1419 — Overnight surfaces (§10.3 veto card + §10.4 Tonight line)
// ---------------------------------------------------------------------------

// The veto-window card: tonight's run announced ~30 min ahead with a live
// countdown. Three actions (§9.2): Cancel tonight (veto verdict), Edit plan
// (opens the Tonight drill-down below), Run now instead (override).
export const VetoSection = memo(function VetoSection({
  cards,
  now,
  onCancel,
  onEditPlan,
  onRunNow,
}: {
  cards: VetoCardRow[];
  now: number;
  onCancel: (card: VetoCardRow) => void;
  onEditPlan: (card: VetoCardRow) => void;
  onRunNow: (card: VetoCardRow) => void;
}) {
  if (cards.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">Overnight</h2>
      <div className="space-y-2">
        {cards.map((card) => {
          const remaining = countdownRemaining(card.dueMs, now);
          const min = remaining != null ? Math.max(1, Math.round(remaining / 60000)) : null;
          return (
            <div
              key={card.id}
              className="rounded-md border border-strong bg-fill px-3 py-3"
              style={{
                borderLeftWidth: "var(--need-edge-w)",
                borderLeftColor: "color-mix(in srgb, var(--warn) 55%, transparent)",
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium text-text">{card.title}</span>
                    {min != null ? (
                      <span
                        className="rounded-full bg-fill-active px-2 py-1 text-[11px] font-medium text-text-faint"
                        title="Time until the overnight window opens"
                      >
                        opens in ~{min}m
                      </span>
                    ) : null}
                  </div>
                  {card.body ? <p className="mt-1 text-sm text-text-muted">{card.body}</p> : null}
                </div>
              </div>
              <div className="mt-2 flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onCancel(card)}
                  className="rounded-md px-2 py-1 text-sm font-medium text-text hover:bg-fill-hover"
                >
                  Cancel tonight
                </button>
                <button
                  type="button"
                  onClick={() => onEditPlan(card)}
                  className="rounded-md px-2 py-1 text-sm text-text-muted hover:bg-fill-hover"
                >
                  Edit plan
                </button>
                <button
                  type="button"
                  onClick={() => onRunNow(card)}
                  className="rounded-md px-2 py-1 text-sm text-text-muted hover:bg-fill-hover"
                >
                  Run now instead
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
});

// The Tonight one-line + opt-in drill-down (§10.4). The parent fetches the
// task list when expanded (ctoTonightGet). A manual reorder PINS the order
// for the current window (exempt from re-scoring) and every edit is a
// verdict; "budget & forecast in ⚙" points at the settings card.
export const TonightSection = memo(function TonightSection({
  count,
  expanded,
  onToggle,
  tasks,
  tasksLoading,
  pinned,
  windowOpen,
  onCancelTonight,
  onRemove,
  onMove,
  onOpenSettings,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
  tasks: CtoTonightTask[];
  tasksLoading: boolean;
  pinned: boolean;
  windowOpen: boolean;
  onCancelTonight: () => void;
  onRemove: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onOpenSettings?: () => void;
}) {
  if (count <= 0) return null;
  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm text-text-muted hover:bg-fill-hover"
        aria-expanded={expanded}
      >
        <span aria-hidden>🌙</span>
        <span>
          {count} task{count === 1 ? "" : "s"} queued for tonight {windowOpen ? "(running now)" : "(window)"}
        </span>
        {pinned ? (
          <span className="rounded-full bg-fill-active px-2 py-1 text-[11px] font-medium text-text-faint" title="Manual order pinned for this window">
            order pinned
          </span>
        ) : null}
        <span className="ml-auto text-xs text-text-faint">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded ? (
        <div className="space-y-2 rounded-md border border-strong bg-fill px-3 py-3">
          {tasksLoading ? <p className="text-sm text-text-faint">Loading…</p> : null}
          {!tasksLoading && tasks.length === 0 ? <p className="text-sm text-text-faint">Nothing queued.</p> : null}
          {tasks.map((t, i) => (
            <div key={t.id} className="flex items-center gap-2 text-sm">
              <span className="text-xs text-text-faint">{i + 1}.</span>
              <span className="min-w-0 flex-1 truncate text-text" title={t.prompt}>
                {t.name}
              </span>
              <span className="rounded-full bg-fill-active px-2 py-1 text-[11px] font-medium text-text-faint">{t.cls}</span>
              <button
                type="button"
                onClick={() => onMove(t.id, -1)}
                disabled={i === 0}
                className="rounded px-1 text-xs text-text-faint hover:bg-fill-hover disabled:opacity-30"
                aria-label={`Move ${t.name} earlier`}
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => onMove(t.id, 1)}
                disabled={i === tasks.length - 1}
                className="rounded px-1 text-xs text-text-faint hover:bg-fill-hover disabled:opacity-30"
                aria-label={`Move ${t.name} later`}
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => onRemove(t.id)}
                className="rounded-md px-2 py-1 text-xs text-text-muted hover:bg-fill-hover"
              >
                Remove
              </button>
            </div>
          ))}
          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={onCancelTonight}
              className="rounded-md px-2 py-1 text-sm font-medium text-text hover:bg-fill-hover"
            >
              Cancel tonight
            </button>
            <button
              type="button"
              onClick={onOpenSettings}
              className="text-xs text-text-faint hover:text-text"
              title="Overnight budget & forecast live in Settings → Adaptive CTO → Behavior"
            >
              budget &amp; forecast in ⚙
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
});
