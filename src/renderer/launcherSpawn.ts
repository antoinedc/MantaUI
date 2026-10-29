import type { AvailableLauncher } from "../shared/types";

/**
 * The `launcher` a PTY spawn carries. A current box resolves the saved launch options itself, so `{id}` is
 * enough. An older box (a flag row without `value`) runs only the flags it is GIVEN — a bare `{id}` would
 * drop every option, including `--dangerously-skip-permissions` whose default is on — so for that box the row's
 * own `default`s are sent (the old box's data, no rule copied here).
 */
export function launcherSpawnPayload(def: AvailableLauncher): { id: string; flags?: Record<string, boolean> } {
  const flags = def.flags ?? [];
  if (flags.length > 0 && flags.some((f) => f.value === undefined)) {
    return { id: def.id, flags: Object.fromEntries(flags.map((f) => [f.key, f.default])) };
  }
  return { id: def.id };
}
