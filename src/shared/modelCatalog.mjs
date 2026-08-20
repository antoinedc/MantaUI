// modelCatalog.mjs — pure, provider-agnostic model-catalogue matching.
//
// The SINGLE copy of the matching logic behind an opaque model id ("which
// catalogue entries could this be?") and the catalogue-wide search
// ("typeahead over every known model"). Originally written inside
// src/server/modelCatalog.mjs (BET-1241); moved here so the RENDERER'S
// "Models we couldn't identify" block and the SERVER's routing core share
// one code path instead of two matchers drifting (epic anti-spaghetti rule
// 4: "One code path"). src/server/modelCatalog.mjs re-exports these, so the
// server's public API and its tests are unchanged.
//
// This file is PURE: no I/O, no network, no date. The catalogue data arrives
// as an argument (`entries`); the fetching/caching stays server-side, and
// the renderer fetches the entries over RPC and builds the same matcher
// here.

// Normalise a model identifier for comparison: case-insensitive, collapsing
// `.`, `_`, `/`, whitespace and runs of `-` onto a single `-`. So `Qwen3.6-27B`,
// `qwen3.6_27b` and `qwen3.6-27b` all compare equal.
export function normalize(modelsId) {
  return String(modelsId)
    .toLowerCase()
    .replace(/[\s_./]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Every distinct normalised "handle" an entry can be addressed by: its full
// catalogue id, the bare model segment of that id (after the provider prefix),
// its display name, and its family. Grouping by family is what lets an opaque
// local id like `ornith` resolve to all four sibling sizes instead of guessing
// between them.
export function entryHandles(entry) {
  const keys = new Set();
  const id = entry?.id;
  const name = entry?.name;
  const family = entry?.family;
  if (typeof id === "string" && id !== "") {
    keys.add(normalize(id));
    const seg = id.split("/").pop();
    if (typeof seg === "string" && seg !== "") keys.add(normalize(seg));
  }
  if (typeof name === "string" && name !== "") keys.add(normalize(name));
  if (typeof family === "string" && family !== "") keys.add(normalize(family));
  return keys;
}

/**
 * PURE. Build a read-only matcher over a list of catalogue entries.
 *
 * `lookupModel(catalogId)` — exact match on the catalogue id (case-insensitive
 * and separator-normalised). Returns the entry or null.
 *
 * `matchModel(localModelId)` — resolves an opaque local id to the catalogue
 * entries it could be, on the model id and name (case-insensitive, separators
 * normalised), with family-grouping so a bare family name surfaces every size.
 * Returns `{ kind, candidates }` where `kind` is:
 *   "exact"      — exactly one entry matches;
 *   "ambiguous"  — several entries match (e.g. one family at different sizes);
 *                  the caller must NOT guess between them — never pick between
 *                  candidates of materially different size;
 *   "none"       — meaningless / unidentifiable (e.g. `default`).
 *
 * `allModels()` — the full entry list (for typeahead and modelQuality ranking).
 *
 * @param {Array<object>} entries
 */
export function createModelIndex(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const byHandle = new Map();
  for (const e of list) {
    for (const k of entryHandles(e)) {
      let bucket = byHandle.get(k);
      if (!bucket) {
        bucket = [];
        byHandle.set(k, bucket);
      }
      bucket.push(e);
    }
  }

  return {
    get size() {
      return list.length;
    },
    lookupModel(catalogId) {
      const needle = normalize(catalogId);
      for (const e of list) {
        if (typeof e?.id === "string" && normalize(e.id) === needle) return e;
      }
      return null;
    },
    matchModel(localModelId) {
      const needle = normalize(localModelId);
      const raw = byHandle.get(needle) ?? [];
      // An entry can appear under several handles; dedupe before classifying.
      const candidates = [...new Set(raw)];
      if (candidates.length === 0) return { kind: "none", candidates: [] };
      if (candidates.length === 1) return { kind: "exact", candidates };
      return { kind: "ambiguous", candidates };
    },
    allModels() {
      return list.slice();
    },
  };
}
