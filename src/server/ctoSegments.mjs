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
//   - Segments persist 30d in the segments area of the rollups store (A1),
//     swept by ctoStores.sweepSegments.

import { engineStateStore, segmentsStore, ledgerStore } from "./ctoStores.mjs";
import { isUserPromptEvent } from "./ctoEvidence.mjs";

export const DEFAULT_G_MINUTES = 45;
export const G_MIN = 20;
export const G_MAX = 90;
export const MINUTE_MS = 60_000;
export const ONE_LINER_MAX = 140;
export const MIN_GAP_SAMPLES = 8; // below this a refit reuses the current G
export const MAX_SEGMENT_EVENTS = 32; // cap per-segment context kept in memory
export const SEGMENT_SUMMARY_VERSION = 1;

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
  };
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
  } = deps;

  let gMinutes = initialGMinutes;
  let booted = false;
  const sessions = new Map(); // sessionID -> sessionState
  const oneLiners = new Map(); // sessionID -> { oneLiner, ts }
  let gapSamples = []; // global inter-arrival gaps (ms) since the last refit

  async function boot() {
    if (booted) return;
    booted = true;
    gMinutes = await loadStoredG(engineState);
    return { gMinutes };
  }

  async function persistG(nextMinutes) {
    try {
      const p = await engineState.load();
      await engineState.save({ ...p, segmentGMinutes: nextMinutes });
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
  async function doClose(seg, st) {
    if (st?.turnChain) {
      try {
        await st.turnChain;
      } catch {
        /* one-liner compute is best-effort */
      }
    }
    const cached = oneLiners.get(seg.sessionID)?.oneLiner;
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
      } else {
        // Gated (disabled/paused/rate-limited): expected, persist degraded.
        summary = degradedSegmentSummary(data);
      }
    } catch {
      summary = degradedSegmentSummary(data);
      failed = true;
    }
    if (failed) {
      await ledgerLog({ kind: "cto.segment_summary_failed", sessionID: seg.sessionID, project: seg.project });
    }
    try {
      await segments.save(seg.id, {
        v: SEGMENT_SUMMARY_VERSION,
        id: seg.id,
        sessionID: seg.sessionID,
        project: seg.project,
        window: summary.window,
        ts: seg.end,
        summary,
      });
    } catch {
      /* persistence is best-effort */
    }
    return summary;
  }

  function closeSegment(st, endTs) {
    const seg = st.segment;
    if (!seg) return;
    st.segment = null;
    seg.end = endTs;
    // Serialize closes per session so summaries for one session stay ordered.
    st.closeChain = (st.closeChain ?? Promise.resolve()).then(() => doClose(seg, st)).catch(() => {});
  }

  // Turn completion: compute + cache the one-liner; a failed/absent model
  // call degrades to the truncated last user prompt. Never throws.
  async function computeAndCacheOneLiner(st) {
    const data = {
      sessionID: st.sessionID,
      project: st.project,
      events: st.segment ? st.segment.events : [],
      lastUserPrompt: truncatePrompt(st.lastUserPrompt),
    };
    let oneLiner = null;
    try {
      oneLiner = await computeOneLiner(data);
    } catch {
      oneLiner = null;
    }
    const cached = truncatePrompt(oneLiner) || truncatePrompt(st.lastUserPrompt);
    oneLiners.set(st.sessionID, { oneLiner: cached, ts: now() });
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
        st.turnChain = (st.turnChain ?? Promise.resolve()).then(() => computeAndCacheOneLiner(st)).catch(() => {});
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

  function getGMinutes() {
    return gMinutes;
  }

  return {
    observe,
    monthlyRefit,
    boot,
    getGMinutes,
    getOneLiner,
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
