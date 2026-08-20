// ===== ModelsWeCouldntIdentify (BET-1249) =====
//
// "Models we couldn't identify" — the Settings → Models block that lets a
// user tell us what an opaque endpoint is actually serving. Rendered above the
// model table, ONLY when at least one endpoint has no user declaration
// (`declaredModels[key]` absent) — an empty section is noise on a healthy box.
//
// One SettingsRow per unresolved endpoint, its case derived from the shared
// identity resolver:
//   • exact      → we auto-matched a single catalogue entry → "Matched
//                  automatically → …" + a Change action (opens the editor).
//   • ambiguous  → several catalogue entries could be it → the candidate chips;
//                  we never guess between them.
//   • none       → no match → a searchable typeahead over the catalogue, plus
//                  the two optional fields (Costs here, default free; Caching,
//                  default none — the safe-overestimate direction).
//
// Saving writes a ModelDeclaration into `modelRouting.declaredModels[key]` via
// the caller's `onDeclare` (ModelsCard routes it through configUpdate) and the
// row disappears (declared → no longer unresolved). Leaving a row untouched
// writes nothing.

import { useMemo, useRef, useState } from "react";
import { Eyebrow } from "./Eyebrow";
import { Card } from "./Card";
import { SettingsRow } from "./SettingsRow";
import { ChipGroup } from "./Chip";
import { Button } from "./Button";
import { Checkbox } from "./Checkbox";
import { describeModel } from "../shared/modelGuide.mjs";
import { resolveIdentity } from "../shared/modelIdentity.mjs";
import { formatModelContextSize } from "./chatUtils";
import type { OpencodeModel } from "../shared/types";
import type {
  OpencodeModel as IdentityOpencodeModel,
} from "../shared/modelIdentity.mjs";
import type { ModelCatalog, ModelCatalogEntry } from "../shared/modelCatalog.mjs";
import type { RoutingCatalog } from "./routingCatalog";

export type DeclaredModel = {
  catalogId?: string;
  price?: { input: number; output: number } | "free";
  caches?: false | { read?: boolean; write?: boolean };
  tierOverride?: "fast" | "balanced" | "deep";
};

const modelKey = (providerID: string, id: string) => `${providerID}/${id}`;

const fieldCls =
  "w-full bg-bg-soft border border-border px-3 py-2 text-body rounded-xs focus:outline-none focus:border-accent";

const numFieldCls =
  "w-[84px] bg-bg-soft border border-border px-3 py-2 text-body rounded-xs focus:outline-none focus:border-accent";

// ---- Searchable typeahead over the catalogue ----
function ModelSearch({
  entries,
  selected,
  onSelect,
}: {
  entries: ModelCatalogEntry[];
  selected: ModelCatalogEntry | null;
  onSelect: (e: ModelCatalogEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries.slice(0, 30);
    return entries
      .filter((e) =>
        `${e.id ?? ""} ${e.name ?? ""} ${e.family ?? ""}`.toLowerCase().includes(q),
      )
      .slice(0, 50);
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
          if (selected) onSelect(null as unknown as ModelCatalogEntry);
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

// The "none" case editor (also reused by clicking Change on an "exact" row): a
// searchable model input plus the two optional fields, with safe defaults.
function IdentifyEditor({
  catalog,
  initial,
  busy,
  onSave,
  onCancel,
}: {
  catalog: ModelCatalog;
  initial: ModelCatalogEntry | null;
  busy: boolean;
  onSave: (decl: DeclaredModel) => void;
  onCancel?: () => void;
}) {
  const [selected, setSelected] = useState<ModelCatalogEntry | null>(initial);
  const [priceMode, setPriceMode] = useState<"free" | "custom">("free");
  const [costIn, setCostIn] = useState("");
  const [costOut, setCostOut] = useState("");
  const [cacheMode, setCacheMode] = useState<"none" | "custom">("none");
  const [cacheRead, setCacheRead] = useState(true);
  const [cacheWrite, setCacheWrite] = useState(true);

  const save = () => {
    if (!selected) return;
    const decl: DeclaredModel = { catalogId: selected.id };
    if (priceMode === "custom") {
      const input = parseFloat(costIn);
      const output = parseFloat(costOut);
      if (Number.isFinite(input) || Number.isFinite(output)) {
        decl.price = {
          input: Number.isFinite(input) ? input : 0,
          output: Number.isFinite(output) ? output : 0,
        };
      }
    } else {
      decl.price = "free";
    }
    if (cacheMode === "custom") decl.caches = { read: cacheRead, write: cacheWrite };
    else decl.caches = false;
    onSave(decl);
  };

  return (
    <div className="flex flex-col gap-3 w-[360px]">
      <ModelSearch
        entries={catalog.allModels()}
        selected={selected}
        onSelect={(e) => setSelected(e)}
      />
      {selected?.description ? (
        <div className="text-meta text-text-quiet">{selected.description}</div>
      ) : null}
      <div>
        <div className="text-micro font-semibold uppercase text-text-muted mb-2">
          Costs here
        </div>
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
      </div>
      <div>
        <div className="text-micro font-semibold uppercase text-text-muted mb-2">
          Caching
        </div>
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
      <div className="flex items-center gap-2">
        <Button onClick={save} tone="primary" disabled={!selected || busy}>
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

export function ModelsWeCouldntIdentify({
  models,
  declaredModels,
  catalog,
  busyKey,
  onDeclare,
}: {
  models: OpencodeModel[];
  declaredModels: Record<string, DeclaredModel> | undefined;
  catalog: RoutingCatalog;
  /** The "providerID/modelID" key mid-mutation, for disabling that row. */
  busyKey: string | null;
  onDeclare: (key: string, decl: DeclaredModel) => void;
}) {
  const matcher = catalog.matcher;

  const rows = useMemo(() => {
    if (!matcher) return [];
    const out: {
      model: OpencodeModel;
      key: string;
      state: "exact" | "ambiguous" | "none";
      catalogId: string | null;
      candidates: ModelCatalogEntry[];
    }[] = [];
    for (const m of models) {
      const key = modelKey(m.providerID, m.id);
      if (declaredModels?.[key]) continue;
      // The renderer's OpencodeModel and modelIdentity's are structurally alike
      // at runtime but disagree on the `capabilities.input` sub-type; the cast
      // is only for TS (resolveIdentity reads providerID/id/family/limit/cost).
      const id = resolveIdentity(
        m as unknown as IdentityOpencodeModel,
        null,
        matcher,
      );
      if (id.state === "resolved") {
        out.push({
          model: m,
          key,
          state: "exact",
          catalogId: id.catalogId,
          candidates: [],
        });
      } else if (id.state === "ambiguous") {
        const candidates = (id.candidates ?? [])
          .map((c) => matcher.lookupModel(c))
          .filter((e): e is ModelCatalogEntry => e != null);
        out.push({
          model: m,
          key,
          state: "ambiguous",
          catalogId: null,
          candidates,
        });
      } else {
        out.push({
          model: m,
          key,
          state: "none",
          catalogId: null,
          candidates: [],
        });
      }
    }
    return out;
  }, [models, declaredModels, matcher]);

  if (!matcher) return null;
  if (rows.length === 0) return null;

  return (
    <div>
      <Eyebrow>Models we couldn't identify</Eyebrow>
      <Card>
        <div className="space-y-4">
          <p className="text-meta text-text-faint max-w-[62ch]">
            Served under a name the catalogue doesn't recognise, so Manta can't
            tell what they are or what they're good at. They stay usable by
            hand. Identify one and Auto can start choosing it.
          </p>

          {rows.map((row) => (
            <EndpointRow
              key={row.key}
              row={row}
              matcher={matcher}
              busy={busyKey === row.key}
              onDeclare={(decl) => onDeclare(row.key, decl)}
            />
          ))}

          <p className="text-meta text-text-quiet">
            Can't say? Leave it. The model stays available to pick by hand —
            Auto just won't choose something it can't describe.
          </p>
        </div>
      </Card>
    </div>
  );
}

function EndpointRow({
  row,
  matcher,
  busy,
  onDeclare,
}: {
  row: {
    model: OpencodeModel;
    key: string;
    state: "exact" | "ambiguous" | "none";
    catalogId: string | null;
    candidates: ModelCatalogEntry[];
  };
  matcher: ModelCatalog;
  busy: boolean;
  onDeclare: (decl: DeclaredModel) => void;
}) {
  const [editing, setEditing] = useState(false);
  const name = `${row.model.providerID} / ${row.model.id}`;

  // exact case
  if (row.state === "exact") {
    const entry = row.catalogId ? matcher.lookupModel(row.catalogId) : null;
    const ctx = entry ? formatModelContextSize(entry.limit?.context) : "";
    const tier = row.catalogId ? describeModel(row.model.providerID, row.catalogId)?.tier : undefined;
    const bits = [entry?.name ?? row.catalogId];
    if (tier) bits.push(tier);
    if (ctx) bits.push(ctx);
    const help = entry || row.catalogId ? `Matched automatically → ${bits.join(" · ")}` : null;
    return (
      <SettingsRow name={name} help={help}>
        {editing ? (
          <IdentifyEditor
            catalog={matcher}
            initial={entry}
            busy={busy}
            onSave={onDeclare}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={busy}
            className="text-meta text-accent hover:underline disabled:opacity-40"
          >
            Change
          </button>
        )}
      </SettingsRow>
    );
  }

  // ambiguous case — candidate chips, none preselected
  if (row.state === "ambiguous") {
    return (
      <SettingsRow
        name={name}
        help={`${row.candidates.length} models share this name — which one is it?`}
      >
        {row.candidates.length > 4 ? (
          <div className="w-[360px]">
            <IdentifyEditor
              catalog={matcher}
              initial={null}
              busy={busy}
              onSave={onDeclare}
            />
          </div>
        ) : (
          <ChipGroup
            label={`Which model is ${name}?`}
            value={""}
            options={row.candidates.map((c) => ({ value: c.id ?? "", label: c.name ?? c.id ?? "" }))}
            onChange={(v) => onDeclare({ catalogId: v })}
          />
        )}
      </SettingsRow>
    );
  }

  // none case — search + the two optional fields
  return (
    <SettingsRow name={name} help="No match — tell us which model this is">
      <IdentifyEditor
        catalog={matcher}
        initial={null}
        busy={busy}
        onSave={onDeclare}
      />
    </SettingsRow>
  );
}
