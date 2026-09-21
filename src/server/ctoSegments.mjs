// src/server/ctoSegments.mjs
// BET-1380 — work segmentation, segment summaries, and turn completion (spec
// §5.1, §5.2). The read-layer that turns the ambient opencode event stream
// (A5 evidence) into work episodes ("segments"), bounded by idle events and by
// a per-box recency threshold G that is refit monthly from the box's own
// inter-arrival times.
//
// Pure logic + injected I/O in the style of delegate.mjs / ctoEngine.mjs —
// no live tmux/opencode/network in tests. The model-backed summarization and
// one-liner seams (`summarize`, `computeOneLiner`) are injected; ctoEngine.mjs
// wraps them with the §3.3 ephemeral-session rate gate and wires them to the
// real runner (ctoSessions.runEphemeral) from src/server/index.mjs.
//
// Segmentation rules (§5.1):
//   - A segment is a contiguous run of meaningful activity on one pipeline
//     session (owner user|job — never cto's own sessions).
//   - A segment closes when the inter-event gap exceeds G **or** on
//     `session.idle`. Closing by a gap starts the next segment at the event
//     that triggered the close; closing by idle leaves the session open until
//     the next activity opens a fresh segment.
//   - Turn completion is the session's FIRST `session.idle` after a seen busy —
//     the same sawBusy-then-idle shape delegate.mjs's observeEvent uses. An
//     idle caused by a MessageAbortedError (user abort or the queued-drain
//     abort, detected exactly the way push.mjs's classifier does — by error
//     name) is NOT a turn completion.
//   - At turn completion a one-liner is computed and cached (the Just-finished
//     rail, a later issue, reads it from cache); segment close REUSES the
//     cached one-liner instead of recomputing (§5.2).
//   - On close, ONE `ambient-summarize` call produces the §5.2 schema. If the
//     model output fails schema validation the runner's cascade retries once;
//     on final failure a degraded summary is stored and the failure recorded.
//   - BET-1538 (endpoint-health spec W11): a segment whose summary is EMPTY
//     (the degraded shell) becomes eligible for re-summarisation on a later
//     retry sweep — `retryFailedSummaries()`, ticked by the engine — bounded by
//     a per-segment `summaryAttempts` counter. A `gated` outcome is expected,
//     not a failure: it stays eligible without counting against the cap. Each
//     attempt rides the same injected (engine-gated) `summarize` seam as a
//     first-pass close — no new rate gate, no second budget path. The sweep
//     yields to live work via `presenceCheck` and never replays history (the
//     cold-start backfill in ctoBackfill.mjs owns that).
//   - Segments persist 30d in the segments area of the rollups store (A1),
//     swept by ctoStores.sweepSegments.

import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { engineStateStore, segmentsStore, ledgerStore, patchEngineState } from "./ctoStores.mjs";
import { isUserPromptEvent } from "./ctoEvidence.mjs";
import { validateProposalList } from "./ctoJournal.mjs";
import { safeSummaryCode } from "./ctoRunOutcome.mjs";

export const DEFAULT_G_MINUTES = 45;
export const G_MIN = 20;
export const G_MAX = 90;
export const MINUTE_MS = 60_000;
export const ONE_LINER_MAX = 140;
export const MIN_GAP_SAMPLES = 8; // below this a refit reuses the current G
export const MAX_SEGMENT_EVENTS = 32; // cap per-segment context kept in memory
export const SEGMENT_SUMMARY_VERSION = 1;

// W11 retry sweep bounds. Attempts are per-segment and durable (`summaryAttempts`
// on the stored record); a gated outcome never consumes one. The window bounds
// the scan to recently-written files (mtime) — bulk historic shells are the
// operational cleanup's job (spec W11 step 2), not a resurrect-everything pass.
export const MAX_SUMMARY_ATTEMPTS = 3;
export const MAX_RETRIES_PER_PASS = 4;
export const SUMMARY_RETRY_INTERVAL_MS = 15 * MINUTE_MS;
export const SUMMARY_RETRY_WINDOW_MS = 48 * 60 * MINUTE_MS;

export const OUTCOMES = Object.freeze(["done", "failed", "blocked", "in-progress"]);

export function minutesToMs(mins) {
  return Math.round(mins * MINUTE_MS);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------------------
// Event interpretation
// ---------------------------------------------------------------------------

function evtName(evt) {
  return evt?.properties?.error?.name || evt?.properties?.info?.error?.name || null;
}

function statusType(evt) {
  return (
    evt?.properties?.status?.type ||
    evt?.properties?.info?.status?.type ||
    evt?.properties?.status ||
    null
  );
}

// A `session.status` busy/retry — the turn-start signal for sawBusy.
export function isBusyEvent(evt) {
  if (!evt || typeof evt !== "object" || evt.type !== "session.status") return false;
  const s = statusType(evt);
  return s === "busy" || s === "retry";
}

// An idle signal — either the canonical `session.idle` or a `session.status`
// with type idle. Both can fire for one logical idle; the sawBusy reset below
// makes the pair idempotent.
export function isIdleEvent(evt) {
  if (!evt || typeof evt !== "object" || typeof evt.type !== "string") return false;
  if (evt.type === "session.idle") return true;
  if (evt.type === "session.status") return statusType(evt) === "idle";
  return false;
}

// MessageAbortedError — the abort marker, detected by error name the way
// push.mjs's classifier detects it. An idle following one is NOT a turn
// completion.
export function isAbortEvent(evt) {
  return evt?.type === "session.error" && evtName(evt) === "MessageAbortedError";
}

// Best-effort user prompt text (for degraded summaries / one-line fallback).
export function userPromptText(evt) {
  if (!evt || typeof evt !== "object") return "";
  const p = evt.properties || {};
  const info = p.info || {};
  const msg = p.message || info.message || info;
  const candidate =
    (typeof msg === "object" ? msg?.text : msg) ||
    info?.text ||
    p?.text ||
    "";
  return typeof candidate === "string" ? candidate.trim() : "";
}

// Reduce one event to its segmentation significance. Returns one of
// "busy" | "idle" | "abort" | "prompt" | "touch" | null (null = noise, i.e.
// streaming deltas / config churn — the same events normalizeEvidence drops).
export function segmentEventKind(evt) {
  if (!evt || typeof evt !== "object" || typeof evt.type !== "string") return null;
  const type = evt.type;
  if (type === "session.error") {
    return isAbortEvent(evt) ? "abort" : "touch";
  }
  if (type === "session.idle") return "idle";
  if (type === "session.status") {
    const s = statusType(evt);
    if (s === "busy" || s === "retry") return "busy";
    if (s === "idle") return "idle";
    return null;
  }
  if (isUserPromptEvent(evt)) return "prompt";
  if (type === "session.created" || type === "session.deleted") return "touch";
  return null; // noise
}

// Pure turn-completion predicate: an idle, not caused by an abort, after a
// seen busy. `sessionState` = { sawBusy, abort } maintained by the segmenter.
export function isTurnCompletion(evt, sessionState) {
  if (!isIdleEvent(evt)) return false;
  if (!sessionState) return false;
  if (sessionState.abort) return false; // idle caused by MessageAbortedError
  return sessionState.sawBusy === true;
}

export function truncatePrompt(text, max = ONE_LINER_MAX) {
  const s = String(text ?? "").trim();
  if (s.length <= max) return s;
  return s.slice(0, max);
}

// Tolerant extractor for the model's JSON segment summary — a model may wrap
// the JSON in code fences or prose; we take the first `{` .. last `}`.
// Parse-only: schema validation is validateSegmentSummary's job.
export function parseSegmentSummaryText(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

// The one-liner is plain text (not JSON); test it against the ≤140 constraint.
export function validOneLiner(text) {
  const t = typeof text === "string" ? text.trim() : "";
  return t.length > 0 && t.length <= ONE_LINER_MAX ? t : null;
}

// ---------------------------------------------------------------------------
// §5.2 segment-summary schema validation + degraded fallback
// ---------------------------------------------------------------------------

// §8.2 evidence-atom validity. This is the A6/P2 extension point: the profile
// engine (BET-1393) consumes atoms produced in the SAME §5.2 summary pass — no
// second model call. `direction` is "up"|"down" (binary BKT) or a signed
// magnitude in [-1,1] (graded TrueSkill); `weight` is optional in (0,1];
// `dimension` is required; `ref` is an optional provenance string.
export function validateAtoms(atoms) {
  if (!Array.isArray(atoms)) return false;
  if (atoms.length > 20) return false;
  return atoms.every(
    (a) =>
      a &&
      typeof a === "object" &&
      typeof a.dimension === "string" &&
      !!a.dimension &&
      (a.direction === "up" ||
        a.direction === "down" ||
        (typeof a.direction === "number" && a.direction >= -1 && a.direction <= 1)) &&
      (a.weight === undefined ||
        (typeof a.weight === "number" && a.weight > 0 && a.weight <= 1)) &&
      (a.ref === undefined || typeof a.ref === "string"),
  );
}

export function validateSegmentSummary(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.v !== SEGMENT_SUMMARY_VERSION) return false;
  if (typeof obj.sessionID !== "string" || !obj.sessionID) return false;
  if (obj.project !== undefined && typeof obj.project !== "string") return false;
  if (
    !Array.isArray(obj.window) ||
    obj.window.length !== 2 ||
    typeof obj.window[0] !== "number" ||
    typeof obj.window[1] !== "number" ||
    !(obj.window[0] <= obj.window[1])
  ) {
    return false;
  }
  if (typeof obj.intent !== "string") return false;
  if (!OUTCOMES.includes(obj.outcome)) return false;
  if (
    !Array.isArray(obj.key_events) ||
    obj.key_events.length > 5 ||
    obj.key_events.some(
      (e) =>
        !e ||
        typeof e !== "object" ||
        typeof e.t !== "number" ||
        typeof e.text !== "string",
    )
  ) {
    return false;
  }
  if (
    !Array.isArray(obj.files_touched) ||
    obj.files_touched.some((f) => typeof f !== "string")
  ) {
    return false;
  }
  if (!Array.isArray(obj.prs) || obj.prs.some((p) => typeof p !== "string")) {
    return false;
  }
  if (
    typeof obj.importance !== "number" ||
    !Number.isInteger(obj.importance) ||
    obj.importance < 1 ||
    obj.importance > 10
  ) {
    return false;
  }
  if (typeof obj.one_liner !== "string" || obj.one_liner.length > ONE_LINER_MAX) {
    return false;
  }
  if (obj.atoms !== undefined && !validateAtoms(obj.atoms)) {
    return false;
  }
  if (obj.journalProposals !== undefined && !validateProposalList(obj.journalProposals)) {
    return false;
  }
  return true;
}

export function degradedSegmentSummary({ sessionID, project, start, end, lastUserPrompt } = {}) {
  return {
    v: SEGMENT_SUMMARY_VERSION,
    sessionID,
    project,
    window: [start, end],
    intent: truncatePrompt(lastUserPrompt) || "in-progress",
    outcome: "in-progress",
    key_events: [],
    files_touched: [],
    prs: [],
    importance: 1,
    one_liner: truncatePrompt(lastUserPrompt),
    atoms: [],
    journalProposals: [],
  };
}

// ---------------------------------------------------------------------------
// W11 (BET-1538) retry sweep — the summaryOutcome reader
// ---------------------------------------------------------------------------

// An "empty" summary is the degraded shell persisted when close-time
// summarisation failed or was gated: no key events, no files, no PRs, and no
// importance above the default. Selection is CONTENT-based on purpose (spec
// W11 note): keying on `summaryOutcome` would miss every shell that predates
// the marker. A missing/unparseable summary counts as empty too.
export function isSegmentSummaryEmpty(summary) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return true;
  const noEvents = !Array.isArray(summary.key_events) || summary.key_events.length === 0;
  const noFiles = !Array.isArray(summary.files_touched) || summary.files_touched.length === 0;
  const noPrs = !Array.isArray(summary.prs) || summary.prs.length === 0;
  const lowImportance = !(typeof summary.importance === "number" && summary.importance > 1);
  return noEvents && noFiles && noPrs && lowImportance;
}

// Retry eligibility for a STORED segment record: well-formed enough to
// re-summarise, an empty summary, and under the durable attempt cap.
// Recency is a scan-level mtime pre-filter, not part of the predicate.
export function isRetryEligibleSegment(rec, { maxAttempts = MAX_SUMMARY_ATTEMPTS } = {}) {
  if (!rec || typeof rec !== "object") return false;
  if (typeof rec.sessionID !== "string" || !rec.sessionID) return false;
  const w = rec.window;
  if (!Array.isArray(w) || w.length !== 2 || !Number.isFinite(w[0]) || !Number.isFinite(w[1]) || w[0] > w[1]) return false;
  if (!isSegmentSummaryEmpty(rec.summary)) return false;
  const attempts = typeof rec.summaryAttempts === "number" && Number.isFinite(rec.summaryAttempts)
    ? Math.max(0, Math.floor(rec.summaryAttempts))
    : 0;
  return attempts < maxAttempts;
}

// ---------------------------------------------------------------------------
// G refit — 2-component Gaussian mixture on log inter-arrival times (§5.1-d)
// ---------------------------------------------------------------------------

function gaussianDens(x, mu, s) {
  if (!(s > 0)) return Number.EPSILON;
  const z = (x - mu) / s;
  return Math.exp(-0.5 * z * z) / (Math.sqrt(2 * Math.PI) * s);
}

export function emGaussianMixture(
  xs,
  { iterations = 50 } = {},
) {
  const n = xs.length;
  if (n < MIN_GAP_SAMPLES) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const variance = sorted.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n;
  let mu1 = mean - 1;
  let mu2 = mean + 1;
  let s1 = Math.max(Math.sqrt(variance), 1e-3);
  let s2 = s1;
  let w1 = 0.5;
  let w2 = 0.5;
  for (let it = 0; it < iterations; it++) {
    let n1 = 0;
    let n2 = 0;
    let t1 = 0;
    let t2 = 0;
    let q1 = 0;
    let q2 = 0;
    for (const x of xs) {
      const d1 = w1 * gaussianDens(x, mu1, s1);
      const d2 = w2 * gaussianDens(x, mu2, s2);
      const den = d1 + d2;
      const r1 = den > 0 ? d1 / den : it % 2 === 0 ? 1 : 0;
      const r2 = 1 - r1;
      n1 += r1;
      n2 += r2;
      t1 += r1 * x;
      t2 += r2 * x;
      q1 += r1 * x * x;
      q2 += r2 * x * x;
    }
    if (n1 < 1 || n2 < 1) return null; // collapsed to one cluster
    w1 = n1 / n;
    w2 = n2 / n;
    mu1 = t1 / n1;
    mu2 = t2 / n2;
    s1 = Math.sqrt(Math.max(q1 / n1 - mu1 * mu1, 1e-6));
    s2 = Math.sqrt(Math.max(q2 / n2 - mu2 * mu2, 1e-6));
  }
  return { w1, mu1, s1, w2, mu2, s2 };
}

// The crossing point(s) where w1·N1(x) = w2·N2(x) — the log-space quadratic.
export function mixtureCrossings({ w1, mu1, s1, w2, mu2, s2 }) {
  if (!(s1 > 0) || !(s2 > 0)) return null;
  const A = 1 / (2 * s1 * s1);
  const B = 1 / (2 * s2 * s2);
  const a2 = B - A;
  const b2 = 2 * (A * mu1 - B * mu2);
  const c2 = B * mu2 * mu2 - A * mu1 * mu1 + Math.log(w1 / s1) - Math.log(w2 / s2);
  if (Math.abs(a2) < 1e-12) {
    // equal variances — the crossing is linear
    if (Math.abs(b2) < 1e-12) return null;
    return [-c2 / b2];
  }
  const disc = b2 * b2 - 4 * a2 * c2;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  return [(-b2 + sq) / (2 * a2), (-b2 - sq) / (2 * a2)];
}

// The mixture valley (log-ms): the crossing between the two component means
// where the combined density is lowest. Returns null when there is no clean
// between-means crossing.
export function mixtureValley(components) {
  if (!components) return null;
  const { w1, mu1, s1, w2, mu2, s2 } = components;
  const cross = mixtureCrossings(components);
  if (!cross) return null;
  const lo = Math.min(mu1, mu2);
  const hi = Math.max(mu1, mu2);
  const density = (x) => w1 * gaussianDens(x, mu1, s1) + w2 * gaussianDens(x, mu2, s2);
  let best = null;
  let bestVal = Infinity;
  const candidates = [...cross, (lo + hi) / 2];
  for (const x of candidates) {
    if (x < lo || x > hi) continue;
    const v = density(x);
    if (v < bestVal) {
      bestVal = v;
      best = x;
    }
  }
  return best;
}

// Refit G from `logGapSamples` (log of inter-arrival milliseconds). Returns
// { gMinutes, components?, reused } — `reused:true` when the sample is too
// small or degenerate, keeping the current G.
export function refitG(logGapSamples, { currentGMinutes = DEFAULT_G_MINUTES, gMin = G_MIN, gMax = G_MAX } = {}) {
  if (!Array.isArray(logGapSamples) || logGapSamples.length < MIN_GAP_SAMPLES) {
    return { gMinutes: currentGMinutes, reused: true };
  }
  const components = emGaussianMixture(logGapSamples);
  if (!components) return { gMinutes: currentGMinutes, reused: true };
  const valley = mixtureValley(components);
  if (valley == null) return { gMinutes: currentGMinutes, reused: true };
  const minutes = Math.exp(valley) / MINUTE_MS;
  return { gMinutes: clamp(minutes, gMin, gMax), components, reused: false };
}

// ---------------------------------------------------------------------------
// The segmenter — per-session online segmentation over the evidence stream
// ---------------------------------------------------------------------------

// memory-safe rollup of a session's open segment + idle/busy bookkeeping.
function newSessionState(sessionID, project) {
  return {
    sessionID,
    project,
    sawBusy: false,
    abort: false,
    lastActivityTs: null,
    lastUserPrompt: "",
    segment: null,
    turnChain: Promise.resolve(), // serialized one-liner computes (turn completion)
    closeChain: Promise.resolve(), // serialized segment-close summaries
  };
}

function newSegment(st, ts, evt) {
  return {
    id: `${st.sessionID}-${ts}`,
    sessionID: st.sessionID,
    project: st.project,
    start: ts,
    lastTs: ts,
    lastUserPrompt: st.lastUserPrompt,
    events: [segEventRow(evt, ts)],
  };
}

function segEventRow(evt, ts) {
  const kind = segmentEventKind(evt);
  return {
    t: ts,
    kind: kind === "touch" ? "activity" : kind,
    refs: [evt?.properties?.sessionID].filter(Boolean),
  };
}

// Load the stored G (minutes) from engine-state, or the default.
async function loadStoredG(engineState) {
  try {
    const p = await engineState.load();
    if (p && typeof p === "object" && typeof p.segmentGMinutes === "number") {
      return p.segmentGMinutes;
    }
  } catch {
    /* unreadable → default */
  }
  return DEFAULT_G_MINUTES;
}

/**
 * Create the segmenter. Deps:
 *   segments        — A1 segments store { pathFor, load, save } (default segmentsStore)
 *   ledger          — A1 ledger { append } (default ledgerStore)
 *   engineState     — { load, save } for persisted G (default engineStateStore)
 *   summarize       — async (data) => { ok, summary?, gated? } — the §5.2 summary producer
 *   computeOneLiner — async (data) => string|null — the one-line producer
 *   now             — () => epoch ms (default Date.now)
 *   initialGMinutes — number (default DEFAULT_G_MINUTES; overridden by stored G on boot)
 *   fs              — node:fs/promises-like for the retry scan (default real fsp)
 *   presenceCheck   — async () => true when the user is present → the retry sweep yields
 *   maxSummaryAttempts — W11 per-segment retry cap (default MAX_SUMMARY_ATTEMPTS)
 *   maxRetriesPerPass  — W11 per-sweep work bound (default MAX_RETRIES_PER_PASS)
 *   retryWindowMs      — W11 scan window over segment mtimes (default SUMMARY_RETRY_WINDOW_MS)
 *   retryIntervalMs    — W11 sweep cadence (default SUMMARY_RETRY_INTERVAL_MS)
 */
export function createSegmenter(deps = {}) {
  const {
    segments = segmentsStore,
    ledger = ledgerStore,
    engineState = engineStateStore,
    summarize = async () => ({ ok: false, gated: false }),
    computeOneLiner = async () => null,
    now = () => Date.now(),
    initialGMinutes = DEFAULT_G_MINUTES,
    // §8.2 profile feed (BET-1393): invoked with every produced summary (valid
    // or degraded) so the profile engine ingests its atoms / session length /
    // project in the same pass — no second model call, best-effort.
    onSummary = async () => {},
    fs = fsp,
    presenceCheck = async () => false,
    maxSummaryAttempts = MAX_SUMMARY_ATTEMPTS,
    maxRetriesPerPass = MAX_RETRIES_PER_PASS,
    retryWindowMs = SUMMARY_RETRY_WINDOW_MS,
    retryIntervalMs = SUMMARY_RETRY_INTERVAL_MS,
  } = deps;

  let gMinutes = initialGMinutes;
  let booted = false;
  const sessions = new Map(); // sessionID -> sessionState
  const oneLiners = new Map(); // sessionID -> { oneLiner, ts }
  let gapSamples = []; // global inter-arrival gaps (ms) since the last refit
  let lastRetrySweepAt = -Infinity; // W11 sweep cadence gate
  let retryRunning = false; // W11 re-entry guard

  async function boot() {
    if (booted) return;
    booted = true;
    gMinutes = await loadStoredG(engineState);
    return { gMinutes };
  }

  async function persistG(nextMinutes) {
    try {
      // BET-1425: per-key RMW — only `segmentGMinutes` is owned here.
      await patchEngineState({ segmentGMinutes: nextMinutes }, { engineState });
    } catch {
      /* best-effort */
    }
  }

  async function ledgerLog(entry) {
    try {
      await ledger.append({ actor: "cto", ts: now(), ...entry });
    } catch {
      /* best-effort */
    }
  }

  // A segment closed → one summarize call, then persist (valid summary or
  // degraded), reusing the session's cached one-liner. Never throws. Awaits
  // any pending one-liner compute (turn completion) so close reuses the cached
  // value rather than racing it.
  async function doClose(seg, turnChain) {
    let cached;
    if (turnChain) {
      try {
        cached = await turnChain;
      } catch {
        /* one-liner compute is best-effort */
      }
    }
    const data = {
      sessionID: seg.sessionID,
      project: seg.project,
      start: seg.start,
      end: seg.end,
      events: seg.events,
      lastUserPrompt: truncatePrompt(seg.lastUserPrompt),
      oneLiner: cached ?? truncatePrompt(seg.lastUserPrompt),
    };
    let summary;
    let failed = false;
    let code = null;
    await ledgerLog({ kind: "cto.segment_summary_attempt", sessionID: seg.sessionID, project: seg.project });
    try {
      const res = await summarize(data);
      if (res?.ok && validateSegmentSummary(res.summary)) {
        summary = res.summary;
        // Reuse the cached one-liner at close (§5.2) instead of recomputing.
        if (cached) summary.one_liner = truncatePrompt(cached);
        // Anchor the persisted window to the actual observed bounds.
        summary.window = [seg.start, seg.end];
        summary.sessionID = seg.sessionID;
      } else if (!res?.gated) {
        // A real (non-gated) validation failure — record + degrade.
        summary = degradedSegmentSummary(data);
        failed = true;
        code = safeSummaryCode(res?.code);
      } else {
        // Gated (disabled/paused/rate-limited): expected, persist degraded.
        summary = degradedSegmentSummary(data);
        code = "gated";
      }
    } catch {
      summary = degradedSegmentSummary(data);
      failed = true;
      code = "summary-error";
    }
    if (failed) {
      await ledgerLog({ kind: "cto.segment_summary_failed", sessionID: seg.sessionID, project: seg.project, code });
    }
    try {
      await segments.save(seg.id, {
        v: SEGMENT_SUMMARY_VERSION,
        id: seg.id,
        sessionID: seg.sessionID,
        project: seg.project,
        window: summary.window,
        ts: seg.end,
        summarizedAt: now(), // when the summary was persisted (health §10.5 pipeline-lag measurement)
        summary,
        summaryOutcome: { ok: !failed && code !== "gated", code },
        summaryAttempts: 0, // W11: durable retry-attempt counter (consumed by retryFailedSummaries)
      });
    } catch {
      await ledgerLog({ kind: "cto.segment_persist_failed", sessionID: seg.sessionID, code: "persist-error" });
      return summary;
    }
    await ledgerLog({ kind: "cto.segment_summary_outcome", sessionID: seg.sessionID, code: code ?? "ok" });
    try {
      await onSummary(summary);
    } catch {
      /* profile feed is best-effort */
    }
    return summary;
  }

  function closeSegment(st, endTs) {
    const seg = st.segment;
    if (!seg) return;
    st.segment = null;
    seg.end = endTs;
    // Serialize closes per session so summaries for one session stay ordered.
    const turnChain = st.turnChain;
    st.closeChain = (st.closeChain ?? Promise.resolve()).then(() => doClose(seg, turnChain)).catch(() => {});
  }

  // Turn completion: compute + cache the one-liner; a failed/absent model
  // call degrades to the truncated last user prompt. Never throws.
  async function computeAndCacheOneLiner(data) {
    let oneLiner = null;
    try {
      oneLiner = await computeOneLiner(data);
    } catch {
      oneLiner = null;
    }
    const cached = truncatePrompt(oneLiner) || data.lastUserPrompt;
    oneLiners.set(data.sessionID, { oneLiner: cached, ts: now() });
    return cached;
  }

  // "inter-event gap exceeds G" close on a busy/prompt/touch event.
  function touchActivity(st, ts, evt) {
    if (st.lastActivityTs != null) gapSamples.push(ts - st.lastActivityTs);
    st.lastActivityTs = ts;
    if (st.segment && ts - st.segment.lastTs > minutesToMs(gMinutes)) {
      closeSegment(st, st.segment.lastTs);
    }
    if (!st.segment) {
      st.segment = newSegment(st, ts, evt);
    } else {
      st.segment.lastTs = ts;
      if (st.segment.events.length < MAX_SEGMENT_EVENTS) st.segment.events.push(segEventRow(evt, ts));
    }
  }

  function observe(evt, { sessionID, project, ts = now() } = {}) {
    if (!sessionID || typeof sessionID !== "string") return;
    const kind = segmentEventKind(evt);
    if (!kind) return; // noise — not activity, no boundary
    let st = sessions.get(sessionID);
    if (!st) {
      st = newSessionState(sessionID, project);
      sessions.set(sessionID, st);
    }
    if (project != null) st.project = project;

    if (kind === "abort") {
      st.abort = true;
      return;
    }
    if (kind === "idle") {
      if (isTurnCompletion(evt, st)) {
        const data = {
          sessionID: st.sessionID, project: st.project,
          start: st.segment?.start, end: ts,
          events: structuredClone(st.segment?.events ?? []),
          lastUserPrompt: truncatePrompt(st.lastUserPrompt),
        };
        st.turnChain = (st.turnChain ?? Promise.resolve()).then(() => computeAndCacheOneLiner(data)).catch(() => {});
      }
      st.sawBusy = false;
      st.abort = false;
      closeSegment(st, ts);
      return;
    }
    if (kind === "busy") st.sawBusy = true;
    if (kind === "prompt") {
      const text = userPromptText(evt);
      if (text) {
        st.lastUserPrompt = text;
        if (st.segment) st.segment.lastUserPrompt = text;
      }
    }
    touchActivity(st, ts, evt);
  }

  // Monthly G refit (§5.1-d): fit on the box's own inter-arrival times, persist
  // the new G, and reset the sample window.
  async function monthlyRefit() {
    if (gapSamples.length < MIN_GAP_SAMPLES) {
      return { gMinutes, reused: true, samples: gapSamples.length };
    }
    const logs = gapSamples.map((x) => Math.log(Math.max(x, 1)));
    const out = refitG(logs, { currentGMinutes: gMinutes });
    if (!out.reused) {
      gMinutes = out.gMinutes;
      await persistG(gMinutes);
    }
    gapSamples = [];
    return { gMinutes, reused: out.reused };
  }

  function getOneLiner(sessionID) {
    return oneLiners.get(sessionID)?.oneLiner ?? null;
  }

  // BET-1385: recent completed-turn one-liners for the Just-finished rail
  // (§10.4). Reads the cached one-liner map (A6) — aborted turns never cache a
  // one-liner, so abort exclusion is inherent, not an extra filter. Most recent
  // first, capped.
  function listRecentOneLiners({ withinMs = 24 * 60 * 60 * 1000, cap = 6 } = {}) {
    if (typeof withinMs !== "number" || withinMs <= 0) withinMs = 24 * 60 * 60 * 1000;
    if (typeof cap !== "number" || cap <= 0) cap = 6;
    const t = now();
    const out = [];
    for (const [sessionID, entry] of oneLiners) {
      if (!entry || typeof entry.ts !== "number") continue;
      if (t - entry.ts > withinMs) continue;
      if (typeof entry.oneLiner !== "string" || !entry.oneLiner) continue;
      out.push({ sessionID, oneLiner: entry.oneLiner, ts: entry.ts });
    }
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, cap);
  }

  function getGMinutes() {
    return gMinutes;
  }

  // W11 (BET-1538) retry sweep — the reader `summaryOutcome` never had. Lists
  // stored segments whose summary is empty and whose file was written inside
  // the retry window, then re-runs ONE gated `summarize` per selected segment
  // (the same injected seam a first-pass close uses — beginEphemeral, ambient
  // budget and rate limits apply unchanged; no second gate). Bounds: per-segment
  // attempt cap (durable, `summaryAttempts`), per-pass work cap, sweep cadence,
  // and a full yield while the user is present. A `gated` result persists
  // nothing and consumes no attempt. Never throws.
  async function retryFailedSummaries({ force = false } = {}) {
    const t = now();
    if (!force && t - lastRetrySweepAt < retryIntervalMs) return { kind: "throttled" };
    if (retryRunning) return { kind: "busy" };
    if (typeof segments?.dir !== "string" || typeof segments?.load !== "function" || typeof segments?.save !== "function" || !fs?.readdir || !fs?.stat) {
      return { kind: "unavailable" };
    }
    retryRunning = true;
    try {
      if (await presenceCheck().catch(() => false)) return { kind: "present" }; // yield to live work
      const candidates = await listRetryCandidates({ at: t });
      let attempted = 0;
      let recovered = 0;
      let gated = false;
      for (const { id, rec } of candidates) {
        if (attempted >= maxRetriesPerPass) break;
        const res = await retryOne(id, rec);
        if (res === "gated") {
          gated = true;
          break; // the gate is closed — hammering more candidates is pointless
        }
        attempted += 1;
        if (res === "recovered") recovered += 1;
      }
      lastRetrySweepAt = now();
      return gated ? { kind: "gated", attempted, recovered } : { kind: "done", attempted, recovered };
    } finally {
      retryRunning = false;
    }
  }

  // Scan the segments dir for retry candidates: only files written inside the
  // retry window (mtime pre-filter — bounded, and strictly cheaper than the
  // existing store sweeper's read-every-file pass), loaded and filtered by the
  // pure eligibility predicate. Oldest window first.
  async function listRetryCandidates({ at }) {
    let names = [];
    try {
      names = await fs.readdir(segments.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const cutoff = at - retryWindowMs;
    const out = [];
    for (const e of names) {
      if (!e || !e.isFile || typeof e.name !== "string" || !e.name.endsWith(".json")) continue;
      const id = e.name.slice(0, -5);
      let mtimeMs;
      try {
        mtimeMs = (await fs.stat(join(segments.dir, e.name))).mtimeMs;
      } catch {
        continue;
      }
      if (!(typeof mtimeMs === "number" && mtimeMs >= cutoff)) continue;
      let rec;
      try {
        rec = await segments.load(id);
      } catch {
        continue;
      }
      if (isRetryEligibleSegment(rec, { maxAttempts: maxSummaryAttempts })) out.push({ id, rec });
    }
    out.sort((a, b) => (a.rec.window?.[0] ?? 0) - (b.rec.window?.[0] ?? 0));
    return out;
  }

  // Re-summarise ONE stored segment. Returns "recovered" | "failed" | "gated".
  // The transcript evidence the producer reads comes from the opencode store
  // via sessionID + window (ctoSegmentEvidence), so the retry data needs only
  // the anchors the stored record already carries — events stay empty (the
  // in-memory buffer is long gone) and the prompt echo rides along from the
  // degraded summary. Success overwrites the shell exactly like a first-pass
  // close; failure persists only the attempt counter + outcome marker, leaving
  // the degraded summary and `summarizedAt` (§10.5 lag truth) untouched.
  async function retryOne(id, rec) {
    const promptEcho = typeof rec.summary?.one_liner === "string" && rec.summary.one_liner ? rec.summary.one_liner : undefined;
    const data = {
      sessionID: rec.sessionID,
      project: rec.project,
      start: rec.window[0],
      end: rec.window[1],
      events: [],
      lastUserPrompt: promptEcho,
      oneLiner: promptEcho,
    };
    await ledgerLog({ kind: "cto.segment_summary_attempt", sessionID: rec.sessionID, project: rec.project, retry: true });
    let res = null;
    try {
      res = await summarize(data);
    } catch {
      res = { ok: false, gated: false, code: "summary-error" };
    }
    if (res?.gated) return "gated";
    if (res?.ok && validateSegmentSummary(res.summary)) {
      const summary = res.summary;
      summary.window = [rec.window[0], rec.window[1]];
      summary.sessionID = rec.sessionID;
      if (!summary.one_liner && promptEcho) summary.one_liner = promptEcho;
      try {
        await segments.save(id, {
          ...rec,
          summary,
          summaryOutcome: { ok: true, code: null },
          summarizedAt: now(),
        });
      } catch {
        await ledgerLog({ kind: "cto.segment_persist_failed", sessionID: rec.sessionID, code: "persist-error", retry: true });
        return "failed";
      }
      await ledgerLog({ kind: "cto.segment_summary_outcome", sessionID: rec.sessionID, code: "ok", retry: true });
      try {
        await onSummary(summary);
      } catch {
        /* profile feed is best-effort */
      }
      return "recovered";
    }
    const code = safeSummaryCode(res?.code);
    try {
      await segments.save(id, {
        ...rec,
        summaryAttempts: (typeof rec.summaryAttempts === "number" && Number.isFinite(rec.summaryAttempts) ? Math.max(0, Math.floor(rec.summaryAttempts)) : 0) + 1,
        summaryOutcome: { ok: false, code },
      });
    } catch {
      /* best-effort — the cap just doesn't advance this pass */
    }
    await ledgerLog({ kind: "cto.segment_summary_failed", sessionID: rec.sessionID, project: rec.project, code, retry: true });
    return "failed";
  }

  return {
    observe,
    monthlyRefit,
    retryFailedSummaries,
    boot,
    getGMinutes,
    getOneLiner,
    listRecentOneLiners,
    get gapSampleCount() {
      return gapSamples.length;
    },
    get openSegmentCount() {
      return sessions.size;
    },
    // exposed for tests / diagnostics
    _sessions: sessions,
    _gapSamples: gapSamples,
    _oneLiners: oneLiners,
  };
}
