// modelsPicker.ts — the renderer side of the box-computed model picker (WS09
// SF-M2). The BOX decides which models the picker lists, which are locked
// (deprecated, not opted in), which are selectable and what the delegate picker
// offers; this module only maps those keys onto the `OpencodeModel` objects the
// catalogue already holds, and tells a card when the box is too old to answer.

import { useEffect, useMemo, useState } from "react";
import type { ModelsPickerResult, OpencodeModel } from "../shared/types";
import { isUnknownChannelError } from "./chatUtils";

/** Shown wherever a box feature the client depends on is missing (D24 wire compat). */
export const UPDATE_YOUR_BOX = "Update your box to use this.";

/** True when an RPC failed because the box has no such channel (an older box). */
export function isUnknownChannel(e: unknown): boolean {
  return isUnknownChannelError(e instanceof Error ? e.message : String(e ?? ""));
}

/** The picker data the UI renders, keyed to model objects. */
export type ModelsPickerView = {
  /** Main picker groups (provider → models), deprecated kept, `-fast` twins folded. */
  groups: Array<[string, OpencodeModel[]]> | null;
  /** "providerID/modelID" keys shown disabled with an "Enable" action. */
  disabledKeys: string[];
  /** Flat selectable list (fast twins included — the ⚡ toggle's input). */
  selectableModels: OpencodeModel[] | null;
  /** Delegate-picker groups (deprecated excluded). */
  delegateGroups: Array<[string, OpencodeModel[]]> | null;
  /** True on a box that does not answer `models:picker` (nothing is hidden or locked). */
  unsupported: boolean;
};

const modelKey = (m: { providerID: string; id: string }) => `${m.providerID}/${m.id}`;

function mapGroups(
  groups: { provider: string; keys: string[] }[],
  byKey: Map<string, OpencodeModel>,
): Array<[string, OpencodeModel[]]> {
  const out: Array<[string, OpencodeModel[]]> = [];
  for (const g of groups) {
    const models = g.keys.map((k) => byKey.get(k)).filter((m): m is OpencodeModel => m != null);
    if (models.length > 0) out.push([g.provider, models]);
  }
  return out;
}

/** Pure mapping of the box's picker result onto the catalogue's model objects. */
export function buildPickerView(
  models: OpencodeModel[] | null,
  picker: ModelsPickerResult | null,
  unsupported = false,
): ModelsPickerView {
  if (!models) return { groups: null, disabledKeys: [], selectableModels: null, delegateGroups: null, unsupported: false };
  const byKey = new Map(models.map((m) => [modelKey(m), m] as const));
  if (!picker) {
    // Older box (or not loaded yet): list everything enabled, nothing locked or hidden —
    // `unsupported` is only claimed once the box has actually refused the channel.
    const enabled = models.filter((m) => m.enabled !== false);
    const map = new Map<string, OpencodeModel[]>();
    for (const m of enabled) map.set(m.providerID, [...(map.get(m.providerID) ?? []), m]);
    const groups = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
    return { groups, disabledKeys: [], selectableModels: enabled, delegateGroups: groups, unsupported };
  }
  return {
    groups: mapGroups(picker.groups, byKey),
    disabledKeys: picker.locked,
    selectableModels: picker.selectable.map((k) => byKey.get(k)).filter((m): m is OpencodeModel => m != null),
    delegateGroups: mapGroups(picker.delegateGroups, byKey),
    unsupported: false,
  };
}

/**
 * Loads `models:picker` and refetches on the box's `models.updated` hint and on
 * `model-prefs.updated` (recents). An older box that has no such channel falls
 * back to the raw list with `unsupported: true`.
 */
export function useModelsPicker(models: OpencodeModel[] | null): ModelsPickerView & { recents: ModelsPickerResult["recents"] } {
  const [picker, setPicker] = useState<ModelsPickerResult | null>(null);
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    let alive = true;
    // Tolerate a pre-pairing / test `window.api` that has no models channels.
    const api = (window.api ?? {}) as Partial<typeof window.api>;
    if (!api.modelsPicker) return;
    const load = () => {
      window.api.modelsPicker().then(
        (r) => {
          if (!alive) return;
          setPicker(r);
          setUnsupported(false);
        },
        (e) => {
          if (alive && isUnknownChannel(e)) setUnsupported(true);
        },
      );
    };
    load();
    const offModels = api.onModelsUpdated?.(load);
    const offPrefs = api.onModelPrefsUpdated?.(load);
    return () => {
      alive = false;
      offModels?.();
      offPrefs?.();
    };
  }, []);

  return useMemo(() => {
    const view = buildPickerView(models, unsupported ? null : picker, unsupported);
    return { ...view, recents: unsupported ? [] : (picker?.recents ?? []) };
  }, [models, picker, unsupported]);
}
