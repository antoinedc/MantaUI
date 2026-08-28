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
  cardsStore,
  segmentsStore,
  rollupsStore,
  inboxStore,
  purgeExpiredInbox,
} from "./ctoStores.mjs";
import { createCtoBackfill } from "./ctoBackfill.mjs";
import { startPoller } from "./startPoller.mjs";
import { createSeenIdFilter } from "./seenIds.mjs";
import { createCtoProfile, DAY_MS } from "./ctoProfile.mjs";
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
} from "./ctoCards.mjs";
import { createSegmenter, segmentEventKind } from "./ctoSegments.mjs";
import {
  createRollupRunner,
  LEVEL_MS as ROLLUP_LEVEL_MS,
  ROLLUP_LEVELS,
  windowFor as rollupWindowFor,
} from "./ctoRollups.mjs";
import { buildFactProposal, createFactsEngine, VERIFY_CYCLE_MS, senderKey, senderReliability } from "./ctoFacts.mjs";
import { formatFactsBlock } from "./ctoSessions.mjs";

// Actor tag stamped on every engine RPC call / ledger row (spec §3.3).
export const ACTOR = "cto";

// Rate limits (spec §3.3): exceed any one and the engine pauses itself and
// raises a health warning (§10.6-7).
export const RATE_LIMITS = Object.freeze({
  sessionCreationsPerHour: 30,
  concurrentEphemeral: 5,
  concurrentDelegate: 2, // inside delegate's global cap of 5
});

export const HOUR_MS = 3_600_000;
export const TICK_INTERVAL_MS = 60_000;

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
  async function pause() {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, String(Date.now()), { mode: 0o600 });
  }
  async function resume() {
    await fs.rm(path, { force: true });
  }
  return { isPaused, pause, resume };
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
// Defensive — a malformed or missing store yields zeros, never a throw.
export async function defaultGetCounts() {
  let needsYouCount = 0;
  try {
    const cards = await cardsStore.load();
    const arr = Array.isArray(cards?.cards) ? cards.cards : [];
    needsYouCount = arr.filter((c) => c && c.state === "open").length;
  } catch {
    needsYouCount = 0;
  }
  return { needsYouCount, generationInFlight: false, tonightCount: 0 };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export function createCtoEngine(deps = {}) {
  const {
    configGet = async () => ({}), // → { ctoEnabled?: boolean }
    ledger = ledgerStore, // A1 ledger writer { append }
    engineState = engineStateStore, // { load, save } (engine-state.json)
    killSwitch = createKillSwitch(),
    publish = () => {}, // (evt: {kind:"ctoState", payload}) => void
    now = () => Date.now(),
    rates: rateLimits = RATE_LIMITS,
    tickIntervalMs = TICK_INTERVAL_MS,
    cardCheckIntervalMs = CARD_CHECK_INTERVAL_MS,
    getCounts = defaultGetCounts,
    track = createRateTracker({ now }),
    // BET-1382 needs-you card machinery (blocker cards). Defaults to the real
    // stores; tests inject a fake. Cards are about the user's own blockers,
    // not autonomous CTO work, so this is wired regardless of enabled state.
    // BET-1397: the internal cards manager gets the blocking-tier router
    // (`cardFireNotify`) so an inbox `blocker` note (source 3) fires the one
    // notification on the live box.
    cardFireNotify = async () => {},
    cards = createCtoCards({ fireNotify: cardFireNotify }),
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
  } = deps;

  let disposed = false;
  let thrifty = false;
  let selfPaused = false;
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
  let verifyHandle = null;
  let tuneHandle = null;
  let builtInBackfill = null;
  let profileDecayHandle = null;

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

  // Load + append a pending blocker-card request (health escalation, §10.6-7)
  // into engine-state.json. Best-effort — the health record never throws.
  async function recordBlocker(source, reason) {
    try {
      const payload = await engineState.load();
      const pending = Array.isArray(payload?.pendingBlockers)
        ? payload.pendingBlockers
        : [];
      pending.push({
        id: nextId(),
        kind: "blocker",
        source,
        reason,
        ts: now(),
        resolved: false,
      });
      await engineState.save({ ...payload, pendingBlockers: pending });
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
    try {
      paused = paused || (await killSwitch.isPaused());
    } catch {
      /* flag read failure → treat as not paused */
    }
    return { enabled: enabledNow, paused };
  }

  async function readState() {
    const { enabled: enabledNow, paused } = await gateContext();
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
    } catch {
      /* best-effort */
    }
    return {
      enabled: enabledNow,
      dot: computeDot({ enabled: enabledNow, paused, thrifty }),
      needsYouCount: counts.needsYouCount ?? 0,
      generationInFlight: !!counts.generationInFlight,
      tonightCount: counts.tonightCount ?? 0,
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
      const { enabled: enabledNow, paused } = await gateContext();
      if (paused) {
        await syncState();
        return;
      }
      // §5.3 rollups — ambient background work, gated on enabled like any other.
      if (enabledNow) {
        await finalizeRollups();
        // §6.2 blackboard: pump the per-project proposal queue (gatekeeper).
        await pumpFacts();
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
  async function cardTick() {
    if (disposed) return;
    try {
      await cards.promoteDue();
      await cards.ingestHealthEscalations();
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

  // Exceeding a rate limit pauses the engine + raises a health warning (§3.3
  // / §10.6-7).
  async function exceedRateLimit(limitId) {
    selfPaused = true;
    await ledgerLog({ kind: "cto.ratelimit_trip", reason: limitId, source: "engine" });
    await recordBlocker("rate_limit", limitId);
    await syncState();
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
    if (track.ephemeral >= rateLimits.concurrentEphemeral) {
      await exceedRateLimit("concurrentEphemeral");
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
      await exceedRateLimit("concurrentDelegate");
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
      onSummary: async (summary) => getProfile().applySegmentSummary(summary),
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
      return runEphemeral ? await runEphemeral(data) : { ok: false, gated: true };
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
    profileEngine = deps.profile ?? createCtoProfile({ now });
    return profileEngine;
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
      presenceCheck: () => engine.getPresence().state === "present",
      surfaceExists: factSurfaceExists,
      verify: factVerify,
      resolveRef: factResolveRef,
    });
    return factsEngine;
  }

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
      const t = now();
      let cursorInit = false;
      for (const level of ROLLUP_LEVELS) {
        if (cursor[level] == null) {
          cursor[level] = rollupWindowFor(level, t)[0];
          cursorInit = true;
        }
      }
      let changed = cursorInit;
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
        const outcomes = await runner.processDue(list.map((w) => ({ level, window: w })));
        if (outcomes && outcomes.length > 0) {
          const next = outcomes[outcomes.length - 1].window[1];
          if (next > cursor[level]) {
            cursor[level] = next;
            changed = true;
          }
        }
      }
      if (changed) {
        await engineState.save({ ...payload, rollupCursor: cursor });
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
      segments: segmentsStore,
      rollups: rollupsStore,
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
      const store = inbox ?? inboxStore;
      const payload = await store.load();
      const entries = Array.isArray(payload?.entries) ? payload.entries : [];
      if (entries.length === 0) return { drained: 0 };
      const { keep } = purgeExpiredInbox(entries, { nowMs: now() });
      const unread = keep.filter((e) => !e?.read);
      if (unread.length === 0) {
        if (keep.length !== entries.length) await store.save({ ...payload, entries: keep });
        return { drained: 0 };
      }
      // Per-sender reliability (Beta mean, §6.4 / B1); unseen senders default
      // to neutral (1).
      let rel = {};
      try {
        rel = (await getFactsEngine().getState())?.senderReliability ?? {};
      } catch {
        rel = {};
      }
      const next = keep.map((e) => {
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
      });
      await store.save({ ...payload, entries: next });
      return { drained: unread.length };
    } catch {
      /* inbox drain is best-effort — never takes the engine down */
      return { drained: 0 };
    }
  }
    }
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
        });
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

  function start() {
    if (disposed) throw new Error("cto engine already disposed");
    // Load the persisted segmentation G (minutes) from engine-state (§5.1-d).
    if (segmenter && typeof segmenter.boot === "function") {
      void segmenter.boot().catch(() => {});
    }
    // Load the persisted profile (§8.1) — deterministic, lazy, best-effort.
    void getProfile().init().catch(() => {});
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
  }

  async function getState() {
    return syncState();
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
    observeEvent,
    drainInbox,
    getPresence,
    getState,
    lastHeartbeat,
    proposeFact,
    factsContextBlock,
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
    get cards() {
      return cards;
    },
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

  async function tick() {
    const burn = await getSpendPerHour();
    const expected = await expectedHourlyBurn();
    if (burn > 4 * expected) {
      await engine.hardPause({
        reason: `ambient spend ${burn} > 4x expected ${expected}`,
        source: "watchdog",
      });
      return;
    }
    if (burn > 2 * expected) {
      await engine.setThrifty(true, {
        reason: `ambient spend ${burn} > 2x expected ${expected}`,
        source: "watchdog",
      });
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
