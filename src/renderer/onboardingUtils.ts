// onboardingUtils.ts — pure step model + resume logic for the M6.6 desktop
// onboarding flow (BET-356). Replaces the 4-step shell (BET-49-T3) with the
// 2-step user-visible collapse: Connect (box picker) and (optionally) Connect
// a provider — then success. Model and Project are no longer onboarding steps
// (the default model is global config edited in Settings; the first project
// is auto-created on pair success, no dedicated step).
//
// The step machine is reused — only the visible positions and labels change.
// `resolveInitialStep` keeps the resumable property the existing flow had:
// quitting mid-flow reopens at the first incomplete step rather than step 1.
//
// Pure + framework-free so it's unit-testable in vitest (see
// onboardingUtils.test.ts), exactly like chatUtils.ts. Onboarding.tsx owns
// all the React/DOM; this module owns the "which step are we on" decisions.

import type { AppConfig } from "../shared/types";

// The ordered numbered steps.
export const ONBOARDING_STEPS = [1, 2] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
/** Full navigable position. There is no terminal success screen — step 2's
 *  own button ends onboarding — so a position IS a numbered step. */
export type OnboardingPosition = OnboardingStep;

export const FIRST_STEP: OnboardingStep = 1;
export const LAST_STEP: OnboardingStep = 2;

// Human labels for the progress rail. Step 1 = "Connect" (the box picker is
// the primary surface; the manual code form lives behind a disclosure there).
// Step 2 = "Connect a provider" — the only step a user sees when their box
// doesn't already have a connected provider; auto-skips when one is.
export const STEP_LABELS: Record<OnboardingStep, string> = {
  1: "Connect",
  2: "Connect a provider",
};

// Back navigation is available on step 2 only (per the two-step flow — step 1
// has no back slot: it's the entry point).
export function canGoBack(pos: OnboardingPosition): boolean {
  return pos === 2;
}

// The next position after `pos`. There is no step after 2 — the provider
// step's own button ends onboarding — so nextPosition clamps at the last step.
export function nextPosition(pos: OnboardingPosition): OnboardingPosition {
  if (pos >= LAST_STEP) return pos;
  return (pos + 1) as OnboardingStep;
}

// The previous position. Only meaningful when canGoBack(pos) is true; clamps
// at the first step.
export function prevPosition(pos: OnboardingPosition): OnboardingPosition {
  if (pos <= FIRST_STEP) return pos;
  return (pos - 1) as OnboardingStep;
}

// Resume: derive the first INCOMPLETE step from persisted config.
//
// The previous 4-step resume math (paired but no model → step 2, model chosen
// but no projects → step 4) collapses — both Model and Project are no longer
// onboarding concerns. What we CAN tell from config alone is whether the box
// is paired. Whether a provider is connected is a live box query, NOT a
// config field, so we resolve to step 2 whenever paired and let the Provider
// step hold the screen: it probes the box on mount and renders whatever is
// already connected, letting the user add more or continue. Net:
// re-entering onboarding on a paired box always lands on step 2.
//
// The 32-hex boxToken gate mirrors the transport-mode detection in
// `resolveTransportMode`, so a malformed token does not falsely advance the
// resume point.
export function resolveInitialStep(
  config: Partial<AppConfig> | null | undefined,
): OnboardingStep {
  const cfg = config && typeof config === "object" ? config : {};
  const paired = typeof cfg.boxToken === "string" && /^[0-9a-f]{32}$/.test(cfg.boxToken);
  return paired ? 2 : 1;
}
