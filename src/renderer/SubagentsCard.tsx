import { useEffect, useState, useCallback } from "react";
import { describeModel } from "../shared/modelGuide.mjs";
import type { SubagentDef, OpencodeModel } from "../shared/types";

type Draft = { name: string; model: string; description: string };
const EMPTY_DRAFT: Draft = { name: "", model: "", description: "" };

export function SubagentsCard() {
  const [subagents, setSubagents] = useState<SubagentDef[] | null>(null);
  const [models, setModels] = useState<OpencodeModel[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // subagent name being mutated
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const load = useCallback(() => {
    window.api
      .opencodeGetSubagents()
      .then((agents) => { setSubagents(agents); setGlobalError(null); })
      .catch((e) => {
        setSubagents([]);
        setGlobalError(e instanceof Error ? e.message : String(e));
      });
  }, []);
  useEffect(() => { load(); }, [load]);

  // Fetch models once for the model select dropdown
  useEffect(() => {
    window.api
      .opencodeModels()
      .then((list) => setModels(list))
      .catch(() => {});
  }, []);

  const addSubagent = useCallback(async () => {
    if (busy) return;
    const d = draft;
    if (!d.name.trim() || !d.model.trim()) return;
    setBusy(d.name);
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
      setDraft(EMPTY_DRAFT);
      load();
    } catch (e) {
      setGlobalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [busy, draft, load]);

  const saveEdit = useCallback(async (agent: SubagentDef) => {
    if (busy || !editingName) return;
    setBusy(agent.name);
    setGlobalError(null);
    try {
      const res = await window.api.opencodeSetSubagents({
        upsert: [{
          name: agent.name,
          model: agent.model,
          description: agent.description,
        }],
      });
      if (!res.ok) { setGlobalError(res.error ?? "Save failed"); return; }
      setEditingName(null);
      load();
    } catch (e) {
      setGlobalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [busy, editingName, load]);

  const removeSubagent = useCallback(async (name: string) => {
    if (busy) return;
    setBusy(name);
    setGlobalError(null);
    try {
      const res = await window.api.opencodeSetSubagents({ remove: [name] });
      if (!res.ok) { setGlobalError(res.error ?? "Remove failed"); return; }
      load();
    } catch (e) {
      setGlobalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [busy, load]);

  // When a model is selected, prefill description with catalog info
  const handleModelSelect = useCallback((modelStr: string, isDraft: boolean) => {
    if (!modelStr) return;
    const [providerID, modelID] = modelStr.split("/");
    const info = describeModel(providerID, modelID);
    const prefillDesc = info
      ? `${info.blurb} Good for: ${info.goodFor.join(", ")}`
      : "";
    
    if (isDraft) {
      setDraft((d) => ({ ...d, model: modelStr, description: prefillDesc }));
    } else if (editingName) {
      setSubagents((agents) =>
        agents?.map((a) =>
          a.name === editingName ? { ...a, model: modelStr, description: prefillDesc } : a
        ) ?? null
      );
    }
  }, [editingName]);

  return (
    <div className="space-y-2 pt-2 border-t border-border">
      <label className="block text-xs uppercase tracking-wider text-text-muted">
        Subagents
      </label>
      <div className="text-xs text-text-faint">
        Named subagents run on specific models. Configure them here, then the AI can dispatch via{" "}
        <code className="text-text-muted">task(subagent_type: "name")</code>.
      </div>

      {globalError && <div className="text-xs text-red-400">{globalError}</div>}

      {(subagents ?? []).map((agent) => (
        <div key={agent.name} className="border border-border rounded p-2 space-y-1">
          {editingName === agent.name ? (
            <>
              <input
                className="w-full bg-bg-soft border border-border px-2 py-1 text-xs rounded"
                value={agent.name}
                disabled
                placeholder="name"
              />
              <select
                className="w-full bg-bg-soft border border-border px-2 py-1 text-xs rounded"
                value={agent.model}
                onChange={(e) => handleModelSelect(e.target.value, false)}
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
                value={agent.description}
                onChange={(e) =>
                  setSubagents((agents) =>
                    agents?.map((a) =>
                      a.name === editingName ? { ...a, description: e.target.value } : a
                    ) ?? null
                  )
                }
                placeholder="Description (what this agent is good for)"
                rows={2}
              />
              <div className="flex gap-2">
                <button
                  onClick={() => saveEdit(agent)}
                  disabled={busy === agent.name}
                  className="px-2 py-1 text-xs bg-bg-soft border border-border rounded text-text-muted hover:text-text disabled:opacity-40"
                >
                  {busy === agent.name ? "..." : "Save"}
                </button>
                <button
                  onClick={() => setEditingName(null)}
                  className="px-2 py-1 text-xs text-text-faint hover:text-text"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-text font-medium">{agent.name}</div>
                  <code className="text-[10px] text-text-faint truncate block">{agent.model}</code>
                  <div className="text-xs text-text-muted">{agent.description}</div>
                </div>
                <button
                  onClick={() => setEditingName(agent.name)}
                  disabled={busy === agent.name}
                  className="px-2 py-1 text-xs bg-bg-soft border border-border rounded text-text-muted hover:text-text disabled:opacity-40"
                >
                  Edit
                </button>
                <button
                  onClick={() => removeSubagent(agent.name)}
                  disabled={busy === agent.name}
                  className="text-xs text-text-faint hover:text-text px-1"
                  title="Remove subagent"
                >
                  ✕
                </button>
              </div>
            </>
          )}
        </div>
      ))}

      <div className="border border-dashed border-border rounded p-2 space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-text-faint">Add subagent</div>
        <input
          className="w-full bg-bg-soft border border-border px-2 py-1 text-xs rounded"
          placeholder="name (e.g. fast, deep)"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        />
        <select
          className="w-full bg-bg-soft border border-border px-2 py-1 text-xs rounded"
          value={draft.model}
          onChange={(e) => handleModelSelect(e.target.value, true)}
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
          value={draft.description}
          onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          rows={2}
        />
        <button
          onClick={addSubagent}
          disabled={!draft.name.trim() || !draft.model.trim() || busy !== null}
          className="px-3 py-1 text-xs bg-bg-soft border border-border rounded text-text-muted hover:text-text disabled:opacity-40"
        >
          Add
        </button>
      </div>

      <div className="text-xs text-text-faint bg-bg-soft border border-border rounded p-2">
        Restart opencode to apply: <code className="text-text-muted">systemctl --user restart opencode-serve</code>
      </div>
    </div>
  );
}
