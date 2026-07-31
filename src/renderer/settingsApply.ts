// BET-419 — shared instant-apply + toast helpers used by both desktop
// Settings.tsx and mobile MobileSettings.tsx. Pure logic (no JSX, no DOM
// beyond window.api) so it stays testable and platform-agnostic.
//
// The stomping bug (sub-issue 13 §"The bug") is fixed by removing the
// per-field local state + resync effect that overwrote unsaved text. These
// helpers write to the store directly (optimistic) then to configUpdate,
// with a toast carrying an Undo action — the "one save model: instant
// apply + Undo" from §A.

import { useState } from "react";
import { useStore } from "./store";
import { applyTheme, type ThemePref } from "./theme";
import { ToastStack, type ToastItem } from "./Toast";
import { errorDisclosure } from "./settingsError";
import type { SettingEntry } from "../shared/settingsSchema";

function describeValue(entry: SettingEntry, value: unknown): string {
  if (entry.control === "toggle") return value ? "on" : "off";
  if (entry.control === "segmented") {
    const opt = entry.options?.find((o) => o.value === String(value));
    return opt?.label ?? String(value);
  }
  return String(value);
}

/** Local toast stack for a Settings surface (newest-first, capped at 3). */
export function useSettingsToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const push = (t: ToastItem) => setToasts((prev) => [t, ...prev].slice(0, 3));
  const dismiss = (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id));
  return { toasts, push, dismiss };
}

/**
 * Instant-apply a single config key. Optimistic store update → configUpdate →
 * reconcile → toast with Undo. Rolls back + raises an error toast on failure.
 * Never throws to the caller. `prevValue` is captured for the Undo action.
 */
export function useApplySetting(pushToast: (t: ToastItem) => void) {
  return async (entry: SettingEntry, value: unknown, prevValue: unknown) => {
    if (entry.configKey == null) return;
    const key = entry.configKey;
    if (key === "theme") applyTheme(value as ThemePref);
    useStore.setState({ [key]: value });
    try {
      const next = await window.api.configUpdate({ [key]: value });
      const reconciled = (next as Record<string, unknown>)[key];
      useStore.setState({ [key]: reconciled ?? value });
      pushToast({
        id: `apply-${key}-${Date.now()}`,
        message: `${entry.label} set to ${describeValue(entry, value)}`,
        action: {
          label: "Undo",
          onClick: () => {
            void useStore.setState({ [key]: prevValue });
            if (key === "theme") applyTheme(prevValue as ThemePref);
            window.api.configUpdate({ [key]: prevValue })
              .then((r) => {
                const back = (r as Record<string, unknown>)[key];
                useStore.setState({ [key]: back ?? prevValue });
              })
              .catch(() => {});
          },
        },
      });
    } catch (e) {
      useStore.setState({ [key]: prevValue });
      if (key === "theme") applyTheme(prevValue as ThemePref);
      pushToast({ id: `err-${key}-${Date.now()}`, message: errorDisclosure(`Couldn't set ${entry.label.toLowerCase()}.`, e) });
    }
  };
}

/** Re-export so surfaces can render the stack without a second import. */
export { ToastStack };
export type { ToastItem };
