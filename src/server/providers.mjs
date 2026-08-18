// providers.mjs — Provider management for the manta mobile server.
//
// Ports the pure helpers from src/main/providers.ts (parseModelsResponse,
// upsertProviderBlock, readProviderEndpoints,
// findStoredApiKey, stripUrlUserinfo) and adds server-side I/O functions:
//   discoverModels    — fetch <baseURL>/models directly (server IS the box)
//   setProviders      — read/merge/write opencode.jsonc locally
//
// The desktop's src/main/providers.ts SSH runners stay until Stage 2 deletion.
// This slice only adds the HTTP path. The RPC layer serves both (SSH + HTTP)
// until SSH is removed.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { reconcileSubagents } from "../shared/subagentSync.mjs";
import { restartOpencode } from "./opencodeAdmin.mjs";

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
// mobile server IS the box. WRITES go through opencode's own /global/config
// endpoint (the single authority that owns both the in-memory config and the
// file, and edits the .jsonc surgically so comments survive). The READ path
// below parses the file with jsonc-parser (opencode's own JSONC parser) — the
// comment-stripping regex that used to live here is deleted.
const OPENCODE_JSONC = join(homedir(), ".config", "opencode", "opencode.jsonc");
const OPENCODE_API = "http://127.0.0.1:4096/global/config";

// opencode's PATCH /global/config has no HTTP delete semantics (it deep-merges
// objects and rejects `null`), so a `remove` op can't be expressed through the
// single endpoint. Re-scoped out of BET-1019: setProviders/setSubagents REJECT
// removes with this message rather than writing the file directly (a direct
// write behind the endpoint's back is what made memory and disk diverge — a
// removed key resurrects on the next upsert PATCH). See BET-1033 for restoring
// deactivation through a vetted mechanism.
const REMOVE_UNSUPPORTED_MSG =
  "remove ops are not supported through the config endpoint (PATCH /global/config " +
  "has no delete semantics). Deactivation is pending a vetted mechanism — " +
  "nothing was changed.";

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
// ✕ on that row would route the block through upsertProviderBlock, overwriting
// it with npm:"@ai-sdk/openai-compatible" + empty baseURL and corrupting the
// plugin auth. They still appear in the model dropdown, which reads the live
// /provider endpoint instead.
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

// Insert or replace a single named agent. Only the `agent` key is touched;
// every other key in `cfg` is preserved by spread. `mode` defaults to
// "subagent" (the only config-writable agent type manta manages for the
// SubagentsCard). `permission` and `prompt` are carried through only when
// supplied — the BET-984 `manta-plan` primary agent needs both (a custom
// agent merges its own `permission` block AFTER opencode's deny-by-default
// `plan_enter`/`plan_exit`, so last-match wins and plan hand-off works).
export function upsertAgentBlock(cfg, input) {
  const agents = getAgentMap(cfg);
  agents[input.name] = {
    model: input.model,
    description: input.description,
    mode: input.mode ?? "subagent",
  };
  if (input.permission !== undefined) agents[input.name].permission = input.permission;
  if (input.prompt !== undefined) agents[input.name].prompt = input.prompt;
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
 * Read opencode.jsonc from the box and parse it with jsonc-parser (opencode's
 * own JSONC parser — no comment-stripping regex). Returns {} if the file is
 * absent. THROWS if the file exists but is unparseable — callers must NOT
 * overwrite an unparseable config.
 */
async function readRemoteConfig() {
  if (!existsSync(OPENCODE_JSONC)) return {};
  const raw = await readFile(OPENCODE_JSONC, "utf-8");
  const errors = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(UNPARSEABLE_CONFIG_MSG);
  }
  return parsed;
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
 * THE single opencode.jsonc write path: PATCH /global/config.
 *
 * opencode's endpoint is the single authority for what the config should be —
 * it owns both the in-memory config and the file, and edits the .jsonc
 * surgically so comments survive (verified live: a PATCH of one key leaves all
 * other lines byte-identical). Writes therefore go through it, never through a
 * hand-rolled read/merge/write (which is what used to strip comments and
 * silently discard an unparseable config).
 *
 * On ANY failure (network or non-2xx) returns { ok:false, error } with the
 * endpoint's error surfaced to the caller — there is deliberately NO fallback
 * that writes opencode.jsonc itself (a fallback would reintroduce the silent
 * data-loss bug this replaces).
 *
 * `patchGlobalConfig` is injectable so setProviders/setSubagents can be
 * unit-tested against a stub without touching the live opencode endpoint.
 */
export async function patchGlobalConfig(patch) {
  let res;
  try {
    res = await fetch(OPENCODE_API, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[providers] patch /global/config unreachable:", msg);
    return { ok: false, error: `opencode config endpoint unreachable: ${msg}` };
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* ignore read error on the error body */
    }
    console.warn(`[providers] patch /global/config failed: ${res.status}`, detail);
    return {
      ok: false,
      error: `opencode config update failed (${res.status}): ${String(detail ?? "").slice(0, 200)}`,
    };
  }
  return { ok: true };
}

/**
 * Shared core for setProviders / setSubagents — both are the same write-through
 * PATCH shape (reject `remove`, upsert each block via a builder, PATCH one
 * config key) with no HTTP delete semantics. `configKey` is "provider" or
 * "agent"; `keyFor(input)` and `build(input)` produce the per-entry key + block.
 */
async function patchBlocks(ops, deps, configKey, keyFor, build) {
  const patch = deps?.patch ?? patchGlobalConfig;
  const upserts = ops?.upsert ?? [];
  const removes = ops?.remove ?? [];

  if (removes.length > 0) {
    return { ok: false, error: REMOVE_UNSUPPORTED_MSG };
  }

  if (upserts.length === 0) return { ok: true };
  const collected = {};
  for (const input of upserts) {
    collected[keyFor(input)] = build(input);
  }
  return patch({ [configKey]: collected });
}

/**
 * Apply a set of provider mutations through opencode's config endpoint.
 * Upserts go through PATCH /global/config — the single authority that owns
 * both the in-memory config and the file. `remove` ops are NOT supported
 * (the endpoint has no delete semantics over HTTP: it deep-merges objects and
 * rejects `null`, so a key can't be removed through it) and are REJECTED with
 * an explicit error rather than written directly — writing the file behind the
 * endpoint's back would let memory and disk diverge (a removed key resurrects
 * on the next upsert PATCH). Restoring deactivation is tracked as follow-up
 * work. Does NOT restart opencode; the caller decides (prompt-before-restart).
 */
export async function setProviders(ops, deps = {}) {
  return patchBlocks(
    ops,
    deps,
    "provider",
    (input) => input.id,
    (input) => upsertProviderBlock({}, input).provider[input.id],
  );
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
 * Apply a set of subagent mutations through opencode's config endpoint.
 * Upserts go through PATCH /global/config — the single authority that owns
 * both the in-memory config and the file. `remove` ops are NOT supported (the
 * endpoint has no delete semantics over HTTP) and are REJECTED with an
 * explicit error rather than written directly — writing the file behind the
 * endpoint's back would let memory and disk diverge (a removed block
 * resurrects on the next upsert PATCH). Restoring deactivation is tracked as
 * follow-up work. Does NOT restart opencode; the caller must do that manually.
 */
export async function setSubagents(ops, deps = {}) {
  return patchBlocks(
    ops,
    deps,
    "agent",
    (input) => input.name,
    (input) => upsertAgentBlock({}, input).agent[input.name],
  );
}

/**
 * Apply the user's configured skill-registry URLs to opencode's `skills.urls`
 * via PATCH /global/config — the single opencode.jsonc writer (BET-1019).
 * The renderer persists the list to config.json via config:update; this is the
 * server-side half of BET-1031 that actually makes opencode honor it
 * (previously nothing on the server read skillRegistryUrls into opencode, so
 * adding a registry in Settings "saved" but did nothing).
 *
 * The endpoint deep-merges `skills`, so unrelated skills keys (e.g. `command`)
 * are untouched. Does NOT restart opencode; like providers/subagents, opencode
 * only re-reads `skills` at startup and the caller decides whether to restart.
 */
export async function setSkillRegistryUrls(urls = [], deps = {}) {
  const patch = deps.patch ?? patchGlobalConfig;
  return patch({ skills: { urls: Array.isArray(urls) ? urls : [] } });
}

/**
 * Upsert opencode references (BET-1023) through THE single opencode.jsonc
 * write path — PATCH /global/config (the same `patchGlobalConfig` used by
 * setProviders/setSubagents; never a second writer).
 *
 * A reference entry is written as an explicit object — either
 *   { path, description? }            for a local directory, or
 *   { repository, branch?, description? }  for a git repository
 * — never as a bare shorthand string, so the config stays unambiguous and
 * keyed by the alias the user declared.
 *
 * `remove` ops are REJECTED with an explicit error, mirroring
 * REMOVE_UNSUPPORTED_MSG: opencode's PATCH /global/config has no HTTP delete
 * semantics (it deep-merges objects and rejects `null`), so a reference alias
 * can't be removed through the single endpoint. Restoring removal is tracked
 * as follow-up work alongside BET-1033.
 *
 * `patch` is injectable for unit tests; defaults to patchGlobalConfig.
 */
export async function setReferences(ops, deps = {}) {
  const patch = deps.patch ?? patchGlobalConfig;
  const upserts = ops?.upsert ?? [];
  const removes = ops?.remove ?? [];

  if (removes.length > 0) {
    return { ok: false, error: REMOVE_UNSUPPORTED_MSG };
  }

  if (upserts.length === 0) return { ok: true };

  const referencesPatch = {};
  for (const input of upserts) {
    const { alias } = input;
    if (!alias) continue;
    const entry = {};
    if (input.repository) {
      entry.repository = input.repository;
      if (input.branch) entry.branch = input.branch;
    } else {
      entry.path = input.path;
    }
    if (input.description) entry.description = input.description;
    referencesPatch[alias] = entry;
  }
  if (Object.keys(referencesPatch).length === 0) return { ok: true };
  return patch({ references: referencesPatch });
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
  { models = [], deactivated = [], optIn = [] } = {},
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
  const { upsert, remove } = reconcileSubagents({ models, existingAgents, deactivated, optIn });
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

// ---------------------------------------------------------------------------
// manta-plan — the MantaUI-owned primary planning agent (BET-984)
// ---------------------------------------------------------------------------

export const MANTA_PLAN_AGENT_NAME = "manta-plan";

// The planning prompt ships in the repo (committed under docs/), so it exists
// at the same relative location in a dev checkout and a release tarball (both
// of which re-materialize the full source tree on the box). The opencode
// config references it by absolute path; resolved from this module's own URL
// (src/server/providers.mjs → ../../ → repo root) like opencodeAdmin does for
// scripts/self-update.sh.
const MANTA_PLAN_PROMPT_REL = "../../docs/opencode/skills/manta-plan/prompt.md";

export function mantaPlanPromptPath(fromMetaUrl = import.meta.url) {
  return fileURLToPath(new URL(MANTA_PLAN_PROMPT_REL, fromMetaUrl));
}

// Assemble a primary-agent block object. Shared by the manta-plan and cto
// agents — both are the same "a selectable primary agent with a file-based
// prompt + permission block" shape; only the content differs. `model` is left
// unset (inherit the session default) unless provided.
function agentBlock({ name, description, permission, promptPath, model }) {
  const block = {
    name,
    mode: "primary",
    description,
    permission,
    prompt: `{file:${promptPath}}`,
  };
  if (typeof model === "string" && model) block.model = model;
  return block;
}

export function mantaPlanAgentBlock(promptPath) {
  return agentBlock({
    name: MANTA_PLAN_AGENT_NAME,
    // mode primary (NOT subagent) — BET-983 only offers `mode !== "subagent"`
    // agents in the composer's Plan target selection.
    description: "Research a request and produce a structured, buildable plan.",
    // opencode merges each agent's permission block AFTER its shared defaults
    // (which deny plan_enter/plan_exit for every agent); these allows are what
    // make the plan-exit → build hand-off possible.
    permission: {
      plan_exit: "allow",
      plan_enter: "allow",
      edit: { "*": "ask", ".opencode/plans/**": "allow" },
      bash: "ask",
    },
    promptPath,
  });
}

/**
 * Shared installer/ensurer core for a box-side opencode agent block.
 * Idempotent (a no-op diff when the named block already exists) and never
 * throws — I/O/restart failures log and return `{ ok:false }` so the startup
 * wire-in can fire-and-forget. Both ensureMantaPlanAgent and ensureCtoAgent
 * delegate here; keep them thin wrappers.
 *
 * @param {object} o
 * @param {string} o.agentName
 * @param {() => object} o.buildBlock
 * @param {() => Promise<object>} o.readConfig
 * @param {(ops) => Promise<{ok: boolean, error?: string}>} o.applySubagents
 * @param {() => Promise<{ok: boolean, error?: string}>} o.restart
 * @param {string} o.logPrefix
 * @param {{warn?: Function, error?: Function}} o.log
 * @returns {Promise<{ok: boolean, changed: boolean, reason?: string, error?: string}>}
 */
async function runEnsureAgent({ agentName, buildBlock, readConfig, applySubagents, restart, logPrefix, log }) {
  try {
    let cfg;
    try {
      cfg = await readConfig();
    } catch (e) {
      log.warn?.(`[providers] ${logPrefix}: config unreadable, skipping install:`, e);
      return { ok: false, changed: false, reason: "unreadable" };
    }
    if (cfg?.agent?.[agentName]) {
      return { ok: true, changed: false };
    }
    const result = await applySubagents({ upsert: [buildBlock()] });
    if (!result.ok) {
      log.warn?.(`[providers] ${logPrefix}: write failed:`, result.error);
      return { ok: false, changed: false, error: result.error };
    }
    const restartResult = await restart();
    if (!restartResult.ok) {
      log.warn?.(`[providers] ${logPrefix}: restart after install failed:`, restartResult.error);
    }
    return { ok: true, changed: true };
  } catch (e) {
    log.error?.(`[providers] ${logPrefix}:`, e);
    return { ok: false, changed: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Best-effort installer/ensurer for the box-side `manta-plan` primary agent
 * block in opencode.jsonc.
 *
 * `readConfig`/`applySubagents`/`restart`/`promptPath` are injectable for
 * tests; defaults hit the real box (readRemoteConfig, setSubagents,
 * restartOpencode) exactly like production.
 *
 * @param {object} [deps]
 * @param {() => Promise<object>} [deps.readConfig]
 * @param {(ops) => Promise<{ok: boolean, error?: string}>} [deps.applySubagents]
 * @param {() => Promise<{ok: boolean, error?: string}>} [deps.restart]
 * @param {string} [deps.promptPath]
 * @param {{warn?: Function, error?: Function}} [deps.log]
 * @returns {Promise<{ok: boolean, changed: boolean, reason?: string, error?: string}>}
 */
export async function ensureMantaPlanAgent(deps = {}) {
  const {
    readConfig = readRemoteConfig,
    applySubagents = setSubagents,
    restart = restartOpencode,
    promptPath = mantaPlanPromptPath(),
    log = console,
  } = deps;
  return runEnsureAgent({
    agentName: MANTA_PLAN_AGENT_NAME,
    buildBlock: () => mantaPlanAgentBlock(promptPath),
    readConfig,
    applySubagents,
    restart,
    logPrefix: "ensureMantaPlanAgent",
    log,
  });
}

// ---------------------------------------------------------------------------
// On-call CTO agent (BET-1164, issue 1/3)
// ---------------------------------------------------------------------------
// A `cto` primary agent carrying the deterministic read tool belt (exposed to
// opencode as the global `cto` custom tool — see docs/opencode-tools/cto.ts);
// this block just gives the agent a prompt + makes it selectable as a normal
// chat session. Mirrors the manta-plan block/ensurer below.
export const CTO_AGENT_NAME = "cto";

// Committed under docs/ so it exists at the same relative location in a dev
// checkout and a release tarball (both re-materialize the full source tree).
const CTO_PROMPT_REL = "../../docs/opencode/skills/cto/prompt.md";

export function ctoPromptPath(fromMetaUrl = import.meta.url) {
  return fileURLToPath(new URL(CTO_PROMPT_REL, fromMetaUrl));
}

export function ctoAgentBlock(promptPath, model) {
  return agentBlock({
    name: CTO_AGENT_NAME,
    // mode primary (NOT subagent) — the cto agent is selectable as a normal
    // chat session ("ask the on-call CTO what's running"), and modify access
    // is bounded below to the read-only `cto` tool.
    description:
      "On-call CTO: answer what's running, git state, usage/stopped conversations, " +
      "plan mode, context state and the Multica board via deterministic read-only tools.",
    permission: { cto: "allow" },
    promptPath,
    model,
  });
}

/**
 * Best-effort installer/ensurer for the box-side `cto` primary agent block in
 * opencode.jsonc. Idempotent (a no-op diff when the block already exists) and
 * never throws — I/O/restart failures log and return `{ ok:false }` so the
 * startup wire-in can fire-and-forget. Injected deps default to the real box
 * (readRemoteConfig / setSubagents / restartOpencode) exactly like
 * ensureMantaPlanAgent.
 *
 * Gated by `cto.enabled`: with the feature off (the default until shipped)
 * the caller simply does not invoke this.
 *
 * @param {object} [deps]
 * @param {() => Promise<object>} [deps.readConfig]
 * @param {(ops) => Promise<{ok: boolean, error?: string}>} [deps.applySubagents]
 * @param {() => Promise<{ok: boolean, error?: string}>} [deps.restart]
 * @param {string} [deps.promptPath]
 * @param {string} [deps.model]
 * @param {{warn?: Function, error?: Function}} [deps.log]
 * @returns {Promise<{ok: boolean, changed: boolean, reason?: string, error?: string}>}
 */
export async function ensureCtoAgent(deps = {}) {
  const {
    readConfig = readRemoteConfig,
    applySubagents = setSubagents,
    restart = restartOpencode,
    promptPath = ctoPromptPath(),
    model,
    log = console,
  } = deps;
  return runEnsureAgent({
    agentName: CTO_AGENT_NAME,
    buildBlock: () => ctoAgentBlock(promptPath, model),
    readConfig,
    applySubagents,
    restart,
    logPrefix: "ensureCtoAgent",
    log,
  });
}
