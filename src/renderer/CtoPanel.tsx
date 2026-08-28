// BET-1384 + BET-1385 + BET-1386: the Adaptive CTO pane (§10). BET-1384 shipped
// the skeleton — header, ⚙ settings page, the fixed column, resting state.
// BET-1385 filled in the overview section content this pane was built for:
// Blocker cards (§10.3), the Now rail (§10.4), the Just-finished rail (§10.4),
// the "While you were away" digest section (§10.4), the Digest-now button (its
// POST /api/cto/digest dep is merged), and the resting-state gate (§10.6-1).
// BET-1386 (this diff) replaced the ⚙ settings placeholder with the real
// Settings & health pane (§10.5): the Behavior card (Enabled · Effort dial ·
// Hard daily cap · Push digest · Pause/Resume kill switch), the Health card
// (P1 stats with min-sample `collecting (n/k)`), the A12 Activity-ledger
// drill-down (reverse-chron, filterable by actor/type), and the §10.6-5
// paused banner (kill switch active → the header gives way to a paused-at
// banner with a Resume control).
//
// Data volume stays minimal and notifier-driven:
//   - `ctoState` (prop) is the App's single `{kind:"ctoState"}` subscription
//     (§10.1). It carries the needs-you COUNT + `pausedAt`; the Blocker rows
//     come from a `GET /api/cto/cards` read, refreshed whenever that count
//     changes.
//   - The digest section reads `GET /api/cto/digest`, reloaded when a
//     generation completes (generationInFlight true → false) and after
//     Digest-now.
//   - The Just-finished rail reads `GET /api/cto/finished`.
//   - The Now rail is composed from store state (windows + per-window
//     running/blocked status) — no polling, no new endpoints.
//   - The settings view reads config + health on open (never polled); the
//     ledger pages in reverse-chron with a cursor.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "./store";
import {
  backfillCardView,
  digestBusy,
  blockerTarget,
  resting,
  relativeTime,
  finishedVariant,
  formatEta,
  showPausedBanner,
  statDisplay,
  type BlockerCard,
  type CtoState,
  type CtoHealthStat,
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
import type { CtoCard, CtoFinishedItem, CtoDigest, CtoLedgerPage, CtoLedgerRow } from "../shared/api.js";
import { Toggle } from "./Toggle";

// The effort-dial options (§12.1, D12). Plain-language scope per tier. Medium
// and High list the features they ADD over the tier below; their additional
// features are P2 (not yet merged), so the radio carries an honest "coming in
// P2" note rather than implying the capability exists (§ no-dead-controls).
type EffortLevel = { value: "low" | "medium" | "high"; title: string; scope: string; comingInP2?: boolean };
const EFFORT_LEVELS: EffortLevel[] = [
  {
    value: "low",
    title: "Low",
    scope:
      "Background digest, work rollups, facts blackboard, Now / Just-finished rails and the activity ledger.",
  },
  {
    value: "medium",
    title: "Medium",
    scope: "Adds suggestions and tool discovery probes — coming in P2.",
    comingInP2: true,
  },
  {
    value: "high",
    title: "High",
    scope: "Adds overnight planning and veto-window actions — coming in P2.",
    comingInP2: true,
  },
];

// A minimal non-interactive clock for the paused-at line + ledger timestamps.
function formatTime(ts: number | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type CtoSettingsConfig = {
  ctoEnabled?: boolean;
  ctoTier?: "low" | "medium" | "high";
  ctoAmbientCap?: number;
  ctoDigestPush?: boolean;
};

export function CtoPanel({
  state,
  onOpenSession,
}: {
  state: CtoState | null;
  onOpenSession: (sessionId: string) => void;
}) {
  const [view, setView] = useState<"overview" | "settings" | "ledger">("overview");
  const pushToast = useStore((s) => s.pushAppToast);

  // --- data reads ---------------------------------------------------------
  const [digest, setDigest] = useState<CtoDigest | null>(null);
  const [cards, setCards] = useState<CtoCard[]>([]);
  const [finished, setFinished] = useState<CtoFinishedItem[]>([]);
  const [ledgerCard, setLedgerCard] = useState<BlockerCard | null>(null);
  const [logsItem, setLogsItem] = useState<CtoFinishedItem | null>(null);

  const busy = digestBusy(state);
  const busyRef = useRef(busy);

  // §10.6-5: the kill switch being active drives the banner via the pure
  // state→banner selector (tested in ctoView.test.ts).
  const paused = showPausedBanner(state);

  const resumeCto = useCallback(async () => {
    try {
      const r = await window.api.ctoResume();
      if (!r.ok) throw new Error(r.error ?? "resume failed");
    } catch (e) {
      pushToast({
        id: `resume-${Date.now()}`,
        message: `Couldn't resume the CTO: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }, [pushToast]);

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

  // Dispatch the Just-finished action by variant: turn → open the session; a
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
      <SettingsView
        paused={paused}
        pausedAt={state?.pausedAt ?? null}
        onBack={() => setView("overview")}
        onLedger={() => setView("ledger")}
        onResume={() => void resumeCto()}
      />
    );
  }
  if (view === "ledger") {
    return <LedgerView onBack={() => setView("settings")} pushToast={pushToast} />;
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

        {/* §10.6-5 paused banner — kill switch active → the header gives way to
            the paused-at banner with a Resume control. */}
        {paused && (
          <div className="mb-4 flex flex-col gap-2 rounded-lg border border-border-subtle bg-fill-active p-3">
            <div className="text-sm font-medium text-text">
              Paused <span className="text-text-muted">· {formatTime(state?.pausedAt ?? null)}</span>
            </div>
            <p className="text-sm text-text-muted">
              No probes, no jobs, no analysis; digest data keeps accumulating passively.
            </p>
            <div>
              <button
                type="button"
                onClick={() => void resumeCto()}
                className="rounded-md border border-border px-3 py-2 text-sm font-medium text-text hover:bg-fill-hover"
              >
                Resume
              </button>
            </div>
          </div>
        )}

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

// ---------------------------------------------------------------------------
// Settings & health (§10.5)
// ---------------------------------------------------------------------------
function SettingsView({
  paused,
  pausedAt,
  onBack,
  onLedger,
  onResume,
}: {
  paused: boolean;
  pausedAt: number | null;
  onBack: () => void;
  onLedger: () => void;
  onResume: () => void;
}) {
  const pushToast = useStore((s) => s.pushAppToast);
  // Local mirror of the adaptive-CTO config cluster, loaded on open so the
  // controls reflect the box; edits write through configUpdate (instant-apply).
  const [config, setConfig] = useState<CtoSettingsConfig | null>(null);
  const [capText, setCapText] = useState("");
  const [health, setHealth] = useState<CtoHealthStat[]>([]);
  const [busyPause, setBusyPause] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.api.configGet().then((c) => {
      if (!alive) return;
      setConfig({ ctoEnabled: !!c?.ctoEnabled, ctoTier: c?.ctoTier, ctoAmbientCap: c?.ctoAmbientCap, ctoDigestPush: !!c?.ctoDigestPush });
      setCapText(String(c?.ctoAmbientCap ?? 2.5));
    });
    void window.api.ctoHealthGet().then((h) => {
      if (alive) setHealth(h.stats);
    });
    return () => {
      alive = false;
    };
  }, []);

  const applyConfig = useCallback(
    async (patch: Partial<CtoSettingsConfig>) => {
      const prev = config;
      setConfig((c) => ({ ...(c ?? {}), ...patch }));
      try {
        const next = (await window.api.configUpdate(patch)) as CtoSettingsConfig;
        setConfig((c) => ({ ...c, ...patch, ctoAmbientCap: next?.ctoAmbientCap }));
      } catch (e) {
        setConfig(prev ?? {});
        pushToast({
          id: `cto-cfg-${Date.now()}`,
          message: `Couldn't update: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    },
    [config, pushToast],
  );

  const saveCap = useCallback(() => {
    const n = Number(capText);
    if (!Number.isFinite(n) || n < 0) {
      pushToast({ id: `cap-${Date.now()}`, message: "Daily cap must be a non-negative dollar amount." });
      return;
    }
    void applyConfig({ ctoAmbientCap: Math.round(n * 100) / 100 });
  }, [capText, applyConfig, pushToast]);

  const doPause = useCallback(async () => {
    setBusyPause(true);
    try {
      const r = await window.api.ctoPause();
      if (!r.ok) throw new Error(r.error ?? "pause failed");
    } catch (e) {
      pushToast({ id: `pause-${Date.now()}`, message: `Couldn't pause the CTO: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusyPause(false);
    }
  }, [pushToast]);

  return (
    <div className="h-full w-full overflow-y-auto bg-bg">
      <div className="mx-auto px-6 py-8" style={{ maxWidth: "var(--cto-col-max-w)" }}>
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-2 text-text-muted hover:bg-fill-hover hover:text-text"
          aria-label="Back to the CTO overview"
        >
          ← Back to CTO
        </button>
        <h2 className="mt-4 text-lg font-semibold text-text">Settings &amp; health</h2>

        {paused && (
          <div className="mt-3 flex flex-col gap-1 rounded-lg border border-border-subtle bg-fill-active p-3">
            <div className="text-sm font-medium text-text">
              Paused <span className="text-text-muted">· {formatTime(pausedAt)}</span>
            </div>
            <p className="text-sm text-text-muted">
              No probes, no jobs, no analysis; digest data keeps accumulating passively.
            </p>
            <div>
              <button
                type="button"
                onClick={onResume}
                className="rounded-md border border-border px-3 py-2 text-sm font-medium text-text hover:bg-fill-hover"
              >
                Resume
              </button>
            </div>
          </div>
        )}

        <div className="mt-4 space-y-6">
          {/* ---------- Behavior card (§10.5 card 1, P1 subset) ---------- */}
          <section className="rounded-lg border border-border-subtle p-4">
            <h3 className="text-sm font-semibold text-text">Behavior</h3>
            <p className="mt-1 text-sm text-text-faint">
              One hard daily cap (<span className="font-mono">${config?.ctoAmbientCap ?? 2.5}</span>)
              bounds all autonomous work, independent of the effort dial.
            </p>

            <div className="mt-4 space-y-4">
              {/* Enabled */}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-text">Enabled</div>
                  <div className="text-sm text-text-muted">
                    Off = fully idle (event ingestion continues, nothing runs).
                  </div>
                </div>
                <Toggle
                  checked={config?.ctoEnabled ?? false}
                  onChange={(v) => void applyConfig({ ctoEnabled: v })}
                  ariaLabel="Adaptive CTO enabled"
                />
              </div>

              {/* Effort dial */}
              <div>
                <div className="text-sm font-medium text-text">Effort</div>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  {EFFORT_LEVELS.map((lv) => (
                    <label
                      key={lv.value}
                      className={
                        "cursor-pointer rounded-md border p-3 text-sm " +
                        ((config?.ctoTier ?? "low") === lv.value
                          ? "border-accent bg-fill-hover"
                          : "border-border-subtle")
                      }
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="cto-effort"
                          value={lv.value}
                          checked={(config?.ctoTier ?? "low") === lv.value}
                          onChange={() => void applyConfig({ ctoTier: lv.value })}
                          className="accent-accent"
                        />
                        <span className="font-medium text-text">{lv.title}</span>
                      </span>
                      <span className="mt-1 block text-xs text-text-muted">{lv.scope}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Ambient cap editor */}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-text">Hard daily cap</div>
                  <div className="text-sm text-text-muted">Dollar amount per day (default $2.50).</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-text-muted">$</span>
                  <input
                    type="number"
                    min={0}
                    step={0.25}
                    value={capText}
                    onChange={(e) => setCapText(e.target.value)}
                    onBlur={saveCap}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveCap();
                    }}
                    className="w-20 rounded-md border border-border bg-bg px-2 py-1 text-sm text-text"
                    aria-label="Hard daily ambient cap in dollars"
                  />
                </div>
              </div>

              {/* Push digest to phone */}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-text">Push digest to phone</div>
                  <div className="text-sm text-text-muted">
                    Also notify your phone when a digest is pre-generated.
                  </div>
                </div>
                <Toggle
                  checked={!!config?.ctoDigestPush}
                  onChange={(v) => void applyConfig({ ctoDigestPush: v })}
                  ariaLabel="Push digest to phone"
                />
              </div>

              {/* Pause / Resume (§10.6-5 kill switch) */}
              <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-4">
                <div>
                  <div className="text-sm font-medium text-text">
                    {paused ? "Paused" : "Pause everything now"}
                  </div>
                  <div className="text-sm text-text-muted">
                    {paused
                      ? "Probes, jobs and analysis are stopped; digest data keeps accumulating."
                      : "Stops all autonomous work immediately. You can resume any time."}
                  </div>
                </div>
                {paused ? (
                  <button
                    type="button"
                    onClick={onResume}
                    className="rounded-md border border-border px-3 py-2 text-sm font-medium text-text hover:bg-fill-hover"
                  >
                    Resume
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void doPause()}
                    disabled={busyPause}
                    className="rounded-md border border-danger/40 px-3 py-2 text-sm font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
                  >
                    Pause now
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* ---------- Health card (§10.5 card 2, P1 rows) ---------- */}
          <section className="rounded-lg border border-border-subtle p-4">
            <h3 className="text-sm font-semibold text-text">Health</h3>
            <ul className="mt-3 divide-y divide-border-subtle">
              {HEALTH_ROW_ORDER.map((id) => {
                const stat = health.find((s) => s.id === id) ?? {
                  id,
                  label:
                    id === "ambientSpendToday"
                      ? "Ambient spend today"
                      : id === "digestOpens"
                      ? "Digest opens · 7d"
                      : "Pipeline lag (close → summary)",
                  value: null,
                  n: 0,
                  min: 1,
                };
                const d = statDisplay(stat);
                return (
                  <li key={id} className="flex items-baseline justify-between gap-3 py-2">
                    <span className="text-sm text-text-muted">{stat.label}</span>
                    <span className={"text-right text-sm " + (d.ready ? "font-mono text-text" : "text-text-faint")}>
                      {d.ready ? d.text : <><span>{stat.label}</span> · {d.text}</>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* ---------- Internals: Activity ledger entry point ---------- */}
          <section className="rounded-lg border border-border-subtle p-4">
            <h3 className="text-sm font-semibold text-text">Internals</h3>
            <button
              type="button"
              onClick={onLedger}
              className="mt-2 flex w-full items-center justify-between rounded-md border border-border-subtle px-3 py-2 text-left hover:bg-fill-hover"
            >
              <span>
                <span className="block text-sm font-medium text-text">Activity ledger</span>
                <span className="block text-xs text-text-muted">
                  Reverse-chronological record of everything the CTO has done.
                </span>
              </span>
              <span className="text-text-muted">›</span>
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}

const HEALTH_ROW_ORDER = ["ambientSpendToday", "digestOpens", "pipelineLag"] as const;

// ---------------------------------------------------------------------------
// Activity ledger drill-down (A12)
// ---------------------------------------------------------------------------
const LEDGER_ACTORS = ["cto", "user", "job"];

function LedgerView({
  onBack,
  pushToast,
}: {
  onBack: () => void;
  pushToast: (t: { id: string; message: string }) => void;
}) {
  const [rows, setRows] = useState<CtoLedgerRow[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [actor, setActor] = useState<string>("");
  const [kind, setKind] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const loadPage = useCallback(
    async (before?: number, replace = false) => {
      setLoading(true);
      try {
        const page: CtoLedgerPage = await window.api.ctoLedgerGet({
          before,
          actor: actor || undefined,
          kind: kind || undefined,
          limit: 100,
        });
        setRows((prev) => (replace ? page.rows : [...prev, ...page.rows]));
        setNextBefore(page.nextBefore);
      } catch (e) {
        pushToast({
          id: `ledger-${Date.now()}`,
          message: `Couldn't load the ledger: ${e instanceof Error ? e.message : String(e)}`,
        });
      } finally {
        setLoading(false);
      }
    },
    [actor, kind, pushToast],
  );

  // Reload when a filter changes (first page, replacing).
  useEffect(() => {
    void loadPage(undefined, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, kind]);

  // Distinct kinds across the rows loaded so far, for the §10.5 card-4
  // "filter by type" chips.
  const kinds = Array.from(new Set(rows.map((r) => r.kind).filter((k): k is string => !!k))).sort();

  return (
    <div className="h-full w-full overflow-y-auto bg-bg">
      <div className="mx-auto px-6 py-8" style={{ maxWidth: "var(--cto-col-max-w)" }}>
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-2 text-text-muted hover:bg-fill-hover hover:text-text"
          aria-label="Back to CTO settings"
        >
          ← Back to settings
        </button>
        <h2 className="mt-4 text-lg font-semibold text-text">Activity ledger</h2>

        {/* Filter chips by actor */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-text-faint">Actor</span>
          <button
            type="button"
            onClick={() => setActor("")}
            className={"rounded-full border px-3 py-1 text-xs " + (actor === "" ? "border-accent bg-fill-hover text-text" : "border-border-subtle text-text-muted")}
          >
            All
          </button>
          {LEDGER_ACTORS.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setActor(actor === a ? "" : a)}
              className={"rounded-full border px-3 py-1 text-xs capitalize " + (actor === a ? "border-accent bg-fill-hover text-text" : "border-border-subtle text-text-muted")}
            >
              {a}
            </button>
          ))}
        </div>

        {/* Filter chips by type (kind) */}
        {kinds.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-text-faint">Type</span>
            <button
              type="button"
              onClick={() => setKind("")}
              className={"rounded-full border px-3 py-1 text-xs " + (kind === "" ? "border-accent bg-fill-hover text-text" : "border-border-subtle text-text-muted")}
            >
              All
            </button>
            {kinds.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(kind === k ? "" : k)}
                className={"rounded-full border px-3 py-1 font-mono text-xs " + (kind === k ? "border-accent bg-fill-hover text-text" : "border-border-subtle text-text-muted")}
              >
                {k}
              </button>
            ))}
          </div>
        )}

        {rows.length === 0 && !loading ? (
          <p className="mt-8 text-sm text-text-faint">
            No activity recorded yet{actor || kind ? ` for "${[actor, kind].filter(Boolean).join(" / ")}"` : ""}.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-border-subtle">
            {rows.map((r, i) => (
              <li key={`${r.ts}-${i}`} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm text-text">
                    <span className="mr-2 font-mono text-xs text-text-muted">{r.kind ?? "entry"}</span>
                    {r.reason ? <span className="text-text-muted">· {r.reason}</span> : null}
                  </div>
                  <div className="text-xs text-text-faint">
                    {r.actor ? <span className="capitalize">by {r.actor}</span> : null}
                    {r.sessionID ? <span> · {r.sessionID}</span> : null}
                  </div>
                </div>
                <span className="shrink-0 text-xs text-text-faint">{formatTime(r.ts)}</span>
              </li>
            ))}
          </ul>
        )}

        {nextBefore != null && (
          <button
            type="button"
            onClick={() => void loadPage(nextBefore)}
            disabled={loading}
            className="mt-4 rounded-md border border-border px-3 py-2 text-sm text-text hover:bg-fill-hover disabled:opacity-50"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}
