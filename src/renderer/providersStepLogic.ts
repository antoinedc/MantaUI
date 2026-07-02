// providersStepLogic.ts — pure logic for onboarding Step 2 (Providers) and
// Step 3 (Model), BET-49-T4. Framework-free so it's unit-testable in vitest
// (see providersStepLogic.test.ts), exactly like pairStepLogic.ts /
// onboardingUtils.ts. ProvidersStep.tsx / ModelStep.tsx own the React/DOM; this
// module owns the "which providers are connected / can we continue" decisions.
//
// The single source of truth for "connected" is opencode's own model list
// (window.api.opencodeModels()), which main derives from GET /provider filtered
// by `connected[]` (see opencode.ts:listModels) — NEVER /api/model, which leaks
// apiKey. A provider is "connected" iff opencode actually serves at least one
// model for it; that is exactly the condition under which a model can be picked
// in Step 3, so the two steps stay consistent by construction.

import type { OpencodeModel } from "../shared/types";

// Provider ids we surface as first-class cards in Step 2. Anthropic is the
// Claude-auth path (connected on the box via the auth plugin); OpenAI is the
// canonical hosted OpenAI-compatible endpoint added via an API key. Everything
// else is reached through the "Custom" card.
export const ANTHROPIC_ID = "anthropic";
export const OPENAI_ID = "openai";

// opencode's default OpenAI-compatible base URL for the built-in OpenAI card.
// The Custom card lets the user type any baseURL; OpenAI is pinned so the user
// only has to paste a key.
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

// The set of provider ids opencode actually serves models for. This is the
// authoritative "connected" signal for the whole step: a provider with zero
// served models is not connected (even if a stale block sits in opencode.jsonc).
export function connectedProviderIds(models: OpencodeModel[]): Set<string> {
  const ids = new Set<string>();
  for (const m of models) {
    if (m.providerID) ids.add(m.providerID);
  }
  return ids;
}

// Is a specific provider connected (opencode serves ≥1 model for it)?
export function isProviderConnected(models: OpencodeModel[], providerID: string): boolean {
  return connectedProviderIds(models).has(providerID);
}

// Step 2 Continue gate: at least one provider must be connected (i.e. at least
// one model is pickable in Step 3). Mirrors the acceptance criterion "step 2
// Continue requires ≥1 connected provider".
export function canContinueProviders(models: OpencodeModel[]): boolean {
  return connectedProviderIds(models).size > 0;
}

// Validation for the OpenAI / Custom API-key add forms. OpenAI needs only a
// key (baseURL is pinned); Custom needs id + baseURL, key optional (some
// self-hosted endpoints are keyless). Returns the reason it's invalid, or null
// when the draft is submittable — so the UI can both disable the button and
// (optionally) show why.
export type ProviderDraft = { id: string; name: string; baseURL: string; apiKey: string };

export function customDraftError(draft: ProviderDraft): string | null {
  if (!draft.id.trim()) return "Provider id is required.";
  if (!draft.baseURL.trim()) return "Base URL is required.";
  if (!/^https?:\/\//i.test(draft.baseURL.trim())) return "Base URL must start with http:// or https://.";
  return null;
}

export function openaiKeyError(apiKey: string): string | null {
  if (!apiKey.trim()) return "API key is required.";
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
