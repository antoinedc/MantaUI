// launchersConfig.mjs — CLI launch options, owned by the box (WS11 D3 / audit X1).
// The saved choice is `config.launcherFlags[id][key]`; an option nobody touched
// falls back to the registry default. The box resolves it for the list view AND
// for the PTY spawn, so a toggle set on one device is what every device (and a
// CLI session started from either) uses.

import { findLauncher } from "./launcherRegistry.mjs";

/** The value of one option: saved choice, else the registry default. */
export function flagValue(saved, flag) {
  const v = saved?.[flag.key];
  return typeof v === "boolean" ? v : flag.default === true;
}

/** `launchers:list` rows with each flag's resolved `value`. */
export function launchersView(launchers, config) {
  return (Array.isArray(launchers) ? launchers : []).map((l) => ({
    ...l,
    flags: (l.flags ?? []).map((f) => ({ ...f, value: flagValue(config?.launcherFlags?.[l.id], f) })),
  }));
}

/**
 * Flags a PTY spawn should use: explicit `flags` from the caller are honoured
 * (an older client sends them resolved); otherwise they are resolved here from
 * the saved config. An unknown launcher is returned untouched (the spawn falls
 * back to a plain shell).
 */
export async function resolveLauncherForSpawn(launcher, { configGet }) {
  if (!launcher || typeof launcher !== "object" || typeof launcher.id !== "string") return launcher;
  if (launcher.flags && typeof launcher.flags === "object") return launcher;
  const def = findLauncher(launcher.id);
  if (!def) return launcher;
  let config = null;
  try {
    config = await configGet();
  } catch {
    /* unreadable config: registry defaults */
  }
  const flags = {};
  for (const f of def.flags ?? []) flags[f.key] = flagValue(config?.launcherFlags?.[def.id], f);
  return { ...launcher, flags };
}

/**
 * Atomic read-modify-write of one option. Serialised so two devices toggling at
 * once never lose a write. Errors are class-1 sentences (thrown).
 * @returns {Promise<{id: string, label: string, flags: object[]}>} the updated row
 */
export function createLauncherFlagWriter({ configGet, configUpdate }) {
  let chain = Promise.resolve();
  return function setFlag({ id, key, value }) {
    const run = async () => {
      const def = typeof id === "string" ? findLauncher(id) : null;
      if (!def) throw new Error("Unknown launcher.");
      const flag = (def.flags ?? []).find((f) => f.key === key);
      if (!flag || typeof value !== "boolean") throw new Error("Unknown option for this launcher.");
      const config = await configGet();
      const all = config?.launcherFlags && typeof config.launcherFlags === "object" ? config.launcherFlags : {};
      const next = { ...all, [def.id]: { ...(all[def.id] ?? {}), [flag.key]: value } };
      const saved = await configUpdate({ launcherFlags: next });
      const effective = saved?.launcherFlags ?? next;
      return {
        id: def.id,
        label: def.label,
        flags: def.flags.map((f) => ({ key: f.key, label: f.label, type: f.type, default: f.default, value: flagValue(effective[def.id], f) })),
      };
    };
    const result = chain.then(run, run);
    chain = result.catch(() => {});
    return result;
  };
}
