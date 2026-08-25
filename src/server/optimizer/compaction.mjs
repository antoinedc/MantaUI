// optimizer/compaction.mjs — the background compaction scheduler (Optimizer
// P2.4, BET-1346).
//
// WHY: a conversation that runs long and then goes idle sits at a high
// context % with a dead cache until the USER returns and manually runs /compact
// (or opencode's own auto-compact triggers mid-turn on an overflow). This
// scheduler compacts such conversations in the BACKGROUND — before the user
// comes back to them — and stops compaction from eating the user's standing
// instructions (Part B's constraint pinning).
//
// Split strictly into pure (`shouldCompact`) + stateful/injected-I/O
// (`createCompactionScheduler`), mirroring the other optimizer modules.
//
//   • `shouldCompact` — the decision. PURE: no Date.now(), no I/O. Every fact
//     arrives as an argument, so the whole decision is unit-testable.
//   • `createCompactionScheduler` — the stateful tick: enumerates candidates
//     via the injected `listCandidates`, evaluates each with `shouldCompact`,
//     and invokes the injected `compact(sessionId)` (the already-wired
//     oc.compactSession; NO second call path — see opencode.mjs). It enforces
//     the three idempotency/concurrency guards (in-memory in-flight set, the
//     persisted per-session cooldown, and the isBusy re-check immediately
//     before the call) and persists per-session last-attempt state.
//
// Compact fires at most COMPACT_MAX_PER_TICK per tick so a restart cannot
// stampede every stale session at once. Compaction mutates the user's history;
// firing it twice is not idempotent and firing it under a live turn is a
// visible failure — hence the three guards, all required.

export const COMPACT_CTX_THRESHOLD = 0.85; // of the model's limit.context
export const COMPACT_IDLE_MS = 10 * 60_000; // 10 minutes quiet
export const COMPACT_COOLDOWN_MS = 30 * 60_000; // per session, after any attempt
export const COMPACT_POLL_MS = 60_000;
export const COMPACT_MAX_PER_TICK = 2;

// Effective cache-TTL fallback when the optimizer summary has neither a
// measured nor a configured TTL (matches optimizerPolicy's 300_000 default).
export const COMPACT_CACHE_TTL_FALLBACK_MS = 300_000;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * PURE. Decide whether a session should be compacted in the background.
 *
 * `compact:true` requires ALL of:
 *   enabled && !busy && contextLimit > 0 &&
 *   contextTokens > COMPACT_CTX_THRESHOLD * contextLimit &&
 *   idleMs > COMPACT_IDLE_MS && cacheDead &&
 *   now - lastAttemptMs > COMPACT_COOLDOWN_MS
 *
 * `reason` names the FIRST failing condition (in the order above) — it is what
 * the log line and the activity entry read, so a session can tell you WHY it
 * was not compacted, not just that it wasn't.
 *
 * `cacheDead` is computed by the CALLER (idleMs > effectiveCacheTtlMs). The
 * scheduler derives it from the candidate's cacheTtlMs; compacting while the
 * prompt cache is still warm throws away a prefix you already paid to write —
 * the whole point of waiting for cache death is that the rewrite is then free.
 *
 * @param {object} a
 * @param {string} a.sessionID
 * @param {number} a.contextTokens  current context usage (from the ledger)
 * @param {number} a.contextLimit   the model's limit.context (0/absent → never)
 * @param {number} a.idleMs         ms since the session's last activity
 * @param {boolean} a.cacheDead     idleMs > effective cache TTL
 * @param {boolean} a.busy          is the session mid-turn?
 * @param {number} a.lastAttemptMs  last compaction attempt (0 → never)
 * @param {number} a.now            current epoch ms
 * @param {boolean} a.enabled       is the optimizer switch on?
 * @returns {{compact: boolean, reason: string}}
 */
export function shouldCompact({
  sessionID,
  contextTokens,
  contextLimit,
  idleMs,
  cacheDead,
  busy,
  lastAttemptMs,
  now,
  enabled,
} = {}) {
  if (!enabled) return { compact: false, reason: "disabled" };
  if (busy) return { compact: false, reason: "busy" };
  if (!isNum(contextLimit) || contextLimit <= 0) return { compact: false, reason: "no-context-limit" };
  const toks = isNum(contextTokens) ? contextTokens : 0;
  if (!(toks > COMPACT_CTX_THRESHOLD * contextLimit)) return { compact: false, reason: "low-context" };
  const idle = isNum(idleMs) ? idleMs : 0;
  if (!(idle > COMPACT_IDLE_MS)) return { compact: false, reason: "not-idle" };
  if (!cacheDead) return { compact: false, reason: "cache-warm" };
  const last = isNum(lastAttemptMs) ? lastAttemptMs : 0;
  const t = isNum(now) ? now : 0;
  if (!(t - last > COMPACT_COOLDOWN_MS)) return { compact: false, reason: "cooldown" };
  return { compact: true, reason: "compact" };
}

function normalizeState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const sessions = {};
  for (const [sid, e] of Object.entries(s.sessions ?? {})) {
    if (!e || typeof e !== "object") continue;
    sessions[sid] = {
      ...(isNum(e.lastAttemptMs) ? { lastAttemptMs: e.lastAttemptMs } : {}),
      ...(typeof e.lastResult === "string" ? { lastResult: e.lastResult } : {}),
    };
  }
  return { sessions };
}

/**
 * Build the compaction scheduler.
 *
 * Injected I/O (mirrors createPacingState / createCounterfactualStore):
 *   listCandidates(now) — async → Array<{ sessionID, contextTokens,
 *     contextLimit, lastActivityMs, cacheTtlMs }> — the sessions the box knows
 *     about, with the per-session facts the scheduler can't derive. The wiring
 *     (index.mjs) sources these from the model ledger (context tokens + last
 *     activity fallback) + the firehose-stamped lastActivityAt map, and the
 *     shared optimizer summary for the effective cache TTL.
 *   compact(sessionId) — async — the already-wired oc.compactSession call.
 *   isBusy(sessionId) — the shared promptDelivery busy gate (grep-verified:
 *     INJECTED here, never re-implemented).
 *   now — number or zero-arg fn (the clock).
 *   load / save — persist `{ sessions: { "<id>": { lastAttemptMs,
 *     lastResult } } }` via the shared jsonStore atomic writer (statePath
 *     "optimizer-compaction.json"); injected so tests stub them.
 *   enabled — boolean or zero-arg fn; read per tick so flipping the switch
 *     takes effect without a restart.
 *   onCompacted — (info) => void (async ok): called after a compact succeeds
 *     with { sessionID, contextTokens, contextLimit }. BET-1347 wires this to
 *     append a `compaction` entry to the activity log (the trust surface).
 *
 * The three guards, all required:
 *   1. an in-memory Set of sessionIds with a compaction in flight; a session
 *      already in the set is skipped. Entries are removed in a `finally`.
 *   2. the COMPACT_COOLDOWN_MS per-session cooldown, persisted, so a restart
 *      cannot immediately re-fire.
 *   3. the isBusy gate, re-checked IMMEDIATELY BEFORE the call, not only during
 *      evaluation — a turn can start between the two.
 *
 * Returns { tick } — tick() evaluates candidates, compacts at most
 * COMPACT_MAX_PER_TICK, records attempts, and returns a small summary.
 */
export function createCompactionScheduler({
  listCandidates,
  compact,
  isBusy,
  now,
  load,
  save,
  enabled = () => true,
  onCompacted = null,
} = {}) {
  const inflight = new Set();
  let state = null;
  // BET-1347: running tally of this-process compaction attempts for the
  // "X of Y in background" stat. `background` counts the scheduler's own
  // successful background compactions; `total` every attempted compaction.
  const tally = { background: 0, total: 0 };

  const nowMs = () => (typeof now === "function" ? (now() ?? 0) : (now ?? Date.now()));

  async function ensureLoaded() {
    if (!state && typeof load === "function") state = normalizeState(await load());
    return state ?? (state = { sessions: {} });
  }

  async function persist() {
    if (typeof save !== "function" || !state) return;
    try {
      await save(state);
    } catch (e) {
      console.warn("[optimizer] compaction save failed:", e?.message ?? e);
    }
  }

  async function tick() {
    const s = await ensureLoaded();
    const t = nowMs();
    const enabledOn = typeof enabled === "function" ? !!(await enabled()) : !!enabled;

    let candidates = [];
    try {
      const raw = typeof listCandidates === "function" ? await listCandidates(t) : [];
      candidates = Array.isArray(raw) ? raw : [];
    } catch (e) {
      console.warn("[optimizer] compaction listCandidates failed:", e?.message ?? e);
      return { compacted: [], attempted: 0 };
    }

    const compacted = [];
    let attempted = 0;
    for (const c of candidates) {
      if (attempted >= COMPACT_MAX_PER_TICK) break;
      if (!c || typeof c.sessionID !== "string" || c.sessionID === "") continue;
      if (inflight.has(c.sessionID)) continue;

      const lastActivityMs = isNum(c.lastActivityMs) ? c.lastActivityMs : t;
      const idleMs = Math.max(0, t - lastActivityMs);
      const cacheTtlMs = isNum(c.cacheTtlMs) && c.cacheTtlMs > 0 ? c.cacheTtlMs : COMPACT_CACHE_TTL_FALLBACK_MS;

      const decision = shouldCompact({
        sessionID: c.sessionID,
        contextTokens: c.contextTokens,
        contextLimit: c.contextLimit,
        idleMs,
        cacheDead: idleMs > cacheTtlMs,
        busy: typeof isBusy === "function" ? !!isBusy(c.sessionID) : false,
        lastAttemptMs: s.sessions?.[c.sessionID]?.lastAttemptMs ?? 0,
        now: t,
        enabled: enabledOn,
      });

      if (!decision.compact) continue;

      const pct = contextLimitForPct(c.contextTokens, c.contextLimit);
      // Guard 2 (persisted cooldown): stamp the attempt BEFORE the call so a
      // restart mid-call cannot immediately re-fire, and so a failed attempt
      // still cools the session down.
      const entry = s.sessions[c.sessionID] ?? {};
      entry.lastAttemptMs = t;
      s.sessions[c.sessionID] = entry;

      // Guard 1 (in-memory in-flight set): claimed before the call, released
      // in a finally so a throw can never leave a session stuck in-flight.
      inflight.add(c.sessionID);
      attempted++;
      tally.total++;
      try {
        // Guard 3 (isBusy re-check immediately before the call): a turn can
        // start between evaluation and here — firing under a live turn is a
        // visible failure.
        if (typeof isBusy === "function" && isBusy(c.sessionID)) {
          entry.lastResult = "busy";
          console.warn(
            `[optimizer] compact skip (busy) session=${c.sessionID} ctx=${pct}% idle=${Math.round(idleMs / 60_000)}m`,
          );
          continue;
        }
        console.log(
          `[optimizer] precompact session=${c.sessionID} ctx=${pct}% idle=${Math.round(idleMs / 60_000)}m`,
        );
        await compact(c.sessionID);
        entry.lastResult = "ok";
        compacted.push(c.sessionID);
        tally.background++;
        console.log(`[optimizer] compacted session=${c.sessionID} ctx=${pct}% idle=${Math.round(idleMs / 60_000)}m`);
        if (typeof onCompacted === "function") {
          try {
            await onCompacted({ sessionID: c.sessionID, contextTokens: c.contextTokens, contextLimit: c.contextLimit });
          } catch (e) {
            console.warn("[optimizer] compact onCompacted failed:", e?.message ?? e);
          }
        }
      } catch (e) {
        entry.lastResult = "error";
        console.warn(
          `[optimizer] compact FAILED session=${c.sessionID} ctx=${pct}%:`,
          e?.message ?? e,
        );
      } finally {
        inflight.delete(c.sessionID);
        await persist();
      }
    }

    return { compacted, attempted };
  }

  // BET-1347: the "X of Y in background" stat. Absent until the scheduler has
  // attempted at least one compaction (never a fabricated zero).
  function stat() {
    if (tally.total === 0) return null;
    return { background: tally.background, total: tally.total };
  }

  return { tick, stat };
}

// The context % for a log line (0..~100). Guarded: a non-finite limit yields 0.
function contextLimitForPct(tokens, limit) {
  if (!isNum(limit) || limit <= 0) return 0;
  const t = isNum(tokens) ? tokens : 0;
  return Math.min(100, Math.round((t / limit) * 100));
}
