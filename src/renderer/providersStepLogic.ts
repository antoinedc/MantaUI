// providersStepLogic.ts — pure, framework-free core for the desktop onboarding
// Step 2 (Providers) + Step 3 (Model) screens (BET-49-T4).
//
// The React components (ProvidersStep.tsx / ModelStep.tsx) own all the DOM and
// the async IPC wiring; this module owns the decisions that don't need a DOM so
// they're unit-testable in vitest (see providersStepLogic.test.ts), exactly like
// pairStepLogic.ts / onboardingUtils.ts.
//
// The single source of "which providers are connected" is opencode's `/provider`
// endpoint, surfaced to the renderer as `window.api.opencodeModels()` (an
// OpencodeModel[] that lists ONLY models from connected providers — see
// opencode.ts:listModels, which filters `all` by `/provider.connected`). We
// NEVER touch `/api/model` (it leaks apiKey). So a provider is "connected"
// exactly when at least one model in that list carries its providerID.

import type { OpencodeModel } from "../shared/types";

// The two first-class providers the onboarding cards offer alongside "Custom".
// ids match opencode's provider ids so a card's connected state can be read
// straight off the `/provider`-derived model list.
export const ANTHROPIC_ID = "anthropic";
export const OPENAI_ID = "openai";

// The baseURL an OpenAI card writes via setProviders (the OpenAI-compatible
// block opencode serves). Kept here so the component and its test agree.
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * The set of provider ids that are actually connected, derived from the
 * `/provider`-backed model list. A provider is connected iff at least one of
 * its models is present (opencode only lists models from connected providers).
 */
export function connectedProviderIds(models: OpencodeModel[] | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const m of models ?? []) {
    if (m && typeof m.providerID === "string" && m.providerID) ids.add(m.providerID);
  }
  return ids;
}

/** True when a specific provider id has at least one connected model. */
export function isProviderConnected(
  models: OpencodeModel[] | null | undefined,
  providerID: string,
): boolean {
  return connectedProviderIds(models).has(providerID);
}

/**
 * Step 2 gate: "Continue" is enabled only once at least one provider is
 * connected (≥1 model from a connected provider exists). `null` (still loading)
 * counts as not-ready.
 */
export function canContinueProviders(models: OpencodeModel[] | null | undefined): boolean {
  return connectedProviderIds(models).size > 0;
}

/**
 * Step 3 gate: "Continue" is enabled only once a model is selected. Pure so the
 * component's disabled logic and its test share one definition.
 */
export function canContinueModel(
  selected: { providerID: string; modelID: string } | null | undefined,
): boolean {
  return !!selected && typeof selected.modelID === "string" && selected.modelID.length > 0;
}

/**
 * The models to offer in Step 3: every model from a connected provider, in the
 * order opencode returned them (stable — callers don't re-sort). Kept as its own
 * function so the "connected-only" contract is enforced in one tested place
 * rather than re-derived inline in the component.
 */
export function selectableModels(models: OpencodeModel[] | null | undefined): OpencodeModel[] {
  const connected = connectedProviderIds(models);
  return (models ?? []).filter((m) => m && connected.has(m.providerID));
}

/**
 * Human context-window label for a model card, e.g. 200000 → "200K context".
 * Returns null when the model reports no context limit (the card then shows
 * provider only, no dot + span), matching the mockup's meta row.
 */
export function formatContextWindow(limit: number | null | undefined): string | null {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return null;
  if (limit >= 1_000_000) {
    const m = limit / 1_000_000;
    const rounded = Math.round(m * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}M context`;
  }
  if (limit >= 1000) {
    return `${Math.round(limit / 1000)}K context`;
  }
  return `${limit} context`;
}

/**
 * The submit gate for the OpenAI / Custom provider-key forms. A submission needs
 * a non-empty id + baseURL + apiKey and no in-flight request. (OpenAI prefills
 * id/name/baseURL, so in practice its gate reduces to "a key was typed".)
 */
export function canSubmitProviderKey(input: {
  id: string;
  baseURL: string;
  apiKey: string;
  submitting: boolean;
}): boolean {
  if (input.submitting) return false;
  return (
    input.id.trim().length > 0 &&
    input.baseURL.trim().length > 0 &&
    input.apiKey.trim().length > 0
  );
}
