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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { ModelCostArgs } from "../shared/api";
import { Button } from "./Button";
import { Field } from "./Field";

// ===== Pure logic (unit-tested) =====

export type PriceDraft = { input: string; output: string; cacheRead: string; cacheWrite: string };

export const EMPTY_PRICE_DRAFT: PriceDraft = { input: "", output: "", cacheRead: "", cacheWrite: "" };

export type ParsedCost =
  | { ok: true; cost: ModelCostArgs["cost"] }
  | { ok: false; error: string };

// A non-negative decimal, nothing else ("1e3", "0x10", "-1", "1,5" are refused:
// a price typed in a hurry should be a price, not whatever Number() tolerates).
const DECIMAL = /^(\d+\.?\d*|\.\d+)$/;

function parseField(raw: string, label: string, required: boolean): { value?: number; error?: string } {
  const s = raw.trim();
  if (s === "") return required ? { error: `${label} is required.` } : {};
  if (!DECIMAL.test(s)) return { error: `${label} must be a number of dollars per million tokens (0 or more).` };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return { error: `${label} must be a number of dollars per million tokens (0 or more).` };
  return { value: n };
}

/** Validate the draft into the writer's `cost` body. input, output + cache read required. */
export function parseCostDraft(d: PriceDraft): ParsedCost {
  const input = parseField(d.input, "Input price", true);
  if (input.error) return { ok: false, error: input.error };
  const output = parseField(d.output, "Output price", true);
  if (output.error) return { ok: false, error: output.error };
  const cacheRead = parseField(d.cacheRead, "Cache read price", true);
  if (cacheRead.error) return { ok: false, error: cacheRead.error };
  const cacheWrite = parseField(d.cacheWrite, "Cache write price", false);
  if (cacheWrite.error) return { ok: false, error: cacheWrite.error };
  const cost: ModelCostArgs["cost"] = { input: input.value as number, output: output.value as number };
  cost.cache_read = cacheRead.value as number;
  if (cacheWrite.value !== undefined) cost.cache_write = cacheWrite.value;
  return { ok: true, cost };
}

export type UnpricedGroup = { providerID: string; models: string[] };

/**
 * Group the "<providerID>/<modelID>" keys by provider. The split is at the FIRST
 * slash: model ids may themselves contain slashes (openrouter's
 * "deepseek/deepseek-v4-flash"). A key with no provider or no model part is
 * dropped — it can't be addressed by the writer.
 */
export function groupUnpriced(keys: readonly string[]): UnpricedGroup[] {
  const byProvider = new Map<string, string[]>();
  for (const key of keys) {
    const i = key.indexOf("/");
    if (i <= 0 || i === key.length - 1) continue;
    const providerID = key.slice(0, i);
    const modelID = key.slice(i + 1);
    const list = byProvider.get(providerID) ?? [];
    list.push(modelID);
    byProvider.set(providerID, list);
  }
  return [...byProvider.entries()]
    .map(([providerID, models]) => ({ providerID, models: [...models].sort() }))
    .sort((a, b) => a.providerID.localeCompare(b.providerID));
}

const SAVED_MESSAGE = "Saved — the optimizer will use these prices";

// ===== One model's form =====

function ModelPriceRow({
  providerID,
  modelID,
  onSaved,
}: {
  providerID: string;
  modelID: string;
  onSaved: (providerID: string, modelID: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PriceDraft>(EMPTY_PRICE_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idBase = `price-${providerID}-${modelID}`.replace(/[^A-Za-z0-9_-]/g, "_");

  const set = (k: keyof PriceDraft) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setDraft((d) => ({ ...d, [k]: e.target.value }));
    setError(null);
  };

  const save = async () => {
    if (busy) return;
    const parsed = parseCostDraft(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError(null);
    let res: Awaited<ReturnType<typeof window.api.opencodeSetModelCost>>;
    try {
      res = await window.api.opencodeSetModelCost({ providerID, modelID, cost: parsed.cost });
    } catch (e) {
      setError(`Couldn't save — ${e instanceof Error ? e.message : String(e)}. Nothing was changed; try again.`);
      setBusy(false);
      return;
    }
    if (!res || res.ok !== true) {
      const why = res && "error" in res && res.error ? res.error : "the box rejected the price";
      setError(`Couldn't save — ${why}. Nothing was changed; try again.`);
      setBusy(false);
      return;
    }
    setBusy(false);
    // The row may unmount once the refreshed list no longer contains the model;
    // the panel owns the confirmation for exactly that reason.
    await onSaved(providerID, modelID);
  };

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
            <Field id={`${idBase}-input`} label="Input" mono={false} value={draft.input} placeholder="e.g. 3" disabled={busy} onChange={set("input")} />
            <Field id={`${idBase}-output`} label="Output" mono={false} value={draft.output} placeholder="e.g. 15" disabled={busy} onChange={set("output")} />
            <Field id={`${idBase}-cache-read`} label="Cache read" mono={false} value={draft.cacheRead} placeholder="e.g. 0.3" disabled={busy} onChange={set("cacheRead")} />
            <Field id={`${idBase}-cache-write`} label="Cache write (optional)" mono={false} value={draft.cacheWrite} placeholder="e.g. 3.75" disabled={busy} onChange={set("cacheWrite")} />
          </div>
          {error && (
            <div role="alert" className="text-meta text-danger break-words">
              {error}
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

type Load = { state: "loading" } | { state: "hidden" } | { state: "ready"; unpriced: string[] };

export function UnpricedModelsPanel({ names = {} }: { names?: Record<string, string> }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [notices, setNotices] = useState<{ key: string; modelID: string; refreshFailed: boolean }[]>([]);
  const alive = useRef(true);

  const fetchPrices = useCallback(async (): Promise<string[] | null> => {
    const r = await window.api.optimizerPrices();
    if (!r || !("unpriced" in r) || !Array.isArray(r.unpriced)) return null;
    return r.unpriced;
  }, []);

  useEffect(() => {
    alive.current = true;
    fetchPrices()
      .then((unpriced) => {
        if (!alive.current) return;
        setLoad(unpriced ? { state: "ready", unpriced } : { state: "hidden" });
      })
      .catch(() => {
        // Initial read only (no user action behind it): an unreadable price map
        // hides the panel rather than painting a failure over Accounts.
        if (alive.current) setLoad({ state: "hidden" });
      });
    return () => {
      alive.current = false;
    };
  }, [fetchPrices]);

  const onSaved = useCallback(
    async (providerID: string, modelID: string) => {
      const key = `${providerID}/${modelID}`;
      let refreshFailed = false;
      try {
        const unpriced = await fetchPrices();
        if (unpriced && alive.current) setLoad({ state: "ready", unpriced });
        else if (!unpriced) refreshFailed = true;
      } catch {
        // The save already succeeded; say the list couldn't be refreshed
        // instead of pretending it was.
        refreshFailed = true;
      }
      if (!alive.current) return;
      setNotices((n) => [...n.filter((x) => x.key !== key), { key, modelID, refreshFailed }]);
    },
    [fetchPrices],
  );

  const groups = useMemo(() => (load.state === "ready" ? groupUnpriced(load.unpriced) : []), [load]);

  if (load.state !== "ready") return null;
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
          <code>{n.modelID}</code> · {SAVED_MESSAGE}
          {n.refreshFailed ? " (couldn't refresh the list — reopen Settings to update it)" : ""}
        </div>
      ))}
    </div>
  );
}
