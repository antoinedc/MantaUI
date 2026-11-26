// Constants for the Claude-Code impersonation (mechanisms M3/M4) — copied from
// opencode-claude-auth@2.2.1 `model-config.js`. They drift whenever Anthropic
// changes what Claude Code sends (R5); the box's levers are ANTHROPIC_CLI_VERSION
// and the live state file written by manta-server (see cliVersion below).

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Lowest Claude Code version we ever claim. Keep equal to
 * `manta_claude_cli_version_floor` in scripts/lib/release.sh.
 */
export const CC_VERSION_FALLBACK = "2.1.293";

/** Relative to the state home: the box's real `claude --version`, kept current by manta-server. */
export const CLI_VERSION_FILE = join(".manta", "claude-cli-version");

const VERSION_RE = /^\d+(?:\.\d+){1,3}$/;

/** True when dotted-numeric `a` is strictly newer than `b`. */
function isNewer(a: string, b: string): boolean {
  const av = a.split(".").map(Number);
  const bv = b.split(".").map(Number);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const d = (av[i] ?? 0) - (bv[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// path -> last read, keyed on mtime so a request costs one stat, not a read.
const fileCache = new Map<string, { mtimeMs: number; version: string | null }>();

/** The version in the state file, or null for missing / unreadable / garbage. Never throws. */
function versionFromFile(env: Record<string, string | undefined>): string | null {
  const home = env.MANTA_STATE_HOME?.trim() || env.HOME?.trim();
  if (!home) return null;
  const path = join(home, CLI_VERSION_FILE);
  try {
    const { mtimeMs } = statSync(path);
    const hit = fileCache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.version;
    const text = readFileSync(path, "utf8").trim();
    const version = VERSION_RE.test(text) ? text : null;
    fileCache.set(path, { mtimeMs, version });
    return version;
  } catch {
    fileCache.delete(path);
    return null;
  }
}

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

/**
 * The Claude Code version to claim: the HIGHEST of the env override, the live state file and
 * the built-in floor. Read per call, so a `claude update` takes effect on the next request
 * without restarting opencode (a restart would end every in-flight turn).
 */
export function cliVersion(env: Record<string, string | undefined> = process.env): string {
  let best = CC_VERSION_FALLBACK;
  for (const candidate of [env.ANTHROPIC_CLI_VERSION?.trim(), versionFromFile(env)]) {
    if (candidate && VERSION_RE.test(candidate) && isNewer(candidate, best)) best = candidate;
  }
  return best;
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
