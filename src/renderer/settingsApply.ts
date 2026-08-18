// BET-419 — shared instant-apply + toast helpers used by both desktop
// Settings.tsx and mobile MobileSettings.tsx. Pure logic (no JSX, no DOM
// beyond window.api) so it stays testable and platform-agnostic.
//
// The stomping bug (sub-issue 13 §"The bug") is fixed by removing the
// per-field local state + resync effect that overwrote unsaved text. These
// helpers write to the store directly (optimistic) then to configUpdate.
// Success raises no toast (BET-1055); failure rolls back + raises an error.

import { useStore } from "./store";
import { applyTheme, type ThemePref } from "./theme";
import type { ToastItem } from "./Toast";
import { errorDisclosure } from "./settingsError";
import type { SettingEntry } from "../shared/settingsSchema";

/**
 * Coerce a UI-produced value to the entry's stored type. Segmented controls
 * emit their option `value` (always a string); when the entry's default is a
 * number (e.g. uploadCleanupHours), coerce to a number so the store and box
 * config stay numeric (keeps the Modified-dot comparison strict-equal and the
 * box poller's arithmetic correct). Non-numeric-default entries pass through
 * unchanged.
 */
function coerceSettingValue(entry: SettingEntry, value: unknown): unknown {
  if (entry.control === "segmented" && typeof entry.default === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : entry.default;
  }
  return value;
}

/**
 * Instant-apply a single config key. Optimistic store update → configUpdate →
 * reconcile. On failure, rolls back to `prevValue` and raises an error toast.
 * Success raises no toast (BET-1055). Never throws to the caller. `prevValue`
 * is captured for rollback on failure.
 */
export function useApplySetting(pushToast: (t: ToastItem) => void) {
  return async (entry: SettingEntry, value: unknown, prevValue: unknown) => {
    if (entry.configKey == null) return;
    const key = entry.configKey;
    value = coerceSettingValue(entry, value);
    if (key === "theme") applyTheme(value as ThemePref);
    setStorePath(key, value);
    try {
      const next = await window.api.configUpdate({ [key]: value });
      const reconciled = readStorePath(next as Record<string, unknown>, key);
      setStorePath(key, reconciled ?? value);
    } catch (e) {
      setStorePath(key, prevValue);
      if (key === "theme") applyTheme(prevValue as ThemePref);
      pushToast({ id: `err-${key}-${Date.now()}`, message: errorDisclosure(`Couldn't set ${entry.label.toLowerCase()}.`, e) });
    }
  };
}

/**
 * Read a possibly-dotted path (e.g. "cto.enabled") from an object. Flat keys
 * return the value directly.
 */
function readStorePath(root: Record<string, unknown>, key: string): unknown {
  if (!key.includes(".")) return root[key];
  const parts = key.split(".");
  let cur: unknown = root;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Write a possibly-dotted path into the zustand store as a nested object. The
 * store is shallow-merged by setState, so a nested path must be written as a
 * whole parent object built from the current store state (no stomping others).
 */
function setStorePath(key: string, value: unknown): void {
  if (!key.includes(".")) {
    useStore.setState({ [key]: value });
    return;
  }
  const parts = key.split(".");
  const head = parts[0];
  const current = {
    ...(((useStore.getState() as Record<string, unknown>)[head] as object) ?? {}),
  };
  let cur = current as Record<string, unknown>;
  for (let i = 1; i < parts.length - 1; i++) {
    cur[parts[i]] = { ...((cur[parts[i]] as Record<string, unknown>) ?? {}) };
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
  useStore.setState({ [head]: current });
}
