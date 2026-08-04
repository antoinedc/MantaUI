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
import { ChevronDown, Sparkles, Zap } from "lucide-react";
import type { OpencodeModel } from "../shared/types";
import { type ModelSelection, resolveActiveModel } from "./chatShared";
import { hideFastSiblingGroups, resolveFastToggle, titleCase } from "./chatUtils";
import { useClickAway } from "./hooks/useClickAway";
import { SplitChip } from "./Chip";
import { EffortMenu } from "./EffortMenu";
import { ModelMenu } from "./ModelMenu";

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

  // The models a user may actually switch TO: enabled, not deprecated, not
  // deactivated in Settings. Both the dropdown and the ⚡ toggle read from this
  // one set, so a model hidden in Settings can't be reached by either route.
  // (`activeModel` below deliberately resolves against the FULL list — an
  // already-selected model must keep displaying its own name even if it was
  // later deactivated.)
  const selectableModels = useMemo(() => {
    if (!models) return null;
    const deactivatedMain = new Set(deactivatedMainModels ?? []);
    return models.filter(
      (m) =>
        m.enabled !== false &&
        m.status !== "deprecated" &&
        !deactivatedMain.has(`${m.providerID}/${m.id}`),
    );
  }, [models, deactivatedMainModels]);

  // Group models by providerID so the list reads e.g. "anthropic" → 3 models.
  const groups = useMemo(() => {
    if (!selectableModels) return null;
    const map = new Map<string, OpencodeModel[]>();
    for (const m of selectableModels) {
      const arr = map.get(m.providerID) ?? [];
      arr.push(m);
      map.set(m.providerID, arr);
    }
    const sorted = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
    // "Fast" flavours (`<id>-fast`) are a MODE of their base model, not a
    // separate choice — they're reached through the ⚡ segment below, so they
    // don't get a row here. `hideFastSiblingGroups` keeps an orphan whose base
    // is missing/deactivated, which would otherwise become unreachable.
    return hideFastSiblingGroups(sorted);
  }, [selectableModels]);

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

  // ⚡ fast-mode toggle — the third segment. Flipping it swaps the active model
  // for its `-fast` twin (or back), carrying the selected effort across. It is
  // disabled when there is no twin, or when the twin doesn't offer the current
  // effort, so the toggle can never silently change the user's effort choice.
  const fast = useMemo(
    () => resolveFastToggle(selectableModels, activeModel, activeVariantId),
    [selectableModels, activeModel, activeVariantId],
  );

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
        extra={<Zap size={13} aria-hidden="true" fill={fast.on ? "currentColor" : "none"} />}
        onExtraClick={() => {
          if (!fast.available || !fast.target) return;
          setModelOpen(false);
          setVariantOpen(false);
          onSelect(fast.target);
        }}
        extraTitle={fast.title}
        extraLabel="Fast mode"
        extraHook="manta-fast-toggle-btn"
        extraPressed={fast.on}
        extraDisabled={!fast.available}
        rightAccent
        popup
        leftHook="manta-model-picker-btn"
        rightHook="manta-effort-picker-btn"
        leftExpanded={modelOpen}
        rightExpanded={variantOpen}
        leftTitle="Pick model for next prompt"
        rightTitle={
          effortDisabled
            ? "This model has no effort / variant setting"
            : "Pick effort / variant"
        }
      />

      {/* Model dropdown — renders through the specced Dropdown + MenuOption
          surface (ModelMenu: search strip, pinned server-default header,
          provider-grouped body). Selecting a row sets the per-session
          override; the variant is cleared on model change. */}
      {modelOpen && (
        <ModelMenu
          groups={groups}
          modelOverride={modelOverride}
          defaultModel={defaultModel}
          onSelect={onSelect}
          onClose={() => setModelOpen(false)}
        />
      )}

      {/* Variant / effort dropdown — flat list of the active model's variants
          plus a "Default" (no variant) row, via EffortMenu. */}
      {variantOpen && variants.length > 0 && (
        <EffortMenu
          variants={variants}
          activeModel={activeModel}
          activeVariantId={activeVariantId}
          onSelect={onSelect}
          onClose={() => setVariantOpen(false)}
        />
      )}
    </div>
  );
}
