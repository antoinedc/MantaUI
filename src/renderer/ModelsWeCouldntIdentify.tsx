// ===== ModelsWeCouldntIdentify (BET-1249 / BET-1272, server-first WS09) =====
//
// "Models we couldn't identify" — the Settings → Models block that lets a user
// tell us what an opaque endpoint is actually serving. The BOX computes the rows
// (`models:unidentified`, src/server/modelsUnidentified.mjs): which endpoints
// Auto cannot yet describe (the SAME gate the router waits on), each row's help
// line, its actions and whether it gets candidate chips. Saving goes through
// `models:declare`, where the box builds + validates the declaration and merges
// it into `modelRouting.declaredModels`. This component renders rows and keeps
// only the editor's view state; the catalogue typeahead and Save gating stay
// client-side (they are pure UI affordances).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eyebrow } from "./Eyebrow";
import { Card } from "./Card";
import { SettingsRow } from "./SettingsRow";
import { ChipGroup } from "./Chip";
import { Button } from "./Button";
import { Checkbox } from "./Checkbox";
import { useCachedResource } from "./useCachedResource";
import { useRoutingCatalog } from "./routingCatalog";
import { UPDATE_YOUR_BOX, isUnknownChannel } from "./modelsPicker";
import type { ModelsDeclareForm, UnidentifiedList, UnidentifiedRow } from "../shared/types";
import type { ModelCatalogEntry } from "../shared/modelCatalog.mjs";

const fieldCls =
  "w-full bg-bg-soft border border-border px-3 py-2 text-body rounded-xs focus:outline-none focus:border-accent";

const numFieldCls =
  "w-[84px] bg-bg-soft border border-border px-3 py-2 text-body rounded-xs focus:outline-none focus:border-accent";

// ---- Searchable typeahead over the catalogue (client affordance) ----
function ModelSearch({
  entries,
  selected,
  onSelect,
}: {
  entries: ModelCatalogEntry[];
  selected: ModelCatalogEntry | null;
  onSelect: (e: ModelCatalogEntry | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries.slice(0, 30);
    return entries.filter((e) => `${e.id ?? ""} ${e.name ?? ""} ${e.family ?? ""}`.toLowerCase().includes(q)).slice(0, 50);
  }, [entries, query]);

  return (
    <div className="relative" ref={ref}>
      <input
        type="text"
        value={selected ? (selected.name ?? selected.id ?? "") : query}
        placeholder="Search the catalogue…"
        className={fieldCls}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          if (selected) onSelect(null);
          setQuery(e.target.value);
        }}
      />
      {open && results.length > 0 && (
        <div className="absolute z-20 mt-1 w-full max-h-64 overflow-auto border border-border bg-raised rounded-xs shadow">
          {results.map((e) => (
            <button
              key={e.id ?? e.name ?? ""}
              type="button"
              className="block w-full text-left px-3 py-2 text-body text-text hover:bg-fill-hover"
              onMouseDown={(ev) => {
                ev.preventDefault();
                onSelect(e);
                setOpen(false);
              }}
            >
              <span className="font-medium">{e.name ?? e.id}</span>
              <span className="ml-2 text-meta text-text-faint">{e.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// The editor: a searchable model input plus the two optional fields. Price has NO
// default — Save stays disabled until Free is picked or a rate is typed.
function IdentifyEditor({
  entries,
  initial,
  busy,
  error,
  onSave,
  onCancel,
}: {
  entries: ModelCatalogEntry[];
  initial: ModelCatalogEntry | null;
  busy: boolean;
  /** The box's refusal for this row, shown under the field it names. */
  error: { field?: string; message: string } | null;
  onSave: (form: ModelsDeclareForm) => void;
  onCancel?: () => void;
}) {
  const [selected, setSelected] = useState<ModelCatalogEntry | null>(initial);
  const [priceMode, setPriceMode] = useState<"" | "free" | "custom">("");
  const [costIn, setCostIn] = useState("");
  const [costOut, setCostOut] = useState("");
  const [cacheMode, setCacheMode] = useState<"none" | "custom">("none");
  const [cacheRead, setCacheRead] = useState(true);
  const [cacheWrite, setCacheWrite] = useState(true);

  // Free is a complete answer; Custom needs at least one finite rate.
  const priceChosen =
    priceMode === "free" ||
    (priceMode === "custom" && (Number.isFinite(parseFloat(costIn)) || Number.isFinite(parseFloat(costOut))));

  const save = () => {
    if (!selected || !priceChosen) return;
    onSave({
      catalogId: selected.id ?? "",
      price: priceMode || null,
      costIn,
      costOut,
      caching: cacheMode,
      reads: cacheRead,
      writes: cacheWrite,
    });
  };

  return (
    <div className="flex flex-col gap-3 w-[360px]">
      <ModelSearch entries={entries} selected={selected} onSelect={setSelected} />
      {error?.field === "catalogId" && (
        <div role="alert" className="text-meta text-danger">
          {error.message}
        </div>
      )}
      {selected?.description ? <div className="text-meta text-text-quiet">{selected.description}</div> : null}
      <div>
        <div className="text-micro font-semibold uppercase text-text-muted mb-2">Costs here</div>
        <ChipGroup
          label="Costs here"
          value={priceMode}
          options={[
            { value: "free", label: "Free" },
            { value: "custom", label: "Custom" },
          ]}
          onChange={(v) => setPriceMode(v)}
        />
        {priceMode === "custom" && (
          <div className="mt-2 flex items-center gap-2">
            <input
              type="number"
              min={0}
              value={costIn}
              onChange={(e) => setCostIn(e.target.value)}
              placeholder="in / 1M"
              aria-label="Custom input cost per 1M tokens"
              className={numFieldCls}
            />
            <input
              type="number"
              min={0}
              value={costOut}
              onChange={(e) => setCostOut(e.target.value)}
              placeholder="out / 1M"
              aria-label="Custom output cost per 1M tokens"
              className={numFieldCls}
            />
          </div>
        )}
        {error?.field === "price" && (
          <div role="alert" className="text-meta text-danger mt-1">
            {error.message}
          </div>
        )}
      </div>
      <div>
        <div className="text-micro font-semibold uppercase text-text-muted mb-2">Caching</div>
        <ChipGroup
          label="Caching"
          value={cacheMode}
          options={[
            { value: "none", label: "None" },
            { value: "custom", label: "Custom" },
          ]}
          onChange={(v) => setCacheMode(v)}
        />
        {cacheMode === "custom" && (
          <div className="mt-2 flex items-center gap-4">
            <label className="flex items-center gap-2 text-body text-text-muted">
              <Checkbox checked={cacheRead} onChange={() => setCacheRead(!cacheRead)} ariaLabel="Cache reads" />
              reads
            </label>
            <label className="flex items-center gap-2 text-body text-text-muted">
              <Checkbox checked={cacheWrite} onChange={() => setCacheWrite(!cacheWrite)} ariaLabel="Cache writes" />
              writes
            </label>
          </div>
        )}
      </div>
      {error && error.field !== "catalogId" && error.field !== "price" && (
        <div role="alert" className="text-meta text-danger">
          {error.message}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button onClick={save} tone="primary" disabled={!selected || !priceChosen || busy}>
          Save
        </Button>
        {onCancel && (
          <Button onClick={onCancel} tone="ghost" disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

const UNSUPPORTED = "unsupported" as const;

export function ModelsWeCouldntIdentify() {
  const { data, refresh } = useCachedResource<UnidentifiedList | typeof UNSUPPORTED>("modelsWeCouldntIdentify", async () => {
    try {
      return await window.api.modelsUnidentified();
    } catch (e) {
      if (isUnknownChannel(e)) return UNSUPPORTED;
      throw e;
    }
  });
  const catalog = useRoutingCatalog();
  // A declare reply carries the refreshed list — show it at once.
  const [replied, setReplied] = useState<UnidentifiedList | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ key: string | null; field?: string; message: string } | null>(null);

  useEffect(() => {
    const off = window.api.onModelsUpdated?.(() => {
      void refresh().then(() => setReplied(null));
    });
    return () => off?.();
  }, [refresh]);

  const declare = useCallback(
    async (key: string, input: { catalogId: string } | { form: ModelsDeclareForm }) => {
      if (busy) return;
      setBusy(key);
      setSaveError(null);
      setNotice(null);
      try {
        const reply = await window.api.modelsDeclare({ key, ...input });
        if (reply.ok) {
          setReplied(reply.list);
          setNotice(reply.message);
        } else {
          setSaveError({ key, field: reply.field, message: reply.message });
        }
      } catch (e) {
        setSaveError({ key: null, message: isUnknownChannel(e) ? UPDATE_YOUR_BOX : `Couldn't confirm the save — ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  const list = replied ?? data;
  if (!list) return null;

  if (list === UNSUPPORTED) {
    return (
      <div>
        <Eyebrow>Models we couldn't identify</Eyebrow>
        <Card>
          <p className="text-meta text-text-faint">{UPDATE_YOUR_BOX}</p>
        </Card>
      </div>
    );
  }

  // The catalogue is unavailable — nothing on the box can be resolved. Say so
  // rather than hiding (a surface that disappears when its input is missing reads as broken).
  if (!list.supported) {
    return (
      <div>
        <Eyebrow>Models we couldn't identify</Eyebrow>
        <Card>
          <div className="space-y-4">
            <p className="text-meta text-text-faint max-w-[62ch]">{list.intro}</p>
            <p className="text-meta text-text-quiet">{list.unavailableText}</p>
          </div>
        </Card>
      </div>
    );
  }

  if (list.rows.length === 0 && !notice) return null;

  return (
    <div>
      <Eyebrow>Models we couldn't identify</Eyebrow>
      <Card>
        <div className="space-y-4">
          <p className="text-meta text-text-faint max-w-[62ch]">{list.intro}</p>

          {notice && (
            <div role="status" className="text-meta text-text-muted">
              {notice}
            </div>
          )}
          {saveError && saveError.key === null && (
            <div role="alert" className="text-meta text-danger">
              {saveError.message}
            </div>
          )}

          {list.rows.map((row) => (
            <EndpointRow
              key={row.key}
              row={row}
              entries={catalog.entries}
              busy={busy === row.key}
              error={saveError?.key === row.key ? saveError : null}
              onDeclare={(input) => void declare(row.key, input)}
            />
          ))}

          <p className="text-meta text-text-quiet">{list.footer}</p>
        </div>
      </Card>
    </div>
  );
}

function EndpointRow({
  row,
  entries,
  busy,
  error,
  onDeclare,
}: {
  row: UnidentifiedRow;
  entries: ModelCatalogEntry[];
  busy: boolean;
  error: { field?: string; message: string } | null;
  onDeclare: (input: { catalogId: string } | { form: ModelsDeclareForm }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const has = (a: string) => row.actions.includes(a as UnidentifiedRow["actions"][number]);
  const initial = row.catalogId ? (entries.find((e) => e.id === row.catalogId) ?? null) : null;
  const editor = (pre: ModelCatalogEntry | null, onCancel?: () => void) => (
    <IdentifyEditor
      entries={entries}
      initial={pre}
      busy={busy}
      error={error}
      onSave={(form) => onDeclare({ form })}
      onCancel={onCancel}
    />
  );

  const editorShown = (has("pick") && !row.chips) || has("identify") || editing;
  let control;
  if (has("pick") && row.chips) {
    control = (
      <ChipGroup
        label={`Which model is ${row.label}?`}
        value={""}
        options={row.candidates.map((c) => ({ value: c.id, label: c.name || c.id }))}
        onChange={(v) => onDeclare({ catalogId: v })}
      />
    );
  } else if (has("pick") || has("identify")) {
    control = editor(null);
  } else if (editing) {
    control = editor(initial, () => setEditing(false));
  } else {
    control = (
      <div className="flex items-center gap-3">
        {has("confirm") && (
          <button
            type="button"
            onClick={() => onDeclare({ catalogId: row.catalogId ?? "" })}
            disabled={busy}
            className="text-meta text-accent hover:underline disabled:opacity-40"
          >
            Confirm
          </button>
        )}
        {has("change") && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={busy}
            className="text-meta text-accent hover:underline disabled:opacity-40"
          >
            Change
          </button>
        )}
      </div>
    );
  }

  return (
    <SettingsRow name={row.label} help={row.help}>
      <div className="flex flex-col gap-1">
        {control}
        {error && !editorShown && (
          <div role="alert" className="text-meta text-danger">
            {error.message}
          </div>
        )}
      </div>
    </SettingsRow>
  );
}
