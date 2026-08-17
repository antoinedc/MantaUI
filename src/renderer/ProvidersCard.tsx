import { useState, useCallback } from "react";
import { X } from "lucide-react";
import type { ProviderEndpoint, DiscoverResult } from "../shared/types";
import { CustomProviderForm } from "./CustomProviderForm";
import { Checkbox } from "./Checkbox";
import { useCachedResource } from "./useCachedResource";
import { MantaLoader } from "./MantaLoader";

type Props = {
  /**
   * BET-420: raised when an endpoint mutation needs an opencode restart. The
   * card never renders its own restart UI — the Settings panel owns the ONE
   * shared restart banner (BET-420), and this callback drives it.
   *
   * BET-421 §D: the add-endpoint form (CustomProviderForm) handles its OWN
   * save + restart internally (probe → save → restart), so it does NOT route
   * through this callback — only the per-endpoint toggle/remove mutations do.
   */
  onRestartNeeded: () => void;
};

export function ProvidersCard({ onRestartNeeded }: Props) {
  // The endpoint list goes through the shared cache (BET-1057): a cold open
  // shows the loader, a warm reopen renders instantly while it revalidates.
  const {
    data: endpoints,
    loading,
    error,
    refresh,
    mutate,
  } = useCachedResource<ProviderEndpoint[]>("providers", () =>
    window.api.opencodeGetProviders(),
  );
  const [discovered, setDiscovered] = useState<Record<string, { id: string }[]>>({});
  const [discoverError, setDiscoverError] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null); // endpoint id being mutated

  const discover = useCallback(async (ep: ProviderEndpoint) => {
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
    await mutate(async () => {
      const res = await window.api.opencodeSetProviders({
        upsert: [{ id: ep.id, name: ep.name, baseURL: ep.baseURL, enabledModels: enabled }],
      });
      if (!res.ok) throw new Error(res.error ?? "Save failed");
      onRestartNeeded();
      refresh();
    });
    setBusy(null);
  }, [busy, mutate, refresh, onRestartNeeded]);

  const removeEndpoint = useCallback(async (ep: ProviderEndpoint) => {
    if (busy) return;
    setBusy(ep.id);
    await mutate(async () => {
      const res = await window.api.opencodeSetProviders({ remove: [ep.id] });
      if (!res.ok) throw new Error(res.error ?? "Remove failed");
      setDiscovered((d) => { const { [ep.id]: _drop, ...rest } = d; return rest; });
      setDiscoverError((er) => { const { [ep.id]: _drop, ...rest } = er; return rest; });
      onRestartNeeded();
      refresh();
    });
    setBusy(null);
  }, [busy, mutate, refresh, onRestartNeeded]);

  return (
    <div className="space-y-2">
      {error && <div className="text-meta text-danger">{error}</div>}

      {loading ? (
        <div className="py-2">
          <MantaLoader size="inline" label="Loading endpoints" />
        </div>
      ) : (
        (endpoints ?? []).map((ep) => (
        <div key={ep.id} className="border border-border rounded-xs p-2 space-y-1">
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-body text-text truncate">{ep.name}</div>
              <code className="text-meta text-text-faint truncate block">{ep.baseURL}</code>
            </div>
            <button
              onClick={() => discover(ep)}
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
            <div key={m.id} className="flex items-center gap-2 text-meta">
              <Checkbox
                checked={ep.enabledModels.includes(m.id)}
                onChange={() => toggleModel(ep, m.id)}
                disabled={busy === ep.id}
                ariaLabel={m.id}
              />
              <span className="text-text-muted">{m.id}</span>
            </div>
          ))}
        </div>
      ))
      )}

      {/* BET-421 §D: shared CustomProviderForm — probes the endpoint before
          saving, derives the provider id from the name, and handles its own
          save + restart. Replaces the old bespoke add-endpoint block and the
          BET-420 AddEndpointForm (which had no probe and asked for the id). */}
      <CustomProviderForm
        compact
        onSaved={refresh}
      />
    </div>
  );
}
