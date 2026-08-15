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
import { ChevronDown, Sparkles, Zap, ZapOff } from "lucide-react";
import type { OpencodeModel } from "../shared/types";
import { type ModelSelection, resolveActiveModel } from "./chatShared";
import { selectableModelGroups, selectableModelList, resolveFastToggle, titleCase } from "./chatUtils";
import { SplitChip } from "./Chip";
import { EffortMenu } from "./EffortMenu";
import { ModelMenu } from "./ModelMenu";

const LOADING_TITLE = "Loading models…";

/**
 * A placeholder bar sized to the label it stands in for, so the chip doesn't
 * jump when the real text arrives. `bg-border` is the one neutral token with an
 * alpha channel; `animate-pulse` is already covered by the global
 * prefers-reduced-motion guard in index.css.
 */
function SkeletonBar({ width }: { width: number }) {
  return (
    <span
      className="inline-block h-[9px] rounded-full bg-border animate-pulse"
      style={{ width }}
      aria-hidden="true"
    />
  );
}

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
  // The two dropdowns each anchor to their OWN segment button (the model and
  // the effort trigger). Each is an independent Popover — clicking one segment
  // while the other's menu is open closes the other (BET-865's accepted
  // behaviour: the old shared-root click-away coupling is gone).
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const effortBtnRef = useRef<HTMLButtonElement>(null);

  // The models a user may actually switch TO: enabled, not deprecated, not
  // deactivated in Settings. Both the dropdown and the ⚡ toggle read from the
  // same chatUtils source of truth (the enabled/status/deactivated gate lives
  // there and nowhere else), so a model hidden in Settings can't be reached by
  // either route.
  // (`activeModel` below deliberately resolves against the FULL list — an
  // already-selected model must keep displaying its own name even if it was
  // later deactivated.)
  const selectableModels = useMemo(
    () => selectableModelList(models, deactivatedMainModels),
    [models, deactivatedMainModels],
  );

  // The dropdown's candidate set: selectable models grouped by provider,
  // sorted, with `-fast` siblings folded into their base (they're reached
  // through the ⚡ segment). Shared with the delegate model picker.
  const groups = useMemo(
    () => selectableModelGroups(models, deactivatedMainModels),
    [models, deactivatedMainModels],
  );

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

  // The catalog hasn't landed yet. `models === null` is the ONLY loading signal
  // (useModelCatalog keeps no separate flag), and all three segments describe
  // the same unresolved subject, so they go into placeholder together.
  //
  // This branch exists because the fallbacks below are not neutral — they are
  // confident and WRONG while the list is in flight: the left segment settles
  // on the "opencode" stub, `effortLabel` hard-codes "High", and
  // `resolveFastToggle` returns unavailable, i.e. the chip claims this model has
  // no fast twin. A user reading that gets three facts about a model nobody has
  // resolved. Placeholder bars say "not yet" instead.
  const loading = models === null;

  return (
    <div className="overflow-visible min-w-0">
      <SplitChip
        loading={loading}
        leftBtnRef={modelBtnRef}
        rightBtnRef={effortBtnRef}
        left={
          loading ? (
            <span className="flex items-center gap-1">
              <Sparkles size={13} aria-hidden="true" className="shrink-0 text-text-quiet" />
              <SkeletonBar width={76} />
              <ChevronDown size={13} aria-hidden="true" className="shrink-0 text-text-quiet" />
            </span>
          ) : (
            <span className="flex items-center gap-1 truncate">
              <Sparkles size={13} aria-hidden="true" className="shrink-0 text-accent" />
              <span className="truncate max-w-[140px]">{modelDisplayName}</span>
              <ChevronDown size={13} aria-hidden="true" className="shrink-0 text-text-faint" />
            </span>
          )
        }
        right={
          loading ? (
            <span className="flex items-center gap-1">
              <SkeletonBar width={30} />
              <ChevronDown size={13} aria-hidden="true" className="shrink-0 text-text-quiet" />
            </span>
          ) : (
            <span className="flex items-center gap-1 truncate">
              <span className="truncate max-w-[80px]">{effortLabel}</span>
              <ChevronDown
                size={13}
                aria-hidden="true"
                className={`shrink-0 ${effortDisabled ? "text-text-quiet" : "text-text-faint"}`}
              />
            </span>
          )
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
        // Three states, three glyphs — "unavailable" gets its OWN icon rather
        // than a dimmer copy of the "off" one. A greyed Zap is indistinguishable
        // from an un-toggled Zap at 13px, which is why this model has no fast
        // twin / no fast twin at this effort read as "fast mode is simply off"
        // and people kept clicking a dead segment. ZapOff says unavailable;
        // hollow Zap says available-but-off; filled Zap says on. (`fast.on`
        // wins over availability so an on-but-frozen toggle still shows as on.)
        extra={
          loading ? (
            // A neutral 13px block, not a dimmed Zap/ZapOff: either glyph would
            // state an availability we don't know yet, which is the whole point
            // of the loading branch.
            <span
              className="w-[13px] h-[13px] rounded-sm bg-border animate-pulse"
              aria-hidden="true"
            />
          ) : fast.on ? (
            <Zap size={13} aria-hidden="true" fill="currentColor" />
          ) : fast.available ? (
            <Zap size={13} aria-hidden="true" fill="none" />
          ) : (
            <ZapOff size={13} aria-hidden="true" />
          )
        }
        onExtraClick={() => {
          if (!fast.available || !fast.target) return;
          setModelOpen(false);
          setVariantOpen(false);
          onSelect(fast.target);
        }}
        extraTitle={loading ? LOADING_TITLE : fast.title}
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
        leftTitle={loading ? LOADING_TITLE : "Pick model for next prompt"}
        rightTitle={
          loading
            ? LOADING_TITLE
            : effortDisabled
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
          open={modelOpen}
          anchorRef={modelBtnRef}
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
          open={variantOpen}
          anchorRef={effortBtnRef}
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
