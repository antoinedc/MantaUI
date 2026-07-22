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

import { useCallback, useEffect, useMemo, useState } from "react";
import { describeModel } from "../shared/modelGuide.mjs";
import { formatModelContextSize } from "./chatUtils";
import { useStore } from "./store";
import type { OpencodeModel } from "../shared/types";

function modelKey(providerID: string, id: string): string {
  return `${providerID}/${id}`;
}

const TIER_CLASS: Record<string, string> = {
  fast: "bg-green-900/20 text-green-400",
  balanced: "bg-blue-900/20 text-blue-400",
  deep: "bg-purple-900/20 text-purple-400",
};

// iOS-style toggle switch used by the Main + Sub columns. Consolidates the
// two near-identical checkbox blocks (BET-215 reviewer nit, BET-219 follow-up).
// The bound state, disabled flag, and an optional aria-label are the only
// per-call-site differences; rendering is shared.
interface SwitchProps {
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
  "aria-label"?: string;
}

function Switch({ checked, disabled, onChange, "aria-label": ariaLabel }: SwitchProps) {
  return (
    <label className="inline-flex items-center cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-label={ariaLabel}
        className="peer sr-only"
      />
      <span
        className={`w-[30px] h-[18px] rounded-full border transition-colors relative ${
          checked
            ? "bg-accent-soft/40 border-accent"
            : "bg-bg border-border-strong"
        }`}
      >
        <span
          className={`absolute top-[2px] w-[12px] h-[12px] rounded-full transition-transform ${
            checked
              ? "translate-x-[12px] bg-accent"
              : "translate-x-[2px] bg-text-faint"
          }`}
        />
      </span>
    </label>
  );
}

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

  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartResult, setRestartResult] = useState<
    { ok: boolean; message: string } | null
  >(null);

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
  // only opencode.jsonc writing the table triggers.)
  const doRestart = useCallback(async () => {
    if (restarting) return;
    setRestarting(true);
    setRestartResult(null);
    try {
      await window.api.opencodeRestart();
      setRestartResult({ ok: true, message: "Restarted — subagent changes are now live." });
    } catch (e) {
      setRestartResult({
        ok: false,
        message: `Restart failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setRestarting(false);
      setRestartConfirmOpen(false);
    }
  }, [restarting]);

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
        (info?.blurb.toLowerCase().includes(q) ?? false) ||
        (info?.goodFor.some((g) => g.toLowerCase().includes(q)) ?? false)
      );
    });
  }, [models, searchQuery]);

  return (
    <div className="space-y-3 pt-2 border-t border-border">
      <div>
        <label className="block text-xs uppercase tracking-wider text-text-muted mb-1">
          Models
        </label>
        <div className="text-xs text-text-faint">
          <b className="text-text-muted">Default</b> = the model new &amp; cleared sessions start on (exactly one; must be Main-available).{" "}
          <b className="text-text-muted">Main</b> = selectable as the chat main agent (off hides it from the composer's model picker).{" "}
          <b className="text-text-muted">Sub</b> = dispatchable as a subagent.
        </div>
      </div>

      {/* Saved & active default banner — reads from the store, NOT local
          edits, so it stays in sync with what's actually persisted. */}
      <div
        className={`flex items-center gap-2 bg-bg-soft border border-border rounded px-3 py-1.5 ${
          savedDefault ? "" : "text-text-faint italic"
        }`}
      >
        <span className="text-[10px] uppercase tracking-wider text-text-faint">Default</span>
        {savedDefault ? (() => {
          const m = models?.find(
            (x) => x.providerID === savedDefault.providerID && x.id === savedDefault.modelID,
          );
          return (
            <span className="text-[13px] text-text font-semibold inline-flex items-center gap-2">
              {m?.name ?? savedDefault.modelID}
              <span className="text-text-faint font-normal">{savedDefault.providerID}</span>
            </span>
          );
        })() : (
          <span className="text-[13px]">No default set — opencode default (server decides)</span>
        )}
      </div>

      {globalError && <div className="text-xs text-red-400">{globalError}</div>}
      {loading && <div className="text-xs text-text-faint">Loading models…</div>}

      <input
        type="text"
        placeholder="Search models by name, provider, capability…"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        className="w-full bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent"
      />

      <div className="border border-border rounded overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left text-[10px] uppercase tracking-wider text-text-faint font-semibold px-3 py-2">
                Model
              </th>
              <th className="text-center text-[10px] uppercase tracking-wider text-text-faint font-semibold px-3 py-2 w-[80px]">
                Default
                <span className="block text-[9px] normal-case tracking-normal text-text-faint font-normal mt-0.5">
                  main
                </span>
              </th>
              <th className="text-center text-[10px] uppercase tracking-wider text-text-faint font-semibold px-3 py-2 w-[80px]">
                Main
                <span className="block text-[9px] normal-case tracking-normal text-text-faint font-normal mt-0.5">
                  agent
                </span>
              </th>
              <th className="text-center text-[10px] uppercase tracking-wider text-text-faint font-semibold px-3 py-2 w-[80px]">
                Sub
                <span className="block text-[9px] normal-case tracking-normal text-text-faint font-normal mt-0.5">
                  agent
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-xs text-text-faint">
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
              const isBusy = busy === key;
              return (
                <tr key={key} className="border-b border-border/40 hover:bg-bg-soft/40">
                  <td className="px-3 py-2 align-middle">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm text-text font-medium">{m.name}</span>
                      <span className="text-[10px] text-text-faint">{m.providerID}</span>
                      {ctxSize && <span className="text-[10px] text-text-faint">{ctxSize}</span>}
                      {info && (
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${TIER_CLASS[info.tier]}`}>
                          {info.tier}
                        </span>
                      )}
                    </div>
                    {info && (
                      <div className="text-[11px] text-text-faint mt-1 max-w-[440px]">
                        {info.blurb}
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
                      className="appearance-none w-4 h-4 rounded-full border-[1.5px] border-border-strong bg-bg cursor-pointer checked:border-accent checked:bg-accent disabled:opacity-30 disabled:cursor-not-allowed relative"
                      style={
                        isDefault
                          ? { backgroundColor: "var(--accent, #5A88FF)", borderColor: "var(--accent, #5A88FF)" }
                          : undefined
                      }
                    />
                  </td>
                  <td className="px-3 py-2 align-middle text-center">
                    <Switch
                      checked={isMain}
                      disabled={isBusy}
                      onChange={() => void toggleMain(key, isMain)}
                    />
                  </td>
                  <td className="px-3 py-2 align-middle text-center">
                    <Switch
                      checked={isSub}
                      disabled={isBusy}
                      onChange={() => void toggleSub(key, isSub)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Restart — Subagent changes still require a restart, so keep the
          existing SubagentsCard restart button + destructive-confirm copy
          verbatim (BET-123). */}
      <div className="border border-border rounded p-3 space-y-2 bg-bg-elev">
        {!restartConfirmOpen ? (
          <button
            onClick={() => { setRestartConfirmOpen(true); setRestartResult(null); }}
            className="px-3 py-1.5 text-xs bg-bg-soft border border-border rounded text-text-muted hover:text-text"
          >
            ⟳ Restart opencode
          </button>
        ) : (
          <div className="space-y-2">
            <div className="text-xs text-amber-400">
              Restarting opencode applies subagent changes but STOPS all
              running opencode sessions — any in-progress turns will be
              interrupted. Continue?
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => void doRestart()}
                disabled={restarting}
                className="px-3 py-1 text-xs bg-red-900/30 border border-red-800 rounded text-red-300 hover:text-red-200 disabled:opacity-40"
              >
                {restarting ? "Restarting…" : "Restart"}
              </button>
              <button
                onClick={() => setRestartConfirmOpen(false)}
                disabled={restarting}
                className="px-2 py-1 text-xs text-text-faint hover:text-text disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {restartResult && (
          <div className={`text-xs ${restartResult.ok ? "text-green-400" : "text-red-400"}`}>
            {restartResult.message}
          </div>
        )}
        <div className="text-[10px] text-text-faint">
          Restart applies config to opencode's own service (systemctl --user
          restart opencode-serve) — separate from manta-server itself.
        </div>
      </div>
    </div>
  );
}
