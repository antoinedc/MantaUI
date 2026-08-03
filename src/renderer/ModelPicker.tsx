// ===== Model picker (model ▸ effort split) =====
//
// One SplitChip control (BET-615): the model name/button on the left, the
// active variant (effort) on the right — the composer's single split control.
//   - Left:  a friendly model name (m.name) with a Sparkles icon + dropdown.
//   - Right: the active variant, title-cased, with its own dropdown. The spec
//            has ONE split control, not two pills — the left/right are always
//            both present inside the shared SplitChip shell. `rightAccent`
//            colours the effort side (the screen's one accent element).
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
import { SplitChip } from "./Chip";

export function ModelPicker({
  modelLabel,
  models,
  modelOverride,
  defaultModel,
  deactivatedMainModels,
  onOpen,
  onSelect,
  defaultLabel = null,
  labelOverride = null,
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
  // Welcome-screen helpers for the model button label.
  //   - `defaultLabel` (e.g. "Auto"): shown when NO per-session override is
  //     active (the server default is in effect).
  //   - `labelOverride`: shown unconditionally, highest precedence — lets a
  //     caller display "Auto" until the user first picks a model, even when
  //     the override is seeded from the configured default.
  // Both are no-ops for callers that don't pass them (ChatPanel).
  defaultLabel?: string | null;
  labelOverride?: string | null;
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const [variantOpen, setVariantOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Click-away to dismiss either dropdown. Using mousedown (not click) so we
  // close before an inner button's onClick re-toggles. The hook closes both
  // dropdowns on outside-click or Escape; the SplitChip's toggle buttons are
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

  // Effort visibility/state. The SplitChip is always rendered — the design's
  // one split control must never be absent from the composer row. When the
  // active model exposes no variant list the right segment is simply
  // non-interactive (nothing to select).
  const effortDisabled = variants.length === 0;
  // Label reflects the user's selected variant; with no selectable variants
  // (or no selection yet) it shows the design's default effort value.
  const effortLabel = activeVariant
    ? titleCase(activeVariant.id)
    : variants.length > 0
      ? "Default"
      : "High";

  // Friendly display name for the model button. Falls back through the same
  // precedence as the old label: override → default → last-used → stub.
  // `defaultLabel` (e.g. "Auto", the welcome-screen convention) replaces the
  // resolved name when the server default is active and no override is set;
  // `labelOverride` wins unconditionally (highest precedence).
  const modelDisplayName =
    labelOverride ??
    (modelOverride == null && defaultLabel
      ? defaultLabel
      : activeModel?.name ?? modelLabel ?? "opencode");

  return (
    <div ref={rootRef} className="overflow-visible min-w-0 relative">
      <SplitChip
        left={
          <span className="flex items-center gap-1 truncate">
            <Sparkles size={13} aria-hidden="true" className="shrink-0 text-accent" />
            <span className="truncate max-w-[140px]">{modelDisplayName}</span>
            <ChevronDown size={13} aria-hidden="true" className="shrink-0 text-text-faint" />
          </span>
        }
        right={
          <span className="flex items-center gap-1 truncate">
            <span className="truncate max-w-[80px]">{effortLabel}</span>
            <ChevronDown
              size={13}
              aria-hidden="true"
              className={`shrink-0 ${effortDisabled ? "text-text-quiet" : "text-text-faint"}`}
            />
          </span>
        }
        onLeftClick={() => {
          if (!modelOpen) onOpen();
          setVariantOpen(false);
          setModelOpen((v) => !v);
        }}
        onRightClick={() => {
          if (effortDisabled) return;
          setModelOpen(false);
          setVariantOpen((v) => !v);
        }}
        rightAccent
        popup
        leftTitle="Pick model for next prompt"
        rightTitle={
          effortDisabled
            ? "This model has no effort / variant setting"
            : "Pick effort / variant"
        }
      />

      {/* Model dropdown — provider-grouped list. Selecting a row sets the
          per-session override; the variant is cleared (the new model's own
          variants show up in the effort segment). */}
      {modelOpen && (
        <div className="manta-model-dropdown absolute left-0 bottom-full mb-1 z-20 min-w-[240px] max-h-[360px] overflow-y-auto rounded-xs border border-border bg-bg-elev shadow-md text-meta">
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
              <div className="px-2 py-px text-micro font-semibold uppercase text-text-faint">
                {providerID}
              </div>
              {ms.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    // Selecting a model clears any variant — the new model's
                    // own variants surface in the effort segment.
                    onSelect({ providerID: m.providerID, modelID: m.id });
                    setModelOpen(false);
                  }}
                  className={
                    "w-full text-left px-2 py-px hover:bg-bg-soft flex justify-between gap-2 " +
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

      {/* Variant / effort dropdown — flat list of the active model's variants
          plus a "Default" (no variant) row. */}
      {variantOpen && variants.length > 0 && (
        <div className="manta-effort-dropdown absolute right-0 bottom-full mb-1 z-20 min-w-[160px] rounded-xs border border-border bg-bg-elev shadow-md text-meta">
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
                "w-full text-left px-2 py-px hover:bg-bg-soft " +
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
