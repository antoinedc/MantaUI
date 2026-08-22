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
import { selectableModelList, resolveFastToggle, mainPickerGroups, titleCase } from "./chatUtils";
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
  optInModels,
  onOptInModel,
  onOpen,
  onSelect,
  labelOverride = null,
  // BET-1247: when the session's model choice is `auto` (the three-state
  // choice BET-1245), the chip MUST say so and, once the router has resolved a
  // model (a turn has run and `modelOverride` carries the routed pick), which
  // model Auto chose. Until a model is resolved there is nothing to claim.
  auto = false,
  // BET-1248: the latest boundary-routing reason — forwarded to ModelMenu's
  // Auto row sub-line once a decision has resolved.
  autoReason = null,
  // BET-1248: the user re-picking Auto — when provided the ModelMenu's Auto
  // row is rendered (a control can NEVER be present without a handler).
  onSelectAuto,
  // BET-1222: when the router chose this session's model, the composer pill
  // explains WHY (reason) and offers one-click undo to the incumbent model.
  // `routed` is pure display state; the undo action itself (set override back
  // to the incumbent, clear the routed state, surface failures) is supplied by
  // the caller via `onRoutedUndone` so it routes through the SAME error/toast
  // mechanism the picker's own selects use — no second persistence path.
  routed = null,
  onRoutedUndone,
  // BET-1274 10c: effort (variant) + the ⚡ fast toggle call THIS, not
  // `onSelect` — writing a variant never changes the ModelChoice kind and
  // never turns Auto off.
  onSelectEffort,
  // BET-1274 10d: the routing preset's display label ("Balanced"), threaded to
  // the Auto row's sub-line so Auto can name the user's balance setting.
  presetLabel,
}: {
  modelLabel: string | null;
  models: OpencodeModel[] | null;
  modelOverride: ModelSelection | null;
  defaultModel: { providerID: string; modelID: string } | null;
  // BET-215: "providerID/modelID" strings; models in this set are hidden
  // from the picker. Filter lives in the same `groups` chokepoint as the
  // existing enabled/status gate. Default [] = no Main filtering.
  deactivatedMainModels?: string[];
  // BET-1139: "providerID/modelID" strings of deprecated models the user has
  // explicitly opted back in to. Empty/absent = every deprecated model shows
  // disabled. Shared with the subagent path and the store's `optInModels`.
  optInModels?: string[];
  // Persist an opt-in (BET-1139) — flips a deprecated model's disabled row to
  // a normal selectable one.
  onOptInModel?: (key: string) => void;
  onOpen: () => void;
  onSelect: (m: ModelSelection | null) => void;
  // BET-1274 10c: kind-preserving effort/fast selection (see above).
  onSelectEffort: (m: ModelSelection) => void;
  // BET-1274 10d: the routing preset's display label for the Auto row.
  presetLabel?: string;
  // Welcome-screen helper for the model button label: shown unconditionally,
  // highest precedence — lets a caller display "Auto" until the user first
  // picks a model. A no-op for callers that don't pass it (ChatPanel).
  labelOverride?: string | null;
  // BET-1247: session model choice is `auto` (see above).
  auto?: boolean;
  // BET-1248: the latest boundary-routing reason for the Auto row.
  autoReason?: string | null;
  // BET-1248: the user re-picking Auto (render the Auto row).
  onSelectAuto?: () => void;
  // BET-1222/BET-1274 routed state (see above). `incumbent` null = a first turn
  // with nothing to undo (the pill renders the reason only).
  routed?: {
    reason: string;
    incumbent: { providerID: string; modelID: string } | null;
  } | null;
  onRoutedUndone?: () => void;
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

  // The dropdown's candidate set: models grouped by provider, sorted, with
  // `-fast` siblings folded into their base (they're reached through the ⚡
  // segment). BET-1139: unlike the selectable set, deprecated models are KEPT
  // in the list (visible + importable) but flagged disabled unless opted in
  // (`disabledKeys`) — the user must be able to see and opt in to a model the
  // provider is deprecating.
  const picker = useMemo(
    () => mainPickerGroups(models, deactivatedMainModels, optInModels),
    [models, deactivatedMainModels, optInModels],
  );

  // Resolve the active model object (for the friendly name + variant list).
  // Shared resolution path with ChatPanel (BET-415 duplication gate).
  // Under Auto, the resolved model is the one the router CHOSE (it is applied
  // to `modelOverride` the moment a turn runs), never the server default —
  // falling back to the default would claim "Auto · <default>" for a model Auto
  // had not actually picked. So under Auto we resolve from the override only.
  const activeModel = useMemo<OpencodeModel | null>(
    () =>
      auto
        ? resolveActiveModel(models, modelOverride, null)
        : resolveActiveModel(models, modelOverride, defaultModel),
    [models, modelOverride, defaultModel, auto],
  );

  const variants = activeModel?.variants ?? [];
  const activeVariantId = modelOverride?.variant ?? undefined;
  const activeVariant = variants.find((v) => v.id === activeVariantId) ?? null;

  // Effort visibility/state. The SplitChip is always rendered — the design's
  // one split control must never be absent from the composer row. When the
  // active model exposes no variant list the right segment is simply
  // non-interactive (nothing to select).
  const effortDisabled = variants.length === 0;
  // BET-1274 10g: no resolved model yet (catalog in flight, OR Auto before its
  // first turn resolved a model) ⇒ the right segment must not claim a value.
  // "High" is the design's default only for a RESOLVED model that has no
  // variant list; with no model at all the effort side says "not yet", reusing
  // the loading treatment rather than inventing a third state.
  const rightUnresolved = models === null || activeModel === null;
  // Label reflects the user's selected variant; with no selectable variants
  // (or no selection yet) it shows the design's default effort value.
  const effortLabel = activeVariant
    ? titleCase(activeVariant.id)
    : variants.length > 0
      ? "Default"
      : "High";

  // Friendly display name for the model button: the caller's labelOverride
  // (highest precedence), else the resolved active model name, else the
  // modelLabel prop, else the "opencode" stub.
  // Under Auto this is replaced entirely: "Auto" until the router has resolved
  // a model, then "Auto · <model>" so the chip never hides who is answering.
  const modelDisplayName = auto
    ? activeModel
      ? `Auto · ${activeModel.name}`
      : "Auto"
    : labelOverride ?? activeModel?.name ?? modelLabel ?? "opencode";

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

  // Native title on the left segment. Under Auto with a resolved model, name
  // the full resolved model + provider so hovering answers "what exactly is
  // this". Otherwise today's copy stands.
  const leftTitle = loading
    ? LOADING_TITLE
    : auto && activeModel
      ? `Auto · ${activeModel.name} (${activeModel.providerID})`
      : "Pick model for next prompt";

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
              <span className="truncate max-w-[140px]">
                {routed ? "◆ " : ""}
                {modelDisplayName}
                {routed ? " · routed" : ""}
              </span>
              <ChevronDown size={13} aria-hidden="true" className="shrink-0 text-text-faint" />
            </span>
          )
        }
        right={
          rightUnresolved ? (
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
          onSelectEffort(fast.target);
        }}
        extraTitle={loading ? LOADING_TITLE : fast.title}
        extraLabel="Fast mode"
        extraHook="manta-fast-toggle-btn"
        extraPressed={fast.on}
        extraDisabled={!fast.available}
        rightAccent
        leftAccent={Boolean(routed) || auto}
        popup
        leftHook="manta-model-picker-btn"
        rightHook="manta-effort-picker-btn"
        leftExpanded={modelOpen}
        rightExpanded={variantOpen}
        leftTitle={leftTitle}
        rightTitle={
          rightUnresolved
            ? LOADING_TITLE
            : effortDisabled
              ? "This model has no effort / variant setting"
              : "Pick effort / variant"
        }
      />

      {/* Routed pill — the honesty mechanism (BET-1222). When the router set
          this session's model, show WHY and, when there is a model it moved
          away from, a one-click undo back to it. The reason renders whenever
          `routed` is set (including a first turn with no incumbent — nothing
          to undo, so no undo action); the undo button renders only when an
          incumbent exists (BET-1274 10e). */}
      {routed && !loading && (
        <span className="flex items-center gap-2 flex-wrap">
          <span className="text-meta text-text-faint">{routed.reason}</span>
          {routed.incumbent && (
            <button
              type="button"
              onClick={onRoutedUndone}
              className="font-mono text-meta rounded-full border border-border bg-raised px-3 py-1 text-text-muted hover:bg-fill-hover"
            >
              undo · keep {routed.incumbent.providerID}/{routed.incumbent.modelID} here
            </button>
          )}
        </span>
      )}

      {/* Model dropdown — renders through the specced Dropdown + MenuOption
          surface (ModelMenu: search strip, pinned server-default header,
          provider-grouped body). Selecting a row sets the per-session
          override; the variant is cleared on model change. */}
      {modelOpen && (
        <ModelMenu
          open={modelOpen}
          anchorRef={modelBtnRef}
          groups={picker.groups}
          disabledKeys={picker.disabledKeys}
          onEnableDeprecated={onOptInModel}
          modelOverride={modelOverride}
          defaultModel={defaultModel}
          onSelect={onSelect}
          onClose={() => setModelOpen(false)}
          autoActive={auto}
          onSelectAuto={onSelectAuto}
          autoReason={autoReason ?? undefined}
          presetLabel={presetLabel}
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
          onSelect={onSelectEffort}
          onClose={() => setVariantOpen(false)}
        />
      )}
    </div>
  );
}
