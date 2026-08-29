// src/server/ctoBackfill.mjs
// BET-1387 — cold-start backfill (spec §10.6-4). A one-time bootstrap that
// replays up to N days of stored opencode history (read-only, via the same
// opencodeDb.mjs handle ⌘F search uses — NEVER write to it) through the A6
// segmentation + summary pipeline (ctoSegments) and A7 rollups (ctoRollups),
// oldest first, so the CTO starts with a live model instead of an empty one.
//
// Guardrails (all enforced here):
//   - Watermark: the backfill owns every session with ts < its start instant
//     (recorded in engine-state at kick-off); live ingestion owns ts ≥ it. The
//     backfill only ever reads ts < startInstant, so a backfilled and a live
//     segment can never overlap or double-count.
//   - Spend bound: one-time budget (default $3, config `ctoBackfillCapUsd`),
//     measured as the cumulative model-ledger cost attributed since the start
//     instant. On hitting the bound it stops at the depth reached and persists
//     {stoppedAtDepthDays, reason:"budget"}.
//   - Batch-priority: reduce calls (summaries/rollups) run only while presence
//     is not "present" (away/gone/unknown-with-no-recent-activity), yielding
//     between calls via the injected presenceCheck.
//   - Once per box: guarded by an `engine-state.json` marker (backfillDone);
//     a re-enable of the CTO does not re-run it.
//
// Pure, injectable, testable in the style of the rest of src/server — no live
// tmux/opencode in tests. The engine (ctoEngine.mjs) owns the tick that calls
// `step()`; index.mjs supplies the real model producer + the read-only DB.

import { DAY_MS, HOUR_MS, WEEK_MS, createRollupRunner, defaultExists, startOfDay, startOfHour, startOfWeek, windowFor, windowId } from "./ctoRollups.mjs";
import { createSegmenter } from "./ctoSegments.mjs";
import { engineStateStore, segmentsStore, rollupsStore, ledgerStore, patchEngineState } from "./ctoStores.mjs";
import { fetchLedgerRows } from "./modelLedger.mjs";

export const DEFAULT_BACKFILL_CAP_USD = 3;
export const DEFAULT_BACKFILL_DAYS = 30;
export const MAX_SESSIONS_PER_STEP = 12;
export const MAX_ROLLUPS_PER_STEP = 12;
export const ROLLUP_PHASES = Object.freeze(["hour", "day", "week"]);
const START_OF = Object.freeze({ hour: startOfHour, day: startOfDay, week: startOfWeek });

// ---------------------------------------------------------------------------
// Pure helpers (all unit-tested in ctoBackfill.test.mjs)
// ---------------------------------------------------------------------------

// The absolute session-time window the backfill owns: [historyStart,
// startInstant). Watermark-exclusive: ts === end is owned by LIVE ingestion.
export function historyWindow({ startInstant, depthDays = DEFAULT_BACKFILL_DAYS } = {}) {
  const start = startInstant - depthDays * DAY_MS;
  return { start, end: startInstant };
}

// Watermark exclusivity: a session with ts === end (the start instant) is in
// the live pipeline's territory and must be EXCLUDED from the backfill.
export function sessionInRange(ts, { start, end }) {
  return typeof ts === "number" && Number.isFinite(ts) && ts >= start && ts < end;
}

// Cumulative model-ledger cost (USD) across a set of ledger rows. Rows come
// from fetchLedgerRows; a missing/non-numeric cost counts as zero.
export function sumCost(rows) {
  return (Array.isArray(rows) ? rows : []).reduce(
    (s, r) => s + (typeof r?.cost === "number" && Number.isFinite(r.cost) ? r.cost : 0),
    0,
  );
}

// Budget state. exceeded = spent >= cap. Negative/NaN clamp to zero.
export function budgetState({ spentUsd = 0, capUsd = DEFAULT_BACKFILL_CAP_USD } = {}) {
  const spent = Math.max(0, Number.isFinite(spentUsd) ? spentUsd : 0);
  const cap = Math.max(0, Number.isFinite(capUsd) ? capUsd : DEFAULT_BACKFILL_CAP_USD);
  return { spentUsd: spent, capUsd: cap, overBy: Math.max(0, spent - cap), exceeded: spent >= cap };
}

// Progress math for the learning card: done/total, a 0..1 percent, and a wall
// ETA (ms) extrapolated from the observed rate when there is progress to
// extrapolate from. etaMs null = "unknown yet".
export function computeProgress({ done = 0, total = 0, startedAt, at } = {}) {
  const d = Math.max(0, Number.isFinite(done) ? done : 0);
  const t = Math.max(0, Number.isFinite(total) ? total : 0);
  const pct = t > 0 ? Math.min(1, d / t) : d > 0 ? 1 : 0;
  let etaMs = null;
  if (d > 0 && t > d && startedAt && at && at > startedAt) {
    const rate = (at - startedAt) / d;
    etaMs = Math.max(0, Math.round(rate * (t - d)));
  }
  return { done: Math.round(d), total: Math.round(t), pct, etaMs };
}

// The days-into-the-past depth reached when the backfill stopped (used for the
// "stopped at ~N days" card copy when the budget bound is hit). If nothing was
// processed yet it reads as the full requested depth; an out-of-window ts
// clamps to the requested depth (we never reach further back than depthDays).
export function depthDaysAt({ newestProcessedTs, now = Date.now(), depthDays = DEFAULT_BACKFILL_DAYS } = {}) {
  if (!newestProcessedTs || !(newestProcessedTs > 0)) return depthDays;
  const reached = Math.max(0, Math.round((now - newestProcessedTs) / DAY_MS));
  return Math.min(depthDays, reached);
}

// ---------------------------------------------------------------------------
// Event reconstruction (stored messages → synthetic segmenter events)
// ---------------------------------------------------------------------------

function parseData(raw) {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const d = JSON.parse(raw);
    return d && typeof d === "object" ? d : {};
  } catch {
    return {};
  }
}

function userPromptEvent(sessionID, text) {
  return { type: "user.message.created", properties: { sessionID, message: { role: "user", text: text ?? "" } } };
}

function busyEvent() {
  return { type: "session.status", properties: { status: { type: "busy" } } };
}

function idleEvent() {
  return { type: "session.idle", properties: {} };
}

// ---------------------------------------------------------------------------
// The backfill engine
// ---------------------------------------------------------------------------

export function createCtoBackfill(deps = {}) {
  const {
    configGet = async () => ({}),
    engineState = engineStateStore,
    ledger = ledgerStore,
    segments = segmentsStore,
    rollups = rollupsStore,
    summarize = async () => ({ ok: false, gated: false }),
    computeOneLiner = async () => null,
    runEphemeral = null,
    getDb = null, // async () => read-only opencode db | null (index.mjs supplies the real handle)
    presenceCheck = async () => false, // true when present → stop/yield (batch-priority)
    now = () => Date.now(),
    capUsd = null, // explicit override; else config.ctoBackfillCapUsd; else default
    depthDays = null, // explicit override; else config.ctoBackfillDays; else default
    maxSessionsPerStep = MAX_SESSIONS_PER_STEP,
    maxRollupsPerStep = MAX_ROLLUPS_PER_STEP,
  } = deps;

  let cfg = {};
  let running = false;
  let rollupRunner = null;
  let existsFn = null;

  async function loadCfg() {
    try {
      cfg = (await configGet()) || {};
    } catch {
      cfg = {};
    }
    return cfg;
  }
  function cfgNum(key, dflt) {
    const v = cfg && cfg[key];
    return typeof v === "number" && Number.isFinite(v) ? v : dflt;
  }
  function resolveCap() {
    return capUsd ?? cfgNum("ctoBackfillCapUsd", DEFAULT_BACKFILL_CAP_USD);
  }
  function resolveDepth() {
    return depthDays ?? cfgNum("ctoBackfillDays", DEFAULT_BACKFILL_DAYS);
  }

  async function readState() {
    const st = await engineState.load().catch(() => ({}));
    return st && typeof st === "object" ? st : {};
  }
  async function saveState(patch) {
    // BET-1425: per-key RMW — patches carry only backfill-owned keys, so a
    // concurrent writer's keys survive this save.
    await patchEngineState(patch, { engineState });
  }

  // The A7 rollup runner is constructed lazily + cached; it reduces past
  // windows that the live rollupCursor deliberately never touches.
  function getRunner(db) {
    if (rollupRunner) return rollupRunner;
    if (!existsFn) existsFn = defaultExists({ rollups });
    rollupRunner = createRollupRunner({
      runEphemeral,
      rollups,
      segments,
      exists: existsFn,
      presenceCheck,
      now,
    });
    return rollupRunner;
  }

  function progressFrom(st) {
    const p = st?.backfillProgress;
    return computeProgress({
      done: p ? (Array.isArray(p.processedSessions) ? p.processedSessions.length : 0) : 0,
      total: p?.total ?? 0,
      startedAt: p?.startedAt,
      at: now(),
    });
  }

  async function ledgerLog(entry) {
    try {
      await ledger.append({ actor: "cto", ts: now(), ...entry });
    } catch {
      /* best-effort */
    }
  }

  async function measureSpend(db, startInstant) {
    if (!db) return 0;
    try {
      const rows = await fetchLedgerRows(db, startInstant);
      return sumCost(rows);
    } catch {
      return 0;
    }
  }

  // Replay ONE historical session's messages (ts < watermark) through a fresh
  // segmenter, oldest-first, and flush the persisted close chains so the
  // segment summaries are on disk before the session is marked processed.
  async function replaySession(db, session, endTs) {
    const seg = createSegmenter({ segments, engineState, summarize, computeOneLiner, now });
    const rows = db
      .prepare(
        "SELECT id, time_created, data FROM message WHERE session_id = ? AND time_created < ? ORDER BY time_created ASC",
      )
      .all(String(session.id), endTs);
    const msgs = [];
    for (const r of rows || []) {
      const data = parseData(r.data);
      const role = data?.role;
      if (role !== "user" && role !== "assistant") continue;
      msgs.push({
        id: r.id != null ? String(r.id) : null,
        ts: Number(r.time_created) || 0,
        role,
        text: typeof data?.text === "string" ? data.text : "",
      });
    }
    const project = typeof session?.directory === "string" && session.directory ? session.directory : undefined;
    const sid = String(session.id);

    let i = 0;
    while (i < msgs.length) {
      const m = msgs[i];
      if (m.role === "user") {
        seg.observe(userPromptEvent(sid, m.text), { sessionID: sid, project, ts: m.ts });
        i += 1;
        let lastTs = m.ts;
        while (i < msgs.length && msgs[i].role === "assistant") {
          seg.observe(busyEvent(), { sessionID: sid, project, ts: msgs[i].ts });
          lastTs = msgs[i].ts;
          i += 1;
        }
        // Turn completed — the boundary the segmenter closes on.
        seg.observe(idleEvent(), { sessionID: sid, project, ts: Math.max(lastTs, m.ts) });
      } else {
        // Assistant activity with no preceding user prompt in range — its own
        // micro-turn, so it still closes into a segment.
        seg.observe(busyEvent(), { sessionID: sid, project, ts: m.ts });
        i += 1;
        seg.observe(idleEvent(), { sessionID: sid, project, ts: m.ts });
      }
    }

    // Flush the serialized on-liner compute + segment-close summary chains so
    // the persisted segments are complete before we advance.
    const st = seg._sessions?.get(sid);
    if (st) {
      if (st.turnChain) await st.turnChain.catch(() => {});
      if (st.closeChain) await st.closeChain.catch(() => {});
    }
  }

  // Enumerate candidate sessions in [historyStart, watermark) that we have not
  // yet processed. The backfill owns strictly ts < watermark; the set is stable
  // for the life of the backfill (no live session can land in a past window).
  async function enumerateRemaining(db, win, processedSet) {
    const out = [];
    if (!db) return out;
    // Enumerate sessions by their message activity (message.time_created is the
    // canonical INTEGER timestamp the rest of the store uses) rather than by
    // session.time_created, which is not guaranteed/typed across opencode
    // schemas. Oldest-(message-)first gives the depth-ordered replay order.
    let rows = [];
    try {
      rows = db
        .prepare(
          "SELECT m.session_id AS sid, s.directory AS directory, s.agent AS agent, MIN(m.time_created) AS first_ts " +
            "FROM message m LEFT JOIN session s ON s.id = m.session_id " +
            "WHERE m.time_created >= ? AND m.time_created < ? " +
            "GROUP BY m.session_id ORDER BY first_ts ASC",
        )
        .all(win.start, win.end);
    } catch {
      return out;
    }
    for (const r of rows || []) {
      const id = r.sid != null ? String(r.sid) : null;
      if (!id) continue;
      if (r.agent === "cto") continue; // never re-segment the CTO's own sessions
      if (processedSet.has(id)) continue;
      out.push({ id, directory: r.directory ?? null, ts: Number(r.first_ts) || 0 });
    }
    return out;
  }

  // The segments phase: replay up to maxSessionsPerStep remaining sessions,
  // oldest first, checking presence + budget between each. Returns the work
  // outcome { kind } for the caller to decide what to persist.
  async function segmentsStep(db, win, st, startInstant, cap) {
    const p = st?.backfillProgress || { processedSessions: [] };
    const processed = new Set(Array.isArray(p.processedSessions) ? p.processedSessions : []);
    const remaining = await enumerateRemaining(db, win, processed);

    // total is stable for the backfill's life; done grows as sessions finish.
    const total = remaining.length + processed.size;

    let doneThisStep = 0;
    let newestTs = p.newestProcessedTs ?? null;
    const newly = [];
    for (const sess of remaining) {
      if (doneThisStep >= maxSessionsPerStep) break;
      if (await presenceCheck().catch(() => false)) break; // yield between calls
      const spent = await measureSpend(db, startInstant);
      if (budgetState({ spentUsd: spent, capUsd: cap }).exceeded) {
        return { kind: "budget", spentUsd: spent, doneThisStep, newestTs, newly, total };
      }
      try {
        await replaySession(db, sess, win.end);
      } catch {
        /* a single bad session never aborts the backfill — skip + record */
        await ledgerLog({ kind: "cto.backfill_session_failed", sessionID: sess.id });
      }
      processed.add(sess.id);
      newly.push(sess.id);
      newestTs = Math.max(newestTs ?? 0, sess.ts || 0);
      doneThisStep += 1;
    }

    // Persist progress (resume-safe: processedSessions is the durable cursor).
    const nextProgress = {
      processedSessions: [...processed],
      total,
      startedAt: p.startedAt ?? st.backfillStartInstant ?? startInstant,
      newestProcessedTs: newestTs,
    };
    await saveState({ backfillProgress: nextProgress });
    await ledgerLog({ kind: "cto.backfill_segments", done: processed.size, total });

    const allSegmentsDone = remaining.length === 0 || processed.size === total;
    if (allSegmentsDone && doneThisStep === 0 && remaining.length === 0) {
      await saveState({ backfillPhase: "rollups" });
      return { kind: "segments-done", progress: nextProgress };
    }
    if (processed.size >= total) {
      await saveState({ backfillPhase: "rollups" });
      return { kind: "segments-done", progress: nextProgress };
    }
    return { kind: "partial", progress: nextProgress };
  }

  // The rollups phase: reduce the level-below inputs into the windows the live
  // rollupCursor never visits, oldest-first, bounded per step, presence+budget
  // checked between windows. Hour → day → week (each level's inputs come from
  // the level below). `st.backfillRollup` = { phase: hour|day|week, cursorTs }.
  async function rollupsStep(db, win, st, startInstant, cap) {
    const roll = st?.backfillRollup || {};
    let phase = roll.phase ?? "hour";
    let cursorTs = roll.cursorTs ?? startOfHour(win.start);

    const spent = await measureSpend(db, startInstant);
    let lastSpent = spent;
    let reduced = 0;
    let newestTs = st?.backfillProgress?.newestProcessedTs ?? null;

    for (; reduced < maxRollupsPerStep; ) {
      if (await presenceCheck().catch(() => false)) break;
      if (budgetState({ spentUsd: lastSpent, capUsd: cap }).exceeded) {
        break;
      }
      if (cursorTs >= win.end) {
        // Level exhausted — move up the ladder.
        const idx = ROLLUP_PHASES.indexOf(phase);
        if (idx < ROLLUP_PHASES.length - 1) {
          phase = ROLLUP_PHASES[idx + 1];
          cursorTs = START_OF[phase](win.start);
          continue;
        }
        break; // week done → finished
      }
      const window = windowFor(phase, cursorTs);
      const id = windowId(window);
      // Sail past windows already rolled up (write-once — never rewrite/throw).
      if (!(await existsFn({ level: phase, id }))) {
        try {
          await getRunner(db).reduceWindow(phase, window);
          reduced += 1;
          lastSpent = await measureSpend(db, startInstant);
        } catch {
          /* best-effort — never abort the backfill on one bad window */
        }
      }
      cursorTs = window[1];
    }

    await saveState({ backfillRollup: { phase, cursorTs } });

    // Budget-stop happened mid-drive (or at top) → persist the stop once.
    if (budgetState({ spentUsd: lastSpent, capUsd: cap }).exceeded) {
      const reachedAt = depthDaysAt({ newestProcessedTs: newestTs, now: now(), depthDays: resolveDepth() });
      await ledgerLog({ kind: "cto.backfill_stopped", reason: "budget", stoppedAtDepthDays: reachedAt, spentUsd: lastSpent });
      return { kind: "budget", spentUsd: lastSpent, reachedAt };
    }

    const done = phase === "week" && cursorTs >= win.end;
    if (done) {
      await saveState({ backfillDone: true, backfillPhase: "done" });
      await ledgerLog({ kind: "cto.backfill_done", depthDays: resolveDepth() });
    }
    return { kind: done ? "done" : "partial", progress: progressFrom(await readState()), spentUsd: lastSpent };
  }

  async function doStep(at) {
    const st = await readState();
    if (st?.backfillDone) return { ok: true, done: true, progress: progressFrom(st) };

    await loadCfg();
    // Disabled → never run (but never mark done — a re-enable resumes).
    if (cfg?.ctoEnabled !== true) return { ok: false, reason: "disabled", progress: progressFrom(st) };
    // Batch-priority: yield while present.
    if (await presenceCheck().catch(() => false)) return { ok: false, reason: "present", progress: progressFrom(st) };

    // Kick-off: record the watermark once. Live ingestion owns ts ≥ it forever
    // as far as the backfill is concerned.
    const startInstant = st?.backfillStartInstant ?? at;
    if (!st?.backfillStartInstant) {
      await saveState({ backfillStartInstant: startInstant, backfillPhase: st?.backfillPhase ?? "segments" });
    }

    const cap = resolveCap();
    const depth = resolveDepth();
    const win = historyWindow({ startInstant, depthDays: depth });

    const db = await (getDb ? getDb() : Promise.resolve(null)).catch(() => null);

    // No opencode history at all → nothing to backfill; mark done once so a
    // re-enable does not re-attempt forever.
    if (!db) {
      await saveState({
        backfillDone: true,
        backfillStopped: { reason: "no-history", stoppedAtDepthDays: 0, spentUsd: 0 },
        backfillPhase: "done",
      });
      return { ok: true, done: true, reason: "no-history", progress: progressFrom(await readState()) };
    }

    // Budget check up front (a stopped backfill stays stopped).
    const spent = await measureSpend(db, startInstant);
    if (budgetState({ spentUsd: spent, capUsd: cap }).exceeded) {
      const reachedAt = depthDaysAt({ newestProcessedTs: st?.backfillProgress?.newestProcessedTs ?? null, now: at, depthDays: depth });
      await saveState({
        backfillDone: true,
        backfillStopped: { reason: "budget", stoppedAtDepthDays: reachedAt, spentUsd: spent },
        backfillPhase: "done",
      });
      await ledgerLog({ kind: "cto.backfill_stopped", reason: "budget", stoppedAtDepthDays: reachedAt, spentUsd: spent });
      return { ok: false, stopped: true, reason: "budget", progress: progressFrom(await readState()), budget: budgetState({ spentUsd: spent, capUsd: cap }) };
    }

    const phase = st?.backfillPhase ?? "segments";
    if (phase === "segments") {
      const res = await segmentsStep(db, win, st, startInstant, cap);
      if (res.kind === "budget") {
        const reachedAt = depthDaysAt({ newestProcessedTs: res.newestTs, now: at, depthDays: depth });
        const st2 = await readState();
        await saveState({
          backfillDone: true,
          backfillStopped: { reason: "budget", stoppedAtDepthDays: reachedAt, spentUsd: res.spentUsd },
          backfillPhase: "done",
        });
        await ledgerLog({ kind: "cto.backfill_stopped", reason: "budget", stoppedAtDepthDays: reachedAt, spentUsd: res.spentUsd });
        return { ok: false, stopped: true, reason: "budget", progress: progressFrom(st2), budget: budgetState({ spentUsd: res.spentUsd, capUsd: cap }) };
      }
      return { ok: true, progress: progressFrom(await readState()) };
    }
    if (phase === "rollups") {
      return rollupsStep(db, win, await readState(), startInstant, cap);
    }
    return { ok: true, progress: progressFrom(st) };
  }

  async function step({ at = now() } = {}) {
    if (running) return { ok: false, busy: true };
    running = true;
    try {
      return await doStep(at);
    } finally {
      running = false;
    }
  }

  return {
    step,
    // Pure surface for tests / diagnostics.
    _historyWindow: historyWindow,
    _budgetState: budgetState,
    _progress: computeProgress,
    _depthDaysAt: depthDaysAt,
  };
}
