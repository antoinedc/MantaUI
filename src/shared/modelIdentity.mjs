// modelIdentity.mjs — what model is this opaque endpoint actually serving?
//
// Pure, injected inputs only. There is no I/O and nothing is fetched: the
// catalogue matcher (`{ lookupModel, matchModel }`, the same pair the
// box-side model catalogue exposes) arrives as an argument. This is the
// design opportunity of Automatic Manta Routing: not every opaque id is
// equally opaque. A provider can expose three model ids — `qwen3.6-27b`,
// `ornith`, `default` — where every fact a router needs is missing or
// present-and-wrong (a context limit of 0 and a price of 0 are not
// "unknown", they are claims, and both are false). But the ids are not
// equally hopeless:
//
//   • `qwen3.6-27b` resolves exactly in the catalogue → we know what it is;
//   • `ornith` is ambiguous (four same-family sizes) → we must NOT guess;
//   • `default` is meaningless → genuinely unknown, stays hand-pickable and
//     is simply never chosen automatically (supported, not an error).
//
// The hallucinated `limit.context: 0` and `cost: 0` are the credibility trap
// this module exists for: a provider reporting `0` / `""` / `undefined` is
// reporting *nothing*, and the catalogue's real value must win; but a
// positive provider value is a real property of that endpoint and wins over
// the catalogue. Price is always the endpoint's, never the catalogue's — the
// same model is free on one host and expensive on another.

// A value is "credible" for the limit/context rule: any positive finite
// number is a real claim about this endpoint; `0`/`""`/`undefined`/`NaN` are
// silence and must fall back to the catalogue. Returns the credible value or
// null.
function credibleNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

// Generic "provider value overrides the catalogue base when credible" —
// `credible(v)` decides whether the provider's value is a real signal.
function pickCredible(providerVal, catalogueVal, credible) {
  return credible(providerVal) ? providerVal : catalogueVal;
}

// Copy only the finite, non-negative payload of a cost object (a declared 0
// is real, missing/NaN/negative is junk and dropped — never emitted as a
// made-up figure).
function copyCost(cost) {
  if (!cost || typeof cost !== "object") return {};
  const out = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    const v = cost[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[key] = v;
  }
  return out;
}

// Merge catalogue capabilities (reasoning, tool_call, modalities) under the
// provider's own where the provider's are credible; otherwise the catalogue
// fact stands. Provider capability fields that are absent are untouched.
function mergeCapabilities(providerCaps, catalogueEntry) {
  const base =
    providerCaps && typeof providerCaps === "object" ? { ...providerCaps } : {};
  const e = catalogueEntry && typeof catalogueEntry === "object" ? catalogueEntry : {};
  return {
    ...base,
    reasoning: pickCredible(base.reasoning, e.reasoning, (v) => typeof v === "boolean"),
    tool_call: pickCredible(base.tool_call, e.tool_call, (v) => typeof v === "boolean"),
    modalities: pickCredible(
      base.modalities,
      e.modalities,
      (v) => Array.isArray(v) && v.length > 0,
    ),
  };
}

// Resolve the provider's own id/family against the catalogue. id is the
// more specific signal and is tried first; family is the fallback that lets
// a bare family name surface every size of it (ambiguously).
function matchProvider(cat, id, family) {
  for (const localId of [id, family]) {
    if (typeof localId !== "string" || localId === "") continue;
    // A provider that literally names a full catalogue id is self-identifying
    // — no fuzzy matching needed.
    if (typeof cat?.lookupModel === "function") {
      const direct = cat.lookupModel(localId);
      if (direct) return { kind: "provider", candidates: [direct] };
    }
    if (typeof cat?.matchModel === "function") {
      const r = cat.matchModel(localId);
      if (r?.kind === "exact") return { kind: "exact", candidates: r.candidates };
      if (r?.kind === "ambiguous") return { kind: "ambiguous", candidates: r.candidates };
    }
  }
  return { kind: "none", candidates: [] };
}

// Merge the catalogue entry, then the provider's own credible values, then
// the user's declaration, into one `effective` endpoint description. Later
// wins.
function buildEffective(m, dec, entry, catalogId) {
  const e = entry && typeof entry === "object" ? entry : {};

  // Price is always the endpoint's — never the catalogue's. Start from the
  // provider's own cost, then the user's declared price (incl. "free", which
  // is an explicit zero, distinguishable from the silence of an absent price).
  let cost = copyCost(m.cost);
  if (dec.price === "free") {
    cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  } else if (dec.price && typeof dec.price === "object") {
    cost = { ...cost, ...copyCost(dec.price) };
  }

  // Context/output: catalogue is the base; the provider's positive value wins
  // (it is a real property of its own endpoint); `0`/absent falls back.
  const context =
    credibleNumber(m?.limit?.context) ?? credibleNumber(e?.limit?.context) ?? undefined;
  const output =
    credibleNumber(m?.limit?.output) ?? credibleNumber(e?.limit?.output) ?? undefined;

  const effective = {
    providerID: m?.providerID,
    id: m?.id,
    family:
      typeof e?.family === "string" && e.family !== "" ? e.family : m?.family,
    capabilities: mergeCapabilities(m?.capabilities, e),
    limit: { context, output },
    cost,
  };
  for (const key of ["catalogId", "benchmarks", "caches", "tierOverride"]) {
    const val =
      key === "catalogId"
        ? catalogId
        : key === "benchmarks"
          ? e.benchmarks
          : dec[key];
    if (key === "benchmarks" ? Array.isArray(val) : val !== undefined) {
      effective[key] = val;
    }
  }
  return effective;
}

/**
 * What model is this endpoint actually serving, and what do we therefore know?
 *
 * @param {object} model      OpencodeModel as normalised from the provider
 * @param {object} declared   the user's declaration for this endpoint key, or null:
 *                            { catalogId?, price?: {input,output}|"free",
 *                              caches?: false|{read,write}, tierOverride? }
 * @param {object} catalog    { lookupModel, matchModel } — injected
 * @returns {{
 *   state: "resolved"|"ambiguous"|"unknown",
 *   catalogId: string|null,
 *   candidates: string[],          // populated only when ambiguous
 *   source: "provider"|"matched"|"declared"|null,
 *   effective: object,             // the model merged with catalogue + declared facts
 * }}
 */
export function resolveIdentity(model, declared, catalog) {
  const m = model && typeof model === "object" ? model : {};
  const dec = declared && typeof declared === "object" ? declared : {};

  let catalogId = null;
  let source = null;
  let state = "unknown";
  let entry = null;
  let candidates = [];

  if (typeof dec.catalogId === "string" && dec.catalogId !== "") {
    // The user told us. Always wins — even over an exact catalogue match.
    catalogId = dec.catalogId;
    source = "declared";
    state = "resolved";
    if (typeof catalog?.lookupModel === "function") {
      entry = catalog.lookupModel(catalogId);
    } else {
      entry = null;
    }
  } else {
    const res = matchProvider(catalog, m.id, m.family);
    if (res.kind === "provider" || res.kind === "exact") {
      // candidate[0] is the single resolved entry for both kinds.
      entry = res.candidates[0];
      catalogId = entry?.id;
      source = res.kind === "provider" ? "provider" : "matched";
      state = "resolved";
    } else if (res.kind === "ambiguous") {
      state = "ambiguous";
      candidates = res.candidates.map((x) => x?.id).filter(Boolean);
    }
    // kind === "none" → state stays "unknown".
  }

  const effective = buildEffective(m, dec, entry, catalogId);
  return { state, catalogId, candidates, source, effective };
}
