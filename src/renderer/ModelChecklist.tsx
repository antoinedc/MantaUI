// ModelChecklist — the one shared model checklist (BET-1312).
//
// Replaces TWO hand-rolled `flex … gap-2` + `Checkbox` lists that had drifted
// apart: the probe-results list in CustomProviderForm and the saved-endpoint
// list in AccountsCard. A real aggregator probe returns 40–300 pre-checked
// model ids, so the probe list gains a filter box and All/None batch controls;
// the saved-endpoint list keeps today's per-tick-write behaviour exactly.
//
// THE ONE PROP THAT GATES EVERYTHING: `onBulkChange` present → render the
// filter box AND the All/None row. `onBulkChange` absent → render neither.
// There is deliberately no `searchable` / `mode` second prop: the two always
// co-vary (probe list gets both, saved list gets neither), and two props that
// always move together invite drift.
//
// All/None act only on the VISIBLE (filtered) ids and are the caller's batch
// hook; the caller decides whether a batch is local-only (probe list) or
// write-through (it is not offered to a caller that can't batch — see the
// gate). The ListRow primitive owns the checkbox row + the double-toggle
// guard; the Checkbox keeps `ariaLabel` so existing tests find rows by it.

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Field } from "./Field";
import { Button } from "./Button";
import { Checkbox } from "./Checkbox";
import { ListRow } from "./ListRow";
import { formatEndpointStateLine } from "./chatUtils";

/**
 * BET-1537 (S5, §W9): optional per-model ENDPOINT health, keyed by model id
 * (the caller resolves `${providerID}/${modelId}` → modelId before handing it
 * over). Present → each row with a non-ok register state shows the human
 * state (and the rate-limit deadline) next to its name, from the SAME
 * register that gates Auto — the badge can never disagree with routing.
 */
export type ModelHealthStates = Record<string, { state: string; retryInMs?: number | null }>;

export function ModelChecklist({
  models,
  checked,
  onToggle,
  onBulkChange,
  disabled,
  states,
}: {
  models: { id: string }[];
  /** The ids currently selected. Read-only; mutation flows back via onToggle/onBulkChange. */
  checked: Set<string>;
  onToggle: (id: string) => void;
  /** Present → render the filter box + All/None row. Absent → neither. */
  onBulkChange?: (ids: string[], next: boolean) => void;
  disabled: boolean;
  /** Per-model endpoint-register state (BET-1537). Absent → no badges. */
  states?: ModelHealthStates;
}) {
  const [query, setQuery] = useState("");
  const trimmed = query.trim().toLowerCase();

  const visible = useMemo(() => {
    if (!trimmed) return models;
    return models.filter((m) => m.id.toLowerCase().includes(trimmed));
  }, [models, trimmed]);

  const searchable = onBulkChange !== undefined;
  const filterActive = trimmed.length > 0;
  const allChecked = visible.length > 0 && visible.every((m) => checked.has(m.id));
  const noneChecked = visible.length > 0 && visible.every((m) => !checked.has(m.id));
  const visibleIds = visible.map((m) => m.id);

  return (
    <div className="rounded-md border border-border bg-bg-soft overflow-hidden">
      {searchable && (
        <div className="border-b border-border-subtle p-2">
          <Field
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            leading={<Search size={14} />}
            mono={false}
            ariaLabel="Filter models"
            placeholder={`Filter ${models.length} models…`}
          />
        </div>
      )}
      <div className="border-b border-border-subtle px-2 py-1 flex items-center justify-between gap-2">
        <div className="text-meta text-text-faint">
          {checked.size} of {models.length} selected
          {filterActive ? ` · ${visible.length} shown` : ""}
        </div>
        {searchable && (
          <div className="flex items-center gap-1">
            <Button
              tone="ghost"
              disabled={disabled || visible.length === 0 || allChecked}
              onClick={() => onBulkChange && onBulkChange(visibleIds, true)}
            >
              {filterActive ? `All ${visible.length}` : "All"}
            </Button>
            <Button
              tone="ghost"
              disabled={disabled || visible.length === 0 || noneChecked}
              onClick={() => onBulkChange && onBulkChange(visibleIds, false)}
            >
              None
            </Button>
          </div>
        )}
      </div>
      <div className="max-h-48 overflow-auto p-1">
        {visible.length === 0 ? (
          <div className="px-2 py-4 text-center text-meta text-text-faint">
            No model matches “{trimmed}”.
          </div>
        ) : (
          visible.map((m) => {
            const h = states?.[m.id];
            // BET-1537 review Block 3: the badge renders through the ONE pure
            // helper (chatUtils), never inline formatting.
            const line = h ? formatEndpointStateLine(h, Date.now()) : "";
            return (
              <ListRow
                key={m.id}
                leading={
                  <Checkbox
                    checked={checked.has(m.id)}
                    onChange={() => onToggle(m.id)}
                    disabled={disabled}
                    ariaLabel={m.id}
                  />
                }
                name={m.id}
                onClick={() => onToggle(m.id)}
                trailing={
                  line ? (
                    <span
                      data-testid={`endpoint-state-${m.id}`}
                      className="text-meta text-text-faint whitespace-nowrap"
                    >
                      {line}
                    </span>
                  ) : undefined
                }
              />
            );
          })
        )}
      </div>
    </div>
  );
}
