// modelPicker.ts — pure mapping of the box's `opencode:models` RPC response
// into the grouped view model the Settings model picker renders, plus the
// "which row is currently the default" decision.
//
// The box exposes the CONNECTED providers' models on the `opencode:models`
// channel (src/server/rpc.mjs → oc.listModels()), which returns a FLAT list of
// `{ id, providerID, name, ... }` — one entry per model, already filtered to
// providers that have credentials on the box. (The `opencode:get-providers`
// channel the issue mentions is a desktop-only stub that returns `[]` on the
// box — src/server/rpc.mjs line 226 — so `opencode:models` is the real source
// of the connected model list, matching what the desktop onboarding ModelStep
// uses: `window.api.opencodeModels()`.)
//
// The current default comes from the `opencode:default-model` channel
// (`{ providerID, modelID } | null`), and selecting a model persists it via
// `config:update({ defaultModel })` — the SAME config write the desktop store's
// setDefaultModel uses (src/renderer/store.ts). All of that wiring is impure and
// lives in ../api/pairingApi; THIS module owns only the raw-JSON → picker-VM
// transform + the default-match decision, so it is fully unit-testable without a
// live box, exactly like the other mobile-rn pure modules.

/** The current default model selection, as returned by `opencode:default-model`. */
export interface DefaultModel {
  providerID: string;
  modelID: string;
}

/** One selectable model row in the picker. */
export interface ModelRowVM {
  /** Stable key + the value passed back to setDefaultModel: `<providerID>/<modelID>`. */
  key: string;
  providerID: string;
  modelID: string;
  /** Human label (the model's `name`, falling back to its id). */
  label: string;
  /** True when this row matches the current default (drives the checkmark). */
  selected: boolean;
}

/** A provider group (section) with its model rows. */
export interface ProviderGroupVM {
  providerID: string;
  rows: ModelRowVM[];
}

/**
 * Whether a raw model row from `opencode:models` matches the given default.
 * Both `providerID` and the model id must match. Pure.
 */
function matchesDefault(
  providerID: string,
  modelID: string,
  def: DefaultModel | null,
): boolean {
  return !!def && def.providerID === providerID && def.modelID === modelID;
}

/**
 * Map a raw `opencode:models` response (flat array of normalized model objects)
 * into provider-grouped picker sections, marking the row that matches the
 * current default as `selected`.
 *
 * Defensive against a malformed/partial response (non-array input, non-object
 * entries, missing id/providerID) — a bad shape simply drops that entry rather
 * than throwing, so a transient box hiccup can't crash the Settings screen.
 * Provider order and within-provider model order follow first-seen order in the
 * raw list (the box already returns connected providers only). Pure.
 */
export function mapModelGroups(
  raw: unknown,
  def: DefaultModel | null,
): ProviderGroupVM[] {
  if (!Array.isArray(raw)) return [];
  const groups: ProviderGroupVM[] = [];
  const byProvider = new Map<string, ProviderGroupVM>();
  const seenKeys = new Set<string>();

  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const providerID = (m as { providerID?: unknown }).providerID;
    const modelID = (m as { id?: unknown }).id;
    if (typeof providerID !== "string" || providerID.length === 0) continue;
    if (typeof modelID !== "string" || modelID.length === 0) continue;

    const key = `${providerID}/${modelID}`;
    // A provider can legitimately list a model once; guard against duplicate
    // entries so a repeated row doesn't render twice.
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const nameRaw = (m as { name?: unknown }).name;
    const label =
      typeof nameRaw === "string" && nameRaw.length > 0 ? nameRaw : modelID;

    const row: ModelRowVM = {
      key,
      providerID,
      modelID,
      label,
      selected: matchesDefault(providerID, modelID, def),
    };

    let group = byProvider.get(providerID);
    if (!group) {
      group = { providerID, rows: [] };
      byProvider.set(providerID, group);
      groups.push(group);
    }
    group.rows.push(row);
  }

  return groups;
}

/**
 * Flatten the mapped groups back into a single ordered row list (some renderers
 * want a plain FlatList rather than sections). Preserves group + row order.
 * Pure.
 */
export function flattenModelRows(groups: ProviderGroupVM[]): ModelRowVM[] {
  const out: ModelRowVM[] = [];
  for (const g of groups) out.push(...g.rows);
  return out;
}

/**
 * Total number of selectable models across all provider groups. Pure — used to
 * decide between the "pick a model" list and the "no connected models" empty
 * state without re-walking the raw response in the component.
 */
export function countModels(groups: ProviderGroupVM[]): number {
  let n = 0;
  for (const g of groups) n += g.rows.length;
  return n;
}

/**
 * Parse a picker row key (`<providerID>/<modelID>`) back into a DefaultModel.
 * The split is on the FIRST slash only, since a modelID can itself contain
 * slashes (e.g. "meta-llama/llama-3.3-70b"). Returns null for a malformed key
 * (no slash, empty side) so the caller can ignore a bad tap. Pure.
 */
export function parseModelKey(key: string): DefaultModel | null {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash >= key.length - 1) return null;
  const providerID = key.slice(0, slash);
  const modelID = key.slice(slash + 1);
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}
