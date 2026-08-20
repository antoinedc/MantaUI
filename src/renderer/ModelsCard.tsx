// ===== ModelsCard (BET-215) =====
//
// Replaces three AI-tab sections in Settings with one consolidated model table:
//   - the legacy "Default model" <select> block
//   - the read-only "Model reference" catalog
//   - the legacy `SubagentsCard` (kept verbatim here minus the rename / add-
//     custom-subagent affordances the consolidation drops)
//
// Per-row controls:
//   - **Default**  : single-select radio (one radio group across the whole
//                    table). Disabled when Main is off. Writes AppConfig.defaultModel.
//   - **Main**     : toggle. Off → hidden from the chat composer's ModelPicker.
//                    On→off on the current default also clears defaultModel
//                    in the SAME save (a default must be Main-available).
//   - **Sub**      : toggle. Off → the model is removed from opencode.jsonc's
//                    agent block list (BET-123 / opencodeSyncSubagents).
//
// "Default" reflects the SAVED value (not in-table unsaved edits), so the
// banner only updates after a configUpdate round-trip — mirrors the existing
// opt-out semantics (configGet / configUpdate only, no store live mirroring
// inside the card).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pencil, X } from "lucide-react";
import { describeModel } from "../shared/modelGuide.mjs";
import { formatModelContextSize } from "./chatUtils";
import { useStore } from "./store";
import type { AppConfig, ModelOverride, OpencodeModel } from "../shared/types";
import { Checkbox } from "./Checkbox";
import { Tag } from "./Tag";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { refreshModelCatalog } from "./modelCatalog";
import { useCachedResource } from "./useCachedResource";
import { MantaLoader } from "./MantaLoader";
import { isDeprecated } from "./chatUtils";
import {
  ModelsWeCouldntIdentify,
  type DeclaredModel,
} from "./ModelsWeCouldntIdentify";
import { useRoutingCatalog } from "./routingCatalog";

function modelKey(providerID: string, id: string): string {
  return `${providerID}/${id}`;
}

const TIER_CLASS: Record<string, string> = {
  fast: "bg-ok-bg text-ok",
  balanced: "bg-accent-bg text-accent-tx",
  deep: "bg-accent-bg text-accent-tx",
};

// The overlay dialog for editing a model's display name / description /
// context size. Prefilled from the model's current effective values; Save
// returns a ModelOverride with ONLY the fields that differ (empty object = no
// effective override → the caller removes the model's key from the store).
function EditModelModal({
  model,
  open = true,
  onSave,
  onCancel,
}: {
  model: OpencodeModel;
  // Controlled presence. The modal stays mounted (portaled) so Modal can play
  // its exit; `open` comes from the caller's editing state.
  open?: boolean;
  onSave: (override: ModelOverride) => void;
  onCancel: () => void;
}) {
  const info = describeModel(model.providerID, model.id);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState(model.name);
  const [description, setDescription] = useState(
    model.description ?? info?.blurb ?? "",
  );
  const [context, setContext] = useState(
    typeof model.limit?.context === "number" ? String(model.limit.context) : "",
  );

  // The dialog lives under a full-screen container that re-renders on store
  // updates; `autoFocus` can be visually disrupted by sibling re-renders, so
  // grab focus explicitly once on mount rather than relying on it.
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const save = () => {
    const override: ModelOverride = {};
    const n = name.trim();
    if (n !== "" && n !== model.name) override.name = n;
    const d = description.trim();
    if (d !== "" && d !== (model.description ?? info?.blurb ?? "")) override.description = d;
    const c = context.trim();
    if (c !== "") {
      const num = Number(c);
      if (Number.isFinite(num) && num > 0 && num !== model.limit?.context) override.context = num;
    }
    onSave(override);
  };

  const fieldCls =
    "w-full bg-bg-soft border border-border px-3 py-2 text-body rounded-xs focus:outline-none focus:border-accent";

  return (
    <Modal open={open} size="md" onDismiss={onCancel} label={`Edit ${model.name}`}>
      {/* Escape is owned by Modal (BET-724) via onDismiss above — no
          hand-rolled handler needed here. */}
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-body font-semibold text-text">Edit model</div>
            <div className="text-meta text-text-faint">
              {model.providerID} / {model.id}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-text-muted hover:text-text leading-none inline-flex items-center"
            aria-label="Close"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <label className="block">
          <span className="block text-micro font-semibold uppercase text-text-muted mb-1">Name</span>
          <input
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={fieldCls}
          />
        </label>

        <label className="block">
          <span className="block text-micro font-semibold uppercase text-text-muted mb-1">Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className={`${fieldCls} resize-y`}
          />
        </label>

        <label className="block">
          <span className="block text-micro font-semibold uppercase text-text-muted mb-1">Context size (tokens)</span>
          <input
            type="number"
            min={1}
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="e.g. 200000"
            className={fieldCls}
          />
        </label>

        <div className="text-meta text-text-faint">
          Leave a field blank to keep the provider's default for it.
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onCancel} tone="ghost">Cancel</Button>
          <Button onClick={save} tone="primary">Save</Button>
        </div>
      </div>
    </Modal>
  );
}

// The Main + Sub column toggles. Migrated to the Checkbox primitive (BET-589)
// from the old iOS-style toggle switch; the bound state, disabled flag, and
// an optional aria-label are the only per-call-site differences.
export function ModelsCard() {
  const setStoreDefaultModel = useStore((s) => s.setDefaultModel);
  // Saved default echoed in the banner above the search. Mirror the SAVED
  // value, not local unsaved edits — read from the store (which is fed by
  // configGet on refresh / configUpdate after a save).
  const savedDefault = useStore((s) => s.defaultModel);

  // Local working state for the toggles. Hydrated from configGet on mount.
  const [deactivatedMain, setDeactivatedMain] = useState<Set<string>>(new Set());
  const [deactivatedSub, setDeactivatedSub] = useState<Set<string>>(new Set());
  // BET-1139: deprecated models the user explicitly opted back in to
  // ("providerID/modelID"). Shared with the main picker's opt-in rows.
  const [optIn, setOptIn] = useState<Set<string>>(new Set());
  // The model list + config are fetched through the shared cache (BET-1057).
  // The synchronized subagent reconcile stays inside the fetcher so it runs
  // on every (re)load exactly as before.
  const {
    data,
    loading,
    error,
    refresh,
    mutate,
  } = useCachedResource<{ models: OpencodeModel[]; cfg: AppConfig }>("models", async () => {
    const [modelList, cfg] = await Promise.all([
      window.api.opencodeModels(),
      window.api.configGet(),
    ]);
    const deactivatedSubList = cfg.deactivatedSubagents ?? [];
    const optInList = cfg.optInModels ?? [];
    // The server (opencode:models) is the single source of truth for display
    // overrides, so the model list it returns is already overridden — use it
    // as-is.
    await window.api.opencodeSyncSubagents({
      models: modelList,
      deactivated: deactivatedSubList,
      optIn: optInList,
    });
    return { models: modelList, cfg };
  });
  const models = data?.models ?? null;
  // Hydrate the toggle state from the freshly-fetched config. The toggles
  // write their own local state on mutation, so this only runs when the
  // cached config actually changes (mount + explicit refresh).
  useEffect(() => {
    if (!data) return;
    setDeactivatedMain(new Set(data.cfg.deactivatedMainModels ?? []));
    setDeactivatedSub(new Set(data.cfg.deactivatedSubagents ?? []));
    setOptIn(new Set(data.cfg.optInModels ?? []));
  }, [data]);
  // Tracks which model row is mid-mutation (key), or "__main__" /
  // "__default__" for the banner-side actions.
  const [busy, setBusy] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // Key ("providerID/modelID") of the model whose edit dialog is open, or null.
  const [editing, setEditing] = useState<string | null>(null);
  // Keeps the edit modal rendered with the last-edited model while it plays
  // its close exit (see the portal below).
  const lastEditModel = useRef<OpencodeModel | null>(null);

  // (Reused as-is from the prior SubagentsCard — subagent reconcile is the
  // only opencode.jsonc writing the table triggers.) A sub toggle change
  // needs an opencode restart to take effect; rather than show a per-card
  // restart prompt (BET-420 collapsed the three prompts into one panel-level
  // banner), we raise the shared `opencodeRestartNeeded` flag and let the
  // Settings panel offer the single restart button.

  // ---- Toggles ----
  //
  // Main toggle: off → adds key to deactivatedMainModels. If the row is the
  // CURRENT default, also clear defaultModel in the same configUpdate so the
  // invariant "defaultModel implies Main-available" holds in the persisted
  // config. Sub toggle: off → adds key to deactivatedSubagents + sync, same
  // as the prior SubagentsCard.

  const toggleMain = useCallback(
    async (key: string, currentlyMain: boolean) => {
      if (busy || !models) return;
      setBusy(key);
      const nextMain = new Set(deactivatedMain);
      if (currentlyMain) nextMain.add(key);
      else nextMain.delete(key);
      const nextMainList = [...nextMain];
      // Invariant: a saved defaultModel MUST be Main-available. When the
      // user turns Main off on the current default, clear defaultModel in
      // the SAME save so the persisted config never violates the invariant.
      const isCurrentDefault =
        currentlyMain &&
        savedDefault != null &&
        modelKey(savedDefault.providerID, savedDefault.modelID) === key;
      const patch: Record<string, unknown> = { deactivatedMainModels: nextMainList };
      if (isCurrentDefault) {
        // `null` (not `undefined`) — JSON.stringify drops `undefined` keys,
        // so passing null is the only way the server actually clears the
        // field. The store's applyConfig normalizes any null back to null
        // and the existing defaultModel?: type allows absence.
        patch.defaultModel = null;
      }
      await mutate(async () => {
        const cfg = await window.api.configUpdate(patch);
        const resolvedList = cfg.deactivatedMainModels ?? nextMainList;
        setDeactivatedMain(new Set(resolvedList));
        if (isCurrentDefault) {
          // Mirror the cleared default into the store so the banner + every
          // other reader of `defaultModel` flips off in the same tick. Use
          // setState directly (not setStoreDefaultModel — that helper is
          // typed for setting, not clearing).
          useStore.setState({ defaultModel: null });
        }
      });
      setBusy(null);
    },
    [busy, mutate, models, deactivatedMain, savedDefault],
  );

  const toggleSub = useCallback(
    async (key: string, currentlyActive: boolean) => {
      if (busy || !models) return;
      setBusy(key);
      const nextSet = new Set(deactivatedSub);
      if (currentlyActive) nextSet.add(key);
      else nextSet.delete(key);
      const nextList = [...nextSet];
      await mutate(async () => {
        const cfg = await window.api.configUpdate({ deactivatedSubagents: nextList });
        const resolvedList = cfg.deactivatedSubagents ?? nextList;
        await window.api.opencodeSyncSubagents({
          models,
          deactivated: resolvedList,
          optIn: [...optIn],
        });
        setDeactivatedSub(new Set(resolvedList));
        // Sub toggles write opencode.jsonc agent blocks — a restart is
        // required for opencode to re-read them. Raise the panel banner.
        useStore.getState().setOpencodeRestartNeeded(true);
      });
      setBusy(null);
    },
    [busy, mutate, models, deactivatedSub, optIn],
  );

  // BET-1139: persist the user's opt-in for a deprecated model. Reconcile the
  // subagents so the now-opted-in model's block is registered (and, being a
  // shared set, the main picker row becomes selectable too).
  const enableDeprecated = useCallback(
    async (key: string) => {
      if (busy || !models) return;
      setBusy(key);
      const nextList = [...new Set([...optIn, key])];
      await mutate(async () => {
        const cfg = await window.api.configUpdate({ optInModels: nextList });
        const resolvedList = cfg.optInModels ?? nextList;
        await window.api.opencodeSyncSubagents({
          models,
          deactivated: [...deactivatedSub],
          optIn: resolvedList,
        });
        setOptIn(new Set(resolvedList));
        useStore.getState().setOpencodeRestartNeeded(true);
      });
      setBusy(null);
    },
    [busy, mutate, models, deactivatedSub, optIn],
  );

  // Default radio — single-select. Writes defaultModel via the store's
  // setDefaultModel so the banner + everything else mirrors consistently.
  const setDefault = useCallback(
    async (providerID: string, modelID: string) => {
      if (busy) return;
      setBusy("__default__");
      await mutate(async () => {
        await setStoreDefaultModel({ providerID, modelID });
        void refresh();
      });
      setBusy(null);
    },
    [busy, mutate, setStoreDefaultModel, refresh],
  );

  // Save a model display override (name / description / context) drafted in the
  // edit modal. Writes the full modelOverrides map to config, then re-fetches
  // the model list from the server (the single source of truth, which applies
  // the override in opencode:models) so both the table and the composed model
  // catalog reflect the change in the same tick.
  const saveOverride = useCallback(
    async (key: string, _model: OpencodeModel, override: ModelOverride) => {
      if (busy) return;
      setBusy(key);
      await mutate(async () => {
        const cfg = await window.api.configGet();
        const existing = cfg.modelOverrides ?? {};
        const next = { ...existing };
        if (Object.keys(override).length === 0) delete next[key];
        else next[key] = override;
        await window.api.configUpdate({ modelOverrides: next });
        // Server re-reads config per opencode:models call, so a fresh cache
        // refresh is already overridden.
        await refresh();
        setEditing(null);
        refreshModelCatalog();
      });
      setBusy(null);
    },
    [busy, mutate, refresh],
  );

  // ---- "Models we couldn't identify" (BET-1249) ----
  // The provider-agnostic catalogue (fetched once) that resolves opaque
  // endpoint identity + powers the typeahead. The user declarations live in
  // AppConfig.modelRouting.declaredModels, read from the same cfg the table
  // already holds.
  const routingCatalog = useRoutingCatalog();

  const declareModel = useCallback(
    async (key: string, decl: DeclaredModel) => {
      if (busy || !models) return;
      setBusy(key);
      await mutate(async () => {
        const cfg = await window.api.configGet();
        const routing = cfg.modelRouting ?? { preset: "balanced" };
        const declared = { ...(routing.declaredModels ?? {}), [key]: decl };
        await window.api.configUpdate({
          modelRouting: { ...routing, declaredModels: declared },
        });
        // The block's rows derive from `declaredModels` (via the cached cfg),
        // so a fresh fetch removes the now-declared endpoint in the same tick.
        await refresh();
      });
      setBusy(null);
    },
    [busy, mutate, models, refresh],
  );

  // ---- Render ----

  const filtered = useMemo(() => {
    if (!models) return [];
    if (!searchQuery.trim()) return models;
    const q = searchQuery.toLowerCase();
    return models.filter((m) => {
      const info = describeModel(m.providerID, m.id);
      return (
        m.name.toLowerCase().includes(q) ||
        m.providerID.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.description?.toLowerCase().includes(q) ?? false) ||
        (info?.blurb.toLowerCase().includes(q) ?? false) ||
        (info?.goodFor.some((g) => g.toLowerCase().includes(q)) ?? false)
      );
    });
  }, [models, searchQuery]);

  return (
    <div className="space-y-3">
      {/* BET-1249: surfaced above the table, only when a model needs identity. */}
      {models && (
        <ModelsWeCouldntIdentify
          models={models}
          declaredModels={data?.cfg.modelRouting?.declaredModels}
          catalog={routingCatalog}
          busyKey={busy}
          onDeclare={declareModel}
        />
      )}

      <div>
        <div className="text-meta text-text-faint">
          <b className="text-text-muted">Default</b> = the model new &amp; cleared sessions start on (exactly one; must be Main-available).{" "}
          <b className="text-text-muted">Main</b> = selectable as the chat main agent (off hides it from the composer's model picker).{" "}
          <b className="text-text-muted">Sub</b> = dispatchable as a subagent.
        </div>
      </div>

      {/* Saved & active default banner — reads from the store, NOT local
          edits, so it stays in sync with what's actually persisted. */}
      <div
        className={`flex items-center gap-2 bg-bg-soft border border-border rounded-xs px-3 py-2 ${
          savedDefault ? "" : "text-text-faint italic"
        }`}
      >
        <span className="text-micro font-semibold uppercase text-text-faint">Default</span>
        {savedDefault ? (() => {
          const m = models?.find(
            (x) => x.providerID === savedDefault.providerID && x.id === savedDefault.modelID,
          );
          return (
            <span className="text-label text-text font-semibold inline-flex items-center gap-2">
              {m?.name ?? savedDefault.modelID}
              <span className="text-text-faint font-normal">{savedDefault.providerID}</span>
            </span>
          );
        })() : (
          <span className="text-label">No default set — opencode default (server decides)</span>
        )}
      </div>

      {error && <div className="text-meta text-danger">{error}</div>}

      <input
        type="text"
        placeholder="Search models by name, provider, capability…"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        className="w-full bg-bg-soft border border-border px-3 py-2 text-body rounded-xs focus:outline-none focus:border-accent"
      />

      {loading ? (
        <div className="py-2">
          <MantaLoader size="inline" label="Loading models" />
        </div>
      ) : (
      <div className="border border-border rounded-xs overflow-x-auto">
        <table className="w-full text-body">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left text-micro font-semibold uppercase text-text-faint font-semibold px-3 py-2">
                Model
              </th>
              <th className="text-center text-micro font-semibold uppercase text-text-faint font-semibold px-3 py-2 w-[80px]">
                Default
                <span className="block text-meta normal-case tracking-normal text-text-faint font-normal mt-px">
                  main
                </span>
              </th>
              <th className="text-center text-micro font-semibold uppercase text-text-faint font-semibold px-3 py-2 w-[80px]">
                Main
                <span className="block text-meta normal-case tracking-normal text-text-faint font-normal mt-px">
                  agent
                </span>
              </th>
              <th className="text-center text-micro font-semibold uppercase text-text-faint font-semibold px-3 py-2 w-[80px]">
                Sub
                <span className="block text-meta normal-case tracking-normal text-text-faint font-normal mt-px">
                  agent
                </span>
              </th>
              {/* Unlabeled trailing column: per-row edit affordance. */}
              <th className="w-[48px]" aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-meta text-text-faint">
                  No models found
                </td>
              </tr>
            )}
            {filtered.map((m) => {
              const key = modelKey(m.providerID, m.id);
              // BET-1139: a deprecated model is disabled-by-default (all
              // row controls locked) until the user opts it back in via the
              // shared optIn set — the same opt-in that enables it in the
              // main picker and registers it as a subagent.
              const deprecated = isDeprecated(m);
              const optedIn = optIn.has(key);
              const deprecatedDisabled = deprecated && !optedIn;
              const isMain = deprecatedDisabled ? false : !deactivatedMain.has(key);
              const isSub = deprecatedDisabled ? false : !deactivatedSub.has(key);
              const isDefault =
                savedDefault != null &&
                savedDefault.providerID === m.providerID &&
                savedDefault.modelID === m.id;
              const info = describeModel(m.providerID, m.id);
              const ctxSize = formatModelContextSize(m.limit?.context);
              const desc = m.description ?? info?.blurb;
              const isBusy = busy === key;
              const rowDisabled = isBusy || deprecatedDisabled;
              return (
                <tr
                  key={key}
                  className={`border-b border-border/40 hover:bg-bg-soft/40 ${
                    deprecatedDisabled ? "opacity-60" : ""
                  }`}
                >
                  <td className="px-3 py-2 align-middle">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-body text-text font-medium">{m.name}</span>
                      <span className="text-meta text-text-faint">{m.providerID}</span>
                      {ctxSize && <Tag numeric>{ctxSize}</Tag>}
                      {deprecated && <Tag numeric>deprecated</Tag>}
                      {info && (
                        <span className={`px-2 py-px rounded-xs text-meta ${TIER_CLASS[info.tier]}`}>
                          {info.tier}
                        </span>
                      )}
                    </div>
                    {desc && (
                      <div className="text-label text-text-faint mt-1 max-w-[440px]">
                        {desc}
                      </div>
                    )}
                    {deprecatedDisabled && (
                      <button
                        type="button"
                        onClick={() => void enableDeprecated(key)}
                        disabled={isBusy}
                        className="mt-1 text-meta text-accent hover:underline disabled:opacity-40"
                      >
                        Enable deprecated (also registers as a subagent)
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2 align-middle text-center">
                    <input
                      type="radio"
                      name="defaultModel"
                      checked={isDefault}
                      disabled={!isMain || rowDisabled}
                      onChange={() => void setDefault(m.providerID, m.id)}
                      title={
                        deprecatedDisabled
                          ? "Enable this deprecated model first"
                          : isMain
                            ? "Set as default main model"
                            : "Enable Main first"
                      }
                      className="appearance-none w-4 h-4 rounded-full border-[1.5px] border-border-strong bg-bg cursor-pointer checked:border-accent checked:bg-accent-solid disabled:opacity-30 disabled:cursor-not-allowed relative"
                      style={
                        isDefault
                          ? { backgroundColor: "var(--accent-solid)", borderColor: "var(--accent)" }
                          : undefined
                      }
                    />
                  </td>
                  <td className="px-3 py-2 align-middle text-center">
                    <Checkbox
                      checked={isMain}
                      disabled={rowDisabled}
                      onChange={() => void toggleMain(key, isMain)}
                      ariaLabel={`Main availability for ${m.name}`}
                    />
                  </td>
                  <td className="px-3 py-2 align-middle text-center">
                    <Checkbox
                      checked={isSub}
                      disabled={rowDisabled}
                      onChange={() => void toggleSub(key, isSub)}
                      ariaLabel={`Sub availability for ${m.name}`}
                    />
                  </td>
                  <td className="px-3 py-2 align-middle text-center">
                    <button
                      type="button"
                      onClick={() => setEditing(key)}
                      disabled={rowDisabled}
                      className="inline-flex items-center justify-center p-2 rounded-xs text-text-faint hover:text-text hover:bg-fill-hover disabled:opacity-30 disabled:cursor-not-allowed"
                      aria-label={`Edit ${m.name}`}
                      title="Edit name / description / context"
                    >
                      <Pencil size={14} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}

      {models && (() => {
        const target = editing
          ? (models.find((m) => modelKey(m.providerID, m.id) === editing) ?? null)
          : null;
        // Keep the modal MOUNTED (so Modal can play its exit) even after the
        // user closes it; during the fade the last-edited model still renders.
        if (target) lastEditModel.current = target;
        const model = lastEditModel.current ?? models[0];
        if (!model) return null;
        // Modal portals itself to document.body (BET-885).
        return (
          <EditModelModal
            model={model}
            open={!!target}
            onSave={(override) => void saveOverride(modelKey(model.providerID, model.id), model, override)}
            onCancel={() => setEditing(null)}
          />
        );
      })()}
    </div>
  );
}
