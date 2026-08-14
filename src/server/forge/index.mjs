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

import { detectForge, rollupChecks, unsupportedByForge, repoKey as forgeRepoKey } from "../../shared/forge.mjs";
import { run } from "../tmux.mjs";
import { gitRemoteOrigin as localGitRemoteOrigin, detectForgeCli as localDetectForgeCli, gitPush as localGitPush } from "../local.mjs";
import { resolveToken as authResolveToken } from "./auth.mjs";
import { createGithubAdapter, GithubRequestError } from "./github.mjs";
import { getDraft as storeGetDraft, putComment as storePutComment, deleteComment as storeDeleteComment, setVerdict as storeSetVerdict, markDraftStale as storeMarkDraftStale, clearDraft as storeClearDraft } from "./draft.mjs";
import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";

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

    const job = fetchOne(url, token, bucket, url, "application/vnd.github+json", (res) => res.json(), etagStore, inflight, coolingUntil, fetch, now);
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
  async function getText(url, { token }) {
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

    const job = fetchOne(url, token, bucket, cacheKey, "application/vnd.github.diff", (res) => res.text(), etagStore, inflight, coolingUntil, fetch, now);
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

async function fetchOne(url, token, bucket, cacheKey, accept, parse, etagStore, inflight, coolingUntil, fetch, now) {
  const hit = etagStore.get(cacheKey);
  const headers = {
    accept,
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
    const cached = etagStore.get(cacheKey);
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

  const data = await parse(res);
  const etag = res.headers.get("etag");
  if (etag) etagStore.set(cacheKey, { etag, data, at: now() });
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
      const requestText = (url) => requestLayer.getText(url, { token });
      return create(request, requestWrite, requestText);
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
  const base = deps.defaultBase ?? "main";

  let files = [];
  try {
    const { stdout } = await run("git", ["-C", cwd, "diff", "--name-only", `origin/${base}...${ctx.head}`, "--"]);
    files = String(stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    // origin/<base> may not exist locally yet — best-effort empty.
  }

  const title = await draftTitle(cwd, ctx.head, deps);
  const body = await draftBody(cwd, ctx.head, base, files, deps);
  return { ok: true, head: ctx.head, base, fileCount: files.length, title, body };
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

// Body draft: the repo's PR template when one exists (honouring step-1's
// "honouring the repo's PR template"), else a short changed-files summary.
// Template `${head}` / `${base}` placeholders, if present, are filled.
async function draftBody(cwd, head, base, files, deps) {
  const readPrTemplate = deps.readPrTemplate ?? defaultReadPrTemplate;
  const template = await readPrTemplate(cwd, deps);
  if (template && template.trim()) {
    return template
      .replace(/\$\{head\}/g, head || "")
      .replace(/\$\{base\}/g, base || "");
  }
  if (files.length === 0) return "";
  return `## What\n\nOpens ${head} → ${base}.\n\n## Changed files\n\n${files.map((f) => `- ${f}`).join("\n")}`;
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
 * forge:diff — the review pane's read. Resolve `cwd → origin → repo`, pick the
 * open PR on the current branch (falling back to the first open PR) exactly as
 * `pullRequestForCwd` does, then fetch its raw unified diff + normalised
 * incoming threads + head SHA. Returns `{ diff, threads, headSha, error }` —
 * never throws for a repo with no forge ("no_forge"), no token
 * ("not_connected") or no open PR ("no_pr").
 *
 * @param {string} cwd
 * @param {{ gitRemoteOrigin?: (cwd: string) => Promise<string|null>,
 *          currentBranch?: (cwd: string) => Promise<string|null>,
 *          resolveToken?: typeof authResolveToken,
 *          getAdapter?: (kind: string, token: string) => any }} [deps]
 */
export async function forgeDiffForCwd(cwd, deps = {}) {
  const gitRemoteOrigin = deps.gitRemoteOrigin ?? defaultGitRemoteOrigin;
  const currentBranch = deps.currentBranch ?? defaultCurrentBranch;
  const resolveToken = deps.resolveToken ?? authResolveToken;
  const getAdapterFn = deps.getAdapter ?? getAdapter;

  const origin = await gitRemoteOrigin(cwd);
  const forge = origin ? detectForge(origin) : null;
  if (!forge || forge.kind !== "github") {
    return { diff: "", threads: [], headSha: "", error: "no_forge" };
  }

  const tok = await resolveToken(forge.host);
  if (!tok) return { diff: "", threads: [], headSha: "", error: "not_connected" };

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
      return { diff: "", threads: [], headSha: "", error: null, stale: true };
    }
    throw err;
  }
  if (prArr.length === 0) return { diff: "", threads: [], headSha: "", error: "no_pr" };

  const branch = await currentBranch(cwd);
  let candidate = branch ? prArr.find((p) => p.headRef === branch) : undefined;
  if (!candidate) candidate = prArr[0];

  try {
    const res = await adapter.getDiff(repo, candidate.number);
    return {
      diff: res.data.diff ?? "",
      threads: Array.isArray(res.data.threads) ? res.data.threads : [],
      headSha: res.data.headSha ?? "",
      stale: stale || Boolean(res.stale),
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
// repoKey the draft store uses. Returns `{ error }` for no_forge /
// not_connected / no_pr; otherwise the full context.
//
// Built on the SHARED resolveWriteContext (the cwd → origin → forge → token →
// adapter preamble) rather than a parallel copy — the draft variant only adds
// the PR-number + head-SHA resolution on top of what that resolver already
// returns. One code path (issue §Hygiene).
async function resolveDraftContext(cwd, deps) {
  const base = await resolveWriteContext(cwd, deps, false);
  if (base.error) return { error: base.error };

  const currentBranch = deps.currentBranch ?? defaultCurrentBranch;
  const adapter = base.adapter;
  const repo = base.repo;

  const res = await adapter.listPullRequests(repo, { state: "open" });
  const prArr = Array.isArray(res.data) ? res.data : [];
  if (prArr.length === 0) return { error: "no_pr" };

  const branch = await currentBranch(cwd);
  const branchPr = branch ? prArr.find((p) => p.headRef === branch) : undefined;
  const number = branchPr?.number ?? prArr[0].number;

  // The head SHA the diff was anchored at. getPullRequest is the authoritative
  // source; a failure (stale/counting) falls back to the list entry's SHA so
  // the context still resolves and the reconciler degrades gracefully.
  let headSha = prArr.find((p) => p.number === number)?.headSha ?? "";
  try {
    const full = await adapter.getPullRequest(repo, number);
    if (full?.data?.headSha) headSha = full.data.headSha;
  } catch {
    /* fall back to the list's headSha */
  }

  return {
    forge: base.forge,
    repo,
    adapter,
    number,
    headSha,
    repoKey: forgeRepoKey({ host: base.forge.host, owner: base.forge.owner, repo: base.forge.repo }),
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
export async function draftGetForCwd(cwd, deps = {}) {
  const ctx = await resolveDraftContext(cwd, deps);
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
export async function draftCommentForCwd(cwd, input = {}, deps = {}) {
  const ctx = await resolveDraftContext(cwd, deps);
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
 * forge:draft-submit — flush the box-buffered draft as ONE review. The draft
 * is cleared ONLY on success; a failed submit leaves it intact and recoverable.
 * Returns a typed error (`kind`) for the distinguishable failure modes.
 *
 * @param {string} cwd
 * @param {{ verdict?: string, body?: string }} input
 * @param {object} [deps] injectable I/O
 * @returns {Promise<{ ok: true } | { ok: false, error: string, kind?: string }>}
 */
export async function draftSubmitForCwd(cwd, input = {}, deps = {}) {
  const ctx = await resolveDraftContext(cwd, deps);
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
 * @property {(repo: { owner: string, repo: string }, filter?: { state?: string }) => Promise<{ data: Array<any>, stale: boolean }>} listPullRequests
 * @property {(repo: { owner: string, repo: string }, number: number) => Promise<{ data: any, stale: boolean }>} getPullRequest
 * @property {(repo: { owner: string, repo: string }, filter?: { state?: string }) => Promise<{ data: Array<any>, stale: boolean }>} listIssues
 * @property {(repo: { owner: string, repo: string }, sha: string) => Promise<{ data: Array<any>, stale: boolean }>} getChecks
 * @property {((repo: { owner: string, repo: string }, number: number) => Promise<{ data: { diff: string, threads: Array<any>, headSha: string }, stale: boolean }>)} [getDiff] — OPTIONAL. Presence is the capability model: an adapter without the diff/threads read simply omits it and the caller checks presence.
 */
