// Provider management: discover models from an OpenAI-compatible endpoint and
// read/merge/write provider blocks in the box's opencode.jsonc. opencode.jsonc
// stays the single source of truth; the model picker keeps reading opencode's
// /provider endpoint (see opencode.ts:listModels) — this file only edits config.
import type { DiscoverResult, ProviderEndpoint, ProviderInput } from "../shared/types.js";

// Parse the body of GET <baseURL>/models (OpenAI-compatible shape: { data: [{ id }] }).
// Pure — no I/O — so it is unit-testable against fixture strings.
export function parseModelsResponse(body: string): DiscoverResult {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, error: "bad_response", detail: body.slice(0, 200) };
  }
  const obj = json as Record<string, unknown>;
  // Auth errors come back as 200/4xx JSON with an `error` object on many gateways.
  if (obj && typeof obj === "object" && "error" in obj) {
    const errObj = obj.error as Record<string, unknown> | undefined;
    const msg = errObj && typeof errObj.message === "string" ? errObj.message : "";
    const code = errObj && typeof errObj.code === "string" ? errObj.code : "";
    if (/api key|unauthor|invalid_api_key|401/i.test(`${msg} ${code}`)) {
      return { ok: false, error: "unauthorized", detail: msg || code };
    }
    return { ok: false, error: "bad_response", detail: msg || code };
  }
  const data = obj?.data;
  if (!Array.isArray(data)) {
    return { ok: false, error: "bad_response", detail: "no data array" };
  }
  const models = data
    .map((m) => (m && typeof m === "object" ? String((m as Record<string, unknown>).id ?? "") : ""))
    .filter(Boolean)
    .map((id) => ({ id }));
  return { ok: true, models };
}

type Cfg = Record<string, unknown>;
type ProviderBlock = {
  npm: string;
  name?: string;
  options?: { baseURL?: string; apiKey?: string };
  models?: Record<string, { id: string; name?: string }>;
};

function getProviderMap(cfg: Cfg): Record<string, ProviderBlock> {
  const p = cfg.provider;
  return p && typeof p === "object" ? ({ ...(p as Record<string, ProviderBlock>) }) : {};
}

// Insert or replace a single provider block. Only the `provider` key is touched;
// every other key in `cfg` is preserved by spread. If `input.apiKey` is
// undefined, the existing key (if any) is kept — so the renderer never has to
// round-trip the secret.
export function upsertProviderBlock(cfg: Cfg, input: ProviderInput): Cfg {
  const providers = getProviderMap(cfg);
  const prev = providers[input.id];
  const apiKey =
    input.apiKey !== undefined ? input.apiKey : prev?.options?.apiKey ?? "";
  const models: Record<string, { id: string; name: string }> = {};
  for (const id of input.enabledModels) models[id] = { id, name: id };
  providers[input.id] = {
    npm: "@ai-sdk/openai-compatible",
    name: input.name,
    options: { baseURL: input.baseURL, apiKey },
    models,
  };
  return { ...cfg, provider: providers };
}

export function removeProviderBlock(cfg: Cfg, id: string): Cfg {
  const providers = getProviderMap(cfg);
  delete providers[id];
  return { ...cfg, provider: providers };
}

// Project the config's provider map down to renderer-safe metadata. Never
// includes the apiKey value — only whether one is present.
export function readProviderEndpoints(cfg: Cfg): ProviderEndpoint[] {
  const providers = getProviderMap(cfg);
  return Object.entries(providers).map(([id, block]) => ({
    id,
    name: typeof block.name === "string" ? block.name : id,
    baseURL: block.options?.baseURL ?? "",
    hasApiKey: Boolean(block.options?.apiKey),
    enabledModels: Object.keys(block.models ?? {}),
  }));
}
