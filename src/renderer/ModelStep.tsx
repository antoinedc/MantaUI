import { useCallback, useEffect, useState } from "react";
import type { OpencodeModel } from "../shared/types";
import { canContinueModel, formatContextWindow, selectableModels } from "./providersStepLogic";
import { useStore } from "./store";

// ModelStep.tsx — Step 3 (Default model) of the desktop onboarding shell
// (BET-49-T4). Mounts into Onboarding.tsx's step-3 slot.
//
// A radio list of every model from a connected provider (window.api
// .opencodeModels() — the /provider-backed, connected-only list; NEVER
// /api/model). Each row: model id (mono) + provider + context window, matching
// docs/onboarding/mockup.html (no capability badges).
//
// The selection persists to AppConfig.defaultModel via the EXISTING config
// mechanism (window.api.configUpdate + store.applyConfig) — the same field
// Settings writes, and the one new/cleared chat sessions already inherit. We
// persist on "Continue" (not per-click) so a mis-tap doesn't rewrite config,
// then advance.
//
// Owns its own footer (Back + Continue) — like PairStep/ProvidersStep — because
// Continue is gated on a selection (canContinueModel) AND must run an async
// persist before advancing, which the shell's generic goNext can't express.
//
// Pure decisions (selectable set, the gate, context formatting) live in
// providersStepLogic.ts (unit-tested).

const ACCENT = "#7c9cff";
const DANGER = "#f87171";

export function ModelStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [models, setModels] = useState<OpencodeModel[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Prefill from any already-chosen default (resume / back-navigation).
  const [selected, setSelected] = useState<{ providerID: string; modelID: string } | null>(
    () => useStore.getState().defaultModel,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.api
      .opencodeModels()
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        setLoadError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setModels([]);
        setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const options = selectableModels(models);
  const canContinue = canContinueModel(selected) && !saving;

  const persistAndNext = useCallback(async () => {
    if (!canContinueModel(selected) || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Reuse the canonical config write + store reconcile (same path Settings
      // uses); new/cleared sessions inherit AppConfig.defaultModel automatically.
      const next = await window.api.configUpdate({ defaultModel: selected ?? undefined });
      useStore.getState().applyConfig(next);
      onNext();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [selected, saving, onNext]);

  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight text-text mb-1.5">
        Pick your default model
      </h2>
      <p className="text-sm text-text-muted leading-relaxed mb-8 max-w-md">
        This model will power your new chat sessions. You can switch anytime.
      </p>

      {loadError && (
        <div role="alert" className="text-sm mb-4" style={{ color: DANGER }}>
          Couldn't load models: {loadError}
        </div>
      )}

      {models === null ? (
        <div className="text-sm text-text-faint">Loading models…</div>
      ) : options.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-bg-soft p-6 text-sm text-text-muted">
          No connected models yet. Go back and connect a provider first.
        </div>
      ) : (
        <div
          role="radiogroup"
          aria-label="Default model"
          className="flex flex-col gap-2 max-h-[360px] overflow-y-auto pr-1"
        >
          {options.map((m) => {
            const isSel = selected?.providerID === m.providerID && selected?.modelID === m.id;
            const ctx = formatContextWindow(m.limit?.context);
            return (
              <button
                key={`${m.providerID}::${m.id}`}
                type="button"
                role="radio"
                aria-checked={isSel}
                onClick={() => setSelected({ providerID: m.providerID, modelID: m.id })}
                className="flex items-center gap-3 text-left rounded-lg border p-3 transition-colors"
                style={{
                  borderColor: isSel ? ACCENT : "#262932",
                  background: isSel ? "rgba(124,156,255,0.08)" : "transparent",
                }}
              >
                <span
                  className="w-4 h-4 rounded-full border shrink-0 flex items-center justify-center"
                  style={{ borderColor: isSel ? ACCENT : "#3a3f4b" }}
                >
                  {isSel && (
                    <span className="w-2 h-2 rounded-full" style={{ background: ACCENT }} />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block font-mono text-sm text-text truncate">{m.id}</span>
                  <span className="flex items-center gap-2 text-xs text-text-muted mt-0.5">
                    <span>{m.providerID}</span>
                    {ctx && (
                      <>
                        <span
                          className="inline-block w-1 h-1 rounded-full"
                          style={{ background: "#3a3f4b" }}
                        />
                        <span>{ctx}</span>
                      </>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {saveError && (
        <div role="alert" className="text-sm mt-4" style={{ color: DANGER }}>
          Couldn't save your choice: {saveError}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 mt-8">
        <button
          onClick={onBack}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-md text-sm text-text-muted hover:text-text transition-colors disabled:opacity-60"
        >
          <BackArrow />
          Back
        </button>
        <button
          onClick={() => void persistAndNext()}
          disabled={!canContinue}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md text-sm font-medium text-bg transition-opacity disabled:opacity-40"
          style={{ background: ACCENT }}
        >
          {saving ? "Saving…" : "Continue"}
          <FwdArrow />
        </button>
      </div>
    </div>
  );
}

function BackArrow() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function FwdArrow() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}
