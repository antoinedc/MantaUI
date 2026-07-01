// Provider management: discover models from an OpenAI-compatible endpoint and
// read/merge/write provider blocks in the box's opencode.jsonc. opencode.jsonc
// stays the single source of truth; the model picker keeps reading opencode's
// /provider endpoint (see opencode.ts:listModels) — this file only edits config.
import type { AppConfig, DiscoverResult, ProviderEndpoint, ProviderInput } from "../shared/types.js";
import { runSshOnce, shellQuote } from "./pty.js";
import { buildRemoteConfigWriteCmd } from "./remoteConfigWrite.js";
import { stripLineComments } from "./setup.js";

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
  // Auth errors come back as 200/4xx JSON with an `error` object on many
  // gateways. Gate on a truthy object: some OpenAI-compatible gateways return
  // `{ data: [...], error: null }` on SUCCESS, and a bare `"error" in obj`
  // check would mistreat that as a failure and discard the valid `data`.
  const errObj = obj?.error;
  if (errObj && typeof errObj === "object") {
    const e = errObj as Record<string, unknown>;
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

// Non-destructive-write guard (pure, unit-tested). Given the provider map read
// BEFORE the merge and the map AFTER, plus the ids explicitly removed, return
// the ids that vanished WITHOUT being asked to. A non-empty result means the
// read was empty/partial and writing would silently wipe real providers — the
// bug that ate the voska endpoint. Callers must refuse to write when this is
// non-empty.
export function droppedProviders(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  removed: Iterable<string>,
): string[] {
  const removeSet = new Set(removed);
  return Object.keys(before).filter((id) => !removeSet.has(id) && !(id in after));
}

// Strip any `user:pass@` userinfo from a URL so a credential embedded in the
// baseURL (e.g. https://user:pass@host/v1) can't ride along to the renderer /
// mobile client. Falls back to a regex if the URL doesn't parse.
function stripUrlUserinfo(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
  }
}

// Project the config's provider map down to renderer-safe metadata. Never
// includes the apiKey value — only whether one is present — and scrubs any
// credential embedded in the baseURL.
export function readProviderEndpoints(cfg: Cfg): ProviderEndpoint[] {
  const providers = getProviderMap(cfg);
  return Object.entries(providers).map(([id, block]) => ({
    id,
    name: typeof block.name === "string" ? block.name : id,
    baseURL: block.options?.baseURL ? stripUrlUserinfo(block.options.baseURL) : "",
    hasApiKey: Boolean(block.options?.apiKey),
    enabledModels: Object.keys(block.models ?? {}),
  }));
}

const OPENCODE_JSONC = "~/.config/opencode/opencode.jsonc";

// Normalize a baseURL for equality: drop a trailing slash AND any userinfo, so
// the value the renderer sends back (which readProviderEndpoints scrubbed of
// `user:pass@`) still matches the stored, possibly-unscrubbed baseURL.
const normBaseURL = (u: string): string => stripUrlUserinfo(u).replace(/\/$/, "");

// Find the apiKey stored in opencode.jsonc for the provider whose baseURL
// matches. Pure — unit-testable. Returns "" when no provider matches or the
// matched one has no key. Backs the Refresh flow: the renderer sends an empty
// key (never re-sending the secret), and we recover the stored one here by
// baseURL.
export function findStoredApiKey(cfg: Cfg, baseURL: string): string {
  const providers = getProviderMap(cfg);
  const target = normBaseURL(baseURL);
  const match = Object.values(providers).find(
    (b) => b.options?.baseURL && normBaseURL(b.options.baseURL) === target,
  );
  return match?.options?.apiKey ?? "";
}

// Query an OpenAI-compatible endpoint's /v1/models FROM THE BOX (not the Mac):
// the box is where opencode reaches these endpoints, so discovery must reflect
// the box's network view (honors the "remote box is backend-only" invariant).
export async function discoverModels(
  config: AppConfig,
  baseURL: string,
  apiKey: string,
): Promise<DiscoverResult> {
  // Empty key from the renderer means "use the key already stored on the box"
  // (Refresh on an existing endpoint never re-sends the secret). New endpoints
  // persist their key via Add before Refresh, so the lookup finds it.
  let key = apiKey;
  if (!key) {
    try {
      key = findStoredApiKey(await readRemoteConfig(config), baseURL);
    } catch (e) {
      // Best-effort recovery — an endpoint may legitimately need no key, so a
      // failed re-read must not abort discovery (the curl below will surface a
      // real auth/parse error). Log so a spurious `unauthorized` is debuggable.
      console.warn("[providers] stored-key re-read failed; discovering with empty key:", e);
    }
  }
  const url = `${normBaseURL(baseURL)}/models`;
  // Pass the key via an environment variable read by curl on the box, NOT as a
  // curl argv token — so the secret stays out of the box's process list (`ps`).
  // It DOES appear in the command STRING (the `export`); the catch handler
  // redacts BUI_PROV_KEY before logging and the user only sees a fixed message,
  // so it never reaches ps, logs, the UI, or mobile RPC.
  //
  // IMPORTANT: the assignment MUST be a SEPARATE statement (`export VAR=…; curl
  // …`), NOT the command-prefix form (`VAR=… curl …`). In the prefix form the
  // shell does NOT expand `$VAR` within that same command's own arguments — the
  // `$BUI_PROV_KEY` in the header would resolve to empty, sending a bare
  // `Bearer ` and getting "Malformed API Key" from the gateway. (Verified.)
  const cmd =
    `export BUI_PROV_KEY=${shellQuote(key)}; ` +
    `curl -s --max-time 20 -H "Authorization: Bearer $BUI_PROV_KEY" ${shellQuote(url)}`;
  try {
    const { stdout } = await runSshOnce(config, cmd, { timeoutMs: 30000 });
    if (!stdout.trim()) return { ok: false, error: "unreachable", detail: "empty response" };
    return parseModelsResponse(stdout);
  } catch (e) {
    // Do NOT surface the raw transport error to the USER (fixed message below).
    // runSshOnce echoes a slice of the command on timeout, and that slice can
    // include the `export BUI_PROV_KEY='<key>'` prefix — so REDACT the key from
    // anything we log, too. The user only ever sees the fixed detail.
    const redacted = (e instanceof Error ? e.message : String(e)).replace(
      /BUI_PROV_KEY=('([^']*)'|\S+)/g,
      "BUI_PROV_KEY=<redacted>",
    );
    console.warn("[providers] discovery failed for", url, "—", redacted);
    return { ok: false, error: "unreachable", detail: "could not reach the endpoint" };
  }
}

// Read opencode.jsonc from the box and parse it. Returns {} if the file is
// absent. THROWS if the file exists but is unparseable — callers must NOT
// overwrite an unparseable config (that was the 2026-05-18 corruption mode).
//
// We use the string-literal-aware `stripLineComments` (from setup.ts), NOT a
// naive `//`-to-EOL regex: every opencode.jsonc has `"$schema":
// "https://opencode.ai/config.json"` (and provider `baseURL`s) whose `//`
// inside a string would be eaten by the naive strip, truncating the string and
// making JSON.parse throw on a perfectly valid config.
// Sentinels frame the file body so a truncated/half-delivered `cat` (the box
// or link cutting the stream mid-file — very real under the port-exhaustion
// conditions that motivated all this) CANNOT masquerade as a complete config.
// The body is only trusted when BOTH markers are present and the trailing one
// is intact; otherwise we throw and callers refuse to overwrite. `__absent__`
// distinguishes a genuinely missing file (→ {}) from a failed read (→ throw).
const CFG_READ_BEGIN = "BUI_CFG_BEGIN_b3f1a9";
const CFG_READ_END = "BUI_CFG_END_b3f1a9";

export async function readRemoteConfig(config: AppConfig): Promise<Cfg> {
  // If the file is absent, print an explicit __absent__ marker (NOT `{}`, which
  // is indistinguishable from a truncated read). Otherwise wrap the real body
  // in begin/end sentinels so we can verify the whole file arrived.
  const { stdout } = await runSshOnce(
    config,
    `if [ -f ${OPENCODE_JSONC} ]; then ` +
      `echo ${CFG_READ_BEGIN}; cat ${OPENCODE_JSONC}; echo; echo ${CFG_READ_END}; ` +
      `else echo ${CFG_READ_BEGIN}__absent__${CFG_READ_END}; fi`,
  );
  const begin = stdout.indexOf(CFG_READ_BEGIN);
  const end = stdout.lastIndexOf(CFG_READ_END);
  if (begin < 0 || end < 0 || end < begin) {
    // Neither a valid empty nor a valid full read arrived — treat as a failed
    // read (transport truncation / wedged link), NOT as an empty config. This
    // is the guard that stops a partial `cat` from clobbering the real file.
    throw new Error("incomplete config read from box (missing framing markers)");
  }
  const body = stdout.slice(begin + CFG_READ_BEGIN.length, end).trim();
  if (body === "__absent__") return {}; // file genuinely does not exist yet
  if (body === "") {
    throw new Error("empty config read from box (refusing to treat as {})");
  }
  const stripped = stripLineComments(body);
  return JSON.parse(stripped) as Cfg; // intentional throw on malformed JSON
}

// User-facing message for an unparseable on-box config. Shared by the read and
// write paths so the UI says the same actionable thing either way.
const UNPARSEABLE_CONFIG_MSG =
  "opencode.jsonc on the box is unparseable — fix it manually first.";

export async function getProviderEndpoints(config: AppConfig): Promise<ProviderEndpoint[]> {
  let cfg: Cfg;
  try {
    cfg = await readRemoteConfig(config);
  } catch (e) {
    // Distinguish the two failure classes for the renderer, which otherwise
    // collapses them into a deceptively-empty provider list:
    //  - SyntaxError  → the config exists but is malformed (actionable message)
    //  - anything else → SSH/transport failure (box unreachable)
    // Re-throw a clear Error in both cases so the renderer can show it.
    if (e instanceof SyntaxError) {
      console.warn("[providers] opencode.jsonc unparseable on read:", e.message);
      throw new Error(UNPARSEABLE_CONFIG_MSG);
    }
    console.warn("[providers] failed to read providers from the box:", e);
    throw new Error("Couldn't reach the box to read providers.");
  }
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
  } catch (e) {
    console.warn("[providers] refusing to write — config unparseable/unreadable:", e);
    // Refuse to overwrite: an unparseable OR incomplete/truncated read could
    // mean a malformed config OR a half-delivered one — clobbering either loses
    // the real file (the 2026-05-18 corruption + the 2026-07-01 provider-wipe
    // mode). readRemoteConfig now throws on truncation, so this catch covers it.
    return { ok: false, error: `${UNPARSEABLE_CONFIG_MSG} (refusing to overwrite)` };
  }

  // Snapshot what we read so we can prove the write is non-destructive. Any
  // provider present here and NOT explicitly removed must survive into `cfg`.
  const before = getProviderMap(cfg);
  const removeIds = new Set(ops.remove ?? []);

  for (const id of ops.remove ?? []) cfg = removeProviderBlock(cfg, id);
  for (const input of ops.upsert ?? []) cfg = upsertProviderBlock(cfg, input);

  // Non-destructive guard: the merged config MUST still contain every provider
  // that existed and wasn't explicitly removed. If any silently vanished, the
  // read was bad (empty/partial) and writing would wipe real providers —
  // exactly the failure that ate the voska endpoint. Refuse rather than corrupt.
  const after = getProviderMap(cfg);
  const dropped = droppedProviders(before, after, removeIds);
  if (dropped.length > 0) {
    console.warn("[providers] refusing to write — would drop providers:", dropped);
    return {
      ok: false,
      error: `Aborted: the write would have dropped provider(s) ${dropped.join(", ")} (stale/partial config read). Retry once the box is responsive.`,
    };
  }
  // Second guard: an upsert that ends with ZERO providers is almost certainly a
  // bad read (you don't add an endpoint and end up with none). Only a pure
  // remove-to-empty is legitimate.
  if (Object.keys(after).length === 0 && (ops.upsert?.length ?? 0) > 0) {
    console.warn("[providers] refusing to write — upsert produced an empty provider map");
    return { ok: false, error: "Aborted: config read looked empty (refusing to overwrite)." };
  }

  const content = JSON.stringify(cfg, null, 2);
  try {
    await writeRemoteConfigSafe(config, content);
    return { ok: true };
  } catch (e) {
    console.warn("[providers] write failed:", e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Back up the current on-box file BEFORE overwriting (timestamped .bui-bak-*),
// then write `content` verbatim via the tested heredoc builder. Every
// opencode.jsonc write in the app MUST go through here so a bad write is always
// recoverable. Best-effort backup: `[ -f ]` guards a first-time write; failure
// there doesn't block the write.
export async function writeRemoteConfigSafe(
  config: AppConfig,
  content: string,
): Promise<void> {
  await runSshOnce(
    config,
    `f=${OPENCODE_JSONC}; [ -f "$f" ] && cp "$f" "$f.bui-bak-$(date +%Y%m%d-%H%M%S)" || true`,
  ).catch((e) => console.warn("[config] pre-write backup failed (continuing):", e));
  await runSshOnce(config, buildRemoteConfigWriteCmd(content, OPENCODE_JSONC));
}

// Safely patch top-level keys of opencode.jsonc without clobbering anything
// else. Reads via the framed/comment-aware readRemoteConfig (THROWS on a
// truncated/empty read — the caller then keeps the file untouched), applies
// `mutate`, and refuses to write if the result would drop any top-level key
// that existed before and wasn't part of the patch. This is the shared
// safe path for non-provider settings writes (e.g. skills.urls) that used to
// have their own naive read-merge-write and wiped the whole config on a bad
// read (2026-07-01 skills-registry wipe: the 37-byte {skills:{urls}} file).
export async function patchRemoteConfig(
  config: AppConfig,
  mutate: (cfg: Cfg) => Cfg,
  opts: { patchedKeys: string[] } = { patchedKeys: [] },
): Promise<{ ok: boolean; error?: string }> {
  let cfg: Cfg;
  try {
    cfg = await readRemoteConfig(config);
  } catch (e) {
    console.warn("[config] refusing to patch — config unreadable/incomplete:", e);
    return { ok: false, error: `${UNPARSEABLE_CONFIG_MSG} (refusing to overwrite)` };
  }
  const beforeKeys = Object.keys(cfg);
  const patched = new Set(opts.patchedKeys);
  const next = mutate(cfg);
  // Guard: any top-level key that existed and is NOT one we deliberately
  // patched must survive. A vanished key means the read was bad → refuse.
  const dropped = beforeKeys.filter((k) => !patched.has(k) && !(k in next));
  if (dropped.length > 0) {
    console.warn("[config] refusing to patch — would drop keys:", dropped);
    return {
      ok: false,
      error: `Aborted: config patch would drop key(s) ${dropped.join(", ")} (stale/partial read).`,
    };
  }
  try {
    await writeRemoteConfigSafe(config, JSON.stringify(next, null, 2));
    return { ok: true };
  } catch (e) {
    console.warn("[config] patch write failed:", e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
