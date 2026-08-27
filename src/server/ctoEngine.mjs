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
// Timer discipline: the engine owns exactly one timer today — the liveness /
// kill-switch / state-refresh tick — via startPoller (timer.unref() + inFlight
// guard). It is stopped on pause and restarted on resume. Event ingestion
// (observeEvent) is NOT a timer: it is driven from index.mjs's event pump and
// keeps running while paused (§10.6-5). Future work timers (probes, overnight,
// backfill) register through the same start/stop surface so pause halts them
// too; they are out of scope for this skeleton.

import { promises as fsp } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  ctoPath,
  ledgerStore,
  engineStateStore,
  cardsStore,
} from "./ctoStores.mjs";
import { startPoller } from "./startPoller.mjs";
import { createSeenIdFilter } from "./seenIds.mjs";
import { getDesktopPresence as pushGetDesktopPresence } from "./push.mjs";
import {
  CHANNEL_EVENT,
  computeLastSeen,
  eventSessionID,
  isUserPromptEvent,
  normalizeEvidence,
  presenceState,
} from "./ctoEvidence.mjs";

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
// tonight counts not populated until later pipeline issues. Defensive — a
// malformed or missing store yields zeros, never a throw.
export async function defaultGetCounts() {
  let needsYouCount = 0;
  try {
    const cards = await cardsStore.load();
    const arr = Array.isArray(cards?.cards) ? cards.cards : [];
    needsYouCount = arr.filter(
      (c) => c && c.needsYou === true && c.resolved !== true,
    ).length;
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
    getCounts = defaultGetCounts,
    track = createRateTracker({ now }),
    // A5 evidence/presence seams (injected I/O — nothing here touches tmux /
    // push directly; index.mjs supplies the real resolvers).
    getSessionInfo = async () => ({ owner: "user", project: undefined }),
    getDesktopPresence = pushGetDesktopPresence,
  } = deps;

  let disposed = false;
  let thrifty = false;
  let selfPaused = false;
  let enabled = false;
  let heartbeatAt = now();
  let tickHandle = null;
  let lastPublishedSerialized = null;

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
    return {
      enabled: enabledNow,
      dot: computeDot({ enabled: enabledNow, paused, thrifty }),
      needsYouCount: counts.needsYouCount ?? 0,
      generationInFlight: !!counts.generationInFlight,
      tonightCount: counts.tonightCount ?? 0,
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
      const { paused } = await gateContext();
      if (paused) {
        await syncState();
        return;
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
  }

  function startTimers() {
    if (tickHandle || disposed) return;
    tickHandle = startPoller(tick, {
      intervalMs: tickIntervalMs,
      label: "cto-engine",
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
  }

  // Presence/absence (§5.4): current state + lastSeen + how long the user has
  // been absent (now − lastSeen). Desktop heartbeat is read live; prompts come
  // from observedEvent stamping. Exposed to later pipeline consumers.
  function getPresence() {
    const t = now();
    const desktop = getDesktopPresence();
    const lastSeen = computeLastSeen({
      desktopHeartbeatTs: desktop?.lastSeen ?? 0,
      appOpenTs: 0,
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
    startTimers();
    // Publish the initial state once (fire-and-forget) so a subscriber that
    // mounts before the first tick still sees a ctoState event.
    void syncState().catch(() => {});
    return engine;
  }

  function dispose() {
    disposed = true;
    stopTimers();
  }

  async function getState() {
    return syncState();
  }

  function lastHeartbeat() {
    return heartbeatAt;
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
    getPresence,
    getState,
    lastHeartbeat,
    get rateTracker() {
      return track;
    },
  };

  return engine;
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
