// src/server/ctoDigest.mjs
// BET-1383 — the digest engine (spec §5.4–5.5). Consumes A7's rollups (folded
// day/hour reads) + A8's needs-you cards to compose the "here's what happened
// while you were away" digest.
//
// Properties (each honored below and asserted in ctoDigest.test.mjs):
//   - Granularity selection from Δ = now − last_seen, using the fitted G from
//     the segmenter plus the two fixed policy constants 16h and 3d (§5.4):
//         Δ < G              → read live events (item unit: events)
//         G ≤ Δ < 16h        → segment summaries (work episodes per project)
//         16h ≤ Δ ≤ 3d       → hour/day rollups (sessions/threads w/ outcomes)
//         Δ > 3d             → day rollups (themes + trends)
//   - One mid-class model call at generation time (`digest-compose`, §12.3),
//     fed the Δ-appropriate slice + open needs-you items + facts changed in
//     window (+ an injectable tool-probe seam). Output = ordered digest items
//     {tier, text, sub?, refs[], deep?}.
//   - Tier lattice is deterministic and outranks any learned score:
//     blocker ≫ failure ≫ decision-made ≫ shipped/milestone ≫ external ≫
//     progress. Blockers are EXTRACTED OUT into needs-you cards (§10.3) and
//     never occupy a digest slot — the composition strips any blocker-tier
//     item and the validator refuses obvious strays (D15).
//   - "Nothing important happened" is a legal output (renders the resting
//     state) — empty `items` is valid.
//   - Single-flight: generation holds a server-side lock keyed by absence-
//     window id; concurrent triggers JOIN the in-flight generation rather than
//     start a second. Generation state is published as a `{kind:"digestState"}`
//     bus event; the Digest-now button renders the server's state.
//   - `digests/` persistence (last 30 — retention sweep lives in ctoStores).
//   - Timing scheduler (§5.5, D9): learned median of digest-open times over
//     the trailing 14 days once ≥ 7 opens exist → else 30 min before the
//     rising edge of the dominant workday component (§8.2, injectable) → else
//     09:00 in the profile's inferred timezone when confidence is high → else
//     09:00 box-local.
//   - Digest-push honors informational deferral (desktop-first §3.4) and only
//     fires when the §10.5 toggle is on; the toggle itself ships in A12, so
//     `digestPushEnabled` defaults off here.
//
// Pure logic + injected I/O in the style of ctoRollups.mjs / ctoEngine.mjs —
// no live tmux/opencode/network in tests. All model/store/presence/timing
// seams are injectable (`runEphemeral`, `digests`, `presence`, `getGMinutes`,
// `listOpenCards`, `factsChanged`, `probeFindings`, `loadSlice`,
// `pushDigest`, `now`, `publish`, `getRisingEdge`, `getInferredTz`).

import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import {
  digestsStore,
  ledgerStore,
  rollupsStore,
  segmentsStore,
  factsStore,
} from "./ctoStores.mjs";
import { DEFAULT_G_MINUTES, minutesToMs } from "./ctoSegments.mjs";
import { startPoller } from "./startPoller.mjs";

export const DIGEST_VERSION = 1;

// Local (box-zone) day boundary for a timestamp (ms → local midnight epoch).
// Kept local — a trivial date helper independent of the rollup/segment
// pipelines this module otherwise reads from.
export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

// §5.4 fixed policy constants (deliberately not G-derived).
export const SIXTEEN_HOURS_MS = 16 * HOUR_MS;
export const THREE_DAYS_MS = 3 * DAY_MS;

// §5.4 constant item budget at every granularity.
export const DIGEST_MIN_ITEMS = 4;
export const DIGEST_MAX_ITEMS = 7;

// §5.5 timing constants.
export const STALE_MS = 30 * 60_000; // regenerate on view-open if older than this
export const RISING_EDGE_LEAD_MS = 30 * 60_000; // 30 min before the rising edge
export const LEARNED_WINDOW_DAYS = 14;
export const LEARNED_MIN_OPENS = 7;
export const DEFAULT_DIGEST_MS_INTO_DAY = 9 * HOUR_MS; // 09:00 box-local fallback
export const INFERRED_TZ_CONFIDENCE_HIGH = 0.8;

// §5.5 tier lattice — deterministic ordering (index 0 = highest priority),
// outranks any learned score. `blocker` ranks first but is never a digest
// item (D15): blockers are extracted into needs-you cards.
export const TIER_ORDER = Object.freeze([
  "blocker",
  "failure",
  "decision-made",
  "shipped/milestone",
  "external",
  "progress",
]);

export const SCHEDULER_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Granularity selection (§5.4)
// ---------------------------------------------------------------------------

export function selectGranularity(absenceDeltaMs, { gMinutes = DEFAULT_G_MINUTES } = {}) {
  const gMs = minutesToMs(gMinutes);
  if (absenceDeltaMs < gMs) {
    return { reads: "events", unit: "events", rollupLevels: [] };
  }
  if (absenceDeltaMs < SIXTEEN_HOURS_MS) {
    return { reads: "segments", unit: "work episodes", rollupLevels: [] };
  }
  if (absenceDeltaMs <= THREE_DAYS_MS) {
    return { reads: "rollups", unit: "sessions/threads with outcomes", rollupLevels: ["hour", "day"] };
  }
  return { reads: "rollups", unit: "themes + trends", rollupLevels: ["day"] };
}

// ---------------------------------------------------------------------------
// Tier lattice helpers
// ---------------------------------------------------------------------------

export function tierIndex(tier) {
  return TIER_ORDER.indexOf(tier);
}

// Deterministic descending-priority sort on the tier lattice (stable).
export function sortItemsByTier(items) {
  return [...(items || [])].sort((a, b) => tierIndex(a?.tier) - tierIndex(b?.tier) || 0);
}

// Blockers never occupy a digest slot (D15) — strip any that slip through.
export function stripBlockers(items) {
  return (items || []).filter((it) => it && it.tier !== "blocker");
}

// ---------------------------------------------------------------------------
// Digest shape + validation
// ---------------------------------------------------------------------------

export function validateDigestItem(it) {
  if (!it || typeof it !== "object") return false;
  if (typeof it.tier !== "string" || tierIndex(it.tier) === -1) return false;
  if (typeof it.text !== "string" || it.text.trim().length === 0) return false;
  if (it.sub !== undefined && typeof it.sub !== "string") return false;
  if (it.deep !== undefined && typeof it.deep !== "string") return false;
  if (
    it.refs !== undefined &&
    (!Array.isArray(it.refs) || !it.refs.every((r) => typeof r === "string"))
  ) {
    return false;
  }
  return true;
}

// The digest payload shape persisted to `digests/<id>.json` (§13.1).
// `nothingHappened` is a derived flag: true iff items is empty ("Nothing
// important happened" — renders the resting state, §5.5). Empty items are
// legal; a digest is otherwise invalid if it carries stray blocker-tier items
// (D15).
export function validateDigest(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.v !== DIGEST_VERSION) return false;
  if (!Array.isArray(obj.window) || obj.window.length !== 2 || typeof obj.window[0] !== "number" || typeof obj.window[1] !== "number") {
    return false;
  }
  if (typeof obj.generated !== "number") return false;
  if (!Array.isArray(obj.items)) return false;
  if (obj.items.some((it) => it && it.tier === "blocker")) return false;
  return obj.items.every(validateDigestItem);
}

// Tolerant extractor for the model's JSON digest — take the first `{` .. last
// `}` (a model may wrap the JSON in prose or fences). Parse-only; schema
// validation is validateDigest's job.
export function parseDigestText(text) {
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

// Normalize parsed model output into the validated, ordered item list:
// accept valid items, honour an explicit "nothing happened" marker, strip
// blockers, sort by the tier lattice, and cap at the constant budget.
export function normalizeDigestItems(parsed) {
  let raw = Array.isArray(parsed?.items) ? parsed.items : [];
  if (parsed?.nothingHappened === true) raw = [];
  const valid = raw.filter(validateDigestItem);
  return stripBlockers(sortItemsByTier(valid)).slice(0, DIGEST_MAX_ITEMS);
}

export function collectDigestRefs(items) {
  const refs = new Set();
  for (const it of items || []) {
    if (Array.isArray(it?.refs)) for (const r of it.refs) if (typeof r === "string") refs.add(r);
  }
  return Array.from(refs).sort();
}

// ---------------------------------------------------------------------------
// Timing scheduler (§5.5, D9) — pure, injectable
// ---------------------------------------------------------------------------

export function startOfSeconds(ms) {
  return Math.floor(ms / 1000) * 1000;
}

// The next occurrence, at the box's local day boundary, of `msIntoDay`
// ([0, DAY_MS)) — today if still in the future, else tomorrow.
export function nextOccurrence(msIntoDay, now, dayStart = startOfDay(now)) {
  let c = dayStart + msIntoDay;
  if (c <= now) c += DAY_MS;
  return c;
}

// Local UTC offset (hours east of UTC) at `ts`.
export function boxUtcOffsetHoursOf(ts) {
  return -new Date(ts).getTimezoneOffset() / 60;
}

export function medianOf(list) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// The next pre-generation deadline, following the fallback chain:
//   1. learned — median of digest-open times over the trailing 14 days once
//      ≥ `learnedMinOpens` opens exist;
//   2. rising-edge default — `risingEdgeLeadMs` (30 min) before the dominant
//      workday component's rising edge (§8.2), when one exists;
//   3. inferred-TZ 09:00 — when the profile's inferred timezone confidence is
//      high;
//   4. box-local 09:00.
// Returns the absolute epoch-ms of the next run.
export function nextDigestMs({
  now,
  learnedOpenTimes = [],
  risingEdgeMsIntoDay = null,
  inferredTz = null,
  learnedMinOpens = LEARNED_MIN_OPENS,
  risingEdgeLeadMs = RISING_EDGE_LEAD_MS,
  defaultMsIntoDay = DEFAULT_DIGEST_MS_INTO_DAY,
  boxUtcOffsetHours,
} = {}) {
  const dayStart = startOfDay(now);
  if (Array.isArray(learnedOpenTimes) && learnedOpenTimes.length >= learnedMinOpens) {
    const intoDay = learnedOpenTimes.map((t) => (t - startOfDay(t)) % DAY_MS);
    const med = medianOf(intoDay);
    if (med != null) return nextOccurrence(med, now, dayStart);
  }
  if (typeof risingEdgeMsIntoDay === "number" && risingEdgeMsIntoDay >= 0) {
    const target = (((risingEdgeMsIntoDay - risingEdgeLeadMs) % DAY_MS) + DAY_MS) % DAY_MS;
    return nextOccurrence(target, now, dayStart);
  }
  if (inferredTz && typeof inferredTz.utcOffsetHours === "number" && (inferredTz.confidence ?? 0) >= INFERRED_TZ_CONFIDENCE_HIGH) {
    const box = boxUtcOffsetHours != null ? boxUtcOffsetHours : boxUtcOffsetHoursOf(now);
    const target = ((defaultMsIntoDay + (inferredTz.utcOffsetHours - box) * HOUR_MS) % DAY_MS + DAY_MS) % DAY_MS;
    return nextOccurrence(target, now, dayStart);
  }
  return nextOccurrence(defaultMsIntoDay, now, dayStart);
}

// ---------------------------------------------------------------------------
// Context assembly — the `digest-compose` model input (≤12k ctx, §12.3)
// ---------------------------------------------------------------------------

export function buildDigestContext({ granularity, window, slice, needsYou, factsChanged, probes, gMinutes, audience, reports } = {}) {
  const [ws, we] = window;
  const blocks = [];

  const readLine = {
    events: "live events",
    segments: "segment summaries (work episodes per project)",
    rollups: granularity.rollupLevels?.join("/") + " rollups",
  }[granularity?.reads] || "activity";

  blocks.push({
    priority: "high",
    text:
      `You are the Adaptive CTO. Compose a digest of what happened while the user was ` +
      `away — the absence window ${ws}..${we} (${granularity?.reads}, item unit: ${granularity?.unit}). ` +
      `Output ONLY JSON of the form ` +
      `{"items":[{"tier":"<tier>","text":"<short human sentence>","sub":"<optional subtitle>","refs":["<evidenceId>",...],"deep":"<optional expandable technical layer>"}]}. ` +
      `Tiers (highest first): failure, decision-made, shipped/milestone, external, progress. ` +
      `Blockers are NOT digest items (they're handled separately) — never emit a "blocker" tier. ` +
      `Produce ${DIGEST_MIN_ITEMS}-${DIGEST_MAX_ITEMS} concrete, factual items. If nothing important ` +
      `happened, output {"items":[]} (the resting state is legal). ` +
      `Each item may carry refs to evidence (segment/rollup ids). "deep" must be present when an item ` +
      `summarizes technical work (the expandable technical layer); "sub" is an optional secondary line. ` +
      `When a change OVERTURNS a previously-held fact, phrase it as a subordinate clause on the owning item ` +
      `(e.g. a "sub" like "this overturns the earlier priority"), NEVER as a separate section or item.`,
  });
  if (Array.isArray(reports) && reports.length) {
    // BET-1403 (§9.2 invariant 1): actions the CTO executed on its own are
    // injected into the digest input — the model must report each as a
    // progress item; the deterministic aside below guarantees appearance.
    blocks.push({
      priority: "high",
      text:
        `The CTO executed the following actions on its own since the last digest ` +
        `(each MUST appear as a progress-tier item, phrased as a factual report of what was done):\n` +
        reports.map((r) => `- ${typeof r === "string" ? r : r.text}`).join("\n"),
    });
  }
  if (needsYou && needsYou.length) {
    blocks.push({
      priority: "medium",
      text:
        `Open needs-you items requiring the user (do NOT include these as digest items — they live ` +
        `in the needs-you list):\n` +
        needsYou.map((c) => `- [${c.id}] ${c.title || c.body || "needs you"}`).join("\n"),
    });
  }
  if (slice && slice.length) {
    const lines = [];
    for (const it of slice) {
      if (granularity?.reads === "segments") {
        lines.push(`[${it.id}] ${it.oneLiner || "work"}${it.project ? ` (project: ${it.project})` : ""} — window ${it.window ? `${it.window[0]}..${it.window[1]}` : "?"}`);
      } else {
        const bullets = (it.bullets || []).map((b) => `- ${b.text}`).join("\n");
        lines.push(`[${it.id}] ${it.level || ""}${bullets ? `:\n${bullets}` : " (no bullets)"}`);
      }
    }
    blocks.push({ priority: "medium", text: `The ${readLine} to summarize:\n${lines.join("\n")}` });
  }
  if (factsChanged && factsChanged.length) {
    blocks.push({
      priority: "medium",
      text: "Facts changed in this window:\n" + factsChanged.map((f) => `- [${f.id}] ${f.statement}`).join("\n"),
    });
  }
  // §8.4 profile audience block — adapt per-item technicality (μ−2σ + depth
  // pref). Never injected when absent; blockers stay non-technical regardless.
  if (audience && typeof audience.text === "string") {
    blocks.push({ priority: "medium", text: audience.text });
  }
  if (probes && probes.length) {
    blocks.push({
      priority: "low",
      text: "Tool-probe findings:\n" + probes.map((p) => `- ${typeof p === "string" ? p : JSON.stringify(p)}`).join("\n"),
    });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Default input loading — read the Δ-appropriate slice from the stores.
// Blockers are excluded from the slice (they never roll up / occupy a slot,
// §5.4); A8's needs-you cards are surfaced separately via `listOpenCards`.
// ---------------------------------------------------------------------------

export function defaultLoadSlice({ granularity, window, segments = segmentsStore, rollups = rollupsStore, fs = fsp } = {}) {
  return async () => {
    const [ws, we] = window;
    if (granularity?.reads === "segments") {
      let names = [];
      try {
        names = await fs.readdir(segments.dir);
      } catch {
        return [];
      }
      const out = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -5);
        let seg;
        try {
          seg = await segments.load(id);
        } catch {
          continue;
        }
        if (seg && Array.isArray(seg.window) && seg.window[1] > ws && seg.window[0] <= we && seg.summary) {
          if (seg.summary?.outcome === "blocked") continue; // blockers never occupy a slot
          out.push({
            id,
            window: seg.window,
            oneLiner: seg.summary.one_liner || seg.summary.intent || "work",
            outcome: seg.summary.outcome,
            project: seg.project,
          });
        }
      }
      return out.sort((a, b) => a.window[0] - b.window[0]);
    }
    if (granularity?.reads === "rollups") {
      const levels = granularity.rollupLevels?.length ? granularity.rollupLevels : ["day"];
      const out = [];
      for (const level of levels) {
        let names = [];
        try {
          names = await fs.readdir(rollups.dirFor(level));
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.endsWith(".json")) continue;
          const id = name.slice(0, -5);
          let r;
          try {
            r = await rollups.load(level, id);
          } catch {
            continue;
          }
          if (r && Array.isArray(r.window) && r.window[1] > ws && r.window[0] <= we && Array.isArray(r.bullets)) {
            out.push({ id, level, window: r.window, bullets: r.bullets });
          }
        }
      }
      return out.sort((a, b) => a.window[0] - b.window[0]);
    }
    // events granularity: live events are surfaced by the "Now" rail (§10.4);
    // the digest itself has nothing extra to fold here.
    return [];
  };
}

// Facts created within the window (the §5.5 "facts changed in the window"
// input). Reads the per-project facts store (P1 — single-writer path exists).
export function defaultFactsChanged({ window, facts = factsStore, fs = fsp } = {}) {
  return async () => {
    const [ws, we] = window;
    let names = [];
    try {
      names = await fs.readdir(facts.dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      let payload;
      try {
        payload = await facts.load(name.slice(0, -5));
      } catch {
        continue;
      }
      for (const f of Array.isArray(payload?.facts) ? payload.facts : []) {
        if (typeof f?.created === "number" && f.created >= ws && f.created <= we) {
          out.push({ id: f.id, statement: f.statement, kind: f.kind });
        }
      }
    }
    return out;
  };
}

// Degraded fallback when the model call is gated/unavailable/failed: a
// truthful minimal digest. Empty slice → "Nothing important happened"
// ({items: []}); otherwise one "progress" item per slice entry with correct
// refs, capped at the item budget.
export function degradedDigest({ granularity, window, slice, generated, gMinutes } = {}) {
  const items = [];
  const cap = DIGEST_MAX_ITEMS;
  if (granularity?.reads === "segments") {
    for (const it of slice || []) {
      if (items.length >= cap) break;
      items.push({ tier: "progress", text: it.oneLiner || "work", refs: it.id ? [it.id] : [] });
    }
  } else {
    for (const it of slice || []) {
      for (const b of it?.bullets || []) {
        if (items.length >= cap) break;
        items.push({ tier: "progress", text: typeof b?.text === "string" ? b.text : "work", refs: Array.isArray(b.refs) ? b.refs : [] });
      }
      if (items.length >= cap) break;
    }
  }
  return { v: DIGEST_VERSION, granularity, window, generated, items };
}

// ---------------------------------------------------------------------------
// The digest engine
// ---------------------------------------------------------------------------

export function createCtoDigest(deps = {}) {
  const {
    now = () => Date.now(),
    publish = () => {},
    runEphemeral = null, // async ({taskClass, context, deps}) => {text, ok, ...}
    digests = digestsStore,
    segmented = segmentsStore,
    rolled = rollupsStore,
    facts = factsStore,
    ledger = ledgerStore,
    presence = null, // { get(): {lastSeen, absenceDelta} } | null
    getGMinutes = () => DEFAULT_G_MINUTES,
    listOpenCards = async () => [], // A8 open needs-you items
    factsChanged = null, // async ({window}) => [...]  (default reads facts store)
    probeFindings = async () => [], // tool-probe findings (injectable; default none)
    loadSlice = null, // async ({granularity, window}) => slice
    getRisingEdge = async () => null, // ms-into-day of dominant workday rising edge (§8.2) | null
    getInferredTz = async () => null, // {utcOffsetHours, confidence} | null
    getAudience = async () => null, // §8.4 async ({topics}) => audience block | null
    getDeviations = async () => [], // §8.4 deviation-from-baseline asides (user-only)
    trust = null, // BET-1403: trust engine — act-and-report lines (mandatory report, §9.2) + tier changes, announced as progress asides
    getHeldSuggestionCount = async () => 0, // §14.3 silence audit: held suggestion rows (default none)
    getEnabled = async () => false, // top-level ctoEnabled gate for the scheduler
    digestPushEnabled = async () => false, // §10.5 toggle (ships A12) — off by default
    pushDigest = async () => {}, // informational notification honoring router deferral
    drain = async () => {}, // BET-1397: call engine.drainInbox() so unread inbox notes become evidence before composing
    intervalMs = SCHEDULER_INTERVAL_MS,
    fs = fsp,
  } = deps;

  let disposed = false;
  let generating = false;
  let lastGenerated = null;
  let lastDigestId = null;
  let firedScheduledAt = null;
  let stopHandle = null;

  const inFlight = new Map();

  async function safe(fn, ...args) {
    try {
      return await fn(...args);
    } catch {
      return null;
    }
  }

  async function ledgerLog(entry) {
    try {
      await ledger.append({ actor: "cto", ts: now(), ...entry });
    } catch {
      /* best-effort */
    }
  }

  function setGenerating(v) {
    if (generating === v) return;
    generating = v;
    publish({ kind: "digestState", payload: { generationInFlight: generating } });
  }

  // ----- single-flight -----
  function absenceKey(lastSeen) {
    return `digest:${lastSeen == null ? "none" : lastSeen}`;
  }

  // ---- learned timing (§5.5/D9) ----
  // The learned median of observed digest-open times comes from the §14.1
  // ledger instrumentation rows (`cto.digest_opened`), filtered to the
  // trailing LEARNED_WINDOW_DAYS, used once ≥ LEARNED_MIN_OPENS opens exist.
  // The ledger is the single source of truth for open times — no parallel
  // engine-state array.
  async function loadOpens() {
    let rows = [];
    try {
      rows = await ledger.read();
    } catch {
      rows = [];
    }
    const cutoff = now() - LEARNED_WINDOW_DAYS * DAY_MS;
    return rows
      .filter((r) => r?.kind === "cto.digest_opened" && typeof r?.ts === "number" && r.ts >= cutoff)
      .map((r) => r.ts);
  }

  // View-open: records the §14.1 `cto.digest_opened` instrumentation row,
  // which both feeds the learned timing scheduler (via loadOpens above) and
  // the usage instrumentation.
  async function recordOpen() {
    const t = now();
    await ledgerLog({ kind: "cto.digest_opened", ts: t, windowEnd: t });
  }

  // §14.1 instrumentation: per-item open / expand (the UI issue calls this via
  // POST /api/cto/digest/opened).
  //
  // BET-1391: the per-item OPEN path moved into the verdict ledger — the
  // `/opened` route now calls `recordVerdict({...verdict:"open"})` (one path),
  // and this direct ledger write is deleted. Only the whole-digest view-open
  // (`recordOpen` → `cto.digest_opened`, which the learned-timing scheduler
  // reads) remains recorded here.

  async function nextScheduledAt() {
    const opens = await loadOpens();
    const rising = await safe(getRisingEdge);
    const tz = await safe(getInferredTz);
    const boxOffset = boxUtcOffsetHoursOf(now());
    return nextDigestMs({
      now: now(),
      learnedOpenTimes: opens,
      risingEdgeMsIntoDay: typeof rising === "number" ? rising : null,
      inferredTz: tz || null,
      boxUtcOffsetHours: boxOffset,
    });
  }

  // ---- generation ----
  async function doGenerate({ reason = "manual", presenceOf } = {}) {
    const t = now();
    if (!presenceOf) return null;
    // BET-1397 digest-generation breakpoint: fold unread inbox notes into
    // evidence before composing (best-effort — never blocks the digest).
    await safe(drain);
    const gMinutes = (await safe(getGMinutes)) ?? DEFAULT_G_MINUTES;
    const lastSeen = typeof presenceOf.lastSeen === "number" ? presenceOf.lastSeen : t;
    const delta = typeof presenceOf.absenceDelta === "number" ? presenceOf.absenceDelta : Math.max(0, t - lastSeen);
    const granularity = selectGranularity(delta, { gMinutes });
    const window = [lastSeen, t];

    const needsYou = await safe(listOpenCards) ?? [];
    const slice = await (loadSlice ? loadSlice({ granularity, window }) : defaultLoadSlice({ granularity, window, segments: segmented, rollups: rolled, fs })().catch(() => []));
    const factFn = factsChanged ?? defaultFactsChanged({ window, facts, fs });
    const fChanged = await factFn({ window }).catch(() => []);
    const probes = await safe(probeFindings) ?? [];
    // §8.4 profile audience block (μ−2σ + depth pref over the slice's topics).
    const topics = [...new Set((slice || []).map((it) => it.project).filter(Boolean))];
    const audience = await safe(getAudience, { topics });

    // BET-1403: pending trust announcements — act-and-report lines (the
    // mandatory report, §9.2 invariant 1) + tier changes (§9.4). Acts are
    // also injected into the digest input; every row is deterministically
    // appended as a progress aside below so appearance is guaranteed.
    const trustAsides = trust ? ((await safe(trust.listAnnouncements)) ?? []) : [];

    const context = buildDigestContext({ granularity, window, slice: slice || [], needsYou, factsChanged: fChanged, probes, gMinutes, audience, reports: trustAsides.filter((a) => a?.kind === "act") });

    let digest = null;
    if (runEphemeral) {
      try {
        const res = await runEphemeral({ taskClass: "digest-compose", context, deps: { validate: validateDigest } });
        const parsed = parseDigestText(res?.text);
        if (parsed) {
          const items = normalizeDigestItems(parsed);
          const candidate = {
            v: DIGEST_VERSION,
            granularity,
            window,
            generated: t,
            items,
            nothingHappened: items.length === 0,
            refs: collectDigestRefs(items),
          };
          if (validateDigest(candidate)) digest = candidate;
        }
      } catch {
        digest = null;
      }
    }
    if (!digest) {
      const degraded = degradedDigest({ granularity, window, slice: slice || [], generated: t, gMinutes });
      digest = { ...degraded, nothingHappened: degraded.items.length === 0, refs: collectDigestRefs(degraded.items) };
      await ledgerLog({ kind: "cto.digest_degraded", granularity: granularity.reads, window });
    }

    // §8.4 deviation-from-baseline asides — surfaced ONLY as progress-tier
    // digest items for the user, never in any shared artifact (facts/rollups).
    // Deduped against existing items so a digest never carries a repeated
    // aside; `nothingHappened` is left untouched (an aside is not work).
    if (validateDigest(digest)) {
      const deviations = (await safe(getDeviations)) || [];
      if (deviations.length) {
        const extant = new Set(digest.items.map((i) => `${i.tier || ""}:${i.text || ""}`));
        for (const d of deviations) {
          if (!d || !d.text) continue;
          const key = `progress:${d.text}`;
          if (extant.has(key)) continue;
          digest.items.push({ tier: "progress", text: d.text });
          extant.add(key);
        }
        digest.refs = collectDigestRefs(digest.items);
      }
    }

    // BET-1403: trust asides — act-and-report lines (the mandatory report,
    // §9.2 invariant 1) + trust-tier changes (§9.4) appended as progress-tier
    // items, same treatment as the §8.4 deviations. Marked announced only
    // after the digest is persisted, so a failed save re-announces next time.
    const announcedIds = [];
    if (validateDigest(digest) && trustAsides.length) {
      const extant = new Set(digest.items.map((i) => `${i.tier || ""}:${i.text || ""}`));
      for (const a of trustAsides) {
        if (!a || !a.text || !a.id) continue;
        if (extant.has(`progress:${a.text}`)) {
          announcedIds.push(a.id); // already reported (model picked it up)
          continue;
        }
        digest.items.push({ tier: "progress", text: a.text, ...(Array.isArray(a.refs) && a.refs.length ? { refs: a.refs } : {}) });
        extant.add(`progress:${a.text}`);
        announcedIds.push(a.id);
      }
      digest.refs = collectDigestRefs(digest.items);
    }

    const id = String(t);
    let persisted = false;
    try {
      // §14.3 silence audit: the digest carries how many suggestions the CTO
      // held back, so the DigestSection can render the "I held back N — review"
      // aside linking to the gated-out list view (in-digest, not overview).
      const held = await safe(getHeldSuggestionCount);
      if (typeof held === "number" && held > 0) digest.heldSuggestions = held;
      await digests.save(id, digest);
      persisted = true;
    } catch {
      /* best-effort — but the trust queue below is NOT consumed on a failed
         save: an announcement consumed without its digest persisting would
         lose the mandatory act report (§9.2 invariant 1) forever. */
    }
    if (persisted && trust && announcedIds.length) await safe(trust.markAnnounced, announcedIds);
    lastGenerated = t;
    lastDigestId = id;

    await ledgerLog({ kind: "cto.digest_generated", id, granularity: granularity.reads, items: digest.items.length, reason });

    if (reason === "scheduled") {
      const pushOn = await safe(digestPushEnabled);
      if (pushOn) await safe(pushDigest, { digest, granularity });
    }
    return digest;
  }

  function generateDigest(opts = {}) {
    const presenceOf = (presence && typeof presence.get === "function") ? presence.get() : null;
    const key = absenceKey(presenceOf?.lastSeen);
    if (inFlight.has(key)) return inFlight.get(key);
    const job = (async () => {
      setGenerating(true);
      try {
        return await doGenerate({ ...opts, presenceOf });
      } finally {
        setGenerating(false);
      }
    })();
    inFlight.set(key, job);
    job.finally(() => inFlight.delete(key)).catch(() => {});
    return job;
  }

  // ---- latest digest from the store (restart-safe render, §5.5) ----
  async function getLatest() {
    let names = [];
    try {
      names = await fs.readdir(digests.dir);
    } catch {
      return null;
    }
    const entries = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      let d;
      try {
        d = await digests.load(id);
      } catch {
        continue;
      }
      if (d && validateDigest(d)) entries.push(d);
    }
    if (!entries.length) return null;
    entries.sort((a, b) => b.generated - a.generated);
    return entries[0];
  }

  async function getState() {
    const latest = await safe(getLatest);
    return {
      generationInFlight: generating,
      lastGeneratedAt: latest?.generated ?? null,
      lastDigestId: latest ? String(latest.generated) : null,
    };
  }

  // ---- scheduler ----
  async function schedulerTick() {
    if (disposed) return;
    const enabled = await safe(getEnabled);
    if (!enabled) return;
    const t = now();
    const due = await safe(nextScheduledAt);
    if (typeof due !== "number" || due !== firedScheduledAt) {
      if (typeof due === "number" && t >= due) {
        firedScheduledAt = due;
        void generateDigest({ reason: "scheduled" });
      }
    }
  }

  function start() {
    if (disposed) throw new Error("cto digest engine already disposed");
    stopHandle = startPoller(schedulerTick, { intervalMs, label: "cto-digest" });
    return engine;
  }

  function dispose() {
    disposed = true;
    if (stopHandle) stopHandle.stop?.();
  }

  const engine = {
    actor: "cto",
    start,
    dispose,
    generateDigest,
    getLatest,
    isGenerating: () => generating,
    getState,
    recordOpen,
    nextScheduledAt,
    // exposed for tests / diagnostics
    _now: now,
    _selectGranularity: selectGranularity,
  };

  return engine;
}
