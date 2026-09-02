// The Adaptive CTO engine skeleton (BET-1376 / spec §3, §10.1, §10.6, §13.3).
//
// The CTO is NOT a long-running agent (spec §3.1): it is deterministic server
// code — schedulers, stores, queues, scoring, thresholds, budget math — in the
// same dependency-injected style as delegate.mjs. This module is that engine's
// P1 skeleton: it owns the engine's timer discipline, the state surface the
// `/api/cto/state` route + `{kind:"ctoState"}` bus event serve (§10.1), the
// kill switch + health state machine (§10.6), the rate limits (§3.3), and
// records every mutating act in the A1 activity ledger. The pipeline pipelines
// (facts, presence, digest, overnight, reaper) land in later issues against
// this shell.
//
// Determinism + testability: every I/O seam (config, ledger, engine-state,
// kill switch, clock, counts) is injected with a real default, exactly like
// the other server engines. Nothing here touches tmux/opencode directly.
//
// State machine (§10.6): dot ∈ {active, disabled, thrifty, paused}.
//   - disabled – config `ctoEnabled` is false (the default). No work.
//   - paused   – the kill-switch flag file is present, or a rate-limit trip
//     self-paused the engine (§10.6-5). All work timers stop; event ingestion
//     keeps running. Resume() (a user action) is the only way out.
//   - thrifty  – the cap/window is tight; set by the watchdog (>2× expected
//     hourly burn, §13.3) or a cap hit. Quiet warn chip; auto-clears later.
//   - active   – enabled, not paused, not thrifty.
//
// Kill switch (§13.3): engine-EXTERNAL. A flag file whose path lives on the
// box (`statePath("cto","paused")` via A1 ctoPath). It is checked at every
// engine tick and before every job/session start; pause()/resume() write and
// remove it. Because it is a flag file (not a bit in this process's memory) a
// wedged engine still stops — the watchdog, which is a SEPARATE timer
// registered from src/server/index.mjs (also §13.3), can write it without
// this module cooperating.
//
// Timer discipline: the engine owns exactly two timers — the liveness /
// kill-switch / state-refresh tick and the ephemeral-session reaper (§3.1,
// BET-1378) — via startPoller (timer.unref() + inFlight guard). Both are
// stopped on pause and restarted on resume. Event ingestion (observeEvent) is
// NOT a timer: it is driven from index.mjs's event pump and keeps running
// while paused (§10.6-5). Future work timers (probes, overnight, backfill)
// register through the same start/stop surface so pause halts them too;
// they are out of scope for this skeleton.

import { promises as fsp } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  ctoPath,
  ledgerStore,
  engineStateStore,
  trustStore,
  cardsStore,
  segmentsStore,
  rollupsStore,
  inboxStore,
  findingsStore,
  plansStore,
  verdictsStore,
  watchersStore,
  factsArchiveStore,
  factsStore,
  probeStateStore,
  profileStore,
  journalStore,
  toolRegistryStore,
  toolUsageStore,
  budgetStore,
  patchEngineState,
  patchStore,
  purgeExpiredInbox,
} from "./ctoStores.mjs";
import { createVerdictEngine, createAsSourceSink } from "./ctoVerdicts.mjs";
import { cardHasContent } from "../shared/ctoCard.mjs";
// BET-1403: the earned-trust ladder (§9.3/§9.4). Its per-class Beta counters
// ride the §9.5 verdict sink registry below; the digest announces acts and
// tier changes through the same engine.
import { createCtoTrust } from "./ctoTrust.mjs";
import { createCtoBackfill } from "./ctoBackfill.mjs";
import { startPoller } from "./startPoller.mjs";
import { createSeenIdFilter } from "./seenIds.mjs";
import { createCtoProfile, DAY_MS } from "./ctoProfile.mjs";
import { createCtoJournal } from "./ctoJournal.mjs";
import {
  getDesktopPresence as pushGetDesktopPresence,
  getLastDesktopHeartbeat as pushGetLastDesktopHeartbeat,
} from "./push.mjs";
import {
  CHANNEL_EVENT,
  computeLastSeen,
  eventSessionID,
  isPipelineSession,
  isUserPromptEvent,
  normalizeEvidence,
  presenceState,
} from "./ctoEvidence.mjs";
import {
  askStartInfo,
  askResolveInfo,
  askQuestionText,
  createCtoCards,
  isAskResolveEvent,
  isConditionGoneResult,
} from "./ctoCards.mjs";
import { createProbes } from "./ctoProbes.mjs";
import { createSegmenter, segmentEventKind } from "./ctoSegments.mjs";
import {
  createRollupRunner,
  LEVEL_MS as ROLLUP_LEVEL_MS,
  ROLLUP_LEVELS,
  windowFor as rollupWindowFor,
} from "./ctoRollups.mjs";
import { buildFactProposal, createFactsEngine, matchCheckable, VERIFY_CYCLE_MS, senderKey, senderReliability } from "./ctoFacts.mjs";
import { formatFactsBlock, estimateTokens } from "./ctoSessions.mjs";
import {
  ambientCapUsd as budgetAmbientCapUsd,
  createCtoBudget,
  dayKey as budgetDayKey,
  isWorkShedInThrifty,
  tierAllows as budgetTierAllows,
} from "./ctoBudget.mjs";
// BET-1398 standing-query watchers (§4.3/§13.4): the event-driven watcher
// engine hosted by the adaptive engine. Supersedes the old cto.json poller.
import {
  collectWatcherHitsFromLedger,
  createStandingQueryEngine,
  extractSignifiers,
  patternSignatureFor,
} from "./ctoWatchers.mjs";

// BET-1419 overnight execution (§11): the pure window/portfolio machine
// (BET-1402) back the engine's veto/tonight verbs; resolveForgeOwner is the
// pure project→job-parent resolver shared with forge dispatch.
import { createOvernightScheduler, normalizeWindow, scheduleCountdown, dataAnalysisCandidatesFromTools } from "./ctoOvernight.mjs";
import { resolveForgeOwner } from "./delegate.mjs";
// BET-1517 (§9.1/§9.2): the triage stage — drained findings → 0–3 resolution
// plans in plans.json, one mid-tier model call per finding per tick.
import { createCtoTriage } from "./ctoTriage.mjs";

// BET-1395 tool discovery (§7): the registry engine — fusion of the four
// evidence channels, the two lifecycle bars, and the connect-ask gate.
import { createToolRegistry } from "./ctoToolRegistry.mjs";

// Actor tag stamped on every engine RPC call / ledger row (spec §3.3).
export const ACTOR = "cto";

// The single definition of a "running CTO job row" (BET-1427): the persisted
// delegate-job rows the §3.3 concurrent cap (act path) and the overnight
// dispatch / preemption counts (engine path) must agree on. If the definition
// of "running" ever changes (new status, grace window), change it HERE only.
export function isRunningCtoRow(row) {
  return row?.actor === ACTOR && row?.status === "running";
}

// Rate limits (spec §3.3): exceed any one and the engine pauses itself and
// raises a health warning (§10.6-7).
export const RATE_LIMITS = Object.freeze({
  sessionCreationsPerHour: 30,
  concurrentEphemeral: 5,
  concurrentDelegate: 2, // inside delegate's global cap of 5
});

export const HOUR_MS = 3_600_000;
export const TICK_INTERVAL_MS = 60_000;

// How long a rate-limit self-pause (exceedRateLimit) backs off before the
// engine's own tick auto-clears it (BET-1508). The concurrent-* limits trip on
// a momentary burst of ambient sessions; a pause until a human resumes is the
// wrong shape for a transient condition — on a busy box the boot→burst→trip
// sequence left the engine permanently paused, and a manual resume was undone
// within one tick (the next ambient dispatch re-tripped on top of the
// still-in-flight sessions). Five minutes gives the burst time to drain; if
// ambient is still saturated the next begin re-trips and the backoff repeats —
// which IS the intended backoff semantics. The persisted kill-switch pause
// (flag file, pause()/hardPause()) is NEVER auto-cleared: selfPaused is false
// on that path (the flag is authoritative), so the cool-down can only ever
// clear the in-memory rate-limit pause.
export const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;

// The card timer's cadence (BET-1382): it inspects pending asks / health
// escalations once a minute and promotes any ask past BLOCKER_AFTER_MS into a
// blocker card. The card threshold itself (10 min) lives in ctoCards.mjs.
export const CARD_CHECK_INTERVAL_MS = 60_000;
// Work-segmentation G refit cadence (§5.1-d): monthly, on the box's own
// inter-arrival times.
export const G_REFIT_INTERVAL_MS = 30 * 24 * HOUR_MS;
export const PROFILE_DECAY_INTERVAL_MS = 7 * DAY_MS; // §8.2 weekly sigma/repo decay tick
// §6.8 monthly half-life tuning cadence (a work timer, halted on pause).
export const MONTHLY_TUNE_INTERVAL_MS = 30 * 24 * HOUR_MS;
// BET-1419 (§11.1/§10.3): the veto card announces the window VETO_LEAD_MS
// before the trough's start, so the countdown reads ~30 min.
export const VETO_LEAD_MS = 30 * 60_000;
// BET-1419 (§10.4): a hard cap on tonight's queue; further adds are refused
// with a "cancel or edit first" note (never silent truncation).
export const TONIGHT_QUEUE_MAX = 12;

export const DOT = Object.freeze({
  ACTIVE: "active",
  DISABLED: "disabled",
  THRIFTY: "thrifty",
  PAUSED: "paused",
});

function nextId() {
  return randomBytes(4).toString("hex");
}

// ---------------------------------------------------------------------------
// Kill switch — a flag file, engine-external (§13.3)
// ---------------------------------------------------------------------------

export function createKillSwitch({ path = ctoPath("paused"), fs = fsp } = {}) {
  async function isPaused() {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }
  // The epoch-ms the kill switch was thrown (the file body is the write time),
  // for the §10.6-5 paused banner's "paused at" line. null when not paused.
  async function pausedAt() {
    try {
      const raw = await fs.readFile(path, "utf8");
      const ms = Number(raw);
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    } catch {
      return null;
    }
  }
  async function pause() {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, String(Date.now()), { mode: 0o600 });
  }
  async function resume() {
    await fs.rm(path, { force: true });
  }
  return { isPaused, pausedAt, pause, resume };
}

// ---------------------------------------------------------------------------
// Rate tracker (spec §3.3)
// ---------------------------------------------------------------------------

export function createRateTracker({ now = () => Date.now() } = {}) {
  const sessionCreations = [];
  let ephemeral = 0;
  let delegate = 0;

  function pruneWindow(windowMs) {
    const cutoff = now() - windowMs;
    while (sessionCreations.length > 0 && sessionCreations[0] < cutoff) {
      sessionCreations.shift();
    }
  }

  return {
    sessionCreationsPerHour() {
      pruneWindow(HOUR_MS);
      return sessionCreations.length;
    },
    recordSessionCreation(ts = now()) {
      sessionCreations.push(ts);
    },
    get ephemeral() {
      return ephemeral;
    },
    beginEphemeral() {
      ephemeral += 1;
      return () => {
        ephemeral = Math.max(0, ephemeral - 1);
      };
    },
    get delegate() {
      return delegate;
    },
    beginDelegate() {
      delegate += 1;
      return () => {
        delegate = Math.max(0, delegate - 1);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// State dot (spec §10.6)
// ---------------------------------------------------------------------------

export function computeDot({ enabled, paused, thrifty }) {
  if (!enabled) return DOT.DISABLED;
  if (paused) return DOT.PAUSED;
  if (thrifty) return DOT.THRIFTY;
  return DOT.ACTIVE;
}

// Default counts producer: needs-you count from the A1 cards store, digest /
// tonight counts not populated until later pipeline issues. Wired to the real
// cards schema (BET-1382): an open card (state === "open") is a needs-you item;
// resolved/dismissed cards have already moved off cards.json into the ledger.
// BET-1476: an open card with neither a title nor a body is the renderer-
// invisible residue BET-1469 stopped writing (§10.3) — the mappers drop it, so
// counting it would badge an answerable item the pane never renders. The same
// shared predicate (cardHasContent) decides content on both sides.
// Defensive — a malformed or missing store yields zeros, never a throw.
// BET-1469: the cards store is injectable so a test can exercise the counting
// logic without writing the real cards.json (the engine's own default passes
// the bundle's cards store; the standalone default stays the real one).
export async function defaultGetCounts(cardStore = cardsStore) {
  let needsYouCount = 0;
  try {
    const cards = await cardStore.load();
    const arr = Array.isArray(cards?.cards) ? cards.cards : [];
    needsYouCount = arr.filter((c) => c && c.state === "open" && cardHasContent(c)).length;
  } catch {
    needsYouCount = 0;
  }
  return { needsYouCount, generationInFlight: false, tonightCount: 0 };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export function createCtoEngine(deps = {}) {
  // BET-1469: the one-line store bundle for tests. Every key replaces that
  // real store for the WHOLE engine — including every sub-engine constructed
  // lazily below — so a test harness can go fully hermetic in one line
  // (`stores: fakeStores()`) instead of threading ~13 individual deps (the
  // gap that let fixtures leak into the live cards.json). Resolution order:
  // an explicitly passed individual dep (ledger, engineState, …) wins, then a
  // bundle entry, then the real store. Production passes nothing here and
  // gets exactly the real bundle it always had. Note the bundle carries
  // STORES, not engines: `rollups` is the rollup STORE (the top-level
  // `rollups` dep remains the pre-built runner), and `cards` is the cards.json
  // store (the top-level `cards` dep remains the cards manager).
  const bundle = {
    ledger: ledgerStore,
    engineState: engineStateStore,
    trust: trustStore,
    cards: cardsStore,
    inbox: inboxStore,
    // BET-1516 (§9.1): the pending-findings queue (blockers → pipeline).
    findings: findingsStore,
    // BET-1517 (§9.2): the resolution-plan store (triage output).
    plans: plansStore,
    verdicts: verdictsStore,
    budget: budgetStore,
    watchers: watchersStore,
    toolRegistry: toolRegistryStore,
    toolUsage: toolUsageStore,
    probeState: probeStateStore,
    segments: segmentsStore,
    rollups: rollupsStore,
    facts: factsStore,
    factsArchive: factsArchiveStore,
    profile: profileStore,
    journal: journalStore,
    ...deps.stores,
  };
  const {
    configGet = async () => ({}), // → { ctoEnabled?: boolean }
    ledger = bundle.ledger, // A1 ledger writer { append }
    engineState = bundle.engineState, // { load, save } (engine-state.json)
    // BET-1403: the trust ladder's own file — isolated from engine-state
    // writers so no snapshot-spread save can revert tiers/counters/pending.
    trustStore: trustStoreDep = bundle.trust,
    killSwitch = createKillSwitch(),
    publish = () => {}, // (evt: {kind:"ctoState", payload}) => void
    now = () => Date.now(),
    rates: rateLimits = RATE_LIMITS,
    tickIntervalMs = TICK_INTERVAL_MS,
    cardCheckIntervalMs = CARD_CHECK_INTERVAL_MS,
    // BET-1469: default counts read the BUNDLE's cards store, so a bundle-only
    // harness never binds the real cards.json through this path either.
    getCounts: getCountsDep = null,
    track = createRateTracker({ now }),
    // BET-1382 needs-you card machinery (blocker cards). Defaults to the real
    // stores; tests inject a fake. Cards are about the user's own blockers,
    // not autonomous CTO work, so this is wired regardless of enabled state.
    // BET-1397: the internal cards manager gets the blocking-tier router
    // (`cardFireNotify`) so an inbox `blocker` note (source 3) fires the one
    // notification on the live box.
    cardFireNotify = async () => {},
    // BET-1463: the cards module needs to consume/drop `pendingBlockers`
    // entries in engine-state.json (mark ingested entries resolved; drop an
    // entry when its health card closes) through the SAME sanctioned
    // read-modify-write path `recordBlocker` uses below, so concurrent
    // engine-state writers share one process-wide mutex. Inject a bound
    // instance rather than letting ctoCards.mjs import patchEngineState
    // itself — same seam pattern as getSessionInfo/getDesktopPresence.
    // BET-1516 (§10.3): the box's session-existence check (oc.sessionExists —
    // definitive 404 → false, transient → true) for the inbox cards'
    // sender-session liveness predicate. Default null → the predicate is
    // skipped (no checker wired = no opinion, never a false resolution).
    hasSession = null,
    cards = createCtoCards({
      fireNotify: cardFireNotify,
      cardStore: bundle.cards,
      engineState,
      patchEngineState: (mutation) => patchEngineState(mutation, { engineState }),
      // Inbox-note grouping layer 2 (§10.3 never-duplicate). Wrapped in a
      // thunk, not passed by reference: `getSessionInfo` is destructured
      // BELOW `cards` in this same binding, so naming it directly here is a
      // TDZ error. The arrow body runs long after destructuring settles.
      getSessionInfo: (sid) => getSessionInfo(sid),
      // BET-1516 (§9.1): the pending-findings queue writer — blocker notes
      // (at arrival) and worker asks (past the 10-min threshold) wait here to
      // enter the pipeline on the next engine tick (drainFindings, card tick).
      queueFinding: (finding) => queueFindingRow(finding),
      // §10.3 liveness seams, same TDZ-safe thunk pattern as getSessionInfo:
      // hasSession is destructured above, conditionGone classifies via the
      // §6.7 matcher + factVerify (both destructured later in this binding).
      hasSession: (sid) => hasSession(sid),
      conditionGone: async (condition) => conditionGoneFromCondition(condition, factVerify),
      // The engine's clock is authoritative for the cards module too — one
      // now for promoteDue thresholds AND the BET-1407 seed's retention
      // bound (a test's fake clock must not make every persisted ask look
      // ancient against a real Date.now()).
      now,
    }),
    // A5 evidence/presence seams (injected I/O — nothing here touches tmux /
    // push directly; index.mjs supplies the real resolvers).
    getSessionInfo = async () => ({ owner: "user", project: undefined }),
    getDesktopPresence = pushGetDesktopPresence,
    getLastDesktopHeartbeat = pushGetLastDesktopHeartbeat,
    reaper = null, // { start() -> {stop} } | null — the §3.1 ephemeral-session reaper (ctoSessions)
    // A6 segmentation seams (§5.1/§5.2): the model-backed summary producers
    // (wired to runEphemeral in index.mjs; defaults degrade to a truncated
    // prompt). The engine wraps them in the §3.3 ephemeral rate gate so a
    // summary call is a normal rate-limited session creation.
    summarize = async () => ({ ok: false, gated: false }),
    computeOneLiner = async () => null,
    segmenterOverride = null, // optional pre-built segmenter (else one is constructed below)
    // BET-1381 rollups (§5.3): the `ambient-summarize` reduce producer,
    // wrapped by the engine in the §3.3 ephemeral rate gate (defaults to a
    // no-op → the runner persists degraded rollups, no model spend). A caller
    // may inject a pre-built rollup runner instead.
    runEphemeral = null,
    rollups = null, // optional pre-built rollup runner override
    // BET-1389 blackboard (§6): optional pre-built facts engine (else one is
    // constructed below from engineState/ledger/runEphemeral/presence), plus
    // the opportunistic checkable-verify + trace seams (null defaults → no
    // verification surface, nothing gets stamped checkable).
    facts = null,
    factSurfaceExists = async () => false,
    factVerify = async () => ({ ok: true }),
    factResolveRef = null,
    // BET-1387 cold-start backfill (§10.6-4): the read-only opencode db handle
    // (index.mjs supplies the real one via opencodeDb) + a runEphemeral the
    // backfill's A7 rollup reduces may use. The backfill has its OWN spend
    // bound, so it must NOT go through the §3.3 rate gate — it uses these raw
    // seams directly and governs cost itself.
    getDb = null,
    backfillRunEphemeral = runEphemeral,
    backfill = null, // optional pre-built backfill override (tests)
    // §8 profile (BET-1393): optional pre-built profile engine (else one is
    // constructed from the shared profileStore — deterministic, never throws).
    profile = null,
    // BET-1397 CTO inbox (§4.4): the durable inbox.json store + seam, so drain
    // is unit-testable without touching the real fs. Defaults to the real store.
    inbox = null,
    // BET-1516 (§9.1): the pending-findings queue (findings.json) — blockers
    // enter the pipeline on the next engine tick. Defaults to the real store;
    // tests inject a bundle memory store.
    findings = null,
    // BET-1517 (§9.2): the resolution-plan store (triage output, plans.json).
    // Same resolution pattern as `findings`.
    plans = null,
    // BET-1517 (§9.1): optional pre-built triage engine (tests). Else one is
    // constructed lazily below over bundle.plans + the gated runEphemeral.
    triage = null,
    // BET-1517 (§9.2): the sender-session transcript-tail reader for blocker
    // triage context — async (sessionID) => string|null (≤ 2k tokens, the
    // caller truncates). Default null → no tail block.
    getTranscriptTail = null,
    // BET-1391 verdict ledger (§9.5): optional pre-built verdicts store (else
    // the shared `verdicts.json` store). The verdict engine + facts sink are
    // constructed below from it.
    verdicts = bundle.verdicts,
    // BET-1388 economics (§10.6-6/§12.1/§12.2/§13.3): the ambient-spend budget
    // accessor (defaults to the real budget.json store via createCtoBudget).
    // beginEphemeral consults it for the independent HARD CAP before every
    // ambient model call; reportAmbientSpend records each run's spend and flips
    // thrifty when the cap is crossed. `tier` is the A12 dial (default low).
    budget = createCtoBudget({ store: bundle.budget }),
    tierGet = async () => "low",
    // BET-1398 standing-query watchers (§4.3/§13.4): optional pre-built
    // watcher engine (else one is constructed below from watchersStore/ledger/
    // engineState/budget). `legacyWatchesLoader` is the one-time source for
    // migrating the superseded cto.json poller watches (index.mjs wires the
    // real loader; default none → no migration).
    watchers = null,
    legacyWatchesLoader = async () => [],
    // BET-1419 overnight execution (§11): the injected scheduler owns the
    // window state machine + portfolio over overnight.json (index.mjs
    // constructs it with the budget seam). The delegate seams keep the engine
    // free of tmux/delegate-store I/O: `startDelegateJob` starts one job
    // (actor "cto" + sweepAllowance are baked in by index.mjs),
    // `listDelegateJobs`/`pauseDelegateJob` back §11.6 preemption, and
    // `listProjects` resolves a candidate's project to a job parent. All
    // default to null → overnight stays disabled even at High tier.
    overnight = null,
    startDelegateJob = null,
    listDelegateJobs = null,
    pauseDelegateJob = null,
    listProjects = null,
    // BET-1395 tool discovery (§7): optional pre-built registry engine (else
    // one is constructed below from the shared tool stores + cards).
    // `toolsRunEphemeral` is the classifier's LLM seam, PRE-GATED by
    // index.mjs through the §3.3 ephemeral rate gate (like the suggest
    // engine's runSuggest); `toolsGetSurfaces` is the channel-3 seam (the
    // already-read config surfaces). Defaults null → no LLM fallback and no
    // config evidence; channel 1 (secret ledger) still fuses.
    tools = null,
    toolsRunEphemeral = null,
    toolsGetSurfaces = null,
  } = deps;

  // BET-1469: the default counts producer binds the bundle's cards store (an
  // injected `getCounts` dep still wins), so `getState()` in a bundle-only
  // harness never reads the real cards.json.
  const getCounts = getCountsDep ?? (() => defaultGetCounts(bundle.cards));

  let disposed = false;
  let thrifty = false;
  let thriftyAtDay = null; // local-day key thrifty was set on (BET-1388 auto-clear)
  let selfPaused = false;
  let selfPausedAt = null; // when the rate-limit self-pause began (BET-1508 cool-down)
  let enabled = false;
  let heartbeatAt = now();
  let tickHandle = null;
  let cardTickHandle = null;
  let reaperHandle = null;
  let refitHandle = null;
  let lastPublishedSerialized = null;
  let rollupRunner = null;
  let factsEngine = null;
  let profileEngine = null;
  let journalEngine = null;
  let verifyHandle = null;
  let tuneHandle = null;
  let builtInBackfill = null;
  let profileDecayHandle = null;
  let verdictsEngine = null;
  let trustEngine = null;
  let watcherEngine = null;
  let toolEngine = null;
  let probesEngine = null;
  let lastToolScanDay = null;

  // A5 presence inputs (spec §5.4): lastSeen = max(desktop heartbeat, app
  // open, user prompt). The desktop heartbeat is read live via
  // getDesktopPresence(); prompts are stamped here from the event stream. The
  // seenId filter folds global + scoped-stream duplicates into one evidence
  // row (createSeenIdFilter — the event id, "", rolls a cache of seen ids).
  const seen = createSeenIdFilter();
  let promptTs = 0;

  // Ledger writes are best-effort: a ledger I/O failure must never take the
  // engine (and its state machine) down with it.
  async function ledgerLog(entry) {
    try {
      await ledger.append({ actor: ACTOR, ts: now(), ...entry });
    } catch {
      /* best-effort */
    }
  }

  // BET-1516 (§9.1): append one finding to the pending-findings queue — the
  // durable handoff between the HTTP funnel (inbox blocker notes) / the card
  // timer (worker asks past the §10.3 threshold) and the engine's card tick
  // drain. Best-effort: a queue failure never takes the funnel down (the
  // note itself already persisted to the inbox, which remains the fallback
  // breakpoint path).
  async function queueFindingRow(finding) {
    const store = findings ?? bundle.findings;
    if (!store) return;
    try {
      await patchStore(store, (fresh) => ({
        findings: [...(Array.isArray(fresh?.findings) ? fresh.findings : []), finding],
      }));
    } catch {
      /* best-effort */
    }
  }

  // BET-1516 (§10.3 predicate 2): is the condition a note named now GONE?
  // Reuses the §6.7 machinery exactly: matchCheckable picks the surface +
  // probe (null → no opinion), factVerify (the same seam the facts engine
  // uses — index.mjs wires it to the real surface verifier) checks the named
  // state now. isConditionGoneResult classifies: a definitive negative is
  // "gone"; "no surface"/"unavailable" is a no-opinion null, never a false
  // resolution.
  async function conditionGoneFromCondition(condition, verify) {
    const match = matchCheckable(condition);
    if (!match) return null;
    try {
      const r = await verify({ surface: match.surface, probe: match.probe, branch: match.branch ?? undefined });
      return isConditionGoneResult(match, r);
    } catch {
      return null;
    }
  }

  // Load + append a pending blocker-card request (health escalation, §10.6-7)
  // into engine-state.json. Best-effort — the health record never throws.
  async function recordBlocker(source, reason) {
    try {
      const blocker = {
        id: nextId(),
        kind: "blocker",
        source,
        reason,
        ts: now(),
        resolved: false,
      };
      // BET-1425: per-key RMW — an array push derived from the FRESH state, so
      // a concurrent writer's keys survive this save.
      await patchEngineState((fresh) => {
        const pending = Array.isArray(fresh?.pendingBlockers) ? [...fresh.pendingBlockers] : [];
        pending.push(blocker);
        return { pendingBlockers: pending };
      }, { engineState });
    } catch {
      /* best-effort */
    }
  }

  // Re-read the live signals the state dot depends on (kill-switch flag is the
  // costly one, so only gates/sync pay it). Returns the fresh context.
  async function gateContext() {
    let enabledNow = false;
    try {
      enabledNow = (await configGet())?.ctoEnabled === true;
    } catch {
      enabledNow = enabled;
    }
    enabled = enabledNow;
    let paused = selfPaused;
    let pausedAt = null;
    try {
      paused = paused || (await killSwitch.isPaused());
      if (paused) pausedAt = await killSwitch.pausedAt();
    } catch {
      /* flag read failure → treat as not paused */
    }
    return { enabled: enabledNow, paused, pausedAt };
  }

  async function readState() {
    const { enabled: enabledNow, paused, pausedAt } = await gateContext();
    let counts = { needsYouCount: 0, generationInFlight: false, tonightCount: 0 };
    try {
      counts = (await getCounts()) ?? counts;
    } catch {
      /* best-effort */
    }
    // Backfill progress for the learning card (§10.6-4) — informational, not a
    // needs-you item. Reads engine-state progress; absent = idle.
    let backfill = { done: 0, total: 0, stopped: false, active: false };
    try {
      const es = (await engineState.load()) || {};
      const p = es.backfillProgress;
      backfill = {
        done: p && Array.isArray(p.processedSessions) ? p.processedSessions.length : 0,
        total: p?.total ?? 0,
        startedAt: p?.startedAt ?? null,
        stopped: !!es.backfillStopped,
        reason: es.backfillStopped?.reason ?? null,
        stoppedAtDepthDays: es.backfillStopped?.stoppedAtDepthDays ?? null,
        // active = started (watermark recorded) but not yet finished.
        active: !!es.backfillStartInstant && es.backfillDone !== true,
      };
      // BET-1419: tonight's queue size (§10.4 line) — the engine owns the
      // queue, so it overrides the counts fold's zero when tasks exist.
      if (Array.isArray(es.tonightQueue)) {
        counts.tonightCount = es.tonightQueue.filter((t) => t && typeof t.id === "string").length;
      }
    } catch {
      /* best-effort */
    }
    let tier = null;
    try {
      tier = await tierGet();
    } catch {
      tier = null;
    }
    return {
      enabled: enabledNow,
      dot: computeDot({ enabled: enabledNow, paused, thrifty }),
      pausedAt: paused ? pausedAt : null,
      needsYouCount: counts.needsYouCount ?? 0,
      generationInFlight: !!counts.generationInFlight,
      tonightCount: counts.tonightCount ?? 0,
      tier,
      backfill,
    };
  }

  // Publish {kind:"ctoState"} ONLY when something changed (no spam, §10.1).
  async function syncState() {
    const state = await readState();
    const serialized = JSON.stringify(state);
    if (serialized !== lastPublishedSerialized) {
      lastPublishedSerialized = serialized;
      publish({ kind: "ctoState", payload: state });
    }
    return state;
  }

  // The engine's single lifecycle tick (startPoller: unref + inFlight).
  // Kill switch is honored at every tick (§13.3): if the flag is present the
  // engine reflects paused and does no work.
  async function tick() {
    if (disposed) return;
    heartbeatAt = now();
    try {
      // BET-1508: a rate-limit self-pause is a backoff, not a policy. Once the
      // cool-down has elapsed, clear it and let this same tick re-assess —
      // the next ambient dispatch re-trips if the burst is still running,
      // which restarts the backoff instead of wedging the engine. The
      // persisted kill-switch pause is untouched (selfPaused is false on
      // that path), so a human Pause always wins.
      if (selfPaused && selfPausedAt != null && now() - selfPausedAt >= RATE_LIMIT_COOLDOWN_MS) {
        selfPaused = false;
        selfPausedAt = null;
        await ledgerLog({
          kind: "cto.self_resume",
          reason: "rate_limit_cooldown_elapsed",
          source: "engine",
        });
        // The trip raised a rate_limit health card; the backoff ending is the
        // liveness predicate going true again (same shape as onHealthRecovered
        // on the manual resume path).
        try {
          await cards.onHealthRecovered();
        } catch {
          /* best-effort */
        }
      }
      const { enabled: enabledNow, paused } = await gateContext();
      if (paused) {
        await syncState();
        return;
      }
      // §10.6-6 BET-1388: thrifty auto-clears at the daily budget reset.
      await maybeClearThrifty();
      // §5.3 rollups — ambient background work, gated on enabled like any other.
      if (enabledNow) {
        await finalizeRollups();
        // §6.2 blackboard: pump the per-project proposal queue (gatekeeper).
        await pumpFacts();
        // §4.3/§13.4 standing-query watchers: windowed kinds + retirement, and
        // auto-created watchers after a new day rollup lands.
        await watcherTick();
        // §11 overnight: window state machine + plan dispatch (BET-1419).
        await overnightTick();
        // §7 tool discovery: the daily evidence scan + lifecycle + connect
        // asks (BET-1395). Once per UTC day; self-paced inside the registry.
        await toolsTick();
        // §7.5 probe runner (BET-1396): due probes + weekly relevance.
        await probesTick();
      }
      // §10.6-4 cold-start backfill — also ambient, gated on enabled. Its own
      // drained state marker makes it run at most once per box.
      if (enabledNow) {
        await backfillStep();
      }
      await syncState();
    } catch {
      /* never throw into the poller */
    }
  }

  function stopTimers() {
    if (tickHandle) {
      tickHandle.stop();
      tickHandle = null;
    }
    if (reaperHandle) {
      reaperHandle.stop();
      reaperHandle = null;
    }
    if (refitHandle) {
      refitHandle.stop();
      refitHandle = null;
    }
    if (verifyHandle) {
      verifyHandle.stop();
      verifyHandle = null;
    }
    if (tuneHandle) {
      tuneHandle.stop();
      tuneHandle = null;
    }
    if (profileDecayHandle) {
      profileDecayHandle.stop();
      profileDecayHandle = null;
    }
  }

  function startTimers() {
    if (tickHandle || disposed) return;
    tickHandle = startPoller(tick, {
      intervalMs: tickIntervalMs,
      label: "cto-engine",
      immediate: false,
    });
    // The §3.1 reaper is a work timer like any other: started with the engine,
    // halted on pause (event ingestion alone keeps running while paused).
    if (reaper && !reaperHandle && typeof reaper.start === "function") {
      reaperHandle = reaper.start();
    }
    // §5.1-d monthly G refit — a work timer, halted on pause like the rest.
    if (segmenter && !refitHandle) {
      refitHandle = startPoller(
        () => segmenter.monthlyRefit().catch(() => {}),
        { intervalMs: G_REFIT_INTERVAL_MS, label: "cto-g-refit", immediate: false },
      );
    }
    // §6.7 checkable-verify cycle (6h, no model cost) — a work timer.
    if (!verifyHandle) {
      verifyHandle = startPoller(
        () => getFactsEngine().verifyDue().catch(() => {}),
        { intervalMs: VERIFY_CYCLE_MS, label: "cto-facts-verify", immediate: false },
      );
    }
    // §6.8 monthly half-life tuning — a work timer, halted on pause like the rest.
    if (!tuneHandle) {
      tuneHandle = startPoller(
        () => getFactsEngine().recomputeHalfLives().catch(() => {}),
        { intervalMs: MONTHLY_TUNE_INTERVAL_MS, label: "cto-facts-tune", immediate: false },
      );
    }
    // §8.2 weekly numeric decay — a work timer, halted on pause like the rest.
    if (!profileDecayHandle) {
      profileDecayHandle = startPoller(
        () => getProfile().decayWeekly().catch(() => {}),
        { intervalMs: PROFILE_DECAY_INTERVAL_MS, label: "cto-profile-decay", immediate: false },
      );
    }
  }

  // The card timer (BET-1382): promotes pending worker asks past the 10-min
  // threshold into blocker cards and ingests the watchdog's health escalations,
  // then re-publishes state if the needs-you count changed. Unlike the tick
  // this runs even while paused/disabled — blocker cards are the user's own
  // "needs you" surface (spec §10.3, §9.2), not autonomous CTO work, so it
  // keeps serving even when the engine's timers are stopped (§10.6-5's
  // "event ingestion keeps running" spirit). Stopped only on dispose.
  // BET-1516: it is also the engine tick that (a) drains the pending-findings
  // queue into the pipeline — blockers enter evidence ≤ 1 min after arrival,
  // even on a paused engine, and (b) runs the §10.3 inbox-card liveness pass
  // (sender session gone / condition gone / inbox TTL → auto-resolve).
  async function cardTick() {
    if (disposed) return;
    try {
      await cards.promoteDue();
      await cards.ingestHealthEscalations();
      const drained = await drainFindings();
      // BET-1517: the triage stage consumes the drain's rows — 0–3 resolution
      // plans per finding into plans.json (one gated model call per finding).
      await triageDrained(drained?.rows);
      await cards.checkInboxLiveness();
      await syncState();
    } catch {
      /* never throw into the poller */
    }
  }

  function stopCardTimer() {
    if (cardTickHandle) {
      cardTickHandle.stop();
      cardTickHandle = null;
    }
  }

  function startCardTimer() {
    if (cardTickHandle || disposed) return;
    cardTickHandle = startPoller(cardTick, {
      intervalMs: cardCheckIntervalMs,
      label: "cto-cards",
      immediate: false,
    });
  }

  // §10.6-5: pausing stops all engine timers (event ingestion is not a timer
  // and is unaffected). The kill-switch flag is the persisted, external mark.
  async function pause({ reason = "manual", source = "engine" } = {}) {
    await killSwitch.pause();
    stopTimers();
    selfPaused = false; // the flag is now authoritative
    await ledgerLog({ kind: "cto.pause", reason, source });
    await syncState();
    return { ok: true };
  }

  async function resume({ reason = "manual" } = {}) {
    await killSwitch.resume();
    selfPaused = false;
    startTimers();
    // Resuming a health-paused engine = "health recovered" → its blocker cards
    // resolve (liveness predicate false, §10.3). Best-effort.
    try {
      await cards.onHealthRecovered();
    } catch {
      /* best-effort */
    }
    await ledgerLog({ kind: "cto.resume", reason });
    await syncState();
    return { ok: true };
  }

  // Watchdog escalation (>4× expected hourly burn, §13.3): writes the kill
  // switch flag AND records a blocker-card request in engine-state.json.
  async function hardPause({ reason = "watchdog", source = "watchdog" } = {}) {
    await killSwitch.pause();
    stopTimers();
    selfPaused = false;
    await recordBlocker(source, reason);
    await ledgerLog({ kind: "cto.hard_pause", reason, source });
    await syncState();
    return { ok: true };
  }

  // Watchdog / cap-hit signal (>2× expected hourly burn, §13.3; §10.6-6).
  async function setThrifty(value, { reason = "", source = "watchdog" } = {}) {
    const next = !!value;
    const changed = next !== thrifty;
    thrifty = next;
    thriftyAtDay = next ? budgetDayKey(now()) : thriftyAtDay;
    if (changed) {
      await ledgerLog({
        kind: next ? "cto.thrifty_on" : "cto.thrifty_off",
        reason,
        source,
      });
    }
    await syncState();
    return { ok: true, changed };
  }

  // BET-1388 (§10.6-6/§12.1): record an ambient model call's spend into budget
  // (wired as runEphemeral's reportCost seam), and flip thrifty if the record
  // crosses today's cap — shedding starts even if no further call is blocked.
  // Metering is best-effort: a budget failure never breaks the run.
  async function reportAmbientSpend({ model, tokens } = {}) {
    try {
      await budget.record({ model, tokens, nowMs: now() });
    } catch {
      /* best-effort */
    }
    let cap = budgetAmbientCapUsd({});
    try {
      cap = budgetAmbientCapUsd((await configGet()) ?? {});
    } catch {
      /* keep default */
    }
    try {
      if (await budget.isCapHit(cap)) {
        await setThrifty(true, { reason: "cap_hit", source: "cap" });
      }
    } catch {
      /* best-effort */
    }
    return { ok: true };
  }

  // BET-1388 (§10.6-6): auto-clear thrifty once a local midnight passes since
  // it was set (the daily budget reset). Runs from the tick.
  async function maybeClearThrifty() {
    if (!thrifty || !thriftyAtDay) return;
    if (budgetDayKey(now()) !== thriftyAtDay) {
      await setThrifty(false, { reason: "daily_reset", source: "engine" });
    }
  }

  // A tripped rate limit. Two severities (BET-1513 follow-up):
  //   pause  — the RUNAWAY-shaped limit (sessionCreationsPerHour): a loop is
  //          creating sessions faster than they finish. The engine pauses all
  //          work and raises a rate_limit health card; the in-memory pause is
  //          a BACKOFF auto-cleared by the tick after RATE_LIMIT_COOLDOWN_MS
  //          (never the kill-switch flag, so a human Pause always wins).
  //   shed   — the CONCURRENCY limits (concurrentEphemeral/concurrentDelegate):
  //          "one more ambient call than slots" is a transient condition whose
  //          correct response is refusing THE CALL — the caller already
  //          degrades gracefully on {ok:false} — not pausing the whole engine.
  //          Pausing here wedged busy boxes into a trip→backoff→burst→trip
  //          oscillation (observed live 2026-09-01: boot → 5 ambient sessions
  //          → trip → 5-min backoff → self-resume → re-trip 30s later), with
  //          the dot reading paused most of the time. A shed is ledgered for
  //          the drill-down; it raises NO needs-you card — routine backoff is
  //          not something the user must act on.
  async function exceedRateLimit(limitId, { pause = true } = {}) {
    await ledgerLog({ kind: "cto.ratelimit_trip", reason: limitId, source: "engine" });
    if (pause) {
      selfPaused = true;
      selfPausedAt = now();
      await recordBlocker("rate_limit", limitId);
      await syncState();
    }
  }

  // ----- Session / job creation gates (§3.3) -----
  // Each checks the kill switch at START (the second place the flag is
  // honored, §13.3) plus the relevant rate limit. Later pipeline issues call
  // these before creating a session / starting a delegate job; the skeleton
  // ships the guards + the pause-on-trip behavior.

  async function checkCanCreateSession() {
    const { enabled: enabledNow, paused } = await gateContext();
    if (!enabledNow) return { ok: false, error: "cto_disabled" };
    if (paused) return { ok: false, error: "cto_paused" };
    if (track.sessionCreationsPerHour() >= rateLimits.sessionCreationsPerHour) {
      await exceedRateLimit("sessionCreationsPerHour");
      return { ok: false, error: "rate_limit:sessionCreationsPerHour" };
    }
    return { ok: true };
  }

  async function beginEphemeral() {
    const { enabled: enabledNow, paused } = await gateContext();
    if (!enabledNow) return { ok: false, error: "cto_disabled" };
    if (paused) return { ok: false, error: "cto_paused" };
    // BET-1388 (§12.1): the independent HARD CAP — checked before EVERY ambient
    // model call, at every tier, regardless of the tier dial. Once today's
    // ambient spend reaches the cap, no new ambient session is created (even
    // the "kept to the last token" work stops at the cap). A cap hit also flips
    // the engine thrifty (§10.6-6). A budget read failure never opens an
    // unchecked writer — we default to the configured cap and treat a failed
    // read as non-hit (the run proceeds; the meter stays best-effort).
    let cap = budgetAmbientCapUsd({});
    try {
      cap = budgetAmbientCapUsd((await configGet()) ?? {});
    } catch {
      /* keep default */
    }
    try {
      if (await budget.isCapHit(cap)) {
        await setThrifty(true, { reason: "cap_hit", source: "cap" });
        return { ok: false, error: "cto_cap_hit" };
      }
    } catch {
      /* a failed cap read must not block ambient work */
    }
    if (track.ephemeral >= rateLimits.concurrentEphemeral) {
      await exceedRateLimit("concurrentEphemeral", { pause: false });
      return { ok: false, error: "rate_limit:concurrentEphemeral" };
    }
    track.recordSessionCreation();
    const release = track.beginEphemeral();
    await ledgerLog({ kind: "cto.ephemeral_begin" });
    return { ok: true, release };
  }

  async function beginDelegateJob() {
    const { enabled: enabledNow, paused } = await gateContext();
    if (!enabledNow) return { ok: false, error: "cto_disabled" };
    if (paused) return { ok: false, error: "cto_paused" };
    if (track.delegate >= rateLimits.concurrentDelegate) {
      await exceedRateLimit("concurrentDelegate", { pause: false });
      return { ok: false, error: "rate_limit:concurrentDelegate" };
    }
    const release = track.beginDelegate();
    await ledgerLog({ kind: "cto.delegate_begin" });
    return { ok: true, release };
  }

  // ----- A6 work segmentation (§5.1/§5.2) -----
  // The segmenter's model-backed seams are wrapped in the §3.3 ephemeral rate
  // gate so each segment summary / one-liner is a normal rate-limited session
  // creation — disabled/paused/at-cap → gated → the segmenter persists a
  // degraded summary with no model spend.
  const gatedSummarize = async (data) => {
    const gate = await beginEphemeral();
    if (!gate.ok) return { ok: false, gated: true, error: gate.error };
    try {
      return await summarize(data);
    } finally {
      gate.release?.();
    }
  };
  const gatedOneLiner = async (data) => {
    const gate = await beginEphemeral();
    if (!gate.ok) return null;
    try {
      return await computeOneLiner(data);
    } finally {
      gate.release?.();
    }
  };
  const segmenter =
    segmenterOverride ??
    createSegmenter({
      summarize: gatedSummarize,
      computeOneLiner: gatedOneLiner,
      now,
      // §8.2 profile feed: every closed segment's atoms/session-length/project
      // go to the profile engine in the same pass (no second model call).
      // §3.2 journal feed: any `journalProposals` in the same A4 output are
      // written by the engine (cap-50, eviction at admission).
      onSummary: async (summary) => {
        getProfile().applySegmentSummary(summary);
        const jp = Array.isArray(summary?.journalProposals) ? summary.journalProposals : [];
        if (jp.length > 0) await getJournal().addProposals(jp).catch(() => {});
      },
    });

  // ----- BET-1381 rollups (§5.3) -----
  // Window-close TIMERS live here on the engine tick. The task list tracked a
  // per-level cursor (the start of the last FINALIZED window) persisted in
  // engine-state; each 1-min tick asks "has a window of this level closed since
  // the cursor?" and hands the due windows to the rollup runner. Defaulting the
  // cursor to the CURRENT window start on first sight means the past is never
  // backfilled — a window only gets rolled up once it has actually closed.
  // One shared ephemeral-rate wrapper (§3.3) used by both the rollup runner and
  // the facts gatekeeper — every model-bound CTO step goes through the same
  // per-session creation gate (D10's "well-maintained" writer discipline).
  const gatedRunEphemeral = async (data) => {
    const gate = await beginEphemeral();
    if (!gate.ok) return { ok: false, gated: true, error: gate.error };
    try {
      // BET-1388: the engine-wrapped ambient model calls report their spend to
      // the budget via reportAmbientSpend. The rollup runner / facts engine
      // call runEphemeral without their own deps, so the reportCost seam is
      // injected here.
      return runEphemeral
        ? await runEphemeral({
            ...data,
            deps: { ...(data?.deps || {}), reportCost: reportAmbientSpend },
          })
        : { ok: false, gated: true };
    } finally {
      gate.release?.();
    }
  };

  function getRollupRunner() {
    if (rollupRunner) return rollupRunner;
    if (deps.rollups) {
      rollupRunner = deps.rollups;
      return rollupRunner;
    }
    // No reduce producer wired → rolling up would only write degraded data with
    // no model spend. Stay inert (and never touch the real stores) until a
    // runEphemeral is supplied.
    if (!runEphemeral) return null;
    rollupRunner = createRollupRunner({
      runEphemeral: gatedRunEphemeral,
      presenceCheck: () => engine.getPresence().state === "present",
      now,
      // P2 (§6.2): rollup fact-sync submits blackboard proposals to the queue.
      submitProposal: async (proposal) => (await getFactsEngine()).submitProposal(proposal),
    });
    return rollupRunner;
  }

  // Lazy-construct the profile engine (BET-1393 / §8). Pure deterministic
  // module with injected store; always inert-safe, never throws. The engine
  // owns its lifecycle: init on start, per-event feeding, the weekly decay
  // tick, and the segment-summary atom feed (via the segmenter's onSummary).
  function getProfile() {
    if (profileEngine) return profileEngine;
    profileEngine = deps.profile ?? createCtoProfile({ now, store: bundle.profile });
    return profileEngine;
  }

  // Lazy-construct the journal (§3.2, BET-1394). Pure module over the injected
  // store; inert-safe and never throws. The engine owns the only write path
  // (ephemeral-session `journalProposals` via the segmenter's onSummary) and
  // exposes it for the render-model read under Settings → Internals.
  function getJournal() {
    if (journalEngine) return journalEngine;
    journalEngine = deps.journal ?? createCtoJournal({ store: bundle.journal });
    return journalEngine;
  }

  // Lazy-construct the blackboard facts engine (BET-1389 / §6). Mirrors the
  // rollup-runner pattern: degraded (deterministic gatekeeper) when no model
  // runner is wired, always useful, never throws. The engine owns the queue
  // pump (per-project, on tick) + the 6h verify + monthly tuning timers.
  function getFactsEngine() {
    if (factsEngine) return factsEngine;
    if (facts) {
      factsEngine = facts;
      return factsEngine;
    }
    factsEngine = createFactsEngine({
      engineState,
      ledger,
      runEphemeral: runEphemeral ? gatedRunEphemeral : null,
      now,
      facts: bundle.facts,
      archive: bundle.factsArchive,
      presenceCheck: () => engine.getPresence().state === "present",
      surfaceExists: factSurfaceExists,
      verify: factVerify,
      resolveRef: factResolveRef,
    });
    return factsEngine;
  }

  // BET-1391 verdict ledger (§9.5): lazy single instance over the injectable
  // verdicts store. The counter sinks are registered ONCE at construction
  // so every recorded verdict routes its §9.5 effects to the sender-reliability
  // counters (B1) and friends — and are unregistered by the engine's dispose
  // below (BET-1466: the claim used to be false, the sinks kept firing after
  // dispose against disposed engine state).
  let verdictSinkDisposers = [];
  function getVerdictsEngine() {
    if (verdictsEngine) return verdictsEngine;
    verdictsEngine = createVerdictEngine({ verdicts, now });
    verdictSinkDisposers.push(verdictsEngine.registerCounterSink(factsCounterSink));
    verdictSinkDisposers.push(verdictsEngine.registerCounterSink(tonightCounterSink));
    // BET-1404 (§9.5): tool-as-source verdicts fold into the tool registry's
    // as_source counters — the decay chain's input data. Late-bound registry
    // handle: the tool registry is constructed lazily and the sink fires
    // after any verdict, so resolve getTools() at fold time. Best-effort
    // like every sink.
    verdictSinkDisposers.push(
      verdictsEngine.registerCounterSink(
        createAsSourceSink({
          registry: {
            applyAsSource: (toolId, effects) => getTools().applyAsSource(toolId, effects),
          },
        }),
      ),
    );
    // BET-1403 (§9.4): the trust counters ride the same §9.5 sink registry —
    // per-action-class Beta counters over class-attributed suggestion
    // verdicts. Best-effort like every sink: a failure never breaks verdict
    // recording.
    const t = getTrust();
    verdictSinkDisposers.push(
      verdictsEngine.registerCounterSink((effects, entry) => {
        void t.noteVerdictEffects(effects, entry).catch(() => {});
      }),
    );
    return verdictsEngine;
  }

  // BET-1419 queue-tonight counter sink (§11.4): fold queue-tonight verdicts
  // into the overnight Thompson acceptance counters (two per category, read
  // by the portfolio's next sample). Only the suggestion-subject verdicts
  // with class `queue-tonight` count — the veto card's own verdicts are user
  // consent, not task acceptance. The fold maps the verdict's §9.5 effects
  // (accept → success, reject/veto → rejection) internally. Best-effort.
  function tonightCounterSink(effects, entry) {
    if (!overnight) return;
    if (entry?.subject?.type !== "suggestion" || entry?.subject?.class !== "queue-tonight") return;
    void overnight
      .foldCounters({ category: "queue-tonight", verdict: entry?.verdict, never: entry?.never === true })
      .catch(() => {});
  }

  // BET-1403: the earned-trust engine over its own store file (trust.json —
  // a legacy `es.trust` payload migrates on first load). One instance per
  // engine; the suggest module keeps
  // its own over the same stores — both are stateless facades whose every
  // op loads fresh, mutates, and saves.
  function getTrust() {
    if (trustEngine) return trustEngine;
    trustEngine = createCtoTrust({ store: trustStoreDep, legacy: engineState, ledger, verdicts, now });
    return trustEngine;
  }

  // BET-1398 standing-query watchers (§4.3/§13.4): lazy single instance over
  // the shared watchers store. Injected seams for usage-burn evaluation read
  // today's ambient spend pace and the daily cap from the budget engine — the
  // same sources the §13.3 watchdog consults — so a `usage-burn` watcher fires
  // when the ambient burn is running hot relative to the cap fraction.
  function getWatchers() {
    if (watcherEngine) return watcherEngine;
    watcherEngine = watchers ?? createStandingQueryEngine({
      store: bundle.watchers,
      ledger,
      engineState,
      now,
      publish,
      getSpendInWindow: async (windowMs) => {
        const perHour =
          budget && typeof budget.spendPerHourUsd === "function" ? await budget.spendPerHourUsd() : 0;
        return perHour * (windowMs / HOUR_MS);
      },
      getCapUsd: async () => {
        let cap = budgetAmbientCapUsd({});
        try {
          cap = budgetAmbientCapUsd((await configGet()) ?? {});
        } catch {
          /* keep default */
        }
        return cap;
      },
    });
    return watcherEngine;
  }

  // BET-1395 tool discovery (§7): lazy single instance over the shared tool
  // registry/usage stores + the A1 card machinery. `runEphemeral` is the
  // rate-gated LLM seam (wired by index.mjs) — the LLM fallback classification
  // rides the §3.3 ephemeral rate gate exactly like a digest compose. The
  // db/surface collection seams are injected (index.mjs supplies the live
  // opencodeDb read handle + config readers); defaults null → channels 2/3
  // contribute nothing, channel 1 (secret ledger) still fuses.
  function getTools({ backfillStartInstant = null } = {}) {
    if (toolEngine) return toolEngine;
    toolEngine =
      tools ??
      createToolRegistry({
        registryStore: bundle.toolRegistry,
        usageStore: bundle.toolUsage,
        cards,
        ledger,
        now,
        runEphemeral: toolsRunEphemeral ?? runEphemeral,
        collectDb: toolsCollectDb,
        collectSurfaces: toolsGetSurfaces,
        backfillStartInstant,
        recordVerdict: (input) => getVerdictsEngine().recordVerdict(input),
        // §7.5 BET-1396: the consent path authors the tool's probe-spec
        // template through the probes engine (late-bound — the probes engine
        // is constructed just below with THIS registry as its registry dep).
        scaffoldProbes: (toolId, opts) => getProbes().scaffoldSpec(toolId, opts),
      });
    getProbes();
    return toolEngine;
  }

  // §7.5 probe runner (BET-1396). Built lazily next to the registry it reads.
  // `toolsRunEphemeral` is the §3.3-gated classifier seam (the SAME gate the
  // registry's LLM fallback rides) — relevance's weekly nano score rides it
  // too, so an ungated ambient call path never exists. `isThrifty` reads the
  // engine's LIVE thrifty flag (the §12.2 shed ladder's rung 2).
  function getProbes() {
    if (probesEngine) return probesEngine;
    if (!tools && !toolEngine) getTools();
    if (!toolEngine) return null;
    probesEngine = createProbes({
      registry: toolEngine,
      stateStore: bundle.probeState,
      cards,
      ledger,
      now,
      isThrifty: () => thrifty,
      listProjects: () => getFactsEngine().listProjects(),
      getTopFacts: (project, k) => getFactsEngine().topFacts(project, { k }),
      getRollups: () => loadRecentDayRollups(7),
      resolveSegment: resolveSegmentProject,
      runEphemeral: toolsRunEphemeral ?? null,
    });
    return probesEngine;
  }

  // §7.6 relevance context (BET-1439): the probes runner receives the RAW
  // recent day-rollup payloads and projects them per project itself, using
  // this resolver to attribute each rollup bullet's leaf segment refs to
  // their project (the same mapper the day-level fact sync runs). Best-effort:
  // an unreadable segment attributes to nothing, which the runner treats as
  // the facts-only fallback.
  async function resolveSegmentProject(id) {
    try {
      const s = await bundle.segments.load(id);
      return s && s.project ? { project: s.project } : null;
    } catch {
      return null;
    }
  }

  // The §7.5 probe tick (BET-1396; template authoring BET-1438): fill still-
  // empty scaffolded probe specs (before the runner sees them, so consent →
  // fill → first probe can land inside one tick), then due probes + weekly
  // relevance, behind the master toggle, thrifty-shed, paused with the tick.
  async function probesTick() {
    const eng = getProbes();
    if (!eng) return;
    await eng.authorSpecs().catch(() => {});
    await eng.runDue().catch(() => {});
    await eng.relevanceScan().catch(() => {});
  }

  // §7.1-2: the daily batch's db seam — tool-call part rows in the scan
  // window, via the injected opencodeDb read handle (same async supplier the
  // backfill uses; a missing handle yields no rows, never a throw).
  async function toolsCollectDb({ sinceTs, untilTs, cap }) {
    if (typeof getDb !== "function") return [];
    const db = await getDb().catch(() => null);
    if (!db) return [];
    const { collectDbRows } = await import("./ctoToolScan.mjs");
    return collectDbRows(db, { sinceTs, untilTs, cap });
  }

  // The daily tool scan (§7.3): once per UTC day, inside the tick's enabled
  // gate. Restart-safe — the registry's own watermarks (lastScanTs/lastAskDay)
  // make a repeat scan idempotent and keep ask pacing ≤1/day durable. The
  // first scan after install runs over the cold-start backfill range
  // (engine-state backfillStartInstant), satisfying §7.1-2's "also runs over
  // the backfill range once".
  async function toolsTick() {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (lastToolScanDay === day) return;
    let backfillStartInstant = null;
    try {
      const es = (await engineState.load()) ?? {};
      if (Number.isFinite(es.backfillStartInstant)) backfillStartInstant = es.backfillStartInstant;
    } catch {
      /* best-effort — the registry falls back to its own 30-day window */
    }
    await getTools({ backfillStartInstant }).dailyScan();
    // Stamp the day only AFTER a successful scan — a failed scan retries on
    // the next tick instead of waiting until tomorrow (the registry's own
    // watermarks keep the retry idempotent).
    lastToolScanDay = day;
  }

  // Load the last `windowDays` (default 7, §13.4) day rollups so the watcher
  // auto-creator can scan them for recurring themes. Reverse-chron, already
  // oldest-first — the themes extractor filters by window start itself.
  async function loadRecentDayRollups(windowDays = 7) {
    const since = now() - windowDays * 24 * HOUR_MS;
    let names = [];
    try {
      names = await fsp.readdir(bundle.rollups.dirFor("day"));
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      let r;
      try {
        r = await bundle.rollups.load("day", name.slice(0, -5));
      } catch {
        continue;
      }
      if (r && Array.isArray(r?.window) && typeof r.window[0] === "number" && r.window[0] >= since) {
        out.push(r);
      }
    }
    out.sort((a, b) => a.window[0] - b.window[0]);
    return out;
  }

  // §13.4 "or the underlying fact archived": collect the normalized patterns of
  // superseded/archived facts so a watcher whose theme is archived retires.
  // Best-effort — an unreadable archive yields no signatures.
  async function archivedWatcherSignatures() {
    const out = new Set();
    try {
      const dir = bundle.factsArchive.dir;
      let names = [];
      if (typeof dir === "string" && dir) {
        names = (await fsp.readdir(dir).catch(() => [])) ?? [];
      }
      for (const name of names) {
        const project = String(name).endsWith(".json") ? String(name).slice(0, -5) : String(name);
        let p;
        try {
          p = await bundle.factsArchive.load(project);
        } catch {
          continue;
        }
        for (const f of Array.isArray(p?.entries) ? p.entries : []) {
          for (const sig of extractSignifiers(f?.statement)) {
            const norm = patternSignatureFor(sig);
            if (norm) out.add(norm);
          }
        }
      }
    } catch {
      /* best-effort */
    }
    return [...out];
  }

  // Watcher run growth per tick (enabled-gated, §13.4): evaluate the windowed
  // kinds (usage-burn) + retirement, and after a new day rollup has landed run
  // the auto-creation scan once per day (guarded by a day marker so it doesn't
  // re-run every tick). Best-effort — never throws into the poller.
  async function watcherTick() {
    try {
      const archivedSig = await archivedWatcherSignatures();
      await getWatchers().runTick({ archivedSignatures: archivedSig });
      const es = (await engineState.load()) ?? {};
      const lastAutoDay = es?.watchers?.lastAutoDay ?? null;
      const todayKey = budgetDayKey(now());
      if (lastAutoDay === todayKey) return;
      const dayRollups = await loadRecentDayRollups();
      const result = await getWatchers().autoCreate(dayRollups);
      // BET-1425: sub-key merge on `watchers` from the FRESH state — this key
      // is shared with ctoWatchers' migration marker, so a stale spread would
      // resurrect/clobber the other writer's marker.
      await patchEngineState(
        (fresh) => ({ watchers: { ...(fresh?.watchers || {}), lastAutoDay: todayKey } }),
        { engineState },
      );
      if (result.added.length > 0) {
        await ledgerLog({ kind: "watcher.auto_created", count: result.added.length, signatures: result.added.map((a) => a.patternSignature) });
      }
    } catch {
      /* watchers are best-effort — never take the engine down */
    }
  }

  // The facts sink (BET-1391 / §9.5): map verdict acceptance/rejection effects
  // on fact subjects back onto the fact sender's reliability counters — success
  // → confirmed, rejection → rejected. `open`/`expire` (importance/retention
  // effects only) never touch acceptance counters, matching the mapping table.
  // Best-effort (a reliability write failing never breaks verdict recording).
  function factsCounterSink(effects, entry) {
    if (entry?.subject?.type !== "fact") return;
    const sender = entry.subject.sender;
    if (sender == null) return;
    const delta = {};
    if (effects.success) delta.confirmed = 1;
    if (effects.rejection) delta.rejected = 1;
    if (!delta.confirmed && !delta.rejected) return;
    const fe = getFactsEngine();
    if (fe && typeof fe.noteReliability === "function") {
      void fe.noteReliability(sender, delta).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // BET-1419 — Overnight execution wiring (§11). The pure machine (window
  // state machine, portfolio scorer, execution contract) lives in
  // ctoOvernight.mjs; this block is the wiring: feed the machine each tick
  // (quiet trough from the profile, presence, candidates from the tonight
  // queue + watcher hits), dispatch the selected plan through the injected
  // delegate seams (actor "cto", sweepAllowance = window remaining, the §3.3
  // sub-cap of 2 enforced by beginDelegateJob), preempt everything on the
  // user's return (§11.6), and arm/fulfill/cancel the veto countdown card
  // (§10.3). Nothing runs unless the engine is enabled, the Overnight switch
  // is on (config `ctoOvernight`), the tier is High, and the scheduler
  // was injected.
  // ---------------------------------------------------------------------------

  const VETO_CARD_ID = "overnight:veto";
  // One-shot "run now instead" consent set by the veto card / tonight verb;
  // consumed by the next overnight tick.
  let pendingRunNow = false;

  async function overnightGate() {
    if (disposed || !overnight) return false;
    try {
      const cfg = (await configGet()) ?? {};
      if (cfg.ctoOvernight !== true) return false;
      return (await tierGet()) === "high";
    } catch {
      return false;
    }
  }

  // The §11.4 candidate sources this issue wires: accepted `queue-tonight`
  // entries (the tonight queue) + watcher-driven investigations (the standing
  // queries' hits). Queue entries carry the value/confidence captured at
  // accept time; watcher hits degrade to mid-lattice defaults.
  async function tonightQueueRows() {
    try {
      const es = (await engineState.load()) ?? {};
      return Array.isArray(es.tonightQueue) ? es.tonightQueue : [];
    } catch {
      return [];
    }
  }

  async function saveTonightQueueRows(rows) {
    // BET-1425: per-key RMW — the rows are the only key this writer owns.
    await patchEngineState({ tonightQueue: rows }, { engineState });
  }

  function queueCandidatesFromRows(rows) {
    const out = [];
    for (const t of Array.isArray(rows) ? rows : []) {
      if (!t || typeof t !== "object" || typeof t.id !== "string" || !t.id) continue;
      out.push({
        id: t.id,
        name: typeof t.name === "string" ? t.name : undefined,
        prompt: typeof t.prompt === "string" ? t.prompt : undefined,
        project: typeof t.project === "string" ? t.project : undefined,
        category: "queue-tonight",
        value: Number.isFinite(t.value) ? t.value : 1,
        confidence: Number.isFinite(t.confidence) ? t.confidence : 0.8,
        predictedCost: Number.isFinite(t.predictedCost) ? t.predictedCost : 1,
        refs: Array.isArray(t.refs) ? t.refs : [],
      });
    }
    return out;
  }

  function watcherCandidatesFromRows(rows) {
    const out = [];
    for (const hit of collectWatcherHitsFromLedger(rows)) {
      // BET-1472 (BET-1436 decision c): overnight candidacy REQUIRES a hosting
      // project. A project-less hit (usage-burn hits are box-wide; rows
      // predating BET-1428 lack the field) can never be hosted by §11.5
      // dispatch, so it is filtered at the source instead of producing a
      // candidate that gets re-skipped on every tick of the open window. The
      // B4 suggestion path is unaffected.
      if (typeof hit.project !== "string" || !hit.project) continue;
      out.push({
        id: hit.id,
        name: hit.text,
        category: "watcher",
        // BET-1428: the project whose evidence produced the hit — always a
        // non-empty string here because project-less hits are filtered above
        // (overnight candidacy requires a hosting project).
        project: hit.project,
        value: 2,
        confidence: 0.8,
        predictedCost: 1,
        refs: Array.isArray(hit.refs) ? hit.refs : [],
      });
    }
    return out;
  }

  // Read the running delegate jobs this engine may preempt (actor "cto" only).
  async function runningCtoJobs() {
    if (typeof listDelegateJobs !== "function") return [];
    try {
      const jobs = await listDelegateJobs();
      return (Array.isArray(jobs) ? jobs : []).filter(isRunningCtoRow);
    } catch {
      return [];
    }
  }

  // §11.6 preemption: pause every running CTO job, then close the window (or
  // clear an armed countdown). Best-effort — a failing pause seam must never
  // break the close; the delegate sweeper still drains a missed pause flag.
  async function preemptOvernight(reason) {
    for (const j of await runningCtoJobs()) {
      try {
        await pauseDelegateJob?.(j.id);
        await ledgerLog({ kind: "cto.overnight.preempt", jobId: j.id, reason });
      } catch {
        /* the sweeper still drains it; preemption is best-effort */
      }
    }
    if (!overnight) return;
    const t = now();
    await overnight
      .updateWindow((prev) =>
        prev
          ? normalizeWindow({
              ...normalizeWindow(prev),
              ...(prev.state === "open"
                ? { state: "closed", closedMs: t, closeReason: reason, pinnedOrder: null }
                : { countdown: null }),
            })
          : null,
      )
      .catch(() => {});
  }

  // Dispatch the selected plan (§11.5 execution contract). The §3.3 concurrent
  // delegate sub-cap (RATE_LIMITS.concurrentDelegate = 2) is enforced HERE, by
  // counting still-running cto-actor jobs (the same rows preemption reads) +
  // starts accepted in this dispatch against the cap — `beginDelegateJob`'s
  // transient tracker is not consulted on this path and the delegate engine
  // only enforces the box-wide cap of 5. Each start removes its queue entry (a
  // queued task that started is no longer queued); failures ledger and leave
  // the entry queued for the next tick/night. Candidates whose job already
  // started in this window are skipped (the ledger's job_started rows are the
  // dedupe record — a watcher hit stays in the ledger and would otherwise
  // re-run every tick of the same window). BET-1428: the same ledger records
  // the skip dedupe — a candidate whose dispatch already logged a skip row in
  // this window re-runs silently (a freed cap or a newly opened project
  // session can still start it), it just stops re-writing the row. Each
  // job_started row carries `estTokens` (the prompt-size estimate, §12.1
  // metering style) so the windowless night-cap bound can price tonight's
  // spend from the ledger.
  async function dispatchPlan({ plan, trough, projects, ledgerRows, windowOpenedMs }) {
    let started = 0;
    const inWindow = (r) =>
      typeof r?.ts === "number" && (windowOpenedMs == null ? true : r.ts >= windowOpenedMs);
    const startedIds = new Set(
      (Array.isArray(ledgerRows) ? ledgerRows : [])
        .filter((r) => r?.kind === "cto.overnight.job_started" && inWindow(r))
        .map((r) => r.id),
    );
    const skippedIds = new Set(
      (Array.isArray(ledgerRows) ? ledgerRows : [])
        .filter((r) => r?.kind === "cto.overnight.skip" && inWindow(r))
        .map((r) => r.id),
    );
    const runningCto = (await runningCtoJobs()).length;
    let startedThisDispatch = 0;
    for (const cand of plan?.selected ?? []) {
      try {
        if (!cand || typeof cand.id !== "string" || startedIds.has(cand.id)) continue;
        if (typeof startDelegateJob !== "function") break;
        if (runningCto + startedThisDispatch >= rateLimits.concurrentDelegate) {
          // BET-1428: one skip row per candidate per window — the retry stays
          // live (a freed slot starts it on a later tick), only the repeated
          // row is suppressed.
          if (!skippedIds.has(cand.id)) {
            await ledgerLog({
              kind: "cto.overnight.skip",
              id: cand.id,
              reason: "rate_limit:concurrentDelegate",
              running: runningCto + startedThisDispatch,
            });
          }
          continue;
        }
        const task = (await tonightQueueRows()).find((r) => r?.id === cand.id) ?? null;
        const project = cand.project ?? task?.project;
        const parent =
          typeof project === "string" && project ? resolveForgeOwner(projects, project) : null;
        if (!parent?.parentSessionID) {
          // BET-1426: an unresolvable project can never host the job — re-skip
          // per tick would pollute the ledger forever. When the project list
          // was READABLE (a null/throw is a transient read failure, not a
          // verdict) and the candidate is a queue row, remove the entry on the
          // first skip: one final skip row + a needs-you blocker. Rows queued
          // before the add-time validation are cleaned here too.
          if (Array.isArray(projects) && task) {
            const rows = await tonightQueueRows();
            await saveTonightQueueRows(rows.filter((r) => r?.id !== task.id));
            if (overnight) {
              await overnight
                .updateWindow((prev) =>
                  prev?.pinnedOrder?.length
                    ? normalizeWindow({ ...normalizeWindow(prev), pinnedOrder: prev.pinnedOrder.filter((pid) => pid !== task.id) })
                    : null,
                )
                .catch(() => {});
            }
            await ledgerLog({
              kind: "cto.overnight.skip",
              id: cand.id,
              reason: "no tracked project session to host the job — entry removed from tonight's queue",
              project,
              removed: true,
            });
            await recordBlocker(
              "overnight_queue",
              `Tonight task "${task.name ?? cand.id}" was removed — no tracked project session could host it.`,
            );
          } else {
            // BET-1428: a candidate with no queue row to remove (a watcher
            // hit) or no readable project list stays in play, but its skip row
            // is written once per window, not once per tick — the retry stays
            // live (a project session opened mid-window starts it), only the
            // repeated row is suppressed.
            if (!skippedIds.has(cand.id)) {
              await ledgerLog({
                kind: "cto.overnight.skip",
                id: cand.id,
                reason: "no tracked project session to host the job",
                project,
              });
            }
          }
          continue;
        }
        const prompt =
          cand.prompt ??
          task?.prompt ??
          `${cand.name ?? "overnight"} — investigate and report a draft summary with refs.`;
        const res = await startDelegateJob({
          name: cand.name ?? task?.name ?? `overnight:${cand.category}`,
          prompt,
          parentSessionID: parent.parentSessionID,
          parentDirectory: project,
          sweepAllowanceMs: trough ? Math.max(0, trough.endMs - now()) : undefined,
        });
        if (res?.ok === false) {
          // BET-1428: same per-window dedupe — the refusal is retried on the
          // next tick, only the repeated row is suppressed.
          if (!skippedIds.has(cand.id)) {
            await ledgerLog({ kind: "cto.overnight.skip", id: cand.id, reason: res.error ?? "delegate start refused", project });
          }
          continue;
        }
        started += 1;
        startedThisDispatch += 1;
        await ledgerLog({
          kind: "cto.overnight.job_started",
          id: cand.id,
          jobId: res?.job?.id ?? null,
          project,
          category: cand.category,
          estTokens: estimateTokens(prompt),
        });
        if (task) {
          const rows = await tonightQueueRows();
          await saveTonightQueueRows(rows.filter((r) => r?.id !== task.id));
        }
      } catch {
        /* keep dispatching the remaining selected jobs */
      }
    }
    return started;
  }

  // §9.2 veto card: armed once per imminent window (trough start − 30 min),
  // fulfilled by its own open, canceled by the user, abandoned when it
  // elapses unmet (the machine already ledgers the abandon on tick).
  async function overnightVetoCard({ trough, candidateCount }) {
    if (!overnight || !cards || typeof cards.upsertVeto !== "function") return;
    const t = now();
    const win = await overnight.readWindow();
    if (!win) return;
    const due = trough ? trough.startMs : null;
    const imminent = due != null && t >= due - VETO_LEAD_MS && t < due;
    // §9.2: never re-announce a trough the user vetoed — the stamp from
    // tonightCancel suppresses both the countdown re-arm and the card.
    const vetoed = win.vetoedTroughStartMs != null && win.vetoedTroughStartMs === due;
    if (imminent && win.state !== "open" && !win.countdown && !vetoed && candidateCount > 0) {
      await overnight
        .updateWindow((prev) => scheduleCountdown(prev, { now: t, dueMs: due }))
        .catch(() => {});
      const tasks = (await tonightQueueRows()).filter((r) => r && typeof r.id === "string");
      await cards
        .upsertVeto({
          id: VETO_CARD_ID,
          title: "Overnight run planned",
          body: `The CTO queued ${tasks.length} task${tasks.length === 1 ? "" : "s"} for tonight's window. It runs unattended unless you cancel.`,
          dueMs: due,
          options: [
            { label: "Cancel tonight", action: { type: "veto-cancel", payload: {} } },
            { label: "Edit plan", action: { type: "veto-edit", payload: {} } },
            { label: "Run now instead", action: { type: "veto-run-now", payload: {} } },
          ],
        })
        .catch(() => {});
      await ledgerLog({ kind: "cto.overnight.veto_card", dueMs: due, tasks: tasks.length });
      return;
    }
    if (win.state === "open" || !imminent) {
      // Fulfilled (its own open cleared the countdown), canceled, or long
      // gone: resolve any still-open veto card so the countdown cannot linger
      // (§10.3 liveness).
      const open = (await cards.listOpen().catch(() => [])) ?? [];
      const stale = open.find((c) => c?.id === VETO_CARD_ID && c?.variant === "veto");
      if (stale) {
        const fulfilled = win.state === "open" && win.countdown == null;
        await cards.resolveById(stale.id, { reason: fulfilled ? "window opened" : "countdown elapsed unmet" }).catch(() => {});
        if (fulfilled) {
          // BET-1403 §9.4: the announced window elapsed UNcancelled and the
          // overnight run opened — the veto-window record's acceptance, feeding
          // the veto→act promotion bar under the canonical action class.
          void getTrust().noteVetoOutcome("queue-tonight", { accepted: true }).catch(() => {});
        }
      }
    }
  }

  // The overnight slice of the engine tick. Gated like every other work
  // branch; every step is best-effort — the machine's ledger rows record what
  // actually happened (§14.5), and this block never throws into the poller.
  async function overnightTick() {
    if (!(await overnightGate())) return;
    const t = now();
    const presence = getPresence().state;
    const hasDesktop = getLastDesktopHeartbeat() > 0;
    const lastUserEventMs = promptTs > 0 ? promptTs : null;
    const trough = typeof profile?.getQuietTrough === "function" ? profile.getQuietTrough() : null;
    const runNow = pendingRunNow;
    pendingRunNow = false;
    let recentLedger = [];
    try {
      // BET-1466: every consumer below looks at the last 24h at most (the
      // watcher candidates; dispatchPlan at rows since the window opened) —
      // request the bounded range instead of reading the whole ledger file.
      recentLedger = (await ledger.read({ from: t - 24 * HOUR_MS })) ?? [];
    } catch {
      recentLedger = [];
    }
    const candidates = [
      ...queueCandidatesFromRows(await tonightQueueRows()),
      ...watcherCandidatesFromRows(recentLedger),
      // §7.6 (BET-1404): data-source analyses — one per deep-consented tool
      // at argmax relevance, p_use = ewma × max(relevance). Best-effort: a
      // registry hiccup must never take the overnight tick down.
      ...await (async () => {
        try {
          return dataAnalysisCandidatesFromTools(await getTools().listTools());
        } catch {
          return [];
        }
      })(),
    ];
    let out = null;
    try {
      out = await overnight.tick({
        now: t,
        trough,
        presence,
        hasDesktop,
        lastUserEventMs,
        runNow,
        candidates,
      });
    } catch {
      return; // the persisted window state is authoritative; skip this tick
    }
    if (Array.isArray(out?.ledgerRows) && out.ledgerRows.length) {
      for (const row of out.ledgerRows) {
        await ledgerLog({ ...row, ts: row?.ts ?? t }).catch(() => {});
      }
      // A fold that just closed the window also released the §11.6 preemption
      // (presence return / fresh user event) — the delegate jobs need the
      // pause flag set now, not on the next tick.
      if (out.ledgerRows.some((r) => r?.kind === "cto.overnight.close" && r?.reason !== "trough-end")) {
        await preemptOvernight("user-return");
      }
    }
    const win = out?.window ?? null;
    if (win?.state === "open" && out.plan?.selected?.length) {
      let projects = null;
      try {
        projects = await listProjects();
      } catch {
        projects = null;
      }
      await dispatchPlan({
        plan: out.plan,
        trough,
        projects,
        ledgerRows: recentLedger,
        windowOpenedMs: win.openedMs,
      }).catch(() => {});
    }
    await overnightVetoCard({ trough, candidateCount: candidates.length }).catch(() => {});
    await syncState().catch(() => {});
  }

  // ---- Tonight verbs (§10.4 drill-down + §9.2 veto card actions) ----------

  // List the queue + the current window state for the Tonight drill-down.
  async function tonightList() {
    const tasks = await tonightQueueRows();
    const win = overnight ? await overnight.readWindow().catch(() => null) : null;
    return { tasks, window: win };
  }

  // A project can host an overnight job only when one of its windows carries
  // a live opencode session — the same shape resolveForgeOwner returns an
  // owner for (BET-1426 add-time validation + dispatch backstop).
  function hostableProjects(projects) {
    if (!Array.isArray(projects)) return [];
    return projects.filter(
      (p) =>
        Array.isArray(p?.windows) &&
        p.windows.some((w) => typeof w?.opencodeSessionId === "string" && w.opencodeSessionId),
    );
  }

  // Queue a task for tonight (the `queue-tonight` decision-card option
  // executor). Gated: engine enabled, High tier, Overnight switch, injected
  // scheduler. A 13th add is refused with a note (never silent truncation).
  // BET-1426: the task's project is resolved HERE, at add time — both add
  // paths (renderer ask, act executor) funnel into this one point, so the
  // queue only ever holds rows the §11.5 dispatch can host. A payload without
  // a resolvable project auto-resolves to the single tracked project session
  // when there is exactly one (noted in the ack + ledger row) and is refused
  // otherwise — an unresolvable row would otherwise skip on every overnight
  // tick forever.
  async function tonightAdd(task = {}) {
    if (!(await overnightGate())) return { ok: false, error: "overnight is not enabled (High tier + Overnight switch)" };
    const name = typeof task.name === "string" ? task.name.trim() : "";
    if (!name) return { ok: false, error: "name is required" };
    const rows = await tonightQueueRows();
    if (rows.length >= TONIGHT_QUEUE_MAX) {
      return { ok: false, error: `tonight's queue is full (${TONIGHT_QUEUE_MAX}) — cancel or edit first` };
    }
    let project = typeof task.project === "string" && task.project ? task.project : null;
    let projectResolved = "explicit";
    let projects = null;
    if (typeof listProjects === "function") {
      try {
        projects = await listProjects();
      } catch {
        projects = null;
      }
    }
    if (!Array.isArray(projects)) {
      return { ok: false, error: "cannot verify the task's project (project list unavailable) — try again" };
    }
    if (project) {
      const owner = resolveForgeOwner(projects, project);
      if (owner?.parentSessionID) {
        // Canonicalize to the owning project's directory so the row keeps
        // resolving by exact match even when window paths churn.
        if (owner.defaultCwd) project = owner.defaultCwd;
      } else {
        project = null; // named but unresolvable → fall through to auto/refuse
      }
    }
    if (!project) {
      const hostable = hostableProjects(projects);
      if (hostable.length === 1) {
        project = typeof hostable[0].defaultCwd === "string" && hostable[0].defaultCwd ? hostable[0].defaultCwd : null;
        if (!project) return { ok: false, error: "the only tracked project session has no project directory to host the task" };
        projectResolved = "auto";
      } else if (hostable.length === 0) {
        return { ok: false, error: "no tracked project session to host the task — open a project session first" };
      } else {
        return { ok: false, error: "no resolvable project for the task — name one of the open project sessions" };
      }
    }
    const entry = {
      id: `tq:${nextId()}`,
      name: name.slice(0, 200),
      prompt: typeof task.prompt === "string" && task.prompt.trim() ? task.prompt.trim() : name,
      project,
      value: Number.isFinite(task.value) ? task.value : 1,
      confidence: Number.isFinite(task.confidence) ? task.confidence : 0.8,
      predictedCost: Number.isFinite(task.predictedCost) ? task.predictedCost : 1,
      refs: Array.isArray(task.refs) ? task.refs : [],
      cls: typeof task.cls === "string" ? task.cls : "queue-tonight",
      originId: typeof task.originId === "string" ? task.originId : null,
      addedMs: now(),
    };
    await saveTonightQueueRows([...rows, entry]);
    await ledgerLog({ kind: "cto.overnight.queue_add", id: entry.id, name: entry.name, project: entry.project, resolved: projectResolved });
    await syncState().catch(() => {});
    return { ok: true, task: entry, projectResolved };
  }

  // Remove one task (a Tonight drill-down edit — itself a verdict, §10.4).
  async function tonightRemove(id) {
    if (typeof id !== "string" || !id) return { ok: false, error: "id is required" };
    const rows = await tonightQueueRows();
    const next = rows.filter((r) => r?.id !== id);
    if (next.length === rows.length) return { ok: false, error: "not found" };
    await saveTonightQueueRows(next);
    // Drop the task from a pinned order too — a removed task can no longer
    // pin a slot.
    if (overnight) {
      await overnight
        .updateWindow((prev) =>
          prev?.pinnedOrder?.length
            ? normalizeWindow({ ...normalizeWindow(prev), pinnedOrder: prev.pinnedOrder.filter((pid) => pid !== id) })
            : null,
        )
        .catch(() => {});
    }
    const removed = rows.find((r) => r?.id === id);
    await ledgerLog({ kind: "cto.overnight.queue_edit", edit: "remove", id });
    void getVerdictsEngine()
      .recordVerdict({
        subject: { type: "suggestion", id: removed?.originId ?? id, class: "queue-tonight" },
        verdict: "edit",
      })
      .catch(() => {});
    await syncState().catch(() => {});
    return { ok: true };
  }

  // Reorder the queue — PINS the order for the current window (exempt from
  // the 30-min re-scoring; cleared again when the window closes, §10.4).
  async function tonightReorder(ids) {
    if (!Array.isArray(ids)) return { ok: false, error: "ids array is required" };
    if (!overnight) return { ok: false, error: "overnight is not enabled" };
    const rows = await tonightQueueRows();
    const known = new Set(rows.map((r) => r?.id).filter(Boolean));
    const pinned = ids.filter((i) => typeof i === "string" && known.has(i));
    if (pinned.length === 0) return { ok: false, error: "no known task ids in order" };
    await overnight
      .updateWindow((prev) => normalizeWindow({ ...normalizeWindow(prev), pinnedOrder: pinned }))
      .catch(() => {});
    await ledgerLog({ kind: "cto.overnight.queue_edit", edit: "reorder", order: pinned });
    void getVerdictsEngine()
      .recordVerdict({
        subject: { type: "suggestion", id: rows.find((r) => r?.id === pinned[0])?.originId ?? pinned[0], class: "queue-tonight" },
        verdict: "edit",
      })
      .catch(() => {});
    return { ok: true, pinned };
  }

  // Cancel tonight (veto card "Cancel tonight" / drill-down "Cancel tonight").
  // Pauses running CTO jobs + closes the window (or clears the countdown),
  // resolves the veto card, records the §9.5 veto verdict. The window row
  // keeps `vetoedTroughStartMs` = the current trough's start so the machine's
  // open path refuses to auto-open this trough again — a veto is a veto, not a
  // countdown reset. The stamp is per-trough: the next trough has a different
  // startMs, so it never suppresses a later night (and run-now overrides it).
  async function tonightCancel() {
    const trough = typeof profile?.getQuietTrough === "function" ? profile.getQuietTrough() : null;
    await preemptOvernight("veto");
    if (overnight) {
      await overnight
        .updateWindow((prev) =>
          prev
            ? normalizeWindow({
                ...normalizeWindow(prev),
                ...(trough?.startMs != null ? { vetoedTroughStartMs: trough.startMs } : {}),
                countdown: null,
              })
            : null,
        )
        .catch(() => {});
    }
    const open = (await cards.listOpen().catch(() => [])) ?? [];
    const stale = open.find((c) => c?.id === VETO_CARD_ID && c?.variant === "veto");
    if (stale) await cards.resolveById(stale.id, { reason: "canceled by user" }).catch(() => {});
    await ledgerLog({ kind: "cto.overnight.veto", ts: now() });
    // BET-1403 §9.4: a cancel IS the veto-window record's rejection. The
    // canonical action class is "queue-tonight" (the §9.3 eligibility map's
    // class — the overnight veto window guards tonight's queued tasks); the
    // UI's veto-verdict subject carries the same stamp. Single writer: the
    // trust sink ignores veto-window subjects, so the record is fed exactly
    // once per resolved window (cancel here, executed-open in the veto card).
    void getVerdictsEngine()
      .recordVerdict({ subject: { type: "veto-window", id: VETO_CARD_ID, class: "queue-tonight" }, verdict: "veto" })
      .catch(() => {});
    void getTrust().noteVetoOutcome("queue-tonight", { accepted: false }).catch(() => {});
    await syncState().catch(() => {});
    return { ok: true };
  }

  // "Run now instead" (§9.2): one-shot consent the next overnight tick
  // consumes — it opens the window even outside the trough (the machine's
  // `runNow` branch; zero candidates still opens nothing, §11.4).
  async function tonightRunNow() {
    if (!(await overnightGate())) return { ok: false, error: "overnight is not enabled (High tier + Overnight switch)" };
    pendingRunNow = true;
    await ledgerLog({ kind: "cto.overnight.run_now", ts: now() });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------

  // Pump the blackboard proposal queue (per-project, single writer). Driven
  // from the tick when enabled; best-effort, never throws into the poller.
  async function pumpFacts() {
    try {
      await getFactsEngine().pump();
    } catch {
      /* facts are best-effort — never take the engine down */
    }
  }

  // Fold any closed windows into rollups (respecting enabled/paused via the
  // tick's gate, and preempting the batch between calls when the user is
  // present). Advances the persisted cursor only across windows actually
  // finalized, so a preempted batch re-runs the remainder next tick. Never
  // throws into the poller.
  async function finalizeRollups() {
    try {
      const runner = getRollupRunner();
      if (!runner) return;
      const payload = (await engineState.load()) || {};
      const cursor = { ...(payload.rollupCursor ?? {}) };
      // BET-1425: per-level cursor deltas, saved per-key at the end — the old
      // shape spread the whole load-time `payload` back after minutes of
      // rollup processing, resurrecting every other writer's keys.
      const cursorUpdates = {};
      const t = now();
      let cursorInit = false;
      for (const level of ROLLUP_LEVELS) {
        if (cursor[level] == null) {
          cursor[level] = rollupWindowFor(level, t)[0];
          cursorUpdates[level] = cursor[level];
          cursorInit = true;
        }
      }
      let changed = cursorInit;
      // BET-1388 §12.2 rung 4: shed hourly rollups while thrifty (§10.6-6).
      const shedHourly = thrifty;
      for (const level of ROLLUP_LEVELS) {
        const duration = ROLLUP_LEVEL_MS[level];
        let start = cursor[level];
        const list = [];
        let guard = 0;
        while (start + duration <= t && guard < 2000) {
          list.push(rollupWindowFor(level, start));
          start += duration;
          guard += 1;
        }
        if (list.length === 0) continue;
        if (shedHourly && level === "hour") {
          // No hour reduces while thrifty; advance the cursor across the closed
          // windows so they are never re-attempted later. The next DAY reduce
          // reconstructs the missing hours from segments (ctoRollups).
          cursor[level] = list[list.length - 1].window[1];
          cursorUpdates[level] = cursor[level];
          changed = true;
          continue;
        }
        const outcomes = await runner.processDue(list.map((w) => ({ level, window: w })));
        if (outcomes && outcomes.length > 0) {
          const next = outcomes[outcomes.length - 1].window[1];
          if (next > cursor[level]) {
            cursor[level] = next;
            cursorUpdates[level] = cursor[level];
            changed = true;
          }
        }
      }
      if (changed) {
        await patchEngineState(
          (fresh) => ({ rollupCursor: { ...(fresh?.rollupCursor || {}), ...cursorUpdates } }),
          { engineState },
        );
      }
      // BET-1397 breakpoint drain (rollup close): fold unread inbox notes into
      // evidence. Best-effort — never blocks or breaks the rollup fold.
      await drainInbox();
    } catch {
      /* rollups are best-effort — never take the engine down */
    }
  }

  // Lazy-construct the cold-start backfill (§10.6-4). Mirrors the rollup/facts
  // pattern: degenerate to the real store-backed module; tests inject an
  // override. The backfill governs its own one-time spend bound + batch-priority
  // (presence) internally and NEVER touches the engine's §3.3 rate tracker.
  function getBackfill() {
    if (builtInBackfill) return builtInBackfill;
    builtInBackfill = backfill ?? createCtoBackfill({
      configGet,
      engineState,
      ledger,
      segments: bundle.segments,
      rollups: bundle.rollups,
      summarize, // raw seam — the backfill owns its own budget, no rate gate
      computeOneLiner,
      runEphemeral: backfillRunEphemeral,
      getDb: getDb ?? (async () => null),
      presenceCheck: () => engine.getPresence().state === "present",
      now,
    });
    return builtInBackfill;
  }

  // One incremental backfill batch per tick (segments/rollups), oldest-first,
  // batch-priority. Once-per-box is enforced by the module's engine-state
  // marker. Never throws into the poller.
  async function backfillStep() {
    try {
      await getBackfill().step();
    } catch {
      /* backfill is best-effort — never take the engine down */
    }
  }

  // BET-1397 inbox drain (§4.4): at breakpoints (rollup close; digest /
  // overnight planning land with later issues and hook the same method) every
  // UNREAD inbox note becomes a high-salience evidence event on the A1 ledger,
  // weighted by the B1 sender-reliability (Beta mean) of the sending session,
  // and is then marked read. Inbox content rides as untrusted data — it is
  // written verbatim to the ledger, never treated as instructions. Silent:
  // expired entries are dropped (`purgeExpiredInbox`) with no trace.
  async function drainInbox() {
    try {
      const store = inbox ?? bundle.inbox;
      let drained = 0;
      // BET-1492: the mark-read (and the expired-only rewrite) is ONE
      // patchStore read-derive-write section — the old unlocked
      // load-spread-save could revert a note appended (or a read flag
      // flipped) between the drain's load and its save. An empty patch is a
      // pure no-op: no save when nothing expired and nothing unread.
      await patchStore(store, async (payload) => {
        const entries = Array.isArray(payload?.entries) ? payload.entries : [];
        if (entries.length === 0) return {};
        const { keep } = purgeExpiredInbox(entries, { nowMs: now() });
        const unread = keep.filter((e) => !e?.read);
        if (unread.length === 0) {
          return keep.length === entries.length ? {} : { entries: keep };
        }
        // Per-sender reliability (Beta mean, §6.4 / B1); unseen senders default
        // to neutral (1).
        let rel = {};
        try {
          rel = (await getFactsEngine().getState())?.senderReliability ?? {};
        } catch {
          rel = {};
        }
        drained = unread.length;
        return {
          entries: keep.map((e) => {
            if (e?.read) return e;
            const weight = senderReliability(rel[senderKey(e?.sender)] ?? {});
            const refs = Array.isArray(e?.refs) ? e.refs.slice() : [];
            if (e?.sender?.sessionID) refs.push(e.sender.sessionID);
            void ledgerLog({
              channel: CHANNEL_EVENT,
              sessionID: e?.sender?.sessionID ?? undefined,
              kind: `inbox.${e?.kind ?? "note"}`,
              salience: "high",
              senderReliability: weight,
              refs,
              message: e?.message,
              tag: e?.tag,
            });
            return { ...e, read: true };
          }),
        };
      });
      return { drained };
    } catch {
      /* inbox drain is best-effort — never takes the engine down */
      return { drained: 0 };
    }
  }

  // BET-1516 (§9.1): the pending-findings drain — the "blockers enter the
  // pipeline on the next engine tick (≤ 1 min)" half. The card tick calls
  // this every pass (it runs even while paused, so a blocker reported to a
  // paused engine still enters the pipeline within a minute); the
  // notification itself stays the funnel's immediate path (separate timer).
  //
  // Each queued finding becomes a high-salience evidence row on the A1
  // ledger — for inbox notes byte-shape-identical to what the breakpoint
  // drain (drainInbox) writes — and the source inbox note is marked read so
  // the breakpoint drain never double-folds it. Ordering: the ledger rows +
  // queue clear commit in ONE patch first (the queue row is the recovery
  // marker — a crash before the clear re-drains next tick), then the inbox
  // mark-read lands. Never orphaned, at worst a duplicated evidence row.
  async function drainFindings() {
    const store = findings ?? bundle.findings;
    if (!store) return { drained: 0, rows: [] };
    try {
      let drained = 0;
      const noteIds = [];
      // BET-1517: the drained rows feed the triage stage (one model call per
      // finding, plans.json) right after this patch commits.
      const drainedRows = [];
      // 1) Ledger rows + clear the queue in ONE patch (crash-safe: rows fire
      // before the clear commits, so a crash can only duplicate — converge on
      // the next tick).
      await patchStore(store, async (fresh) => {
        const rows = Array.isArray(fresh?.findings) ? fresh.findings : [];
        if (rows.length === 0) return {};
        drained = rows.length;
        drainedRows.push(...rows);
        // Per-sender reliability (Beta mean, §6.4 / B1); unseen senders
        // default to neutral (1) — the same weighting drainInbox applies.
        let rel = {};
        try {
          rel = (await getFactsEngine().getState())?.senderReliability ?? {};
        } catch {
          rel = {};
        }
        for (const row of rows) {
          const senderSessionID = row?.sender?.sessionID ?? row?.sessionID ?? undefined;
          const weight = senderReliability(
            rel[senderKey(row?.sender ?? { sessionID: senderSessionID })] ?? {},
          );
          const refs = Array.isArray(row?.refs) ? row.refs.slice() : [];
          if (senderSessionID) refs.push(senderSessionID);
          void ledgerLog({
            channel: CHANNEL_EVENT,
            sessionID: senderSessionID ?? undefined,
            kind: row?.source === "ask" ? `ask.${row?.sourceKind ?? "blocker"}` : `inbox.${row?.noteKind ?? "blocker"}`,
            salience: "high",
            senderReliability: weight,
            refs,
            message: row?.message,
            tag: row?.tag,
          });
          if (row?.source === "inbox" && typeof row?.noteId === "string") noteIds.push(row.noteId);
        }
        return { findings: [] };
      });
      // 2) Mark the source notes read (dedupe guard against drainInbox).
      // AFTER the ledger patch above, so this never orphans a finding: a
      // crash before the clear commits just re-drains the queue next tick.
      if (noteIds.length) {
        await patchStore(inbox ?? bundle.inbox, (fresh) => {
          const entries = Array.isArray(fresh?.entries) ? fresh.entries : [];
          const idSet = new Set(noteIds);
          let touched = false;
          const next = entries.map((e) => {
            if (e && !e.read && idSet.has(e.id)) {
              touched = true;
              return { ...e, read: true };
            }
            return e;
          });
          return touched ? { entries: next } : {};
        });
      }
      return { drained, rows: drainedRows };
    } catch {
      /* findings drain is best-effort — never takes the engine down */
      return { drained: 0, rows: [] };
    }
  }

  // BET-1517: lazy triage engine (§9.1/§9.2). The model seam is the engine's
  // own gatedRunEphemeral, so every triage call rides the §12.1 ambient-cap
  // check + §3.3 rate gate + spend metering; a null runEphemeral gates
  // everything out (no plans, no spend).
  let triageEngine = null;
  function getTriage() {
    if (triageEngine) return triageEngine;
    triageEngine =
      triage ??
      createCtoTriage({
        plans: plans ?? bundle.plans,
        ledger,
        runEphemeral: runEphemeral ? gatedRunEphemeral : null,
        now,
      });
    return triageEngine;
  }

  // §9.2 blocker-triage context pieces: the sender session's transcript tail
  // (engine-level getTranscriptTail dep, ≤ 2k tokens enforced by the caller in
  // index.mjs), the sender project's top facts, and the B1 sender reliability.
  // Everything is best-effort — a missing piece just drops its block.
  async function buildTriageCtx(finding) {
    const ctx = {};
    const senderSessionID = finding?.sender?.sessionID ?? finding?.sessionID;
    if (typeof senderSessionID !== "string" || !senderSessionID) return ctx;
    if (getTranscriptTail) {
      try {
        const tail = await getTranscriptTail(senderSessionID);
        if (typeof tail === "string" && tail.trim()) ctx.transcriptTail = tail;
      } catch {
        /* best-effort */
      }
    }
    try {
      const info = await getSessionInfo(senderSessionID);
      const project = info?.project;
      if (project) {
        try {
          const facts = await getFactsEngine().topFacts(project, { k: 8 });
          const block = formatFactsBlock(facts, { nowMs: now() });
          if (block?.text) ctx.factsBlock = block.text;
        } catch {
          /* best-effort */
        }
      }
    } catch {
      /* best-effort */
    }
    try {
      const rel = (await getFactsEngine().getState())?.senderReliability ?? {};
      ctx.reliability = senderReliability(rel[senderKey(finding?.sender ?? { sessionID: senderSessionID })] ?? {});
    } catch {
      /* best-effort */
    }
    return ctx;
  }

  // §9.1 triage over the drain's rows — the engine-tick wire into the plans
  // store. Thrifty shed ladder (§12.2): finding triage sheds FIRST; blocker
  // triage (inbox notes) is kept to the last token. One triage call per
  // finding per tick; never throws into the card tick.
  async function triageDrained(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return { triaged: 0, shed: 0 };
    let triaged = 0;
    let shed = 0;
    for (const row of rows) {
      const isBlockerFinding = row?.source === "inbox";
      if (thrifty && !isBlockerFinding) {
        shed += 1;
        continue;
      }
      try {
        const ctx = await buildTriageCtx(row);
        const res = await getTriage().triageFinding(row, ctx);
        if (res?.ok) triaged += 1;
      } catch {
        /* best-effort */
      }
    }
    return { triaged, shed };
  }

  // Event ingestion — the ONE thing that keeps running while paused (§10.6-5).
  // Driven from index.mjs's event pump (not a timer); the engine is just
  // another consumer (§4.1). Consumes the opencode stream into normalized
  // evidence rows appended to the A1 ledger (deduped, pipeline-scoped), and
  // stamps prompt activity for presence. Deterministic — never throws into
  // the pump.
  function observeEvent(evt) {
    if (disposed) return;
    heartbeatAt = now();
    if (!evt || typeof evt !== "object") return;
    // Presence (§5.4): a user prompt submission proves the user is at the desk.
    if (isUserPromptEvent(evt)) {
      const t = now();
      if (t > promptTs) promptTs = t;
      // §11.6 preemption on the user's return: an open overnight window closes
      // and its running CTO jobs are paused at their next tool-call boundary —
      // immediately, not at the next tick. Fire-and-forget; the next tick's
      // evaluateWindow would reach the same close regardless.
      void preemptOvernight("user-return").catch(() => {});
    }
    // The SAME opencode event arrives on both the global and the per-directory
    // scoped stream — fold the duplicate so it counts once.
    const id = evt?.id;
    if (typeof id === "string" && id && seen.seen(id)) return;
    // Evidence append is best-effort I/O; never let it throw into the pump.
    void (async () => {
      try {
        let owner = "user";
        let project;
        const sid = eventSessionID(evt);
        if (sid) {
          const info = await getSessionInfo(sid);
          owner = info?.owner ?? "user";
          project = info?.project;
        }
        // A6 segmentation — feed pipeline (user|job) sessions into the
        // segmenter's online state machine. Never throws into the pump;
        // G refit / summaries happen on their own async paths.
        if (segmenter && sid && isPipelineSession(owner)) {
          try {
            segmenter.observe(evt, { sessionID: sid, project, ts: now() });
          } catch {
            /* best-effort — segmentation must never break ingestion */
          }
        }
        // §8.2 profile feed — deterministic per-event temporal/interaction
        // evidence. Best-effort; profile updates never throw into the pump.
        try {
          const k = segmentEventKind(evt);
          if (k) getProfile().observeEvent({ kind: k, ts: now(), project });
        } catch {
          /* best-effort — profile must never break ingestion */
        }
        const row = normalizeEvidence(evt, { owner, project, now: now() });
        if (!row) return;
        await ledgerLog({
          channel: CHANNEL_EVENT,
          sessionID: row.sessionID,
          project: row.project,
          kind: row.kind,
          salience: row.salience,
          refs: row.refs,
          ...(row.text ? { text: row.text } : {}),
        });
        // §4.3/§13.4 standing-query watchers: evaluate the standing queries
        // against this evidence event. Event-driven (NOT a poll loop); a match
        // becomes a high-salience `watcher.hit` evidence event + B4 source.
        // Fire-and-forget — a watcher must never break ingestion into the pump.
        void getWatchers()
          .evaluateEvent(row)
          .catch(() => {});
      } catch {
        /* best-effort, never throw into the pump */
      }
    })();
    // BET-1382 blocker-card wiring: the same events that already produced an
    // IMMEDIATE blocking-tier notification (the router in push.mjs, untouched)
    // feed the card machinery — a question/permission ask registers a pending
    // blocker that the card timer promotes into a card at > 10 min; an answer
    // / rejection / abort clears it and resolves the card (liveness §10.3).
    // No notification is fired here; the card is the only new artifact.
    const askStart = askStartInfo(evt);
    if (askStart && askStart.sessionID) {
      void cards
        .onAskStart({
          sourceKind: askStart.sourceKind,
          sourceId: askStart.sourceId,
          sessionID: askStart.sessionID,
          body: askQuestionText(evt),
          ts: now(),
        })
        .catch(() => {});
    } else if (isAskResolveEvent(evt)) {
      const info = askResolveInfo(evt);
      if (info?.sessionID) {
        void cards
          .onAskResolved({ sessionID: info.sessionID, ts: now() })
          .then((r) => (r?.changed ? syncState() : null))
          .catch(() => {});
      }
    } else if (evt?.type === "session.deleted") {
      // A blocked session being deleted is an abort — the ask can never be
      // answered, so the card resolves.
      const sid = eventSessionID(evt);
      if (sid) {
        void cards
          .onAskResolved({ sessionID: sid, ts: now() })
          .then((r) => (r?.changed ? syncState() : null))
          .catch(() => {});
      }
    }
  }

  // Presence/absence (§5.4): current state + lastSeen + how long the user has
  // been absent (now − lastSeen). Desktop heartbeat is read live; prompts come
  // from observedEvent stamping. Exposed to later pipeline consumers.
  //
  // D6 app-open note: "app open/focus events" are a named last_seen input, but
  // there is no timestamped app-open event source on the box today, and on a
  // desktop box the 30s presence heartbeat already proves the app is running —
  // an app-open signal would be subsumed by it. So lastSeen is fed by the
  // desktop heartbeat (desktop boxes) + user prompt submissions (proves the
  // user is here on any box). computeLastSeen still accepts appOpenTs, so a
  // real app-open producer can be added without touching this contract.
  function getPresence() {
    const t = now();
    const desktop = getDesktopPresence();
    const lastSeen = computeLastSeen({
      desktopHeartbeatTs: getLastDesktopHeartbeat(),
      promptTs,
    });
    return {
      state: presenceState({ heartbeats: desktop, lastSeen, now: t }),
      lastSeen,
      absenceDelta: Math.max(0, t - lastSeen),
    };
  }

  async function start() {
    if (disposed) throw new Error("cto engine already disposed");
    // BET-1407: restart resilience — rebuild the in-flight ask registry from
    // its persisted half (engine-state.json `pendingAsks`) BEFORE the first
    // card tick, so an ask that crossed the 10-min card threshold while the
    // box was down still promotes instead of being lost. Same seam guard as
    // segmenter.boot — a test-injected cards fake without the seed stays
    // valid. Best-effort: a failed seed degrades to a fresh registry.
    if (typeof cards?.seedPendingAsks === "function") {
      try {
        await cards.seedPendingAsks();
      } catch {
        /* best-effort */
      }
    }
    // BET-1498: one-time prune of the pre-BET-1469 contentless open cards in
    // cards.json — the §10.3-invisible rows BET-1476's badge filter stopped
    // counting but nothing can ever resolve or dismiss. Marker-guarded
    // (idempotent) and best-effort, exactly like the seed above: a failed
    // prune degrades to the BET-1476 status quo (invisible, uncounted rows)
    // and retries on the next boot. Same seam guard — a test-injected cards
    // fake without the method stays valid.
    if (typeof cards?.pruneLegacyOpenCards === "function") {
      try {
        await cards.pruneLegacyOpenCards();
      } catch {
        /* best-effort */
      }
    }
    // BET-1516: one-time prune of the orphaned `concurrentEphemeral` health
    // card + its shed pendingBlockers entries (BET-1513 stopped the trips from
    // carding; the residue re-upserted itself every tick). Same marker-guarded
    // best-effort contract as the prune above.
    if (typeof cards?.pruneOrphanedShedCards === "function") {
      try {
        await cards.pruneOrphanedShedCards();
      } catch {
        /* best-effort */
      }
    }
    // Load the persisted segmentation G (minutes) from engine-state (§5.1-d).
    if (segmenter && typeof segmenter.boot === "function") {
      void segmenter.boot().catch(() => {});
    }
    // Load the persisted profile (§8.1) — deterministic, lazy, best-effort.
    void getProfile().init().catch(() => {});
    // BET-1398: one-time migration of the superseded cto.json watcher poller's
    // watches into the standing-query engine (idempotent — a marker in
    // engine-state.json makes a re-deploy a no-op). Best-effort.
    if (typeof legacyWatchesLoader === "function") {
      void (async () => {
        try {
          const legacy = await legacyWatchesLoader();
          await getWatchers().migrateLegacy(Array.isArray(legacy) ? legacy : []);
        } catch {
          /* best-effort */
        }
      })();
    }
    startTimers();
    startCardTimer();
    // Publish the initial state once (fire-and-forget) so a subscriber that
    // mounts before the first tick still sees a ctoState event.
    void syncState().catch(() => {});
    return engine;
  }

  function dispose() {
    disposed = true;
    stopTimers();
    stopCardTimer();
    // BET-1466: drop the verdict counter sinks (registered lazily by
    // getVerdictsEngine). Without this a post-dispose verdict still folds
    // effects into this engine's reliability/registry state.
    for (const d of verdictSinkDisposers.splice(0)) {
      try {
        d();
      } catch {
        /* best-effort */
      }
    }
  }

  async function getState() {
    return syncState();
  }

  // Activity-ledger drill-down reader (A12). Reverse-chron over the A1 ledger,
  // cursor-paginated with `before` (exclusive ts) and filterable by actor and
  // kind. Reads are best-effort: an unreadable ledger returns [].
  async function readLedger({ before, actor, kind, limit = 100 } = {}) {
    let rows = [];
    try {
      rows = (await ledger.read()) ?? [];
    } catch {
      return { rows: [], nextBefore: null };
    }
    const out = rows
      .filter((r) => {
        if (before !== undefined && before !== null && !(typeof r?.ts === "number" && r.ts < before)) {
          return false;
        }
        if (actor && r?.actor !== actor) return false;
        if (kind && r?.kind !== kind) return false;
        return true;
      })
      .sort((a, b) => (b?.ts ?? 0) - (a?.ts ?? 0));
    const sliced = out.slice(0, limit);
    const last = sliced.length ? sliced[sliced.length - 1] : null;
    return { rows: sliced, nextBefore: typeof last?.ts === "number" ? last.ts : null };
  }

  function lastHeartbeat() {
    return heartbeatAt;
  }

  // cto_fact route handler (BET-1390 / §6.2): turn tool input into a
  // validated proposal, enqueue it on the blackboard's single-writer queue,
  // then await the gatekeeper's resolution for up to 10s so the caller gets
  // the verdict when it resolves fast. If resolution is still pending we
  // return `queued:true` — the durable queue + the tick's pump guarantee the
  // proposal is still resolved (nothing is lost by returning early).
  async function proposeFact(input = {}) {
    const built = buildFactProposal(input);
    if (built.error) return { ok: false, error: built.error };
    const fe = getFactsEngine();
    const id = built.proposal.proposalId;
    const submitted = await fe.submitProposal(built.proposal);
    if (!submitted.ok) {
      // Not newly added: either already applied (idempotent re-delivery) or
      // still queued from a prior enqueue. Report the known outcome when there
      // is one.
      const existing = await fe.proposalOutcome(id);
      if (existing) return { ok: true, proposalId: id, applied: false, outcome: existing };
      return { ok: true, proposalId: id, applied: false, queued: true };
    }
    await Promise.race([
      fe.pump(built.proposal.project).catch(() => {}),
      new Promise((r) => setTimeout(r, 10000)),
    ]);
    const outcome = await fe.proposalOutcome(id);
    if (!outcome) return { ok: true, proposalId: id, applied: true, queued: true };
    return { ok: true, proposalId: id, applied: true, outcome };
  }

  // Spawn-context facts seed for a project (§6.9): pull the top-K facts by
  // retention, format them into a context block, and record the access so the
  // retention clock reflects "this fact was actually surfaced". Returns null
  // when there is nothing to seed (callers omit the block entirely).
  async function factsContextBlock(project, { cap = 15, nowMs } = {}) {
    if (!project || !getFactsEngine()) return null;
    const fe = getFactsEngine();
    return buildFactsContext({
      project,
      cap,
      nowMs,
      getTopFacts: (p, k) => fe.topFacts(p, { k, nowMs }),
      touchFacts: (opts) => fe.touchFacts(opts),
    });
  }

  // ---- §10.5 drill-down render routes (BET-1399) ---------------------------

  // Row 1 — Blackboard drill-down render: facts per project, active +
  // superseded (struck-through), optional bi-temporal asOf. Read-only except
  // the §6.4 access touch the facts engine performs on what it renders.
  async function factsView(project, { asOfMs = null } = {}) {
    const fe = getFactsEngine();
    if (!fe) return { compiledAt: Date.now(), project: null, projects: [], asOf: asOfMs ?? null, active: [], superseded: [] };
    let asOf = null;
    if (typeof asOfMs === "number" && Number.isFinite(asOfMs) && asOfMs > 0) asOf = asOfMs;
    return fe.viewRender(project, { asOfMs: asOf });
  }

  // Row 1 — read-only, paginated archive browser (§6.3).
  async function factsArchive(project, { limit = 50, before = null } = {}) {
    const fe = getFactsEngine();
    if (!fe) return { ok: false, error: "facts engine unavailable" };
    const lim = Number.isFinite(limit) ? Math.floor(limit) : 50;
    const cur = typeof before === "number" && Number.isFinite(before) ? before : null;
    return fe.archivePage(project, { limit: lim, before: cur });
  }

  // Row 1 — `wrong`: user supersession proposal (auto-accepted, §10.5) plus
  // the ONE §9.5 verdict — `correct` on the fact's sender (highest weight;
  // the facts counter-sink dings the sender's reliability counters).
  async function correctFact(input = {}) {
    const fe = getFactsEngine();
    if (!fe) return { ok: false, error: "facts engine unavailable" };
    const r = await fe.correctFact(input);
    if (r?.ok && r.sender) {
      void getVerdictsEngine()
        .recordVerdict({
          subject: { type: "fact", id: input?.factId, sender: r.sender },
          verdict: "correct",
        })
        .catch(() => {});
    }
    return r;
  }

  // Row 1 — `pin`: resets the fact's access clock (touchFacts, §6.4). No
  // verdict — pinning is retrieval, not a judgment (§9.5).
  async function factPin(input = {}) {
    const fe = getFactsEngine();
    if (!fe) return { ok: false, error: "facts engine unavailable" };
    const fid = typeof input?.factId === "string" ? input.factId.trim() : "";
    if (!fid) return { ok: false, error: "factId is required" };
    const r = await fe.touchFacts({ project: typeof input?.project === "string" ? input.project : null, ids: [fid] });
    if (!r?.touched) return { ok: false, error: "fact not found or not live" };
    return { ok: true, touched: r.touched };
  }

  // Row 4 — tool-integrations drill-down render: the §7.2 registry rows
  // (engagement, vitality, derived §7.3 role) joined with the §7.5 probe
  // summaries (declared + effective cadence, last result). Never list is the
  // subset of rows whose metadata ring is "never" (§7.4).
  async function toolsView() {
    const reg = getTools();
    if (!reg) return { compiledAt: Date.now(), tools: [], never: [] };
    const rows = await reg.listTools().catch(() => []);
    const probes = getProbes();
    const summaries = new Map();
    if (probes?.probeSummary) {
      await Promise.all(
        rows.map(async (row) => {
          try {
            summaries.set(row.tool, await probes.probeSummary(row.tool));
          } catch {
            summaries.set(row.tool, { tool: row.tool, consented: false, configured: false, probes: [] });
          }
        }),
      );
    }
    const tools = rows.map((row) => ({
      ...row,
      probes: summaries.get(row.tool) ?? { tool: row.tool, consented: false, configured: false, probes: [] },
    }));
    const never = tools.filter((row) => row.consent?.metadata === "never");
    return { compiledAt: Date.now(), tools, never };
  }

  const engine = {
    actor: ACTOR,
    start,
    dispose,
    tick, // exposed for tests + explicit syncs
    pause,
    resume,
    hardPause,
    setThrifty,
    checkCanCreateSession,
    beginEphemeral,
    beginDelegateJob,
    reportAmbientSpend,
    // BET-1388 tier gating (§3.3): pure consult; reads the A12 dial via the
    // injected tierGet (default low). Exposed so P2 features gate on it.
    tierAllowsFeature: async (feature) => budgetTierAllows(await tierGet(), feature),
    observeEvent,
    drainInbox,
    // BET-1516 (§9.1): the pending-findings drain — exposed for tests and for
    // index.mjs's debug surface, same seam as drainInbox. `cardTick` rides
    // along (the pass that drains findings + runs the §10.3 liveness pass).
    drainFindings,
    // BET-1517 (§9.1): the triage stage over the drain's rows — exposed for
    // tests + the gate ticket's seam (stored plans keyed by finding id).
    triageDrained,
    cardTick,
    getPresence,
    getState,
    readLedger,
    lastHeartbeat,
    proposeFact,
    factsContextBlock,
    // BET-1399 (§10.5 rows 1+4): drill-down render routes + the row-1 fact
    // actions (wrong → correctFact; pin → factPin). Tools actions ride the
    // `tools` getter (revokeConsent / unNever).
    factsView,
    factsArchive,
    correctFact,
    factPin,
    toolsView,
    // BET-1396 (§7.5/§10.5): the A12 health endpoint's probe-health reader.
    probeHealth: () => getProbes()?.healthSnapshot() ?? { tools: 0, probes: 0, healthy: 0, authFailed: 0, lastRunAt: null },
    // BET-1391 verdict ledger (§9.5): record + read the verdict ledger (the
    // opencode `cto_verdict` tool + the digest-opened rewire + the health card
    // all reach one path through these).
    recordVerdict: (input) => getVerdictsEngine().recordVerdict(input),
    listVerdicts: () => getVerdictsEngine().listVerdicts(),
    // BET-1403: trust engine — consult tiers, act-and-report bookkeeping, and
    // the digest announcement queue (index.mjs wires the digest seam to it).
    trust: getTrust(),
    get rateTracker() {
      return track;
    },
    get segmenter() {
      return segmenter;
    },
    get cards() {
      return cards;
    },
    get rollupRunner() {
      return getRollupRunner();
    },
    get facts() {
      return getFactsEngine();
    },
    get backfill() {
      return getBackfill();
    },
    get profile() {
      return getProfile();
    },
    get journal() {
      return getJournal();
    },
    // BET-1398 standing-query watchers: expose the engine's register/unregister/
    // list so the on-call CTO read gateway re-points its watch/unwatch/
    // list_watches verbs here (same confirm-mode contract for `watch`).
    get watchers() {
      return getWatchers();
    },
    // BET-1395 tool discovery (§7): the registry engine (resolveConnect feeds
    // the /api/cto/tools/connect route; listTools the §10.5 surfaces) plus the
    // manual dailyScan trigger for diagnostics/tests.
    get tools() {
      return getTools();
    },
    toolsScan: () => toolsTick(),
    // BET-1472: the pure overnight watcher-candidacy predicate, exposed for
    // diagnostics/tests (same pattern as toolsScan above).
    watcherCandidatesFromRows,
    // BET-1419 tonight verbs (§10.4 drill-down + §9.2 veto card actions).
    tonightList,
    tonightAdd,
    tonightRemove,
    tonightReorder,
    tonightCancel,
    tonightRunNow,
  };

  return engine;
}

// ---------------------------------------------------------------------------
// Spawn-context facts seed (BET-1390 / §6.9) — pure orchestration over
// injected providers so it is testable without a live facts engine. Pulls
// top-K facts for a project, formats them into a `{priority,text}` context
// block, and records a retention touch on exactly the facts that were
// surfaced. Returns null when there is nothing to seed.
// ---------------------------------------------------------------------------
export async function buildFactsContext({ project, cap = 15, nowMs, getTopFacts, touchFacts } = {}) {
  if (!project || typeof getTopFacts !== "function" || typeof touchFacts !== "function") return null;
  const facts = await getTopFacts(project, cap);
  const block = formatFactsBlock(facts, { cap, nowMs });
  if (!block) return null;
  const ids = (Array.isArray(facts) ? facts : []).slice(0, cap).map((f) => f?.id).filter(Boolean);
  if (ids.length > 0) await touchFacts({ project, ids });
  return block;
}

// ---------------------------------------------------------------------------
// Watchdog (§13.3) — a SEPARATE, deterministic monitor. Its timer is owned by
// src/server/index.mjs (deliberately NOT inside the engine); the logic lives
// here so it is a pure, injectable, testable unit. Checks engine liveness +
// ambient spend rate: > 2× expected hourly burn → auto-thrifty + health
// warning; > 4× → auto-pause + blocker card.
// ---------------------------------------------------------------------------

export function createWatchdog(deps = {}) {
  const {
    engine,
    getSpendPerHour = async () => 0, // measured ambient burn since the reset
    expectedHourlyBurn = async () => 0, // the budget's expected burning rate
    livenessMs = 2 * TICK_INTERVAL_MS,
    now = () => Date.now(),
    ledger = ledgerStore,
  } = deps;

  async function ledgerLog(entry) {
    try {
      await ledger.append({ actor: ACTOR, ts: now(), ...entry });
    } catch {
      /* best-effort */
    }
  }

  // BET-1462 defect 4: read the engine's live gate state through its own state
  // accessor before escalating — an escalation already in effect is never
  // re-asserted (the cardOpen-latch shape from ctoProbes). A failed read
  // escalates as before; a real overspend is never silently skipped.
  async function escalationState() {
    try {
      const st = await engine.getState();
      return {
        paused: st?.pausedAt != null || st?.dot === DOT.PAUSED,
        thrifty: st?.dot === DOT.THRIFTY,
      };
    } catch {
      return { paused: false, thrifty: false };
    }
  }

  async function tick() {
    const burn = await getSpendPerHour();
    const expected = await expectedHourlyBurn();
    if (burn > 2 * expected) {
      const { paused, thrifty } = await escalationState();
      if (burn > 4 * expected) {
        if (!paused) {
          await engine.hardPause({
            reason: `ambient spend $${burn.toFixed(2)}/hr > 4x expected $${expected.toFixed(2)}/hr`,
            source: "watchdog",
          });
        }
        return;
      }
      if (!thrifty) {
        await engine.setThrifty(true, {
          reason: `ambient spend $${burn.toFixed(2)}/hr > 2x expected $${expected.toFixed(2)}/hr`,
          source: "watchdog",
        });
      }
      return;
    }
    const age = now() - (typeof engine.lastHeartbeat === "function" ? engine.lastHeartbeat() : 0);
    if (age > livenessMs) {
      await ledgerLog({
        kind: "cto.watchdog_stale",
        reason: `engine heartbeat stale ${age}ms > ${livenessMs}`,
      });
    }
  }

  return { tick };
}
