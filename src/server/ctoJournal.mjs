// src/server/ctoJournal.mjs
// BET-1394 — the CTO journal (§3.2). A durable store for unstructured residue
// that fits no schema (timing observations, meta-lessons, preference
// hypotheses). One entry:
//   { id, text, created, last_accessed, refs: string[] }
//
// Same discipline as the blackboard (§6.3): a hard cap (50), retention by
// access with exponential decay, and eviction AT ADMISSION — a new proposal
// displaces the lowest-retention entry exactly like facts do. Entries are
// appended by the ENGINE only: ephemeral sessions *propose* journal entries in
// their structured output (§3.2 / the A4 output handling), the engine writes
// them. Inspectable (with per-entry delete) under Settings → Internals →
// Profile & rhythm → journal tab.
//
// Pure logic + injected store, in the style of ctoProfile / ctoFacts — no live
// I/O in tests.

import { randomUUID } from "node:crypto";
import { journalStore } from "./ctoStores.mjs";

export const JOURNAL_CAP = 50; // §3.2 hard cap
export const JOURNAL_HALF_LIFE_MS = 30 * 24 * 3_600_000; // 30d decay scale (facts-like)
export const ENTRY_TEXT_MAX = 500; // defensive per-entry text cap
export const PROPOSALS_MAX = 20; // per summary's proposal cap
export const REFS_MAX = 8; // per-entry refs cap

// A single proposal `{ text, refs? }`. The text is the thing that matters;
// refs are optional provenance. Mirrors ctoFacts' validateProposal shape.
export function validateProposal(p) {
  if (!p || typeof p !== "object") return false;
  if (typeof p.text !== "string") return false;
  const t = p.text.trim();
  if (!t || t.length > ENTRY_TEXT_MAX) return false;
  if (p.refs !== undefined) {
    if (!Array.isArray(p.refs) || p.refs.some((r) => typeof r !== "string")) return false;
  }
  return true;
}

export function validateProposalList(list) {
  if (list === undefined) return true; // optional — a summary may propose none
  if (!Array.isArray(list)) return false;
  if (list.length > PROPOSALS_MAX) return false;
  return list.every(validateProposal);
}

// Normalize a validated proposal to its stored form.
export function normalizeProposal(p) {
  const refs = Array.isArray(p.refs)
    ? p.refs.filter((r) => typeof r === "string").slice(0, REFS_MAX)
    : [];
  return { text: p.text.trim(), refs };
}

// Facts-style retention: weight 1, exponential decay from last access, plus an
// access-count boost. An entry never re-accessed decays toward 0 and is the
// first admitted-out at the cap. Mirrors ctoFacts.retentionOf (§6.3).
export function retentionOf(entry, { nowMs = Date.now(), halfLifeMs = JOURNAL_HALF_LIFE_MS } = {}) {
  const t = nowMs;
  const lastAccess = entry?.last_accessed ?? entry?.created ?? t;
  const hours = Math.max(0, (t - lastAccess) / 3_600_000);
  const decay = Math.pow(0.5, hours / (halfLifeMs / 3_600_000));
  const access = 1 + Math.log(1 + (entry?.access_count ?? 0));
  return decay * access;
}

// Displacement at admission: when `entries` would exceed the cap, drop the
// single lowest-retention entry. Pure, mutates the passed array.
export function evictToCap(entries, { cap = JOURNAL_CAP, nowMs } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length <= cap) return list;
  let drop = -1;
  let min = Infinity;
  for (let i = 0; i < list.length; i++) {
    const s = retentionOf(list[i], { nowMs });
    if (s < min) {
      min = s;
      drop = i;
    }
  }
  if (drop >= 0) list.splice(drop, 1);
  return list;
}

// Normalized text key for near-duplicate detection (case/whitespace-folded).
export function dedupeText(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, ENTRY_TEXT_MAX);
}

// Merge `proposals` into an existing entry list: near-duplicates are skipped,
// everything else is admitted fresh (created=last_accessed=now) with eviction
// to the cap applied after each admission. Pure — returns a new array.
export function mergeProposals(existing, proposals, { nowMs = Date.now(), cap = JOURNAL_CAP } = {}) {
  const out = Array.isArray(existing) ? existing.slice() : [];
  const seen = new Set(out.map((e) => dedupeText(e.text)));
  for (const p of proposals) {
    const normalized = normalizeProposal(p);
    if (!normalized.text) continue;
    const key = dedupeText(normalized.text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: randomUUID(), created: nowMs, last_accessed: nowMs, access_count: 1, ...normalized });
    evictToCap(out, { cap, nowMs });
  }
  return out;
}

/**
 * The journal engine over an injectable store. All reads/writes are lazy —
 * first call loads the persisted entries once. Reads never throw (a missing or
 * corrupt store degrades to an empty journal); writes are best-effort.
 *   deps.store — { load, save } (default journalStore)
 *   deps.now   — () => epoch ms (inject a clock for deterministic tests)
 *   deps.cap   — hard cap (default JOURNAL_CAP)
 */
export function createCtoJournal(deps = {}) {
  const { store = journalStore, now = () => Date.now(), cap = JOURNAL_CAP } = deps;
  let entries = [];
  let booted = false;

  async function load() {
    if (booted) return;
    try {
      const raw = await store.load();
      if (raw && Array.isArray(raw.entries)) entries = raw.entries;
    } catch {
      entries = [];
    }
    booted = true;
  }

  async function persist() {
    try {
      await store.save({ v: 1, entries: entries.slice(0, cap) });
    } catch {
      /* best-effort */
    }
  }

  async function list() {
    await load();
    return entries.slice();
  }

  async function addProposals(proposals) {
    if (!Array.isArray(proposals) || proposals.length === 0) return { added: 0 };
    await load();
    const valid = proposals.filter(validateProposal).map(normalizeProposal).slice(0, PROPOSALS_MAX);
    const before = entries.length;
    entries = mergeProposals(entries, valid, { nowMs: now(), cap });
    const added = entries.length - before;
    if (added > 0) await persist();
    return { added };
  }

  async function removeById(id) {
    await load();
    const before = entries.length;
    entries = entries.filter((e) => e.id !== id);
    if (entries.length !== before) await persist();
    return { ok: entries.length !== before };
  }

  async function touch(id) {
    await load();
    let changed = false;
    for (const e of entries) {
      if (e.id === id) {
        e.last_accessed = now();
        e.access_count = (e.access_count ?? 0) + 1;
        changed = true;
      }
    }
    if (changed) await persist();
    return { ok: changed };
  }

  return { init: load, list, addProposals, removeById, touch };
}
