import { useEffect, useState, useCallback } from "react";
import { X } from "lucide-react";
import type { ProviderEndpoint, DiscoverResult } from "../shared/types";
import { CustomProviderForm } from "./CustomProviderForm";

type Props = {
  /**
   * BET-420: raised when an endpoint mutation needs an opencode restart. When
   * provided (desktop Settings), the card does NOT render its own restart
   * banner — the Settings panel shows ONE shared restart banner instead. When
   * omitted (mobile), the card keeps its inline "Apply Now / Apply Later"
   * banner so mobile still has a restart affordance.
   *
   * BET-421 §D: the add-endpoint form (CustomProviderForm) handles its OWN
   * save + restart internally (probe → save → restart), so it does NOT route
   * through this callback — only the per-endpoint toggle/remove mutations do.
   */
  onRestartNeeded?: () => void;
};

export function ProvidersCard({ onRestartNeeded }: Props = {}) {
  const [endpoints, setEndpoints] = useState<ProviderEndpoint[] | null>(null);
  const [discovered, setDiscovered] = useState<Record<string, { id: string }[]>>({});
  const [discoverError, setDiscoverError] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null); // endpoint id being mutated
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const load = useCallback(() => {
    window.api
      .opencodeGetProviders()
      .then((eps) => { setEndpoints(eps); setGlobalError(null); })
      .catch((e) => {
        // Don't collapse a failure into a deceptively-empty list: surface it.
        // main translates the two cases into clear messages (unparseable config
        // vs box unreachable); show whichever we got.
        setEndpoints([]);
        setGlobalError(e instanceof Error ? e.message : String(e));
      });
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

  const flagRestart = () => {
    if (onRestartNeeded) onRestartNeeded();
    else setRestartNeeded(true);
  };

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
      flagRestart();
      load();
    } catch (e) {
      setGlobalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [busy, load, onRestartNeeded]);

  const removeEndpoint = useCallback(async (ep: ProviderEndpoint) => {
    if (busy) return;
    setBusy(ep.id);
    setGlobalError(null);
    try {
      const res = await window.api.opencodeSetProviders({ remove: [ep.id] });
      if (!res.ok) { setGlobalError(res.error ?? "Remove failed"); return; }
      setDiscovered((d) => { const { [ep.id]: _drop, ...rest } = d; return rest; });
      setDiscoverError((er) => { const { [ep.id]: _drop, ...rest } = er; return rest; });
      flagRestart();
      load();
    } catch (e) {
      setGlobalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [busy, load, onRestartNeeded]);

  const [restarting, setRestarting] = useState(false);
  const applyRestart = useCallback(async () => {
    if (restarting) return;
    setRestarting(true);
    setGlobalError(null);
    try {
      await window.api.opencodeRestart();
      setRestartNeeded(false);
    } catch (e) {
      // A restart that killed the session but failed to bring opencode back is
      // the worst-perceived outcome — never let it fail silently.
      setGlobalError(`Restart failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRestarting(false);
    }
  }, [restarting]);

  return (
    <div className="space-y-2">
      <div className="text-meta text-text-faint">
        OpenAI-compatible endpoints opencode can serve. Refresh to discover models,
        then enable the ones you want in the model picker.
      </div>

      {globalError && <div className="text-meta text-danger">{globalError}</div>}

      {(endpoints ?? []).map((ep) => (
        <div key={ep.id} className="border border-border rounded-xs p-2 space-y-1">
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-body text-text truncate">{ep.name}</div>
              <code className="text-meta text-text-faint truncate block">{ep.baseURL}</code>
            </div>
            <button
              onClick={() => refresh(ep)}
              disabled={busy === ep.id}
              className="px-2 py-1 text-meta bg-bg-soft border border-border rounded-xs text-text-muted hover:text-text disabled:opacity-40"
            >
              {busy === ep.id ? "…" : "Refresh"}
            </button>
            <button
              onClick={() => removeEndpoint(ep)}
              disabled={busy === ep.id}
              className="text-meta text-text-faint hover:text-text px-1 inline-flex items-center"
              title="Remove endpoint"
              aria-label="Remove endpoint"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          {discoverError[ep.id] && (
            <div className="text-meta text-danger">{discoverError[ep.id]}</div>
          )}
          {(discovered[ep.id] ?? ep.enabledModels.map((id) => ({ id }))).map((m) => (
            <label key={m.id} className="flex items-center gap-2 text-meta cursor-pointer">
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

      {/* BET-421 §D: shared CustomProviderForm — probes the endpoint before
          saving, derives the provider id from the name, and handles its own
          save + restart. Replaces the old bespoke add-endpoint block and the
          BET-420 AddEndpointForm (which had no probe and asked for the id). */}
      <CustomProviderForm
        compact
        onSaved={load}
      />

      {/* Mobile-only restart banner (desktop routes through the panel banner
          via onRestartNeeded, so this never renders on desktop). */}
      {!onRestartNeeded && restartNeeded && (
        <div className="flex items-center gap-2 text-meta bg-bg-soft border border-border rounded-xs p-2">
          <span className="flex-1 text-text-muted">
            Restart opencode now to apply? (interrupts active sessions)
          </span>
          <button onClick={applyRestart} disabled={restarting}
            className="px-2 py-1 bg-accent/20 border border-accent rounded-xs text-text disabled:opacity-40">
            {restarting ? "Restarting…" : "Apply Now"}
          </button>
          <button onClick={() => setRestartNeeded(false)} disabled={restarting}
            className="px-2 py-1 border border-border rounded-xs text-text-muted disabled:opacity-40">
            Apply Later
          </button>
        </div>
      )}
    </div>
  );
}
