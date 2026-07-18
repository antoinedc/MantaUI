import { useEffect, useState, useCallback, useMemo } from "react";
import { describeModel } from "../shared/modelGuide.mjs";
import { formatModelContextSize } from "./chatUtils";
import type { SubagentDef, OpencodeModel } from "../shared/types";

// BET-123: every model opencode knows about is auto-registered as a named
// subagent (deactivable), rather than the user hand-picking which models
// become subagents (BET-121's model). One row per model, sourced from
// window.api.opencodeModels() — NOT from the configured agent blocks, so a
// model with no block yet still shows up (about to be registered on the next
// sync). `syncSubagents` reconciles opencode.jsonc against this list + the
// deactivated set on every load and every activation toggle.

function modelKey(providerID: string, id: string): string {
  return `${providerID}/${id}`;
}

const TIER_CLASS: Record<string, string> = {
  fast: "bg-green-900/20 text-green-400",
  balanced: "bg-blue-900/20 text-blue-400",
  deep: "bg-purple-900/20 text-purple-400",
};

type AddDraft = { name: string; model: string; description: string };
const EMPTY_ADD_DRAFT: AddDraft = { name: "", model: "", description: "" };

export function SubagentsCard() {
  const [models, setModels] = useState<OpencodeModel[] | null>(null);
  const [subagents, setSubagents] = useState<SubagentDef[] | null>(null);
  const [deactivated, setDeactivated] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null); // model key being mutated
  const [globalError, setGlobalError] = useState<string | null>(null);

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");

  const [addDraft, setAddDraft] = useState<AddDraft>(EMPTY_ADD_DRAFT);
  const [addOpen, setAddOpen] = useState(false);

  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartResult, setRestartResult] = useState<
    { ok: boolean; message: string } | null
  >(null);

  const refresh = useCallback(async () => {
    setGlobalError(null);
    try {
      const [modelList, cfg] = await Promise.all([
        window.api.opencodeModels(),
        window.api.configGet(),
      ]);
      const deactivatedList = cfg.deactivatedSubagents ?? [];
      const agents = await window.api.opencodeSyncSubagents({
        models: modelList,
        deactivated: deactivatedList,
      });
      setModels(modelList);
      setDeactivated(new Set(deactivatedList));
      setSubagents(agents);
    } catch (e) {
      setGlobalError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const agentByModel = useMemo(() => {
    const map = new Map<string, SubagentDef>();
    for (const a of subagents ?? []) if (!map.has(a.model)) map.set(a.model, a);
    return map;
  }, [subagents]);

  const toggleActive = useCallback(
    async (key: string, currentlyActive: boolean) => {
      if (busy || !models) return;
      setBusy(key);
      setGlobalError(null);
      try {
        const nextSet = new Set(deactivated);
        if (currentlyActive) nextSet.add(key);
        else nextSet.delete(key);
        const nextList = [...nextSet];
        const cfg = await window.api.configUpdate({ deactivatedSubagents: nextList });
        const resolvedList = cfg.deactivatedSubagents ?? nextList;
        const agents = await window.api.opencodeSyncSubagents({
          models,
          deactivated: resolvedList,
        });
        setDeactivated(new Set(resolvedList));
        setSubagents(agents);
      } catch (e) {
        setGlobalError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [busy, deactivated, models],
  );

  const startEdit = useCallback((key: string, agent: SubagentDef | undefined, fallbackName: string) => {
    setEditingKey(key);
    setDraftName(agent?.name ?? fallbackName);
    setDraftDescription(agent?.description ?? "");
    setGlobalError(null);
  }, []);

  const saveEdit = useCallback(
    async (key: string) => {
      if (busy) return;
      const name = draftName.trim();
      if (!name) return;
      setBusy(key);
      setGlobalError(null);
      try {
        const prevAgent = agentByModel.get(key);
        const res = await window.api.opencodeSetSubagents({
          upsert: [{ name, model: key, description: draftDescription.trim() }],
          remove: prevAgent && prevAgent.name !== name ? [prevAgent.name] : undefined,
        });
        if (!res.ok) { setGlobalError(res.error ?? "Save failed"); return; }
        setEditingKey(null);
        const agents = await window.api.opencodeGetSubagents();
        setSubagents(agents);
      } catch (e) {
        setGlobalError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [busy, draftName, draftDescription, agentByModel],
  );

  // Model select onChange prefills the description from the catalog, same
  // behavior as BET-121's card.
  const handleAddModelSelect = useCallback((modelStr: string) => {
    if (!modelStr) return;
    const [providerID, modelID] = modelStr.split("/");
    const info = describeModel(providerID, modelID);
    const prefillDesc = info ? `${info.blurb} Good for: ${info.goodFor.join(", ")}` : "";
    setAddDraft((d) => ({ ...d, model: modelStr, description: prefillDesc }));
  }, []);

  const addSubagent = useCallback(async () => {
    if (busy) return;
    const d = addDraft;
    if (!d.name.trim() || !d.model.trim()) return;
    setBusy("__add__");
    setGlobalError(null);
    try {
      const res = await window.api.opencodeSetSubagents({
        upsert: [{
          name: d.name.trim(),
          model: d.model.trim(),
          description: d.description.trim(),
        }],
      });
      if (!res.ok) { setGlobalError(res.error ?? "Add failed"); return; }
      setAddDraft(EMPTY_ADD_DRAFT);
      setAddOpen(false);
      await refresh();
    } catch (e) {
      setGlobalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [busy, addDraft, refresh]);

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

  return (
    <div className="space-y-2 pt-2 border-t border-border">
      <label className="block text-xs uppercase tracking-wider text-text-muted">
        Subagents
      </label>
      <div className="text-xs text-text-faint">
        Every model opencode knows about is registered as a named subagent
        automatically — deactivate the ones you don't want. The AI dispatches
        via{" "}
        <code className="text-text-muted">task(subagent_type: "name")</code>,
        even for models with no guidance below (callable by name).
      </div>

      {globalError && <div className="text-xs text-red-400">{globalError}</div>}
      {loading && <div className="text-xs text-text-faint">Loading models…</div>}

      {(models ?? []).map((m) => {
        const key = modelKey(m.providerID, m.id);
        const agent = agentByModel.get(key);
        const isActive = !deactivated.has(key);
        const info = describeModel(m.providerID, m.id);
        const ctxSize = formatModelContextSize(m.limit?.context);
        const isEditing = editingKey === key;
        const isBusy = busy === key;

        return (
          <div key={key} className="border border-border rounded p-2 space-y-1">
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1 shrink-0"
                checked={isActive}
                disabled={isBusy}
                onChange={() => toggleActive(key, isActive)}
                title={isActive ? "Deactivate this subagent" : "Activate this subagent"}
              />
              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-text font-medium truncate">{m.name}</span>
                  <span className="text-[10px] text-text-faint">{m.providerID}</span>
                  {ctxSize && <span className="text-[10px] text-text-faint">{ctxSize}</span>}
                  {info && (
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${TIER_CLASS[info.tier]}`}>
                      {info.tier}
                    </span>
                  )}
                </div>
                {isActive ? (
                  agent ? (
                    <code className="text-[10px] text-text-faint block truncate">
                      task(subagent_type: "{agent.name}")
                    </code>
                  ) : (
                    <span className="text-[10px] text-text-faint italic">registering…</span>
                  )
                ) : (
                  <span className="text-[10px] text-text-faint italic">deactivated</span>
                )}
                {info ? (
                  <div className="text-[10px] text-text-faint">{info.blurb}</div>
                ) : (
                  <div className="text-[10px] text-text-faint italic">
                    no guidance — callable by name
                  </div>
                )}
              </div>
              {isActive && agent && !isEditing && (
                <button
                  onClick={() => startEdit(key, agent, agent.name)}
                  disabled={isBusy}
                  className="px-2 py-1 text-xs bg-bg-soft border border-border rounded text-text-muted hover:text-text disabled:opacity-40 shrink-0"
                >
                  Edit
                </button>
              )}
            </div>

            {isEditing && (
              <div className="pl-6 space-y-1">
                <input
                  className="w-full bg-bg-soft border border-border px-2 py-1 text-xs rounded"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="subagent name"
                />
                <textarea
                  className="w-full bg-bg-soft border border-border px-2 py-1 text-xs rounded"
                  value={draftDescription}
                  onChange={(e) => setDraftDescription(e.target.value)}
                  placeholder="Description (what this agent is good for)"
                  rows={2}
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => saveEdit(key)}
                    disabled={isBusy || !draftName.trim()}
                    className="px-2 py-1 text-xs bg-bg-soft border border-border rounded text-text-muted hover:text-text disabled:opacity-40"
                  >
                    {isBusy ? "..." : "Save"}
                  </button>
                  <button
                    onClick={() => setEditingKey(null)}
                    className="px-2 py-1 text-xs text-text-faint hover:text-text"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div className="border border-dashed border-border rounded p-2 space-y-1">
        <button
          onClick={() => setAddOpen((v) => !v)}
          className="text-[10px] uppercase tracking-wider text-text-faint hover:text-text-muted"
        >
          {addOpen ? "▾" : "▸"} Add custom subagent
        </button>
        {addOpen && (
          <>
            <div className="text-[10px] text-text-faint">
              Give a model a second, bespoke name (e.g. two named agents on the
              same model with different descriptions).
            </div>
            <input
              className="w-full bg-bg-soft border border-border px-2 py-1 text-xs rounded"
              placeholder="name (e.g. fast, deep)"
              value={addDraft.name}
              onChange={(e) => setAddDraft((d) => ({ ...d, name: e.target.value }))}
            />
            <select
              className="w-full bg-bg-soft border border-border px-2 py-1 text-xs rounded"
              value={addDraft.model}
              onChange={(e) => handleAddModelSelect(e.target.value)}
            >
              <option value="">Select model...</option>
              {models?.map((m) => (
                <option key={`${m.providerID}/${m.id}`} value={`${m.providerID}/${m.id}`}>
                  {m.name} ({m.providerID})
                </option>
              ))}
            </select>
            <textarea
              className="w-full bg-bg-soft border border-border px-2 py-1 text-xs rounded"
              placeholder="Description (what this agent is good for)"
              value={addDraft.description}
              onChange={(e) => setAddDraft((d) => ({ ...d, description: e.target.value }))}
              rows={2}
            />
            <button
              onClick={addSubagent}
              disabled={!addDraft.name.trim() || !addDraft.model.trim() || busy !== null}
              className="px-3 py-1 text-xs bg-bg-soft border border-border rounded text-text-muted hover:text-text disabled:opacity-40"
            >
              Add
            </button>
          </>
        )}
      </div>

      <div className="border border-border rounded p-2 space-y-2">
        {!restartConfirmOpen ? (
          <button
            onClick={() => { setRestartConfirmOpen(true); setRestartResult(null); }}
            className="px-3 py-1.5 text-xs bg-bg-soft border border-border rounded text-text-muted hover:text-text w-full"
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
                onClick={doRestart}
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
          restart opencode-serve) — separate from bui-server itself.
        </div>
      </div>
    </div>
  );
}
