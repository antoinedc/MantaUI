// BET-1384 + BET-1385: the Adaptive CTO overview pane (§10). The BET-1384 bump
// shipped the skeleton — header, ⚙ settings page, the fixed column, resting
// state. BET-1385 fills in the section content this pane was built for: Blocker
// cards (§10.3), the Now rail (§10.4), the Just-finished rail (§10.4), the
// "While you were away" digest section (§10.4), the Digest-now button (its
// POST /api/cto/digest dep is merged), and the resting-state gate (§10.6-1).
//
// Data volume stays minimal and notifier-driven:
//   - `ctoState` (prop) is the App's single `{kind:"ctoState"}` subscription
//     (§10.1). It carries the needs-you COUNT; the Blocker rows come from a
//     `GET /api/cto/cards` read, refreshed whenever that count changes.
//   - The digest section reads `GET /api/cto/digest`, reloaded when a
//     generation completes (generationInFlight true → false) and after
//     Digest-now.
//   - The Just-finished rail reads `GET /api/cto/finished`.
//   - The Now rail is composed from store state (windows + per-window
//     running/blocked status) — no polling, no new endpoints.
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "./store";
import {
  backfillCardView,
  digestBusy,
  blockerTarget,
  resting,
  relativeTime,
  finishedVariant,
  formatEta,
  type BlockerCard,
} from "./ctoView";
import {
  BlockerSection,
  LedgerFallbackModal,
  JobLogsModal,
  NowRail,
  JustFinishedRail,
  DigestSection,
  type NowCard,
} from "./ctoSections";
import type { CtoState, CtoCard, CtoFinishedItem, CtoDigest } from "../shared/api.js";

export function CtoPanel({
  state,
  onOpenSession,
}: {
  state: CtoState | null;
  onOpenSession: (sessionId: string) => void;
}) {
  const [view, setView] = useState<"overview" | "settings">("overview");

  // --- data reads ---------------------------------------------------------
  const [digest, setDigest] = useState<CtoDigest | null>(null);
  const [cards, setCards] = useState<CtoCard[]>([]);
  const [finished, setFinished] = useState<CtoFinishedItem[]>([]);
  const [ledgerCard, setLedgerCard] = useState<BlockerCard | null>(null);
  const [logsItem, setLogsItem] = useState<CtoFinishedItem | null>(null);

  const busy = digestBusy(state);
  const busyRef = useRef(busy);

  // Store-derived live state for the Now rail + answer-now routing.
  const projects = useStore((s) => s.projects);
  const status = useStore((s) => s.status);

  // §10.3 target resolution: is a card's owning session still present?
  const knownSessions = useMemo(
    () => new Set(projects.flatMap((p) => p.windows.map((w) => w.opencodeSessionId).filter(Boolean) as string[])),
    [projects],
  );

  // Initial reads + regeneration-completion reload after a generation.
  useEffect(() => {
    void window.api?.ctoDigestGet?.()
      .then((r) => setDigest(r.digest))
      .catch(() => {});
    void window.api?.ctoCardsGet?.()
      .then((r) => setCards(r.cards))
      .catch(() => {});
    void window.api?.ctoFinishedGet?.()
      .then((r) => setFinished(r.items))
      .catch(() => {});
  }, []);

  // Reload the digest + finished rails when a generation completes, and the
  // cards whenever the open needs-you count changes.
  useEffect(() => {
    const prev = busyRef.current;
    busyRef.current = busy;
    const generationSettled = prev && !busy;
    if (generationSettled) {
      void window.api?.ctoDigestGet?.().then((r) => setDigest(r.digest)).catch(() => {});
      void window.api?.ctoFinishedGet?.().then((r) => setFinished(r.items)).catch(() => {});
    }
  }, [busy]);

  useEffect(() => {
    if (typeof state?.needsYouCount === "number") {
      void window.api?.ctoCardsGet?.()
        .then((r) => setCards(r.cards))
        .catch(() => {});
    }
  }, [state?.needsYouCount]);

  // --- Now rail composition (§10.4) ---------------------------------------
  const nowCards = useMemo<NowCard[]>(() => {
    const out: NowCard[] = [];
    for (const p of projects) {
      for (const w of p.windows) {
        const st = status[p.tmuxSession]?.[w.index];
        if (!st) continue;
        const blocked =
          st.attentionKind === "blocked" ||
          st.attentionKind === "question" ||
          st.attentionKind === "permission";
        const active = st.running === true || blocked;
        if (!active) continue;
        const sessionId = w.opencodeSessionId;
        const elapsed = typeof st.lastMessageAt === "number" ? relativeTime(st.lastMessageAt, Date.now()) : null;
        out.push({
          id: sessionId ?? `${p.tmuxSession}-${w.index}`,
          name: w.name,
          state: blocked ? "blocked" : "working",
          step: st.progressLabel ?? null,
          meta: elapsed ? `${p.tmuxSession} · ${elapsed}` : p.tmuxSession,
          onClick: () => {
            if (sessionId) onOpenSession(sessionId);
          },
        });
      }
    }
    return out;
  }, [projects, status, onOpenSession]);

  // --- routing ------------------------------------------------------------
  const handleAnswer = (card: BlockerCard) => {
    const target = blockerTarget(card, knownSessions);
    if (target.action === "session") {
      onOpenSession(target.sessionID);
      window.dispatchEvent(
        new CustomEvent("manta-scroll-to-question", { detail: { sessionId: target.sessionID } }),
      );
      return;
    }
    // ledger fallback (target/session missing, or an inbox/health source whose
    // fix surface isn't in the renderer yet — §10.3 keeps the control honest).
    setLedgerCard(card);
  };

  // BET-1385 review (Block): dispatch the Just-finished action by variant, not
  // by "open the child session for everything". turn → open the session; a
  // gate-failed job → open the inline logs surface; a done job → no action.
  const handleOpenFinished = (item: CtoFinishedItem) => {
    const variant = finishedVariant(item);
    if (variant.action === "open") {
      if (item.sessionID) onOpenSession(item.sessionID);
    } else if (variant.action === "logs") {
      setLogsItem(item);
    }
  };

  const handleRegen = () => {
    void window.api?.ctoDigestNow?.();
  };
  const handleItemOpen = (item: { id: string; text: string; refs?: string[] }) => {
    void window.api?.ctoDigestOpened?.({ item: item.id, expand: false, digestId: digest?.id ?? null }).catch(() => {});
  };
  const handleItemExpand = (item: { id: string }) => {
    void window.api?.ctoDigestOpened?.({ item: item.id, expand: true, digestId: digest?.id ?? null }).catch(() => {});
  };

  // --- resting gate (§10.6-1) ----------------------------------------------
  const isResting = resting({
    cards,
    nowActive: nowCards,
    finished,
    digestHasItems: (digest?.items?.length ?? 0) > 0,
  });

  // §10.2: after a generation settles with an otherwise-empty overview, scroll
  // the resting line into view. (useRef kept in the effect-scope-free form.)
  const restingRef = useRef<HTMLDivElement>(null);
  const [didSettle, setDidSettle] = useState(false);
  useEffect(() => {
    const prev = busyRef.current;
    busyRef.current = busy;
    if (prev && !busy) setDidSettle(true);
  }, [busy]);
  useEffect(() => {
    if (didSettle && isResting) {
      restingRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [didSettle, isResting]);

  if (view === "settings") {
    return (
      <div className="h-full w-full overflow-y-auto bg-bg">
        <div className="mx-auto px-6 py-8" style={{ maxWidth: "var(--cto-col-max-w)" }}>
          <button
            type="button"
            onClick={() => setView("overview")}
            className="rounded-md p-2 text-text-muted hover:bg-fill-hover hover:text-text"
            aria-label="Back to the CTO overview"
          >
            ← Back to CTO
          </button>
          <h2 className="mt-4 text-lg font-semibold text-text">Settings &amp; health</h2>
          <p className="mt-2 text-sm text-text-faint">
            Settings &amp; health cards will land in a later issue.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-bg">
      <div className="mx-auto px-6 py-8" style={{ maxWidth: "var(--cto-col-max-w)" }}>
        {/* Header row (§10.2): title · spacer · Digest now · ⚙ */}
        <div className="flex items-center gap-2 pb-4">
          <h1 className="text-lg font-semibold text-text">CTO</h1>
          <div className="flex-1" />
          <button
            type="button"
            onClick={handleRegen}
            disabled={busy}
            className="rounded-md px-3 py-1 text-sm font-medium text-text hover:bg-fill-hover disabled:opacity-60"
            aria-label="Regenerate the digest"
          >
            {busy ? "Generating…" : "Digest now"}
          </button>
          <button
            type="button"
            onClick={() => setView("settings")}
            className="rounded-md p-2 text-text-muted hover:bg-fill-hover hover:text-text"
            title="Settings & health"
            aria-label="Open CTO settings & health"
          >
            ⚙
          </button>
        </div>

        <div className="space-y-8">
          {/* Learning card (§10.6-4): cold-start backfill progress (BET-1387).
              Informational — never counts into the sidebar badge. */}
          <BackfillCard state={state} />
          <BlockerSection cards={cards} now={Date.now()} onAnswer={handleAnswer} />
          <NowRail cards={nowCards} />
          <JustFinishedRail items={finished} now={Date.now()} onOpen={handleOpenFinished} />
          <DigestSection
            digest={digest}
            busy={busy}
            onRegen={handleRegen}
            onItemOpen={handleItemOpen}
            onItemExpand={handleItemExpand}
          />
        </div>

        {/* Resting state (§10.6-1): only when every section is empty. */}
        {isResting && (
          <div ref={restingRef} className="flex flex-col items-center gap-1 py-12">
            <div className="text-text-muted">
              Nothing needs you <span aria-hidden>✓</span>
            </div>
            <div className="text-sm text-text-faint">
              I&rsquo;ll surface anything that needs your attention here.
            </div>
          </div>
        )}
      </div>

      {ledgerCard && <LedgerFallbackModal card={ledgerCard} onClose={() => setLedgerCard(null)} />}
      {logsItem && logsItem.kind === "job" && (
        <JobLogsModal
          name={logsItem.name}
          detail={logsItem.detail}
          onClose={() => setLogsItem(null)}
        />
      )}
    </div>
  );
}

// The cold-start learning card (§10.6-4). Renders only while a backfill is
// running or was stopped by its spend bound. Neutral border (informational —
// NOT a needs-you item, so it does not count into the sidebar badge).
function BackfillCard({ state }: { state: CtoState | null }) {
  const view = backfillCardView(state);
  if (!view || !view.show) return null;
  const eta = formatEta(view.etaMs);
  const pctLabel =
    view.total > 0 ? Math.round(view.pct * 100) + "%" : view.done > 0 ? "100%" : "…";

  return (
    <div
      className="rounded-lg border border-border-subtle bg-bg-soft p-4"
      data-cto-card="learning"
    >
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-fill px-2 py-1 text-xs font-medium text-text-muted">
          learning
        </span>
        {view.stopped ? (
          <span className="text-sm font-medium text-text">Backfill stopped</span>
        ) : (
          <span className="text-sm font-medium text-text">Backfilling history</span>
        )}
      </div>

      {view.stopped ? (
        <p className="mt-2 text-sm text-text-faint">
          {view.reason === "budget"
            ? `Reached the one-time spend cap at ~${view.stoppedAtDepthDays ?? "some"} days of history (${view.done} of ${view.total} sessions processed).`
            : "History backfilling was interrupted."}
        </p>
      ) : (
        <div className="mt-2">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-text-muted">
              Session {view.done} of {view.total} · {pctLabel}
            </span>
            {eta && <span className="text-text-faint">ETA {eta}</span>}
          </div>
          <div
            role="progressbar"
            aria-valuenow={Math.round(view.pct * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-fill"
          >
            <div
              className="h-full rounded-full bg-info"
              style={{ width: `${Math.max(0, Math.min(100, view.pct * 100))}%` }}
            />
          </div>
        </div>
      )}

      <p className="mt-2 text-xs text-text-faint">
        Ask-only while learning — I&rsquo;ll suggest, not act, until there&rsquo;s a track record.
      </p>
    </div>
  );
}
