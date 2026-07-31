// ===== Model picker (model ▸ effort split) =====
//
// Two buttons in one bordered group (BET-415):
//   - Left:  a friendly model name (m.name) with a Sparkles icon + dropdown.
//   - Right: the active variant, title-cased, with its own dropdown — only
//            rendered when the active model has variants. A model with no
//            variants collapses to the single model button.
//
// Variants are whatever the provider returns (m.variants); no fixed vocabulary,
// no mapping table. The variant label is title-cased for display only — the
// raw id is sent back via onSelect.

import { useMemo, useRef, useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import type { OpencodeModel } from "../shared/types";
import { type ModelSelection, resolveActiveModel } from "./chatShared";
import { formatModelContextSize } from "./chatUtils";
import { useClickAway } from "./hooks/useClickAway";

export function ModelPicker({
  modelLabel,
  models,
  modelOverride,
  defaultModel,
  deactivatedMainModels,
  onOpen,
  onSelect,
}: {
  modelLabel: string | null;
  models: OpencodeModel[] | null;
  modelOverride: ModelSelection | null;
  defaultModel: { providerID: string; modelID: string } | null;
  // BET-215: "providerID/modelID" strings; models in this set are hidden
  // from the picker. Filter lives in the same `groups` chokepoint as the
  // existing enabled/status gate. Default [] = no Main filtering.
  deactivatedMainModels?: string[];
  onOpen: () => void;
  onSelect: (m: ModelSelection | null) => void;
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const [variantOpen, setVariantOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Click-away to dismiss either dropdown. Using mousedown (not click) so we
  // close before an inner button's onClick re-toggles. The hook closes both
  // dropdowns on outside-click or Escape; the caller's toggle buttons are
  // inside rootRef so they don't trigger the dismiss.
  useClickAway(rootRef, modelOpen || variantOpen, () => {
    setModelOpen(false);
    setVariantOpen(false);
  });

  // Group models by providerID so the list reads e.g. "anthropic" → 3 models.
  const groups = useMemo(() => {
    if (!models) return null;
    const deactivatedMain = new Set(deactivatedMainModels ?? []);
    const map = new Map<string, OpencodeModel[]>();
    for (const m of models) {
      if (m.enabled === false || m.status === "deprecated") continue;
      if (deactivatedMain.has(`${m.providerID}/${m.id}`)) continue;
      const arr = map.get(m.providerID) ?? [];
      arr.push(m);
      map.set(m.providerID, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [models, deactivatedMainModels]);

  const isActive = (m: OpencodeModel, variantId?: string): boolean => {
    if (modelOverride) {
      return (
        modelOverride.providerID === m.providerID &&
        modelOverride.modelID === m.id &&
        (modelOverride.variant ?? undefined) === variantId
      );
    }
    return false;
  };

  // Resolve the active model object (for the friendly name + variant list).
  // Shared resolution path with ChatPanel (BET-415 duplication gate).
  const activeModel = useMemo<OpencodeModel | null>(
    () => resolveActiveModel(models, modelOverride, defaultModel),
    [models, modelOverride, defaultModel],
  );

  const variants = activeModel?.variants ?? [];
  const activeVariantId = modelOverride?.variant ?? undefined;
  const activeVariant = variants.find((v) => v.id === activeVariantId) ?? null;

  // Friendly display name for the model button. Falls back through the same
  // precedence as the old label: override → default → last-used → stub.
  const modelDisplayName = activeModel?.name ?? modelLabel ?? "opencode";

  return (
    <div
      ref={rootRef}
      className="manta-model-picker inline-flex items-stretch rounded-lg border border-border-strong bg-card overflow-visible min-w-0"
    >
      {/* Model button — friendly name + Sparkles icon, opens the model list. */}
      <button
        className="manta-model-picker-btn truncate text-meta text-text hover:bg-fill flex items-center gap-1 px-2 py-1"
        onClick={() => {
          if (!modelOpen) onOpen();
          setVariantOpen(false);
          setModelOpen((v) => !v);
        }}
        title="Pick model for next prompt"
      >
        <Sparkles size={12} aria-hidden="true" className="shrink-0 text-accent" />
        <span className="truncate max-w-[140px]">{modelDisplayName}</span>
        <ChevronDown size={12} aria-hidden="true" className="shrink-0 text-text-faint" />
      </button>

      {/* Effort / variant button — only when the active model has variants.
          Renders whatever the provider returns; no fixed vocabulary. */}
      {variants.length > 0 && (
        <button
          className="manta-effort-picker-btn truncate text-meta text-text-muted hover:bg-fill flex items-center gap-1 px-2 py-1 border-l border-border-strong"
          onClick={() => {
            setModelOpen(false);
            setVariantOpen((v) => !v);
          }}
          title="Pick effort / variant"
        >
          <span className="truncate max-w-[80px]">
            {activeVariant ? titleCase(activeVariant.id) : "Default"}
          </span>
          <ChevronDown size={12} aria-hidden="true" className="shrink-0 text-text-faint" />
        </button>
      )}

      {/* Model dropdown — provider-grouped list. Selecting a row sets the
          per-session override; the variant is cleared (the new model's own
          variants show up in the effort button). */}
      {modelOpen && (
        <div
          className="manta-model-dropdown absolute left-0 bottom-full mb-1 z-20 min-w-[240px] max-h-[360px] overflow-y-auto rounded border border-border bg-bg-elev shadow-md text-meta"
        >
          <button
            onClick={() => {
              onSelect(null);
              setModelOpen(false);
            }}
            className={
              "w-full text-left px-2 py-1 hover:bg-bg-soft border-b border-border " +
              (modelOverride == null ? "text-text" : "text-text-muted")
            }
          >
            <span className="mr-1" style={{ color: modelOverride == null ? "var(--accent)" : "transparent" }}>●</span>
            Server default
          </button>
          {!groups && (
            <div className="px-2 py-2 text-text-faint">Loading…</div>
          )}
          {groups?.length === 0 && (
            <div className="px-2 py-2 text-text-faint">No models</div>
          )}
          {groups?.map(([providerID, ms]) => (
            <div key={providerID} className="py-1">
              <div className="px-2 py-0.5 text-micro font-semibold uppercase text-text-faint">
                {providerID}
              </div>
              {ms.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    // Selecting a model clears any variant — the new model's
                    // own variants surface in the effort button.
                    onSelect({ providerID: m.providerID, modelID: m.id });
                    setModelOpen(false);
                  }}
                  className={
                    "w-full text-left px-2 py-0.5 hover:bg-bg-soft flex justify-between gap-2 " +
                    (isActive(m) ? "text-text" : "text-text-muted")
                  }
                >
                  <span className="truncate flex items-center gap-1">
                    <span style={{ color: isActive(m) ? "var(--accent)" : "transparent" }}>●</span>
                    <span>{m.name}</span>
                  </span>
                  {formatModelContextSize(m.limit?.context) ? (
                    <span className="text-text-faint text-meta shrink-0">
                      {formatModelContextSize(m.limit?.context)}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Variant / effort dropdown — flat list of the active model's
          variants plus a "Default" (no variant) row. */}
      {variantOpen && variants.length > 0 && (
        <div
          className="manta-effort-dropdown absolute left-0 bottom-full mb-1 z-20 min-w-[160px] rounded border border-border bg-bg-elev shadow-md text-meta"
        >
          <button
            onClick={() => {
              onSelect({
                providerID: activeModel!.providerID,
                modelID: activeModel!.id,
              });
              setVariantOpen(false);
            }}
            className={
              "w-full text-left px-2 py-1 hover:bg-bg-soft border-b border-border " +
              (activeVariantId == null ? "text-text" : "text-text-muted")
            }
          >
            <span className="mr-1" style={{ color: activeVariantId == null ? "var(--accent)" : "transparent" }}>●</span>
            Default
          </button>
          {variants.map((v) => (
            <button
              key={v.id}
              onClick={() => {
                onSelect({
                  providerID: activeModel!.providerID,
                  modelID: activeModel!.id,
                  variant: v.id,
                });
                setVariantOpen(false);
              }}
              className={
                "w-full text-left px-2 py-0.5 hover:bg-bg-soft " +
                (isActive(activeModel!, v.id) ? "text-text" : "text-text-muted")
              }
            >
              <span style={{ color: isActive(activeModel!, v.id) ? "var(--accent)" : "transparent" }}>●</span>{" "}
              {titleCase(v.id)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Title-case a variant id for display: "high" → "High", "extended-thinking"
// → "Extended Thinking". The raw id is preserved for the wire; this is
// display-only.
function titleCase(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}
