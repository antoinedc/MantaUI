// Constants for the Claude-Code impersonation (mechanisms M3/M4) — copied from
// opencode-claude-auth@2.2.1 `model-config.js`. They drift whenever Anthropic
// changes what Claude Code sends (R5); the box's lever is ANTHROPIC_CLI_VERSION.

/** Claude Code version we claim when ANTHROPIC_CLI_VERSION is unset. */
export const CC_VERSION_FALLBACK = "2.1.280";

export const BASE_BETAS: readonly string[] = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "prompt-caching-scope-2026-01-05",
  "context-management-2025-06-27",
  "advisor-tool-2026-03-01",
  "thinking-token-count-2026-05-13",
  "extended-cache-ttl-2025-04-11",
];

/** Betas dropped, one at a time, when Anthropic rejects a request as "long context". */
export const LONG_CONTEXT_BETAS: readonly string[] = ["context-1m-2025-08-07", "interleaved-thinking-2025-05-14"];

interface ModelOverride {
  add?: string[];
  exclude?: string[];
  disableEffort?: boolean;
}

// FIRST MATCH WINS (insertion order, `includes` on the lowercased id): keep
// "haiku" ahead of anything broader so claude-haiku-4-5 never receives effort.
const MODEL_OVERRIDES: ReadonlyArray<readonly [string, ModelOverride]> = [
  ["haiku", { exclude: ["effort-2025-11-24"], disableEffort: true }],
  ["opus-4-5", { add: ["effort-2025-11-24"] }],
  ["4-6", { add: ["effort-2025-11-24"] }],
  ["4-7", { add: ["effort-2025-11-24"] }],
];

export function getModelOverride(modelId: string): ModelOverride | null {
  const lower = (modelId || "").toLowerCase();
  for (const [pattern, override] of MODEL_OVERRIDES) if (lower.includes(pattern)) return override;
  return null;
}

/** The Claude Code version to claim. Read per call so a changed env takes effect. */
export function cliVersion(env: Record<string, string | undefined> = process.env): string {
  const v = env.ANTHROPIC_CLI_VERSION?.trim();
  return v ? v : CC_VERSION_FALLBACK;
}

export function userAgent(env: Record<string, string | undefined> = process.env): string {
  return env.ANTHROPIC_USER_AGENT || `claude-cli/${cliVersion(env)} (external, sdk-cli)`;
}

/** Beta flags for a model: base list, per-model overrides, minus the excluded ones. */
export function modelBetas(
  modelId: string,
  excluded?: ReadonlySet<string>,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const base = (env.ANTHROPIC_BETA_FLAGS ?? BASE_BETAS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let betas = [...base];
  const o = getModelOverride(modelId);
  if (o?.exclude) betas = betas.filter((b) => !o.exclude!.includes(b));
  if (o?.add) for (const a of o.add) if (!betas.includes(a)) betas.push(a);
  return excluded && excluded.size > 0 ? betas.filter((b) => !excluded.has(b)) : betas;
}

export function isLongContextError(body: string): boolean {
  return (
    body.includes("Extra usage is required for long context requests") ||
    body.includes("long context beta is not yet available") ||
    body.includes("You're out of extra usage")
  );
}
