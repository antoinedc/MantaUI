// Watcher supersession + auto-created watchers (BET-1398 / spec §4.3, §13.4).
//
// The OLD watcher poller (BET-1165) ran a poll loop: every minute it swept the
// registered watches, ran each watch's query against a surface read, and only
// surfaced a notification when a NLP condition matched AND the surface's
// seenId moved. Its watches lived in cto.json (loadWatches/saveWatches) and
// only understood the on/off presence of a surface — never the actual work
// evidence flowing through the CTO.
//
// This module supersedes that with a STANDING-QUERY engine evaluated over the
// A5 evidence stream — event-driven, NOT a poll loop. A watcher is
//
//     { id, patternSignature,
//       predicate: { kind, params },
//       source, created, lastHit, hits, retired?, legacy? }
//
// evaluated against each evidence event (and, for the windowed kinds, each
// engine tick). Exactly three predicate kinds exist (closed set, §13.4):
//
//   - event-pattern : regex over evidence text/kind. Per-event.
//   - rate-threshold: count of matching events in a window >= threshold.
//   - usage-burn    : ambient spend pace vs the daily cap fraction.
//
// Every predicate kind is validated up front (validatePredicate); a watcher
// register with an unknown kind is rejected loudly. There is no fourth kind —
// new kinds are a spec change, not this module growing ad hoc.
//
// Watcher HITS are themselves high-salience evidence events (kind
// `watcher.hit`, salience `high`) appended to the A1 ledger, and they feed the
// B4 suggestion engine as a candidate source (`sourceKind: "watcher-hit"`, or
// `"watcher-hit-rate"` when the predicate was `rate-threshold`, which earns the
// steep-decay notify rule). This module is pure + injected-I/O in the same DI
// style as the rest of src/server — nothing here touches tmux/opencode.
//
// Auto-created watchers: after each day rollup, recurring themes (>=2
// occurrences of a matchable pattern across the last 7 days of rollup bullets)
// are upserted by patternSignature — never duplicated. Retirement: 30 days
// without a hit, or when the underlying fact/pattern is archived.

import { randomBytes } from "node:crypto";

// Closed set of predicate kinds (spec §13.4). Adding a kind is a spec change.
export const PREDICATE_KINDS = Object.freeze(["event-pattern", "rate-threshold", "usage-burn"]);

export const EVENT_PATTERN = "event-pattern";
export const RATE_THRESHOLD = "rate-threshold";
export const USAGE_BURN = "usage-burn";

// The watcher-hit ledger kind + its evidence salience.
export const WATCHER_HIT_KIND = "watcher.hit";
export const WATCHER_HIT_SALIENCE = "high";
export const WATCHER_CHANNEL = "watcher";

// Auto-created watcher tuning (§13.4).
export const AUTO_MIN_OCCURRENCES = 2; // >=2 occurrences of a pattern
export const AUTO_WINDOW_DAYS = 7; // across the last 7 days of rollup bullets
// Retirement: 30 days without a hit.
export const RETIRE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

// engine-state.json marker that legacy watches were migrated (idempotent).
export const WATCHER_MIGRATION_KEY = "watchers";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function nextId() {
  return randomBytes(4).toString("hex");
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeRegex(pattern) {
  try {
    return pattern == null ? null : new RegExp(String(pattern));
  } catch {
    return null;
  }
}

// Normalize a theme string into a stable pattern signature (lowercased,
// punctuation collapsed). Used to key auto-created watchers so the same theme
// is never duplicated.
export function patternSignatureFor(theme) {
  return String(theme ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

// ---------------------------------------------------------------------------
// Predicate validation (closed set)
// ---------------------------------------------------------------------------

export function validatePredicate(pred) {
  if (!pred || typeof pred !== "object") {
    return { ok: false, error: "predicate is required" };
  }
  const kind = pred.kind;
  if (!PREDICATE_KINDS.includes(kind)) {
    return {
      ok: false,
      error: `unknown predicate kind "${kind}" (allowed: ${PREDICATE_KINDS.join(", ")})`,
    };
  }
  const params = pred.params ?? {};
  if (kind === EVENT_PATTERN) {
    const pattern = params.pattern;
    if (typeof pattern !== "string" || pattern.trim() === "") {
      return { ok: false, error: "event-pattern requires params.pattern (a regex string)" };
    }
    if (safeRegex(pattern) == null) {
      return { ok: false, error: `event-pattern regex is invalid: ${pattern}` };
    }
    return { ok: true };
  }
  if (kind === RATE_THRESHOLD) {
    const threshold = params.threshold;
    const windowMs = params.windowMs;
    if (!Number.isInteger(threshold) || threshold < 1) {
      return { ok: false, error: "rate-threshold requires params.threshold (integer >= 1)" };
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      return { ok: false, error: "rate-threshold requires params.windowMs (> 0)" };
    }
    if (params.pattern != null && params.pattern !== "" && safeRegex(params.pattern) == null) {
      return { ok: false, error: `rate-threshold filter regex is invalid: ${params.pattern}` };
    }
    return { ok: true };
  }
  if (kind === USAGE_BURN) {
    const windowMs = params.windowMs;
    const capFraction = params.capFraction;
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      return { ok: false, error: "usage-burn requires params.windowMs (> 0)" };
    }
    if (!Number.isFinite(capFraction) || capFraction <= 0 || capFraction > 1) {
      return { ok: false, error: "usage-burn requires params.capFraction in (0, 1]" };
    }
    return { ok: true };
  }
  return { ok: false, error: `unknown predicate kind "${kind}"` };
}

// ---------------------------------------------------------------------------
// Pure predicate evaluation
// ---------------------------------------------------------------------------

// event-pattern: regex over evidence text/kind. Default fields = both. Returns
// true when the (cached) regex matches the event's text or kind.
export function eventPatternMatches(pred, event = {}) {
  const params = pred?.params ?? {};
  const re = safeRegex(params.pattern);
  if (re == null) return false;
  const fields = params.fields ?? "both";
  const text = typeof event?.text === "string" ? event.text : "";
  const kind = typeof event?.kind === "string" ? event.kind : "";
  if (fields === "text" && text) return re.test(text);
  if (fields === "kind" && kind) return re.test(kind);
  re.lastIndex = 0;
  if (fields !== "kind" && text && re.test(text)) return true;
  re.lastIndex = 0;
  if (fields !== "text" && kind && re.test(kind)) return true;
  return false;
}

// rate-threshold event filter: does a single evidence event count toward the
// threshold? Honors optional params.pattern / params.eventKind filters.
export function rateEventCounts(pred, event = {}) {
  const params = pred?.params ?? {};
  let matched = true;
  if (params.eventKind != null && params.eventKind !== "") {
    matched = matched && event?.kind === params.eventKind;
  }
  if (matched && params.pattern != null && params.pattern !== "") {
    matched = matched && eventPatternMatches({ params: { ...params, fields: params.fields ?? "both" } }, event);
  }
  return matched;
}

// usage-burn: hit when the ambient spend over `windowMs` is at least
// `capFraction` of the proportional share of the daily cap for that window.
export function usageBurnHit(pred, { spend, capUsd } = {}) {
  const params = pred?.params ?? {};
  const capShare = (capUsd ?? 0) * (params.windowMs / DAY_MS);
  if (!(capShare > 0)) return false;
  return (spend ?? 0) >= params.capFraction * capShare;
}

// ---------------------------------------------------------------------------
// Watcher construction + upsert + retirement
// ---------------------------------------------------------------------------

// Build a watcher record. `patternSignature` is derived when omitted (from the
// predicate). `validate` option (default true) rejects unknown predicate kinds.
export function makeWatcher({ predicate, source = "user", patternSignature, now = Date.now(), id, validate = true } = {}) {
  if (validate) {
    const v = validatePredicate(predicate);
    if (!v.ok) return { ok: false, error: v.error };
  }
  const sig =
    patternSignature || patternSignatureFor(`${predicate?.kind || ""} ${JSON.stringify(predicate?.params ?? {})}`);
  return {
    ok: true,
    watch: {
      id: id || nextId(),
      patternSignature: sig,
      predicate,
      source,
      created: now(),
      lastHit: null,
      hits: 0,
      retired: false,
    },
  };
}

// Upsert a set of candidate watchers keyed by patternSignature — auto-created
// themes never duplicate. Existing watchers matching a signature are left
// untouched (their hit/lastHit history is kept). Returns {next, added, updated}.
export function upsertWatchers(watchers, candidates, { now = Date.now() } = {}) {
  const next = Array.isArray(watchers) ? [...watchers] : [];
  const added = [];
  const updated = [];
  for (const cand of Array.isArray(candidates) ? candidates : []) {
    if (!cand || !cand.patternSignature) continue;
    const built = makeWatcher({ predicate: cand.predicate, source: cand.source || "auto", now });
    if (!built.ok) continue;
    const idx = next.findIndex((w) => w && w.patternSignature === cand.patternSignature);
    if (idx === -1) {
      next.push(built.watch);
      added.push({ patternSignature: cand.patternSignature, id: built.watch.id });
    } else if (next[idx].retired) {
      // Re-armed: an archived theme resurfacing re-activates its watcher.
      next[idx] = { ...next[idx], retired: false, predicate: built.watch.predicate, source: built.watch.source };
      updated.push({ patternSignature: cand.patternSignature, id: next[idx].id, rearmed: true });
    } else {
      updated.push({ patternSignature: cand.patternSignature, id: next[idx].id, rearmed: false });
    }
  }
  return { next, added, updated };
}

// Retire watchers that have gone quiet (no hit for `inactiveAfterMs`) or whose
// patternSignature is in the archived set. Best-effort per watcher — a bad
// record is skipped, never thrown.
export function retireWatchers(watchers, { nowMs = Date.now(), inactiveAfterMs = RETIRE_AFTER_MS, archivedSignatures = [] } = {}) {
  const archived = new Set(Array.isArray(archivedSignatures) ? archivedSignatures : []);
  const next = [];
  const retired = [];
  for (const w of Array.isArray(watchers) ? watchers : []) {
    if (!w || w.retired) {
      if (w) next.push(w);
      continue;
    }
    const quiet = nowMs - (typeof w.lastHit === "number" && w.lastHit > 0 ? w.lastHit : w.created ?? 0) >= inactiveAfterMs;
    const archivedAway = w.patternSignature != null && archived.has(w.patternSignature);
    if (quiet || archivedAway) {
      retired.push({ id: w.id, patternSignature: w.patternSignature, reason: archivedAway ? "archived" : "inactive" });
      continue; // retired watchers are dropped (they can be re-armed by upsert)
    }
    next.push(w);
  }
  return { next, retired };
}

// ---------------------------------------------------------------------------
// Migration from the legacy poller store (cto.json) — idempotent
// ---------------------------------------------------------------------------

// Convert one legacy watch (from the old cto.json watcher store) into a
// standing-query watcher. Natural-language conditions become an alternation of
// their significant keywords (regex-escaped) so a migrated watcher still fires
// on future evidence mentioning those words. A legacy watch that yields no
// meaningful keyword is dropped (never a never-matching dead watcher).
function significantKeywords(text) {
  if (typeof text !== "string") return [];
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOP.get(w));
  return [...new Set(words)];
}

const STOP = new Set(
  "about above after again against all also and any are because been before being below between both but can did does doing down during each few for from further had has have having here how if in into is it its itself just more most much must my no nor not now of off on once only or other our own same should so some such than that the their them then there these they this those through too under until up very was were what when where which while who why will with would you your".split(
    " ",
  ),
);

export function migrateLegacyWatches(legacyWatches, { now = Date.now() } = {}) {
  const out = [];
  for (const w of Array.isArray(legacyWatches) ? legacyWatches : []) {
    if (!w || w.active === false) continue;
    const words = significantKeywords(w.condition);
    if (words.length === 0) continue; // nothing matchable — skip the dead watcher
    const pattern = words.map(escapeRegex).join("|");
    const pred = { kind: EVENT_PATTERN, params: { pattern } };
    const sig = patternSignatureFor(`${w.query || ""} ${w.condition || ""}`);
    out.push({
      id: typeof w.id === "string" && w.id ? w.id : nextId(),
      patternSignature: sig,
      predicate: pred,
      source: "migrated-legacy",
      legacy: {
        surface: typeof w.surface === "string" ? w.surface : undefined,
        query: typeof w.query === "string" ? w.query : undefined,
        condition: typeof w.condition === "string" ? w.condition : undefined,
      },
      created: typeof w.createdAt === "number" ? w.createdAt : now(),
      lastHit: typeof w.lastFiredAt === "number" ? w.lastFiredAt : null,
      hits: 0,
      retired: false,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auto-created watchers from day-rollup bullets
// ---------------------------------------------------------------------------

// Extract candidate "matchable patterns" (normalized failure/tool/test
// identifiers) from a rollup bullet's text. Deterministic heuristics: issue
// keys, file refs, function calls, PascalCase identifiers, bracketed ids.
export function extractSignifiers(text) {
  if (typeof text !== "string") return [];
  const out = new Set();
  // Issue keys: BET-123, MUL-45, ...
  for (const m of text.matchAll(/\b[A-Z]{2,}-\d+\b/g)) out.add(m[0]);
  // File refs: path/name.ext (mjs/js/ts/tsx/py/go/rs/sh/json/yaml...).
  for (const m of text.matchAll(/\b[\w./-]+\.(?:mjs|js|ts|tsx|py|go|rs|sh|jsonc?|ya?ml|sql)\b/g))
    out.add(m[0]);
  // Function calls: foo(), pkg.foo(), foo.bar()
  for (const m of text.matchAll(/\b[\w$.]+\(\)/g)) out.add(m[0]);
  // Bracket ids: [something] where something looks like an identifier.
  for (const m of text.matchAll(/\[([A-Za-z0-9_-]{4,})\]/g)) out.add(m[1]);
  // PascalCase identifiers (classes / tool names), len >= 5.
  for (const m of text.matchAll(/\b[A-Z][a-zA-Z0-9]{4,}\b/g)) out.add(m[0]);
  const trimmed = [];
  for (const s of out) {
    const t = s.trim();
    if (patternSignatureFor(t).length >= 3) trimmed.push(t);
  }
  return [...new Set(trimmed)];
}

// Reduce day rollups to recurring-theme watcher candidates. Counts each
// extracted signifier across the given day-rollup bullets; a signifier present
// in >= `minOccurrences` distinct bullets becomes an event-pattern candidate.
export function extractRecurringThemes(dayRollups, { minOccurrences = AUTO_MIN_OCCURRENCES, now = Date.now(), windowDays = AUTO_WINDOW_DAYS } = {}) {
  const since = now() - windowDays * DAY_MS;
  const count = new Map(); // normalized signifier -> { occurrences, bullets:Set }
  for (const rp of Array.isArray(dayRollups) ? dayRollups : []) {
    if (!rp || rp.level !== "day" || typeof rp.window?.[0] !== "number") continue;
    if (rp.window[0] < since) continue; // only the last 7 days
    for (const b of Array.isArray(rp.bullets) ? rp.bullets : []) {
      const sigs = extractSignifiers(b?.text);
      for (const sig of sigs) {
        const norm = patternSignatureFor(sig);
        if (!norm) continue;
        const cur = count.get(norm) || { occurrences: 0, bullets: new Set(), matched: sig };
        cur.occurrences += 1;
        cur.bullets.add(rp.window[0]);
        cur.matched = sig;
        count.set(norm, cur);
      }
    }
  }
  const candidates = [];
  for (const [norm, info] of count) {
    if (info.bullets.size < minOccurrences) continue; // >=2 bullets (distinct days) share the theme
    candidates.push({
      patternSignature: norm,
      predicate: { kind: EVENT_PATTERN, params: { pattern: escapeRegex(norm), fields: "both" } },
      source: "auto",
    });
  }
  // Deterministic order (upsert is order-independent, but stable tests).
  candidates.sort((a, b) => a.patternSignature.localeCompare(b.patternSignature));
  return candidates;
}

// ---------------------------------------------------------------------------
// Watcher-hit evidence + B4 candidate source
// ---------------------------------------------------------------------------

// The high-salience evidence payload appended to the A1 ledger for a hit. The
// predicate-kind drives the B4 sourceKind: a rate-threshold watch that trips
// earns the steep-decay notify rule (`watcher-hit-rate`).
export function watcherHitPayload(watch, event = {}, { now = Date.now() } = {}) {
  const pk = watch?.predicate?.kind;
  return {
    kind: WATCHER_HIT_KIND,
    salience: WATCHER_HIT_SALIENCE,
    watcherId: watch?.id,
    predicateKind: pk,
    patternSignature: watch?.patternSignature,
    sourceKind: pk === RATE_THRESHOLD ? "watcher-hit-rate" : "watcher-hit",
    text:
      typeof event?.text === "string" && event.text.trim()
        ? event.text.slice(0, 512)
        : `Watcher ${watch?.id} matched`,
    refs: Array.isArray(event?.refs) ? event.refs : [],
    ts: now(),
  };
}

// Convert `watcher.hit` ledger rows into B4 findings for the suggestion
// engine. Stable keying per watcherId so repeated hits for the same watcher
// upsert one card (auto-created watchers never spam).
export function collectWatcherHitsFromLedger(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.kind !== WATCHER_HIT_KIND) continue;
    if (r.salience !== WATCHER_HIT_SALIENCE) continue;
    const pk = r.predicateKind;
    out.push({
      id: `wh:${r.watcherId || "watcher"}`,
      sourceKind: pk === RATE_THRESHOLD ? "watcher-hit-rate" : "watcher-hit",
      text:
        typeof r.text === "string" && r.text.trim()
          ? r.text
          : `Watcher ${r.watcherId || "?"} for ${r.patternSignature || "?"} triggered`,
      refs: Array.isArray(r.refs) ? r.refs : [],
      ts: typeof r.ts === "number" ? r.ts : 0,
      watcherId: r.watcherId,
      patternSignature: r.patternSignature,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The standing-query engine (event-driven, injected I/O)
// ---------------------------------------------------------------------------

// The stateful engine. deps:
//   store          – { load, save } returning/accepting `{ watchers: [] }`
//   ledger         – { append } (A1 evidence ledger)
//   engineState    – { load, save } for the migration marker
//   now            – () => ms timestamp
//   publish        – (evt) => void (optional watcher-hit bus event)
//   getSpendInWindow – async (windowMs) => USD spent over the window (usage-burn)
//   getCapUsd      – async () => daily ambient cap USD (usage-burn)
//
// In-memory, per-watcher window accumulation for rate-threshold (a rolling
// list of matching event timestamps); window state is deliberately ephemeral —
// a rate-threshold watcher recounts from the fresh stream after a restart.
export function createStandingQueryEngine(deps = {}) {
  const {
    store,
    ledger,
    engineState,
    now = () => Date.now(),
    publish = () => {},
    getSpendInWindow = async () => 0,
    getCapUsd = async () => 0,
  } = deps;

  // watcherId -> array of matching event timestamps (rate-threshold window).
  const windowHits = new Map();
  // watcherId -> last usage-burn hit ts (so burn doesn't re-fire every tick).
  const lastBurnHit = new Map();

  async function loadAll() {
    try {
      const payload = await store.load();
      return Array.isArray(payload?.watchers) ? payload.watchers : [];
    } catch {
      return [];
    }
  }

  async function saveAll(watchers) {
    await store.save({ watchers: Array.isArray(watchers) ? watchers : [] });
  }

  async function hit(watch, event = {}) {
    const payload = watcherHitPayload(watch, event, { now });
    try {
      await ledger.append({ channel: WATCHER_CHANNEL, actor: "cto", ts: now(), ...payload });
    } catch {
      /* best-effort */
    }
    // Persist the watcher's moved hit accounting.
    try {
      const all = await loadAll();
      const idx = all.findIndex((w) => w && w.id === watch.id);
      if (idx !== -1) {
        all[idx] = {
          ...all[idx],
          lastHit: now(),
          hits: (typeof all[idx].hits === "number" ? all[idx].hits : 0) + 1,
        };
        await saveAll(all);
      }
    } catch {
      /* best-effort */
    }
    try {
      publish({ kind: "watcher.hit", payload });
    } catch {
      /* best-effort */
    }
    return payload;
  }

  async function evaluateEvent(event = {}) {
    let all;
    try {
      all = await loadAll();
    } catch {
      return;
    }
    const t = now();
    for (const w of all) {
      if (!w || w.retired) continue;
      const pk = w.predicate?.kind;
      try {
        if (pk === EVENT_PATTERN) {
          if (eventPatternMatches(w.predicate, event)) await hit(w, event);
        } else if (pk === RATE_THRESHOLD) {
          if (rateEventCounts(w.predicate, event)) {
            const list = windowHits.get(w.id) || [];
            list.push(t);
            const cutoff = t - (w.predicate.params?.windowMs ?? 0);
            while (list.length && list[0] < cutoff) list.shift();
            windowHits.set(w.id, list);
            if (list.length >= (w.predicate.params?.threshold ?? Infinity)) {
              windowHits.delete(w.id); // reset so it needs a fresh burst
              await hit(w, event);
            }
          }
        }
        // usage-burn is evaluated on the tick, not per-event.
      } catch {
        /* one bad watcher never breaks ingestion */
      }
    }
  }

  // Evaluates windowed kinds (usage-burn) + retirement, driven from the engine
  // tick (a work timer — already gated by pause).
  async function runTick() {
    let all;
    try {
      all = await loadAll();
    } catch {
      return;
    }
    const t = now();
    let changed = false;
    for (const w of all) {
      if (!w || w.retired) continue;
      const pk = w.predicate?.kind;
      if (pk !== USAGE_BURN) continue;
      const windowMs = w.predicate?.params?.windowMs ?? 0;
      const last = lastBurnHit.get(w.id) || 0;
      if (t - last < windowMs) continue; // fire at most once per window
      try {
        const [spend, capUsd] = await Promise.all([getSpendInWindow(windowMs), getCapUsd()]);
        if (usageBurnHit(w.predicate, { spend, capUsd })) {
          lastBurnHit.set(w.id, t);
          await hit(w, {});
          changed = true;
        }
      } catch {
        /* best-effort */
      }
    }
    // Retirement is cheap to run here too (once per tick).
    try {
      const { next, retired } = retireWatchers(all, { nowMs: t });
      if (retired.length > 0) {
        await saveAll(next);
      }
    } catch {
      /* best-effort */
    }
    return changed;
  }

  async function register(input = {}) {
    const built = makeWatcher({ ...input, now });
    if (!built.ok) return { ok: false, error: built.error };
    const all = await loadAll();
    // A watcher with the same patternSignature is added alongside (user
    // registration is distinct from auto-upsert) but the same id is not.
    if (all.some((w) => w && w.id === built.watch.id)) {
      return { ok: false, error: `watcher id already exists: ${built.watch.id}` };
    }
    await saveAll([...all, built.watch]);
    return { ok: true, data: { watch: built.watch } };
  }

  async function unregister(id) {
    if (!id || typeof id !== "string") return { ok: true, data: { removed: false } };
    const all = await loadAll();
    const next = all.filter((w) => w && w.id !== id);
    if (next.length === all.length) return { ok: true, data: { removed: false } };
    await saveAll(next);
    windowHits.delete(id);
    lastBurnHit.delete(id);
    return { ok: true, data: { removed: true } };
  }

  async function list() {
    return (await loadAll()).map((w) => ({
      id: w.id,
      patternSignature: w.patternSignature,
      predicate: w.predicate,
      source: w.source,
      created: w.created,
      lastHit: w.lastHit,
      hits: w.hits,
      retired: w.retired === true,
      legacy: w.legacy,
    }));
  }

  // Auto-create watchers from the last N days of day rollups. Idempotent by
  // patternSignature (upsert never duplicates).
  async function autoCreate(dayRollups) {
    const candidates = extractRecurringThemes(dayRollups, { now });
    if (candidates.length === 0) return { added: [], updated: [] };
    const all = await loadAll();
    const { next, added, updated } = upsertWatchers(all, candidates, { now });
    if (added.length > 0 || updated.some((u) => u.rearmed)) await saveAll(next);
    return { added, updated };
  }

  // One-time migration of legacy cto.json watches, guarded by a marker in
  // engine-state.json. Re-invoking after a successful migration is a no-op.
  async function migrateLegacy(legacyWatches = []) {
    let meta = {};
    try {
      meta = (await engineState.load()) ?? {};
    } catch {
      meta = {};
    }
    if (meta?.[WATCHER_MIGRATION_KEY]?.migrated === true) {
      return { migrated: false, count: 0 };
    }
    const converted = migrateLegacyWatches(legacyWatches, { now });
    if (converted.length > 0) {
      const all = await loadAll();
      const existingIds = new Set(all.map((w) => w?.id));
      const fresh = converted.filter((c) => !existingIds.has(c.id));
      await saveAll([...all, ...fresh]);
    }
    try {
      await engineState.save({
        ...meta,
        [WATCHER_MIGRATION_KEY]: { ...(meta?.[WATCHER_MIGRATION_KEY] || {}), migrated: true, at: now() },
      });
    } catch {
      /* best-effort */
    }
    return { migrated: true, count: converted.length };
  }

  return {
    list,
    register,
    unregister,
    evaluateEvent,
    runTick,
    autoCreate,
    migrateLegacy,
    hitsFromLedger: collectWatcherHitsFromLedger,
  };
}
