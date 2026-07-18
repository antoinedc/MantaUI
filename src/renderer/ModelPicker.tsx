// ===== Model picker =====
//
// Extracted from ChatPanel.tsx (M0.5). Compact dropdown that shows the active
// model on the left (either the user-selected override or the last model used
// by the server). Clicking the label expands an absolutely-positioned list
// above the footer. Selecting a row sets the per-session override (persisted in
// localStorage by ChatPanel); the "Server default" row clears it so
// prompt_async falls back to opencode's default.

import { useEffect, useMemo, useRef, useState } from "react";
import type { OpencodeModel } from "../shared/types";
import { CLAUDE_ORANGE, type ModelSelection } from "./chatShared";
import { formatModelContextSize } from "./chatUtils";

export function ModelPicker({
  modelLabel,
  models,
  modelOverride,
  defaultModel,
  onOpen,
  onSelect,
}: {
  modelLabel: string | null;
  models: OpencodeModel[] | null;
  modelOverride: ModelSelection | null;
  defaultModel: { providerID: string; modelID: string } | null;
  onOpen: () => void;
  onSelect: (m: ModelSelection | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Click-away to dismiss the dropdown. Using mousedown (not click) so we
  // close before the inner button's onClick re-toggles. Buttons inside the
  // popup still fire their onClick because we check containment.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Label precedence — show what will be used for the NEXT prompt, not what
  // the last response happened to use:
  //   1. user-picked override (explicit choice)
  //   2. server default for the first connected provider (when no override —
  //      "Server default" was picked, so we show the actual default name)
  //   3. last assistant message's modelID (fallback while defaultModel still loading)
  //   4. "opencode" stub (initial render, nothing loaded yet)
  const label = modelOverride
    ? `${modelOverride.providerID}/${modelOverride.modelID}${modelOverride.variant ? `@${modelOverride.variant}` : ""}`
    : defaultModel
      ? `${defaultModel.providerID}/${defaultModel.modelID}`
      : modelLabel
        ? modelLabel
        : null;

  // Group models by providerID so the list reads e.g. "anthropic" → 3 models.
  const groups = useMemo(() => {
    if (!models) return null;
    const map = new Map<string, OpencodeModel[]>();
    for (const m of models) {
      if (m.enabled === false || m.status === "deprecated") continue;
      const arr = map.get(m.providerID) ?? [];
      arr.push(m);
      map.set(m.providerID, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [models]);

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

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        className="truncate text-[12px] text-text-muted hover:text-text flex items-center gap-1"
        onClick={() => {
          if (!open) onOpen();
          setOpen((v) => !v);
        }}
        title="Pick model for next prompt"
      >
        <span className="truncate">{label ?? <span className="opacity-60">opencode</span>}</span>
        <span className="text-text-faint text-[9px]">▾</span>
      </button>
      {open && (
        <div
          className="absolute left-0 bottom-full mb-1 z-20 min-w-[240px] max-h-[360px] overflow-y-auto rounded border border-border bg-bg-elev shadow-lg text-[12px]"
        >
          <button
            onClick={() => {
              onSelect(null);
              setOpen(false);
            }}
            className={
              "w-full text-left px-2 py-1 hover:bg-bg-soft border-b border-border " +
              (modelOverride == null ? "text-text" : "text-text-muted")
            }
          >
            <span className="mr-1" style={{ color: modelOverride == null ? CLAUDE_ORANGE : "transparent" }}>●</span>
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
              <div className="px-2 py-0.5 text-[10px] uppercase tracking-wider text-text-faint">
                {providerID}
              </div>
              {ms.map((m) => {
                const variants = m.variants ?? [];
                return (
                  <div key={m.id}>
                    <button
                      onClick={() => {
                        onSelect({ providerID: m.providerID, modelID: m.id });
                        setOpen(false);
                      }}
                      className={
                        "w-full text-left px-2 py-0.5 hover:bg-bg-soft flex justify-between gap-2 " +
                        (isActive(m) ? "text-text" : "text-text-muted")
                      }
                    >
                      <span className="truncate flex items-center gap-1">
                        <span style={{ color: isActive(m) ? CLAUDE_ORANGE : "transparent" }}>●</span>
                        <span>{m.name}</span>
                      </span>
                      {formatModelContextSize(m.limit?.context) ? (
                        <span className="text-text-faint text-[10px] shrink-0">
                          {formatModelContextSize(m.limit?.context)}
                        </span>
                      ) : null}
                    </button>
                    {variants.map((v) => (
                      <button
                        key={v.id}
                        onClick={() => {
                          onSelect({ providerID: m.providerID, modelID: m.id, variant: v.id });
                          setOpen(false);
                        }}
                        className={
                          "w-full text-left pl-6 pr-2 py-0.5 hover:bg-bg-soft text-[11px] " +
                          (isActive(m, v.id) ? "text-text" : "text-text-faint")
                        }
                      >
                        <span style={{ color: isActive(m, v.id) ? CLAUDE_ORANGE : "transparent" }}>●</span>{" "}
                        @{v.id}
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
