import { useEffect, useState } from "react";
import type { OpencodeModel } from "../shared/types";
import { useStore } from "./store";
import {
  canContinueModel,
  formatContextWindow,
  modelDisplayName,
  sortModelsForPicker,
} from "./providersStepLogic";
import { StepFooter } from "./onboardingUi";

// ModelStep.tsx — Step 3 (Model) of the desktop onboarding shell (BET-49-T4).
// Mounts into Onboarding.tsx's step-3 slot.
//
// A radio list of models from the CONNECTED providers, sourced from
// window.api.opencodeModels() — the SAME served-model list Step 2 uses for its
// connected badges (main builds it from GET /provider filtered by connected[];
// never /api/model). Each row shows: model name (mono) + provider + context
// window, matching docs/onboarding/mockup.html (no "Recommended"/"Fast" badges).
//
// Selecting a model persists it to AppConfig.defaultModel via the store's
// setDefaultModel action (config write → survives restart; new/cleared sessions
// inherit it — existing mechanism, no new plumbing). We seed the selection from
// the store's current defaultModel so a resumed flow shows the prior choice.
//
// Owns its OWN footer (Back + Continue), like PairStep/ProvidersStep, because
// Continue is gated on a selection. The shell suppresses its footer here.
//
// Props:
//   onBack     — go back to Step 2 (Providers).
//   onContinue — advance to Step 4 (Project). Enabled once a model is selected.

const ACCENT = "#7c9cff";
const DANGER = "#f87171";

export function ModelStep({
  onBack,
  onContinue,
}: {
  onBack: () => void;
  onContinue: () => void;
}) {
  const storeDefault = useStore((s) => s.defaultModel);
  const setDefaultModel = useStore((s) => s.setDefaultModel);

  const [models, setModels] = useState<OpencodeModel[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ providerID: string; modelID: string } | null>(
    storeDefault,
  );

  useEffect(() => {
    let cancelled = false;
    window.api
      .opencodeModels()
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch(() => {
        if (!cancelled) {
          setModels([]);
          setLoadError("Couldn't reach the box to list models.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sorted = sortModelsForPicker(models ?? []);
  const canContinue = canContinueModel(models ?? [], selected);

  const pick = async (m: OpencodeModel) => {
    const choice = { providerID: m.providerID, modelID: m.id };
    setSelected(choice);
    setSaveError(null);
    try {
      // Persist immediately so quitting after the pick still resumes with the
      // model chosen (config write is the source of truth for defaultModel).
      await setDefaultModel(choice);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  const isSelected = (m: OpencodeModel) =>
    selected?.providerID === m.providerID && selected?.modelID === m.id;

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
          {loadError}
        </div>
      )}

      {models === null ? (
        <div className="text-sm text-text-faint">Loading models…</div>
      ) : sorted.length === 0 ? (
        <div className="rounded-md border border-border bg-bg-soft px-3 py-3 text-sm text-text-muted">
          No models available yet. Go back and connect a provider first.
        </div>
      ) : (
        <div className="flex flex-col gap-2 max-h-[46vh] overflow-y-auto pr-1" role="radiogroup" aria-label="Default model">
          {sorted.map((m) => {
            const sel = isSelected(m);
            const ctx = formatContextWindow(m);
            return (
              <button
                key={`${m.providerID}/${m.id}`}
                type="button"
                role="radio"
                aria-checked={sel}
                onClick={() => void pick(m)}
                className="flex items-center gap-3.5 rounded-md border px-4 py-3 text-left transition-colors"
                style={{
                  borderColor: sel ? ACCENT : "#262932",
                  background: sel ? "#1b1e25" : "transparent",
                  boxShadow: sel ? `0 0 0 3px rgba(124,156,255,0.15)` : undefined,
                }}
              >
                <span
                  className="w-[18px] h-[18px] rounded-full border flex items-center justify-center shrink-0"
                  style={{ borderColor: sel ? ACCENT : "#3a3f4b" }}
                >
                  {sel && <span className="w-2 h-2 rounded-full" style={{ background: ACCENT }} />}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block font-mono text-sm text-text truncate">
                    {modelDisplayName(m)}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-text-faint">
                    <span className="capitalize">{m.providerID}</span>
                    {ctx && (
                      <>
                        <span className="w-1 h-1 rounded-full bg-text-faint inline-block" />
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
        <div role="alert" className="text-xs mt-3" style={{ color: DANGER }}>
          Couldn't save your choice: {saveError}
        </div>
      )}

      <StepFooter onBack={onBack} onContinue={onContinue} continueDisabled={!canContinue} />
    </div>
  );
}
