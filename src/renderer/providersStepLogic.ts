// providersStepLogic.ts — pure logic for onboarding Step 2 (Providers) and
// Step 3 (Model), BET-49-T4. Framework-free so it's unit-testable in vitest
// (see providersStepLogic.test.ts), exactly like pairStepLogic.ts /
// onboardingUtils.ts. ProvidersStep.tsx / ModelStep.tsx own the React/DOM; this
// module owns the "which providers are connected / can we continue" decisions.
//
// Step 2's "connected" signal moved off `window.api.opencodeModels()` onto
// the `status` action (BET-315). The action feeds directly off opencode's
// `GET /provider` `connected[]`, which is the same source the model list is
// built from, so a provider counted as connected here is one whose models
// appear in Step 3 — the two steps stay consistent by construction.

import type { OpencodeModel, SubscriptionStatus } from "../shared/types";

// Step 2 Continue gate: at least one provider must be connected (i.e. at
// least one model is pickable in Step 3). Mirrors the acceptance criterion
// "step 2 Continue requires ≥1 connected provider". Switching the input
// from a served-models list to the `status` action's SubscriptionStatus[]
// (BET-315) is what makes a subscription connected seconds ago count
// immediately — the parent's refresh fires on connect-done and the
// Continue gate re-evaluates off the same row.
export function canContinueProviders(statuses: SubscriptionStatus[]): boolean {
  return statuses.some((s) => s.connected);
}

// Validation for the custom-endpoint add form. id + baseURL are required;
// key is optional (some self-hosted endpoints are keyless). Returns the
// reason it's invalid, or null when the draft is submittable — so the UI
// can both disable the button and (optionally) show why.
export type ProviderDraft = { id: string; name: string; baseURL: string; apiKey: string };

export function customDraftError(draft: ProviderDraft): string | null {
  if (!draft.id.trim()) return "Provider id is required.";
  if (!draft.baseURL.trim()) return "Base URL is required.";
  if (!/^https?:\/\//i.test(draft.baseURL.trim())) return "Base URL must start with http:// or https://.";
  return null;
}

// A stable, human-friendly display label for a model in the Step 3 radio list.
// Prefers opencode's `name`, falling back to the id. Kept pure so the list
// rendering has no branching logic inline.
export function modelDisplayName(model: OpencodeModel): string {
  return model.name?.trim() || model.id;
}

// Format a model's context window (limit.context, in tokens) as the mockup's
// "200K context" / "128K context" label. Returns null when unknown so the UI
// can omit the segment entirely rather than render "undefined context".
export function formatContextWindow(model: OpencodeModel): string | null {
  const ctx = model.limit?.context;
  if (typeof ctx !== "number" || !Number.isFinite(ctx) || ctx <= 0) return null;
  if (ctx >= 1000) {
    const k = ctx / 1000;
    // Whole thousands render as "200K"; keep one decimal otherwise ("32.8K").
    const label = Number.isInteger(k) ? String(k) : k.toFixed(1);
    return `${label}K context`;
  }
  return `${ctx} context`;
}

// Sort models for the Step 3 picker: connected-provider models grouped by
// provider id (stable, alphabetical), then by display name within a provider.
// Deterministic ordering keeps the radio list from reshuffling between fetches.
export function sortModelsForPicker(models: OpencodeModel[]): OpencodeModel[] {
  return [...models].sort((a, b) => {
    const pa = a.providerID || "";
    const pb = b.providerID || "";
    if (pa !== pb) return pa < pb ? -1 : 1;
    const na = modelDisplayName(a).toLowerCase();
    const nb = modelDisplayName(b).toLowerCase();
    if (na !== nb) return na < nb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// Step 3 Continue gate: a model must be selected AND it must still be present
// in the currently-served list (a provider removed between fetches invalidates
// a stale selection). Compares on providerID/modelID (the AppConfig.defaultModel
// shape).
export function canContinueModel(
  models: OpencodeModel[],
  selected: { providerID: string; modelID: string } | null,
): boolean {
  if (!selected) return false;
  return models.some((m) => m.providerID === selected.providerID && m.id === selected.modelID);
}
