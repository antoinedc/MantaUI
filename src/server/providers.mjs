// providers.mjs — Provider management for the bui mobile server.
//
// Ports the pure helpers from src/main/providers.ts (parseModelsResponse,
// upsertProviderBlock, removeProviderBlock, readProviderEndpoints,
// findStoredApiKey, stripUrlUserinfo) and adds server-side I/O functions:
//   getProviders      — fetch opencode's /provider endpoint (via ocFetch)
//   discoverModels    — fetch <baseURL>/models directly (server IS the box)
//   setProviders      — read/merge/write opencode.jsonc locally
//
// The desktop's src/main/providers.ts SSH runners stay until Stage 2 deletion.
// This slice only adds the HTTP path. The RPC layer serves both (SSH + HTTP)
// until SSH is removed.

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { reconcileSubagents } from "../shared/subagentSync.mjs";

// ---------------------------------------------------------------------------
// Pure helpers (ported from src/main/providers.ts)
// ---------------------------------------------------------------------------

// Parse the body of GET <baseURL>/models (OpenAI-compatible shape: { data: [{ id }] }).
// Pure — no I/O — so it is unit-testable against fixture strings.
export function parseModelsResponse(body) {
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, error: "bad_response", detail: body.slice(0, 200) };
  }
  const obj = json;
  // Auth errors come back as 200/4xx JSON with an `error` object on many
  // gateways. Gate on a truthy object: some OpenAI-compatible gateways return
  // `{ data: [...], error: null }` on SUCCESS, and a bare `"error" in obj`
  // check would mistreat that as a failure and discard the valid `data`.
  const errObj = obj?.error;
  if (errObj && typeof errObj === "object") {
    const e = errObj;
    const msg = typeof e.message === "string" ? e.message : "";
    const code = typeof e.code === "string" ? e.code : "";
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
    .map((m) => (m && typeof m === "object" ? String(m.id ?? "") : ""))
    .filter(Boolean)
    .map((id) => ({ id }));
  return { ok: true, models };
}

// Strip any `user:pass@` userinfo from a URL so a credential embedded in the
// baseURL (e.g. https://user:pass@host/v1) can't ride along to the renderer /
// mobile client. Falls back to a regex if the URL doesn't parse.
function stripUrlUserinfo(url) {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
  }
}

// Normalize a baseURL for equality: drop a trailing slash AND any userinfo, so
// the value the renderer sends back (which readProviderEndpoints scrubbed of
// `user:pass@`) still matches the stored, possibly-unscrubbed baseURL.
const normBaseURL = (u) => stripUrlUserinfo(u).replace(/\/$/, "");

// opencode.jsonc lives at ~/.config/opencode/opencode.jsonc on the box. The
// mobile server IS the box, so we read/write it directly (no SSH hop).
const OPENCODE_JSONC = join(homedir(), ".config", "opencode", "opencode.jsonc");

// Atomic write helper: write to a temp file then rename over the target.
// rename(2) is atomic on the same filesystem, so a crash mid-write cannot
// leave the destination file truncated or empty.
async function atomicWrite(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/**
 * Strip // line comments from JSONC without eating // inside strings.
 * Ported from src/main/setup.ts:stripLineComments.
 */
function stripLineComments(jsonc) {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < jsonc.length) {
    const c = jsonc[i];
    if (inStr) {
      out += c;
      if (c === "\\" && i + 1 < jsonc.length) {
        out += jsonc[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      out += c;
      inStr = true;
      i += 1;
      continue;
    }
    if (c === "/" && jsonc[i + 1] === "/") {
      const nl = jsonc.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Provider block manipulation (pure)
// ---------------------------------------------------------------------------

function getProviderMap(cfg) {
  const p = cfg.provider;
  return p && typeof p === "object" ? { ...(p) } : {};
}

function getAgentMap(cfg) {
  const a = cfg.agent;
  return a && typeof a === "object" ? { ...(a) } : {};
}

// Insert or replace a single provider block. Only the `provider` key is touched;
// every other key in `cfg` is preserved by spread. If `input.apiKey` is
// undefined, the existing key (if any) is kept — so the renderer never has to
// round-trip the secret.
export function upsertProviderBlock(cfg, input) {
  const providers = getProviderMap(cfg);
  const prev = providers[input.id];
  const apiKey =
    input.apiKey !== undefined ? input.apiKey : prev?.options?.apiKey ?? "";
  const models = {};
  for (const id of input.enabledModels) models[id] = { id, name: id };
  providers[input.id] = {
    npm: "@ai-sdk/openai-compatible",
    name: input.name,
    options: { baseURL: input.baseURL, apiKey },
    models,
  };
  return { ...cfg, provider: providers };
}

export function removeProviderBlock(cfg, id) {
  const providers = getProviderMap(cfg);
  delete providers[id];
  return { ...cfg, provider: providers };
}

// Project the config's provider map down to renderer-safe metadata. Never
// includes the apiKey value — only whether one is present — and scrubs any
// credential embedded in the baseURL.
//
// ONLY blocks with an options.baseURL are projected: the ProvidersCard is the
// manager for OpenAI-compatible ENDPOINTS, and a baseURL is definitional for
// those. Plugin-authed providers (e.g. the `anthropic` block used by
// opencode-claude-auth) have no baseURL and MUST be excluded — rendering them
// in the card gives them a Refresh button that fetches `"" + "/models"`
// ("unreachable: could not reach the endpoint"), and worse, a model toggle or
// ✕ on that row would route the block through upsertProviderBlock /
// removeProviderBlock, overwriting it with npm:"@ai-sdk/openai-compatible" +
// empty baseURL and corrupting the plugin auth. They still appear in the model
// dropdown, which reads the live /provider endpoint instead.
export function readProviderEndpoints(cfg) {
  const providers = getProviderMap(cfg);
  return Object.entries(providers)
    .filter(([, block]) => Boolean(block.options?.baseURL))
    .map(([id, block]) => ({
      id,
      name: typeof block.name === "string" ? block.name : id,
      baseURL: stripUrlUserinfo(block.options.baseURL),
      hasApiKey: Boolean(block.options?.apiKey),
      enabledModels: Object.keys(block.models ?? {}),
    }));
}

// Find the apiKey stored in opencode.jsonc for the provider whose baseURL
// matches. Pure — unit-testable. Returns "" when no provider matches or the
// matched one has no key. Backs the Refresh flow: the renderer sends an empty
// key (never re-sending the secret), and we recover the stored one here by
// baseURL.
export function findStoredApiKey(cfg, baseURL) {
  const providers = getProviderMap(cfg);
  const target = normBaseURL(baseURL);
  const match = Object.values(providers).find(
    (b) => b.options?.baseURL && normBaseURL(b.options.baseURL) === target,
  );
  return match?.options?.apiKey ?? "";
}

// ---------------------------------------------------------------------------
// Subagent block manipulation (pure)
// ---------------------------------------------------------------------------

// Insert or replace a single named subagent. Only the `agent` key is touched;
// every other key in `cfg` is preserved by spread. `mode` is always forced to
// "subagent" (the only config-writable agent type bui manages).
export function upsertAgentBlock(cfg, input) {
  const agents = getAgentMap(cfg);
  agents[input.name] = {
    model: input.model,
    description: input.description,
    mode: "subagent",
  };
  return { ...cfg, agent: agents };
}

export function removeAgentBlock(cfg, name) {
  const agents = getAgentMap(cfg);
  delete agents[name];
  return { ...cfg, agent: agents };
}

// Project the config's agent map down to SubagentDef[]. ONLY blocks with a
// `model` string are projected — this filters out opencode's built-in agents
// (which have no model in config) so the UI never renders/clobbers them.
export function readAgentBlocks(cfg) {
  const agents = getAgentMap(cfg);
  return Object.entries(agents)
    .filter(([, block]) => typeof block.model === "string" && block.model)
    .map(([name, block]) => ({
      name,
      model: block.model,
      description: typeof block.description === "string" ? block.description : "",
    }));
}

// ---------------------------------------------------------------------------
// I/O-dependent functions (server-side)
// ---------------------------------------------------------------------------

const UNPARSEABLE_CONFIG_MSG =
  "opencode.jsonc on the box is unparseable — fix it manually first.";

/**
 * Read opencode.jsonc from the box and parse it. Returns {} if the file is
 * absent. THROWS if the file exists but is unparseable — callers must NOT
 * overwrite an unparseable config.
 */
async function readRemoteConfig() {
  if (!existsSync(OPENCODE_JSONC)) return {};
  const raw = await readFile(OPENCODE_JSONC, "utf-8");
  const stripped = stripLineComments(raw);
  return JSON.parse(stripped);
}

/**
 * Read opencode.jsonc from the box and project it into the ProviderEndpoint[]
 * shape the Settings ProvidersCard form expects. This is the config-reading
 * path (NOT the /provider HTTP endpoint): the card needs the configured
 * provider blocks (id/name/baseURL/hasApiKey/enabledModels), so a custom
 * provider like "Voska AI" is prefilled in the form.
 *
 * `readConfig` is injectable so the projection can be unit-tested without the
 * real ~/.config/opencode/opencode.jsonc file; it defaults to readRemoteConfig.
 * Returns [] if the config is absent or unparseable (the form degrades to an
 * empty list rather than throwing).
 */
export async function getProviderEndpoints(readConfig = readRemoteConfig) {
  try {
    const cfg = await readConfig();
    return readProviderEndpoints(cfg);
  } catch (e) {
    console.warn("[providers] could not read provider endpoints:", e);
    return [];
  }
}

/**
 * Fetch the provider list from opencode's /provider endpoint.
 * Returns the raw shape: { all: [...], connected: [...], default: {...} }.
 *
 * Uses native fetch directly (opencode.mjs's ocFetch is not exported).
 * The server IS on the box, so 127.0.0.1:4096 is reachable without SSH.
 */
export async function getProviders() {
  try {
    const res = await fetch("http://127.0.0.1:4096/provider");
    if (!res.ok) {
      await res.text().catch(() => {});
      return { all: [], connected: [], default: {} };
    }
    return await res.json();
  } catch {
    return { all: [], connected: [], default: {} };
  }
}

/**
 * Query an OpenAI-compatible endpoint's /models FROM THE BOX (server IS the box):
 * the box is where opencode reaches these endpoints, so discovery must reflect
 * the box's network view.
 */
export async function discoverModels(baseURL, apiKey) {
  // Defense-in-depth: an endpoint row without a baseURL can't be discovered
  // (fetch("/models") throws "Failed to parse URL"). readProviderEndpoints
  // filters these out of the card, but guard here too so a stale client or
  // direct rpc call gets a clear error instead of "unreachable".
  if (!baseURL || !String(baseURL).trim()) {
    return { ok: false, error: "bad_response", detail: "provider has no baseURL configured" };
  }
  const url = `${normBaseURL(baseURL)}/models`;
  try {
    const headers = {};
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const text = await res.text();
      return parseModelsResponse(text);
    }
    const text = await res.text();
    if (!text.trim()) return { ok: false, error: "unreachable", detail: "empty response" };
    return parseModelsResponse(text);
  } catch (e) {
    console.warn("[providers] discovery failed for", url, e);
    return { ok: false, error: "unreachable", detail: "could not reach the endpoint" };
  }
}

/**
 * Discovery entrypoint for the ProvidersCard Refresh flow. The renderer sends
 * an EMPTY apiKey by design ("Refresh never re-sends the secret"), and the
 * stored key for the endpoint is recovered here from opencode.jsonc via
 * findStoredApiKey — the secret stays on the box. An explicit apiKey (the
 * add-endpoint validation path) is used as-is.
 *
 * `readConfig` is injectable for tests; defaults to readRemoteConfig. A config
 * read failure degrades to keyless discovery (the endpoint may be public).
 */
export async function discoverModelsForEndpoint(baseURL, apiKey, readConfig = readRemoteConfig) {
  let key = apiKey ?? "";
  if (!key) {
    try {
      key = findStoredApiKey(await readConfig(), baseURL);
    } catch (e) {
      console.warn("[providers] could not read stored api key:", e);
      key = "";
    }
  }
  return discoverModels(baseURL, key);
}

/**
 * Serialize + atomically write opencode.jsonc. Shared write path for
 * setProviders / setSubagents (and any future writer) so the mkdir +
 * atomicWrite + error-shape contract lives in one place.
 */
async function writeOpencodeJsonc(cfg) {
  const content = JSON.stringify(cfg, null, 2);
  try {
    await mkdir(dirname(OPENCODE_JSONC), { recursive: true });
    await atomicWrite(OPENCODE_JSONC, content);
    return { ok: true };
  } catch (e) {
    console.warn("[providers] write failed:", e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Apply a set of provider mutations and write opencode.jsonc back.
 * Does NOT restart opencode; the caller decides (prompt-before-restart).
 */
export async function setProviders(ops) {
  let cfg;
  try {
    cfg = await readRemoteConfig();
  } catch (e) {
    console.warn("[providers] refusing to write — config unparseable/unreadable:", e);
    return { ok: false, error: `${UNPARSEABLE_CONFIG_MSG} (refusing to overwrite)` };
  }
  for (const id of ops.remove ?? []) cfg = removeProviderBlock(cfg, id);
  for (const input of ops.upsert ?? []) cfg = upsertProviderBlock(cfg, input);
  return writeOpencodeJsonc(cfg);
}

/**
 * Read opencode.jsonc from the box and project it into the SubagentDef[]
 * shape the Settings SubagentsCard form expects. This is the config-reading
 * path: the card needs the configured subagent blocks (name/model/description).
 *
 * `readConfig` is injectable so the projection can be unit-tested without the
 * real ~/.config/opencode/opencode.jsonc file; it defaults to readRemoteConfig.
 * Returns [] if the config is absent or unparseable (the form degrades to an
 * empty list rather than throwing).
 */
export async function getSubagents(readConfig = readRemoteConfig) {
  try {
    const cfg = await readConfig();
    return readAgentBlocks(cfg);
  } catch (e) {
    console.warn("[providers] could not read subagent blocks:", e);
    return [];
  }
}

/**
 * Apply a set of subagent mutations and write opencode.jsonc back.
 * Does NOT restart opencode; the caller must do that manually.
 */
export async function setSubagents(ops) {
  let cfg;
  try {
    cfg = await readRemoteConfig();
  } catch (e) {
    console.warn("[providers] refusing to write — config unparseable/unreadable:", e);
    return { ok: false, error: `${UNPARSEABLE_CONFIG_MSG} (refusing to overwrite)` };
  }
  for (const name of ops.remove ?? []) cfg = removeAgentBlock(cfg, name);
  for (const input of ops.upsert ?? []) cfg = upsertAgentBlock(cfg, input);
  return writeOpencodeJsonc(cfg);
}

/**
 * Reconcile the full model list against opencode.jsonc's configured agent
 * blocks + the caller-supplied deactivated set (BET-123 "auto-register every
 * model" feature), then apply the diff via the EXISTING setSubagents writer
 * (never a second writer — hard constraint). Returns the resulting
 * SubagentDef[] projection, computed directly from the applied diff (no
 * re-read needed) so the result is exact even when `applySubagents` is
 * mocked in tests.
 *
 * A no-op diff (upsert.length === 0 && remove.length === 0) skips the write
 * entirely — this is what makes running it on every card open/toggle cheap
 * and idempotent.
 *
 * `readConfig`/`applySubagents` are injectable for tests; default to the
 * real readRemoteConfig/setSubagents. On a read failure, degrades to []
 * (logged) rather than throwing — same "form degrades gracefully" contract
 * as getSubagents/getProviderEndpoints. On a write failure, degrades to the
 * pre-sync existingAgents list (logged) so the card still renders something.
 */
export async function syncSubagents(
  { models = [], deactivated = [] } = {},
  readConfig = readRemoteConfig,
  applySubagents = setSubagents,
) {
  let cfg;
  try {
    cfg = await readConfig();
  } catch (e) {
    console.warn("[providers] could not read config for subagent sync:", e);
    return [];
  }
  const existingAgents = readAgentBlocks(cfg);
  const { upsert, remove } = reconcileSubagents({ models, existingAgents, deactivated });
  if (upsert.length === 0 && remove.length === 0) return existingAgents;

  const result = await applySubagents({ upsert, remove });
  if (!result.ok) {
    console.warn("[providers] subagent sync write failed:", result.error);
    return existingAgents;
  }

  // Project the applied diff directly rather than re-reading the file —
  // exact and testable without a real filesystem round-trip.
  const byName = new Map(existingAgents.map((a) => [a.name, a]));
  for (const name of remove) byName.delete(name);
  for (const a of upsert) byName.set(a.name, a);
  return [...byName.values()];
}
