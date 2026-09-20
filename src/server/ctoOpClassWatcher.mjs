// ctoOpClassWatcher.mjs — BET-1533: the operation-class outcome watcher (§W7
// item 1). Watches `cto.operation_outcome` ledger rows per task class and
// raises a pendingBlockers entry when a class is silently dying:
//
//   blocker  — 0 ok in the last 10 attempts AND ≥1h between the oldest and
//              the newest of those 10
//   degraded — <50% success over the last 20 attempts (also a blocker, lower
//              text severity)
//
// `gated` rows are neither success nor failure — they are skipped entirely
// (the class never ran; it must not count toward any window).
//
// Dedupe: alarm state is keyed (taskClass, incidentGeneration) and kept
// OUT of the ledger (a key in engine-state.json). An incident fires once and
// stays latched; it re-arms only after demonstrated recovery (one `ok` row
// for that class newer than the alarm's fire time). Without the latch a dead
// class would raise a blocker on every tick forever; without the
// newer-than-firedAt guard the sliding read window would re-see an old `ok`
// and clear + re-raise on every read.
//
// The predicate is pure (rows + now) and tested directly; the engine owns the
// thin I/O wrapper (read ledger → evaluate → recordBlocker → persist latch).

export const OP_CLASS_OUTCOME_KIND = "cto.operation_outcome";
export const OP_CLASS_OK = "ok";
export const OP_CLASS_GATED = "gated";

// Blocker window: the last 10 attempts of a class.
export const OP_CLASS_BLOCK_WINDOW = 10;
// ...which must span ≥1h between the oldest and the newest of those 10.
export const OP_CLASS_BLOCK_SPAN_MS = 60 * 60 * 1000;
// Degraded window: the last 20 attempts, <50% of them ok.
export const OP_CLASS_DEGRADED_WINDOW = 20;

// How far back each watch read looks. The cost of `ledger.read({ from })` is
// O(file) regardless of the range (every line is parsed), so a generous
// window is free — it just has to plausibly contain the last 20 attempts of
// every watched class, including slow ones.
export const OP_CLASS_LOOKBACK_MS = 14 * 86_400_000;

// Engine-side pacing: the ledger read is O(file), so the watch runs at most
// once per interval even though the engine ticks every minute. Not a config
// flag — an internal constant the engine may override via deps for tests.
export const OP_CLASS_WATCH_INTERVAL_MS = 10 * 60 * 1000;

// The class key for an outcome row: the operation that ran (`segment-summary`,
// `segment-one-liner`, `tool-classification` op rows) falling back to the
// `taskClass` that routed it. The 2026-09-14 outage data carries both fields;
// acceptance names the operations, so `operation` wins when present.
export function opClassOf(row) {
  if (row && typeof row === "object") {
    if (typeof row.operation === "string" && row.operation) return row.operation;
    if (typeof row.taskClass === "string" && row.taskClass) return row.taskClass;
  }
  return null;
}

// Most frequent failure code among a window's attempts (ties → the code seen
// most recently). Null when every attempt succeeded.
function dominantFailure(attempts) {
  const counts = new Map();
  for (const a of attempts) {
    if (a.code === OP_CLASS_OK) continue;
    const prev = counts.get(a.code);
    counts.set(a.code, { count: (prev?.count ?? 0) + 1, lastTs: a.ts });
  }
  let best = null;
  for (const [code, { count, lastTs }] of counts) {
    if (!best || count > best.count || (count === best.count && lastTs > best.lastTs)) {
      best = { code, count, lastTs };
    }
  }
  return best;
}

// The pendingBlockers reason line. Names what the issue demands: the task
// class, the dominant failure code, and the count.
export function formatOpClassReason(alarm) {
  if (!alarm || typeof alarm.taskClass !== "string") return "operation class watcher";
  if (alarm.severity === "blocker") {
    const spanH = Math.round(((alarm.spanMs ?? 0) / 3_600_000) * 10) / 10;
    return (
      `operation class "${alarm.taskClass}": 0 ok in the last ${alarm.window} attempts ` +
      `over ${spanH}h — dominant failure code "${alarm.code}" ×${alarm.codeCount}`
    );
  }
  return (
    `operation class "${alarm.taskClass}": ${alarm.okCount}/${alarm.window} attempts ok ` +
    `(<50%) — dominant failure code "${alarm.code}" ×${alarm.codeCount}`
  );
}

/**
 * Pure fold over outcome rows + the prior alarm map.
 *
 * `rows` may be raw mixed-kind ledger rows (the function filters to
 * `cto.operation_outcome`, drops `gated`, and sorts by `ts` defensively —
 * `ledger.read` returns file order, not ts order). `alarms` is the prior
 * latch map: `{ [taskClass]: { generation, active, ... } }`. `nowMs` is the
 * evaluation time (the alarm's `firedAt`).
 *
 * Returns `{ alarms, raised, recovered }` — the next latch map, the alarms to
 * raise this evaluation (one entry per newly-fired incident), and the classes
 * whose incident was cleared by a fresh `ok`.
 */
export function evaluateOpClass(rows, { nowMs, alarms = {} } = {}) {
  const next = { ...alarms };
  const raised = [];
  const recovered = [];
  if (!Array.isArray(rows)) return { alarms: next, raised, recovered };

  // Filter to outcome rows with a usable class key, drop `gated` (skipped
  // entirely — never an attempt), and sort by ts ascending.
  const outcome = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || row.kind !== OP_CLASS_OUTCOME_KIND) continue;
    if (row.code === OP_CLASS_GATED) continue;
    const cls = opClassOf(row);
    if (!cls || typeof row.ts !== "number") continue;
    outcome.push({ cls, ts: row.ts, code: typeof row.code === "string" ? row.code : "" });
  }
  outcome.sort((a, b) => a.ts - b.ts);

  const groups = new Map();
  for (const a of outcome) {
    const list = groups.get(a.cls);
    if (list) list.push(a);
    else groups.set(a.cls, [a]);
  }

  for (const [cls, attempts] of groups) {
    const prior = next[cls] ?? null;
    let active = prior && prior.active === true ? prior : null;

    // Recovery: one `ok` row for this class newer than the active latch's
    // fire time. Older oks are the sliding window re-feeding rows the alarm
    // already saw — they must not clear (and re-arm) the incident forever.
    if (active) {
      const freshOk = attempts.some((a) => a.code === OP_CLASS_OK && a.ts > active.firedAt);
      if (freshOk) {
        next[cls] = { generation: prior.generation ?? 0, active: false };
        recovered.push(cls);
        active = null;
      }
    }

    // Blocker: the last 10 attempts, all failures, spanning ≥1h.
    let candidate = null;
    if (attempts.length >= OP_CLASS_BLOCK_WINDOW) {
      const last10 = attempts.slice(-OP_CLASS_BLOCK_WINDOW);
      const okCount = last10.reduce((n, a) => n + (a.code === OP_CLASS_OK ? 1 : 0), 0);
      const spanMs = last10[last10.length - 1].ts - last10[0].ts;
      if (okCount === 0 && spanMs >= OP_CLASS_BLOCK_SPAN_MS) {
        const dom = dominantFailure(last10);
        candidate = {
          severity: "blocker",
          window: OP_CLASS_BLOCK_WINDOW,
          okCount: 0,
          spanMs,
          code: dom.code,
          codeCount: dom.count,
          sinceTs: last10[0].ts,
        };
      }
    }
    // Degraded: the last 20 attempts, strictly <50% ok. (Lower text severity;
    // same pendingBlockers path.)
    if (!candidate && attempts.length >= OP_CLASS_DEGRADED_WINDOW) {
      const last20 = attempts.slice(-OP_CLASS_DEGRADED_WINDOW);
      const okCount = last20.reduce((n, a) => n + (a.code === OP_CLASS_OK ? 1 : 0), 0);
      if (okCount * 2 < OP_CLASS_DEGRADED_WINDOW) {
        const dom = dominantFailure(last20);
        candidate = {
          severity: "degraded",
          window: OP_CLASS_DEGRADED_WINDOW,
          okCount,
          spanMs: undefined,
          code: dom.code,
          codeCount: dom.count,
          sinceTs: last20[0].ts,
        };
      }
    }

    // Fire once per incident: a candidate only raises when no latch is active
    // for the class. Re-feeding the same rows (the sliding read window) finds
    // the latch and does nothing.
    if (candidate && !(next[cls] && next[cls].active === true)) {
      const generation = ((next[cls] && next[cls].generation) ?? 0) + 1;
      const alarm = {
        taskClass: cls,
        generation,
        active: true,
        firedAt: nowMs,
        ...candidate,
      };
      next[cls] = alarm;
      raised.push(alarm);
    }
  }

  return { alarms: next, raised, recovered };
}
