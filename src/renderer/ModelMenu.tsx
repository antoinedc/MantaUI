// BET-644 — the model listbox: the first adopter of both the specced
// `Dropdown` menu surface (with its fixed search strip + pinned server-default
// header) and the `MenuOption` row. Split out of ModelPicker so MenuOption
// has two genuinely distinct adopting files (this menu and the effort menu) —
// they differ in width, density and behaviour, and the file split is what
// makes the two-adopter enforce test tell the truth.
//
// The search strip is client-side over the already-in-memory `groups`; the
// keyboard roving highlight (↑/↓/Enter/Esc) and the filter live in
// chatUtils.ts as pure functions so the arithmetic is testable.

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Sliders } from "lucide-react";
import type { OpencodeModel } from "../shared/types";
import { type ModelSelection, resolveActiveModel } from "./chatShared";
import { Dropdown } from "./MenuItem";
import { MenuOption } from "./MenuOption";
import { Tag } from "./Tag";
import type { RefObject } from "react";
import {
  filterModelGroups,
  formatModelContextSize,
  moveMenuHighlight,
} from "./chatUtils";

export function ModelMenu({
  groups,
  modelOverride,
  defaultModel,
  onSelect,
  onClose,
  open,
  anchorRef,
  defaultRow,
  disabledKeys,
  onEnableDeprecated,
  // BET-1246 — the three-state Auto row (BET-1245's `{ kind: "auto" }` choice).
  autoActive = false,
  onSelectAuto,
  presetLabel,
  autoReason,
}: {
  groups: Array<[string, OpencodeModel[]]> | null;
  modelOverride: ModelSelection | null;
  defaultModel: { providerID: string; modelID: string } | null;
  onSelect: (m: ModelSelection | null) => void;
  onClose: () => void;
  open: boolean;
  anchorRef: RefObject<HTMLElement>;
  /**
   * BET-1246: true when this session's three-state choice is `{ kind: "auto" }`
   * (BET-1245) — the Auto pinned row renders selected and the Server-default row
   * (and every model row) renders unselected. Mutually exclusive with a model
   * override by construction.
   */
  autoActive?: boolean;
  /**
   * BET-1246: called when the user chooses the Auto row. When this is OMITTED
   * the Auto row is NOT rendered at all (so a control can never render dead —
   * see the "NEVER STUB A CONTROL" rule). The delegate model picker (Cards.tsx)
   * omits it: auto-routing is a MAIN-conversation concept, so that surface keeps
   * today's single pinned Server-default row.
   */
  onSelectAuto?: () => void;
  /**
   * BET-1246: the active routing preset's display label (e.g. "Balanced"),
   * shown in the Auto row's sub-line when Auto is active.
   */
  presetLabel?: string;
  /**
   * BET-1246: the routing decision's human-readable reason (what `routing:choose`
   * / `routing:main` returned). Shown in the Auto row's sub-line when Auto is
   * active and a decision exists.
   */
  autoReason?: string;
  /**
   * Copy override for the pinned top (server-default) row ONLY — the row that
   * means "no override". A second consumer (the delegate model picker) needs
   * it to mean "inherit this session's build model" rather than "set in
   * Settings". Omitted → today's exact strings ("Server default" /
   * "<model> · set in Settings" / "opencode decides").
   */
  defaultRow?: { label?: string; sub?: string };
  /**
   * BET-1139: "providerID/modelID" keys that are shown in the list but
   * rendered GREYED/disabled — a deprecated model the user hasn't opted in to.
   * These rows are NOT in the roving-highlight / selectable option set.
   * Omitted or empty = every row is selectable (today's behaviour).
   */
  disabledKeys?: string[];
  /** BET-1139: called with a disabled row's key when the user clicks its
   *  "Enable deprecated" action. Persists the opt-in; the row then becomes a
   *  normal selectable model. */
  onEnableDeprecated?: (key: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  // BET-1139: deprecated rows shown but not selectable — greyed and kept OUT
  // of the roving-highlight option set.
  const disabledSet = useMemo(() => new Set(disabledKeys ?? []), [disabledKeys]);

  // Focus the search input as soon as the menu mounts (it opens on open).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // The server-default row is pinned ABOVE the scroll area and never scrolls
  // away. Resolve the model the server default actually points at so its
  // sub-line names it (the same resolution the trigger label uses).
  const allModels = useMemo(() => groups?.flatMap(([, ms]) => ms) ?? [], [groups]);
  const serverModel = useMemo(
    () => resolveActiveModel(allModels, null, defaultModel),
    [allModels, defaultModel],
  );
  const serverSub = serverModel
    ? `${serverModel.name} · set in Settings`
    : "opencode decides";
  // BET-1246: the Server-default row is selected only when Auto is NOT active
  // and no model override is set — the three states are mutually exclusive.
  const serverSelected = !autoActive && modelOverride == null;
  // `defaultRow` overrides ONLY this pinned row's label/sub — the copy that
  // signals "no override". Omitted, today's exact strings stand.
  const defaultLabel = defaultRow?.label ?? "Server default";
  const defaultSub = defaultRow?.sub ?? serverSub;

  // BET-1246: the Auto row is the first pinned row, above Server default. It is
  // present only in the composer (caller supplied `onSelectAuto`) and never in
  // the delegate model picker (which omits it — auto-routing is a main
  // concept). The sub-line is a single composed string from what is known:
  //   - Auto active + a decision  → `${presetLabel} · ${autoReason}`
  //   - Auto active, no decision  → `${presetLabel} · chooses when the turn starts`
  //   - Auto not active           → static "Chooses a model per task…"
  // The reason text is what the caller supplied (what `routing:choose` returned);
  // the renderer never composes that sentence itself.
  const showAuto = typeof onSelectAuto === "function";
  const autoSelected = Boolean(autoActive);
  const autoSub = !autoSelected
    ? "Chooses a model per task, never mid-turn"
    : autoReason
      ? `${presetLabel ?? "Auto"} · ${autoReason}`
      : `${presetLabel ?? "Auto"} · chooses when the turn starts`;

  const filtered = useMemo(
    () => (groups == null ? null : filterModelGroups(groups, query)),
    [groups, query],
  );
  const visibleModels = useMemo(
    () => filtered?.flatMap(([, ms]) => ms) ?? [],
    [filtered],
  );

  const isActive = (m: OpencodeModel): boolean => {
    if (!modelOverride) return false;
    return (
      modelOverride.providerID === m.providerID &&
      modelOverride.modelID === m.id
    );
  };

  // The flattened option list the roving highlight indexes over: the Auto row
  // (index 0, when present) then the server-default row, then every visible
  // model row, in group order. Adding Auto as the first entry shifts every
  // model row's index by one; the `moveMenuHighlight` arithmetic and the
  // `optionIndexById` lookup below handle the shift unchanged.
  const flatOptions: Array<{ id: string; select: () => void }> = [];
  if (showAuto) {
    flatOptions.push({
      id: "auto",
      select: () => { onSelectAuto!(); onClose(); },
    });
  }
  flatOptions.push({
    id: "server-default",
    select: () => { onSelect(null); onClose(); },
  });
  for (const [, ms] of filtered ?? []) {
    for (const m of ms) {
      const id = `${m.providerID}/${m.id}`;
      if (disabledSet.has(id)) continue; // deprecated, not opted in — not selectable
      flatOptions.push({
        id,
        select: () => {
          onSelect({ providerID: m.providerID, modelID: m.id });
          onClose();
        },
      });
    }
  }
  const optionIndexById = new Map<string, number>();
  flatOptions.forEach((o, i) => optionIndexById.set(o.id, i));
  const highlightedId =
    highlight >= 0 && highlight < flatOptions.length
      ? flatOptions[highlight].id
      : undefined;

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => moveMenuHighlight(h, 1, flatOptions.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => moveMenuHighlight(h, -1, flatOptions.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlight >= 0 && highlight < flatOptions.length) {
        flatOptions[highlight].select();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const body =
    groups === null ? (
      <div className="px-2 py-2 text-text-faint">Loading…</div>
    ) : visibleModels.length === 0 && query.trim() !== "" ? (
      <div className="px-2 py-2 text-text-faint">No models match</div>
    ) : (filtered ?? []).length === 0 ? (
      <div className="px-2 py-2 text-text-faint">No models</div>
    ) : (
      (filtered ?? []).map(([providerID, ms]) => (
        <div key={providerID}>
          <div className="text-micro font-semibold uppercase text-text-faint px-2 pt-3 pb-2 first:pt-1">
            {providerID}
          </div>
          {ms.map((m) => {
            const ctx = formatModelContextSize(m.limit?.context);
            const id = `${m.providerID}/${m.id}`;
            const active = isActive(m);
            // BET-1139: a deprecated model the user hasn't opted in to renders
            // as a disabled row — greyed, outside the roving-highlight option
            // set, with a small "Enable deprecated" action. Kept intentionally
            // minimal (the issue's ask): no fancy component.
            if (disabledSet.has(id)) {
              return (
                <div
                  key={m.id}
                  className="flex w-full items-center gap-3 min-h-[34px] px-2 rounded-md text-left"
                  aria-disabled="true"
                >
                  <span aria-hidden="true" className="w-4 flex-none" />
                  <span className="flex-1 min-w-0 text-left">
                    <span className="block truncate text-label font-medium text-text-faint/70">
                      {m.name}
                    </span>
                  </span>
                  <Tag numeric>deprecated</Tag>
                  {onEnableDeprecated && (
                    <button
                      type="button"
                      onClick={() => onEnableDeprecated(id)}
                      className="flex-none text-meta text-text-faint hover:text-accent hover:underline"
                      title={`Enable ${m.name} despite deprecation`}
                    >
                      Enable deprecated
                    </button>
                  )}
                </div>
              );
            }
            return (
              <MenuOption
                key={m.id}
                id={id}
                selected={active}
                active={highlight === optionIndexById.get(id)}
                label={m.name}
                trailing={
                  ctx ? (
                    <Tag numeric tone={active ? "accent" : undefined}>
                      {ctx}
                    </Tag>
                  ) : undefined
                }
                onSelect={() => {
                  onSelect({ providerID: m.providerID, modelID: m.id });
                  onClose();
                }}
              />
            );
          })}
        </div>
      ))
    );

  return (
    <Dropdown
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      hook="manta-model-dropdown"
      role="listbox"
      placement="above"
      align="start"
      width="wide"
      search={
        <>
          <Search size={14} aria-hidden="true" className="flex-none text-text-faint" />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search models"
            aria-label="Search models"
            aria-activedescendant={highlightedId ?? undefined}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(-1);
            }}
            onKeyDown={onSearchKeyDown}
            className="flex-1 min-w-0 bg-transparent border-none outline-none text-label text-text placeholder:text-text-faint"
          />
          <kbd className="flex-none font-sans text-meta text-text-faint select-none" aria-hidden="true">
            esc
          </kbd>
        </>
      }
      header={
        <>
          {showAuto && (
            <MenuOption
              id="auto"
              selected={autoSelected}
              active={highlight === optionIndexById.get("auto")}
              label="Auto — Manta picks per task"
              sub={autoSub}
              trailing={
                <Tag numeric tone={autoSelected ? "accent" : "default"}>
                  auto
                </Tag>
              }
              onSelect={() => {
                onSelectAuto!();
                onClose();
              }}
            />
          )}
          <MenuOption
            id="server-default"
            selected={serverSelected}
            active={highlight === optionIndexById.get("server-default")}
            label={defaultLabel}
            sub={defaultSub}
            onSelect={() => {
              onSelect(null);
              onClose();
            }}
          />
        </>
      }
      footer={
        // BET-645 — deactivating a model lives in Settings → Models; the model
        // menu is exactly where you realise you want it. A plain footer action
        // (not a MenuOption — not selectable, no tick/trailing slot). Kept
        // local to this file: one call site, which does not clear the
        // two-adopter rule for promoting it to a primitive (standing decision 2).
        <button
          type="button"
          onClick={() => {
            window.dispatchEvent(
              new CustomEvent("manta-open-settings", { detail: { section: "models" } }),
            );
            onClose();
          }}
          className="inline-flex w-full items-center gap-[7px] rounded-md px-2 py-2 text-left text-meta text-text-faint hover:bg-fill-hover hover:text-text"
        >
          <Sliders size={14} aria-hidden="true" className="flex-none" />
          <span>Manage models…</span>
        </button>
      }
    >
      {body}
    </Dropdown>
  );
}
