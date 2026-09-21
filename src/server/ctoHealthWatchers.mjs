// ctoHealthWatchers.mjs — BET-1537 S5, watchers 2 and 3 of the endpoint-health
// spec (§W7 items 2 and 3): the endpoint watcher and the infrastructure
// watcher, as PURE folds over ledger rows.
//
// They deliberately clone the shape of S1's operation-class watcher
// (ctoOpClassWatcher.mjs) and share its plumbing end to end: the engine's
// watcher tick reads the ledger ONCE and feeds all three folds; a raise goes
// through the EXISTING blocker path (recordBlocker → a health card via the
// `endpoint:<subject>` / `infra:<subject>` source — the cards layer upserts
// the duplicate in place); the alarm latches in engine-state.json under the
// `healthAlarms` key, keyed (subject, incidentGeneration), re-arming only
// after recovery. No second alarm path, no new notification mechanism, no new
// store.
//
// The two folds' INPUT rows:
//
//   endpoint watcher — written by endpointHealth.mjs on exclusion-state
//   transitions (§W7.2 "an endpoint or account entering an excluding state"):
//
//     cto.endpoint_excluded   { subject, scope, state, reason }
//     cto.endpoint_recovered  { subject, scope }
//
//   Only the DURABLE excluding states fire: endpoint dead / not-found /
//   forbidden and account out-of-credit / unauthorized. `rate-limited` and the
//   soft states (unproven, degraded) do NOT raise a blocker card — a 429 has a
//   designed clock recovery and surfaces on the Accounts/Models UI (§W9); the
//   durable states recover by evidence only, which is exactly what a
//   needs-you card is for.
//
//   infrastructure watcher (§W7.3 "a health system that is itself broken must
//   not be quiet") — rows already written by S2/S4 plus two S5 additions:
//
//     cto.endpoint_health_persist_failed      (S4 — the register cannot save)
//     cto.endpoint_attempts_persist_failed    (S2 — the attempts store cannot save)
//     cto.endpoint_health_quarantined         (S4 — corrupt state file)
//     cto.endpoint_attempts_quarantined       (S2 — corrupt state file)
//     cto.health_self_doubt                   (S4 — health excluded everything)
//     cto.operation_outcome code=no-healthy-endpoint        (S3 verdict)
//     cto.operation_outcome code=no-alternate-endpoint      (S5 failover stop)
//     cto.operation_not_dispatched            (S5 — a settled op never dispatched)
//     cto.operations_abandoned {count}        (S5 — abandoned closures, batched)
//
//   Rate signals (not-dispatched/abandoned) are only ALARMED as a SUSTAINED
//   rate: ≥ INFRA_RATE_THRESHOLD outcomes inside INFRA_RATE_WINDOW_MS — a
//   healthy box does not lose that many operations to the dispatch path.
//
// Recovery semantics (per fold):
//   - endpoint incidents close on an explicit `cto.endpoint_recovered` row for
//     the same subject — the health engine emits it on an evidence-based clear
//     (production success, probe pass, meter funds, or a user/config reset).
//   - infrastructure incidents close on demonstrated recovery: a later
//     `ok` outcome row after the incident fired, or INFRA_QUIET_MS of quiet —
//     the failure stopped announcing itself (point incidents) / the window's
//     loss count decayed below the threshold (the rate incident).
//
// Pure: rows in, {alarms, raised, recovered} out. No fs, no stores, no clock.

// Mirror S1's read window: every tick re-reads this much ledger. The latches
// live in engine-state.json, so the fold is replayable.
export const HEALTHWATCH_LOOKBACK_MS = 14 * 24 * 3_600_000;

// The sustained-loss window + threshold (§W7.3 "a sustained rate of
// not-dispatched/abandoned outcomes"). Ten lost operations inside half an
// hour is not a bad day — it is a broken dispatch path.
export const INFRA_RATE_WINDOW_MS = 30 * 60_000;
export const INFRA_RATE_THRESHOLD = 10;

// How long an infrastructure incident stays quiet before it counts as
// recovered (the closing notification fires on the next evaluation).
export const INFRA_QUIET_MS = 30 * 60_000;

export const HEALTHWATCH_EXCLUDED_KIND = "cto.endpoint_excluded";
export const HEALTHWATCH_RECOVERED_KIND = "cto.endpoint_recovered";
export const HEALTHWATCH_OUTCOME_KIND = "cto.operation_outcome";
export const HEALTHWATCH_NOT_DISPATCHED_KIND = "cto.operation_not_dispatched";
export const HEALTHWATCH_ABANDONED_KIND = "cto.operations_abandoned";

const PERSIST_KINDS = new Set([
  "cto.endpoint_health_persist_failed",
  "cto.endpoint_attempts_persist_failed",
]);
const QUARANTINE_KINDS = new Set([
  "cto.endpoint_health_quarantined",
  "cto.endpoint_attempts_quarantined",
]);
// The verdict codes that mean "the health model ate the whole pool".
const VERDICT_CODES = new Set(["no-healthy-endpoint", "no-alternate-endpoint"]);

function byTs(a, b) {
  return (a.ts ?? 0) - (b.ts ?? 0);
}

// ---------------------------------------------------------------------------
// Watcher 2 — the endpoint watcher (§W7.2)
// ---------------------------------------------------------------------------

/**
 * Fold `cto.endpoint_excluded` / `cto.endpoint_recovered` rows + the prior
 * latch map into the next map, the alarms to raise and the incidents to close.
 *
 * `alarms` keys are `endpoint:<subject>`; each value
 * `{ watcher, subject, scope, state, reason, generation, active, firedAt, lastEvidenceAt }`.
 * An exclusion row while INACTIVE fires (generation+1); while ACTIVE it is
 * deduped (one alarm per incident). A recovered row newer than the incident's
 * `firedAt` closes it — the closing notification is the engine's
 * `cto.healthwatch_recovered` ledger row.
 *
 * Rows may be raw mixed-kind ledger rows (filtered + ts-sorted defensively —
 * ledger.read returns file order).
 */
export function evaluateEndpointIncidents(rows, { nowMs, alarms = {} } = {}) {
  const next = { ...alarms };
  const raised = [];
  const recovered = [];
  const relevant = (Array.isArray(rows) ? rows : [])
    .filter(
      (r) =>
        r != null &&
        (r.kind === HEALTHWATCH_EXCLUDED_KIND || r.kind === HEALTHWATCH_RECOVERED_KIND),
    )
    .sort(byTs);

  for (const row of relevant) {
    const subject = typeof row.subject === "string" && row.subject ? row.subject : null;
    if (!subject) continue;
    const key = `endpoint:${subject}`;
    if (row.kind === HEALTHWATCH_EXCLUDED_KIND) {
      const prev = next[key];
      const active = prev != null && prev.active === true;
      if (active) {
        // Same incident — the latch dedupes (one alarm per incident); only
        // refresh the last-evidence stamp so recovery can compare against it.
        next[key] = { ...prev, lastEvidenceAt: row.ts ?? prev.lastEvidenceAt };
        continue;
      }
      // Replay guard (the sliding read window re-feeds rows the latch has
      // already seen): an exclusion row at or before the latch's last
      // evidence never re-fires an old incident.
      if (prev != null && (row.ts ?? 0) <= (prev.lastEvidenceAt ?? 0)) continue;
      const generation = (prev?.generation ?? 0) + 1;
      const alarm = {
        watcher: "endpoint",
        subject,
        scope: row.scope === "account" ? "account" : "endpoint",
        state: typeof row.state === "string" ? row.state : "unknown",
        reason: row.reason ?? null,
        generation,
        active: true,
        firedAt: row.ts ?? nowMs,
        lastEvidenceAt: row.ts ?? nowMs,
      };
      next[key] = alarm;
      raised.push(alarm);
      continue;
    }
    // HEALTHWATCH_RECOVERED_KIND — close the active incident (if any).
    const prev = next[key];
    if (prev == null || prev.active !== true) continue;
    if ((row.ts ?? 0) < (prev.firedAt ?? 0)) continue; // stale evidence, pre-incident
    const closed = { ...prev, active: false, recoveredAt: row.ts ?? nowMs };
    next[key] = closed;
    recovered.push(closed);
  }

  return { alarms: next, raised, recovered };
}

// ---------------------------------------------------------------------------
// Watcher 3 — the infrastructure watcher (§W7.3)
// ---------------------------------------------------------------------------

/**
 * Fold the infrastructure signal rows + the prior latch map. Same shape as
 * the endpoint fold; alarm keys are `infra:<subject>` with subject in:
 *   "persist" | "quarantined" | "self-doubt" | "no-healthy-endpoint" |
 *   "no-alternate-endpoint" | "sustained-loss".
 *
 * Point incidents fire on their first evidence row and stay latched (later
 * rows dedupe, refreshing `lastEvidenceAt`). Recovery: a later `ok` outcome
 * row after `firedAt`, or INFRA_QUIET_MS of quiet — evaluated at `nowMs`.
 *
 * The rate incident ("sustained-loss") fires when the not-dispatched/abandoned
 * outcomes inside INFRA_RATE_WINDOW_MS reach INFRA_RATE_THRESHOLD and closes
 * when the window's count decays below the threshold.
 */
export function evaluateInfraIncidents(rows, { nowMs, alarms = {} } = {}) {
  const next = { ...alarms };
  const raised = [];
  const recovered = [];
  const relevant = (Array.isArray(rows) ? rows : [])
    .filter((r) => {
      if (r == null) return false;
      if (r.kind === HEALTHWATCH_OUTCOME_KIND) return true; // verdicts + ok recovery
      return (
        PERSIST_KINDS.has(r.kind) ||
        QUARANTINE_KINDS.has(r.kind) ||
        r.kind === "cto.health_self_doubt" ||
        r.kind === HEALTHWATCH_NOT_DISPATCHED_KIND ||
        r.kind === HEALTHWATCH_ABANDONED_KIND
      );
    })
    .sort(byTs);

  const fire = (subject, patch = {}) => {
    const key = `infra:${subject}`;
    const prev = next[key];
    const active = prev != null && prev.active === true;
    if (active) {
      next[key] = { ...prev, ...patch };
      return null;
    }
    // Replay guard: a row at or before the latch's last evidence never
    // re-fires an old incident (the sliding read window re-feeds rows).
    const rowTs = patch.lastEvidenceAt;
    if (prev != null && typeof rowTs === "number" && rowTs <= (prev.lastEvidenceAt ?? 0)) return null;
    const generation = (prev?.generation ?? 0) + 1;
    const alarm = {
      watcher: "infra",
      subject,
      generation,
      active: true,
      firedAt: nowMs,
      lastEvidenceAt: nowMs,
      ...patch,
    };
    next[key] = alarm;
    raised.push(alarm);
    return alarm;
  };

  let lossCount = 0;
  const windowFloor = nowMs - INFRA_RATE_WINDOW_MS;

  for (const row of relevant) {
    const ts = row.ts ?? 0;
    if (row.kind === HEALTHWATCH_OUTCOME_KIND) {
      const code = typeof row.code === "string" ? row.code : null;
      if (code != null && VERDICT_CODES.has(code)) {
        fire(code, { lastEvidenceAt: ts });
      } else if (code === "ok") {
        // Dispatch works again — demonstrated recovery for every active
        // verdict incident (and a weak-but-real signal for the others; the
        // rate-limited evidence rows re-arm them if the breakage persists).
        for (const subject of VERDICT_CODES) {
          const key = `infra:${subject}`;
          const prev = next[key];
          if (prev?.active === true && (prev.firedAt ?? 0) <= ts) {
            next[key] = { ...prev, active: false, recoveredAt: ts };
            recovered.push(next[key]);
          }
        }
      }
      continue;
    }
    if (PERSIST_KINDS.has(row.kind)) {
      fire("persist", { lastEvidenceAt: ts });
      continue;
    }
    if (QUARANTINE_KINDS.has(row.kind)) {
      fire("quarantined", { lastEvidenceAt: ts });
      continue;
    }
    if (row.kind === "cto.health_self_doubt") {
      fire("self-doubt", { lastEvidenceAt: ts });
      continue;
    }
    if (row.kind === HEALTHWATCH_NOT_DISPATCHED_KIND) {
      if (ts >= windowFloor) lossCount += 1;
      continue;
    }
    if (row.kind === HEALTHWATCH_ABANDONED_KIND) {
      const n = Number.isFinite(row.count) && row.count > 0 ? Math.floor(row.count) : 1;
      if (ts >= windowFloor) lossCount += n;
      continue;
    }
  }

  const key = "infra:sustained-loss";
  const prev = next[key];
  const active = prev != null && prev.active === true;
  if (!active && lossCount >= INFRA_RATE_THRESHOLD) {
    fire("sustained-loss", { lossCount });
  } else if (active && lossCount < INFRA_RATE_THRESHOLD) {
    // The window's loss count decayed below the threshold — the storm ended;
    // the closing notification fires via the engine's recovered row.
    const closed = { ...prev, active: false, lossCount, recoveredAt: nowMs };
    next[key] = closed;
    recovered.push(closed);
  } else if (active) {
    next[key] = { ...prev, lossCount };
  }

  // Quiet-decay pass: a point incident whose evidence stopped arriving
  // INFRA_QUIET_MS ago is recovered (the failure stopped announcing itself).
  for (const [k, a] of Object.entries(next)) {
    if (!k.startsWith("infra:") || a?.active !== true || k === key) continue;
    if (nowMs - (a.lastEvidenceAt ?? a.firedAt ?? 0) <= INFRA_QUIET_MS) continue;
    const closed = { ...a, active: false, recoveredAt: nowMs };
    next[k] = closed;
    recovered.push(closed);
  }

  return { alarms: next, raised, recovered };
}

// Dedicated copy for the infra subjects (review nit): they carry no scope or
// register state, so the endpoint-shaped wording would read as
// `endpoint "persist" excluded — unknown`. Each subject says what broke.
const INFRA_SUBJECT_COPY = Object.freeze({
  persist: "endpoint health persistence failing — health state may not survive restarts",
  quarantined: "a health state file was corrupt — quarantined and rebuilt empty",
  "self-doubt": "health excluded every endpoint of a tier — health may be wrong",
  "sustained-loss": "sustained loss — a burst of not-dispatched/abandoned operations (≥10 in 30 min)",
  "no-healthy-endpoint": "no healthy endpoint — every routing candidate was excluded",
  "no-alternate-endpoint": "endpoint failover found no alternate endpoint to retry on",
});

/**
 * The human words for a raised health-watcher alarm — the blocker card body.
 * Same discipline as formatOpClassReason: name the subject, the state and the
 * reason, in words that agree with the Accounts/Models surface (the shared
 * endpoint-state labels). Infra subjects get dedicated wording (they carry no
 * scope/state of their own).
 */
export function formatHealthReason(alarm) {
  if (!alarm || typeof alarm.subject !== "string") return "health watcher";
  if (alarm.watcher === "infra") {
    const copy = INFRA_SUBJECT_COPY[alarm.subject];
    if (copy) return copy;
  }
  const where = alarm.scope === "account" ? "account" : "endpoint";
  const bits = [];
  if (alarm.state != null) bits.push(`state "${alarm.state}"`);
  const r = alarm.reason;
  if (r && typeof r === "object") {
    if (Number.isFinite(r.httpStatus)) bits.push(`HTTP ${r.httpStatus}`);
    if (typeof r.errorName === "string" && r.errorName) bits.push(r.errorName);
    if (Number.isFinite(r.streak) && r.streak > 0) bits.push(`${r.streak} consecutive failures`);
  }
  const suffix = bits.length > 0 ? ` (${bits.join(", ")})` : "";
  return `${where} "${alarm.subject}" excluded — ${alarm.state ?? "unknown"}${suffix}`;
}
