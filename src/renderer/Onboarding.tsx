import { useState } from "react";
import {
  ONBOARDING_STEPS,
  STEP_LABELS,
  LAST_STEP,
  nextPosition,
  prevPosition,
  resolveInitialStep,
  type OnboardingPosition,
} from "./onboardingUtils";
import { useStore } from "./store";
import { PairStep } from "./PairStep";
import { ProvidersStep } from "./ProvidersStep";
import { ModelStep } from "./ModelStep";
import { FirstProjectStep } from "./FirstProjectStep";
import { ArrowRight, CheckIcon } from "./onboardingUi";

// Onboarding.tsx — full-screen M6.2 onboarding shell (BET-49-T3).
//
// Owns: the full-screen container (no sidebar / header / footer), the progress
// rail (numbered dots + connecting lines, per docs/onboarding/mockup.html),
// fade+slide step transitions, back navigation on steps 2–4, the "Skip setup"
// escape hatch, and the terminal success screen.
//
// Does NOT own the per-step bodies:
//   - Step 1 (Pair)          → BET-49-T2 (PairStep.tsx — mounted below)
//   - Step 2 (Providers)     → BET-49-T4 (ProvidersStep.tsx — mounted below)
//   - Step 3 (Model)         → BET-49-T4 (ModelStep.tsx — mounted below)
//   - Step 4 (First project) → BET-49-T5 (FirstProjectStep.tsx — mounted below)
// Those land as their own components mounted into the step-body slots below.
// The step model + resume math live in onboardingUtils.ts (pure, tested).
//
// Every step owns its OWN footer (per docs/onboarding/mockup.html), because
// each has a gated/side-effecting primary action the shell's generic goNext
// footer can't express: Step 1's "Connect" runs the pairing claim and only
// advances on success; Step 2's "Continue" is gated on ≥1 connected provider;
// Step 3's "Continue" is gated on a model selection; Step 4's "Create project"
// runs project creation and only advances (to success) once it succeeds. So the
// shell hides its footer entirely and lets each step drive advancement
// (onContinue/onPaired/onCreated → goNext), back-nav (onBack → goBack), and
// skipping (onSkip → skip).
//
// Props:
//   onDone — called when onboarding completes (success screen "Open bui") OR is
//            skipped. The parent (App.tsx) re-reads config and drops back to the
//            normal shell WITHOUT an app restart.

const ACCENT = "#7c9cff"; // matches the app's Tailwind `accent` token (see tailwind.config)

// One progress dot + (optionally) the connector leading into it.
function ProgressRail({ current }: { current: OnboardingPosition }) {
  // On the success screen every numbered step reads as completed.
  const activeIdx = current === "success" ? LAST_STEP + 1 : current;
  return (
    <div className="flex flex-col items-center">
      <div className="flex items-center justify-center">
        {ONBOARDING_STEPS.map((step, i) => {
          const state: "completed" | "active" | "inactive" =
            step < activeIdx ? "completed" : step === activeIdx ? "active" : "inactive";
          return (
            <div key={step} className="flex items-center">
              {i > 0 && (
                <div
                  className="h-0.5 w-12 sm:w-16 transition-colors"
                  style={{ background: step <= activeIdx ? ACCENT : "#262932" }}
                />
              )}
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-semibold transition-all shrink-0"
                style={
                  state === "inactive"
                    ? { background: "#1b1e25", color: "#6b7280", border: "1.5px solid #262932" }
                    : state === "active"
                      ? {
                          background: ACCENT,
                          color: "#0e0f12",
                          border: `1.5px solid ${ACCENT}`,
                          boxShadow: `0 0 0 4px rgba(124,156,255,0.15)`,
                        }
                      : { background: ACCENT, color: "#0e0f12", border: `1.5px solid ${ACCENT}` }
                }
              >
                {state === "completed" ? <CheckIcon className="w-3.5 h-3.5" /> : step}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-center gap-4 mt-3">
        {ONBOARDING_STEPS.map((step) => {
          const isActive = step === activeIdx;
          return (
            <div
              key={step}
              className="text-xs text-center min-w-[60px]"
              style={{ color: isActive ? "#9aa0aa" : "#6b7280", fontWeight: isActive ? 500 : 400 }}
            >
              {STEP_LABELS[step]}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  // Derive the resume point once from the current config so a quit-mid-flow
  // reopens at the first incomplete step. Read straight from the store's
  // config snapshot (App gates on `loaded`, so config is present by mount).
  const [pos, setPos] = useState<OnboardingPosition>(() =>
    resolveInitialStep(useStore.getState().configSnapshot()),
  );

  const goNext = () => setPos((p) => nextPosition(p));
  const goBack = () => setPos((p) => prevPosition(p));

  // Skip: persist onboardingSkipped so the flow doesn't re-trigger on every
  // launch of an otherwise-empty config, then hand control back to the shell.
  const skip = async () => {
    await useStore.getState().skipOnboarding();
    onDone();
  };

  const isSuccess = pos === "success";

  return (
    <div className="fixed inset-0 z-50 bg-bg text-text flex items-center justify-center overflow-y-auto">
      <div className="w-full max-w-[720px] px-6 py-8">
        {/* Header: logo + progress rail (hidden on the success screen). */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2.5 mb-8">
            <div
              className="w-9 h-9 rounded flex items-center justify-center"
              style={{ background: `linear-gradient(135deg, ${ACCENT}, #a78bfa)` }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="#0e0f12"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-5 h-5"
              >
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            </div>
            <span className="text-xl font-semibold tracking-tight">bui</span>
          </div>
          {!isSuccess && <ProgressRail current={pos} />}
        </div>

        {/* Step body. `key` on the wrapper restarts the fade+slide animation on
            every position change. */}
        <div className="relative overflow-hidden">
          <div key={String(pos)} className="onboarding-step-enter">
            {isSuccess ? (
              <div className="text-center py-5">
                <div
                  className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-5"
                  style={{ background: "rgba(34,197,94,0.1)" }}
                >
                  <CheckIcon className="w-7 h-7 text-green-400" />
                </div>
                <h2 className="text-2xl font-semibold mb-2">You're all set!</h2>
                <p className="text-sm text-text-muted leading-relaxed max-w-sm mx-auto mb-7">
                  Your server is connected, providers are configured, and your first project is
                  ready. Start chatting with your AI assistant.
                </p>
                <button
                  onClick={onDone}
                  className="inline-flex items-center gap-2 px-6 py-2.5 rounded-md text-sm font-medium text-bg"
                  style={{ background: ACCENT }}
                >
                  Open bui
                  <ArrowRight />
                </button>
              </div>
            ) : pos === 1 ? (
              // Step 1 (Pair) owns its own footer (Skip setup + Connect), so it
              // gets goNext/skip directly and the shell footer is suppressed
              // below. A successful claim advances; skip drops to the app.
              <PairStep onPaired={goNext} onSkip={skip} />
            ) : pos === 2 ? (
              // Step 2 (Providers) owns its footer (Back + gated Continue).
              <ProvidersStep onBack={goBack} onContinue={goNext} />
            ) : pos === 3 ? (
              // Step 3 (Model) owns its footer (Back + gated Continue).
              <ModelStep onBack={goBack} onContinue={goNext} />
            ) : (
              // Step 4 (First project) owns its footer (Back + gated Create
              // project). onCreated advances to the success screen.
              <FirstProjectStep onBack={goBack} onCreated={goNext} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
