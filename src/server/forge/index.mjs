// index.mjs — forge registry + serialisation layer (BET-788).
//
// This module owns everything that must be shared across adapter CALLS (not
// per-adapter, not per-call):
//   - the ETag store, keyed by URL. Every GET sends If-None-Match when an ETag
//     is held, and a 304 costs NOTHING against the rate limit — the single
//     biggest cost lever (spec §3.4⑤), and it is not optional.
//   - a short freshness window in front of the ETag: a value fetched within
//     the last FRESH_TTL_MS is served from memory with ZERO network requests
//     (the "repeated calls issue zero requests" acceptance criterion), after
//     which the ETag conditional GET takes over.
//   - single-flight per resource: two callers asking for the same URL at the
//     same time make one fetch.
//   - the rate-limit cooling period: on a 403 with a rate-limit tell, this
//     bucket stops issuing requests for COOLING_MS and serves last-known
//     values instead.
//   - the "prefer last-known state over blanking the UI" rule (the lesson Orca
//     learned the expensive way): on a failure we return the stale value plus
//     a `stale: true` flag, never an empty panel.
//
// The adapter (github.mjs) is pure URL construction + normalisation; it holds
// none of the above. This is why caching/single-flight/backoff must NOT move
// into the adapter (a per-adapter cache means writing it twice — spec §Hygiene).
//
// It also houses the two box-facing read operations: forge:status (connected/
// login only — a token never crosses RPC) and pullRequestForCwd (resolves
// cwd → origin → repo server-side, keeping the renderer ignorant of forge
// identity).

import { rollupChecks, unsupportedByForge, repoKey as forgeRepoKey, repoKeyParts } from "../../shared/forge.mjs";
import { run } from "../tmux.mjs";
import { createSession as ocCreateSession, sendPrompt as ocSendPrompt, listMessages as ocListMessages, deleteSessionRaw as ocDeleteSessionRaw } from "../opencode.mjs";
import { buildPrDescriptionPrompt, parsePrDescription, extractTranscriptText, extractCompletedAssistantText } from "./shipDescription.mjs";
import { gitRemoteOrigin as localGitRemoteOrigin, detectForgeCli as localDetectForgeCli, gitPush as localGitPush, configGet as localConfigGet } from "../local.mjs";
import { detectForgeWithHosts } from "./selfhost.mjs";
import { resolveToken as authResolveToken } from "./auth.mjs";
import { startDeviceGrant as authStartDeviceGrant, pollDeviceGrant as authPollDeviceGrant, cancelDeviceGrant as authCancelDeviceGrant, ExpiredCodeError, DeviceFlowNotConfiguredError } from "./auth.mjs";
import { getCloneStore } from "./clone.mjs";
import { createGithubAdapter, GithubRequestError, buildInboxQueries, mergeInboxSources } from "./github.mjs";
import { createGitlabAdapter } from "./gitlab.mjs";
import { getDraft as storeGetDraft, putComment as storePutComment, deleteComment as storeDeleteComment, setVerdict as storeSetVerdict, markDraftStale as storeMarkDraftStale, clearDraft as storeClearDraft } from "./draft.mjs";
import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";

// How long a fetched value is served from memory with no network request at
// all. After this, the ETag conditional GET (If-None-Match) takes over.
const FRESH_TTL_MS = 30_000;
// The inbox's SEARCH bucket has its own, much lower rate limit than core
// (spec §4.5④) — so the box caches its three queries a full 60s. Opening the
// inbox twice inside 60 seconds must issue NO second round of requests. This
// is the same request layer — just a longer shelf life for the search bucket.
const INBOX_TTL_MS = 60_000;
// How long an ETag value stays usable for a conditional GET.
const ETAG_HOLD_MS = 5 * 60_000;
// How long a rate-limited bucket is cooled for.
const COOLING_MS = 60_000;

/**
 * Thrown when a request hits a rate-limited bucket with no last-known value to
 * serve. Callers distinguish this from a real network/HTTP failure.
 */
export class ForgeRateLimitedError extends Error {
  constructor(url) {
    super(`github rate limited for ${url}`);
    this.name = "ForgeRateLimitedError";
    this.url = url;
  }
}

/**
 * Classify a forge request failure into an actionable kind. Pure.
 *
 * SAFETY PROPERTY: only "rejected" is destructive downstream (it is the only
 * kind that may cause a stored credential to be deleted). Every other kind is
 * inert, so a misclassification among them is cosmetic, never damaging. Keep it
 * that way — do not widen what maps to "rejected".
 *
 * @param {unknown} err
 * @returns {"rejected"|"rate_limited"|"forbidden"|"network"|"unknown"}
 */
export function classifyForgeError(err) {
  if (err && err.name === "ForgeRateLimitedError") return "rate_limited";
  const status = err && typeof err.status === "number" ? err.status : null;
  if (status === 401) return "rejected";
  if (status === 429) return "rate_limited";
  if (status === 403) return "forbidden";
  // The request layer only throws without a status when `fetch` itself failed.
  if (status === null) return "network";
  return "unknown";
}

function bucketOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

/**
 * The HTTP serialisation layer: ETag store, freshness window, single-flight
 * and rate-limit cooling. `fetch` is injected so tests never hit the network
 * (and can count calls).
 *
 * @param {{ fetch?: typeof fetch, now?: () => number }} [opts]
 * @returns {{
 *   getJson: (url: string, opts: { token: string, tokenHeader?: string, accept?: string, ttl?: number }) => Promise<{ data: any, stale: boolean }>,
 * }}
 */
export function createRequestLayer({ fetch = globalThis.fetch, now = Date.now } = {}) {
  const etagStore = new Map(); // url -> { etag, data, at }
  const inflight = new Map(); // url -> Promise
  const coolingUntil = new Map(); // bucketKey -> ms

  async function getJson(url, { token, tokenHeader, accept = "application/vnd.github+json", ttl } = {}) {
    const bucket = bucketOf(url);
    // Per-resource freshness override: the inbox's search bucket has its own,
    // much lower rate limit (spec §4.5④), so its values are held a full 60s —
    // long enough that "opening the inbox twice inside 60s" issues no second
    // round of requests. The ETag conditional GET then takes over exactly as
    // for every other resource. One cache, one backoff — just a longer shelf
    // life for the rate-limited bucket.
    const ttlMs = ttl ?? FRESH_TTL_MS;

    // Rate-limit cooling: stop issuing for this bucket, serve last-known.
    if ((coolingUntil.get(bucket) ?? 0) > now()) {
      const hit = etagStore.get(url);
      if (hit) return { data: hit.data, stale: true };
      throw new ForgeRateLimitedError(url);
    }

    // Freshness window: a value fetched within ttlMs is served from
    // memory with zero network requests.
    const hit = etagStore.get(url);
    if (hit && now() - hit.at < ttlMs) {
      return { data: hit.data, stale: false };
    }

    // Single-flight: share one in-flight request across concurrent callers for
    // the same URL.
    const inFlight = inflight.get(url);
    if (inFlight) return inFlight;

    const job = fetchOne(url, token, tokenHeader, bucket, url, accept, (res) => res.json(), etagStore, inflight, coolingUntil, fetch, now);
    inflight.set(url, job);
    try {
      return await job;
    } finally {
      inflight.delete(url);
    }
  }

  // The diff (or any non-JSON) view of an endpoint. The diff Accept header
  // returns the RAW unified diff as text, and the JSON and diff views of the
  // SAME URL are cached under separate keys (`text:` prefix) so one never
  // clobbers the other in the ETag store (the diff response is a different
  // representation of `/pulls/{n}` than the PR object).
  async function getText(url, { token, tokenHeader, accept = "application/vnd.github.diff" }) {
    const cacheKey = `text:${url}`;
    const bucket = bucketOf(url);

    if ((coolingUntil.get(bucket) ?? 0) > now()) {
      const hit = etagStore.get(cacheKey);
      if (hit) return { data: hit.data, stale: true };
      throw new ForgeRateLimitedError(url);
    }

    const hit = etagStore.get(cacheKey);
    if (hit && now() - hit.at < FRESH_TTL_MS) {
      return { data: hit.data, stale: false };
    }

    const inFlight = inflight.get(cacheKey);
    if (inFlight) return inFlight;

    const job = fetchOne(url, token, tokenHeader, bucket, cacheKey, accept, (res) => res.text(), etagStore, inflight, coolingUntil, fetch, now);
    inflight.set(cacheKey, job);
    try {
      return await job;
    } finally {
      inflight.delete(cacheKey);
    }
  }

  return {
    getJson,
    getText,
    requestJson: (url, opts) =>
      requestJsonImpl(url, { token: opts?.token, tokenHeader: opts?.tokenHeader, accept: opts?.accept, method: opts?.method, body: opts?.body }, fetch),
  };
}

// A write request: plain fetch, NO ETag cache, NO single-flight, NO cooling —
// writes must not be served from last-known state and must not share the
// GET path (issue §4). Returns `{ data, stale: false }` on 2xx; any non-2xx
// throws GithubRequestError(status, url) so the adapter can map merge-status
// codes to their distinguished failure kinds.
async function requestJsonImpl(url, { token, tokenHeader, method = "GET", body, accept = "application/vnd.github+json" }, fetchImpl) {
  const res = await fetchImpl(url, {
    method,
    headers: {
      accept,
      "user-agent": "manta-forge",
      ...authHeaders(token, tokenHeader),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new GithubRequestError(res.status, url);
  const data = await res.json();
  return { data, stale: false };
}

// How a forge credential appears in an outgoing request. GitHub and OAuth use
// `Authorization: Bearer`; GitLab personal access tokens use the `PRIVATE-TOKEN`
// header (they also accept Bearer for OAuth tokens). `tokenHeader` is set
// per-adapter-kind by the registry so the right scheme rides every call.
function authHeaders(token, tokenHeader) {
  if (!token) return {};
  if (tokenHeader) return { [tokenHeader]: token };
  return { authorization: `Bearer ${token}` };
}

async function fetchOne(url, token, tokenHeader, bucket, cacheKey, accept, parse, etagStore, inflight, coolingUntil, fetch, now) {
  const hit = etagStore.get(cacheKey);
  const headers = {
    accept,
    "user-agent": "manta-forge",
    ...authHeaders(token, tokenHeader),
    ...(hit ? { "if-none-match": hit.etag } : {}),
  };

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    // A network failure must never blank the UI — serve last-known, stale.
    if (hit) return { data: hit.data, stale: true };
    throw err;
  }

  if (res.status === 304) {
    // Not modified: the cache is authoritative, and a 304 costs nothing.
    const cached = etagStore.get(cacheKey);
    return { data: cached ? cached.data : null, stale: false };
  }

  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    coolingUntil.set(bucket, now() + COOLING_MS);
    if (hit) return { data: hit.data, stale: true };
    throw new ForgeRateLimitedError(url);
  }

  if (!res.ok) throw new GithubRequestError(res.status, url);

  const data = await parse(res);
  const etag = res.headers.get("etag");
  if (etag) etagStore.set(cacheKey, { etag, data, at: now() });
  return { data, stale: false };
}

// ---- Registry -----------------------------------------------------------------

// How each forge's credential is presented on the wire (spec §3.3). GitHub and
// any OAuth token ride `Authorization: Bearer`; a GitLab personal access token
// is a `PRIVATE-TOKEN` header. `apiAccept` is the JSON Accept header for that
// forge's API.
const AUTH_BY_KIND = Object.freeze({
  github: Object.freeze({ tokenHeader: null, accept: "application/vnd.github+json" }),
  gitlab: Object.freeze({ tokenHeader: "PRIVATE-TOKEN", accept: "application/vnd.gitlab+json" }),
});

// kind -> adapter factory. `create(adapterRequest)` returns the adapter; the
// adapterRequest closure binds a per-call token to the SHARED request layer so
// ETag/single-flight/cooling persist across calls and across token rotations.
const ADAPTERS = Object.freeze({ github: createGithubAdapter, gitlab: createGitlabAdapter });

/**
 * Create an isolated forge runtime with its own request layer — the test seam.
 * Production uses defaultRuntime; getAdapter() delegates to it.
 *
 * @param {{ fetch?: typeof fetch }} [opts]
 */
export function createForgeRuntime({ fetch = globalThis.fetch } = {}) {
  const requestLayer = createRequestLayer({ fetch });
  return {
    getAdapter(kind, token, apiBase) {
      const create = ADAPTERS[kind];
      if (!create) throw unsupportedByForge(kind, "read path");
      const wire = AUTH_BY_KIND[kind] ?? AUTH_BY_KIND.github;
      const request = (url, opts) =>
        requestLayer.getJson(url, { token, tokenHeader: wire.tokenHeader, accept: wire.accept, ttl: opts?.ttl });
      const requestWrite = (url, opts) =>
        requestLayer.requestJson(url, { token, tokenHeader: wire.tokenHeader, accept: wire.accept, ...opts });
      const requestText = (url) =>
        requestLayer.getText(url, { token, tokenHeader: wire.tokenHeader, accept: wire.accept });
      // apiBase is the per-host API root (github.com → api.github.com, a
      // self-hosted GitLab → <host>/api/v4); omitted it defaults inside the
      // adapter to its canonical hosted root.
      return create(request, requestWrite, requestText, apiBase);
    },
    requestLayer,
  };
}

const defaultRuntime = createForgeRuntime();

/**
 * `getAdapter(kind)` → the adapter for a forge, or throws UnsupportedByForgeError
 * for an unknown kind. The instance is bound to the shared request layer and a
 * per-call token. `apiBase` is the per-host API root for self-hosted forges.
 * @param {"github"} kind
 * @param {string} token
 * @param {string} [apiBase]
 */
export function getAdapter(kind, token, apiBase) {
  return defaultRuntime.getAdapter(kind, token, apiBase);
}

// ---- Box-facing reads ----------------------------------------------------------

const GH_HOST = "github.com";
const EMPTY = Object.freeze({ pr: null, checks: [], rollup: "none", stale: false, error: null });

// The forge kinds the box-facing reads/writes route through the seam. Adding a
// kind here (with its adapter registered above) is what makes a forge render in
// the session header / review pane; unknown kinds fall through to `no_forge`.
const KNOWN_KINDS = new Set(["github", "gitlab"]);
function isKnownKind(kind) {
  return typeof kind === "string" && KNOWN_KINDS.has(kind);
}

// Default box-facing forge detection: the shared `detectForge` plus the
// user-configured `forgeHosts` (AppConfig) mapping layered on top, so a
// self-hosted GitHub/GitLab host a user has configured resolves to its kind
// + apiBase while an unconfigured unknown host still falls through to null.
// `getConfig` is injectable for tests; failures degrade to the known hosts.
async function detectFromConfig(origin, { getConfig = localConfigGet } = {}) {
  if (!origin) return null;
  let hostKinds = [];
  try {
    const cfg = await getConfig();
    hostKinds = Array.isArray(cfg?.forgeHosts) ? cfg.forgeHosts : [];
  } catch {
    /* config unreadable — known hosts still resolve */
  }
  return detectForgeWithHosts(origin, hostKinds);
}

/**
 * forge:status — `{ connected, login, kind, source } | { connected: false }`.
 * `login` comes from `gh auth status` (a non-secret identity); `connected` is
 * whether a token resolves; `source` is the §3.3 ladder rung the box's token
 * came from ("cli" | "env" | "stored") — surfaced in Settings so the UI can
 * say *where* the credential came from. A token NEVER appears in this result —
 * the value the caller is pointed at is only ever used to authenticate the
 * fetch layer.
 *
 * @param {{ resolveToken?: typeof authResolveToken, detectCli?: () => Promise<{ installed: boolean, authenticated: boolean, login: string | null }> }} [deps]
 */
export async function forgeStatus({ resolveToken = authResolveToken, detectCli = localDetectForgeCli } = {}) {
  const [cli, tok] = await Promise.all([detectCli(), resolveToken(GH_HOST)]);
  if (!tok) return { connected: false };
  return { connected: true, login: cli?.login ?? null, kind: "github", source: tok.source ?? null };
}

// ---- §7.4 case C: zero-state clone flow (BET-796) --------------------------
//
// All box-side. The device grant and repo/clone ops share the one rule that
// every other forge op follows: a token never crosses RPC. The device grant
// returns a renderer-safe shape (no device_code, rule 1); clones authenticate
// box-side and the renderer only ever sees a status snapshot.

/**
 * Start the GitHub device grant. Returns the renderer-safe shape — grantId
 * (opaque handle), userCode, verificationUri, expiresIn, pollInterval.
 * `device_code` is held box-side and NEVER appears here.
 *
 * @param {{ resolveToken?: typeof authResolveToken, start?: typeof authStartDeviceGrant }} [deps]
 */
export async function forgeDeviceStart(
  { resolveToken = authResolveToken, start = authStartDeviceGrant } = {},
) {
  // A box that already has a credential (CLI/secret) needn't run the device
  // flow at all — report it so the UI skips straight to the picker.
  const tok = await resolveToken(GH_HOST);
  if (tok) return { connected: true, grant: null };
  try {
    const grant = await start();
    return { connected: false, grant, error: null };
  } catch (e) {
    // A placeholder/unset client_id (BET-849) must surface as a clear "not
    // configured" state, NOT retry a guaranteed-dead-end device screen.
    if (e instanceof DeviceFlowNotConfiguredError) {
      return { connected: false, notConfigured: true, grant: null };
    }
    throw e;
  }
}

/**
 * Poll an in-flight device grant. Returns `{ status: "pending", pollInterval }`,
 * `{ status: "done" }`, or `{ status: "expired" }` ([E2]) — never throws. On
 * success the token is already stored under GITHUB_TOKEN by the auth layer.
 *
 * @param {string} grantId
 * @param {{ poll?: typeof authPollDeviceGrant }} [deps]
 */
export async function forgeDevicePoll(
  grantId,
  { poll = authPollDeviceGrant } = {},
) {
  if (typeof grantId !== "string" || !grantId) return { status: "expired" };
  try {
    return await poll(grantId);
  } catch (e) {
    if (e instanceof ExpiredCodeError) return { status: "expired" };
    return { status: "error", error: String((e && e.message) || e) };
  }
}

/**
 * Cancel an in-flight device grant ([S5] Cancel → back to [S4] with nothing
 * changed). No-op for an unknown grant.
 *
 * @param {string} grantId
 * @param {{ cancel?: typeof authCancelDeviceGrant }} [deps]
 */
export function forgeDeviceCancel(
  grantId,
  { cancel = authCancelDeviceGrant } = {},
) {
  cancel(grantId);
  return { ok: true };
}

/**
 * The remote repo picker's source ([S6]): the repos the connected user can
 * push to, most-recently-pushed first (adapter.listMyRepos). Box-side — a
 * token resolves but never crosses RPC.
 *
 * @param {{ resolveToken?: typeof authResolveToken, getAdapterFn?: typeof getAdapter }} [deps]
 */
export async function forgeListRepos(
  { resolveToken = authResolveToken, getAdapterFn = getAdapter } = {},
) {
  const tok = await resolveToken(GH_HOST);
  if (!tok) return { error: "not_connected", repos: [] };
  const adapter = getAdapterFn("github", tok.token);
  try {
    const { data, stale } = await adapter.listMyRepos();
    return { repos: Array.isArray(data) ? data : [], stale: Boolean(stale), error: null };
  } catch (e) {
    return { repos: [], error: String((e && e.message) || e), stale: false };
  }
}

/**
 * Start a clone. Resolves the token box-side (private-repo auth via the
 * clone's extraheader) and returns an opaque job id tracked by the clone
 * store; the renderer polls forge:clone-status for the determinate progress.
 * Never returns the token.
 *
 * @param {{ url: string, dest: string, name: string }} input
 * @param {{ resolveToken?: typeof authResolveToken, store?: ReturnType<typeof getCloneStore> }} [deps]
 */
export async function forgeCloneStart(
  input,
  { resolveToken = authResolveToken, store = getCloneStore() } = {},
) {
  const url = input?.url;
  const dest = input?.dest;
  const name = input?.name;
  if (typeof url !== "string" || !url || typeof dest !== "string" || !dest) {
    return { error: "bad_request" };
  }
  const tok = await resolveToken(GH_HOST);
  const id = store.start({ url, dest, name: name || "", token: tok?.token ?? undefined });
  return { id };
}

/**
 * Clone status snapshot for the determinate bar ([S7]).
 * @param {string} id
 * @param {{ store?: ReturnType<typeof getCloneStore> }} [deps]
 */
export function forgeCloneStatus(id, { store = getCloneStore() } = {}) {
  return store.status(id);
}

/**
 * Cancel an in-flight clone ([S7] Cancel).
 * @param {string} id
 * @param {{ store?: ReturnType<typeof getCloneStore> }} [deps]
 */
export function forgeCloneCancel(id, { store = getCloneStore() } = {}) {
  return store.cancel(id);
}

async function defaultGitRemoteOrigin(cwd) {
  return localGitRemoteOrigin(cwd);
}

async function defaultCurrentBranch(cwd) {
  try {
    const { stdout } = await run("git", ["-C", cwd, "branch", "--show-current"]);
    return (stdout ?? "").trim() || null;
  } catch {
    return null;
  }
}

// Resolve the PR base default from the forge API (the single source of truth),
// never from a local git ref. Injectable via `deps.getDefaultBranch` so tests
// stay I/O-free.
async function defaultGetDefaultBranch({ adapter, repo }) {
  return adapter.getDefaultBranch(repo);
}

// The shared cwd → origin → forge → token → adapter scaffold that every
// cwd-scoped forge read/write resolves. pullRequestForCwd, resolveWriteContext
// (and its write/draft consumers) and forgeDiffForCwd all did this by hand;
// one helper is the single copy of the "detect the repo's forge, resolve a
// token, bind the adapter to it" preamble. Returns `{ forge, repo, token,
// adapter }` or `{ error: "no_forge" | "not_connected" }`. `currentBranch`
// stays with the callers that need it (it is not part of the shared detect).
async function resolveForgeContext(cwd, deps) {
  const gitRemoteOrigin = deps.gitRemoteOrigin ?? defaultGitRemoteOrigin;
  const resolveToken = deps.resolveToken ?? authResolveToken;
  const getAdapterFn = deps.getAdapter ?? getAdapter;
  const detectForge = deps.detectForge ?? detectFromConfig;

  const origin = await gitRemoteOrigin(cwd);
  const forge = origin ? await detectForge(origin, deps) : null;
  if (!forge || !isKnownKind(forge.kind)) return { error: "no_forge" };
  const tok = await resolveToken(forge.host);
  if (!tok) return { error: "not_connected" };
  const adapter = getAdapterFn(forge.kind, tok.token, forge.apiBase);
  const repo = { owner: forge.owner, repo: forge.repo };
  return { forge, repo, token: tok, adapter };
}

// Resolve the forge identity a diff/draft read addresses. A `ref` is either
// the session's `cwd` (resolve cwd → origin → repo, as before) OR an explicit
// cross-repo inbox target `{ repoKey, number }` (no cwd to resolve — the row
// carries only host/owner/repo + the PR number, BET-850). Returns the same
// `{ forge, repo, adapter }` context as resolveForgeContext plus a canonical
// `repoKey`, or `{ error: "no_forge" | "not_connected" }`.
//
// The explicit branch does NOT call git at all — a cross-repo PR may live in a
// repo the box has not cloned, so the read must get to the forge over the API
// alone, keyed by the inbox row's host/owner/repo + number.
async function resolveRefContext(ref, deps) {
  const resolveToken = deps.resolveToken ?? authResolveToken;
  const getAdapterFn = deps.getAdapter ?? getAdapter;

  if (typeof ref === "object" && ref !== null && ref.repoKey) {
    const target = repoKeyParts(ref.repoKey);
    if (!target) return { error: "no_forge" };
    const tok = await resolveToken(target.host);
    if (!tok) return { error: "not_connected" };
    return {
      forge: { kind: target.kind, host: target.host, owner: target.owner, repo: target.repo },
      repo: { owner: target.owner, repo: target.repo },
      adapter: getAdapterFn(target.kind, tok.token),
      repoKey: forgeRepoKey({ host: target.host, owner: target.owner, repo: target.repo }),
      cwd: null,
      error: null,
    };
  }

  const cwd = typeof ref === "string" ? ref : ref?.cwd;
  const ctx = await resolveForgeContext(cwd, deps);
  if (ctx.error) return { error: ctx.error };
  return {
    ...ctx,
    cwd,
    repoKey: forgeRepoKey({ host: ctx.forge.host, owner: ctx.forge.owner, repo: ctx.forge.repo }),
  };
}

// Pick the PR number a diff/draft read targets. An explicit `{ repoKey, number }`
// ref wins outright (a cross-repo inbox PR — never derived from a branch). A
// cwd ref picks the open PR on the current branch; a branch with no open PR —
// or no branch at all (detached HEAD) — resolves to `"no_pr"`, never someone
// else's PR. Returns `{ number, stale }` or `{ error: "no_pr" }` /
// `{ rateLimited: true }`.
async function resolveRefNumber(ref, ctx, deps) {
  if (typeof ref === "object" && ref !== null && ref.repoKey) {
    const number = Number(ref.number);
    if (!Number.isInteger(number) || number <= 0) return { error: "no_pr" };
    return { number, stale: false };
  }
  const { prs, stale, rateLimited } = await listOpenPrs(ctx.adapter, ctx.repo);
  if (rateLimited) return { rateLimited: true };
  if (prs.length === 0) return { error: "no_pr" };
  const currentBranch = deps.currentBranch ?? defaultCurrentBranch;
  const branch = await currentBranch(ctx.cwd);
  const candidate = branch ? prs.find((p) => p.headRef === branch) : undefined;
  if (!candidate) return { error: "no_pr" };
  return { number: candidate.number, stale };
}

// List a repo's open PRs the way both cwd-scoped readers do, normalising the
// rate-limit guard once. A rate-limited list is not an error — it yields an
// empty list flagged `rateLimited` so the caller can serve a stale result
// rather than blanking the panel. A real network/HTTP failure still throws.
async function listOpenPrs(adapter, repo) {
  try {
    const res = await adapter.listPullRequests(repo, { state: "open" });
    return { prs: Array.isArray(res.data) ? res.data : [], stale: Boolean(res.stale) };
  } catch (err) {
    if (err instanceof ForgeRateLimitedError) return { rateLimited: true, prs: [], stale: true };
    throw err;
  }
}

/**
 * forge:pull-request — resolve `cwd → origin → repo`, pick the open PR whose
 * head is the current branch, and return the normalised PR + merged checks +
 * rollup. A branch with no open PR — or no branch at all (detached HEAD) —
 * returns the well-formed empty result `{ pr: null }`, never someone else's
 * PR. Never throws for "no PR" or "not connected" — those are well-formed
 * `{ error }` / `{ pr: null }` results.
 *
 * All git/forge deps are injectable for tests.
 *
 * @param {string} cwd
 * @param {{ gitRemoteOrigin?: (cwd: string) => Promise<string|null>,
 *          currentBranch?: (cwd: string) => Promise<string|null>,
 *          resolveToken?: typeof authResolveToken,
 *          getAdapter?: (kind: string, token: string) => any }} [deps]
 */
export async function pullRequestForCwd(cwd, deps = {}) {
  const currentBranch = deps.currentBranch ?? defaultCurrentBranch;
  const getDefaultBranch = deps.getDefaultBranch ?? defaultGetDefaultBranch;
  const runGit = deps.run ?? run;

  const ctx = await resolveForgeContext(cwd, deps);

  // Branch state for the ship gate (BET-892), resolved from the same context
  // `resolveWriteContext` uses — NOT a second poll or a new RPC. Best-effort:
  // anything that fails resolves to null. `base` is the repo default branch
  // (from the forge API); `aheadCount` is commits ahead of origin/<base>.
  const branch = ctx.error ? null : await currentBranch(cwd);
  let base = null;
  if (!ctx.error) {
    try {
      base = await getDefaultBranch({ adapter: ctx.adapter, repo: ctx.repo });
    } catch {
      base = null;
    }
  }
  let aheadCount = null;
  if (branch && base) {
    try {
      const { stdout } = await runGit("git", ["-C", cwd, "rev-list", "--count", `origin/${base}..${branch}`]);
      aheadCount = Number(String(stdout ?? "").trim());
      if (!Number.isFinite(aheadCount) || aheadCount < 0) aheadCount = null;
    } catch {
      aheadCount = null;
    }
  }
  const shipState = { branch, base, aheadCount };

  if (ctx.error) return { ...EMPTY, ...shipState, error: ctx.error };
  const { adapter, repo } = ctx;

  const { prs: prArr, stale, rateLimited } = await listOpenPrs(adapter, repo);
  if (rateLimited) return { ...EMPTY, ...shipState, stale: true };

  if (prArr.length === 0) return { ...EMPTY, ...shipState, stale };

  const branchName = await currentBranch(cwd);
  if (!branchName) return { ...EMPTY, ...shipState, stale };

  const candidate = prArr.find((p) => p.headRef === branchName);
  if (!candidate) return { ...EMPTY, ...shipState, stale };

  // Full normalised representation — getPullRequest populates reviewers + the
  // unresolved-thread count that the list endpoint cannot. Falls back to the
  // list variant (best-effort, stale) if that fails.
  let pr = candidate;
  let stalePR = stale;
  try {
    const res = await adapter.getPullRequest(repo, candidate.number);
    pr = res.data;
    stalePR = stalePR || res.stale;
  } catch {
    stalePR = true;
  }

  let checks = [];
  let staleChecks = stalePR;
  try {
    const res = await adapter.getChecks(repo, pr.headSha);
    checks = Array.isArray(res.data) ? res.data : [];
    staleChecks = staleChecks || res.stale;
  } catch {
    // Checks are best-effort — a PR whose checks are unreachable still returns
    // its PR + an empty (stale) check list rather than blanking everything.
    staleChecks = true;
  }

  return { pr, checks, rollup: rollupChecks(checks), stale: staleChecks, error: null, ...shipState };
}

// ---- Inbox seed prompt (BET-795) ----------------------------------------
//
// The template "Start a session" seeds the first prompt from. `{{url}}` is the
// placeholder filled with the work item's URL. Defined ONCE here and exported
// so the per-repo rules file (rules-engine issue) reads the SAME constant as
// its default — one default, not two.
export const INBOX_SEED_PROMPT = "Complete {{url}}";

// Fill INBOX_SEED_PROMPT for one inbox item. Exported for tests.
export function seedPromptFor(item, template = INBOX_SEED_PROMPT) {
  return template.replace("{{url}}", item?.url ?? "");
}

// ---- Box-facing read: forge:inbox (BET-795) ------------------------------
//
// The work inbox: issues assigned to you + PRs awaiting your review + your own
// open PRs whose checks are red — ONE cross-repo list, answered by three SEARCH
// queries (spec §4.5④). All forge access is box-side: `resolveToken` provides
// the token to the shared request layer and it never reaches the renderer.
// Results are deduplicated by the adapter's precedence rule (a PR matching two
// queries appears once, most urgent reason wins) and sorted by updatedAt desc.
//
// The checks-failing population needs each candidate PR's checks, so it is
// fetched per-PR AFTER the search (a search result can't tell you checks) and
// only PRs whose rollup is red are kept — but it is NEVER per-repo iteration.
async function defaultForgeInbox(deps) {
  const resolveToken = deps.resolveToken ?? authResolveToken;
  const getAdapterFn = deps.getAdapter ?? getAdapter;

  const tok = await resolveToken(GH_HOST);
  if (!tok) return { items: [], stale: false, error: "not_connected" };

  const adapter = getAdapterFn("github", tok.token);
  const populations = [];
  let stale = false;

  for (const { query, reason } of buildInboxQueries()) {
    try {
      const res = await adapter.searchIssues(query, { ttl: INBOX_TTL_MS });
      stale = stale || Boolean(res.stale);
      const hits = (Array.isArray(res.data) ? res.data : []).map((h) =>
        h && typeof h === "object"
          ? { ...h, reason, seed: seedPromptFor(h) }
          : h,
      );
      // The checks-failing population: keep only my open PRs whose CI is red.
      const kept =
        reason === "checks failing"
          ? await keepRedPrs(hits, adapter)
          : hits;
      populations.push(kept);
    } catch (err) {
      if (err instanceof ForgeRateLimitedError) {
        // A rate-limited search bucket is not an inbox failure — serve what we
        // have (possibly nothing splus stale) rather than blanking the panel.
        stale = true;
        continue;
      }
      throw err;
    }
  }

  const items = mergeInboxSources(populations)
    .map((it) => ({ ...it, rollup: it.reason === "checks failing" ? "red" : "none" }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return { items, stale, error: null };
}

// Keep only the PRs whose checks roll up red, fetching checks per PR against
// its own repo (from the search hit's owner/repo). A PR whose checks can't be
// fetched (no headSha, rate-limited, unreachable) is dropped — it cannot be
// proven red, and a stale scan must not mislabel it. Best-effort: never throws.
async function keepRedPrs(hits, adapter) {
  const kept = [];
  for (const hit of hits) {
    if (hit.kind !== "pr") continue;
    if (!hit.headSha || !hit.owner || !hit.repo) continue;
    try {
      const res = await adapter.getChecks({ owner: hit.owner, repo: hit.repo }, hit.headSha);
      const checks = Array.isArray(res.data) ? res.data : [];
      if (rollupChecks(checks) === "red") kept.push(hit);
    } catch {
      // checks unreachable — can't prove red, skip
    }
  }
  return kept;
}

/**
 * forge:inbox — the aggregated work inbox. Box-side read; a forge token never
 * leaves the box. Returns `{ items, stale, error }` where `error` is
 * "not_connected" when no GitHub token resolves (empty items) or null.
 *
 * @param {{ resolveToken?: typeof authResolveToken,
 *          getAdapter?: (kind: string, token: string) => any }} [deps]
 */
export async function forgeInbox(deps = {}) {
  return defaultForgeInbox(deps);
}

// ---- Box-facing writes (issue BET-794) --------------------------------------
//
// ship + merge both live here, not in the renderer: a forge token must never
// reach the Electron renderer or the iOS app (§Hygiene). Both resolve
// `cwd → origin → repo → token → adapter` box-side and return well-formed
// results / typed errors. All git/forge deps injectable for tests.

// Shared context resolution for the write ops. Returns `{ forge, repo, adapter,
// token, head }` or a `{ error }` result. `head` is the current branch (the
// thing we push and open a PR from).
async function resolveWriteContext(cwd, deps, wantBranch = true) {
  const currentBranch = deps.currentBranch ?? defaultCurrentBranch;
  const getDefaultBranch = deps.getDefaultBranch ?? defaultGetDefaultBranch;

  const ctx = await resolveForgeContext(cwd, deps);
  if (ctx.error) return { error: ctx.error };
  const { forge, repo, adapter } = ctx;
  let head = null;
  let base = null;
  if (wantBranch) {
    head = await currentBranch(cwd);
    if (!head) return { error: "no_branch" };
    base = await getDefaultBranch({ adapter, repo });
  }
  return { forge, repo, adapter, head, base };
}

/**
 * Ship preview: the facts the [SH1] confirm card shows BEFORE anything is
 * pushed — the head branch, the base branch (the PR target), the number of
 * changed files on the branch, plus a **drafted title + body** (design §4.5
 * step 1: "the agent writes a title + body from the diff ... honouring the
 * repo's PR template"). The card renders these editable; the user can change
 * them. Read-only; no push, no PR. The push+create only ever runs after the
 * human confirms the card.
 *
 * Drafting is heuristic (no model call): the title is the tip commit subject
 * (falling back to a humanised branch name) and the body is seeded from the
 * repo's PR template when one exists, else a short changed-files summary. All
 * git/fs deps injectable for tests.
 *
 * @param {string} cwd
 * @param {object} [deps] injectable I/O
 * @returns {Promise<{ ok: true, head: string, base: string, fileCount: number, title: string, body: string } | { ok: false, error: string }>}
 */
export async function shipPreview(cwd, deps = {}) {
  const ctx = await resolveWriteContext(cwd, deps);
  if (ctx.error) return { ok: false, error: ctx.error };
  if (!ctx.base) return { ok: false, error: "unknown_base" };
  const base = ctx.base;
  const runGit = deps.run ?? run;

  let files = [];
  try {
    const { stdout } = await runGit("git", ["-C", cwd, "diff", "--name-only", `origin/${base}...${ctx.head}`, "--"]);
    files = String(stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    // origin/<base> may not exist locally yet — best-effort empty.
  }

  // BET-893: when the caller supplies the session's selected model, generate
  // the title + body OUT OF BAND (a throwaway opencode session — never the
  // user's own transcript) and use it. A generation failure NEVER surfaces as
  // an error: we fall through to the deterministic draft below.
  if (deps.model) {
    const generated = await tryGeneratePrDescription(cwd, ctx, { base, files, deps });
    if (generated) {
      return { ok: true, head: ctx.head, base, fileCount: files.length, title: generated.title, body: generated.body };
    }
  }

  const title = await draftTitle(cwd, ctx.head, deps);
  const body = await draftBody(cwd, ctx.head, base, files, {
    ...deps,
    linkedIssue: deps.linkedIssue ?? null,
    prRepoKey: forgeRepoKey(ctx.forge),
  });
  return { ok: true, head: ctx.head, base, fileCount: files.length, title, body };
}

// Throwaway-session naming + poll cadence for the out-of-band generation.
const PR_DESC_SESSION_TITLE = "manta: pr description";
const PR_DESC_POLL_MS = 1000;
const PR_DESC_DEADLINE_MS = 60000;

/**
 * Generate the PR title + body with the session's selected model, OUT OF BAND
 * (BET-893). A throwaway opencode session — created WITHOUT a tmux window, so
 * it never appears in the sidebar and never enters the user's own conversation
 * — is created → prompted → polled → deleted. Everything opencode owns
 * (createSession, sendPrompt, listMessages, deleteSessionRaw) is injectable as
 * deps so tests never touch a live opencode.
 *
 * Returns `{ title, body }` on success, or null on ANY failure/timeout so the
 * caller falls back to the deterministic draft. Never throws.
 */
async function tryGeneratePrDescription(cwd, ctx, { base, files, deps }) {
  const {
    model, sessionId,
    run: runGit = run,
    readPrTemplate = defaultReadPrTemplate,
    createSession = ocCreateSession,
    sendPrompt = ocSendPrompt,
    listMessages = ocListMessages,
    deleteSessionRaw = ocDeleteSessionRaw,
    pollMs = PR_DESC_POLL_MS,
    deadlineMs = PR_DESC_DEADLINE_MS,
  } = deps;

  let commits = [];
  try {
    const { stdout } = await runGit("git", ["-C", cwd, "log", "--pretty=%s", `origin/${base}..${ctx.head}`]);
    commits = String(stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    // origin/<base>..<head> may not resolve locally — best-effort empty.
  }

  let transcript = "";
  if (sessionId) {
    try {
      transcript = extractTranscriptText(await listMessages(sessionId));
    } catch {
      // Transcript is best-effort *why* context; generation still runs without it.
    }
  }

  let template = "";
  try {
    template = (await readPrTemplate(cwd, deps)) ?? "";
  } catch {
    /* no template — the prompt just omits the template block */
  }

  const prompt = buildPrDescriptionPrompt({ head: ctx.head, base, files, commits, template, transcript });

  let sid = null;
  try {
    const created = await createSession({ directory: cwd, title: PR_DESC_SESSION_TITLE });
    sid = created?.id;
    if (!sid) return null;
    await sendPrompt({ sessionId: sid, text: prompt, model: { providerID: model.providerID, modelID: model.modelID } });

    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      let detail;
      try {
        // Completion-aware: returns null while the assistant turn is STILL in
        // flight, so we never capture partial, mid-stream text as the final
        // PR description. (BET-893 reviewer Block — first poll at ~1s would
        // otherwise hand back a truncated reply on a real model call.)
        detail = extractCompletedAssistantText(await listMessages(sid));
      } catch {
        // Poll hiccup — keep waiting until the deadline.
        continue;
      }
      if (detail === null) continue; // assistant turn still in flight
      if (!detail) return null; // completed turn produced no text → fallback
      return parsePrDescription(detail);
    }
    return null; // deadline passed without a completed assistant turn
  } catch {
    return null;
  } finally {
    if (sid) {
      try { await deleteSessionRaw(sid); } catch { /* best-effort */ }
    }
  }
}

// PR templates, in GitHub's usual discovery order. Resolved against the repo
// top level.
const PR_TEMPLATE_CANDIDATES = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
];

// Title draft: the tip commit subject (the most on-the-nose "what this branch
// does"), truncated to the GH 72-char subject guideline; falls back to the
// humanised branch name. All I/O injectable.
async function draftTitle(cwd, branch, deps) {
  const gitLog = deps.gitLog ?? defaultGitLog;
  const subject = (await gitLog(cwd))?.trim() ?? "";
  if (subject) return subject.slice(0, 72);
  return humanizeBranch(branch);
}

async function defaultGitLog(cwd) {
  try {
    const { stdout } = await run("git", ["-C", cwd, "log", "-1", "--pretty=%s"]);
    return String(stdout ?? "").trim();
  } catch {
    return "";
  }
}

// Humanise a branch ref into a title-friendly slug: drop the leading scope
// (`feat/`, `fix/`, …), dashes and underscores to spaces, title case.
export function humanizeBranch(branch) {
  const cleaned = String(branch ?? "")
    .split("/")
    .pop()
    .replace(/[-_]+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// `repoKey` is "host/owner/repo" (e.g. "github.com/antoinedc/MantaUI"); a forge
// close-reference is "owner/repo#N", or bare "#N" when the issue lives in the
// same repo as the pull request. Pure + exported for tests.
export function issueCloseRef(issue, prRepoKey) {
  if (!issue?.repoKey || !Number.isInteger(issue.number)) return "";
  if (issue.repoKey === prRepoKey) return `#${issue.number}`;
  const [, owner, repo] = String(issue.repoKey).split("/");
  return owner && repo ? `${owner}/${repo}#${issue.number}` : "";
}

// Body draft: the repo's PR template when one exists (honouring step-1's
// "honouring the repo's PR template"), else a short changed-files summary.
// Template `${head}` / `${base}` placeholders, if present, are filled. When
// `deps.linkedIssue` (an async fn returning `{ repoKey, number } | null`)
// resolves a ref, ONE "Closes <ref>" line plus a blank line is prepended to
// whichever body branch runs — `deps.prRepoKey` decides the bare/suffixed ref.
// With no ref (or no dep) the output is byte-identical to today.
async function draftBody(cwd, head, base, files, deps) {
  const readPrTemplate = deps.readPrTemplate ?? defaultReadPrTemplate;
  let issueRef = "";
  if (deps.linkedIssue) {
    const issue = await deps.linkedIssue();
    issueRef = issueCloseRef(issue, deps.prRepoKey);
  }
  const preamble = issueRef ? `Closes ${issueRef}\n\n` : "";
  const template = await readPrTemplate(cwd, deps);
  if (template && template.trim()) {
    return preamble + template
      .replace(/\$\{head\}/g, head || "")
      .replace(/\$\{base\}/g, base || "");
  }
  if (files.length === 0) return preamble;
  return preamble + `## What\n\nOpens ${head} → ${base}.\n\n## Changed files\n\n${files.map((f) => `- ${f}`).join("\n")}`;
}

// Find + read the repo's PR template, best-first from the candidates list.
async function defaultReadPrTemplate(cwd, deps = {}) {
  const readFile = deps.readFile ?? fsReadFile;
  let root = cwd;
  try {
    const { stdout } = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
    if (stdout?.trim()) root = stdout.trim();
  } catch {
    /* cwd already assumed to be the tree root */
  }
  for (const rel of PR_TEMPLATE_CANDIDATES) {
    try {
      return await readFile(join(root, rel), "utf-8");
    } catch {
      // not present — try the next candidate
    }
  }
  return null;
}

/**
 * Ship: push the current branch, then open a pull request for it. The human
 * gate (issue §4) lives ABOVE this — this function is the push+create step
 * that runs only after an explicit confirm. It is the ONE code path for
 * "open a PR", reused by the human ship action and any future automated one.
 * PRs are always created as real (non-draft) pull requests (BET-892).
 *
 * Push uses gitPush (120s timeout — a real network push is killed by the
 * shared 10s `run()`), then createPullRequest with the given config.
 *
 * @param {string} cwd
 * @param {{ title: string, body?: string }} input
 * @param {object} [deps] injectable I/O
 * @returns {Promise<{ ok: true, pr: object, url: string } | { ok: false, error: string }>}
 */
export async function shipPullRequest(cwd, { title, body = "" } = {}, deps = {}) {
  const ctx = await resolveWriteContext(cwd, deps);
  if (ctx.error) return { ok: false, error: ctx.error };
  if (!ctx.base) return { ok: false, error: "unknown_base" };
  const gitPush = deps.gitPush ?? localGitPush;

  try {
    await gitPush({ cwd, branch: ctx.head, setUpstream: true });
  } catch (e) {
    return { ok: false, error: `push failed: ${String(e?.message ?? e)}` };
  }

  let pr;
  try {
    const res = await ctx.adapter.createPullRequest(ctx.repo, {
      title,
      body,
      base: ctx.base,
      head: ctx.head,
    });
    pr = res.data;
  } catch (e) {
    return { ok: false, error: `create pull request failed: ${String(e?.message ?? e)}` };
  }

  return { ok: true, pr, url: pr?.url ?? "" };
}

/**
 * Merge a pull request, ALWAYS passing the head SHA the user approved (issue
 * §4 — without the SHA the API merges whatever landed after the reviewed diff
 * and the failure is invisible). The typed merge errors surface the
 * distinguished reason (cannot_merge / sha_mismatch / permission) up to the
 * caller, which decides how to present it.
 *
 * @param {string} cwd
 * @param {{ number: number, method?: string, sha: string }} input
 * @param {object} [deps] injectable I/O
 * @returns {Promise<{ ok: true, data: any } | { ok: false, error: string, kind?: string }>}
 */
export async function mergePullRequest(cwd, { number, method = "merge", sha } = {}, deps = {}) {
  const ctx = await resolveWriteContext(cwd, deps, false);
  if (ctx.error) return { ok: false, error: ctx.error };
  try {
    const { data } = await ctx.adapter.merge(ctx.repo, number, { method, sha });
    return { ok: true, data };
  } catch (e) {
    const kind = e?.kind ?? (e?.name === "GithubRequestError" ? `http_${e.status}` : null);
    return { ok: false, error: String(e?.message ?? e), kind };
  }
}

// ---- Adapter interface (the seam a second adapter implements) ------------------

/**
 * forge:diff — the review pane's read. A `ref` is either a session `cwd`
 * (resolve cwd → origin → repo, then pick the open PR on the current branch;
 * a branch with none — or detached HEAD — yields "no_pr") OR an explicit
 * cross-repo target `{ repoKey, number }` for an inbox PR row (no git — the
 * read addresses the forge over the API directly, BET-850). Fetches the PR's
 * raw unified diff + normalised incoming threads + head SHA. Returns `{ diff,
 * threads, headSha, error }` — never throws for a repo with no forge
 * ("no_forge"), no token ("not_connected") or no PR ("no_pr").
 *
 * @param {string | { cwd?: string } | { repoKey: string, number: number }} ref
 * @param {{ gitRemoteOrigin?: (cwd: string) => Promise<string|null>,
 *          currentBranch?: (cwd: string) => Promise<string|null>,
 *          resolveToken?: typeof authResolveToken,
 *          getAdapter?: (kind: string, token: string) => any }} [deps]
 */
export async function forgeDiffForCwd(ref, deps = {}) {
  const ctx = await resolveRefContext(ref, deps);
  if (ctx.error) return { diff: "", threads: [], headSha: "", error: ctx.error };
  const { adapter, repo } = ctx;

  const target = await resolveRefNumber(ref, ctx, deps);
  if (target.rateLimited) return { diff: "", threads: [], headSha: "", error: null, stale: true };
  if (target.error) return { diff: "", threads: [], headSha: "", error: target.error };

  try {
    const res = await adapter.getDiff(repo, target.number);
    return {
      diff: res.data.diff ?? "",
      threads: Array.isArray(res.data.threads) ? res.data.threads : [],
      headSha: res.data.headSha ?? "",
      stale: target.stale || Boolean(res.stale),
      error: null,
    };
  } catch (err) {
    if (err instanceof ForgeRateLimitedError) {
      return { diff: "", threads: [], headSha: "", error: null, stale: true };
    }
    throw err;
  }
}

// ---- Box-facing draft review (BET-793) -------------------------------------
//
// The box owns the draft review (spec §3.4①). Comments accumulate in the
// durable draft store (draft.mjs) and "submit" flushes them in ONE operation.
// These ops resolve cwd → origin → repo → PR → token → adapter box-side, so a
// forge token never reaches the renderer (§Hygiene), and reconcile the stored
// draft against the PR's CURRENT head SHA: if the head moved past what we
// anchored to, the draft is marked stale (kept, never discarded — the renderer
// warns instead of losing typed comments).

// Resolve the box-side context a draft op needs: the forge identity, the
// adapter, the target PR number and its current head SHA, plus the canonical
// repoKey the draft store uses. `ref` is either a session `cwd` (the
// cwd → origin → forge → token → adapter preamble) or an explicit cross-repo
// `{ repoKey, number }` inbox target (BET-850 — the draft ops must hit the
// SAME PR the diff pane shows when it is opened from the inbox, which may be a
// repo the box has not cloned). Returns `{ error }` for no_forge /
// not_connected / no_pr; otherwise the full context.
async function resolveDraftContext(ref, deps) {
  const ctx = await resolveRefContext(ref, deps);
  if (ctx.error) return { error: ctx.error };
  const { adapter, repo } = ctx;

  const target = await resolveRefNumber(ref, ctx, deps);
  if (target.rateLimited) return { error: "no_pr" };
  if (target.error) return { error: target.error };
  const number = target.number;

  // The head SHA the diff was anchored at. getPullRequest is the authoritative
  // source; a failure (stale/counting) degrades to "" so the context still
  // resolves and the reconciler degrades gracefully.
  let headSha = "";
  try {
    const full = await adapter.getPullRequest(repo, number);
    if (full?.data?.headSha) headSha = full.data.headSha;
  } catch {
    /* fall back to "" */
  }

  return {
    forge: ctx.forge,
    repo,
    adapter,
    number,
    headSha,
    repoKey: ctx.repoKey,
  };
}

/**
 * forge:draft-get — the current box-buffered draft for a session's PR. If the
 * PR head has moved past the SHA the draft anchored to, the draft is marked
 * stale (kept, never cleared) and returned so the renderer warns.
 *
 * @param {string} cwd
 * @param {object} [deps] injectable I/O
 * @returns {Promise<{ draft: object | null, error: "no_forge"|"not_connected"|"no_pr"|null }>}
 */
export async function draftGetForCwd(ref, deps = {}) {
  const ctx = await resolveDraftContext(ref, deps);
  if (ctx.error) return { draft: null, error: ctx.error };
  let draft = await storeGetDraft(ctx.repoKey, ctx.number, deps);
  if (draft && draft.headSha && ctx.headSha && draft.headSha !== ctx.headSha) {
    draft = (await storeMarkDraftStale(ctx.repoKey, ctx.number, deps)) ?? draft;
  }
  return { draft, error: null };
}

/**
 * forge:draft-comment — mutate one draft comment (add / edit / delete) or set
 * the draft verdict. The box owns the draft, so every mutation is box-side and
 * publishes a `forge-draft.updated` event for connected clients.
 *
 * @param {string} cwd
 * @param {{ op: "add"|"edit"|"delete"|"set-verdict", comment?: object, verdict?: string, body?: string }} input
 * @param {object} [deps] injectable I/O
 * @returns {Promise<{ ok: true, draft: object } | { ok: false, error: string }>}
 */
export async function draftCommentForCwd(ref, input = {}, deps = {}) {
  const ctx = await resolveDraftContext(ref, deps);
  if (ctx.error) return { ok: false, error: ctx.error };
  const { op, comment, verdict, body } = input;
  switch (op) {
    case "add":
    case "edit": {
      const r = await storePutComment(ctx.repoKey, ctx.number, ctx.headSha, comment, deps);
      return r.ok ? { ok: true, draft: r.draft } : r;
    }
    case "delete": {
      const r = await storeDeleteComment(ctx.repoKey, ctx.number, comment?.id, deps);
      return { ok: true, draft: r.draft };
    }
    case "set-verdict": {
      const r = await storeSetVerdict(ctx.repoKey, ctx.number, ctx.headSha, { verdict, body }, deps);
      return r.ok ? { ok: true, draft: r.draft } : r;
    }
    default:
      return { ok: false, error: `unknown op "${op}"` };
  }
}

/**
 * forge:thread-reply — post a reply to ONE existing incoming thread. Unlike a
 * draft comment this is not buffered: a reply is per-thread and publishes
 * immediately. Box-side only; the token never reaches the renderer.
 *
 * @param {string|object} ref
 * @param {{ threadId: string, body: string }} input
 * @param {object} [deps] injectable I/O
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function replyThreadForCwd(ref, input = {}, deps = {}) {
  const ctx = await resolveDraftContext(ref, deps);
  if (ctx.error) return { ok: false, error: ctx.error };
  const threadId = String(input.threadId ?? "").trim();
  const body = String(input.body ?? "").trim();
  if (!threadId) return { ok: false, error: "missing threadId" };
  if (!body) return { ok: false, error: "empty reply" };
  try {
    await ctx.adapter.replyToThread(ctx.repo, ctx.number, {
      threadId,
      body,
      headSha: ctx.headSha,
    });
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
  return { ok: true };
}

/**
 * forge:draft-submit — flush the box-buffered draft as ONE review. The draft
 * is cleared ONLY on success; a failed submit leaves it intact and recoverable.
 * Returns a typed error (`kind`) for the distinguishable failure modes.
 *
 * @param {string} cwd
 * @param {{ verdict?: string, body?: string }} input
 * @param {object} [deps] injectable I/O
 * @returns {Promise<{ ok: true } | { ok: false, error: string, kind?: string }>}
 */
export async function draftSubmitForCwd(ref, input = {}, deps = {}) {
  const ctx = await resolveDraftContext(ref, deps);
  if (ctx.error) return { ok: false, error: ctx.error };
  const draft = await storeGetDraft(ctx.repoKey, ctx.number, deps);
  if (!draft || draft.comments.length === 0) return { ok: false, error: "nothing to submit" };
  try {
    await ctx.adapter.submitReview(ctx.repo, ctx.number, {
      verdict: input.verdict ?? draft.verdict,
      body: typeof input.body === "string" ? input.body : draft.body,
      comments: draft.comments,
      headSha: ctx.headSha || draft.headSha,
    });
  } catch (e) {
    const kind = e?.kind ?? (e?.name === "GithubRequestError" ? `http_${e.status}` : null);
    return { ok: false, error: String(e?.message ?? e), kind };
  }
  await storeClearDraft(ctx.repoKey, ctx.number, deps);
  return { ok: true };
}

// ---- Adapter interface (the seam a second adapter implements) ------------------

/**
 * The forge adapter interface, written down even though there is only one
 * implementer today (GitHub). The GitLab issue is the acceptance test for it.
 *
 * Method PRESENCE is the capability model: a future adapter simply omits a
 * method it cannot support, and callers check presence rather than consulting
 * a separate capabilities registry (which could drift). Nothing optional is
 * advertised here yet — every method below is core to the read path.
 *
 * Every method receives `repo = { owner, repo }` (lowercased strings), returns
 * `{ data, stale }` where `data` is a NORMALISED shape (never a raw forge
 * payload) and `stale` is true when the value was served from last-known
 * state, and NEVER performs retries/backoff/caching itself (that lives in
 * index.mjs).
 *
 * @typedef {Object} ForgeAdapter
 * @property {"github" | "gitlab"} kind
 * @property {((repo: { owner: string, repo: string }, number: number, input: { discussionId: string }) => Promise<{ data: any, stale: boolean }>)} [resolveThread] — OPTIONAL.
 * @property {(repo: { owner: string, repo: string }, filter?: { state?: string }) => Promise<{ data: Array<any>, stale: boolean }>} listPullRequests
 * @property {(repo: { owner: string, repo: string }, number: number) => Promise<{ data: any, stale: boolean }>} getPullRequest
 * @property {(repo: { owner: string, repo: string }, filter?: { state?: string }) => Promise<{ data: Array<any>, stale: boolean }>} listIssues
 * @property {(repo: { owner: string, repo: string }, sha: string) => Promise<{ data: Array<any>, stale: boolean }>} getChecks
 * @property {((repo: { owner: string, repo: string }, number: number) => Promise<{ data: { diff: string, threads: Array<any>, headSha: string }, stale: boolean }>)} [getDiff] — OPTIONAL. Presence is the capability model: an adapter without the diff/threads read simply omits it and the caller checks presence.
 * @property {(query: string, opts?: { ttl?: number }) => Promise<{ data: Array<any>, stale: boolean }>} [searchIssues] — OPTIONAL. The cross-repo search read that powers the inbox (spec §4.5④). GitHub implements it; an adapter whose forge has no equivalent search surface omits it. Results are already normalised to the shared InboxItem shape.
 */
