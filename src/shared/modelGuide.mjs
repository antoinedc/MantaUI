// modelGuide.mjs — Model catalog for subagent selection and Settings reference.
//
// Provides a single pure function describeModel(providerID, modelID) that returns
// { blurb, goodFor, tier } or null. Matches by family substring (case-insensitive)
// on modelID. First match wins.

const CATALOG = [
  // Anthropic Claude family
  {
    key: "haiku",
    blurb: "Fast, cost-effective model for straightforward tasks.",
    goodFor: [
      "Mechanical edits and simple refactors",
      "File lookups and grep tasks",
      "Running builds/tests and lint fixes",
    ],
    tier: "fast",
  },
  {
    key: "sonnet",
    blurb: "Balanced model for everyday coding and feature work.",
    goodFor: [
      "Most feature implementation",
      "Code review and bug fixes",
      "Multi-file edits",
    ],
    tier: "balanced",
  },
  {
    key: "opus",
    blurb: "Deep-reasoning model for complex architectural work.",
    goodFor: [
      "Architecture and design decisions",
      "Hard debugging and root-cause analysis",
      "Multi-file reasoning and tricky refactors",
    ],
    tier: "deep",
  },

  // OpenAI family
  {
    key: "gpt-4o-mini",
    blurb: "Lightweight model for classification and summarization.",
    goodFor: [
      "Cheap classification tasks",
      "Summarization",
      "Simple mechanical edits",
    ],
    tier: "fast",
  },
  {
    key: "o4-mini",
    blurb: "Lightweight reasoning model for simpler tasks.",
    goodFor: [
      "Cheap classification tasks",
      "Summarization",
      "Simple mechanical edits",
    ],
    tier: "fast",
  },
  {
    key: "gpt-4o",
    blurb: "General-purpose model for coding and reasoning.",
    goodFor: [
      "General coding tasks",
      "Feature implementation",
      "Code review",
    ],
    tier: "balanced",
  },
  {
    key: "o1",
    blurb: "Step-by-step reasoning model for logic-heavy tasks.",
    goodFor: [
      "Step-by-step reasoning",
      "Math and logic-heavy problems",
      "Complex algorithm design",
    ],
    tier: "deep",
  },
  {
    key: "o3",
    blurb: "Advanced reasoning model for complex problems.",
    goodFor: [
      "Deep logical reasoning",
      "Math-intensive tasks",
      "Complex algorithm development",
    ],
    tier: "deep",
  },

  // Google Gemini family - these need to be at the end or checked more carefully
  // since "flash" alone might match other models
  {
    key: "flash",
    blurb: "Fast Gemini variant for quick tasks.",
    goodFor: [
      "Quick classification",
      "Simple edits",
      "Lightweight summarization",
    ],
    tier: "fast",
  },
  {
    key: "gemini",
    blurb: "Balanced Gemini model for general coding.",
    goodFor: [
      "General coding tasks",
      "Feature work",
      "Code review",
    ],
    tier: "balanced",
  },

  // OpenAI Codex / GPT-5 family - ordered with the more specific keys first
  // because match is by case-insensitive substring and first match wins.
  // "codex-mini" and "codex-max" must precede "codex"; every codex entry must
  // precede the bare "gpt-5" so a model like gpt-5.2-codex resolves to the
  // codex entry, not gpt-5.
  {
    key: "codex-mini",
    blurb: "Fast, smallest Codex-tuned model, suited for quick tasks.",
    goodFor: [
      "Quick mechanical edits",
      "Fast file lookups and grep tasks",
      "Simple refactors and lint fixes",
    ],
    tier: "fast",
  },
  {
    key: "codex-max",
    blurb: "Deep-reasoning Codex-tuned model for long agentic runs.",
    goodFor: [
      "Long agentic runs",
      "Multi-step architectural work",
      "Hard debugging and root-cause analysis",
      "Tricky refactors with extended context",
    ],
    tier: "deep",
  },
  {
    key: "codex",
    blurb: "Balanced Codex-tuned GPT-5 for general coding work.",
    goodFor: [
      "General coding tasks",
      "Feature implementation",
      "Code review and bug fixes",
    ],
    tier: "balanced",
  },
  {
    key: "gpt-5",
    blurb: "Balanced general-purpose GPT-5 for coding and reasoning.",
    goodFor: [
      "General coding tasks",
      "Feature implementation",
      "Code review",
      "Reasoning-heavy tasks",
    ],
    tier: "balanced",
  },

  // Kimi family - "kimi-for-coding-highspeed" must precede "kimi-for-coding"
  // and "k3-256k" must precede "k3" so the more specific substring wins.
  // Disjoint from the OpenAI block above; ordering across blocks does not
  // affect matching.
  {
    key: "kimi-for-coding-highspeed",
    blurb: "Fast K2.7 Code variant, roughly 5-6x faster.",
    goodFor: [
      "Quick mechanical edits",
      "Fast file lookups",
      "Simple refactors when latency matters",
    ],
    tier: "fast",
  },
  {
    key: "kimi-for-coding",
    blurb: "Balanced K2.7 Code, available on every Kimi tier.",
    goodFor: [
      "General coding tasks",
      "Feature implementation",
      "Code review across Kimi membership tiers",
    ],
    tier: "balanced",
  },
  {
    key: "k3-256k",
    blurb: "Balanced K3 at 256K context, costs about half the quota of 1M K3.",
    goodFor: [
      "Tasks needing longer context without 1M cost",
      "Mid-sized code review sessions",
      "Working through large monorepo diffs",
    ],
    tier: "balanced",
  },
  {
    key: "k3",
    blurb: "Deep-reasoning Kimi flagship, up to 1M context with thinking-effort variants.",
    goodFor: [
      "Long-running architectural work",
      "Complex multi-file refactors",
      "Tuning low/high/max thinking effort per task",
    ],
    tier: "deep",
  },
];

function matchFamily(modelID) {
  if (!modelID || typeof modelID !== "string") return null;
  const normalized = modelID.toLowerCase();
  return CATALOG.find((e) => normalized.includes(e.key)) ?? null;
}

/**
 * Look up metadata for a model by family match.
 *
 * @param {string} providerID - The provider ID (e.g., "anthropic", "openai")
 * @param {string} modelID - The model ID to match (e.g., "claude-haiku-4", "gpt-4o-mini")
 * @returns {{ blurb: string, goodFor: string[], tier: "fast" | "balanced" | "deep" } | null}
 */
export function describeModel(providerID, modelID) {
  const entry = matchFamily(modelID);
  if (!entry) return null;
  return {
    blurb: entry.blurb,
    goodFor: entry.goodFor,
    tier: entry.tier,
  };
}

/**
 * The catalog family key a modelID matches (e.g. "haiku", "gpt-4o"), or null
 * when no family matches. Used by subagentSync.mjs to derive stable,
 * human-readable subagent names without duplicating the CATALOG here.
 *
 * @param {string} modelID
 * @returns {string | null}
 */
export function familyKey(modelID) {
  const entry = matchFamily(modelID);
  return entry ? entry.key : null;
}

// --- Model matching for app-control (the manta_switch_model tool) -----------
//
// Resolves a spoken/typed model query ("opus", "sonnet 4", "claude-haiku")
// against a list of normalized opencode models (oc.listModels()). This is the
// canonical fuzzy matcher — src/server/appControl.mjs uses it for the
// switch-model action. Do not write a second match implementation anywhere.

/**
 * Match a fuzzy model query against a list of models. Exact id wins, then
 * every token present in the id, then every token present in the name, then a
 * providerID prefix.
 *
 * @param {string|null|undefined} query
 * @param {Array<{id?: string, name?: string, providerID?: string}>} models
 * @returns {object|null} the resolved model, or null when nothing matches.
 */
export function fuzzyMatchModel(query, models) {
  const list = Array.isArray(models) ? models : [];
  if (!query || !list.length) return null;
  const q = String(query).toLowerCase().trim();
  if (!q) return null;

  const direct = list.find((m) => String(m?.id ?? "").toLowerCase() === q);
  if (direct) return direct;

  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  for (const m of list) {
    const id = String(m?.id ?? "").toLowerCase();
    if (tokens.every((t) => id.includes(t))) return m;
  }
  for (const m of list) {
    const name = String(m?.name ?? "").toLowerCase();
    if (tokens.every((t) => name.includes(t))) return m;
  }
  for (const m of list) {
    if (tokens[0] === String(m?.providerID ?? "").toLowerCase()) return m;
  }
  return null;
}

/**
 * The closest candidates for an unmatched query, for a retry hint. Ranks
 * models by how many query tokens appear in their id/name; returns the top
 * `limit`. Exported so the switch-model no-match error can name candidates
 * the model can retry with.
 *
 * @param {string|null|undefined} query
 * @param {Array<{id?: string, name?: string, providerID?: string}>} models
 * @param {number} [limit]
 * @returns {Array<{providerID?: string, id?: string, name?: string}>}
 */
export function suggestModels(query, models, limit = 3) {
  const list = Array.isArray(models) ? models : [];
  if (!query || !list.length) return [];
  const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const scored = [];
  for (const m of list) {
    const haystack = `${String(m?.id ?? "")} ${String(m?.name ?? "")}`.toLowerCase();
    let hits = 0;
    for (const t of tokens) if (haystack.includes(t)) hits++;
    if (hits > 0) scored.push({ m, hits });
  }
  return scored
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map(({ m }) => ({ providerID: m?.providerID, id: m?.id, name: m?.name }));
}
