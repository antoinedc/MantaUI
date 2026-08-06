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
import { createPortal } from "react-dom";
import { Pencil, X } from "lucide-react";
import { describeModel } from "../shared/modelGuide.mjs";
import { formatModelContextSize } from "./chatUtils";
import { useStore } from "./store";
import type { ModelOverride, OpencodeModel } from "../shared/types";
import { Checkbox } from "./Checkbox";
import { Tag } from "./Tag";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { refreshModelCatalog } from "./modelCatalog";

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
  onSave,
  onCancel,
}: {
  model: OpencodeModel;
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
    <Modal size="md" onDismiss={onCancel} label={`Edit ${model.name}`}>
      <div
        className="space-y-4"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
      >
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

  const [models, setModels] = useState<OpencodeModel[] | null>(null);
  // Local working state for the toggles. Hydrated from configGet on mount.
  const [deactivatedMain, setDeactivatedMain] = useState<Set<string>>(new Set());
  const [deactivatedSub, setDeactivatedSub] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  // Tracks which model row is mid-mutation (key), or "__main__" /
  // "__default__" for the banner-side actions.
  const [busy, setBusy] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // Key ("providerID/modelID") of the model whose edit dialog is open, or null.
  const [editing, setEditing] = useState<string | null>(null);

  // Load models + config + reconcile subagents on mount. Mirrors the
  // SubagentsCard.refresh() flow (BET-123): every known model is auto-
  // registered as a named subagent; the user opts OUT via the Sub toggle.
  const refresh = useCallback(async () => {
    setGlobalError(null);
    try {
      const [modelList, cfg] = await Promise.all([
        window.api.opencodeModels(),
        window.api.configGet(),
      ]);
      const deactivatedMainList = cfg.deactivatedMainModels ?? [];
      const deactivatedSubList = cfg.deactivatedSubagents ?? [];
      // The server (opencode:models) is the single source of truth for display
      // overrides, so the model list it returns is already overridden — use it
      // as-is.
      const agents = await window.api.opencodeSyncSubagents({
        models: modelList,
        deactivated: deactivatedSubList,
      });
      setModels(modelList);
      setDeactivatedMain(new Set(deactivatedMainList));
      setDeactivatedSub(new Set(deactivatedSubList));
      // Result ignored — the consolidated table doesn't show per-agent
      // names ("task(...)" or "registering…") since the column was dropped
      // in BET-215. Calling sync is still required to apply the Sub toggle
      // to opencode.jsonc.
      void agents;
    } catch (e) {
      setGlobalError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      setGlobalError(null);
      try {
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
      } catch (e) {
        setGlobalError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [busy, models, deactivatedMain, savedDefault],
  );

  const toggleSub = useCallback(
    async (key: string, currentlyActive: boolean) => {
      if (busy || !models) return;
      setBusy(key);
      setGlobalError(null);
      try {
        const nextSet = new Set(deactivatedSub);
        if (currentlyActive) nextSet.add(key);
        else nextSet.delete(key);
        const nextList = [...nextSet];
        const cfg = await window.api.configUpdate({ deactivatedSubagents: nextList });
        const resolvedList = cfg.deactivatedSubagents ?? nextList;
        await window.api.opencodeSyncSubagents({
          models,
          deactivated: resolvedList,
        });
        setDeactivatedSub(new Set(resolvedList));
        // Sub toggles write opencode.jsonc agent blocks — a restart is
        // required for opencode to re-read them. Raise the panel banner.
        useStore.getState().setOpencodeRestartNeeded(true);
      } catch (e) {
        setGlobalError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [busy, models, deactivatedSub],
  );

  // Default radio — single-select. Writes defaultModel via the store's
  // setDefaultModel so the banner + everything else mirrors consistently.
  const setDefault = useCallback(
    async (providerID: string, modelID: string) => {
      if (busy) return;
      setBusy("__default__");
      setGlobalError(null);
      try {
        await setStoreDefaultModel({ providerID, modelID });
      } catch (e) {
        setGlobalError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [busy, setStoreDefaultModel],
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
      setGlobalError(null);
      try {
        const cfg = await window.api.configGet();
        const existing = cfg.modelOverrides ?? {};
        const next = { ...existing };
        if (Object.keys(override).length === 0) delete next[key];
        else next[key] = override;
        await window.api.configUpdate({ modelOverrides: next });
        // Server re-reads config per opencode:models call, so a fresh fetch is
        // already overridden.
        setModels(await window.api.opencodeModels());
        setEditing(null);
        refreshModelCatalog();
      } catch (e) {
        setGlobalError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [busy],
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
    <div className="space-y-3 pt-2 border-t border-border">
      <div>
        <label className="block text-micro font-semibold uppercase text-text-muted mb-1">
          Models
        </label>
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

      {globalError && <div className="text-meta text-danger">{globalError}</div>}
      {loading && <div className="text-meta text-text-faint">Loading models…</div>}

      <input
        type="text"
        placeholder="Search models by name, provider, capability…"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        className="w-full bg-bg-soft border border-border px-3 py-2 text-body rounded-xs focus:outline-none focus:border-accent"
      />

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
              const isMain = !deactivatedMain.has(key);
              const isSub = !deactivatedSub.has(key);
              const isDefault =
                savedDefault != null &&
                savedDefault.providerID === m.providerID &&
                savedDefault.modelID === m.id;
              const info = describeModel(m.providerID, m.id);
              const ctxSize = formatModelContextSize(m.limit?.context);
              const desc = m.description ?? info?.blurb;
              const isBusy = busy === key;
              return (
                <tr key={key} className="border-b border-border/40 hover:bg-bg-soft/40">
                  <td className="px-3 py-2 align-middle">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-body text-text font-medium">{m.name}</span>
                      <span className="text-meta text-text-faint">{m.providerID}</span>
                      {ctxSize && <Tag numeric>{ctxSize}</Tag>}
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
                  </td>
                  <td className="px-3 py-2 align-middle text-center">
                    <input
                      type="radio"
                      name="defaultModel"
                      checked={isDefault}
                      disabled={!isMain || isBusy}
                      onChange={() => void setDefault(m.providerID, m.id)}
                      title={isMain ? "Set as default main model" : "Enable Main first"}
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
                      disabled={isBusy}
                      onChange={() => void toggleMain(key, isMain)}
                      ariaLabel={`Main availability for ${m.name}`}
                    />
                  </td>
                  <td className="px-3 py-2 align-middle text-center">
                    <Checkbox
                      checked={isSub}
                      disabled={isBusy}
                      onChange={() => void toggleSub(key, isSub)}
                      ariaLabel={`Sub availability for ${m.name}`}
                    />
                  </td>
                  <td className="px-3 py-2 align-middle text-center">
                    <button
                      type="button"
                      onClick={() => setEditing(key)}
                      disabled={isBusy}
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

      {editing && models && (() => {
        const target = models.find((m) => modelKey(m.providerID, m.id) === editing);
        if (!target) return null;
        // Render through a portal to document.body: the modal is the only one
        // in the app nested inside the full-screen Settings dialog, and
        // portaling it out of that frequently re-rendering subtree guarantees
        // a store-driven Settings re-render can never remount it (which would
        // drop focus from the field being typed in).
        return createPortal(
          <EditModelModal
            model={target}
            onSave={(override) => void saveOverride(modelKey(target.providerID, target.id), target, override)}
            onCancel={() => setEditing(null)}
          />,
          document.body,
        );
      })()}
    </div>
  );
}
