// Provider management: discover models from an OpenAI-compatible endpoint and
// read/merge/write provider blocks in the box's opencode.jsonc. opencode.jsonc
// stays the single source of truth; the model picker keeps reading opencode's
// /provider endpoint (see opencode.ts:listModels) — this file only edits config.
import type { DiscoverResult } from "../shared/types.js";

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
