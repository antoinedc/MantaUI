// onboardingUtils.ts — pure step model + resume logic for the M6.2 desktop
// onboarding flow (BET-49-T3). Framework-free so it's unit-testable in vitest
// (see onboardingUtils.test.ts), exactly like chatUtils.ts. Onboarding.tsx owns
// all the React/DOM; this module owns the "which step are we on" decisions.
//
// The flow has four numbered steps plus a terminal success screen, matching
// docs/onboarding/mockup.html:
//
//   1 Pair      → enter the 6-digit pairing code (persists boxToken/boxId/serverUrl)
//   2 Providers → pick AI providers                (BET-49-T4)
//   3 Model     → pick the default model           (BET-49-T4, persists defaultModel)
//   4 Project   → create the first project         (BET-49-T5)
//   success     → "You're all set!" → Open bui
//
// T2/T4/T5 land the per-step UIs; T3 owns this shell + the resume math so a
// user who quits mid-flow reopens at the first INCOMPLETE step instead of
// always restarting at step 1.

import type { AppConfig } from "../shared/types";

// The ordered numbered steps. `success` is the terminal screen after step 4,
// kept out of this tuple so it never participates in progress-dot math.
export const ONBOARDING_STEPS = [1, 2, 3, 4] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
// Full navigable position: a numbered step OR the terminal success screen.
export type OnboardingPosition = OnboardingStep | "success";

export const FIRST_STEP: OnboardingStep = 1;
export const LAST_STEP: OnboardingStep = 4;

// Human labels for the progress rail (mockup: Connect / Providers / Model / Project).
export const STEP_LABELS: Record<OnboardingStep, string> = {
  1: "Connect",
  2: "Providers",
  3: "Model",
  4: "Project",
};

// Back navigation is available on steps 2–4 only (per mockup — step 1 has
// "Skip setup" in the back slot instead, and success has no back).
export function canGoBack(pos: OnboardingPosition): boolean {
  return pos === 2 || pos === 3 || pos === 4;
}

// The next position after `pos`. Step 4 → success; success stays success.
export function nextPosition(pos: OnboardingPosition): OnboardingPosition {
  if (pos === "success") return "success";
  if (pos >= LAST_STEP) return "success";
  return (pos + 1) as OnboardingStep;
}

// The previous position. Only meaningful when canGoBack(pos) is true; clamps
// at the first step and is a no-op from step 1 / success.
export function prevPosition(pos: OnboardingPosition): OnboardingPosition {
  if (pos === "success" || pos <= FIRST_STEP) return pos;
  return (pos - 1) as OnboardingStep;
}

// Resume: derive the first INCOMPLETE step from persisted config, so quitting
// mid-flow reopens where the user left off rather than at step 1. The rule
// mirrors what each step persists:
//
//   - No valid boxToken            → step 1 (still needs to pair)
//   - Paired but no defaultModel   → step 2 (providers → model not chosen yet)
//   - Model chosen but no projects → step 4 (needs a first project)
//   - Everything present           → step 4 (last actionable step; the shell
//                                     shows success only after an explicit
//                                     "Create project" — we never auto-skip
//                                     someone straight to the success screen on
//                                     launch, since that would strand a fully
//                                     configured user with nothing to do)
//
// We intentionally resume to step 2 (Providers) rather than step 3 when paired
// but model-less: the user hasn't chosen providers yet in that state, and step
// 2 → 3 is a single Continue. `boxToken` validity uses the same 32-hex gate as
// transport-mode detection (resolveTransportMode), so a malformed token doesn't
// falsely advance the resume point.
export function resolveInitialStep(
  config: Partial<AppConfig> | null | undefined,
): OnboardingStep {
  const cfg = config && typeof config === "object" ? config : {};
  const paired = typeof cfg.boxToken === "string" && /^[0-9a-f]{32}$/.test(cfg.boxToken);
  if (!paired) return 1;
  const hasModel = !!cfg.defaultModel && !!cfg.defaultModel.modelID;
  if (!hasModel) return 2;
  const hasProject = Array.isArray(cfg.projects) && cfg.projects.length > 0;
  if (!hasProject) return 4;
  return 4;
}
