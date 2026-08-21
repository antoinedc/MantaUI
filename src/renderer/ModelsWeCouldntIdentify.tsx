// ===== ModelsWeCouldntIdentify (BET-1249 / BET-1272) =====
//
// "Models we couldn't identify" — the Settings → Models block that lets a
// user tell us what an opaque endpoint is actually serving. It is the SIBLING
// GroupCard above the models table (mounted in Settings), not a card nested
// inside it.
//
// An endpoint is listed ONLY when it fails the shared Auto-eligibility gate
// (autoEligibility.mjs — the SAME gate the router waits on), so the UI can
// never claim something is routable when it is not. An endpoint that is fully
// described (identity + price + caching + quality known) is not listed. When
// the catalogue itself is unavailable there is nothing to resolve against, so
// the block renders a single explanatory line instead of hiding — a surface
// that hides when its input is missing is indistinguishable from a broken one.
//
// One SettingsRow per unresolved endpoint, its case derived from the shared
// identity resolver:
//   • exact      → we auto-matched a single catalogue entry → "Matched
//                  automatically → …" + a Change action; listed only while a
//                  gap (e.g. price) remains, and the help line says which.
//   • ambiguous  → several catalogue entries could be it → the candidate chips;
//                  we never guess between them.
//   • none       → no match → a searchable typeahead over the catalogue, plus
//                  the two optional fields (Costs here, no default; Caching,
//                  default none). Price has NO default — Save stays disabled
//                  until the user picks Free or enters rates.
//
// Saving writes a ModelDeclaration into `modelRouting.declaredModels[key]` via
// configUpdate and the row disappears (declared → eligible). Leaving a row
// untouched writes nothing.

import { useCallback, useMemo, useRef, useState } from "react";
import { Eyebrow } from "./Eyebrow";
import { Card } from "./Card";
import { SettingsRow } from "./SettingsRow";
import { ChipGroup } from "./Chip";
import { Button } from "./Button";
import { Checkbox } from "./Checkbox";
import { describeModel } from "../shared/modelGuide.mjs";
import { resolveIdentity } from "../shared/modelIdentity.mjs";
import { autoEligibility } from "../shared/autoEligibility.mjs";
import { formatModelContextSize } from "./chatUtils";
import { describeMissing } from "./AccountsCard";
import { useCachedResource } from "./useCachedResource";
import { useRoutingCatalog } from "./routingCatalog";
import type { AppConfig, OpencodeModel } from "../shared/types";
import type {
  OpencodeModel as IdentityOpencodeModel,
} from "../shared/modelIdentity.mjs";
import type { ModelCatalog, ModelCatalogEntry } from "../shared/modelCatalog.mjs";

export type DeclaredModel = {
  catalogId?: string;
  price?: { input: number; output: number } | "free";
  caches?: false | { read?: boolean; write?: boolean };
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
  // Price has NO default (BET-1272 §8f): "" ("none chosen") is the initial
  // state, and Save stays disabled until the user picks Free or enters at
  // least one rate. Caching keeps its "none" default (that genuinely
  // over-estimates cost).
  const [priceMode, setPriceMode] = useState<"" | "free" | "custom">("");
  const [costIn, setCostIn] = useState("");
  const [costOut, setCostOut] = useState("");
  const [cacheMode, setCacheMode] = useState<"none" | "custom">("none");
  const [cacheRead, setCacheRead] = useState(true);
  const [cacheWrite, setCacheWrite] = useState(true);

  // The user has supplied a price: Free is a complete answer; Custom needs at
  // least one finite rate, otherwise the declaration would silently omit price
  // and the endpoint would stay ineligible (still listed) after a save.
  const priceChosen =
    priceMode === "free" ||
    (priceMode === "custom" &&
      (Number.isFinite(parseFloat(costIn)) || Number.isFinite(parseFloat(costOut))));

  const save = () => {
    if (!selected || !priceChosen) return;
    const decl: DeclaredModel = { catalogId: selected.id };
    if (priceMode === "custom") {
      const input = parseFloat(costIn);
      const output = parseFloat(costOut);
      decl.price = {
        input: Number.isFinite(input) ? input : 0,
        output: Number.isFinite(output) ? output : 0,
      };
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

export function ModelsWeCouldntIdentify() {
  const {
    data,
    refresh,
  } = useCachedResource<{
    models: OpencodeModel[];
    declaredModels: Record<string, DeclaredModel> | undefined;
  }>("modelsWeCouldntIdentify", async () => {
    const [modelList, cfg] = await Promise.all([
      window.api.opencodeModels(),
      window.api.configGet(),
    ]);
    return {
      models: modelList,
      declaredModels: (cfg as AppConfig).modelRouting?.declaredModels,
    };
  });
  const catalog = useRoutingCatalog();
  const matcher = catalog.matcher;
  const models = data?.models;
  const declaredModels = data?.declaredModels;
  const [busy, setBusy] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const declare = useCallback(
    async (key: string, decl: DeclaredModel) => {
      if (busy) return;
      setBusy(key);
      setSaveError(null);
      try {
        const cfg = (await window.api.configGet()) as AppConfig;
        const routing = cfg.modelRouting ?? { preset: "balanced" };
        const declared = { ...(routing.declaredModels ?? {}), [key]: decl };
        await window.api.configUpdate({
          modelRouting: { ...routing, declaredModels: declared },
        });
        // A fresh fetch removes the now-declared (eligible) endpoint in the
        // same tick. A failed mutation changed nothing on the box and cleared
        // nothing, so refresh only on success.
        await refresh();
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [busy, refresh],
  );

  const rows = useMemo(() => {
    if (!matcher || !models) return [];
    const out: {
      model: OpencodeModel;
      key: string;
      state: "exact" | "ambiguous" | "none";
      catalogId: string | null;
      candidates: ModelCatalogEntry[];
      missing: string[];
    }[] = [];
    for (const m of models) {
      const key = modelKey(m.providerID, m.id);
      const decl = declaredModels?.[key];
      // The renderer's OpencodeModel and modelIdentity's are structurally alike
      // at runtime but disagree on the `capabilities.input` sub-type; the cast
      // is only for TS (resolveIdentity reads providerID/id/family/limit/cost).
      const id = resolveIdentity(
        m as unknown as IdentityOpencodeModel,
        decl ?? null,
        matcher,
      );
      // The ONE gate: list an endpoint only when Auto cannot yet describe it —
      // the same gate the router waits on. A resolved identity with a known
      // price and known caching is eligible and NOT listed.
      const elig = autoEligibility({
        model: id.effective,
        identity: { known: id.state === "resolved" },
        quality: { known: id.state === "resolved" },
        declared: decl,
        // These models come from opencode's own provider list (the supported
        // catalogue providers); the input is required by type.
        providerClass: "supported",
      });
      if (elig.eligible) continue;
      if (id.state === "resolved") {
        out.push({
          model: m,
          key,
          state: "exact",
          catalogId: id.catalogId,
          candidates: [],
          missing: elig.missing,
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
          missing: elig.missing,
        });
      } else {
        out.push({
          model: m,
          key,
          state: "none",
          catalogId: null,
          candidates: [],
          missing: elig.missing,
        });
      }
    }
    return out;
  }, [models, declaredModels, matcher]);

  // The catalogue is unavailable — nothing on the box can be resolved. Render
  // the block with a single explanatory line rather than hiding (a surface
  // that disappears when its input is missing reads as broken).
  if (!catalog.supported || !matcher) {
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
            <p className="text-meta text-text-quiet">
              Manta couldn't load the model catalogue, so it can't tell what any
              of these endpoints are. Auto won't choose a model it can't
              describe. This usually clears on its own — reopen Settings in a
              minute.
            </p>
          </div>
        </Card>
      </div>
    );
  }

  if (!models || rows.length === 0) return null;

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

          {saveError && (
            <div role="alert" className="text-meta text-danger">
              {saveError}
            </div>
          )}

          {rows.map((row) => (
            <EndpointRow
              key={row.key}
              row={row}
              matcher={matcher}
              busy={busy === row.key}
              onDeclare={(decl) => void declare(row.key, decl)}
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
    missing: string[];
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
    const missing = describeMissing(row.missing);
    // The row is listed only because something is still missing for Auto; name
    // that gap so the UI never claims a different thing from what blocks
    // routing. "what it costs" / "whether it caches" / "how it compares" come
    // from autoEligibility's MISSING keys via describeMissing.
    const help =
      `Matched automatically → ${bits.join(" · ")}` +
      (missing ? ` — Auto still needs: ${missing}` : "");
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
