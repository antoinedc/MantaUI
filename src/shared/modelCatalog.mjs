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
// `.`, `_`, whitespace and runs of `-` onto a single `-`. So a model id with
// mixed case, underscore and dots all compare equal after normalisation.
//
// The `/` separator is DELIBERATELY preserved (BET-1303 5.1): flattening it
// destroys the vendor/model boundary (a reseller alias with a trailing
// decoration would collapse onto the bare model segment, losing the exact
// catalogue hit that segment provides). `entryHandles` indexes both the full
// id and the bare segment, so nothing is lost by keeping the slash.
// so nothing is lost by keeping the slash.
export function normalize(modelsId) {
  return String(modelsId)
    .toLowerCase()
    .replace(/[\s_.]+/g, "-")
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

// ---------------------------------------------------------------------------
// Token classifier (BET-1303 5.3) — the structural core of layer 4.
// ---------------------------------------------------------------------------
//
// The insight the layering rests on: in a model id, a token containing a digit
// is identity; a token of pure letters is often decoration (a reseller can
// `-thinking` are noise, while `5.1` vs `5.2` is a different model). Sorting
// tokens by that one property separates the two classes with no list of names
// on either side — a new reseller inventing `-sgx` next month needs no code
// change.

// Split a model id into atomic tokens. Rules, in order:
//  1. lowercase;
//  2. collapse runs of whitespace/underscore to `-`;
//  3. split on any run of chars not in [a-z0-9.] — so BOTH `-` and `/` split,
//     while `.` stays inside a token;
//  4. inside each chunk, split after a run of TWO OR MORE letters that is
//     immediately followed by a digit (`model5` → model,5), but NOT after a
//     single letter (`v3` and `a22b` stay whole);
//  5. drop empties.
function tokenizeModelId(id) {
  const s = String(id).toLowerCase().replace(/[\s_]+/g, "-");
  const chunks = s.split(/[^a-z0-9.]+/);
  const out = [];
  for (const chunk of chunks) {
    if (chunk === "") continue;
    for (const tok of chunk.split(/(?<=[a-z]{2})(?=[0-9])/)) {
      if (tok !== "") out.push(tok);
    }
  }
  return out;
}

// Classify a token list into exactly one class per token:
//   • date     — bare digits of length 4, 6 or 8 (discarded entirely; no part of matching);
//   • size     — `^a?\d+(\.\d+)?[bmk]$` (32b, a22b, 550b);
//   • version  — any remaining token containing a digit, one leading `v` stripped;
//   • soft     — no digit (compared as a SET; duplicates collapse).
function classifyTokens(tokens) {
  const versions = new Set();
  const sizes = new Set();
  const soft = new Set();
  let dated = false;
  for (const t of tokens) {
    if (/^\d+$/.test(t) && (t.length === 4 || t.length === 6 || t.length === 8)) {
      dated = true;
      continue;
    }
    if (/^a?\d+(\.\d+)?[bmk]$/.test(t)) {
      sizes.add(t);
      continue;
    }
    if (/\d/.test(t)) {
      versions.add(t.replace(/^v/, ""));
      continue;
    }
    soft.add(t);
  }
  return { versions, sizes, soft, dated };
}

function setEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// Collapse structurally-identical candidates to one representative (BET-1307).
// A model and its own dated alias (the same model re-released with a date tail)
// classify identically because the classifier discards dates, so they must never
// present as a pair of "Models we couldn't identify" entries. Group by the
// classification (version / size / soft sets) and keep the representative whose
// normalized id is shortest — that deterministically drops the date decoration
// with no name list and no vendor knowledge. Distinct products never share a
// class: a one-word decoration is an extra soft token, siblings differ in the
// size set, and different versions or vendors differ in the version / soft
// sets — so nothing real is ever merged.
function collapseAliases(candidates) {
  const reps = new Map();
  for (const e of candidates) {
    if (!e || typeof e.id !== "string") continue;
    const c = classifyTokens(tokenizeModelId(e.id));
    const sig = [
      [...c.versions].sort().join(","),
      [...c.sizes].sort().join(","),
      [...c.soft].sort().join(","),
    ].join("|");
    const cur = reps.get(sig);
    if (!cur || normalize(e.id).length < normalize(cur.id).length) {
      reps.set(sig, e);
    }
  }
  return [...reps.values()];
}

// Layer 4 admission (5.4a): ALL of — version sets equal; size sets, if
// non-empty on BOTH sides, equal; at least one shared soft token. Equality on
// versions (not subset) is what rejects a same-family id whose version differs
// from the candidate's.
function admittedBy(local, entry, minSharedSoft) {
  if (!setEqual(local.versions, entry.versions)) return false;
  if (local.sizes.size > 0 && entry.sizes.size > 0 && !setEqual(local.sizes, entry.sizes)) {
    return false;
  }
  let shared = 0;
  for (const s of local.soft) if (entry.soft.has(s)) shared++;
  return shared >= minSharedSoft;
}

function symmetricDiffSize(a, b) {
  const all = new Set([...a, ...b]);
  let n = 0;
  for (const x of all) if (a.has(x) !== b.has(x)) n++;
  return n;
}

// Layer 4 structural score (5.4b). `extraSoft` = symmetric difference of the
// two soft sets (a differing vendor contributes one extra soft token and is
// penalised a little — this is why no alias table is needed).
function rawScore(local, entry) {
  let shared = 0;
  for (const s of local.soft) if (entry.soft.has(s)) shared++;
  let score = 2 * shared - 0.25 * symmetricDiffSize(local.soft, entry.soft);
  if (local.sizes.size > 0 && entry.sizes.size > 0 && setEqual(local.sizes, entry.sizes)) {
    score += 1;
  }
  return score;
}

// Layer 4 corroboration (5.4c) using the endpoint's own declared facts. Absent
// or zero on either side is no evidence and never counts against a candidate.
// Returns the adjusted score, or null when the candidate is vetoed.
function corroborate(entry, facts, score) {
  const inSet = Array.isArray(facts?.modalities) ? new Set(facts.modalities) : null;
  const candIn = Array.isArray(entry?.modalities?.input)
    ? entry.modalities.input.filter((v) => typeof v === "string")
    : [];

  // VETO: endpoint declares an input modality the candidate lacks (both sets non-empty).
  if (inSet && inSet.size > 0 && candIn.length > 0) {
    for (const m of candIn) if (!inSet.has(m)) return null;
  }
  // VETO: endpoint's context limit is greater than the candidate's (both positive).
  const ctx = facts?.context;
  const candCtx = entry?.limit?.context;
  if (
    typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0 &&
    typeof candCtx === "number" && Number.isFinite(candCtx) && candCtx > 0 &&
    ctx > candCtx
  ) {
    return null;
  }
  // +1 both output limits positive and equal.
  const out = facts?.output;
  const candOut = entry?.limit?.output;
  if (
    typeof out === "number" && Number.isFinite(out) && out > 0 &&
    typeof candOut === "number" && Number.isFinite(candOut) && candOut > 0 &&
    out === candOut
  ) {
    score += 1;
  }
  // +1 input-modality sets equal (both non-empty — absence is no evidence).
  if (inSet && inSet.size > 0 && candIn.length > 0 && setEqual(inSet, new Set(candIn))) {
    score += 1;
  }
  return score;
}

// Small local Levenshtein distance — permitted ONLY as the final tiebreak over
// candidates already proven to share versions and sizes (5.4c), where the digit
// confusion that makes edit distance dangerous cannot arise. No dependency.
function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

// Layer 4 (5.4d): the whole-id structural match over the catalogue, then
// corroboration. Layer 4 is DIGIT-ANCHORED by design (5.3/5.4): a local id
// with no digit token at all is pure decoration with no structural identity to
// anchor on — it either resolved through a layer-2 handle (e.g. a bare family
// name) or is unidentifiable. Requiring a digit token here is what keeps
// opaque no-content aliases like `chat` or `base` from colour-matching real
// entries (BET-1303 6.2).
//
// A DATE counts as an anchor but is weaker than a version/size: `-2407`
// distinguishes one release from another, yet a pure date must not let a
// generic soft-only alias re-anchor. So admission for a DATE-ONLY id (no
// version, no size) requires the candidate to share TWO OR MORE specific soft
// tokens — a release-stamped open-weight alias sharing its two identity tokens
// resolves, while a generic soft-only alias carrying just a date stays none.
// Version/size anchoring keeps the normal single-shared-soft admission, since
// the digits themselves carry identity. Without endpoint facts layer 4 may
// only return exact when there is a single admitted candidate (no tie).
function layer4Match(localId, list, facts) {
  const local = classifyTokens(tokenizeModelId(localId));
  const anchoredByVersionOrSize = local.versions.size > 0 || local.sizes.size > 0;
  if (!anchoredByVersionOrSize && !local.dated) return { kind: "none", candidates: [] };
  // A date-only id carries no version/size identity, so it must share ≥2 soft
  // tokens; version/size anchoring keeps the single-soft admission.
  const minSharedSoft = anchoredByVersionOrSize ? 1 : 2;
  const admitted = [];
  for (const e of list) {
    if (!e || typeof e.id !== "string") continue;
    const entry = classifyTokens(tokenizeModelId(e.id));
    if (admittedBy(local, entry, minSharedSoft)) admitted.push(e);
  }
  if (admitted.length === 0) return { kind: "none", candidates: [] };

  if (!facts) {
    const collapsed = collapseAliases(admitted);
    if (collapsed.length === 1) return { kind: "exact", candidates: collapsed };
    return { kind: "ambiguous", candidates: collapsed };
  }

  const scored = [];
  for (const e of admitted) {
    const sc = corroborate(e, facts, rawScore(local, classifyTokens(tokenizeModelId(e.id))));
    if (sc !== null) scored.push({ e, score: sc });
  }
  if (scored.length === 0) return { kind: "none", candidates: [] };
  scored.sort((a, b) => b.score - a.score);
  const max = scored[0].score;
  let survivors = scored.filter((s) => s.score === max);
  // A dated alias and its base score identically (identical version/size/soft
  // classes plus the same endpoint facts); collapse them to the canonical base
  // before the edit-distance tiebreak so the tie never resolves to the alias
  // on a coin flip (BET-1307).
  if (survivors.length > 1) {
    survivors = collapseAliases(survivors.map((s) => s.e)).map((e) => ({ e, score: max }));
  }
  if (survivors.length === 1) return { kind: "exact", candidates: [survivors[0].e] };

  // Tie at the top → smallest edit distance between the normalised ids.
  const base = normalize(localId);
  let best = null;
  let bestD = Infinity;
  let tied = false;
  for (const s of survivors) {
    const d = editDistance(base, normalize(s.e.id));
    if (d < bestD) {
      bestD = d;
      best = s.e;
      tied = false;
    } else if (d === bestD) {
      tied = true;
    }
  }
  if (!tied && best) return { kind: "exact", candidates: [best] };
  return { kind: "ambiguous", candidates: survivors.map((s) => s.e) };
}

/**
 * PURE. Build a read-only matcher over a list of catalogue entries.
 *
 * `lookupModel(catalogId)` — exact match on the catalogue id (case-insensitive
 * and separator-normalised). Returns the entry or null.
 *
 * `matchModel(localModelId[, endpointFacts])` — resolves an opaque local id to
 * the catalogue entries it could be, using the layered mechanism (BET-1303 4):
 *   1. direct catalogue id;
 *   2. normalised handle (id / bare segment / name / family);
 *   3. the id matching a catalogue entry's Hugging Face weights-repo path;
 *   4. a digit-anchored structural match, corroborated by `endpointFacts`.
 * Returns `{ kind, candidates, confidence?, evidence? }`:
 *   "exact"      — exactly one entry matches;
 *   "ambiguous"  — several entries match; never pick between them;
 *   "none"       — meaningless / unidentifiable (e.g. `default`).
 * `confidence` is "certain" for the exact-data lookups (layers 1-3) and
 * "probable" for layer 4 inference; absent when kind === "none". `evidence`
 * is a short human phrase naming the route, for the Settings UI.
 *
 * `endpointFacts` (`{ modalities?, context?, output? }`) is OPTIONAL; when
 * omitted, corroboration is skipped and layer 4 may only return `exact` with a
 * single admitted candidate. Every existing call site keeps working unchanged.
 *
 * `allModels()` — the full entry list (for typeahead and modelQuality ranking).
 *
 * @param {Array<object>} entries
 */
export function createModelIndex(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const byHandle = new Map();
  const byRepo = new Map();
  for (const e of list) {
    for (const k of entryHandles(e)) {
      let bucket = byHandle.get(k);
      if (!bucket) {
        bucket = [];
        byHandle.set(k, bucket);
      }
      bucket.push(e);
    }
    for (const repo of weightsRepos(e)) {
      let bucket = byRepo.get(repo);
      if (!bucket) {
        bucket = [];
        byRepo.set(repo, bucket);
      }
      bucket.push(e);
    }
  }

  function lookupOne(catalogId) {
    const needle = normalize(catalogId);
    for (const e of list) {
      if (typeof e?.id === "string" && normalize(e.id) === needle) return e;
    }
    return null;
  }

  // Layer 3: try the normalised id against the weights-repo map, dropping the
  // last `-`-separated token repeatedly down to two tokens (`acme/a-32b-zap`
  // → miss → `acme/a-32b` → hit).
  function layer3Lookup(needle) {
    let probe = needle;
    for (;;) {
      const hit = byRepo.get(probe);
      if (hit) return { repo: probe, candidates: [...new Set(hit)] };
      const parts = probe.split("-");
      if (parts.length <= 2) break;
      probe = parts.slice(0, -1).join("-");
    }
    return null;
  }

  return {
    get size() {
      return list.length;
    },
    lookupModel(catalogId) {
      return lookupOne(catalogId);
    },
    matchModel(localModelId, endpointFacts) {
      const needle = normalize(localModelId);

      // Layer 1 — the id is a catalogue id.
      const direct = lookupOne(localModelId);
      if (direct) {
        return { kind: "exact", candidates: [direct], confidence: "certain", evidence: "catalogue id" };
      }

      // Layer 2 — a normalised handle (bare segment / name / family). An entry
      // and its own dated alias share the bare-segment AND name handle (the
      // alias's undated name normalizes to the base's key), so the bucket can
      // hold both — collapse to the canonical base before choosing kind.
      const raw = byHandle.get(needle) ?? [];
      const canonHandles = collapseAliases([...new Set(raw)]);
      if (canonHandles.length === 1) {
        return { kind: "exact", candidates: canonHandles, confidence: "certain", evidence: "model name" };
      }
      if (canonHandles.length > 1) {
        return { kind: "ambiguous", candidates: canonHandles, confidence: "certain", evidence: "model name" };
      }

      // Layer 3 — the id is a weights-repo path of a catalogue entry. Same
      // dated-alias collapse; keeps exact/ambiguous consistent with layer 2.
      const repo = layer3Lookup(needle);
      if (repo) {
        const candidates = collapseAliases(repo.candidates);
        const kind = candidates.length === 1 ? "exact" : "ambiguous";
        return {
          kind,
          candidates,
          confidence: "certain",
          evidence: kind === "exact" ? `weights repo ${repo.repo}` : "weights repo",
        };
      }

      // Layer 4 — digit-anchored structural match, corroborated by facts.
      // Layer 4 also collapses dated aliases (see layer4Match), so a model and
      // its own dated alias resolve to one canonical entry at every layer.
      const structural = layer4Match(localModelId, list, endpointFacts);
      if (structural.kind === "exact" || structural.kind === "ambiguous") {
        const evidence = endpointFacts
          ? "name and size match; context and modalities agree"
          : "name and size match";
        return { kind: structural.kind, candidates: structural.candidates, confidence: "probable", evidence };
      }
      return { kind: "none", candidates: [] };
    },
    allModels() {
      return list.slice();
    },
  };
}

// Extract the normalization handles a catalogue entry's weights URLs provide
// (layer 3). A weights URL pointing at the hugging-face repo of a real model
// indexes the entry under that repo's normalised path, so a reseller id derived
// from the
// hugging-face repo path resolves with no inference at all.
function weightsRepos(entry) {
  const out = new Set();
  const ws = Array.isArray(entry?.weights) ? entry.weights : [];
  for (const w of ws) {
    if (typeof w?.url !== "string") continue;
    const m = /huggingface\.co\/([^/]+\/[^/?#]+)/i.exec(w.url);
    if (m) out.add(normalize(m[1]));
  }
  return out;
}
