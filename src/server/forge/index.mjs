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

import { detectForge, rollupChecks, unsupportedByForge } from "../../shared/forge.mjs";
import { run } from "../tmux.mjs";
import { gitRemoteOrigin as localGitRemoteOrigin, detectForgeCli as localDetectForgeCli, gitPush as localGitPush } from "../local.mjs";
import { resolveToken as authResolveToken } from "./auth.mjs";
import { createGithubAdapter, GithubRequestError } from "./github.mjs";

// How long a fetched value is served from memory with no network request at
// all. After this, the ETag conditional GET (If-None-Match) takes over.
const FRESH_TTL_MS = 30_000;
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
 *   getJson: (url: string, opts: { token: string }) => Promise<{ data: any, stale: boolean }>,
 * }}
 */
export function createRequestLayer({ fetch = globalThis.fetch, now = Date.now } = {}) {
  const etagStore = new Map(); // url -> { etag, data, at }
  const inflight = new Map(); // url -> Promise
  const coolingUntil = new Map(); // bucketKey -> ms

  async function getJson(url, { token }) {
    const bucket = bucketOf(url);

    // Rate-limit cooling: stop issuing for this bucket, serve last-known.
    if ((coolingUntil.get(bucket) ?? 0) > now()) {
      const hit = etagStore.get(url);
      if (hit) return { data: hit.data, stale: true };
      throw new ForgeRateLimitedError(url);
    }

    // Freshness window: a value fetched within FRESH_TTL_MS is served from
    // memory with zero network requests.
    const hit = etagStore.get(url);
    if (hit && now() - hit.at < FRESH_TTL_MS) {
      return { data: hit.data, stale: false };
    }

    // Single-flight: share one in-flight request across concurrent callers for
    // the same URL.
    const inFlight = inflight.get(url);
    if (inFlight) return inFlight;

    const job = fetchOne(url, token, bucket, etagStore, inflight, coolingUntil, fetch, now);
    inflight.set(url, job);
    try {
      return await job;
    } finally {
      inflight.delete(url);
    }
  }

  return {
    getJson,
    requestJson: (url, opts) =>
      requestJsonImpl(url, { token: opts?.token, method: opts?.method, body: opts?.body }, fetch),
  };
}

// A write request: plain fetch, NO ETag cache, NO single-flight, NO cooling —
// writes must not be served from last-known state and must not share the
// GET path (issue §4). Returns `{ data, stale: false }` on 2xx; any non-2xx
// throws GithubRequestError(status, url) so the adapter can map merge-status
// codes to their distinguished failure kinds.
async function requestJsonImpl(url, { token, method = "GET", body }, fetchImpl) {
  const res = await fetchImpl(url, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "manta-forge",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new GithubRequestError(res.status, url);
  const data = await res.json();
  return { data, stale: false };
}

async function fetchOne(url, token, bucket, etagStore, inflight, coolingUntil, fetch, now) {
  const hit = etagStore.get(url);
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "manta-forge",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
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
    const cached = etagStore.get(url);
    return { data: cached ? cached.data : null, stale: false };
  }

  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    coolingUntil.set(bucket, now() + COOLING_MS);
    if (hit) return { data: hit.data, stale: true };
    throw new ForgeRateLimitedError(url);
  }

  if (!res.ok) {
    throw new Error(`github request failed (${res.status}) for ${url}`);
  }

  const data = await res.json();
  const etag = res.headers.get("etag");
  if (etag) etagStore.set(url, { etag, data, at: now() });
  return { data, stale: false };
}

// ---- Registry -----------------------------------------------------------------

// kind -> adapter factory. `create(adapterRequest)` returns the adapter; the
// adapterRequest closure binds a per-call token to the SHARED request layer so
// ETag/single-flight/cooling persist across calls and across token rotations.
const ADAPTERS = Object.freeze({ github: createGithubAdapter });

/**
 * Create an isolated forge runtime with its own request layer — the test seam.
 * Production uses defaultRuntime; getAdapter() delegates to it.
 *
 * @param {{ fetch?: typeof fetch }} [opts]
 */
export function createForgeRuntime({ fetch = globalThis.fetch } = {}) {
  const requestLayer = createRequestLayer({ fetch });
  return {
    getAdapter(kind, token) {
      const create = ADAPTERS[kind];
      if (!create) throw unsupportedByForge(kind, "read path");
      const request = (url) => requestLayer.getJson(url, { token });
      const requestWrite = (url, opts) => requestLayer.requestJson(url, { token, ...opts });
      return create(request, requestWrite);
    },
    requestLayer,
  };
}

const defaultRuntime = createForgeRuntime();

/**
 * `getAdapter(kind)` → the adapter for a forge, or throws UnsupportedByForgeError
 * for an unknown kind. The instance is bound to the shared request layer and a
 * per-call token.
 * @param {"github"} kind
 * @param {string} token
 */
export function getAdapter(kind, token) {
  return defaultRuntime.getAdapter(kind, token);
}

// ---- Box-facing reads ----------------------------------------------------------

const GH_HOST = "github.com";
const EMPTY = Object.freeze({ pr: null, checks: [], rollup: "none", stale: false, error: null });

/**
 * forge:status — `{ connected, login, kind } | { connected: false }`.
 * `login` comes from `gh auth status` (a non-secret identity); `connected` is
 * whether a token resolves. A token NEVER appears in this result — the value
 * the caller is pointed at is only ever used to authenticate the fetch layer.
 *
 * @param {{ resolveToken?: typeof authResolveToken, detectCli?: () => Promise<{ installed: boolean, authenticated: boolean, login: string | null }> }} [deps]
 */
export async function forgeStatus({ resolveToken = authResolveToken, detectCli = localDetectForgeCli } = {}) {
  const [cli, tok] = await Promise.all([detectCli(), resolveToken(GH_HOST)]);
  if (!tok) return { connected: false };
  return { connected: true, login: cli?.login ?? null, kind: "github" };
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

/**
 * forge:pull-request — resolve `cwd → origin → repo`, pick the open PR on the
 * current branch (falling back to the first open PR), and return the
 * normalised PR + merged checks + rollup. Never throws for "no PR" or "not
 * connected" — those are well-formed `{ error }` / `{ pr: null }` results.
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
  const gitRemoteOrigin = deps.gitRemoteOrigin ?? defaultGitRemoteOrigin;
  const currentBranch = deps.currentBranch ?? defaultCurrentBranch;
  const resolveToken = deps.resolveToken ?? authResolveToken;
  const getAdapterFn = deps.getAdapter ?? getAdapter;

  const origin = await gitRemoteOrigin(cwd);
  const forge = origin ? detectForge(origin) : null;
  if (!forge || forge.kind !== "github") {
    return { ...EMPTY, error: "no_forge" };
  }

  const tok = await resolveToken(forge.host);
  if (!tok) return { ...EMPTY, error: "not_connected" };

  const adapter = getAdapterFn(forge.kind, tok.token);
  const repo = { owner: forge.owner, repo: forge.repo };

  let prArr = [];
  let stale = false;
  try {
    const res = await adapter.listPullRequests(repo, { state: "open" });
    prArr = Array.isArray(res.data) ? res.data : [];
    stale = res.stale;
  } catch (err) {
    if (err instanceof ForgeRateLimitedError) {
      return { ...EMPTY, stale: true };
    }
    throw err;
  }

  if (prArr.length === 0) return { ...EMPTY, stale };

  const branch = await currentBranch(cwd);
  let candidate = branch ? prArr.find((p) => p.headRef === branch) : undefined;
  if (!candidate) candidate = prArr[0];

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

  return { pr, checks, rollup: rollupChecks(checks), stale: staleChecks, error: null };
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
  const gitRemoteOrigin = deps.gitRemoteOrigin ?? defaultGitRemoteOrigin;
  const currentBranch = deps.currentBranch ?? defaultCurrentBranch;
  const resolveToken = deps.resolveToken ?? authResolveToken;
  const getAdapterFn = deps.getAdapter ?? getAdapter;

  const origin = await gitRemoteOrigin(cwd);
  const forge = origin ? detectForge(origin) : null;
  if (!forge || forge.kind !== "github") return { error: "no_forge" };
  const tok = await resolveToken(forge.host);
  if (!tok) return { error: "not_connected" };
  const adapter = getAdapterFn(forge.kind, tok.token);
  const repo = { owner: forge.owner, repo: forge.repo };
  let head = null;
  if (wantBranch) {
    head = await currentBranch(cwd);
    if (!head) return { error: "no_branch" };
  }
  return { forge, repo, adapter, head };
}

/**
 * Ship preview: the facts the [SH1] confirm card shows BEFORE anything is
 * pushed — the head branch, the base branch (the PR target), and the number
 * of changed files on the branch (best-effort, 0 when it can't be computed).
 * Read-only; no push, no PR. This is what populates the editable confirm card;
 * the push+create only ever runs after the human confirms it.
 *
 * @param {string} cwd
 * @param {object} [deps] injectable I/O
 * @returns {Promise<{ ok: true, head: string, base: string, fileCount: number } | { ok: false, error: string }>}
 */
export async function shipPreview(cwd, deps = {}) {
  const ctx = await resolveWriteContext(cwd, deps);
  if (ctx.error) return { ok: false, error: ctx.error };
  const base = "main";
  let fileCount = 0;
  try {
    const { stdout } = await run("git", ["-C", cwd, "diff", "--name-only", `origin/${base}...${ctx.head}`, "--"]);
    fileCount = String(stdout ?? "").split("\n").filter((l) => l.length > 0).length;
  } catch {
    // origin/<base> may not exist locally yet — best-effort 0.
  }
  return { ok: true, head: ctx.head, base, fileCount };
}

/**
 * Ship: push the current branch, then open a pull request for it. The human
 * gate (issue §4) lives ABOVE this — this function is the push+create step
 * that runs only after an explicit confirm. It is the ONE code path for
 * "open a PR", reused by the human ship action and any future automated one
 * (a background job reaches it as a draft and never merges).
 *
 * Push uses gitPush (120s timeout — a real network push is killed by the
 * shared 10s `run()`), then createPullRequest with the given config.
 *
 * @param {string} cwd
 * @param {{ title: string, body?: string, base?: string, draft?: boolean }} input
 * @param {object} [deps] injectable I/O
 * @returns {Promise<{ ok: true, pr: object, url: string } | { ok: false, error: string }>}
 */
export async function shipPullRequest(cwd, { title, body = "", base, draft = false } = {}, deps = {}) {
  const ctx = await resolveWriteContext(cwd, deps);
  if (ctx.error) return { ok: false, error: ctx.error };
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
      base: base ?? "main",
      head: ctx.head,
      draft: draft ?? false,
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
 * @property {(repo: { owner: string, repo: string }, filter?: { state?: string }) => Promise<{ data: Array<any>, stale: boolean }>} listPullRequests
 * @property {(repo: { owner: string, repo: string }, number: number) => Promise<{ data: any, stale: boolean }>} getPullRequest
 * @property {(repo: { owner: string, repo: string }, filter?: { state?: string }) => Promise<{ data: Array<any>, stale: boolean }>} listIssues
 * @property {(repo: { owner: string, repo: string }, sha: string) => Promise<{ data: Array<any>, stale: boolean }>} getChecks
 */
