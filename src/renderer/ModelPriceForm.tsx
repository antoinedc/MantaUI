// ===== Unpriced models + the per-model price form (sticky-trims spec §3.4) =====
//
// The optimizer only trims a model it can price: trimming a conversation
// re-writes its cached prefix, which is a loss on some providers and a win on
// others, and "which" depends on that model's cache read/write rates. A model
// with no known price is therefore left alone (the trim gate refuses to grow).
//
// This panel is the user's way out. It lists, grouped by provider, every
// connected model the box reports as unpriced (`optimizer:prices` → `unpriced`)
// and lets the user declare prices through the narrow `opencode:set-model-cost`
// writer (opencode's own `provider.<id>.models.<id>.cost`). Prices are $ per
// million tokens; input and output are required (opencode's config schema
// requires both) and so is cache read (the optimizer treats a model without a
// cache-read price as unpriced); cache write is optional (empty = no write
// premium).
//
// AGENTS.md "NEVER STUB A CONTROL TO DO NOTHING": Save awaits the write and
// reports BOTH outcomes — "Saved — the optimizer will use these prices" or the
// error (a validation message, or the box's own). A confirmation outlives the
// row it was raised from (the model leaves the unpriced list on success), so
// notices live at panel level. If the box can't answer `optimizer:prices`
// (supported:false / an older server) the panel renders nothing — a hidden
// control is honest, a dead one is not.

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { ModelsSetPriceReply } from "../shared/types";
import { Button } from "./Button";
import { Field } from "./Field";

// Validation, grouping and the writes are the BOX's (WS09 SF-M13,
// src/server/modelsPricing.mjs): the form sends the four strings AS TYPED to
// `models:set-price` and renders the reply's message / field / warning. The
// optimizer's unpriced list arrives already grouped (`unpricedByProvider`).

export type PriceDraft = { input: string; output: string; cacheRead: string; cacheWrite: string };

export const EMPTY_PRICE_DRAFT: PriceDraft = { input: "", output: "", cacheRead: "", cacheWrite: "" };

type FieldKey = keyof PriceDraft;
type SaveOk = Extract<ModelsSetPriceReply, { ok: true }>;

// ===== One model's form =====

function ModelPriceRow({
  providerID,
  modelID,
  onSaved,
}: {
  providerID: string;
  modelID: string;
  onSaved: (providerID: string, modelID: string, reply: SaveOk) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PriceDraft>(EMPTY_PRICE_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);
  const idBase = `price-${providerID}-${modelID}`.replace(/[^A-Za-z0-9_-]/g, "_");

  const set = (k: FieldKey) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setDraft((d) => ({ ...d, [k]: e.target.value }));
    setError(null);
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.api.modelsSetPrice({ providerID, modelID, draft });
      if (!res.ok) {
        setError({ field: res.field, message: res.message });
        return;
      }
      // The row may unmount once the refreshed list no longer contains the model;
      // the panel owns the confirmation for exactly that reason.
      onSaved(providerID, modelID, res);
    } catch (e) {
      setError({ message: `Couldn't save — ${e instanceof Error ? e.message : String(e)}. Nothing was changed; try again.` });
    } finally {
      setBusy(false);
    }
  };

  const fieldFooter = (f: FieldKey) =>
    error?.field === f ? (
      <span role="alert" className="block text-meta text-danger">
        {error.message}
      </span>
    ) : undefined;

  return (
    <li className="space-y-2">
      <div className="flex items-center gap-2">
        <code className="text-meta text-text truncate flex-1" title={modelID}>
          {modelID}
        </code>
        <Button tone="default" type="button" ariaPressed={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Cancel" : "Set prices"}
        </Button>
      </div>
      {open && (
        <div className="rounded-md border border-dashed border-border p-3 space-y-2">
          <div className="text-meta text-text-faint">Dollars per million tokens. Input, output and cache read are required. Leave cache write empty if the provider charges nothing extra to cache.</div>
          <div className="grid grid-cols-2 gap-2">
            <Field id={`${idBase}-input`} label="Input" mono={false} value={draft.input} placeholder="e.g. 3" disabled={busy} onChange={set("input")} footer={fieldFooter("input")} />
            <Field id={`${idBase}-output`} label="Output" mono={false} value={draft.output} placeholder="e.g. 15" disabled={busy} onChange={set("output")} footer={fieldFooter("output")} />
            <Field id={`${idBase}-cache-read`} label="Cache read" mono={false} value={draft.cacheRead} placeholder="e.g. 0.3" disabled={busy} onChange={set("cacheRead")} footer={fieldFooter("cacheRead")} />
            <Field id={`${idBase}-cache-write`} label="Cache write (optional)" mono={false} value={draft.cacheWrite} placeholder="e.g. 3.75" disabled={busy} onChange={set("cacheWrite")} footer={fieldFooter("cacheWrite")} />
          </div>
          {error && !error.field && (
            <div role="alert" className="text-meta text-danger break-words">
              {error.message}
            </div>
          )}
          <Button tone="primary" type="button" onClick={() => void save()} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
            {busy ? "Saving…" : "Save prices"}
          </Button>
        </div>
      )}
    </li>
  );
}

// ===== The panel =====

type UnpricedGroup = { providerID: string; models: string[] };
type Load = { state: "loading" } | { state: "hidden" } | { state: "ready"; groups: UnpricedGroup[] };

export function UnpricedModelsPanel({ names = {} }: { names?: Record<string, string> }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [notices, setNotices] = useState<{ key: string; modelID: string; message: string; warning?: string }[]>([]);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    // Resolve through a promise so an absent method (pre-pairing preload) rejects instead of throwing.
    Promise.resolve()
      .then(() => window.api.optimizerPrices())
      .then((r) => {
        if (!alive.current) return;
        // An older box has no `unpricedByProvider`: the section is hidden (a hidden control is honest).
        const groups = r && "unpricedByProvider" in r ? r.unpricedByProvider : undefined;
        setLoad(Array.isArray(groups) ? { state: "ready", groups } : { state: "hidden" });
      })
      .catch(() => {
        // Initial read only (no user action behind it): an unreadable price map
        // hides the panel rather than painting a failure over Accounts.
        if (alive.current) setLoad({ state: "hidden" });
      });
    return () => {
      alive.current = false;
    };
  }, []);

  const onSaved = useCallback((providerID: string, modelID: string, reply: SaveOk) => {
    if (!alive.current) return;
    setLoad({ state: "ready", groups: reply.unpricedByProvider });
    const key = `${providerID}/${modelID}`;
    setNotices((n) => [...n.filter((x) => x.key !== key), { key, modelID, message: reply.message, warning: reply.warning }]);
  }, []);

  if (load.state !== "ready") return null;
  const groups = load.groups;
  if (groups.length === 0 && notices.length === 0) return null;

  const toggle = (id: string) =>
    setOpenGroups((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-2 pt-3 border-t border-border-subtle" data-testid="unpriced-models">
      {groups.map((g) => {
        const open = openGroups.has(g.providerID);
        const label = names[g.providerID] ?? g.providerID;
        return (
          <div key={g.providerID} className="space-y-2">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => toggle(g.providerID)}
              className="w-full text-left text-meta flex items-baseline gap-2"
            >
              <span aria-hidden className="text-text-faint">{open ? "▾" : "▸"}</span>
              <b className="text-text">{label}</b>
              <span className="text-warn">No prices — the optimizer won't trim these models</span>
              <span className="text-text-faint">
                ({g.models.length} model{g.models.length === 1 ? "" : "s"})
              </span>
            </button>
            {open && (
              <ul className="pl-4 space-y-2">
                {g.models.map((m) => (
                  <ModelPriceRow key={m} providerID={g.providerID} modelID={m} onSaved={onSaved} />
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {notices.map((n) => (
        <div key={n.key} role="status" className="text-meta text-ok break-words">
          <code>{n.modelID}</code> · {n.message}
          {n.warning && <div className="text-text-faint">{n.warning}</div>}
        </div>
      ))}
    </div>
  );
}
