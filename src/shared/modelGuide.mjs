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
];

/**
 * Look up metadata for a model by family match.
 *
 * @param {string} providerID - The provider ID (e.g., "anthropic", "openai")
 * @param {string} modelID - The model ID to match (e.g., "claude-haiku-4", "gpt-4o-mini")
 * @returns {{ blurb: string, goodFor: string[], tier: "fast" | "balanced" | "deep" } | null}
 */
export function describeModel(providerID, modelID) {
  if (!modelID || typeof modelID !== "string") return null;
  const normalized = modelID.toLowerCase();
  const entry = CATALOG.find((e) => normalized.includes(e.key));
  if (!entry) return null;
  return {
    blurb: entry.blurb,
    goodFor: entry.goodFor,
    tier: entry.tier,
  };
}
