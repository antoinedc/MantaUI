// Provider management: discover models from an OpenAI-compatible endpoint and
// read/merge/write provider blocks in the box's opencode.jsonc. opencode.jsonc
// stays the single source of truth; the model picker keeps reading opencode's
// /provider endpoint (see opencode.ts:listModels) — this file only edits config.
import type { AppConfig, DiscoverResult, ProviderEndpoint, ProviderInput } from "../shared/types.js";
import { runSshOnce, shellQuote } from "./pty.js";

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

const OPENCODE_JSONC = "~/.config/opencode/opencode.jsonc";

// Query an OpenAI-compatible endpoint's /v1/models FROM THE BOX (not the Mac):
// the box is where opencode reaches these endpoints, so discovery must reflect
// the box's network view (honors the "remote box is backend-only" invariant).
export async function discoverModels(
  config: AppConfig,
  baseURL: string,
  apiKey: string,
): Promise<DiscoverResult> {
  // Empty key from the renderer means "use the key already stored on the box"
  // (Refresh on an existing endpoint never re-sends the secret). Re-read it from
  // opencode.jsonc by matching the baseURL. New endpoints persist their key via
  // Add before Refresh, so this same lookup finds it.
  let key = apiKey;
  if (!key) {
    try {
      const cfg = await readRemoteConfig(config);
      const providers = getProviderMap(cfg);
      const match = Object.values(providers).find(
        (b) => b.options?.baseURL?.replace(/\/$/, "") === baseURL.replace(/\/$/, ""),
      );
      key = match?.options?.apiKey ?? "";
    } catch {
      /* fall through with empty key — endpoint may legitimately need none */
    }
  }
  const url = `${baseURL.replace(/\/$/, "")}/models`;
  const cmd =
    `curl -s --max-time 20 -H ${shellQuote(`Authorization: Bearer ${key}`)} ${shellQuote(url)}`;
  try {
    const { stdout } = await runSshOnce(config, cmd, { timeoutMs: 30000 });
    if (!stdout.trim()) return { ok: false, error: "unreachable", detail: "empty response" };
    return parseModelsResponse(stdout);
  } catch (e) {
    return { ok: false, error: "unreachable", detail: e instanceof Error ? e.message : String(e) };
  }
}

// Read opencode.jsonc from the box and parse it (strip // comments, like the
// skill-URLs path in index.ts). Returns {} if the file is absent. THROWS if the
// file exists but is unparseable — callers must NOT overwrite an unparseable
// config (that was the 2026-05-18 corruption failure mode).
async function readRemoteConfig(config: AppConfig): Promise<Cfg> {
  const { stdout } = await runSshOnce(
    config,
    `cat ${OPENCODE_JSONC} 2>/dev/null || echo '{}'`,
  );
  const stripped = stdout.replace(/\/\/[^\n]*/g, "");
  return JSON.parse(stripped) as Cfg; // intentional throw on malformed JSON
}

export async function getProviderEndpoints(config: AppConfig): Promise<ProviderEndpoint[]> {
  const cfg = await readRemoteConfig(config);
  return readProviderEndpoints(cfg);
}

// Apply a set of provider mutations and write opencode.jsonc back using the
// TESTED heredoc writer (no string interpolation of JSON — see remoteConfigWrite.ts).
// Does NOT restart opencode; the caller decides (prompt-before-restart).
export async function setProviders(
  config: AppConfig,
  ops: { upsert?: ProviderInput[]; remove?: string[] },
): Promise<{ ok: boolean; error?: string }> {
  let cfg: Cfg;
  try {
    cfg = await readRemoteConfig(config);
  } catch {
    return { ok: false, error: "opencode.jsonc on the box is unparseable — refusing to overwrite it. Fix it manually first." };
  }
  for (const id of ops.remove ?? []) cfg = removeProviderBlock(cfg, id);
  for (const input of ops.upsert ?? []) cfg = upsertProviderBlock(cfg, input);
  const content = JSON.stringify(cfg, null, 2);
  try {
    const { buildRemoteConfigWriteCmd } = await import("./remoteConfigWrite.js");
    await runSshOnce(config, buildRemoteConfigWriteCmd(content, OPENCODE_JSONC));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
