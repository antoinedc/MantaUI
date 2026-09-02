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
  mayShowResting,
  heldModalShowsError,
  relativeTime,
  finishedVariant,
  formatEta,
  showPausedBanner,
  statDisplay,
  nowCostLabel,
  blockerCards,
  decisionCards,
  vetoCards,
  connectCards,
  connectAnswerArgs,
  tonightVisible,
  executeSuggestionOption,
  tonightBudgetMode,
  nightGauge,
  providerWindowNotes,
  forecastAccuracyRows,
  bindingReserveFrac,
  budgetTodayUsd,
  digestEvidenceAction,
  evidenceExpansion,
  calibrationTableDisplay,
  type BlockerCard,
  type ConnectCardRow,
  type CtoState,
  type CtoHealthStat,
  type CtoCalibrationTable,
  type DecisionCardRow,
  type SuggestionApi,
  type VetoCardRow,
} from "./ctoView";
import {
  BlockerSection,
  LedgerFallbackModal,
  JobLogsModal,
  NowRail,
  JustFinishedRail,
  DigestSection,
  ConnectSection,
  SuggestionSection,
  VetoSection,
  TonightSection,
  type NowCard,
  type SuggestionOption,
} from "./ctoSections";
import type { CtoCard, CtoFinishedItem, CtoDigest, CtoHeldRow, CtoLedgerPage, CtoLedgerRow, CtoProfileRender, CtoSkill, CtoTonightTask, CtoFactsRender, CtoFactRow, CtoToolsRender, CtoToolRegistryRow } from "../shared/api.js";
import { formatAge } from "./chatUtils";
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
  // BET-1405: the Overnight switch + night pool live in the Behavior card
  // (shipped with the §11 overnight wiring). The Tonight's-budget card reads
  // both — the full render is gated on High + Overnight on (§10.5 card 3).
  ctoOvernight?: boolean;
  ctoNightCapUsd?: number;
  // BET-1521 (§9.3/§9.4): the autonomy threshold τ (0..1, default 0.7) — the
  // Settings τ control writes it; the gate + calibration read it.
  ctoAutonomyThreshold?: number;
};

// §11.2 defaults — the same constants ctoBudget.mjs enforces server-side.
const DEFAULT_AMBIENT_CAP_USD = 2.5;
const DEFAULT_NIGHT_CAP_USD = 5;

export function CtoPanel({
  state,
  onOpenSession,
  onOpenSecrets,
}: {
  state: CtoState | null;
  onOpenSession: (sessionId: string) => void;
  /** BET-1437: open the secrets surface (active session, key pre-filled).
      Returns false when there is no active chat session to open it in. */
  onOpenSecrets?: (key: string | null) => boolean;
}) {
  const [view, setView] = useState<"overview" | "settings" | "ledger" | "profile" | "blackboard" | "tools">("overview");
  const pushToast = useStore((s) => s.pushAppToast);

  // --- data reads ---------------------------------------------------------
  const [digest, setDigest] = useState<CtoDigest | null>(null);
  const [cards, setCards] = useState<CtoCard[]>([]);
  const [finished, setFinished] = useState<CtoFinishedItem[]>([]);
  const [ledgerCard, setLedgerCard] = useState<BlockerCard | null>(null);
  const [logsItem, setLogsItem] = useState<CtoFinishedItem | null>(null);
  // BET-1468 item 1: the three overview reads used to end in an empty no-op
  // catch — an offline box / stale token left the lists empty with no signal,
  // and `resting()` reads "everything empty" as "nothing needs you". Track
  // whether the first load has resolved and whether it failed so the resting
  // line can be gated on both (see `mayShowResting` in ctoView.ts).
  const [overviewLoaded, setOverviewLoaded] = useState(false);
  const [overviewLoadError, setOverviewLoadError] = useState<string | null>(null);
  const reportOverviewError = useCallback(
    (label: string) => (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      setOverviewLoadError(msg);
      pushToast({ id: `cto-overview-err-${Date.now()}`, message: `Couldn't refresh ${label}: ${msg}` });
    },
    [pushToast],
  );

  // BET-1392: decision cards (§9.1) render in their own section; the Blocker
  // section keeps the ask/health cards only. The held (silent-log) list backs
  // the §14.3 silence-audit "review held" modal (opened from the digest aside).
  const [heldOpen, setHeldOpen] = useState(false);
  const [heldRows, setHeldRows] = useState<CtoHeldRow[]>([]);
  // BET-1484: a failed FIRST-EVER held load leaves `heldRows` empty, and the
  // modal then renders the "Nothing held back." empty state — a factual claim
  // ("the box holds nothing") when the truth is "we don't know". Track the
  // failure so the modal can say so (the drill-downs' error + Retry shape).
  const [heldLoadError, setHeldLoadError] = useState<string | null>(null);
  // BET-1419: veto cards (§9.2) render in their own Overnight section; the
  // Tonight drill-down (§10.4) fetches its task list when expanded.
  const [tonightExpanded, setTonightExpanded] = useState(false);
  const [tonightTasks, setTonightTasks] = useState<CtoTonightTask[]>([]);
  const [tonightLoading, setTonightLoading] = useState(false);
  const [tonightPinned, setTonightPinned] = useState(false);
  const [tonightWindowOpen, setTonightWindowOpen] = useState(false);
  const blockerCardList = useMemo(() => blockerCards(cards), [cards]);
  const suggestionCards = useMemo(() => decisionCards(cards), [cards]);
  const vetoList = useMemo(() => vetoCards(cards), [cards]);
  const connectList = useMemo(() => connectCards(cards), [cards]);

  const busy = digestBusy(state);
  const busyRef = useRef(busy);
  // §10.2: after a generation settles with an otherwise-empty overview, scroll
  // the resting line into view. Advanced from the single busyRef-bookkeeping
  // effect below (BET-1467: two effects used to share this ref, so the second
  // always read prev === busy and this never fired).
  const [didSettle, setDidSettle] = useState(false);

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
  const sessionCost = useStore((s) => s.sessionCost);

  // §10.3 target resolution: is a card's owning session still present?
  const knownSessions = useMemo(
    () => new Set(projects.flatMap((p) => p.windows.map((w) => w.opencodeSessionId).filter(Boolean) as string[])),
    [projects],
  );

  // Initial reads (and the Retry button below, on failure).
  const loadOverview = useCallback(() => {
    setOverviewLoadError(null);
    const p1 = window.api?.ctoDigestGet?.()
      .then((r) => setDigest(r.digest))
      .catch(reportOverviewError("the digest"));
    const p2 = window.api?.ctoCardsGet?.()
      .then((r) => setCards(r.cards))
      .catch(reportOverviewError("the blocker cards"));
    const p3 = window.api?.ctoFinishedGet?.()
      .then((r) => setFinished(r.items))
      .catch(reportOverviewError("the finished rail"));
    void Promise.all([p1, p2, p3]).finally(() => setOverviewLoaded(true));
  }, [reportOverviewError]);

  useEffect(() => {
    loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload the digest + finished rails when a generation completes, and the
  // cards whenever the open needs-you count changes.
  useEffect(() => {
    const prev = busyRef.current;
    busyRef.current = busy;
    const generationSettled = prev && !busy;
    if (generationSettled) {
      void window.api?.ctoDigestGet?.().then((r) => setDigest(r.digest)).catch(reportOverviewError("the digest"));
      void window.api?.ctoFinishedGet?.().then((r) => setFinished(r.items)).catch(reportOverviewError("the finished rail"));
      setDidSettle(true);
    }
  }, [busy, reportOverviewError]);

  useEffect(() => {
    if (typeof state?.needsYouCount === "number") {
      void window.api?.ctoCardsGet?.()
        .then((r) => setCards(r.cards))
        .catch(reportOverviewError("the blocker cards"));
    }
  }, [state?.needsYouCount, reportOverviewError]);

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
        const cost = sessionId ? nowCostLabel(sessionCost[sessionId]) : null;
        out.push({
          id: sessionId ?? `${p.tmuxSession}-${w.index}`,
          name: w.name,
          state: blocked ? "blocked" : "working",
          step: st.progressLabel ?? null,
          project: p.tmuxSession,
          cost,
          elapsed,
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
    // BET-1437: probe blockers deep-link to the secrets surface on the active
    // chat session (key pre-filled/highlighted in the SecretsCard when the
    // body names one). The App-side handler closes the CTO pane and dispatches
    // manta-open-secrets; with no active chat session it returns false and the
    // ledger fallback keeps the control honest (§10.3).
    if (target.action === "secrets") {
      if (onOpenSecrets?.(target.key)) return;
    }
    // ledger fallback (target/session missing, an inbox/health source whose
    // fix surface isn't in the renderer yet, or a probe with no session to
    // open the secrets card in — §10.3 keeps the control honest).
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

  // BET-1468 item 3: the pane's primary button used to discard its result —
  // `void ctoDigestNow()` — while httpApi returns `{ok:false, error}` "so the
  // pane can toast the cause" and THROWS AuthRequiredError on a 401. Pressed
  // while paused/disabled/offline it did nothing at all. Await and report BOTH
  // branches (the AGENTS.md rule); success says so too, because the fresh
  // digest only lands later, when the generation settles.
  const handleRegen = async () => {
    try {
      const r = await window.api?.ctoDigestNow?.();
      if (r && !r.ok) {
        pushToast({ id: `regen-${Date.now()}`, message: `Couldn't regenerate the digest: ${r.error ?? "unknown error"}` });
      } else {
        pushToast({ id: `regen-${Date.now()}`, message: "Digest regeneration started — the pane refreshes when it lands" });
      }
    } catch (e) {
      pushToast({ id: `regen-${Date.now()}`, message: `Couldn't regenerate the digest: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  // BET-1392 decision-card actions (§9.1). The existing renderer api surface is
  // injected into the pure executor: config-change → configUpdate, start-job →
  // delegate, record-decision → the facts route. Outcome is reported (toast on
  // failure); a successful execution is a positive judgment → verdict accept.
  // Typed as SuggestionApi (shared/api is the single source for the shapes).
  const suggestionApi = useMemo<SuggestionApi>(
    () => ({
      configUpdate: (patch) => window.api?.configUpdate?.(patch) ?? Promise.resolve({}),
      delegateStart: async (input) => {
        const r = await rendererDelegateStart(input);
        return { ok: !!r?.ok, error: r?.error };
      },
      ctoFact: (input) => window.api?.ctoFact?.(input) ?? Promise.resolve({ ok: false, error: "facts unavailable" }),
      ctoTonightAct: (input) => window.api?.ctoTonightAct?.(input) ?? Promise.resolve({ ok: false, error: "tonight unavailable" }),
    }),
    [],
  );

  const refreshCards = useCallback(() => {
    void window.api?.ctoCardsGet?.().then((r) => setCards(r.cards)).catch(reportOverviewError("the blocker cards"));
  }, [reportOverviewError]);

  // BET-1468 item 4: the §9.2/§9.3/§7.4 action handlers below each POST an
  // action that either resolves `{ok:false}` (toasted by its own .then) OR
  // REJECTS (an AuthRequiredError on a stale token, or a network failure —
  // §401). An empty no-op catch swallowed that second case: with a
  // stale token every one of these controls did nothing and said nothing.
  // One handler, every call site, instead of writing the same catch six times.
  const catchActionError = useCallback(
    (label: string) => (e: unknown) => {
      pushToast({ id: `cto-act-err-${Date.now()}`, message: `Couldn't ${label}: ${e instanceof Error ? e.message : String(e)}` });
    },
    [pushToast],
  );

  const handleSuggestionAction = useCallback(
    (card: DecisionCardRow, option: SuggestionOption) => {
      void (async () => {
        const r = await executeSuggestionOption({ option, api: suggestionApi });
        if (r.ok) {
          // acted-on = accept judgment through the B3 verdict route.
          void window.api
            ?.ctoVerdict?.({ subject: { type: "suggestion", id: card.id, class: option.action?.type }, verdict: "accept" })
            .catch(catchActionError("record the acceptance judgment"));
          pushToast({ id: `sugg-${Date.now()}`, message: `Applied: ${option.label}` });
          refreshCards();
        } else {
          pushToast({ id: `sugg-fail-${Date.now()}`, message: `Couldn't apply “${option.label ?? ""}”: ${r.error ?? "unknown error"}` });
        }
      })();
    },
    [suggestionApi, pushToast, refreshCards, catchActionError],
  );

  // BET-1468 item 5: the verdict write was fire-and-forget with an empty
  // catch, racing an un-awaited `refreshCards()` — a failed dismiss silently
  // left the pipeline never learning the judgment, while the card visually
  // vanished (refreshCards ran regardless). Chain it like every sibling
  // action below: await, toast a failure, then refresh either way.
  const handleSuggestionDismiss = useCallback(
    (card: DecisionCardRow) => {
      void window.api
        ?.ctoVerdict?.({ subject: { type: "suggestion", id: card.id }, verdict: "dismiss" })
        .then((r) => {
          if (!r?.ok) pushToast({ id: `sugg-dismiss-fail-${Date.now()}`, message: `Couldn't dismiss: ${r?.error ?? "unknown error"}` });
        })
        .catch(catchActionError("dismiss the suggestion"))
        .finally(refreshCards);
    },
    [refreshCards, pushToast, catchActionError],
  );

  // BET-1395 connect asks (§7.4): the three-way answer is a registry write
  // (consent ring + §9.5 verdict + card resolution) — the server route does
  // all three; the client toasts the outcome and refreshes the cards.
  const handleConnectAnswer = useCallback(
    (card: ConnectCardRow, answer: string) => {
      // BET-1431: the {tool, answer, ring} argument-building lives in
      // ctoView.connectAnswerArgs (pure + tested). A card whose option
      // carries no `action.payload.tool` produces NO call — never a call
      // with a bogus/undefined tool.
      const args = connectAnswerArgs(card, answer);
      if (!args) return;
      const deepRead = args.ring === "deep_read";
      void window.api
        ?.ctoToolConnect?.(args)
        .then((r) => {
          if (r?.ok) {
            pushToast({
              id: `connect-${Date.now()}`,
              message:
                answer === "connect"
                  ? deepRead
                    ? "Connected — deep read access granted"
                    : "Connected read-only — metadata consent granted"
                  : answer === "never"
                    ? "Will not connect to this tool"
                    : "Not now — I'll ask again later",
            });
          } else {
            pushToast({ id: `connect-fail-${Date.now()}`, message: `Couldn't record answer: ${r?.error ?? "unknown"}` });
          }
        })
        .catch(catchActionError("record the connect answer"))
        .finally(refreshCards);
    },
    [pushToast, refreshCards, catchActionError],
  );

  // BET-1419 tonight + veto actions (§9.2/§10.4). The veto card's Cancel
  // tonight is a veto VERDICT on the veto-window subject — the server route
  // performs the actual cancel (pause + close) before recording it. Run-now
  // and the drill-down edits go through the tonight verb route.
  //
  // BET-1468 item 6: a rejected fetch (stale token, offline box) used to wipe
  // `tonightTasks`/`tonightWindowOpen` to empty here, so a genuinely queued
  // plan flashed to "Nothing queued." while the box kept running it, and
  // `tonightPinned` was left stale (contradicting the now-empty list). Keep
  // whatever was last loaded and toast the failure instead of erasing it.
  const refreshTonight = useCallback(() => {
    setTonightLoading(true);
    void window.api
      ?.ctoTonightGet?.()
      .then((r) => {
        setTonightTasks(r.tasks ?? []);
        setTonightPinned(Array.isArray(r.window?.pinnedOrder) && r.window.pinnedOrder.length > 0);
        setTonightWindowOpen(r.window?.state === "open");
      })
      .catch(catchActionError("refresh tonight's plan"))
      .finally(() => setTonightLoading(false));
  }, [catchActionError]);

  const handleVetoCancel = useCallback(
    (card: VetoCardRow) => {
      void window.api
        // BET-1403: the class stamp is the canonical §9.3 action class the
        // veto window guards (queue-tonight) — it must agree with the trust
        // record's consumer, not name the feature.
        ?.ctoVerdict?.({ subject: { type: "veto-window", id: card.id, class: "queue-tonight" }, verdict: "veto" })
        .then((r) => {
          if (!r?.ok) pushToast({ id: `veto-${Date.now()}`, message: `Couldn't cancel tonight: ${r?.error ?? "unknown"}` });
        })
        .catch(catchActionError("cancel tonight"))
        .finally(refreshCards);
    },
    [pushToast, refreshCards, catchActionError],
  );

  const handleVetoEditPlan = useCallback(() => {
    setTonightExpanded(true);
    refreshTonight();
  }, [refreshTonight]);

  const handleVetoRunNow = useCallback(
    () => {
      void window.api
        ?.ctoTonightAct?.({ action: "run-now" })
        .then((r) => {
          if (!r?.ok) pushToast({ id: `runnow-${Date.now()}`, message: `Couldn't start overnight now: ${r?.error ?? "unknown"}` });
          else pushToast({ id: `runnow-${Date.now()}`, message: "Overnight run starting" });
        })
        .catch(catchActionError("start overnight now"))
        .finally(refreshCards);
    },
    [pushToast, refreshCards, catchActionError],
  );

  const handleTonightToggle = useCallback(() => {
    setTonightExpanded((prev) => {
      if (!prev) refreshTonight();
      return !prev;
    });
  }, [refreshTonight]);

  const handleTonightCancel = useCallback(() => {
    void window.api
      ?.ctoTonightAct?.({ action: "cancel" })
      .then((r) => {
        if (!r?.ok) pushToast({ id: `tonight-${Date.now()}`, message: `Couldn't cancel tonight: ${r?.error ?? "unknown"}` });
      })
      .catch(catchActionError("cancel the overnight plan"))
      .finally(() => {
        refreshCards();
        refreshTonight();
      });
  }, [pushToast, refreshCards, refreshTonight, catchActionError]);

  const handleTonightRemove = useCallback(
    (id: string) => {
      void window.api
        ?.ctoTonightAct?.({ action: "remove", id })
        .then((r) => {
          if (!r?.ok) pushToast({ id: `tonight-${Date.now()}`, message: `Couldn't remove the task: ${r?.error ?? "unknown"}` });
        })
        .catch(catchActionError("remove the task"))
        .finally(refreshTonight);
    },
    [pushToast, refreshTonight, catchActionError],
  );

  // Reorder via the up/down arrows — PINS the order for the current window
  // (exempt from re-scoring; cleared when the window closes, §10.4).
  const handleTonightMove = useCallback(
    (id: string, dir: -1 | 1) => {
      const ids = tonightTasks.map((t) => t.id);
      const i = ids.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      void window.api
        ?.ctoTonightAct?.({ action: "reorder", ids })
        .then((r) => {
          if (!r?.ok) pushToast({ id: `tonight-${Date.now()}`, message: `Couldn't reorder: ${r?.error ?? "unknown"}` });
        })
        .catch(catchActionError("reorder tasks"))
        .finally(refreshTonight);
    },
    [tonightTasks, pushToast, refreshTonight, catchActionError],
  );

  // Keep the veto countdown live between state events.
  const [, setTick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(h);
  }, []);

  // §14.3 silence audit: open / refresh the held list (from the digest aside).
  // BET-1468 item 6: a failed load used to reset `heldRows` to `[]`, so the
  // modal opened claiming "Nothing held back." right after the digest said
  // otherwise. Keep whatever was last loaded (the Refresh button in the empty
  // state covers retry) and toast the failure instead. BET-1484: on a
  // first-ever failure that kept list is empty, so also record the error and
  // let the modal render its in-modal error line + Retry (drill-down shape)
  // rather than the empty state.
  const openHeld = useCallback(() => {
    void (async () => {
      try {
        const r = await window.api?.ctoHeldList?.();
        setHeldRows(r.rows);
        setHeldLoadError(null);
      } catch (e) {
        setHeldLoadError(e instanceof Error ? e.message : String(e));
        catchActionError("load held suggestions")(e);
      } finally {
        setHeldOpen(true);
      }
    })();
  }, [catchActionError]);
  // BET-1468 item 6: the row was removed from the list unconditionally even
  // when the verdict POST failed (or threw on a stale token) — the user sees
  // it accepted/dismissed while the pipeline never recorded the judgment.
  // Only remove it once the server confirms the verdict landed.
  const handleHeldVerdict = useCallback(
    (row: CtoHeldRow, verdict: "accept" | "dismiss") => {
      void (async () => {
        try {
          const r = await window.api?.ctoHeldVerdict?.({ id: row.id, verdict });
          if (r?.ok) {
            setHeldRows((prev) => prev.filter((x) => x.id !== row.id));
          } else {
            pushToast({ id: `held-${Date.now()}`, message: `Couldn't ${verdict} held suggestion: ${r?.error ?? "unknown"}` });
          }
        } catch (e) {
          catchActionError(`${verdict} the held suggestion`)(e);
        }
      })();
    },
    [pushToast, catchActionError],
  );
  // BET-1447: the digest "view evidence →" chip must always act (no dead
  // controls). Same decision table as the blackboard fact chips: jump to the
  // first openable session ref, copy the ref + toast otherwise. The §14.1
  // `ctoDigestOpened` ledger entry still fires first.
  const copyEvidenceRef = async (ref: string) => {
    try {
      await navigator.clipboard.writeText(ref);
    } catch {
      /* clipboard can be denied in the sandbox; the chip still responds */
    }
    pushToast({ id: `cto-ev-${ref}`, message: `Copied evidence ref: ${ref}` });
  };
  const handleItemOpen = (item: { id: string; text: string; refs?: string[] }) => {
    // Best-effort §14.1 ledger write — httpApi.ts documents this as
    // non-critical to rendering. The visible action (jump/copy below) always
    // happens regardless of whether this instrumentation call lands.
    void window.api?.ctoDigestOpened?.({ item: item.id, expand: false, digestId: digest?.id ?? null }).catch(() => { /* non-critical, see httpApi.ts */ });
    const evidence = digestEvidenceAction(item.refs, knownSessions, item.id);
    if (evidence.kind === "jump") {
      onOpenSession(evidence.ref);
    } else if (evidence.ref) {
      void copyEvidenceRef(evidence.ref);
    }
  };
  const handleItemExpand = (item: { id: string }) => {
    // Same best-effort §14.1 write as handleItemOpen — expanding the item is
    // the visible action here and already happened by the time this fires.
    void window.api?.ctoDigestOpened?.({ item: item.id, expand: true, digestId: digest?.id ?? null }).catch(() => { /* non-critical, see httpApi.ts */ });
  };

  // --- resting gate (§10.6-1) ----------------------------------------------
  // BET-1468 item 1: "Nothing needs you ✓" is a confident claim — it must
  // never render before the first overview load resolves (empty state on
  // open) or after that load failed (an offline box / stale token would
  // otherwise read as a false all-clear). `mayShowResting` is the pure gate.
  const isResting = resting({
    cards,
    nowActive: nowCards,
    finished,
    digestHasItems: (digest?.items?.length ?? 0) > 0,
  });
  const showResting = mayShowResting({ loaded: overviewLoaded, loadError: !!overviewLoadError, isResting });

  const restingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (didSettle && showResting) {
      restingRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [didSettle, showResting]);

  if (view === "settings") {
    return (
      <SettingsView
        paused={paused}
        pausedAt={state?.pausedAt ?? null}
        onBack={() => setView("overview")}
        onLedger={() => setView("ledger")}
        onProfile={() => setView("profile")}
        onBlackboard={() => setView("blackboard")}
        onTools={() => setView("tools")}
        onResume={() => void resumeCto()}
      />
    );
  }
  if (view === "ledger") {
    return <LedgerView onBack={() => setView("settings")} pushToast={pushToast} />;
  }
  if (view === "profile") {
    return <ProfileView onBack={() => setView("settings")} pushToast={pushToast} />;
  }
  if (view === "blackboard") {
    return (
      <BlackboardView
        onBack={() => setView("settings")}
        pushToast={pushToast}
        onOpenSession={onOpenSession}
        openableSessions={knownSessions}
      />
    );
  }
  if (view === "tools") {
    return <ToolIntegrationsView onBack={() => setView("settings")} pushToast={pushToast} />;
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
          <BlockerSection cards={blockerCardList} now={Date.now()} onAnswer={handleAnswer} />
          <VetoSection cards={vetoList} now={Date.now()} onCancel={handleVetoCancel} onEditPlan={handleVetoEditPlan} onRunNow={handleVetoRunNow} />
          <ConnectSection cards={connectList} onAnswer={handleConnectAnswer} />
          <SuggestionSection cards={suggestionCards} onAction={handleSuggestionAction} onDismiss={handleSuggestionDismiss} />
          <NowRail cards={nowCards} />
          <JustFinishedRail items={finished} now={Date.now()} onOpen={handleOpenFinished} />
          <DigestSection
            digest={digest}
            busy={busy}
            onRegen={handleRegen}
            onItemOpen={handleItemOpen}
            onItemExpand={handleItemExpand}
            onOpenHeld={openHeld}
          />
          {tonightVisible(state?.tonightCount, state?.tier ?? undefined) ? (
            <TonightSection
              count={state?.tonightCount ?? 0}
              expanded={tonightExpanded}
              onToggle={handleTonightToggle}
              tasks={tonightTasks}
              tasksLoading={tonightLoading}
              pinned={tonightPinned}
              windowOpen={tonightWindowOpen}
              onCancelTonight={handleTonightCancel}
              onRemove={handleTonightRemove}
              onMove={handleTonightMove}
              onOpenSettings={() => setView("settings")}
            />
          ) : null}
        </div>

        {/* Resting state (§10.6-1): only when every section is empty AND the
            overview actually loaded (never on open, never on a failed load —
            see `mayShowResting`). */}
        {showResting && (
          <div ref={restingRef} className="flex flex-col items-center gap-1 py-12">
            <div className="text-text-muted">
              Nothing needs you <span aria-hidden>✓</span>
            </div>
            <div className="text-sm text-text-faint">
              I&rsquo;ll surface anything that needs your attention here.
            </div>
          </div>
        )}

        {/* BET-1468 item 1: a failed overview load must say so, not render
            an empty resting state that reads as a false all-clear. */}
        {overviewLoadError && (
          <div className="flex flex-col items-center gap-1 py-12">
            <div className="text-sm text-text-muted">Couldn&rsquo;t load the CTO overview: {overviewLoadError}</div>
            <button
              type="button"
              onClick={loadOverview}
              className="text-sm text-accent underline hover:text-accent-strong"
            >
              Retry
            </button>
          </div>
        )}
      </div>

      {ledgerCard && (
        <LedgerFallbackModal
          card={ledgerCard}
          onClose={() => setLedgerCard(null)}
          onOpenLedger={() => {
            setLedgerCard(null);
            setView("ledger");
          }}
        />
      )}
      {logsItem && logsItem.kind === "job" && (
        <JobLogsModal
          name={logsItem.name}
          detail={logsItem.detail}
          onClose={() => setLogsItem(null)}
        />
      )}
      {heldOpen && (
        <HeldListModal
          rows={heldRows}
          loadError={heldLoadError}
          onClose={() => setHeldOpen(false)}
          onRefresh={() => openHeld()}
          onVerdict={handleHeldVerdict}
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
  onProfile,
  onBlackboard,
  onTools,
  onResume,
}: {
  paused: boolean;
  pausedAt: number | null;
  onBack: () => void;
  onLedger: () => void;
  onProfile: () => void;
  onBlackboard: () => void;
  onTools: () => void;
  onResume: () => void;
}) {
  const pushToast = useStore((s) => s.pushAppToast);
  // Local mirror of the adaptive-CTO config cluster, loaded on open so the
  // controls reflect the box; edits write through configUpdate (instant-apply).
  const [config, setConfig] = useState<CtoSettingsConfig | null>(null);
  const [capText, setCapText] = useState("");
  const [nightCapText, setNightCapText] = useState("");
  const [tauText, setTauText] = useState("");
  const [health, setHealth] = useState<CtoHealthStat[]>([]);
  const [busyPause, setBusyPause] = useState(false);
  // BET-1521 (§9.5): the per-class calibration table (value + counts + current
  // τ), read with the health stats on settings-open — one payload, no polling.
  const [calibration, setCalibration] = useState<CtoCalibrationTable | null>(null);
  // BET-1405 (§10.5 card 3): budget payload (day buckets + quota cache) and
  // usage snapshots (provider window notes), read once on settings-open.
  const [budget, setBudget] = useState<{ days?: Record<string, { usd?: number } | undefined>; quota?: Record<string, { provider?: string; mode?: string | null; reserve?: number | null; mape14?: number | null } | undefined> } | null>(null);
  const [usageSnaps, setUsageSnaps] = useState<{ provider?: string; windows?: { kind?: string; label?: string; resetsAt?: number | null }[] | null }[]>([]);
  // BET-1468 item 2: `config` starts null and the four reads had no `.catch()`
  // at all — while loading, every control displayed a default the box never
  // sent (the effort radios showed "Low" on a High-tier box and a click wrote
  // that downgrade through), and on a failure the pane stayed there forever.
  // Track load state; the Behavior/Tonight cards stay gated on `config`.
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const reportSettingsLoadError = useCallback(
    (label: string) => (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      setSettingsLoadError(msg);
      pushToast({ id: `cto-set-err-${Date.now()}`, message: `Couldn't load ${label}: ${msg}` });
    },
    [pushToast],
  );
  const loadSettings = useCallback(() => {
    setSettingsLoadError(null);
    void window.api.configGet().then((c) => {
      if (!aliveRef.current) return;
      setConfig({
        ctoEnabled: !!c?.ctoEnabled,
        ctoTier: c?.ctoTier,
        ctoAmbientCap: c?.ctoAmbientCap,
        ctoDigestPush: !!c?.ctoDigestPush,
        ctoOvernight: !!c?.ctoOvernight,
        ctoNightCapUsd: c?.ctoNightCapUsd,
        ctoAutonomyThreshold: c?.ctoAutonomyThreshold,
      });
      setCapText(String(c?.ctoAmbientCap ?? DEFAULT_AMBIENT_CAP_USD));
      setNightCapText(c?.ctoNightCapUsd != null ? String(c.ctoNightCapUsd) : "");
      setTauText(c?.ctoAutonomyThreshold != null ? String(c.ctoAutonomyThreshold) : "");
    }).catch(reportSettingsLoadError("the CTO settings"));
    void window.api.ctoHealthGet().then((h) => {
      if (!aliveRef.current) return;
      setHealth(h.stats);
      setCalibration(h.calibration ?? null);
    }).catch(reportSettingsLoadError("the health stats"));
    // BET-1405 (§10.5 card 3): the persisted budget payload (day buckets +
    // quota cache) and the usage snapshots (provider window notes) — one read
    // on settings-open, never polled.
    void window.api.ctoQuotaRead().then((b) => {
      if (aliveRef.current) setBudget(b ?? null);
    }).catch(reportSettingsLoadError("the budget history"));
    void window.api.usageList().then((snaps) => {
      if (aliveRef.current) setUsageSnaps(Array.isArray(snaps) ? snaps : []);
    }).catch(reportSettingsLoadError("the usage snapshots"));
  }, [reportSettingsLoadError]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const applyConfig = useCallback(
    async (patch: Partial<CtoSettingsConfig>) => {
      const prev = config;
      setConfig((c) => ({ ...(c ?? {}), ...patch }));
      try {
        const next = (await window.api.configUpdate(patch)) as CtoSettingsConfig;
        setConfig((c) => ({ ...c, ...patch, ctoAmbientCap: next?.ctoAmbientCap }));
      } catch (e) {
        // BET-1468 item 2: restore exactly what was on screen before the
        // optimistic patch — the old `prev ?? {}` fabricated an empty config
        // (and lost the patch state) whenever the write failed.
        setConfig(prev);
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

  // BET-1419 (§11.2): the windowless providers' absolute night budget. Empty
  // clears the bound (windowless providers then get no overnight budget seam).
  const saveNightCap = useCallback(() => {
    const text = nightCapText.trim();
    if (text === "") {
      void applyConfig({ ctoNightCapUsd: undefined });
      return;
    }
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) {
      pushToast({ id: `nightcap-${Date.now()}`, message: "Night cap must be a non-negative dollar amount (or empty)." });
      return;
    }
    void applyConfig({ ctoNightCapUsd: Math.round(n * 100) / 100 });
  }, [nightCapText, applyConfig, pushToast]);

  // BET-1521 (§9.3/§9.4): the autonomy threshold τ — a proportion, 0..1.
  // Two decimals is the meaningful precision (the gate compares against a
  // calibration mean, not a micro-signal); values outside the range are a
  // rejected write, not a silent clamp (a silently-clamped 5 would read as 1
  // on reopen with no hint it was capped).
  const saveTau = useCallback(() => {
    const n = Number(tauText);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      pushToast({ id: `tau-${Date.now()}`, message: "Autonomy bar must be between 0 and 1." });
      return;
    }
    void applyConfig({ ctoAutonomyThreshold: Math.round(n * 100) / 100 });
  }, [tauText, applyConfig, pushToast]);

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
          {/* BET-1468 item 2: never render controls over a config the box has
              not sent — the `?? false` / `?? "low"` defaults read as facts, and
              a click on the effort dial wrote the fake tier through. Gate the
              card on the read; the Loading… line matches the sibling
              drill-downs, the failure case gets a Retry that re-runs the read. */}
          {config === null ? (
            settingsLoadError ? (
              <div className="rounded-lg border border-border-subtle p-4">
                <div className="text-sm text-text-muted">Couldn&rsquo;t load the CTO settings: {settingsLoadError}</div>
                <button
                  type="button"
                  onClick={loadSettings}
                  className="mt-2 text-sm text-accent underline hover:text-accent-strong"
                >
                  Retry
                </button>
              </div>
            ) : (
              <p className="text-sm text-text-faint">Loading…</p>
            )
          ) : (
          <section className="rounded-lg border border-border-subtle p-4">
            <h3 className="text-sm font-semibold text-text">Behavior</h3>
            <p className="mt-1 text-sm text-text-faint">
              One hard daily cap (<span className="font-mono">${(config?.ctoAmbientCap ?? 2.5).toFixed(2)}</span>)
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

              {/* Autonomy bar τ (BET-1521, §9.3/§9.4): the calibrated gate's
                  threshold. Sits with the effort dial — both bound how much
                  the CTO does on its own. */}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-text">Autonomy bar (τ)</div>
                  <div className="text-sm text-text-muted">
                    The CTO acts on its own when its confidence clears this bar (0–1, default 0.7).
                  </div>
                </div>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={tauText}
                  onChange={(e) => setTauText(e.target.value)}
                  onBlur={saveTau}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveTau();
                  }}
                  className="w-20 rounded-md border border-border bg-bg px-2 py-1 text-sm text-text"
                  aria-label="Autonomy threshold tau, between 0 and 1"
                />
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

              {/* BET-1419 Overnight switch (§11.1 consent) — High tier only. */}
              {(config?.ctoTier ?? "low") === "high" ? (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-text">Overnight work</div>
                    <div className="text-sm text-text-muted">
                      Let the CTO run queued work unattended in the quiet trough (you get a
                      30-min veto card first).
                    </div>
                  </div>
                  <Toggle
                    checked={!!config?.ctoOvernight}
                    onChange={(v) => void applyConfig({ ctoOvernight: v })}
                    ariaLabel="Overnight work enabled"
                  />
                </div>
              ) : null}

              {/* BET-1419 night cap (§11.2): the windowless providers' bound. */}
              {(config?.ctoTier ?? "low") === "high" ? (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-text">Overnight cap (no usage window)</div>
                    <div className="text-sm text-text-muted">
                      Absolute dollar bound for providers without a usage window (empty = no
                      overnight budget for them).
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-text-muted">$</span>
                    <input
                      type="number"
                      min={0}
                      step={0.25}
                      value={nightCapText}
                      onChange={(e) => setNightCapText(e.target.value)}
                      onBlur={saveNightCap}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveNightCap();
                      }}
                      className="w-20 rounded-md border border-border bg-bg px-2 py-1 text-sm text-text"
                      aria-label="Overnight cap for windowless providers in dollars"
                    />
                  </div>
                </div>
              ) : null}

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
          )}

          {/* ---------- Autonomy calibration table (§9.5, BET-1521) ---------- */}
          {/* Read-only: where the CTO is holding itself back per class — the
              Beta(1,1) mean over each class's last-30 outcomes, the raw counts
              behind it, and the configured τ. Collects until the store holds
              windows; a failed read renders the collecting line, never zeros. */}
          <section className="rounded-lg border border-border-subtle p-4">
            <h3 className="text-sm font-semibold text-text">Autonomy calibration</h3>
            {(() => {
              const cal = calibrationTableDisplay(calibration);
              return cal.collecting ? (
                <p className="mt-1 text-sm text-text-faint">
                  Collecting — the per-class windows fill as the CTO resolves work.
                </p>
              ) : (
                <div className="mt-3">
                  <p className="text-sm text-text-muted">
                    Beta mean over each class&rsquo;s last 30 outcomes
                    {cal.tauText ? ` · current ${cal.tauText}` : ""}.
                  </p>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-text-faint">
                          <th className="py-2 font-medium">Class</th>
                          <th className="py-2 font-medium">Calibration</th>
                          <th className="py-2 text-right font-medium">Outcomes</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border-subtle">
                        {cal.rows.map((row) => (
                          <tr key={row.cls}>
                            <td className="py-2 text-text-muted">{row.cls}</td>
                            <td className="py-2 font-mono text-text">{row.value.toFixed(2)}</td>
                            <td className="py-2 text-right font-mono text-text">
                              {row.successes}/{row.outcomes}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}
          </section>

          {/* BET-1468 item 2: the config read landed but a secondary read
              failed — say so (the toast already fired) with a Retry, instead
              of leaving the health/budget sections silently empty. */}
          {config !== null && settingsLoadError ? (
            <div className="rounded-lg border border-border-subtle p-3">
              <div className="text-sm text-text-muted">Couldn&rsquo;t load everything: {settingsLoadError}</div>
              <button
                type="button"
                onClick={loadSettings}
                className="mt-2 text-sm text-accent underline hover:text-accent-strong"
              >
                Retry
              </button>
            </div>
          ) : null}

          {/* ---------- Health card (§10.5 card 2) ---------- */}
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
                      : id === "pipelineLag"
                      ? "Pipeline lag (close → summary)"
                      : id === "suggestionAcceptance"
                      ? "Suggestion acceptance · 30d"
                      : id === "forecastAccuracy"
                      ? "Forecast accuracy · MAPE 14d"
                      : id === "capHitsCaused"
                      ? "Cap-hits caused · 30d"
                      : id === "reserveFractile"
                      ? "Reserve fractile"
                      : id === "autonomyResolvedUnaided"
                      ? "Resolved unaided · 30d"
                      : id === "autonomyBlockerToResolve"
                      ? "Blocker → resolution · 30d"
                      : "ROI · self-report",
                  value: null,
                  n: 0,
                  min: 1,
                };
                const d = statDisplay(stat);
                return (
                  <li key={id} className="flex items-baseline justify-between gap-3 py-2">
                    <span className="text-sm text-text-muted">{stat.label}</span>
                    <span className={"text-right text-sm " + (d.ready ? "font-mono text-text" : "text-text-faint")}>
                      {d.text}
                    </span>
                  </li>
                );
              })}
              {/* BET-1521 (§14-7): the per-class autonomy + calibration rows
                  (`autonomyClass.<cls>` / `autonomyCalib.<cls>`) — the server
                  emits them only for classes with signals in the 30d window,
                  in a deterministic order, so they render only when the data
                  exists and gate on their own min-sample size. */}
              {health
                .filter((s) => s.id.startsWith("autonomyClass.") || s.id.startsWith("autonomyCalib."))
                .map((stat) => {
                  const d = statDisplay(stat);
                  return (
                    <li key={stat.id} className="flex items-baseline justify-between gap-3 py-2">
                      <span className="text-sm text-text-muted">{stat.label}</span>
                      <span className={"text-right text-sm " + (d.ready ? "font-mono text-text" : "text-text-faint")}>
                        {d.text}
                      </span>
                    </li>
                  );
                })}
            </ul>
          </section>

          {/* ---------- Tonight's budget (§10.5 card 3, BET-1405) ---------- */}
          {/* BET-1468 item 2: gated like the Behavior card — `tier ?? "low"`
              here used to render "Overnight work is off — there is no night
              pool to gauge", a false statement about a High-tier box, while
              the read was still in flight (or after it failed). */}
          {config !== null ? (
            <TonightBudgetCard
              tier={config?.ctoTier ?? "low"}
              overnightOn={!!config?.ctoOvernight}
              ambientCapUsd={config?.ctoAmbientCap ?? DEFAULT_AMBIENT_CAP_USD}
              nightCapUsd={config?.ctoNightCapUsd ?? DEFAULT_NIGHT_CAP_USD}
              budget={budget}
              usageSnaps={usageSnaps}
            />
          ) : null}

          {/* ---------- Internals: rows 1-4 of the §10.5 drill-down list ---------- */}
          <section className="rounded-lg border border-border-subtle p-4">
            <h3 className="text-sm font-semibold text-text">Internals</h3>
            <button
              type="button"
              onClick={onBlackboard}
              className="mt-2 flex w-full items-center justify-between rounded-md border border-border-subtle px-3 py-2 text-left hover:bg-fill-hover"
            >
              <span>
                <span className="block text-sm font-medium text-text">Blackboard</span>
                <span className="block text-xs text-text-muted">
                  Facts per project — confidence, supersession, archive.
                </span>
              </span>
              <span className="text-text-muted">›</span>
            </button>
            <button
              type="button"
              onClick={onProfile}
              className="mt-2 flex w-full items-center justify-between rounded-md border border-border-subtle px-3 py-2 text-left hover:bg-fill-hover"
            >
              <span>
                <span className="block text-sm font-medium text-text">Profile &amp; rhythm</span>
                <span className="block text-xs text-text-muted">
                  What the CTO believes about you — skills, sleep window, journal.
                </span>
              </span>
              <span className="text-text-muted">›</span>
            </button>
            <button
              type="button"
              onClick={onTools}
              className="mt-2 flex w-full items-center justify-between rounded-md border border-border-subtle px-3 py-2 text-left hover:bg-fill-hover"
            >
              <span>
                <span className="block text-sm font-medium text-text">Tool integrations</span>
                <span className="block text-xs text-text-muted">
                  External tools — role, engagement, consent, probes.
                </span>
              </span>
              <span className="text-text-muted">›</span>
            </button>
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

// §10.5 card 2 render order. BET-1400's forecast/cap-hit/reserve rows,
// BET-1405's ROI row, then BET-1521's box-wide §14-7 autonomy rows (the
// per-class rows render dynamically after these — class ids are data-derived,
// so they can't live in a const list).
const HEALTH_ROW_ORDER = [
  "ambientSpendToday",
  "digestOpens",
  "pipelineLag",
  "suggestionAcceptance",
  "forecastAccuracy",
  "capHitsCaused",
  "reserveFractile",
  "roi",
  "autonomyResolvedUnaided",
  "autonomyBlockerToResolve",
] as const;

// ---------------------------------------------------------------------------
// Tonight's-budget card (§10.5 card 3, BET-1405)
// ---------------------------------------------------------------------------
type TonightBudgetProps = {
  tier: "low" | "medium" | "high";
  overnightOn: boolean;
  ambientCapUsd: number;
  nightCapUsd: number;
  budget: { days?: Record<string, { usd?: number } | undefined>; quota?: Record<string, { provider?: string; mode?: string | null; reserve?: number | null; mape14?: number | null } | undefined> } | null;
  usageSnaps: { provider?: string; windows?: { kind?: string; label?: string; resetsAt?: number | null }[] | null }[];
};

function formatResetNote(resetsAt: number | null): string {
  if (resetsAt == null) return "";
  const diff = resetsAt - Date.now();
  if (diff <= 0) return "resetting…";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.round(mins / 60);
  return `resets in ${hours}h`;
}

function TonightBudgetCard({ tier, overnightOn, ambientCapUsd, nightCapUsd, budget, usageSnaps }: TonightBudgetProps) {
  const mode = tonightBudgetMode({ tier, overnightOn });
  const usedTodayUsd = budgetTodayUsd(budget ?? null);
  const notes = providerWindowNotes(usageSnaps);
  const accuracy = forecastAccuracyRows(budget?.quota ?? null);

  if (mode === "ambient") {
    return (
      <section className="rounded-lg border border-border-subtle p-4">
        <h3 className="text-sm font-semibold text-text">Tonight&apos;s budget</h3>
        <div className="mt-3 flex items-baseline justify-between gap-3">
          <span className="text-sm text-text-muted">Ambient spend today</span>
          <span className="font-mono text-sm text-text">
            ${usedTodayUsd.toFixed(2)} of ${Number(ambientCapUsd).toFixed(2)} cap
          </span>
        </div>
        <p className="mt-2 text-xs text-text-faint">
          Overnight work is {overnightOn ? "below the High tier" : "off"} — there is no night pool to gauge.
        </p>
        <p className="mt-2 text-xs text-text-faint">Plan editing lives in the tonight drill-down.</p>
      </section>
    );
  }

  // Full render (High + Overnight on): the night-pool gauge with used /
  // planned segments + the reserve line, legend, window notes, accuracy.
  const plannedTonightUsd: number | null = null; // §10.4 plan portfolio — wired when the tonight plan lands
  const reserveFrac = bindingReserveFrac(budget?.quota ?? null);
  const gauge = nightGauge({ nightCapUsd, usedTodayUsd, plannedTonightUsd, reserveFrac });
  const usedPct = gauge.poolUsd > 0 ? (gauge.usedUsd / gauge.poolUsd) * 100 : 0;
  const plannedPct = gauge.poolUsd > 0 ? (gauge.plannedUsd / gauge.poolUsd) * 100 : 0;
  const reservePct = gauge.reserveLineUsd != null && gauge.poolUsd > 0 ? (gauge.reserveLineUsd / gauge.poolUsd) * 100 : null;

  return (
    <section className="rounded-lg border border-border-subtle p-4">
      <h3 className="text-sm font-semibold text-text">Tonight&apos;s budget</h3>

      <div className="mt-3">
        <div className="relative h-4 w-full overflow-hidden rounded-full bg-fill-active">
          <div className="absolute inset-y-0 left-0 bg-accent/25" style={{ width: `${Math.min(100, usedPct)}%` }} />
          <div
            className="absolute inset-y-0 bg-accent/60"
            style={{ left: `${Math.min(100, usedPct)}%`, width: `${Math.min(100 - Math.min(100, usedPct), plannedPct)}%` }}
          />
          {reservePct != null && (
            <div
              className="absolute inset-y-0 w-0.5 bg-warn"
              style={{ left: `${Math.min(100, reservePct)}%` }}
              aria-hidden="true"
            />
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-text-muted">
          <span>
            Used today <span className="font-mono text-text">${gauge.usedUsd.toFixed(2)}</span>
          </span>
          <span>
            Planned tonight{" "}
            <span className="font-mono text-text">
              {plannedTonightUsd != null ? `$${gauge.plannedUsd.toFixed(2)}` : "no plan queued"}
            </span>
          </span>
          <span>
            Night pool <span className="font-mono text-text">${gauge.poolUsd.toFixed(2)}</span>
            {gauge.overflow ? " · over pool" : ""}
          </span>
        </div>
      </div>

      {/* Legend (§10.5 card 3) */}
      <ul className="mt-3 space-y-1 text-xs text-text-faint">
        <li>
          <span className="mr-1 inline-block h-2 w-4 rounded-sm bg-accent/25 align-middle" /> used today — ambient +
          overnight spend metered into the same daily buckets
        </li>
        <li>
          <span className="mr-1 inline-block h-2 w-4 rounded-sm bg-accent/60 align-middle" /> planned tonight — the
          queued plan&apos;s spend estimate
        </li>
        <li>
          <span className="mr-1 inline-block h-2 w-0.5 bg-warn align-middle" /> reserve line — the pool share held
          back at the active fractile{reserveFrac != null ? ` (P${Math.round(reserveFrac * 100)})` : " (no windowed reserve)"}
        </li>
      </ul>

      {/* Provider window notes (§11.2 adapters, via the usage poller) */}
      {notes.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-medium text-text-muted">Provider windows</div>
          <ul className="mt-1 space-y-1 text-xs text-text-faint">
            {notes.map((n, i) => (
              <li key={`${n.provider}-${i}`}>
                <span className="text-text-muted">{n.provider}</span> · {n.label || "window"}
                {n.resetsAt != null ? ` · ${formatResetNote(n.resetsAt)}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Forecast accuracy (§14.5 cache) */}
      <div className="mt-3">
        <div className="text-xs font-medium text-text-muted">Forecast accuracy · MAPE 14d</div>
        {accuracy.length === 0 ? (
          <div className="mt-1 text-xs text-text-faint">collecting — no provider forecast history yet</div>
        ) : (
          <ul className="mt-1 space-y-1 text-xs text-text-faint">
            {accuracy.map((a) => (
              <li key={a.provider}>
                <span className="text-text-muted">{a.provider}</span> · {Math.round(a.mape14 * 100)}%
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-3 text-xs text-text-faint">Read-only — plan editing lives in the tonight drill-down.</p>
    </section>
  );
}

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

// ---------------------------------------------------------------------------
// Profile & rhythm drill-down (BET-1394) — Settings → Internals → Profile.
// Reads the server-composed render model (§8.5) + journal (§3.2).
// ---------------------------------------------------------------------------

type ProfileTab = "profile" | "journal";

function ProfileView({
  onBack,
  pushToast,
}: {
  onBack: () => void;
  pushToast: (t: { id: string; message: string }) => void;
}) {
  const [tab, setTab] = useState<ProfileTab>("profile");
  const [render, setRender] = useState<CtoProfileRender | null>(null);
  const [loading, setLoading] = useState(true);
  // BET-1468 item 7: `loading` used to clear only on the success path, so a
  // 401 left this drill-down on a permanent "Loading…" with no error and no
  // retry. Track the failure; keep the last good render on it.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editDim, setEditDim] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const refresh = useCallback(async () => {
    try {
      const r = await window.api.ctoProfileGet();
      // ctoProfileGet throws on a failed read (BET-1483) — the catch below
      // surfaces it while the last good render stays on screen.
      setRender(r);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      pushToast({ id: `cto-prof-load-${Date.now()}`, message: `Couldn't load the profile: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  const retryProfileLoad = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveEdit = async (skill: CtoSkill) => {
    const value = Number(draft);
    if (!Number.isFinite(value)) {
      pushToast({ id: `cto-edit-inv-${skill.dimension}`, message: "Enter a number between 0 and 1" });
      return;
    }
    const clamped = Math.min(1, Math.max(0, value));
    try {
      const res = await window.api.ctoProfileEdit({ dimension: skill.dimension, value: clamped });
      if (!res.ok) {
        pushToast({ id: `cto-edit-fail-${skill.dimension}`, message: res.error ?? "Edit failed" });
        return;
      }
      setRender(res);
      setEditDim(null);
      pushToast({ id: `cto-edit-ok-${skill.dimension}`, message: `Stated ${skill.dimension} as ${clamped}` });
    } catch (e) {
      pushToast({ id: `cto-edit-fail-${skill.dimension}`, message: `Couldn't save the edit: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const suppress = async (cls: string) => {
    try {
      const res = await window.api.ctoProfileSuppress({ inference: cls });
      if (!res.ok) {
        pushToast({ id: `cto-sup-fail-${cls}`, message: res.error ?? "Couldn't delete" });
        return;
      }
      setRender(res);
      pushToast({ id: `cto-sup-ok-${cls}`, message: "Sensitive inference deleted for 90 days" });
    } catch (e) {
      pushToast({ id: `cto-sup-fail-${cls}`, message: `Couldn't delete the inference: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const delJournal = async (id: string) => {
    try {
      const res = await window.api.ctoJournalDelete({ id });
      if (!res.ok) {
        pushToast({ id: `cto-jdel-${id}`, message: "Couldn't delete the entry" });
        return;
      }
      void refresh();
    } catch (e) {
      pushToast({ id: `cto-jdel-${id}`, message: `Couldn't delete the entry: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  // Deep-link an evidence ref. Refs are bare provenance strings in the render
  // model (no server-side resolver), so the action is to put the ref on the
  // clipboard for the user to navigate to — each top-3 ref is its own chip.
  const copyRef = async (ref: string) => {
    try {
      await navigator.clipboard.writeText(ref);
    } catch {
      /* clipboard can be denied in the sandbox; the chip still responds */
    }
    pushToast({ id: `cto-ev-${ref}`, message: `Copied evidence ref: ${ref}` });
  };

  const empty = !render || (render.skills.length === 0 && render.journal.length === 0 && render.sensitive.length === 0);
  const hist = render?.rhythm?.histogram ?? [];
  const maxH = hist.length ? Math.max(...hist, 1) : 1;

  return (
    <div className="h-full w-full overflow-y-auto bg-bg">
      <div className="mx-auto px-6 py-8" style={{ maxWidth: "var(--cto-col-max-w)" }}>
        <div className="flex items-center gap-2 pb-4">
          <button
            type="button"
            onClick={onBack}
            className="rounded-md px-2 py-1 text-text-muted hover:bg-fill-hover hover:text-text"
            aria-label="Back"
          >
            ‹
          </button>
          <h1 className="text-lg font-semibold text-text">Profile &amp; rhythm</h1>
          <div className="flex-1" />
          <div className="flex gap-1 rounded-md border border-border-subtle p-1">
            <button
              type="button"
              onClick={() => setTab("profile")}
              className={"rounded-md px-2 py-1 text-xs " + (tab === "profile" ? "bg-fill-hover text-text" : "text-text-muted")}
            >
              Profile
            </button>
            <button
              type="button"
              onClick={() => setTab("journal")}
              className={"rounded-md px-2 py-1 text-xs " + (tab === "journal" ? "bg-fill-hover text-text" : "text-text-muted")}
            >
              Journal{render && render.journal.length > 0 ? ` (${render.journal.length})` : ""}
            </button>
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-text-faint">Loading…</p>
        ) : loadError ? (
          <div className="mt-4 flex flex-col items-start gap-1">
            <p className="text-sm text-text-muted">Couldn&rsquo;t load the profile: {loadError}</p>
            <button type="button" onClick={retryProfileLoad} className="text-sm text-accent underline hover:text-accent-strong">
              Retry
            </button>
          </div>
        ) : tab === "journal" ? (
          <JournalTab render={render} delJournal={delJournal} />
        ) : (
          <div className="flex flex-col gap-4">
            {/* Sensitive inferences — §8.5, deletable (90d suppression). */}
            {render && render.sensitive.length > 0 && (
              <section className="rounded-lg border border-border-subtle p-4">
                <h3 className="text-sm font-semibold text-text">Sensitive</h3>
                <p className="text-xs text-text-muted">
                  Inferred, not stored against you — shown only here, deletable. A deletion suppresses that
                  inference for 90 days.
                </p>
                <ul className="mt-2 divide-y divide-border-subtle">
                  {render.sensitive.map((s) => (
                    <li key={s.class} className="flex items-start justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <span className="inline-block rounded-full bg-fill-active px-2 py-1 text-xs text-text">{s.label}</span>
                        <p className="mt-1 text-sm text-text">{s.text}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void suppress(s.class)}
                        className="shrink-0 rounded-md border border-border-subtle px-2 py-1 text-xs text-text-muted hover:bg-fill-hover hover:text-text"
                        title="Delete this inference (90-day suppression)"
                      >
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Skills — §8.1 σ bands + top-3 evidence + stated-wins inline edit. */}
            <section className="rounded-lg border border-border-subtle p-4">
              <h3 className="text-sm font-semibold text-text">Skills</h3>
              {render && render.skills.length === 0 ? (
                <p className="mt-2 text-sm text-text-faint">No skills inferred yet — they appear after the CTO has seen your work.</p>
              ) : (
                <ul className="mt-2 space-y-3">
                  {render?.skills.map((s) => {
                    const muPct = Math.min(100, Math.max(0, s.mu * 100));
                    const sigmaPct = s.sigma * 100;
                    const bandLo = Math.max(0, muPct - sigmaPct);
                    const bandHi = Math.min(100, muPct + sigmaPct);
                    const expertisePct = Math.min(100, Math.max(2, s.expertise * 100));
                    return (
                      <li key={s.dimension} className="flex items-center gap-3">
                        <div className="w-40 shrink-0">
                          <div className="truncate text-sm text-text">{s.dimension}</div>
                          <div className="text-xs text-text-faint">{s.label}</div>
                        </div>
                        <div className="min-w-0 flex-1">
                          {/* σ confidence band (§8.5): translucent μ±σ band, solid
                              expertise fill (μ−2σ), and a tick at the μ estimate. */}
                          <div className="relative h-2 rounded-full bg-fill-active">
                            {sigmaPct > 0 && (
                              <div
                                className="absolute h-2 rounded-full bg-accent/15"
                                style={{ left: `${bandLo}%`, width: `${Math.max(0, bandHi - bandLo)}%` }}
                              />
                            )}
                            <div className="absolute h-2 rounded-full bg-accent" style={{ width: `${expertisePct}%` }} />
                            <div
                              className="absolute top-0 h-2 w-px bg-text"
                              style={{ left: `${muPct}%` }}
                              title={`μ ${s.mu.toFixed(2)}`}
                            />
                          </div>
                          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-[11px]">
                            {s.source === "stated" ? (
                              <span className="text-text">
                                stated: {typeof s.statedValue === "number" ? s.statedValue.toFixed(2) : s.statedValue}
                              </span>
                            ) : s.topEvidence && s.topEvidence.length ? (
                              s.topEvidence.slice(0, 3).map((ref) => (
                                <button
                                  key={ref}
                                  type="button"
                                  onClick={() => void copyRef(ref)}
                                  title={`Copy evidence ref ${ref}`}
                                  className="max-w-44 truncate rounded-md border border-border-subtle px-2 py-1 text-text-muted hover:border-border hover:text-text"
                                >
                                  {ref}
                                </button>
                              ))
                            ) : (
                              <span className="text-text-faint">no evidence yet</span>
                            )}
                          </div>
                        </div>
                        <span className="shrink-0 font-mono text-xs text-text-muted">
                          μ{s.mu.toFixed(2)} σ{s.sigma.toFixed(2)}
                        </span>
                        <div className="shrink-0">
                          {editDim === s.dimension ? (
                            <form
                              onSubmit={(ev) => {
                                ev.preventDefault();
                                void saveEdit(s);
                              }}
                              className="flex items-center gap-1"
                            >
                              <input
                                autoFocus
                                type="number"
                                min={0}
                                max={1}
                                step={0.05}
                                value={draft}
                                onChange={(ev) => setDraft(ev.target.value)}
                                className="w-16 rounded-md border border-border bg-bg px-1 py-1 text-xs text-text"
                              />
                              <button type="submit" className="rounded-md border border-border px-2 py-1 text-xs text-text hover:bg-fill-hover">
                                ✓
                              </button>
                              <button type="button" onClick={() => setEditDim(null)} className="rounded-md border border-border px-2 py-1 text-xs text-text-muted">
                                ✕
                              </button>
                            </form>
                          ) : s.source === "stated" ? (
                            <button
                              type="button"
                              onClick={() => {
                                setEditDim(s.dimension);
                                setDraft(String(s.statedValue ?? s.mu));
                              }}
                              className="rounded-md border border-border px-2 py-1 text-xs text-text hover:bg-fill-hover"
                              title="Edit stated value"
                            >
                              Edit
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setEditDim(s.dimension);
                                setDraft(String(s.expertise.toFixed(2)));
                              }}
                              className="rounded-md border border-border px-2 py-1 text-xs text-text-muted hover:bg-fill-hover hover:text-text"
                              title="State a value (wins over inference)"
                            >
                              State
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* Interaction — §8.4 stats (prompt frequency, session length, mix). */}
            {render && (render.interaction.sessionLenMedian != null || render.interaction.promptFreqEwma != null) && (
              <section className="rounded-lg border border-border-subtle p-4">
                <h3 className="text-sm font-semibold text-text">Interaction</h3>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  {render.interaction.promptFreqEwma != null && (
                    <div>
                      <dt className="text-xs text-text-faint">Prompt frequency</dt>
                      <dd className="text-text">{render.interaction.promptFreqEwma.toFixed(2)} /h</dd>
                    </div>
                  )}
                  {render.interaction.sessionLenMedian != null && (
                    <div>
                      <dt className="text-xs text-text-faint">Session length (median)</dt>
                      <dd className="text-text">{formatDuration(render.interaction.sessionLenMedian)}</dd>
                    </div>
                  )}
                  {render.interaction.questionMix && Object.keys(render.interaction.questionMix).length > 0 && (
                    <div>
                      <dt className="text-xs text-text-faint">Question mix</dt>
                      <dd className="text-text">{formatQuestionMix(render.interaction.questionMix)}</dd>
                    </div>
                  )}
                  {render.interaction.correctionRate && render.interaction.correctionRate.total > 0 && (
                    <div>
                      <dt className="text-xs text-text-faint">Correction rate</dt>
                      <dd className="text-text">
                        {render.interaction.correctionRate.corrected}/{render.interaction.correctionRate.total}
                        {" "}({Math.round((render.interaction.correctionRate.corrected / render.interaction.correctionRate.total) * 100)}%)
                      </dd>
                    </div>
                  )}
                  {render.interaction.verbosityPref && render.interaction.verbosityPref.source === "inferred" && (
                    <div>
                      <dt className="text-xs text-text-faint">Verbosity pref</dt>
                      <dd className="text-text">{verbosityLabel(render.interaction.verbosityPref.value)}</dd>
                    </div>
                  )}
                </dl>
              </section>
            )}

            {/* Rhythm — §8.2 24-bin histogram + inferred TZ. */}
            {(render?.rhythm?.dayCount ?? 0) > 0 && (
              <section className="rounded-lg border border-border-subtle p-4">
                <h3 className="text-sm font-semibold text-text">Rhythm</h3>
                <p className="text-xs text-text-muted">
                  {render?.rhythm.tzOffset != null
                    ? `Inferred timezone UTC${render.rhythm.tzOffset >= 0 ? "+" : ""}${render.rhythm.tzOffset}·${Math.round((render.rhythm.tzConfidence ?? 0) * 100)}% confidence`
                    : "No timezone inferred yet"}{" "}
                  · {render?.rhythm.dayCount} activity {"day"}
                  {render?.rhythm.dayCount === 1 ? "" : "s"}
                  {render?.rhythm.lowConfidence ? " — low confidence until 14 days" : ""}
                </p>
                {/* Inferred workday components (§8.2): each detected peak hour + weight. */}
                {render?.rhythm.components && render.rhythm.components.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px]">
                    <span className="text-text-faint">Workday peaks:</span>
                    {render.rhythm.components.map((c, i) => (
                      <span
                        key={i}
                        className="rounded-md border border-border-subtle px-2 py-1 text-text-muted"
                        title={`peak ≈ ${c.mu_hour.toFixed(1)}:00 · concentration ${c.kappa?.toFixed(2) ?? "—"} · weight ${c.w?.toFixed(2) ?? "—"}`}
                      >
                        ~{normalizeHour(c.mu_hour)}:00 · w{(c.w ?? 0).toFixed(2)}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-2 flex h-16 items-end gap-1">
                  {hist.map((c: number, i: number) => (
                    <div
                      key={i}
                      className="flex-1 rounded-sm bg-accent/30"
                      style={{ height: `${Math.max(2, (c / maxH) * 100)}%` }}
                      title={`${i}:00 − ${c}`}
                    />
                  ))}
                </div>
                <div className="mt-1 flex justify-between text-[10px] text-text-faint">
                  <span>0:00</span>
                  <span>12:00</span>
                  <span>24:00</span>
                </div>
              </section>
            )}
          </div>
        )}

        {!loading && !loadError && empty && <p className="mt-8 text-sm text-text-faint">Nothing here yet — the CTO fills this in as it learns.</p>}
      </div>
    </div>
  );
}

function JournalTab({
  render,
  delJournal,
}: {
  render: CtoProfileRender | null;
  delJournal: (id: string) => void;
}) {
  const entries = render?.journal ?? [];
  if (entries.length === 0) {
    return <p className="mt-8 text-sm text-text-faint">No journal entries yet.</p>;
  }
  return (
    <ul className="mt-2 divide-y divide-border-subtle">
      {entries.map((e) => (
        <li key={e.id} className="flex items-start justify-between gap-3 py-2">
          <div className="min-w-0">
            <p className="text-sm text-text">{e.text}</p>
            <div className="mt-1 text-xs text-text-faint">
              {relativeTime(e.created, Date.now())}
              {e.refs.length > 0 ? ` · ${e.refs.slice(0, 3).join(" · ")}` : ""}
            </div>
          </div>
          <button
            type="button"
            onClick={() => delJournal(e.id)}
            className="shrink-0 rounded-md border border-border-subtle px-2 py-1 text-xs text-text-muted hover:bg-fill-hover hover:text-text"
            title="Delete this journal entry"
          >
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
}

// Small profile-interaction formatters (§8.4). Kept tiny because they are
// pure presentation over the server-composed render model.
function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const min = m % 60;
  return min ? `${h}h ${min}m` : `${h}h`;
}

function formatQuestionMix(mix: Record<string, number>): string {
  const sorted = Object.entries(mix)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k);
  return sorted.length ? sorted.join(" · ") : "—";
}

function verbosityLabel(value: number): string {
  if (value <= -0.2) return "terse";
  if (value >= 0.2) return "thorough";
  return "balanced";
}

// Normalize a (possibly fractional, possibly 24-boundary) hour into 0-23 for display.
function normalizeHour(h: number): number {
  const m = ((Math.round(h) % 24) + 24) % 24;
  return m === 0 ? 0 : m;
}

// BET-1392: the suggestion option executors run against the renderer api
// surface. `delegateStart` needs the fuller DelegateStartInput; the executor
// produces a compatible shape (prompt/sessionID/directory) that we hand off.
function rendererDelegateStart(input: {
  prompt: string;
  sessionID: string;
  directory: string;
  model?: unknown;
}): Promise<{ ok?: boolean; error?: string }> {
  if (!window.api?.delegateStart) return Promise.resolve({ ok: false, error: "delegate unavailable" });
  return window.api.delegateStart(input as never);
}

// §14.3 held-list modal: the silent-logged (below-worthiness) suggestions the
// pipeline held back. Each row takes an accept/dismiss judgment through the B3
// verdict route so the pipeline learns. Opened from the in-digest "I held back
// N — review" aside.
function HeldListModal({
  rows,
  loadError,
  onClose,
  onRefresh,
  onVerdict,
}: {
  rows: CtoHeldRow[];
  loadError?: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onVerdict: (row: CtoHeldRow, verdict: "accept" | "dismiss") => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0, 0, 0, 0.4)" }}
      role="dialog"
      aria-modal="true"
      aria-label="Held suggestions"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg border border-strong bg-bg p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-text">Held suggestions</h3>
          <span className="rounded-full bg-fill-active px-2 py-1 text-[11px] text-text-muted">{rows.length}</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-text hover:bg-fill-hover"
          >
            Close
          </button>
        </div>
        <p className="mt-1 text-xs text-text-faint">
          Suggestions the CTO held back below its bar — accept or dismiss so it learns.
        </p>
        <div className="mt-2 flex-1 space-y-2 overflow-auto">
          {rows.length === 0 ? (
            heldModalShowsError({ loadError: !!loadError, rowCount: rows.length }) ? (
              // BET-1484: a failed first-ever load renders this error line +
              // Retry (the drill-downs' shape) instead of the empty state —
              // "Nothing held back." would read as a factual claim when the
              // read never came back. The toast still fired too.
              <div className="flex flex-col items-start gap-1 py-6">
                <p className="text-sm text-text-muted">Couldn&rsquo;t load held suggestions: {loadError}</p>
                <button type="button" onClick={onRefresh} className="text-sm text-accent underline hover:text-accent-strong">
                  Retry
                </button>
              </div>
            ) : (
              <div className="py-6 text-center text-sm text-text-faint">Nothing held back.</div>
            )
          ) : (
            rows.map((row) => (
              <div key={row.id} className="rounded-md border border-strong bg-fill px-3 py-2">
                <div className="text-sm text-text">{row.text}</div>
                <div className="mt-1 text-[11px] text-text-faint">
                  {row.class} · {((row.score ?? 0) * 100).toFixed(0)}% · {row.reason} · {relativeTime(row.ts ?? Date.now(), Date.now())}
                </div>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => onVerdict(row, "accept")}
                    className="rounded-md bg-accent-solid px-2 py-1 text-xs font-medium text-white hover:opacity-90"
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => onVerdict(row, "dismiss")}
                    className="rounded-md bg-fill-active px-2 py-1 text-xs font-medium text-text hover:bg-fill-hover"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
        {rows.length === 0 ? (
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={onRefresh}
              className="rounded-md px-2 py-1 text-sm text-text hover:bg-fill-hover"
            >
              Refresh
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Blackboard drill-down (BET-1399, §10.5 row 1)
// ---------------------------------------------------------------------------
// Facts per project: kind chip + confidence bar + statement + ref chips +
// sender + age; the superseded chain struck-through; per-fact actions
// wrong (user supersession, auto-accepted) + pin (touchFacts); and the
// read-only paginated archive browser (§6.3).

const FACT_KINDS = ["status", "decision", "preference", "event", "insight"] as const;

function factKindChip(kind: string): string {
  const k = (FACT_KINDS as readonly string[]).includes(kind) ? kind : "status";
  const map: Record<string, string> = {
    status: "border-border-subtle text-text-muted",
    decision: "border-accent text-accent",
    preference: "border-border-strong text-text",
    event: "border-border-strong text-text-muted",
    insight: "border-border-strong text-accent",
  };
  return map[k] ?? map.status;
}

function FactRow({
  row,
  struck,
  onOpenSession,
  onCopyRef,
  openableSessions,
}: {
  row: CtoFactRow;
  struck?: boolean;
  onOpenSession?: (sessionId: string) => void;
  onCopyRef?: (ref: string) => void;
  openableSessions?: Set<string>;
}) {
  const pct = Math.round(Math.min(1, Math.max(0, row.confidence)) * 100);
  const chips = evidenceExpansion(row.refs, openableSessions);
  const hasExpandable = chips.some((chip) => chip.kind === "copy");
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-md border border-border-subtle px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={"rounded-md border px-2 py-1 text-[10px] font-medium capitalize " + factKindChip(row.kind)}>
          {row.kind}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-text" style={struck ? { textDecoration: "line-through", opacity: 0.65 } : undefined}>
          {row.statement}
        </span>
        <span className="shrink-0 text-[11px] text-text-faint" title={`confidence ${pct}%`}>
          {pct}%
        </span>
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-fill-active">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-faint">
        <span>{row.senderLabel}</span>
        <span>· {formatAge(row.ageMs)} old</span>
        {row.expired ? <span className="text-text-muted">· expired</span> : null}
        {struck && row.supersededBy ? <span>· superseded by {row.supersededBy}</span> : null}
        {chips.map((chip) =>
          chip.kind === "jump" ? (
            <button
              key={chip.ref}
              type="button"
              onClick={() => onOpenSession?.(chip.ref)}
              className="truncate rounded-md bg-fill-active px-2 py-1 text-[10px] text-accent underline decoration-dotted underline-offset-2 hover:text-accent-strong focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
              title={chip.title}
            >
              {chip.ref}
            </button>
          ) : (
            <button
              key={chip.ref}
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              className={
                "truncate rounded-md bg-fill-active px-2 py-1 text-[10px] underline decoration-dotted underline-offset-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent " +
                (expanded ? "text-accent hover:text-accent-strong" : "text-text-muted hover:text-text")
              }
              title={expanded ? `Hide evidence for ${chip.ref}` : `Show evidence for ${chip.ref}`}
            >
              {chip.ref}
            </button>
          ),
        )}
      </div>
      {expanded && hasExpandable ? (
        <div className="mt-2 rounded-md border border-border-subtle bg-fill px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-faint">Evidence</div>
          {chips.map((chip) => (
            <div key={chip.ref} className="mt-1 flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-text-muted">{chip.ref}</code>
              {chip.kind === "jump" ? (
                <button
                  type="button"
                  onClick={() => onOpenSession?.(chip.ref)}
                  className="shrink-0 rounded-md border border-border-subtle px-2 py-1 text-[10px] text-accent hover:text-accent-strong focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                  title={chip.title}
                >
                  open
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onCopyRef?.(chip.ref)}
                  className="shrink-0 rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-muted hover:text-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                  title={`Copy ${chip.ref}`}
                >
                  copy
                </button>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function BlackboardView({
  onBack,
  pushToast,
  onOpenSession,
  openableSessions,
}: {
  onBack: () => void;
  pushToast: (t: { id: string; message: string }) => void;
  onOpenSession: (sessionId: string) => void;
  openableSessions: Set<string>;
}) {
  // Non-session refs have no server-side resolver (§6.1 bare provenance) —
  // BET-1442: they fall back to inline evidence expansion in the row (§10.3
  // "evidence ▸ expands the refs list inline"), with copy affordances inside
  // the expanded panel. Every chip responds; none is a dead control.
  const copyRef = useCallback(
    async (ref: string) => {
      try {
        await navigator.clipboard.writeText(ref);
      } catch {
        /* clipboard can be denied; the chip still responds */
      }
      pushToast({ id: `bb-ref-${ref}`, message: `Copied evidence ref: ${ref}` });
    },
    [pushToast],
  );
  const [render, setRender] = useState<CtoFactsRender | null>(null);
  const [loading, setLoading] = useState(true);
  // BET-1468 item 7: same hole as Profile — `loading` cleared on success only,
  // so a 401 hung this view on "Loading…" forever. Track the failure and keep
  // the last good render (the project chip row stays switchable).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<"facts" | "archive">("facts");
  const [archive, setArchive] = useState<CtoFactRow[]>([]);
  const [archiveTotal, setArchiveTotal] = useState(0);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [correction, setCorrection] = useState("");

  const refresh = useCallback(async () => {
    try {
      const r = await window.api.ctoFactsGet({});
      // ctoFactsGet throws on a failed read (BET-1483) — the catch below keeps
      // the board (and the project chip row) instead of swapping in an empty
      // render the user cannot switch back from (BET-1468 item 6).
      setRender(r);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      pushToast({ id: `bb-load-${Date.now()}`, message: `Couldn't load the blackboard: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  const retryBoardLoad = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadArchive = useCallback(
    async (project: string | null, before?: number) => {
      try {
        const page = await window.api.ctoFactsArchiveGet({ project, before });
        if (!page.ok) {
          pushToast({ id: `bb-arc-${Date.now()}`, message: page.error ?? "Couldn't load the archive" });
          return;
        }
        setArchiveTotal(page.total);
        setNextBefore(page.nextBefore);
        setArchive((prev) => (before == null ? page.entries : [...prev, ...page.entries]));
      } catch (e) {
        // A stale token throws (AuthRequiredError) — say so, keep what's shown.
        pushToast({ id: `bb-arc-${Date.now()}`, message: `Couldn't load the archive: ${e instanceof Error ? e.message : String(e)}` });
      }
    },
    [pushToast],
  );

  const openArchive = () => {
    setTab("archive");
    if (archive.length === 0) void loadArchive(render?.project ?? null);
  };

  const switchProject = async (project: string) => {
    try {
      // ctoFactsGet throws on a failed read (BET-1483) — the catch keeps the
      // currently displayed board and its chip row instead of wiping them.
      const r = await window.api.ctoFactsGet({ project });
      setRender(r);
      setArchive([]);
      setArchiveTotal(0);
      setNextBefore(null);
      if (tab === "archive") void loadArchive(project);
    } catch (e) {
      pushToast({ id: `bb-switch-${Date.now()}`, message: `Couldn't switch to ${project}: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const pin = async (row: CtoFactRow) => {
    try {
      const res = await window.api.ctoFactPin({ project: render!.project!, factId: row.id });
      pushToast(
        res.ok
          ? { id: `bb-pin-${row.id}`, message: "Pinned — the access clock was reset" }
          : { id: `bb-pin-err-${row.id}`, message: res.error ?? "Pin failed" },
      );
    } catch (e) {
      pushToast({ id: `bb-pin-err-${row.id}`, message: `Couldn't pin: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const submitCorrection = async (row: CtoFactRow) => {
    try {
      const res = await window.api.ctoFactCorrect({ project: render!.project!, factId: row.id, statement: correction });
      if (!res.ok) {
        pushToast({ id: `bb-corr-err-${row.id}`, message: res.error ?? "Correction failed" });
        return;
      }
      setCorrecting(null);
      setCorrection("");
      pushToast({ id: `bb-corr-${row.id}`, message: "Correction applied — the fact was superseded" });
      void refresh();
    } catch (e) {
      pushToast({ id: `bb-corr-err-${row.id}`, message: `Couldn't send the correction: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

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
        <div className="mt-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text">Blackboard</h2>
          <div className="flex gap-1 rounded-md border border-border-subtle p-1">
            {(["facts", "archive"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => (t === "archive" ? openArchive() : setTab("facts"))}
                className={"rounded-md px-3 py-1 text-xs capitalize " + (tab === t ? "bg-fill-active text-text" : "text-text-muted")}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {render && render.projects.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-text-faint">Project</span>
            {render.projects.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => void switchProject(p)}
                className={"max-w-56 truncate rounded-full border px-3 py-1 text-xs " + (render.project === p ? "border-accent bg-fill-hover text-text" : "border-border-subtle text-text-muted")}
              >
                {p}
              </button>
            ))}
          </div>
        ) : null}

        {loading ? (
          <div className="mt-4 text-sm text-text-muted">Loading…</div>
        ) : loadError ? (
          <div className="mt-4 flex flex-col items-start gap-1">
            <div className="text-sm text-text-muted">Couldn&rsquo;t load the blackboard: {loadError}</div>
            <button type="button" onClick={retryBoardLoad} className="text-sm text-accent underline hover:text-accent-strong">
              Retry
            </button>
          </div>
        ) : tab === "facts" ? (
          <>
            {render && render.active.length > 0 ? (
              <div className="mt-4 space-y-2">
                {render.active.map((row) => (
                  <div key={row.id}>
                    <FactRow row={row} onOpenSession={onOpenSession} onCopyRef={(r) => void copyRef(r)} openableSessions={openableSessions} />
                    {correcting === row.id ? (
                      <div className="mt-2 rounded-md border border-border-subtle bg-fill px-3 py-2">
                        <input
                          type="text"
                          value={correction}
                          onChange={(e) => setCorrection(e.target.value)}
                          placeholder="The correct statement…"
                          maxLength={200}
                          className="w-full rounded-md border border-border-subtle bg-bg px-2 py-1 text-sm text-text"
                          autoFocus
                        />
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            onClick={() => void submitCorrection(row)}
                            disabled={!correction.trim()}
                            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-text disabled:opacity-40"
                          >
                            Supersede
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setCorrecting(null);
                              setCorrection("");
                            }}
                            className="rounded-md border border-border-subtle px-3 py-1 text-xs text-text-muted"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {/* BET-1468 item 8: Pin and the Supersede flow (opened by
                        Wrong?) both act on `render.project` — when the render
                        arrived without one they used to return silently. A
                        control that cannot act is not rendered. */}
                    {render?.project ? (
                      <div className="mt-1 flex gap-2">
                        <button
                          type="button"
                          onClick={() => setCorrecting(correcting === row.id ? null : row.id)}
                          className="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-text-muted hover:text-text"
                        >
                          Wrong?
                        </button>
                        <button
                          type="button"
                          onClick={() => void pin(row)}
                          className="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-text-muted hover:text-text"
                        >
                          Pin
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-4 text-sm text-text-muted">No facts for this project yet.</div>
            )}

            {render && render.superseded.length > 0 ? (
              <div className="mt-6">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-text-faint">Superseded</h3>
                <div className="mt-2 space-y-2">
                  {render.superseded.map((row) => (
                    <FactRow key={row.id} row={row} struck onOpenSession={onOpenSession} onCopyRef={(r) => void copyRef(r)} openableSessions={openableSessions} />
                  ))}
                </div>
              </div>
            ) : null}
            <p className="mt-4 text-xs text-text-faint">
              Wrong? sends a correction — the CTO treats your statement as authoritative. Pin resets a fact&apos;s decay clock.
            </p>
          </>
        ) : (
          <>
            <div className="mt-4 text-xs text-text-faint">Displaced facts, newest first ({archiveTotal} total).</div>
            <div className="mt-2 space-y-2">
              {archive.map((row) => (
                <FactRow key={`${row.id}-${row.archivedAt}`} row={row} struck onOpenSession={onOpenSession} onCopyRef={(r) => void copyRef(r)} openableSessions={openableSessions} />
              ))}
            </div>
            {nextBefore != null ? (
              <button
                type="button"
                onClick={() => void loadArchive(render?.project ?? null, nextBefore)}
                className="mt-3 rounded-md border border-border-subtle px-3 py-2 text-xs text-text-muted hover:text-text"
              >
                Load more
              </button>
            ) : null}
            {archive.length === 0 ? <div className="mt-2 text-sm text-text-muted">The archive is empty.</div> : null}
            <p className="mt-4 text-xs text-text-faint">Read-only — displaced facts stay out of the live board.</p>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool integrations drill-down (BET-1399, §10.5 row 4)
// ---------------------------------------------------------------------------
// The §7.2 registry table: tool, derived §7.3 role (dead-tool flagged),
// engagement + vitality axes, consent rings with per-ring revoke, §7.5 probe
// cadence + last result, and the never list with un-never (§7.4).

const RING_LABELS: Array<{ ring: "metadata" | "deep_read" | "write"; label: string }> = [
  { ring: "metadata", label: "metadata" },
  { ring: "deep_read", label: "deep read" },
  { ring: "write", label: "write" },
];

const ROLE_LABELS: Record<string, string> = {
  both: "workflow + data source",
  workflow: "workflow",
  "data-source": "data source",
  dead: "dead — candidates for retirement",
};

function ToolIntegrationsView({
  onBack,
  pushToast,
}: {
  onBack: () => void;
  pushToast: (t: { id: string; message: string }) => void;
}) {
  const [render, setRender] = useState<CtoToolsRender | null>(null);
  const [loading, setLoading] = useState(true);
  // BET-1468 item 7: same success-only `setLoading(false)` hole as the other
  // drill-downs — a 401 hung this view on "Loading…" forever.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyTool, setBusyTool] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await window.api.ctoToolsGet();
      // ctoToolsGet throws on a failed read (BET-1483) — the catch below
      // surfaces it instead of claiming no tools are observed.
      setRender(r);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      pushToast({ id: `ti-load-${Date.now()}`, message: `Couldn't load the tool registry: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  const retryToolsLoad = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const revoke = async (row: CtoToolRegistryRow, ring: "metadata" | "deep_read" | "write") => {
    setBusyTool(row.tool);
    try {
      const res = await window.api.ctoToolRevoke({ tool: row.tool, ring });
      pushToast(
        res.ok
          ? { id: `ti-rev-${row.tool}-${ring}`, message: `Revoked ${ring.replace("_", " ")} consent for ${row.displayName}` }
          : { id: `ti-rev-err-${row.tool}-${ring}`, message: res.error ?? "Revoke failed" },
      );
      if (res.ok) void refresh();
    } catch (e) {
      pushToast({ id: `ti-rev-err-${row.tool}-${ring}`, message: `Couldn't revoke: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      // BET-1468: the busy flag used to survive a rejection, leaving the
      // revoke control permanently disabled — a dead control.
      setBusyTool(null);
    }
  };

  const unnever = async (row: CtoToolRegistryRow) => {
    setBusyTool(row.tool);
    try {
      const res = await window.api.ctoToolUnnever({ tool: row.tool });
      pushToast(
        res.ok
          ? { id: `ti-un-${row.tool}`, message: `${row.displayName} re-enters the lifecycle at observed` }
          : { id: `ti-un-err-${row.tool}`, message: res.error ?? "Un-never failed" },
      );
      if (res.ok) void refresh();
    } catch (e) {
      pushToast({ id: `ti-un-err-${row.tool}`, message: `Couldn't clear the never verdict: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusyTool(null);
    }
  };

  const toolBlock = (row: CtoToolRegistryRow) => (
    <div key={row.tool} className="rounded-md border border-border-subtle px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-text">{row.displayName}</span>
        <span className="rounded-md border border-border-subtle px-2 py-1 text-[10px] capitalize text-text-muted">{row.status}</span>
        {row.derivedRole ? (
          <span
            className={
              "rounded-md border px-2 py-1 text-[10px] " +
              (row.derivedRole === "dead" ? "border-accent text-accent" : "border-border-subtle text-text-muted")
            }
          >
            {ROLE_LABELS[row.derivedRole] ?? row.derivedRole}
          </span>
        ) : null}
        <span className="ml-auto text-[11px] text-text-faint">
          {row.uses} uses · {row.weeksActive} wk active · ewma {Math.round(row.ewmaPerWeek * 100) / 100}/wk
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-text-faint">
        <span>
          vitality:{" "}
          {row.vitality.ewma != null
            ? `${Math.round(row.vitality.ewma * 100) / 100} inflow ewma`
            : row.vitality.last_event != null
              ? "probed, no inflow fields"
              : "no probe data"}
        </span>
        {row.vitality.last_event != null ? <span>· last event {formatAge(Math.max(0, Date.now() - row.vitality.last_event))} ago</span> : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {RING_LABELS.map(({ ring, label }) => {
          const value = row.consent[ring];
          return (
            <span key={ring} className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[11px]">
              <span className="text-text-muted">{label}</span>
              <span className={value === "yes" ? "font-medium text-accent" : value === "never" ? "font-medium text-text" : "text-text-faint"}>
                {value ?? "—"}
              </span>
              {value === "yes" ? (
                <button
                  type="button"
                  disabled={busyTool === row.tool}
                  onClick={() => void revoke(row, ring)}
                  className="ml-1 text-[10px] text-text-faint hover:text-text"
                  title={`Revoke ${label} consent (writes the ring to no)`}
                >
                  revoke
                </button>
              ) : null}
            </span>
          );
        })}
      </div>
      <div className="mt-2 text-[11px] text-text-faint">
        {row.probes.configured ? (
          <span>
            probes:{" "}
            {row.probes.probes
              .map((p) => {
                const cadence = p.effectiveMs != null ? formatAge(p.effectiveMs) : "?";
                const last = p.lastAt != null ? (p.lastOk ? `ok ${formatAge(Math.max(0, Date.now() - p.lastAt))} ago` : `fail: ${p.lastError ?? p.lastStatus ?? "?"}`) : "never run";
                return `${p.name} every ${cadence} (${last})`;
              })
              .join("; ")}
          </span>
        ) : row.probes.consented ? (
          <span>probes: consented, no spec written yet</span>
        ) : (
          <span>probes: paused — no metadata consent</span>
        )}
      </div>
    </div>
  );

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
        <h2 className="mt-4 text-lg font-semibold text-text">Tool integrations</h2>

        {loading ? (
          <div className="mt-4 text-sm text-text-muted">Loading…</div>
        ) : loadError ? (
          <div className="mt-4 flex flex-col items-start gap-1">
            <div className="text-sm text-text-muted">Couldn&rsquo;t load the tool registry: {loadError}</div>
            <button type="button" onClick={retryToolsLoad} className="text-sm text-accent underline hover:text-accent-strong">
              Retry
            </button>
          </div>
        ) : (
          <>
            {render && render.tools.length > 0 ? (
              <div className="mt-4 space-y-2">
                {render.tools.map((row) => toolBlock(row))}
              </div>
            ) : (
              <div className="mt-4 text-sm text-text-muted">
                No external tools observed yet — they appear here as evidence accumulates.
              </div>
            )}

            {render && render.never.length > 0 ? (
              <div className="mt-6">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-text-faint">Never</h3>
                <div className="mt-2 space-y-2">
                  {render.never.map((row) => (
                    <div key={row.tool} className="flex items-center justify-between rounded-md border border-border-subtle px-3 py-2">
                      <span className="text-sm text-text-muted">{row.displayName}</span>
                      <button
                        type="button"
                        disabled={busyTool === row.tool}
                        onClick={() => void unnever(row)}
                        className="rounded-md border border-border-subtle px-3 py-1 text-[11px] text-text-muted hover:text-text"
                        title="Clear the never verdict — the tool re-enters the lifecycle at observed"
                      >
                        Un-never
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <p className="mt-4 text-xs text-text-faint">
              Revoking a ring is legal anytime — features that depended on it simply narrow. Dead-flagged tools have
              prior engagement but no live engagement or vitality; candidates for retirement.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
