// optimizer/activityLog.mjs — the optimizer's trust surface (Optimizer P2.5,
// BET-1347).
//
// EVERY parameter change the optimizer makes on its own is appended here, with
// the evidence it used, so the dashboard has a legible "what did Manta change
// and why" log — the locked decision from BET-1342 is that THIS log is the
// trust surface (no approval queue, no per-knob reset). Rolled-back entries
// stay: the log is honest about the changes that were reverted too.
//
// Damage discipline: `evidence` is a FLAT object of counts and measurements
// ONLY — numbers and short strings that name a metric, never conversation
// content, never file paths, never session titles. This is the "counts only,
// never content" boundary for the on-box log; the shipped telemetry
// (telemetry.mjs) enforces the same boundary for what leaves the box.
//
// Concurrency: several subsystems append (the tuner, the compaction scheduler,
// the eco/regime recorder). Appends serialize through a shared `createMutex`
// so read-modify-write of the store can never interleave and lose an entry.
// The same mutex guards `markReverted`, which mutates an existing entry.

import { statePath } from "../../shared/paths.mjs";
import { createMutex } from "../jsonStore.mjs";

// Persistence file (wired by index.mjs via the shared jsonStore atomic writer).
export const ACTIVITY_LOG_PATH = statePath("optimizer-log.json");

// Retention: whichever bites first — cap the entry count at MAX_ENTRIES, and
// drop anything older than RETAIN_DAYS.
export const MAX_ENTRIES = 200;
export const RETAIN_DAYS = 90;
// How many entries the summary read model exposes (most recent first).
export const SUMMARY_ACTIVITY_CAP = 50;

const DAY_MS = 86_400_000;

const KINDS = new Set(["tune", "eco", "compaction", "guardrail"]);
const VERDICTS = new Set(["kept", "rolled-back", "applied"]);
// The ONLY fields an entry may carry; anything else is dropped on append.
const ENTRY_KEYS = new Set(["id", "ts", "kind", "subject", "from", "to", "verdict", "evidence", "revertedAt"]);

const isStr = (v) => typeof v === "string";
const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);

// A short, unique-enough id for an entry (8 hex chars) — the handle the tuner
// passes to markReverted.
function newId() {
  return Math.random().toString(16).slice(2, 10);
}

// Coerce `evidence` to a FLAT { string|number } map, dropping everything that
// isn't a string or finite number (no booleans, no objects, no arrays) and
// trimming the key list so stored evidence can't balloon.
function normalizeEvidence(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (isStr(v) || isFiniteNum(v)) out[k] = v;
  }
  return out;
}

// Validate + normalize one raw entry. Returns null when the entry is not a
// legible activity record (unknown kind/verdict). Drops unknown fields;
// coerces evidence to counts/measurements only.
function normalizeEntry(raw) {
  const e = raw && typeof raw === "object" ? raw : null;
  if (!e) return null;
  const kind = e.kind;
  const verdict = e.verdict;
  if (!isStr(kind) || !KINDS.has(kind)) return null;
  if (!isStr(verdict) || !VERDICTS.has(verdict)) return null;
  const out = {};
  out.id = isStr(e.id) && e.id ? e.id : undefined;
  out.ts = isFiniteNum(e.ts) ? e.ts : undefined;
  out.kind = kind;
  out.subject = isStr(e.subject) ? e.subject : undefined;
  // from/to may be a number (token count, eco level) or a short label string;
  // keep raw string|number values so the UI can render them either way.
  out.from = e.from;
  out.to = e.to;
  out.verdict = verdict;
  out.evidence = normalizeEvidence(e.evidence);
  out.revertedAt = isFiniteNum(e.revertedAt) ? e.revertedAt : undefined;
  return out;
}

// Strip undefined keys so entries serialize compactly.
function pack(entry) {
  const out = {};
  for (const k of ENTRY_KEYS) {
    if (entry[k] !== undefined && entry[k] !== null) out[k] = entry[k];
  }
  return out;
}

/**
 * The activity log. Injected I/O (mirrors createCounterfactualStore /
 * createPacingState): `load()` returns the persisted log array (or []),
 * `save(entries)` persists it atomically, `now` is the clock (number or
 * zero-arg fn, for tests). Pure logic — no fs access unless the injected
 * load/save touch it.
 *
 * Returns { append, markReverted, recent, snapshot }:
 *   append(entry) — validate + normalize, prepend (newest first), enforce
 *     retention (MAX_ENTRIES / RETAIN_DAYS), persist. Returns {ok, entry?}.
 *   markReverted(id, at) — stamp revertedAt on an existing entry (the tuner
 *     uses this when a kept-then-reverted change settles).
 *   recent(n) — the newest n entries.
 *   snapshot() — the whole log (tests).
 */
export function createActivityLog({ load, save, now, maxEntries = MAX_ENTRIES, retainDays = RETAIN_DAYS } = {}) {
  const mutex = createMutex();
  let state = null;

  const nowMs = () => (typeof now === "function" ? (now() ?? Date.now()) : (now ?? Date.now()));

  async function ensureLoaded() {
    if (!state) {
      const raw = typeof load === "function" ? await load() : [];
      state = Array.isArray(raw) ? raw.map(normalizeEntry).filter(Boolean) : [];
    }
    return state;
  }

  async function persist() {
    if (typeof save !== "function") return;
    await save(state);
  }

  async function append(raw) {
    return mutex.runExclusive(async () => {
      await ensureLoaded();
      const entry = normalizeEntry({
        ...(raw ?? {}),
        id: isStr(raw?.id) && raw.id ? raw.id : newId(),
        ts: isFiniteNum(raw?.ts) ? raw.ts : nowMs(),
      });
      if (!entry) return { ok: false, error: "invalid" };
      const clean = pack(entry);
      state.unshift(clean);
      // Retention — whichever bites first.
      const cutoff = nowMs() - retainDays * DAY_MS;
      state = state.filter((e) => isFiniteNum(e.ts) && e.ts >= cutoff);
      if (state.length > maxEntries) state.length = maxEntries;
      await persist();
      return { ok: true, entry: clean };
    });
  }

  async function markReverted(id, at) {
    return mutex.runExclusive(async () => {
      await ensureLoaded();
      const entry = state.find((e) => e.id === id);
      if (!entry) return { ok: false, error: "not-found" };
      entry.revertedAt = isFiniteNum(at) ? at : nowMs();
      await persist();
      return { ok: true, entry };
    });
  }

  async function recent(n) {
    const s = await ensureLoaded();
    return isFiniteNum(n) ? s.slice(0, n) : s.slice();
  }

  async function snapshot() {
    const s = await ensureLoaded();
    return s.map((e) => ({ ...e }));
  }

  return { append, markReverted, recent, snapshot };
}
