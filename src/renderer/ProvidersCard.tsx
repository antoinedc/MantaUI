import { useEffect, useState, useCallback } from "react";
import type { ProviderEndpoint, DiscoverResult } from "../shared/types";

type Draft = { id: string; name: string; baseURL: string; apiKey: string };
const EMPTY_DRAFT: Draft = { id: "", name: "", baseURL: "", apiKey: "" };

export function ProvidersCard() {
  const [endpoints, setEndpoints] = useState<ProviderEndpoint[] | null>(null);
  const [discovered, setDiscovered] = useState<Record<string, { id: string }[]>>({});
  const [discoverError, setDiscoverError] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null); // endpoint id being mutated
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const load = useCallback(() => {
    window.api.opencodeGetProviders().then(setEndpoints).catch(() => setEndpoints([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const refresh = useCallback(async (ep: ProviderEndpoint) => {
    if (busy) return;
    setBusy(ep.id);
    setDiscoverError((e) => ({ ...e, [ep.id]: "" }));
    // apiKey "" => main re-reads the stored key for this endpoint (Refresh never
    // re-sends the secret).
    try {
      const r: DiscoverResult = await window.api.opencodeDiscoverModels(ep.baseURL, "");
      if (r.ok) {
        setDiscovered((d) => ({ ...d, [ep.id]: r.models }));
      } else {
        setDiscoverError((e) => ({ ...e, [ep.id]: `${r.error}${r.detail ? `: ${r.detail}` : ""}` }));
      }
    } catch (e) {
      setDiscoverError((er) => ({ ...er, [ep.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  }, [busy]);

  const toggleModel = useCallback(async (ep: ProviderEndpoint, modelId: string) => {
    if (busy) return;
    const enabled = ep.enabledModels.includes(modelId)
      ? ep.enabledModels.filter((m) => m !== modelId)
      : [...ep.enabledModels, modelId];
    setBusy(ep.id);
    setGlobalError(null);
    try {
      const res = await window.api.opencodeSetProviders({
        upsert: [{ id: ep.id, name: ep.name, baseURL: ep.baseURL, enabledModels: enabled }],
      });
      if (!res.ok) { setGlobalError(res.error ?? "Save failed"); return; }
      setRestartNeeded(true);
      load();
    } catch (e) {
      setGlobalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [busy, load]);

  const addEndpoint = useCallback(async () => {
    if (busy) return;
    const d = draft;
    if (!d.id.trim() || !d.baseURL.trim()) return;
    setBusy(d.id);
    setGlobalError(null);
    try {
      const res = await window.api.opencodeSetProviders({
        upsert: [{
          id: d.id.trim(), name: d.name.trim() || d.id.trim(),
          baseURL: d.baseURL.trim(), apiKey: d.apiKey, enabledModels: [],
        }],
      });
      if (!res.ok) { setGlobalError(res.error ?? "Add failed"); return; }
      setDraft(EMPTY_DRAFT);
      setRestartNeeded(true);
      load();
    } catch (e) {
      setGlobalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [busy, draft, load]);

  const removeEndpoint = useCallback(async (ep: ProviderEndpoint) => {
    if (busy) return;
    setBusy(ep.id);
    setGlobalError(null);
    try {
      const res = await window.api.opencodeSetProviders({ remove: [ep.id] });
      if (!res.ok) { setGlobalError(res.error ?? "Remove failed"); return; }
      setDiscovered((d) => { const { [ep.id]: _drop, ...rest } = d; return rest; });
      setDiscoverError((er) => { const { [ep.id]: _drop, ...rest } = er; return rest; });
      setRestartNeeded(true);
      load();
    } catch (e) {
      setGlobalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [busy, load]);

  const applyRestart = useCallback(async () => {
    await window.api.opencodeRestart();
    setRestartNeeded(false);
  }, []);

  return (
    <div className="space-y-2 pt-2 border-t border-border">
      <label className="block text-xs uppercase tracking-wider text-text-muted">
        Providers
      </label>
      <div className="text-xs text-text-faint">
        OpenAI-compatible endpoints opencode can serve. Refresh to discover models,
        then enable the ones you want in the model picker.
      </div>

      {globalError && <div className="text-xs text-red-400">{globalError}</div>}

      {(endpoints ?? []).map((ep) => (
        <div key={ep.id} className="border border-border rounded p-2 space-y-1">
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-text truncate">{ep.name}</div>
              <code className="text-[10px] text-text-faint truncate block">{ep.baseURL}</code>
            </div>
            <button
              onClick={() => refresh(ep)}
              disabled={busy === ep.id}
              className="px-2 py-1 text-xs bg-bg-soft border border-border rounded text-text-muted hover:text-text disabled:opacity-40"
            >
              {busy === ep.id ? "…" : "Refresh"}
            </button>
            <button
              onClick={() => removeEndpoint(ep)}
              disabled={busy === ep.id}
              className="text-xs text-text-faint hover:text-text px-1"
              title="Remove endpoint"
            >
              ✕
            </button>
          </div>
          {discoverError[ep.id] && (
            <div className="text-[10px] text-red-400">{discoverError[ep.id]}</div>
          )}
          {(discovered[ep.id] ?? ep.enabledModels.map((id) => ({ id }))).map((m) => (
            <label key={m.id} className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={ep.enabledModels.includes(m.id)}
                onChange={() => toggleModel(ep, m.id)}
                disabled={busy === ep.id}
              />
              <span className="text-text-muted">{m.id}</span>
            </label>
          ))}
        </div>
      ))}

      <div className="border border-dashed border-border rounded p-2 space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-text-faint">Add endpoint</div>
        <input className="w-full bg-bg-soft border border-border px-2 py-1 text-xs rounded"
          placeholder="id (e.g. voska)" value={draft.id}
          onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))} />
        <input className="w-full bg-bg-soft border border-border px-2 py-1 text-xs rounded"
          placeholder="name (e.g. VoskaAI)" value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
        <input className="w-full bg-bg-soft border border-border px-2 py-1 text-xs rounded"
          placeholder="baseURL (https://api.voska.org/v1)" value={draft.baseURL}
          onChange={(e) => setDraft((d) => ({ ...d, baseURL: e.target.value }))} />
        <input type="password" className="w-full bg-bg-soft border border-border px-2 py-1 text-xs rounded"
          placeholder="API key" value={draft.apiKey}
          onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))} />
        <button
          onClick={addEndpoint}
          disabled={!draft.id.trim() || !draft.baseURL.trim() || busy !== null}
          className="px-3 py-1 text-xs bg-bg-soft border border-border rounded text-text-muted hover:text-text disabled:opacity-40"
        >
          Add
        </button>
      </div>

      {restartNeeded && (
        <div className="flex items-center gap-2 text-xs bg-bg-soft border border-border rounded p-2">
          <span className="flex-1 text-text-muted">
            Restart opencode now to apply? (interrupts active sessions)
          </span>
          <button onClick={applyRestart}
            className="px-2 py-1 bg-accent/20 border border-accent rounded text-text">
            Apply Now
          </button>
          <button onClick={() => setRestartNeeded(false)}
            className="px-2 py-1 border border-border rounded text-text-muted">
            Apply Later
          </button>
        </div>
      )}
    </div>
  );
}
