import { useEffect, useState } from "react";
import type { AvailableLauncher } from "../shared/types";
import { resolveLauncherFlags } from "./chatShared";

/**
 * Shared settings logic used by both desktop Settings.tsx and mobile
 * MobileSettings.tsx (BET-409 — extracted to clear the duplication gate).
 * These hooks/functions are code-organization extractions, NOT Settings UI
 * restructuring (which is deferred to sub-issue 14).
 */

/**
 * Fetch the AI CLI TUI launchers available on this box. Non-fatal — an empty
 * list just hides the launch-options section. Guarded: on an unpaired /
 * mid-onboarding boot, window.api may still be the raw preload OS-bridge subset
 * (no launchersList) until the http-mode transport swap completes, so a bare
 * call would throw synchronously.
 */
export function useLaunchers(): [
  AvailableLauncher[],
  React.Dispatch<React.SetStateAction<AvailableLauncher[]>>,
] {
  const [available, setAvailable] = useState<AvailableLauncher[]>([]);
  useEffect(() => {
    if (!window.api.launchersList) {
      setAvailable([]);
      return;
    }
    window.api
      .launchersList()
      .then((list) => setAvailable(list))
      .catch(() => {});
  }, []);
  return [available, setAvailable];
}

/**
 * Pure updater for a single launcher flag. Used inside a setState callback:
 * `setLauncherFlagValues((prev) => updateLauncherFlag(available, id, key, val, prev))`.
 */
export function updateLauncherFlag(
  launchers: AvailableLauncher[],
  launcherId: string,
  flagKey: string,
  checked: boolean,
  prev: Record<string, Record<string, boolean>>,
): Record<string, Record<string, boolean>> {
  const l = launchers.find((x) => x.id === launcherId);
  if (!l) return prev;
  return {
    ...prev,
    [launcherId]: {
      ...resolveLauncherFlags(l.flags, prev[launcherId]),
      [flagKey]: checked,
    },
  };
}

/**
 * Manages the skill-registry-URL list + the "add new URL" input. Shared by
 * desktop and mobile settings — identical state shape and add/remove logic.
 */
export function useRegistryUrls(initial: string[]) {
  const [registryUrls, setRegistryUrls] = useState<string[]>(initial);
  const [newRegistryUrl, setNewRegistryUrl] = useState("");

  const addRegistryUrl = () => {
    const url = newRegistryUrl.trim();
    if (!url || registryUrls.includes(url)) return;
    setRegistryUrls([...registryUrls, url]);
    setNewRegistryUrl("");
  };

  const removeRegistryUrl = (url: string) => {
    setRegistryUrls(registryUrls.filter((u) => u !== url));
  };

  return {
    registryUrls,
    setRegistryUrls,
    newRegistryUrl,
    setNewRegistryUrl,
    addRegistryUrl,
    removeRegistryUrl,
  };
}
