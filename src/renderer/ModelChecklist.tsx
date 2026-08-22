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

export function ModelChecklist({
  models,
  checked,
  onToggle,
  onBulkChange,
  disabled,
}: {
  models: { id: string }[];
  /** The ids currently selected. Read-only; mutation flows back via onToggle/onBulkChange. */
  checked: Set<string>;
  onToggle: (id: string) => void;
  /** Present → render the filter box + All/None row. Absent → neither. */
  onBulkChange?: (ids: string[], next: boolean) => void;
  disabled: boolean;
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
          visible.map((m) => (
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
            />
          ))
        )}
      </div>
    </div>
  );
}
