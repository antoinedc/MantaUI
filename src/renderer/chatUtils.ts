// Pure utility functions extracted from ChatPanel for testability.

export const ASSUMED_CONTEXT_TOKENS = 200_000;

export function formatTokens(n: number): string {
  if (n < 1000) return `${n} tokens`;
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k tokens`;
  return `${Math.round(n / 1000)}k tokens`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function ctxStageColor(pct: number): string {
  if (pct < 50) return "#22c55e"; // green-500
  if (pct < 75) return "#eab308"; // yellow-500
  if (pct < 90) return "#f97316"; // orange-500
  return "#ef4444"; // red-500
}

export type TypeaheadCommandRow = {
  name: string;
  description?: string;
};

/**
 * Filter a list of commands by a query string (case-insensitive substring match).
 * Empty query returns all commands.
 */
export function filterCommands<T extends TypeaheadCommandRow>(
  commands: T[],
  query: string,
): T[] {
  if (!query) return commands;
  const q = query.toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().includes(q));
}

/**
 * Deduplicate opencode commands against a set of builtin names so we never
 * show two entries for the same command name.
 */
export function dedupeAgainstBuiltins<T extends TypeaheadCommandRow>(
  commands: T[],
  builtinNames: Set<string>,
): T[] {
  return commands.filter((c) => !builtinNames.has(c.name));
}
