// providers.mjs — Provider management for the manta mobile server.
//
// Ports the pure helpers from src/main/providers.ts (parseModelsResponse,
// upsertProviderBlock, readProviderEndpoints,
// findStoredApiKey, stripUrlUserinfo) and adds server-side I/O functions:
//   discoverModels    — fetch <baseURL>/models directly (server IS the box)
//   setProviders      — read/merge/write opencode.jsonc locally
//
// OpenCode V2: every config write is ONE surgical jsonc edit of
// ~/.config/opencode/opencode.jsonc (comments preserved) followed by
// `POST /api/location/reload`. V2 re-reads its config live, so a turn that is
// running during the reload completes untouched — nothing here restarts
// opencode any more (see opencodeAdmin.reloadOpencodeConfig).

import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, modify, applyEdits } from "jsonc-parser";
import { reconcileSubagents } from "../shared/subagentSync.mjs";
import { reloadOpencodeConfig, listOpencodeModels } from "./opencodeAdmin.mjs";
import { statePath, uploadRoot } from "../shared/paths.mjs";
import { composeCtoPrompt } from "./ctoDoctrine.mjs";

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

// opencode.jsonc lives at ~/.config/opencode/opencode.jsonc on the box (opencode
// honours XDG_CONFIG_HOME, so do we). The READ path parses the file with
// jsonc-parser (opencode's own JSONC parser). `MANTA_OPENCODE_CONFIG` is a
// test/harness seam only — production never sets it.
export function opencodeConfigPath(env = process.env) {
  if (env.MANTA_OPENCODE_CONFIG) return env.MANTA_OPENCODE_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "opencode", "opencode.jsonc");
}

const UNPARSEABLE_CONFIG_MSG =
  "opencode.jsonc on the box is unparseable — fix it manually first.";

const FORMAT = { insertSpaces: true, tabSize: 2 };

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function parseConfigText(text) {
  const errors = [];
  const parsed = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isPlainObject(parsed)) return null;
  return parsed;
}

function valueAt(root, path) {
  let cur = root;
  for (const key of path) {
    if (!isPlainObject(cur) && !Array.isArray(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

// Delete `path`, then prune ancestors the delete left EMPTY ({}), stopping at
// the top-level key. A TTL removal must not leave a stray
// `"models": { "x": { "options": {} } }` skeleton behind.
function removePath(text, path) {
  // Deleting something that is not there is a success (and jsonc-parser throws
  // when an ancestor is missing), so check first.
  const cfg = parseConfigText(text);
  if (!cfg || valueAt(cfg, path) === undefined) return text;
  let out = applyEdits(text, modify(text, path, undefined, { formattingOptions: FORMAT }));
  for (let depth = path.length - 1; depth >= 2; depth--) {
    const parent = path.slice(0, depth);
    const cfg = parseConfigText(out);
    const v = cfg ? valueAt(cfg, parent) : undefined;
    if (isPlainObject(v) && Object.keys(v).length === 0) {
      out = applyEdits(out, modify(out, parent, undefined, { formattingOptions: FORMAT }));
    } else {
      break;
    }
  }
  return out;
}

async function defaultReadText(path) {
  try {
    return await readFile(path, "utf-8");
  } catch (e) {
    if (e?.code === "ENOENT") return "";
    throw e;
  }
}

async function defaultWriteText(path, text) {
  await mkdir(dirname(path), { recursive: true });
  // The file can carry provider apiKeys: keep an existing file's mode, create
  // a new one 0600.
  let mode = 0o600;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch {
    /* new file */
  }
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, { encoding: "utf-8", mode });
  await rename(tmp, path);
}

// The one in-process lock: every edit is a read-modify-write of the same file,
// so two concurrent writers (a subagent sync racing a cache-TTL change) would
// otherwise lose one of the edits.
let editChain = Promise.resolve();

/**
 * THE single opencode.jsonc writer. Everything that changes the config — provider
 * endpoints, subagents, references, skill registries, cache TTL, the CTO agents —
 * goes through here, so there is exactly one place that reads, edits, writes
 * and reloads.
 *
 * `edits` is an array of `{ path: string[], value }` (`value === undefined`
 * deletes the key and prunes ancestors it leaves empty) — or a function
 * `(parsedConfig) => edits` evaluated INSIDE the lock against the file as it is
 * at that moment (read-modify-write without a lost-update window).
 *
 * Steps: read (absent file = `{}`) → refuse an unparseable file (never
 * overwritten) → surgical `jsonc-parser` edits (comments and untouched keys
 * survive) → no-op when nothing changed (no write, no reload) → atomic write →
 * `POST /api/location/reload`.
 *
 * Returns `{ ok, changed, reloaded, error? }`. A reload that the server REJECTS
 * is `ok:false` (the live config may still be the old one); opencode simply
 * not running is `ok:true, reloaded:false` — the edit is on disk and applies
 * at its next start.
 *
 * `readText` / `writeText` / `reload` / `path` are injectable for tests.
 */
export function editConfig(edits, deps = {}) {
  const run = editChain.then(() => editConfigNow(edits, deps));
  editChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function editConfigNow(edits, deps) {
  const path = deps.path ?? opencodeConfigPath();
  const readText = deps.readText ?? (() => defaultReadText(path));
  const writeText = deps.writeText ?? ((text) => defaultWriteText(path, text));
  const reload = deps.reload ?? reloadOpencodeConfig;
  try {
    const input = await readText();
    const base = input.trim() === "" ? "{}" : input;
    const cfg = parseConfigText(base);
    if (!cfg) return { ok: false, changed: false, reloaded: false, error: UNPARSEABLE_CONFIG_MSG };

    const list = typeof edits === "function" ? await edits(cfg) : edits;
    let text = base;
    for (const edit of list ?? []) {
      if (edit.value === undefined) {
        text = removePath(text, edit.path);
      } else {
        text = applyEdits(text, modify(text, edit.path, edit.value, { formattingOptions: FORMAT }));
      }
    }
    // Nothing matched / nothing differs — a no-op is a success, and must not
    // trigger a reload (or even a write: an untouched file stays untouched).
    if (text === base) return { ok: true, changed: false, reloaded: false };

    await writeText(text);
    const r = await reload();
    if (!r.ok) return { ok: false, changed: true, reloaded: false, error: r.error };
    return { ok: true, changed: true, reloaded: r.reloaded === true };
  } catch (e) {
    return { ok: false, changed: false, reloaded: false, error: e instanceof Error ? e.message : String(e) };
  }
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
//
// The block lists exactly the SELECTED models. For a provider id that matches
// one in opencode's built-in catalog (e.g. "openrouter", ~385 models) that is
// not enough on its own — V2 merges the catalog in regardless (and, unlike V1,
// ignores a `whitelist`); the rest are hidden by `disabledMarkerOps` below.
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

// Model ids the config hides: `providers.<id>.models.<m>.disabled === true`.
// This is V2's NATIVE provider key — the V1-format `provider` key's per-model
// `disabled` is dropped by V2's loader (proven on the pinned binary: 385 → 385),
// the native one removes the model from the list (385 → 384). It is the V2
// replacement for V1's `whitelist`.
export function disabledModelIds(cfg, providerID) {
  const models = cfg?.providers?.[providerID]?.models;
  if (!isPlainObject(models)) return [];
  return Object.entries(models)
    .filter(([, m]) => isPlainObject(m) && m.disabled === true)
    .map(([id]) => id);
}

/**
 * PURE. The config edit that makes `providers.<id>.models` hide every model in
 * `visibleIds` (what V2 currently lists for the provider) plus every model
 * already hidden, EXCEPT the selected ones. Marker-only: other keys under
 * `providers.<id>` that are not manta's disable markers are left alone, and an
 * empty result removes the block. Returns null when nothing needs to change.
 */
export function disabledMarkerOps(cfg, providerID, enabledModels, visibleIds = []) {
  const enabled = new Set(enabledModels);
  const prev = new Set(disabledModelIds(cfg, providerID));
  const want = new Set([...prev, ...visibleIds].filter((id) => !enabled.has(id)));
  if (want.size === prev.size && [...want].every((id) => prev.has(id))) return null;

  const existing = cfg?.providers?.[providerID]?.models;
  const keep = {};
  if (isPlainObject(existing)) {
    for (const [id, m] of Object.entries(existing)) {
      const isMarkerOnly = isPlainObject(m) && m.disabled === true && Object.keys(m).length === 1;
      if (!isMarkerOnly) keep[id] = m;
    }
  }
  for (const id of want) keep[id] = { disabled: true };
  const path = ["providers", providerID, "models"];
  if (Object.keys(keep).length === 0) return [{ path, value: undefined }];
  return [{ path, value: keep }];
}

// Project the config's provider map down to renderer-safe metadata. Never
// includes the apiKey value — only whether one is present — and scrubs any
// credential embedded in the baseURL.
//
// ONLY blocks with an options.baseURL are projected: the ProvidersCard is the
// manager for OpenAI-compatible ENDPOINTS, and a baseURL is definitional for
// those. Plugin-authed providers (e.g. the `anthropic` block used by
// the Claude Max plugin) have no baseURL and MUST be excluded — rendering them
// in the card gives them a Refresh button that fetches `"" + "/models"`
// ("unreachable: could not reach the endpoint"), and worse, a model toggle or
// ✕ on that row would route the block through upsertProviderBlock, overwriting
// it with npm:"@ai-sdk/openai-compatible" + empty baseURL and corrupting the
// plugin auth. They still appear in the model dropdown, which reads the live
// model list instead.
export function readProviderEndpoints(cfg) {
  const providers = getProviderMap(cfg);
  return Object.entries(providers)
    .filter(([, block]) => Boolean(block.options?.baseURL))
    .map(([id, block]) => {
      const hidden = new Set(disabledModelIds(cfg, id));
      return {
        id,
        name: typeof block.name === "string" ? block.name : id,
        baseURL: stripUrlUserinfo(block.options.baseURL),
        hasApiKey: Boolean(block.options?.apiKey),
        // The selection is the block's own `models`, minus anything the
        // native `providers` key hides. A legacy V1 `whitelist` (written
        // before the cutover, inert in V2) still wins for DISPLAY so the card
        // shows what the user chose until the endpoint is re-saved or
        // migrateLegacyWhitelists() rewrites it.
        enabledModels: Array.isArray(block.whitelist)
          ? block.whitelist.filter((m) => typeof m === "string")
          : Object.keys(block.models ?? {}).filter((m) => !hidden.has(m)),
      };
    });
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
  if (input.disable !== undefined) agents[input.name].disable = input.disable;
  if (input.prompt !== undefined) agents[input.name].prompt = input.prompt;
  return { ...cfg, agent: agents };
}

// Project the config's agent map down to SubagentDef[]. ONLY blocks with a
// `model` string are projected — this filters out opencode's built-in agents
// (which have no model in config) so the UI never renders/clobbers them.
// Primary roles are not subagents: disabling their model for task workers
// must never delete the CTO (or a user's primary agent).
export function readAgentBlocks(cfg) {
  const agents = getAgentMap(cfg);
  return Object.entries(agents)
    .filter(([, block]) => block.mode !== "primary" && typeof block.model === "string" && block.model)
    .map(([name, block]) => ({
      name,
      model: block.model,
      description: typeof block.description === "string" ? block.description : "",
    }));
}

// ---------------------------------------------------------------------------
// I/O-dependent functions (server-side)
// ---------------------------------------------------------------------------

/**
 * Read opencode.jsonc from the box and parse it with jsonc-parser (opencode's
 * own JSONC parser — no comment-stripping regex). Returns {} if the file is
 * absent. THROWS if the file exists but is unparseable — callers must NOT
 * overwrite an unparseable config.
 */
async function readRemoteConfig() {
  const raw = await defaultReadText(opencodeConfigPath());
  if (raw.trim() === "") return {};
  const parsed = parseConfigText(raw);
  if (!parsed) throw new Error(UNPARSEABLE_CONFIG_MSG);
  return parsed;
}

// BET-1395 (Adaptive CTO §7.1-3): the tool scan's config-surface seam reads
// opencode.jsonc for MCP servers — same reader, exported so the scan doesn't
// grow a second jsonc parser.
export async function readOpencodeConfig() {
  return readRemoteConfig();
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
 * Apply a set of provider mutations. Upserts replace the whole
 * `provider.<id>` block (keeping the keys manta does not manage — headers and
 * per-model options such as a cache TTL — of the block that was there), removes
 * delete it together with any `providers.<id>` disable markers. Everything is
 * ONE edit, one write and one reload. After the reload, each upserted
 * endpoint's selection is reconciled against what V2 actually lists for it
 * (see disabledMarkerOps): a catalog provider such as "openrouter" keeps its
 * ~385 built-in models unless the unselected ones are hidden.
 *
 * `deps.listModelIds(providerID)` (default: V2's model list) is the catalog
 * source; it is injectable so the suite never needs a live opencode.
 */
export async function setProviders(ops, deps = {}) {
  const upserts = ops?.upsert ?? [];
  const removes = ops?.remove ?? [];
  if (upserts.length === 0 && removes.length === 0) return { ok: true };

  const r = await editConfig((cfg) => {
    const edits = [];
    for (const input of upserts) {
      const prev = cfg.provider?.[input.id];
      const block = upsertProviderBlock({}, input).provider[input.id];
      if (prev?.options?.apiKey !== undefined && input.apiKey === undefined) block.options.apiKey = prev.options.apiKey;
      const models = {};
      for (const [mid, m] of Object.entries(block.models)) {
        const old = isPlainObject(prev?.models?.[mid]) ? prev.models[mid] : {};
        models[mid] = { ...old, ...m };
      }
      const merged = { ...(isPlainObject(prev) ? prev : {}), ...block, models };
      delete merged.whitelist; // inert in V2; the native disable markers replace it
      merged.options = { ...(isPlainObject(prev?.options) ? prev.options : {}), ...block.options };
      edits.push({ path: ["provider", input.id], value: merged });
    }
    for (const id of removes) {
      edits.push({ path: ["provider", id], value: undefined });
      edits.push({ path: ["providers", id], value: undefined });
    }
    return edits;
  }, deps);
  if (!r.ok) return r;

  for (const input of upserts) {
    const sel = await applyModelSelection(input.id, input.enabledModels ?? [], deps);
    if (!sel.ok) return sel;
  }
  return { ok: true };
}

// Reconcile one provider's hidden-model markers with its selection. Non-fatal
// when V2 cannot list models (opencode down): the markers that already exist
// are still pruned for re-enabled models, and the next save re-applies.
//
// The reload returns before V2's model registry has caught up (measured: the
// 204 comes back ~2s in and the new provider is listable up to ~0.5s later), so
// the catalog is read until it contains at least one SELECTED model — the sign
// the block is live — for at most `settleMs`. Without a selection there is
// nothing to wait for.
async function applyModelSelection(providerID, enabledModels, deps) {
  const list = deps.listModelIds ?? listProviderModelIds;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const settleMs = deps.settleMs ?? 4000;
  const enabled = new Set(enabledModels);
  let visible = [];
  try {
    const deadline = Date.now() + settleMs;
    for (;;) {
      visible = await list(providerID);
      if (enabled.size === 0 || visible.some((id) => enabled.has(id)) || Date.now() >= deadline) break;
      await sleep(200);
    }
  } catch (e) {
    console.warn(`[providers] could not list ${providerID} models to reconcile the selection:`, e instanceof Error ? e.message : e);
  }
  return editConfig((cfg) => disabledMarkerOps(cfg, providerID, enabledModels, visible) ?? [], deps);
}

async function listProviderModelIds(providerID) {
  const models = await listOpencodeModels();
  return models.filter((m) => m.providerID === providerID).map((m) => m.modelID ?? m.id);
}

/**
 * One-shot cutover helper: rewrite every endpoint still carrying a V1
 * `whitelist` (inert in V2, where it silently lists the whole catalog) into the
 * V2 form — the selection stays in `models`, the `whitelist` is dropped and the
 * unselected catalog models are hidden by native `disabled` markers. Idempotent;
 * a config with no `whitelist` is a no-op (no write, no reload).
 */
export async function migrateLegacyWhitelists(deps = {}) {
  let cfg;
  try {
    cfg = await (deps.readConfig ?? readRemoteConfig)();
  } catch (e) {
    return { ok: false, migrated: [], error: e instanceof Error ? e.message : String(e) };
  }
  const todo = Object.entries(getProviderMap(cfg)).filter(([, b]) => Array.isArray(b?.whitelist));
  if (todo.length === 0) return { ok: true, migrated: [] };
  const r = await editConfig(
    (live) =>
      Object.entries(getProviderMap(live))
        .filter(([, b]) => Array.isArray(b?.whitelist))
        .flatMap(([id, b]) => {
          const selected = b.whitelist.filter((m) => typeof m === "string");
          const models = { ...(isPlainObject(b.models) ? b.models : {}) };
          for (const m of selected) models[m] = { id: m, name: m, ...(isPlainObject(models[m]) ? models[m] : {}) };
          return [
            { path: ["provider", id, "models"], value: models },
            { path: ["provider", id, "whitelist"], value: undefined },
          ];
        }),
    deps,
  );
  if (!r.ok) return { ok: false, migrated: [], error: r.error };
  for (const [id, b] of todo) {
    const sel = await applyModelSelection(id, b.whitelist.filter((m) => typeof m === "string"), deps);
    if (!sel.ok) return { ok: false, migrated: [], error: sel.error };
  }
  return { ok: true, migrated: todo.map(([id]) => id) };
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
 * Apply a set of subagent mutations: upserts write `agent.<name>` (replacing
 * the manta-managed keys, keeping any others), removes delete the block — one
 * edit, one write, one reload. V2 hot-applies the result, so deactivating a
 * subagent no longer restarts opencode (a restart used to end every running
 * turn on the box).
 */
export async function setSubagents(ops, deps = {}) {
  const upserts = ops?.upsert ?? [];
  const removes = ops?.remove ?? [];
  if (upserts.length === 0 && removes.length === 0) return { ok: true };
  const r = await editConfig((cfg) => {
    const edits = [];
    for (const input of upserts) {
      const prev = cfg.agent?.[input.name];
      const block = upsertAgentBlock({}, input).agent[input.name];
      edits.push({ path: ["agent", input.name], value: { ...(isPlainObject(prev) ? prev : {}), ...block } });
    }
    for (const name of removes) edits.push({ path: ["agent", name], value: undefined });
    return edits;
  }, deps);
  return r.ok ? { ok: true } : r;
}

/**
 * Apply the user's configured skill-registry URLs to opencode's `skills.urls`.
 * The renderer persists the list to config.json via config:update; this is the
 * server-side half (BET-1031) that actually makes opencode honor it. Only
 * `skills.urls` is written, so unrelated `skills` keys are untouched. V2
 * re-reads `skills` on reload, so the change is live.
 */
export async function setSkillRegistryUrls(urls = [], deps = {}) {
  const r = await editConfig([{ path: ["skills", "urls"], value: Array.isArray(urls) ? urls : [] }], deps);
  return r.ok ? { ok: true } : r;
}

/**
 * Upsert or remove opencode references (BET-1023) through the single writer.
 * A reference entry is written as an explicit object — either
 *   { path, description? }            for a local directory, or
 *   { repository, branch?, description? }  for a git repository
 * — never as a bare shorthand string, so the config stays unambiguous and
 * keyed by the alias the user declared. An upsert REPLACES the alias's entry
 * (switching it from a path to a repository must not keep the old path).
 * `remove` deletes the alias.
 */
export async function setReferences(ops, deps = {}) {
  const upserts = ops?.upsert ?? [];
  const removes = ops?.remove ?? [];
  const edits = [];
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
    edits.push({ path: ["references", alias], value: entry });
  }
  for (const alias of removes) edits.push({ path: ["references", alias], value: undefined });
  if (edits.length === 0) return { ok: true };
  const r = await editConfig(edits, deps);
  return r.ok ? { ok: true } : r;
}

/**
 * Reconcile the full model list against opencode.jsonc's configured agent
 * blocks + the caller-supplied deactivated set (BET-123 "auto-register every
 * model" feature), then apply the diff via setSubagents (the single writer;
 * V2 reloads live, so no restart follows). Returns the resulting
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
  const reservedNames = Object.keys(getAgentMap(cfg));
  const { upsert, remove } = reconcileSubagents({ models, existingAgents, deactivated, optIn, reservedNames });
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
 * throws — I/O failures log and return `{ ok:false }` so the startup
 * wire-in can fire-and-forget. Both ensureMantaPlanAgent and ensureCtoAgent
 * delegate here; keep them thin wrappers. The write is hot-applied by V2's
 * config reload — there is no restart to defer or fail.
 *
 * @param {object} o
 * @param {string} o.agentName
 * @param {() => object} o.buildBlock
 * @param {() => Promise<object>} o.readConfig
 * @param {(ops) => Promise<{ok: boolean, error?: string}>} o.applySubagents
 * @param {string} o.logPrefix
 * @param {{warn?: Function, error?: Function}} o.log
 * @returns {Promise<{ok: boolean, changed: boolean, reason?: string, error?: string}>}
 */
async function runEnsureAgent({ agentName, buildBlock, readConfig, applySubagents, logPrefix, log }) {
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
 * `readConfig`/`applySubagents`/`promptPath` are injectable for tests;
 * defaults hit the real box (readRemoteConfig, setSubagents) exactly like
 * production.
 *
 * @param {object} [deps]
 * @param {() => Promise<object>} [deps.readConfig]
 * @param {(ops) => Promise<{ok: boolean, error?: string}>} [deps.applySubagents]
 * @param {string} [deps.promptPath]
 * @param {{warn?: Function, error?: Function}} [deps.log]
 * @returns {Promise<{ok: boolean, changed: boolean, reason?: string, error?: string}>}
 */
export async function ensureMantaPlanAgent(deps = {}) {
  const {
    readConfig = readRemoteConfig,
    applySubagents = setSubagents,
    promptPath = mantaPlanPromptPath(),
    log = console,
  } = deps;
  return runEnsureAgent({
    agentName: MANTA_PLAN_AGENT_NAME,
    buildBlock: () => mantaPlanAgentBlock(promptPath),
    readConfig,
    applySubagents,
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
    description:
      "CTO orchestrator: discover project context, dispatch tracked work into project workers, verify delivery and report outcomes.",
    // Fail closed for implementation tools AND future tools. In particular,
    // task/delegate would bypass explicit project targeting and work tracking.
    permission: {
      "*": "deny",
      cto_cto: "allow",
      "cto-fact_cto_fact": "allow",
      "cto-verdict_cto_verdict": "allow",
      notify_notify: "allow",
      // Only this conversation's uploads need direct filesystem access.
      // Gather project context through the gateway, not arbitrary secret files.
      read: { "*": "deny", [`${uploadRoot()}/__manta_cto_conversation__/**`]: "allow" },
      external_directory: { "*": "deny", [`${uploadRoot()}/__manta_cto_conversation__/**`]: "allow" },
      question: "allow",
      todowrite: "allow",
    },
    promptPath,
    model,
  });
}

/**
 * Best-effort installer/ensurer for the box-side `cto` / `cto-plan` primary
 * agent blocks in opencode.jsonc. Reconciles the managed role boundary and
 * never throws — failures log and return `{ ok:false }` so the startup
 * wire-in can fire-and-forget.
 *
 * WHY EACH BLOCK IS WRITTEN WHOLE: a `permission` object is evaluated by
 * opencode as an ORDERED rule list, last match wins, so
 * `{"*":"deny", question:"allow"}` allows `question` while the reverse order
 * denies it — the comparison below is therefore deliberately order-sensitive.
 * A leaf-by-leaf merge cannot repair a block whose keys are in the wrong order,
 * so a differing block is replaced as a whole, in the desired key order, and
 * the file loader preserves that order (stable: the next boot sees no
 * difference).
 *
 * All changed agents are folded into ONE edit, ONE file write and ONE config
 * reload (V2 hot-applies it; no opencode restart exists to defer). When
 * nothing differs it is a pure read (no write, no reload).
 *
 * @param {object} [deps]
 * @param {() => Promise<string>} [deps.readText]  opencode.jsonc text ("" / "{}" when absent)
 * @param {(text: string) => Promise<void>} [deps.writeText]  atomic write of the file
 * @param {() => Promise<{ok: boolean, reloaded?: boolean, error?: string}>} [deps.reload]
 * @param {string} [deps.promptPath]
 * @param {string} [deps.model]
 * @param {{warn?: Function, error?: Function}} [deps.log]
 * @returns {Promise<{ok: boolean, changed: boolean, reason?: string, error?: string}>}
 */
export async function ensureCtoAgent(deps = {}) {
  const {
    // The agent block points at the MATERIALIZED prompt (this doctrine work),
    // not the committed file directly — see "CTO operating doctrine" below.
    // `materializeCtoPrompt` guarantees this fixed path always holds SOME
    // valid prompt content (the composed doctrine, or the committed prompt
    // verbatim as a fallback) before this block is ever written, so the
    // agent is never pointed at a file that doesn't exist yet.
    promptPath = ctoMaterializedPromptPath(),
    model,
    log = console,
    ...editDeps
  } = deps;
  // Reconcile both role variants. Planning retains the local capability
  // boundary; the gateway separately refuses project mutations in plan turns.
  const r = await editConfig((cfg) => {
    const edits = [];
    for (const name of [CTO_AGENT_NAME, `${CTO_AGENT_NAME}-plan`]) {
      const existing = cfg?.agent?.[name];
      const desired = ctoAgentBlock(promptPath, existing?.model ?? model);
      desired.name = name;
      desired.disable = false; // the server-owned role follows cto.enabled
      if (name.endsWith("-plan")) {
        desired.description = "CTO planning: discuss scope and propose a plan; project mutations are disabled.";
        desired.prompt += "\n\nPLAN ONLY: discuss scope and propose a plan. Do not dispatch implementation or mutate projects.";
      }
      const { name: _name, ...managed } = desired;
      if (existing && Object.entries(managed).every(([key, value]) => JSON.stringify(existing[key]) === JSON.stringify(value))) {
        continue;
      }
      // Replace the WHOLE block so key order in the file equals desired order.
      // Unmanaged keys of an existing block (e.g. options) are carried over.
      const value = { ...managed };
      for (const [key, v] of Object.entries(existing ?? {})) {
        if (!(key in value)) value[key] = v;
      }
      edits.push({ path: ["agent", name], value });
    }
    return edits;
  }, editDeps);
  if (!r.ok) {
    log.warn?.("[providers] ensureCtoAgent: reconciliation failed:", r.error);
    return { ok: false, changed: r.changed === true, reason: r.error === UNPARSEABLE_CONFIG_MSG ? "unreadable" : undefined, error: r.error };
  }
  return { ok: true, changed: r.changed };
}

// Startup-only recovery. Stop on convergence (or feature disabled); failed
// attempts retry without overlapping and without needing a server restart.
export function startCtoAgentRecovery(ensure, { setTimer = setTimeout, clearTimer = clearTimeout, retryMs = 30000 } = {}) {
  let stopped = false;
  let timer = null;
  const run = async () => {
    if (stopped) return;
    let ready = false;
    try { ready = await ensure(); } catch (error) {
      console.warn("[cto] agent recovery failed:", error);
    }
    if (!ready && !stopped) {
      timer = setTimer(run, retryMs);
      timer?.unref?.();
    }
  };
  const started = run();
  return { started, stop() { stopped = true; if (timer) clearTimer(timer); } };
}

// ---------------------------------------------------------------------------
// CTO operating doctrine — materializing the effective prompt (BET-1164
// follow-up: "give the CTO an explicit, user-customisable operating
// doctrine"). See ctoDoctrine.mjs's header for the full design rationale;
// this section is purely the I/O wrapper around its pure `composeCtoPrompt`.
//
// THE CUSTOMISATION SEAM. `ensureCtoAgent`'s agent block used to point
// straight at the committed `docs/opencode/skills/cto/prompt.md` — a file a
// user edit has nowhere to live (it is versioned source, identical in every
// checkout). This section fixes that: the effective prompt (committed base +
// precedence note + the selected doctrine preset + the user's house rules)
// is composed and written to a FIXED box-side path under the CTO state root
// (`~/.manta/cto/prompt.md`, resolved through the shared `statePath()` used
// by every other CTO store — see ctoStores.mjs/ctoProbes.mjs), and the agent
// block references THAT path instead. Editing the doctrine is then just:
// rewrite this file, then reload opencode's config so its `{file:...}`
// reference is re-read (V2 reloads live — no restart, nothing in flight dies).
//
// NON-THROWING, BEST-EFFORT, NEVER LEAVE THE AGENT WITHOUT A PROMPT. Like
// `ensureCtoAgent`/`ensureMantaPlanAgent`, every step here degrades instead
// of throwing. Specifically: if composing or writing the FULL doctrine fails
// for any reason (a bad style value cannot cause this — `composeCtoPrompt`
// normalizes defensively — but a disk/permission failure can), this function
// falls back to writing the COMMITTED prompt verbatim to the same fixed
// path, so the agent block (which always points here) still has a valid,
// safe prompt to run with. Only a total inability to write to disk at all
// leaves the file unchanged, which is reported back as `{ ok:false }` for
// the caller to log — exactly like every other ensure* helper in this file.

export function ctoMaterializedPromptPath() {
  return statePath("cto", "prompt.md");
}

/**
 * Materialize the effective CTO prompt at the fixed box-side path
 * `ctoMaterializedPromptPath()`. Pure composition (`composeCtoPrompt`) plus
 * injectable I/O so this is testable without touching the real filesystem.
 *
 * @param {object} [deps]
 * @param {string} [deps.style] one of ctoDoctrine.CTO_STYLES; anything else
 *   (including undefined) composes as the default preset.
 * @param {string} [deps.houseRules] free text, appended verbatim when non-empty.
 * @param {string} [deps.basePromptPath] defaults to the committed prompt.md.
 * @param {string} [deps.outputPath] defaults to ctoMaterializedPromptPath().
 * @param {(p: string, enc: string) => Promise<string>} [deps.readFile]
 * @param {(p: string, data: string) => Promise<void>} [deps.writeFile]
 * @param {(p: string, opts?: object) => Promise<void>} [deps.mkdir]
 * @param {{warn?: Function, error?: Function}} [deps.log]
 * @returns {Promise<{ok: boolean, fellBack: boolean, path: string, error?: string}>}
 */
export async function materializeCtoPrompt(deps = {}) {
  const {
    style,
    houseRules,
    basePromptPath = ctoPromptPath(),
    outputPath = ctoMaterializedPromptPath(),
    readFile: read = readFile,
    writeFile: write = writeFile,
    mkdir: makeDir = mkdir,
    log = console,
  } = deps;
  let base;
  try {
    base = await read(basePromptPath, "utf8");
  } catch (e) {
    // The committed base prompt is source-tree data that should always be
    // present; if it truly isn't, there is nothing safe to compose OR fall
    // back to — report failure rather than writing an empty/garbage prompt.
    log.error?.("[cto-doctrine] could not read the committed base prompt:", e);
    return { ok: false, fellBack: false, path: outputPath, error: String(e?.message ?? e) };
  }
  try {
    await makeDir(dirname(outputPath), { recursive: true });
  } catch {
    // best-effort — the write below will surface any real failure
  }
  try {
    const composed = composeCtoPrompt({ basePrompt: base, style, houseRules });
    await write(outputPath, composed);
    return { ok: true, fellBack: false, path: outputPath };
  } catch (e) {
    log.error?.("[cto-doctrine] composing/writing the doctrine failed, falling back to the committed prompt:", e);
    try {
      await write(outputPath, base);
      return { ok: false, fellBack: true, path: outputPath, error: String(e?.message ?? e) };
    } catch (e2) {
      log.error?.("[cto-doctrine] fallback write also failed — the agent's existing prompt file (if any) is left untouched:", e2);
      return { ok: false, fellBack: false, path: outputPath, error: String(e2?.message ?? e2) };
    }
  }
}

/**
 * Re-materialize the doctrine prompt AND reload opencode's config so the CTO
 * agent's `{file:...}` reference is re-read. Called whenever the user changes
 * `ctoStyle`/`ctoHouseRules` (see rpc.mjs's `config:update`), and once at
 * startup before the agent block is first installed (see index.mjs's
 * `maybeEnsureCtoAgent`) so the fixed prompt path has real content before
 * anything references it.
 *
 * Best-effort/non-throwing throughout, matching every other ensure* helper:
 * a failed reload is logged, not thrown, and never undoes the file write
 * (the new prompt still takes effect at the next config reload or start).
 *
 * @param {object} [deps] forwarded to materializeCtoPrompt, plus:
 * @param {() => Promise<{ok: boolean, reloaded?: boolean, error?: string}>} [deps.reload]
 * @returns {Promise<{ok: boolean, fellBack: boolean, path: string, reloaded: boolean, error?: string}>}
 */
export async function refreshCtoDoctrine(deps = {}) {
  const { reload = reloadOpencodeConfig, log = console, ...materializeDeps } = deps;
  const result = await materializeCtoPrompt({ ...materializeDeps, log });
  let reloaded = false;
  try {
    const r = await reload();
    reloaded = r?.ok === true && r.reloaded !== false;
    if (!r?.ok) log.warn?.("[cto-doctrine] config reload after doctrine change failed:", r?.error);
  } catch (e) {
    log.warn?.("[cto-doctrine] config reload after doctrine change threw:", e);
  }
  return { ...result, reloaded };
}

/**
 * The doctrine applier. It used to be a DEFERRING RESTARTER: a doctrine edit had
 * to restart opencode, which kills every in-flight turn box-wide, so the restart
 * was parked until the box was idle and the config responses carried a
 * "pending" flag. V2 applies a config reload live and a reload never touches a
 * running turn, so there is nothing to defer: `refresh()` writes the file and
 * reloads at once, `isPending()` is always false and `tick()` is a no-op. The
 * `{refresh, tick, isPending}` shape and the `anyBusy` dep are kept only so the
 * wiring in index.mjs / rpc.mjs (and the `ctoDoctrineRestartPending` field the
 * UI reads) keep working unchanged until they are cleaned up.
 *
 * @param {object} [deps] materializeCtoPrompt deps (style/houseRules come per
 *        call), plus:
 * @param {() => Promise<{ok: boolean, reloaded?: boolean, error?: string}>} [deps.reload]
 * @param {() => boolean} [deps.anyBusy] ignored (kept for wiring compatibility)
 * @returns {{refresh, tick, isPending}}
 */
export function createCtoDoctrineRestarter(deps = {}) {
  // eslint-disable-next-line no-unused-vars
  const { reload = reloadOpencodeConfig, anyBusy = null, log = console, ...materializeDeps } = deps;

  async function refresh({ style, houseRules } = {}) {
    // The FILE is written first and unconditionally — the edit is saved even
    // if the reload fails (the new prompt then applies at the next reload/start).
    const result = await materializeCtoPrompt({ ...materializeDeps, style, houseRules, log });
    if (!result.ok) log.warn?.("[cto-doctrine] materialize failed; reloading config anyway");
    let reloaded = false;
    try {
      const r = await reload();
      reloaded = r?.ok === true && r.reloaded !== false;
      if (!r?.ok) log.warn?.("[cto-doctrine] config reload after doctrine change failed:", r?.error);
    } catch (e) {
      log.warn?.("[cto-doctrine] config reload after doctrine change threw:", e);
    }
    return { ...result, reloaded, pending: false };
  }

  return { refresh, tick: async () => ({ applied: false }), isPending: () => false };
}

// ---------------------------------------------------------------------------
// Prompt-cache TTL (cacheTtl → opencode's real wire TTL)
// ---------------------------------------------------------------------------
//
// Manta's `cacheTtl` setting is REAL: it changes what Anthropic is asked for,
// not just what the context pill predicts. The mechanism on OpenCode V2.0.30,
// verified on the wire (a recording proxy in front of a real opencode turn):
//
//   provider.<id>.models.<modelID>.options.cacheControl = {type:"ephemeral", ttl:"1h"}
//     → V2 loads it as providers.<id>.models.<modelID>.settings.cacheControl
//       (the V1-format `provider`/`options` spelling is accepted and renamed;
//        the native `providers`/`settings` spelling resolves identically)
//     → the request body carries a TOP-LEVEL `cache_control` with that ttl
//
// What changed from V1, and what did not:
//
//  1. "5m" is still the key being ABSENT. Absent keeps opencode's own
//     breakpoint caching, which Anthropic defaults to 5 minutes.
//
//  2. In V1 setting the key flipped opencode into Anthropic's AUTOMATIC caching
//     and it stopped writing its own breakpoints. V2 has no such mode switch:
//     the top-level `cache_control` is ADDED to opencode's own breakpoints
//     (tools/system/latest message — up to 4). Anthropic allows at most 4
//     cache_control blocks per request, so a request that already carries 4
//     fails with "A maximum of 4 blocks with cache_control may be provided.
//     Found 5." Measured: on the raw API a tool-bearing request is exactly at 4
//     and 1h makes it 5; with the manta-claude-max plugin loaded the
//     tool-bearing request goes 4 → 5 too (title/follow-up requests stay <= 4).
//     V2.0.30 offers no config path to the request's `cache` policy (the only
//     place that can set a ttl on the native breakpoints), so a safe 1h needs a
//     request-body hook that keeps the total <= 4 — see the report for this
//     slice. The writer below is correct; what it asks of the wire is not yet
//     safe on tool turns.
//
//  3. The option is still per-MODEL (ProviderTransform does not pass
//     provider-level settings through), so the setting fans out over the
//     Anthropic-SDK models V2 lists.
//
//  4. Writes AND removals now hot-apply: both are a file edit plus
//     `POST /api/location/reload`. Removing the key (1h → 5m) no longer
//     restarts opencode, so it no longer ends in-flight turns and no
//     confirmation is needed for that reason.
//
// Only the Anthropic package takes the option; anything else would be a stray
// setting, so the target set is exact.
export const ANTHROPIC_PACKAGE_RE = /(^|[/:@-])anthropic($|[/:@-])/i;

export const CACHE_CONTROL_1H = Object.freeze({ type: "ephemeral", ttl: "1h" });

/**
 * The (providerID, modelID) pairs the TTL applies to: every model V2 lists
 * whose provider package is Anthropic's (`@opencode/ai/providers/anthropic`,
 * the Vertex Anthropic variants, …). Pure — takes `GET /api/model`'s `data`.
 */
export function selectCacheTtlTargets(models = []) {
  const out = [];
  const seen = new Set();
  for (const m of Array.isArray(models) ? models : []) {
    const providerID = m?.providerID;
    const modelID = m?.modelID ?? m?.id;
    if (!providerID || !modelID) continue;
    if (typeof m.package !== "string" || !ANTHROPIC_PACKAGE_RE.test(m.package)) continue;
    const key = `${providerID}/${modelID}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ providerID, modelID });
  }
  return out;
}

// The cacheControl configured for one model, whichever spelling the file uses.
function configuredCacheControl(cfg, providerID, modelID) {
  return (
    cfg?.provider?.[providerID]?.models?.[modelID]?.options?.cacheControl ??
    cfg?.providers?.[providerID]?.models?.[modelID]?.settings?.cacheControl
  );
}

// The ttl currently configured in opencode, read back from its own config so
// opencode — not manta's mirror — is the source of truth. Any target carrying a
// 1h cacheControl means the box is on 1h; absent everywhere means 5m.
export function resolveCacheTtlFromConfig(cfg, targets = []) {
  for (const { providerID, modelID } of targets) {
    if (configuredCacheControl(cfg, providerID, modelID)?.ttl === "1h") return "1h";
  }
  return "5m";
}

/**
 * Diff the desired ttl against what the config already says. Returns the
 * `{ path, value }` edits for editConfig: the 1h value for every target that
 * lacks it, or (5m) a removal of every spelling that is present. Empty when the
 * config already matches — the no-op guard that keeps the setting idempotent.
 */
export function planCacheTtlOps({ targets = [], ttl = "5m", cfg = {} } = {}) {
  const edits = [];
  for (const { providerID, modelID } of targets) {
    const current = configuredCacheControl(cfg, providerID, modelID);
    if (ttl === "1h") {
      if (current?.ttl === "1h" && current?.type === "ephemeral") continue;
      edits.push({
        path: ["provider", providerID, "models", modelID, "options", "cacheControl"],
        value: { ...CACHE_CONTROL_1H },
      });
      // A native-spelling value would shadow/duplicate the one just written.
      if (cfg?.providers?.[providerID]?.models?.[modelID]?.settings?.cacheControl !== undefined) {
        edits.push({ path: ["providers", providerID, "models", modelID, "settings", "cacheControl"], value: undefined });
      }
    } else {
      // Back to 5m = opencode's native breakpoint caching = key absent.
      if (cfg?.provider?.[providerID]?.models?.[modelID]?.options?.cacheControl !== undefined) {
        edits.push({ path: ["provider", providerID, "models", modelID, "options", "cacheControl"], value: undefined });
      }
      if (cfg?.providers?.[providerID]?.models?.[modelID]?.settings?.cacheControl !== undefined) {
        edits.push({ path: ["providers", providerID, "models", modelID, "settings", "cacheControl"], value: undefined });
      }
    }
  }
  return edits;
}

// Where the target models come from: an explicit list (tests / callers that
// already hold one), an injected V2-shaped model lister, or V2 itself.
async function resolveCacheTtlTargets({ targets, deps }) {
  if (targets) return targets;
  const list = deps.listModels ?? (() => listOpencodeModels());
  return selectCacheTtlTargets(await list());
}

/**
 * Apply `ttl` to opencode's config. I/O wrapper over the pure planner: one
 * editConfig call (one write, one reload — no restart, in either direction).
 *
 * Returns `{ ok, ttl, changed, restarted, error? }`; `restarted` is kept for
 * shape stability and is always false now.
 */
export async function syncCacheTtl({ ttl = "5m", targets } = {}, deps = {}) {
  const fail = (error) => ({ ok: false, ttl, changed: false, restarted: false, error });
  if (ttl !== "5m" && ttl !== "1h") return fail(`unknown cacheTtl: ${ttl}`);

  let resolved;
  try {
    resolved = await resolveCacheTtlTargets({ targets, deps });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  const r = await editConfig((cfg) => planCacheTtlOps({ targets: resolved, ttl, cfg }), deps);
  if (!r.ok) return { ok: false, ttl, changed: r.changed === true, restarted: false, error: r.error };
  return { ok: true, ttl, changed: r.changed, restarted: false };
}

/**
 * Read the ttl opencode is actually configured for. Non-fatal: any failure
 * returns null so a caller can fall back to its stored mirror rather than
 * showing the user a wrong value.
 */
export async function readCacheTtl(deps = {}) {
  const { readConfig = readRemoteConfig } = deps;
  try {
    const targets = await resolveCacheTtlTargets({ targets: deps.targets, deps });
    if (targets.length === 0) return null;
    return resolveCacheTtlFromConfig(await readConfig(), targets);
  } catch {
    return null;
  }
}
