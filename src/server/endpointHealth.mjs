// endpointHealth.mjs — the two health registers (endpoint-health spec §4.4,
// §4.5, §4.5a; W4/W5/W8, BET-1536), box-side.
//
// The ONE health home for routing, replacing the provider-keyed in-memory
// event tracker in providerHealth.mjs (which remains only as a compatibility
// facade over this engine's read surface).
//
// Two registers (§4.4 — a resource is (provider, endpoint); excluding either
// excludes the pair):
//
//   ACCOUNT (keyed by providerID)   — credential/billing states:
//     out-of-credit  HTTP 402       excluded from Auto (never manual);
//                                   recovers ONLY by evidence
//     unauthorized   HTTP 401       excluded after the SECOND consecutive
//                                   observed 401 (arming counter, §4.5a);
//                                   an intervening success or a successful
//                                   credential recovery resets the count
//
//   ENDPOINT (keyed by endpointKey = providerID/modelID) — model states:
//     unproven       no success inside the window + failureStreak > 0 — soft
//     dead           failureStreak >= DEAD_STREAK health-eligible failures
//     degraded       success rate < 50% over the bounded window (>=10 attempts)
//     not-found      HTTP 404 — authoritative, first occurrence
//     forbidden      HTTP 403 — authoritative, first occurrence
//     rate-limited   HTTP 429 — a Retry-After deadline, auto-recovers on expiry
//
// Health-eligible inputs: S2's provider attempts ONLY (endpointAttempts.mjs —
// BET-1230's classification lives there, not here). Statistics (lastSuccessAt,
// failureStreak, the bounded window) are DERIVED from S2's durable store —
// they live there and are never duplicated here. The authoritative states,
// the 401 arming counter, the rate-limit deadlines, the recovery timestamps
// and the probe scheduler bookkeeping persist HERE, at
// statePath("endpoint-health.json"), versioned, written only through
// patchStore (RMW under the path mutex). There is no process-local health
// state: everything durable is on disk; the in-memory aggregates/register are
// read-models rebuilt by reload() (on creation, on every write, and on the
// store sweep tick), so a restart is never evidence.
//
// Recovery (W8) — four ways, all evidence:
//   1. a production success on the endpoint (and on the account) — the
//      strongest signal; clears authoritative and statistical state;
//   2. a successful probe — clears `unproven` and transient `dead`, and never
//      an authoritative state on its own;
//   3. a manual reset (`retry(providerID)`, the Accounts action) — clears the
//      exclusion and immediately runs one bounded real probe, reporting the
//      result (a user-requested probe success DOES clear an authoritative
//      exclusion — the user is the evidence, and a control that cannot perform
//      the recovery it offers is a dead control);
//   4. a supported provider's usage reader reporting funds on a normal poll
//      (`deliverSnapshots`) — account-meter data, §4.5's promotion evidence
//      in reverse.
//
// Probes (W8) are ONE cheap call: a pinned runSynchronousSession with
// `probe: true` — a short instruction, bounded output, ≤200 tokens, 10s
// timeout, off every hot path (admission probes ride the 5-min store sweep;
// the ladder is jittered backoff 5m → 15m → 1h → 6h → 24h cap). Probe calls
// are recorded as probe evidence (the attempt rows carry `probe: true`, the
// outcome lands in this register's probe ring) and are excluded from budget
// accounting (no ctoAct dispatch row), operation statistics (filtered from
// the window stats below) and the W7.1 class watcher (no operation_outcome
// row — probes never go through the agent dispatcher).
//
// Self-doubt (W8 #3): when health would exclude every candidate of a verdict
// (the no-healthy-endpoint failure where every drop is a health drop), the
// caller raises `raiseSelfDoubtAlarm` — a ledger row — because a health model
// that excludes everything it has never seen succeed may simply be wrong.
//
// Surfacing: per the `NEVER STUB A CONTROL TO DO NOTHING` rule in AGENTS.md
// an exclusion must surface, not silently disappear. The SAME
// `provider-health.needs-attention` bus event as before fires ONCE per
// transition into a non-ok provider state (never on every check).

import {
  MIN_RATE_LIMIT_BACKOFF_MS,
  MAX_RATE_LIMIT_BACKOFF_MS,
} from "./usage.mjs";
import {
  ATTEMPT_RING_WINDOW_MS,
  isHealthEligibleFailure,
  endpointAttempts as defaultAttempts,
} from "./endpointAttempts.mjs";
import { statePath } from "../shared/paths.mjs";
import { patchStore, ledgerStore, createQuarantinedJsonStore } from "./ctoStores.mjs";

export const ENDPOINT_HEALTH_VERSION = 1;
export const ENDPOINT_HEALTH_STATES = Object.freeze({
  UNPROVEN: "unproven",
  DEAD: "dead",
  DEGRADED: "degraded",
  NOT_FOUND: "not-found",
  FORBIDDEN: "forbidden",
  RATE_LIMITED: "rate-limited",
});
export const ACCOUNT_HEALTH_STATES = Object.freeze({
  OUT_OF_CREDIT: "out-of-credit",
  UNAUTHORIZED: "unauthorized",
});
export const PROVIDER_HEALTH_STATE = Object.freeze({
  OK: "ok",
  RATE_LIMITED: "rate-limited",
  OUT_OF_CREDIT: "out-of-credit",
  UNAUTHORIZED: "unauthorized",
  FAILING: "failing",
});

// `dead` needs a streak of consecutive health-eligible failures. A single
// transient blip must never exclude; five in a row is a pattern.
export const DEAD_STREAK = 5;

// `degraded` is a WINDOW measure: success rate < 50% over at least this many
// attempts inside the bounded window (S2's ring window — count AND age
// bounded, never a global success rate).
export const DEGRADED_MIN_ATTEMPTS = 10;
export const DEGRADED_MAX_FAILURE_RATE = 0.5;

// W8's jittered admission-probe backoff ladder, ms. Cap: 24h.
export const PROBE_LADDER_MS = Object.freeze([
  5 * 60_000, 15 * 60_000, 3_600_000, 6 * 3_600_000, 24 * 3_600_000,
]);
export const PROBE_RING_CAP = 50;
// Bound the cost of one sweep tick: at most this many admission probes.
export const MAX_PROBES_PER_TICK = 3;

const ALARM_RATE_LIMIT_MS = 300_000;

export function endpointHealthPath() {
  return statePath("endpoint-health.json");
}

export function createEndpointHealthPayload() {
  return { v: ENDPOINT_HEALTH_VERSION, accounts: {}, endpoints: {}, probes: [] };
}

// Shape validator: throws on a top-level non-object (corrupt) or a NEWER `v`
// (never silently truncate — §13.2). Missing maps normalize to empty.
export function validateEndpointHealthPayload(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("endpoint-health: payload is not an object (corrupt)");
  }
  const v = "v" in data ? data.v : ENDPOINT_HEALTH_VERSION;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new Error(`endpoint-health: invalid schema version ${JSON.stringify(data.v)}`);
  }
  if (v > ENDPOINT_HEALTH_VERSION) {
    throw new Error(
      `endpoint-health: schema version ${v} is newer than the supported version ` +
        `${ENDPOINT_HEALTH_VERSION} — refusing to read (never silently truncate)`,
    );
  }
  const mapOf = (x) =>
    x && typeof x === "object" && !Array.isArray(x) ? x : {};
  return {
    v: ENDPOINT_HEALTH_VERSION,
    accounts: mapOf(data.accounts),
    endpoints: mapOf(data.endpoints),
    probes: Array.isArray(data.probes) ? data.probes : [],
  };
}

// Clamp a requested Retry-After into the band the usage engine already uses
// for the same case (a real provider answers 429 with `retry-after: 0`;
// honouring it hot-loops; a provider asking for an hour must not take a
// resource dark for an hour). One home for the numbers, with their rationale:
// usage.mjs.
export function clampRetryAfterMs(retryAfterMs) {
  const ms = Number.isFinite(retryAfterMs) ? retryAfterMs : 0;
  return Math.min(MAX_RATE_LIMIT_BACKOFF_MS, Math.max(MIN_RATE_LIMIT_BACKOFF_MS, ms));
}

// ---------------------------------------------------------------------------
// Pure statistics (W5): every function here is pure — dumpable to a REPL,
// testable without a store. The DURABLE evidence is S2's attempt store; the
// authoritative slots are this register; the state is a projection of both.
// ---------------------------------------------------------------------------

/**
 * The bounded window over a per-endpoint attempt ring, built from
 * HEALTH-ELIGIBLE production rows ONLY (W5's success-rate measure — the
 * classification table §4.4 decides what counts): probe rows are excluded
 * (probe evidence is recorded separately and never counts as production
 * evidence — W8) and so are failure rows the classifier does not count as
 * health signals (user aborts, content-filter refusals, output/context caps —
 * a model that declines gracefully is not degrading). Age-bounded by the same
 * window the ring itself enforces, so a stale success cannot keep an endpoint
 * "proven" forever and the rate is never computed over stale rows.
 */
export function windowStats(attempts, { nowMs, windowMs = ATTEMPT_RING_WINDOW_MS } = {}) {
  const cutoff = nowMs - windowMs;
  let total = 0;
  let successes = 0;
  for (const a of Array.isArray(attempts) ? attempts : []) {
    if (!a || a.probe === true) continue; // probe evidence is not production evidence
    if (a.outcome !== "success" && !isHealthEligibleFailure(a)) continue; // not a health signal
    const at = typeof a.at === "number" ? a.at : null;
    if (at != null && at < cutoff) continue; // age-bounded
    total += 1;
    if (a.outcome === "success") successes += 1;
  }
  return { total, successes, failures: total - successes };
}

/**
 * The endpoint register state for one endpoint, resolved RIGHT NOW. Inputs:
 * `register` — the endpoint's authoritative slots (from this register),
 * `agg` — its S2 aggregates ({ lastSuccessAt, failureStreak, attempts }),
 * `nowMs`. Precedence: authoritative (not-found/forbidden) > the active
 * rate-limit deadline > dead (streak) > degraded (window) > unproven > ok.
 * An ABSENT entry (nothing known) is permissive — null.
 *
 * A fresh successful PROBE (`provenAt`, W8) clears `unproven` and transient
 * `dead` — probe evidence is weaker than production evidence, so it never
 * touches the authoritative slots and never feeds the window stats.
 */
export function deriveEndpointState(
  { register = null, agg = null, nowMs } = {},
) {
  if (register?.notFound) {
    return { state: ENDPOINT_HEALTH_STATES.NOT_FOUND, since: register.notFound.since };
  }
  if (register?.forbidden) {
    return { state: ENDPOINT_HEALTH_STATES.FORBIDDEN, since: register.forbidden.since };
  }
  if (typeof register?.rateLimitedUntil === "number" && register.rateLimitedUntil > nowMs) {
    return { state: ENDPOINT_HEALTH_STATES.RATE_LIMITED, until: register.rateLimitedUntil };
  }
  const provenFresh =
    typeof register?.provenAt === "number" && register.provenAt >= nowMs - ATTEMPT_RING_WINDOW_MS;
  const streak = typeof agg?.failureStreak === "number" ? agg.failureStreak : 0;
  if (!provenFresh && streak >= DEAD_STREAK) return { state: ENDPOINT_HEALTH_STATES.DEAD, streak };
  const stats = windowStats(agg?.attempts, { nowMs });
  if (
    stats.total >= DEGRADED_MIN_ATTEMPTS &&
    stats.successes / stats.total < DEGRADED_MAX_FAILURE_RATE
  ) {
    return { state: ENDPOINT_HEALTH_STATES.DEGRADED, ...stats };
  }
  // `unproven`: lastSuccessAt absent or older than the window (the success no
  // longer proves anything) WITH at least one failure on record. A
  // ring-derived "never" is a lie the moment an old success is evicted —
  // `lastSuccessAt` persists independently of the ring, so the age bound,
  // not eviction, is what retires a success. A fresh probe success proves
  // the endpoint too (W8: probe evidence clears `unproven`).
  const lastSuccessAt = typeof agg?.lastSuccessAt === "number" ? agg.lastSuccessAt : null;
  const successIsStale = lastSuccessAt == null || lastSuccessAt < nowMs - ATTEMPT_RING_WINDOW_MS;
  if (successIsStale && !provenFresh && streak > 0) {
    return { state: ENDPOINT_HEALTH_STATES.UNPROVEN, streak };
  }
  return null;
}

/**
 * The provider-keyed compatibility view (§4.4 precedence): the account state
// takes precedence when present; otherwise the provider's endpoint rollup —
 * any active rate-limit deadline reads `rate-limited`, any `dead` endpoint
 * reads `failing` (the old soft-failing word), else ok.
 */
export function deriveProviderState({ account = null, endpointStates = [], nowMs } = {}) {
  if (account?.state === ACCOUNT_HEALTH_STATES.OUT_OF_CREDIT) {
    return PROVIDER_HEALTH_STATE.OUT_OF_CREDIT;
  }
  if (account?.state === ACCOUNT_HEALTH_STATES.UNAUTHORIZED) {
    return PROVIDER_HEALTH_STATE.UNAUTHORIZED;
  }
  let rateLimitedUntil = null;
  for (const s of endpointStates) {
    if (!s) continue;
    if (s.state === ENDPOINT_HEALTH_STATES.RATE_LIMITED) {
      rateLimitedUntil = Math.max(rateLimitedUntil ?? 0, s.until ?? 0);
    }
    if (s.state === ENDPOINT_HEALTH_STATES.DEAD) return PROVIDER_HEALTH_STATE.FAILING;
  }
  if (rateLimitedUntil != null && rateLimitedUntil > nowMs) {
    return PROVIDER_HEALTH_STATE.RATE_LIMITED;
  }
  return PROVIDER_HEALTH_STATE.OK;
}

/**
 * W8's jittered admission-probe backoff. Attempt 1 → ladder[0] (5m), then up
 * the ladder, capped at the last rung (24h). Jitter spreads ±10% around the
 * base so a fleet of unproven endpoints does not probe in lockstep.
 */
export function nextProbeDelayMs(attemptN, { jitter = Math.random, ladder = PROBE_LADDER_MS } = {}) {
  const n = Number.isInteger(attemptN) && attemptN >= 1 ? attemptN : 1;
  const base = ladder[Math.min(n - 1, ladder.length - 1)] ?? ladder[ladder.length - 1];
  const j = typeof jitter === "function" ? jitter() : 0.5;
  const spread = 0.9 + 0.2 * (Number.isFinite(j) ? Math.min(Math.max(j, 0), 1) : 0.5);
  return Math.round(base * spread);
}

// ---------------------------------------------------------------------------
// Store — load (quarantine on corruption) + save, over a path-keyed mutex.
// Same conventions as the attempts store: atomic writes, `v` stamp, patchStore
// as the only read-modify-write path, a CORRUPT payload quarantined aside and
// rebuilt empty with an alarm row.
// ---------------------------------------------------------------------------

export function createEndpointHealthStore({
  path = endpointHealthPath(),
  ledger = ledgerStore,
  warn = (msg) => console.warn(msg),
  now = Date.now,
} = {}) {
  // The load/quarantine/alarm/save dance is the SHARED quarantined-store
  // factory in ctoStores.mjs (one contract, one quarantine semantics); this
  // wrapper only supplies the register schema and alarm kind.
  return createQuarantinedJsonStore({
    path,
    name: "endpoint-health",
    createPayload: createEndpointHealthPayload,
    validate: validateEndpointHealthPayload,
    alarmKind: "cto.endpoint_health_quarantined",
    ledger,
    warn,
    now,
  });
}

// ---------------------------------------------------------------------------
// Engine — the registers, the write path (S2's provider attempts), the read
// surface routing + the Accounts UI consume, and the W8 recovery machinery.
// ---------------------------------------------------------------------------

export function createEndpointHealth({
  now = Date.now,
  publish = () => {},
  store = createEndpointHealthStore(),
  ledger = ledgerStore,
  warn = (msg) => console.warn(msg),
  attempts = defaultAttempts,
  meterAtLimit = async () => false,
  adapterForProvider = () => null,
  providerIDForAdapter = () => null,
  probeRun = null,
  lastRecoverySuccessAt = () => null,
  jitter = Math.random,
} = {}) {
  // Read-models (rebuilt by reload; every write updates them in place):
  // `reg` mirrors the durable register payload, `aggs` mirrors S2's
  // per-endpoint aggregates. The DURABLE state is the two stores — these
  // caches exist so the sync read surface (routing) never blocks on I/O, and
  // losing them costs one reload, never a state (a restart is never evidence).
  let reg = createEndpointHealthPayload();
  let aggs = {};
  // Presentation bookkeeping (NOT health state — losing it on restart only
  // risks one duplicate push): the last non-ok state published per provider.
  const published = new Map();
  const probeInFlight = new Set();
  let lastSelfDoubtAlarm = -Infinity;
  let lastPersistAlarm = -Infinity;

  async function persistFailed(op, e) {
    warn(`[endpoint-health] persist failed (${op}): ${e?.message ?? e}`);
    try {
      if (now() - lastPersistAlarm > ALARM_RATE_LIMIT_MS) {
        lastPersistAlarm = now();
        void ledger
          .append({ actor: "cto", ts: now(), kind: "cto.endpoint_health_persist_failed", operation: op })
          .catch(() => {});
      }
    } catch { /* best-effort */ }
  }

  /** Rebuild BOTH read-models from the durable stores. */
  async function reload() {
    try {
      reg = validateEndpointHealthPayload(await store.load());
    } catch (e) {
      reg = createEndpointHealthPayload(); // never wedge reads on a bad file
      warn(`[endpoint-health] load failed: ${e?.message ?? e}`);
    }
    const next = {};
    try {
      const fresh = await patchStore(attempts.store, () => ({})); // read without write
      const endpoints = fresh && typeof fresh.endpoints === "object" ? fresh.endpoints : {};
      for (const [key, ep] of Object.entries(endpoints)) {
        next[key] = {
          lastSuccessAt: typeof ep?.lastSuccessAt === "number" ? ep.lastSuccessAt : null,
          failureStreak: typeof ep?.failureStreak === "number" ? ep.failureStreak : 0,
          attempts: Array.isArray(ep?.attempts) ? ep.attempts : [],
        };
      }
    } catch (e) {
      warn(`[endpoint-health] aggregates read failed: ${e?.message ?? e}`);
    }
    aggs = next;
  }

  /** Fold one attempt into the aggregates read-model (mirrors S2's
   *  applyAttempt: health-eligible failures increment the streak; probe rows
   *  land in the ring for the window stats to filter, but never count). */
  function foldIntoAggs(attempt) {
    const key = attempt.endpointKey;
    const prev = aggs[key] ?? { lastSuccessAt: null, failureStreak: 0, attempts: [] };
    const attempts1 = [...prev.attempts, attempt].filter(
      (a) => a == null || typeof a.at !== "number" || a.at >= now() - ATTEMPT_RING_WINDOW_MS,
    );
    const capped = attempts1.length > 200 ? attempts1.slice(attempts1.length - 200) : attempts1;
    const probe = attempt.probe === true;
    const eligible = isHealthEligibleFailure(attempt);
    aggs = {
      ...aggs,
      [key]: {
        lastSuccessAt: !probe && attempt.outcome === "success" ? attempt.at : prev.lastSuccessAt,
        failureStreak: !probe && attempt.outcome === "success"
          ? 0
          : (prev.failureStreak ?? 0) + (eligible ? 1 : 0),
        attempts: capped,
      },
    };
  }

  /** The providerID of an endpointKey ("provider/model"). */
  function providerOf(endpointKey) {
    const i = String(endpointKey).indexOf("/");
    return i === -1 ? String(endpointKey) : String(endpointKey).slice(0, i);
  }

  /** Every endpointKey the registers know for providerID (either register). */
  function endpointKeysOf(providerID) {
    const keys = new Set();
    for (const key of Object.keys(aggs)) {
      if (providerOf(key) === providerID) keys.add(key);
    }
    for (const key of Object.keys(reg.endpoints)) {
      if (providerOf(key) === providerID) keys.add(key);
    }
    return [...keys];
  }

  /** Resolved endpoint states for a provider's endpoints, right now. */
  function endpointStatesOf(providerID) {
    const nowMs = now();
    return endpointKeysOf(providerID)
      .map((key) => ({ key, s: deriveEndpointState({ register: reg.endpoints[key], agg: aggs[key], nowMs }) }))
      .filter((x) => x.s);
  }

  /** The effective account+endpoint rollup for a provider (compat view). */
  function providerState(providerID) {
    return deriveProviderState({
      account: reg.accounts[providerID] ?? null,
      endpointStates: endpointStatesOf(providerID).map((x) => x.s),
      nowMs: now(),
    });
  }

  /** The endpoint register state for one endpointKey (null = permissive). */
  function endpointState(endpointKey) {
    const s = deriveEndpointState({ register: reg.endpoints[endpointKey] ?? null, agg: aggs[endpointKey] ?? null, nowMs: now() });
    return s ? s.state : null;
  }

  /**
   * Surface a non-ok provider state ONCE per transition into that state, in
   * the SAME words the Accounts row uses. Moving back to ok clears the
   * marker so a later relapse re-publishes.
   */
  function mark(providerID, newState) {
    if (newState === PROVIDER_HEALTH_STATE.OK) {
      published.delete(providerID);
      return;
    }
    if (published.get(providerID) === newState) return;
    published.set(providerID, newState);
    try {
      publish({ kind: "provider-health.needs-attention", payload: { providerID, state: newState } });
    } catch { /* never break the write path on a publish */ }
  }

  function refreshPublished(providerID) {
    mark(providerID, providerState(providerID));
  }

  function capProbeRing(entries) {
    return entries.length > PROBE_RING_CAP ? entries.slice(entries.length - PROBE_RING_CAP) : entries;
  }

  // --- write path ---------------------------------------------------------

  /**
   * Fold ONE S2 provider attempt into the registers. Wired (index.mjs) to the
   * attempts recorder's post-persist hook, so every recorded attempt is
   * reflected here exactly once. Probe attempts update probe evidence only.
   */
  async function recordAttempt(attempt) {
    if (!attempt || typeof attempt.endpointKey !== "string" || !attempt.endpointKey.includes("/")) return;
    try {
      if (attempt.probe === true) {
        await recordProbeEvidence(attempt);
      } else {
        await recordProductionAttempt(attempt);
      }
    } catch (e) {
      await persistFailed("recordAttempt", e);
    }
  }

  async function recordProbeEvidence(attempt) {
    await patchStore(store, (fresh) => {
      const probes = capProbeRing([
        ...fresh.probes,
        {
          at: attempt.at ?? now(),
          endpointKey: attempt.endpointKey,
          outcome: attempt.outcome,
          code: attempt.code ?? null,
          httpStatus: Number.isFinite(attempt.httpStatus) ? attempt.httpStatus : null,
          attemptId: attempt.attemptId ?? null,
        },
      ]);
      const endpoints = { ...fresh.endpoints };
      const key = attempt.endpointKey;
      const prev = endpoints[key] && typeof endpoints[key] === "object" ? endpoints[key] : {};
      const next = { ...prev };
      const status = Number.isFinite(attempt.httpStatus) ? attempt.httpStatus : null;
      // Probe evidence is weaker than production evidence (W8): a probe
      // success proves the endpoint (`provenAt` — clears `unproven` and
      // transient `dead`) but NEVER an authoritative state on its own —
      // clearing those is the kind-specific act of the caller (the manual
      // reset clears BEFORE probing; the last-resort pass clears AFTER a
      // pass). A probe that hits an authoritative status DOES re-arm that
      // state — fresh evidence of the very refusal, for any kind.
      if (attempt.outcome === "success") {
        delete next.admission;
        next.provenAt = attempt.at ?? now();
      } else if (status === 404 && !next.notFound) {
        next.notFound = { since: attempt.at ?? now(), reason: { httpStatus: 404, errorName: attempt.errorName ?? null } };
      } else if (status === 403 && !next.forbidden) {
        next.forbidden = { since: attempt.at ?? now(), reason: { httpStatus: 403, errorName: attempt.errorName ?? null } };
      }
      endpoints[key] = next;
      return { probes, endpoints };
    });
    await reload();
  }

  async function recordProductionAttempt(attempt) {
    const at = typeof attempt.at === "number" ? attempt.at : now();
    const status = Number.isFinite(attempt.httpStatus) ? attempt.httpStatus : null;
    const key = attempt.endpointKey;
    const providerID = providerOf(key);
    const nextReg = await patchStore(store, (fresh) => {
      const accounts = { ...fresh.accounts };
      const endpoints = { ...fresh.endpoints };
      const reason = { httpStatus: status, errorName: attempt.errorName ?? null };
      let changed = false;

      const epPrev = endpoints[key] && typeof endpoints[key] === "object" ? endpoints[key] : null;
      if (attempt.outcome === "success") {
        // A success on the endpoint clears EVERY failure-derived slot (one
        // success resets the streak — the aggregates carry that — and
        // re-includes the endpoint) and on the ACCOUNT (auto-recovery,
        // §4.5a) — including the 401 arming counter.
        if (epPrev) { delete endpoints[key]; changed = true; }
        if (accounts[providerID]) { delete accounts[providerID]; changed = true; }
      } else {
        const ep = { ...(epPrev ?? {}), lastAttemptAt: at, lastFailureAt: at, reason };
        changed = true;
        if (status === 404 && !ep.notFound) {
          ep.notFound = { since: at, reason };
        } else if (status === 403 && !ep.forbidden) {
          ep.forbidden = { since: at, reason };
        } else if (status === 429) {
          ep.rateLimitedUntil = at + clampRetryAfterMs(attempt.retryAfterMs);
        }
        // W8 admission: an endpoint that FAILED its first-ever production
        // attempt registers itself with the admission scheduler (first
        // registration). `aggs` here is PRE-fold — it answers "had this
        // endpoint ever succeeded before this attempt?".
        if (!epPrev && typeof aggs[key]?.lastSuccessAt !== "number") {
          ep.admission = {
            pending: true,
            attempt: 0,
            nextProbeAt: at + nextProbeDelayMs(1, { jitter }),
          };
        }
        endpoints[key] = ep;

        const accPrev = accounts[providerID] && typeof accounts[providerID] === "object" ? accounts[providerID] : null;
        if (status === 402) {
          // Account out-of-credit: excluded until evidence, never a clock.
          // A 402 also breaks any consecutive-401 run (no longer consecutive) —
          // the arming counter restarts from zero on the NEXT 401.
          accounts[providerID] = {
            state: ACCOUNT_HEALTH_STATES.OUT_OF_CREDIT,
            since: accPrev?.state === ACCOUNT_HEALTH_STATES.OUT_OF_CREDIT ? accPrev.since : at,
            lastFailureAt: at,
            reason,
            arming401: 0,
          };
        } else if (status === 401) {
          // §4.5a: excluded on the SECOND consecutive observed 401 — the
          // arming counter lives on the account (it spans the provider's
          // endpoints) and persists below the threshold. A successful
          // credential recovery SINCE the previous 401 resets the count to
          // zero first (the credential the 401s were rejecting is gone) —
          // `_lastRecoverySuccessAt` is epoch SECONDS (opencode.mjs), the
          // attempt clock is epoch ms.
          const recoveryAtSec = typeof lastRecoverySuccessAt === "function" ? lastRecoverySuccessAt() : null;
          const recoveryAtMs = Number.isFinite(recoveryAtSec) ? recoveryAtSec * 1000 : null;
          const prevFailureAt = typeof accPrev?.lastFailureAt === "number" ? accPrev.lastFailureAt : null;
          const recoveredSinceLast401 =
            recoveryAtMs != null && (prevFailureAt == null || recoveryAtMs > prevFailureAt);
          const count = recoveredSinceLast401
            ? 1
            : (typeof accPrev?.arming401 === "number" ? accPrev.arming401 : 0) + 1;
          const alreadyUnauthorized = accPrev?.state === ACCOUNT_HEALTH_STATES.UNAUTHORIZED;
          if (alreadyUnauthorized || count >= 2) {
            accounts[providerID] = {
              state: ACCOUNT_HEALTH_STATES.UNAUTHORIZED,
              since: alreadyUnauthorized ? accPrev.since : at,
              lastFailureAt: at,
              reason,
              arming401: count,
            };
          } else {
            accounts[providerID] = { arming401: count, lastFailureAt: at, reason };
          }
        } else if (!accPrev) {
          delete accounts[providerID]; // nothing to add — avoid empty entries
        }
      }
      if (!changed) return {};
      return { accounts, endpoints };
    });
    if (nextReg) {
      reg = validateEndpointHealthPayload(nextReg);
    }
    foldIntoAggs(attempt);
    refreshPublished(providerID);
  }

  // --- read surface (sync, cache-backed) ----------------------------------

  /** Every provider the registers know, mapped to its compat state. */
  function all() {
    const ids = new Set(Object.keys(reg.accounts));
    for (const key of Object.keys(aggs)) ids.add(providerOf(key));
    const out = {};
    for (const id of ids) out[id] = providerState(id);
    return out;
  }

  /** The endpoint states for buildRoutingServices' `services.endpointHealth`. */
  function endpointSnapshot() {
    const nowMs = now();
    const out = {};
    const keys = new Set([...Object.keys(aggs), ...Object.keys(reg.endpoints)]);
    for (const key of keys) {
      const s = deriveEndpointState({ register: reg.endpoints[key] ?? null, agg: aggs[key] ?? null, nowMs });
      if (s) out[key] = s.state;
    }
    return out;
  }

  /**
   * The remaining ms of the provider's longest active rate-limit deadline
   * (never negative — null when none is active). The Accounts UI's
   * "retry in Nm" suffix reads this.
   */
  function retryIn(providerID) {
    const nowMs = now();
    let max = null;
    for (const { s } of endpointStatesOf(providerID)) {
      if (s.state === ENDPOINT_HEALTH_STATES.RATE_LIMITED && typeof s.until === "number") {
        max = Math.max(max ?? 0, s.until - nowMs);
      }
    }
    return max != null && max > 0 ? max : null;
  }

  // --- recovery (W8) ------------------------------------------------------

  /**
   * Clear the ACCOUNT exclusion (and the provider's endpoint exclusions).
   * The authoritative act behind retry(): everything failure-derived goes,
   * the 401 arming counter goes, and the probe scheduler re-admits.
   */
  async function resetProvider(providerID) {
    const keys = endpointKeysOf(providerID);
    await patchStore(store, (fresh) => {
      const accounts = { ...fresh.accounts };
      delete accounts[providerID];
      const endpoints = { ...fresh.endpoints };
      for (const key of keys) delete endpoints[key];
      return { accounts, endpoints };
    });
    published.delete(providerID);
    await reload();
  }

  /**
   * The Accounts "Try again" action (W8 manual reset). Supported providers
   * re-read their meter first (zero model calls) and clear only on funds;
   * custom providers clear optimistically. Either way, after clearing, ONE
   * bounded real probe runs on the provider's best-known endpoint and the
   * result is reported (the evidence flows back through recordAttempt).
   * A user-requested probe success clears an authoritative exclusion — the
   * user is the evidence; a control that cannot perform the recovery it
   * offers is a dead control.
   */
  async function retry(providerID) {
    const adapterId = adapterForProvider(providerID);
    if (adapterId) {
      let atLimit = false;
      try {
        atLimit = !!(await meterAtLimit(adapterId));
      } catch {
        atLimit = false; // a failed re-check must never clear on an absent reading
      }
      if (atLimit) {
        return {
          cleared: false,
          state: providerState(providerID),
          message: `${providerID} still reports out of credit — check the account.`,
        };
      }
    }
    // Pick the probe target BEFORE the reset — the reset wipes the very
    // evidence (last success / least-recent failure) the pick is made from.
    const probeTarget = bestProbeEndpoint(providerID);
    await resetProvider(providerID);
    const probe = probeTarget
      ? await probeEndpoint(probeTarget, { kind: "manual-reset", force: true })
      : null;
    const state = providerState(providerID);
    refreshPublished(providerID);
    return {
      cleared: true,
      state,
      message: probe?.outcome === "success"
        ? `${providerID} is back in the pool — the verification probe succeeded.`
        : probe?.outcome === "failure"
          ? `${providerID} was re-added, but the verification probe failed (${probe.code ?? "error"}).`
          : `${providerID} is back in the pool (out-of-credit flag cleared).`,
    };
  }

  /** The provider's endpoint to probe: most recently successful, else least
   *  recently failed (the W8 last-resort ordering). Null when unknown. */
  function bestProbeEndpoint(providerID) {
    const keys = endpointKeysOf(providerID);
    if (keys.length === 0) return null;
    let best = null;
    let bestSuccess = -1;
    for (const key of keys) {
      const ls = aggs[key]?.lastSuccessAt ?? -1;
      if (ls > bestSuccess) { bestSuccess = ls; best = key; }
    }
    if (bestSuccess > 0) return best;
    let oldest = null;
    let oldestFailure = Infinity;
    for (const key of keys) {
      const lf = reg.endpoints[key]?.lastFailureAt ?? Infinity;
      if (lf < oldestFailure) { oldestFailure = lf; oldest = key; }
    }
    return oldest;
  }

  /**
   * ONE bounded real probe against a specific endpoint. Subject to the
   * endpoint's own probe backoff unless `force`. Schedules the next attempt
   * up the jittered ladder; the OUTCOME itself arrives via recordAttempt
   * (the probe run records a probe:true attempt). Returns the outcome as
   * observed by the caller's probeRun, or null when nothing ran.
   */
  async function probeEndpoint(key, { kind = "admission", force = false } = {}) {
    if (typeof probeRun !== "function") return null;
    const providerID = providerOf(key);
    const i = key.indexOf("/");
    const modelID = i === -1 ? "" : key.slice(i + 1);
    if (!providerID || !modelID) return null;
    if (probeInFlight.has(key)) return null;
    const prev = reg.endpoints[key] ?? {};
    const admission = prev.admission ?? null;
    const lastResortAt = typeof prev.lastResortProbeAt === "number" ? prev.lastResortProbeAt : null;
    if (!force) {
      const dueAt = kind === "manual-reset" || kind === "last-resort"
        ? (lastResortAt != null
          ? lastResortAt + nextProbeDelayMs(Math.max(1, prev.lastResortAttempt ?? 1), { jitter })
          : 0)
        : (admission?.nextProbeAt ?? 0);
      if (now() < dueAt) return null;
    }
    probeInFlight.add(key);
    try {
      let outcome = null;
      try {
        const r = await probeRun({ providerID, modelID, kind });
        outcome = r && typeof r === "object"
          ? {
              ...r,
              outcome: r.outcome ?? (r.ok === true ? "success" : "failure"),
            }
          : { outcome: "failure", code: null };
      } catch (e) {
        outcome = { outcome: "failure", code: e?.code ?? null, message: e?.message ?? String(e) };
      }
      await patchStore(store, (fresh) => {
        const endpoints = { ...fresh.endpoints };
        const cur = endpoints[key] && typeof endpoints[key] === "object" ? endpoints[key] : {};
        const next = { ...cur };
        if (outcome.outcome === "success") {
          // Probe evidence clears unproven/transient-dead: the endpoint is
          // admitted (its authoritative states were already handled by the
          // probe attempt's own evidence path).
          delete next.admission;
        } else if (kind === "admission") {
          const attemptN = (next.admission?.attempt ?? 0) + 1;
          next.admission = {
            pending: true,
            attempt: attemptN,
            nextProbeAt: now() + nextProbeDelayMs(attemptN, { jitter }),
          };
        } else if (kind === "last-resort") {
          next.lastResortAttempt = (next.lastResortAttempt ?? 0) + 1;
          next.lastResortProbeAt = now();
        }
        endpoints[key] = next;
        return { endpoints };
      });
      await reload();
      return outcome;
    } finally {
      probeInFlight.delete(key);
    }
  }

  async function probeBestEndpoint(providerID, opts = {}) {
    const key = bestProbeEndpoint(providerID);
    if (!key) return null;
    return probeEndpoint(key, { ...opts, force: true });
  }

  /**
   * The store sweep's hook: run due admission probes (bounded per tick) and
   * refresh the read-models. Off every hot path — the sweep runs every
   * CTO_STORE_SWEEP_INTERVAL_MS.
   */
  async function tick() {
    const nowMs = now();
    let ran = 0;
    for (const [key, ep] of Object.entries(reg.endpoints)) {
      if (ran >= MAX_PROBES_PER_TICK) break;
      const a = ep?.admission;
      if (!a?.pending || typeof a.nextProbeAt !== "number" || a.nextProbeAt > nowMs) continue;
      const outcome = await probeEndpoint(key, { kind: "admission" });
      if (outcome) ran += 1;
    }
    if (ran === 0) await reload();
    return ran;
  }

  /**
   * W8's last-resort probe: before a no-healthy-endpoint failure, probe the
   * least-recently-failed excluded endpoint (once, subject to that endpoint's
   * own backoff). Returns true when a probe PASS cleared the exclusion (the
   * caller re-routes); false when nothing ran or the probe failed (the
   * failure surfaces).
   */
  async function lastResortRecovery(excludedKeys) {
    if (!Array.isArray(excludedKeys) || excludedKeys.length === 0) return false;
    let target = null;
    let oldest = Infinity;
    for (const key of excludedKeys) {
      if (typeof key !== "string" || !key.includes("/")) continue;
      const lf = reg.endpoints[key]?.lastFailureAt ?? Infinity;
      if (lf < oldest) { oldest = lf; target = key; }
    }
    if (!target) return false;
    const outcome = await probeEndpoint(target, { kind: "last-resort" });
    if (!outcome || outcome.outcome !== "success") return false;
    // A pass clears the exclusion — the probed endpoint re-enters the pool.
    await patchStore(store, (fresh) => {
      const endpoints = { ...fresh.endpoints };
      const cur = endpoints[target] && typeof endpoints[target] === "object" ? endpoints[target] : {};
      const next = { ...cur };
      delete next.notFound;
      delete next.forbidden;
      delete next.rateLimitedUntil;
      delete next.admission;
      endpoints[target] = next;
      return { endpoints };
    });
    await reload();
    refreshPublished(providerOf(target));
    return true;
  }

  /**
   * W8's self-doubt alarm: health excluded every candidate of a verdict. A
   * health model that excludes everything may simply be wrong — fail closed
   * AND say so (ledger row; W7.3 reads the ledger). Rate-limited like every
   * other alarm row.
   */
  async function raiseSelfDoubtAlarm({ excluded = [], reason = "" } = {}) {
    warn(`[endpoint-health] self-doubt: every candidate excluded (${excluded.join(", ") || "none"}) — health may be wrong`);
    if (now() - lastSelfDoubtAlarm < ALARM_RATE_LIMIT_MS) return;
    lastSelfDoubtAlarm = now();
    try {
      await ledger.append({
        actor: "cto",
        ts: now(),
        kind: "cto.health_self_doubt",
        detail: "health excluded every candidate of a no-healthy-endpoint verdict — health may be wrong",
        excluded,
        reason,
      });
    } catch { /* the alarm must never break the caller */ }
  }

  /**
   * W8 #2: a configuration change clears the affected keys (an endpoint or a
   * whole provider's keys) — config churn is not evidence either way, and a
   * re-registered endpoint must re-prove itself: admission re-arms on its
   * next first-failure (this function only clears).
   */
  async function noteConfigChange({ providerID = null, endpointKey = null } = {}) {
    const keys = endpointKey
      ? [endpointKey]
      : providerID
        ? endpointKeysOf(providerID)
        : [];
    await patchStore(store, (fresh) => {
      const accounts = { ...fresh.accounts };
      const endpoints = { ...fresh.endpoints };
      if (providerID) delete accounts[providerID];
      for (const key of keys) delete endpoints[key];
      return { accounts, endpoints };
    });
    if (providerID) published.delete(providerID);
    await reload();
  }

  /**
   * Recovery path #4 (W8): a supported provider's usage reader reporting
   * funds on a normal poll clears its evidence-only out-of-credit flag.
   * Driven by the EXISTING usage poller's `usage.updated` snapshots — no
   * second poller. A snapshot marked exhausted, or no snapshot at all, is no
   * evidence — the flag stays (never clear on an absent reading).
   */
  async function deliverSnapshots(snapshots) {
    let touched = false;
    for (const s of Array.isArray(snapshots) ? snapshots : []) {
      if (!s || typeof s?.provider !== "string") continue;
      if (s.exhausted === true) continue; // still refusing work — no funds
      const providerID = providerIDForAdapter(s.provider);
      if (!providerID) continue;
      const acc = reg.accounts[providerID];
      if (acc?.state === ACCOUNT_HEALTH_STATES.OUT_OF_CREDIT) {
        await patchStore(store, (fresh) => {
          if (!fresh.accounts[providerID]) return {};
          const accounts = { ...fresh.accounts };
          delete accounts[providerID];
          return { accounts };
        });
        touched = true;
      }
    }
    if (touched) {
      await reload();
      for (const s of Array.isArray(snapshots) ? snapshots : []) {
        const providerID = providerIDForAdapter(s?.provider);
        if (providerID) refreshPublished(providerID);
      }
    }
  }

  return {
    recordAttempt,
    reload,
    tick,
    providerState,
    endpointState,
    endpointSnapshot,
    all,
    retryIn,
    retry,
    resetProvider,
    probeEndpoint,
    lastResortRecovery,
    raiseSelfDoubtAlarm,
    noteConfigChange,
    deliverSnapshots,
    get register() { return reg; },
    get aggregates() { return aggs; },
  };
}

/** Split an endpointKey into {providerID, modelID} (shared identity, §4.4). */
export function splitEndpointKey(key) {
  const s = String(key ?? "");
  const i = s.indexOf("/");
  if (i === -1) return { providerID: s, modelID: "" };
  return { providerID: s.slice(0, i), modelID: s.slice(i + 1) };
}
