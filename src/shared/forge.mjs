// forge.mjs — the L0 forge seam: pure vocabulary for the MantaUI forge
// integration (BET-785).
//
// This is the layer EVERYTHING else in the forge project imports from — the
// repo probe (which normalises a git remote URL) and the GitHub / GitLab
// adapters (which normalise raw forge payloads). It is designed against
// GitLab's documentation as well as GitHub's, BEFORE either adapter exists,
// exactly so the shared types are not GitHub-shaped with GitLab filed off.
//
// Contract (design spec §3.1 / §3.2 L0):
//   - 100% pure. No `fetch`, no `node:fs`, no `node:child_process`, no
//     network, no filesystem, no spawn. The only global used is `URL`, which
//     is a pure string parser, not I/O. If this module ever needs I/O the
//     design is wrong.
//   - Named exports only. No default export, matching the rest of src/shared/.
//   - Unknown input is rejected loudly (returned `null` or a thrown typed
//     error) rather than coerced.
//
// Vocabulary discipline (spec §3.1):
//   - The shared PR/MR type is named `PullRequest`, deliberately (the term
//     users already know on both forges) — but its fields are NORMALISED
//     shapes, never a raw forge payload. GitLab's per-project `iid` maps to
//     `number`; GitLab's disjoint Issues and absent review object are
//     reconciled at the adapter boundary, not here.
//   - No `gitea` / `bitbucket` kind. Out of scope and a settled design
//     decision (spec §3.5 sketches gitea as ~a day once the seam exists).

/**
 * The forges we model. Deliberately only these two — adding a kind is a
 * design decision that ships with that forge's adapter, not a guess here.
 * @typedef {"github" | "gitlab"} ForgeKind
 */

/**
 * A normalised pull-request / merge-request state. Four values only. GitLab
 * emits `"opened"` (not `"open"`) and also has `"locked"`; GitHub reports a
 * merged PR as `closed` + a separate `merged` flag. Those forge raw values
 * are reconciled by `normalizePrState`, never surfaced here.
 * @typedef {"draft" | "open" | "merged" | "closed"} PullRequestState
 */

/**
 * The normalised CI rollup — a traffic-light. Drives logic (can I merge,
 * should I nudge). The raw per-check array is kept separately for display.
 * This tri-state / raw-list split is spec §3.4②.
 * @typedef {"green" | "yellow" | "red" | "none"} CheckRollup
 */

/**
 * A normalised review verdict. GitLab has no review object at all (it has
 * approve/unapprove booleans and a merge-status enum); this shared verdict is
 * what the box-buffered draft review produces. Spec §3.1.
 * @typedef {"approved" | "changes_requested" | "commented" | "pending"} ReviewVerdict
 */

/**
 * The shared PR/MR type. Always normalised, never a raw forge payload.
 * `number` is GitHub `number` and GitLab `iid` — never GitLab's global `id`.
 * `mergeable` is `null` while the forge is still computing it (caller retries).
 * `mergeBlockedReason` is human readable (e.g. "checks failing", "not
 * approved') so "cannot merge" means something to a user. Spec §3.1 / §3.4②.
 * @typedef {{
 *   number: number,
 *   title: string,
 *   body: string,
 *   url: string,
 *   state: PullRequestState,
 *   draft: boolean,
 *   headRef: string,
 *   baseRef: string,
 *   headSha: string,
 *   author: string,
 *   reviewers: string[],
 *   mergeable: true | false | null,
 *   mergeBlockedReason: string | null,
 *   unresolvedThreads: number,
 * }} PullRequest
 */

// ---------------------------------------------------------------------------
// Forge detection
// ---------------------------------------------------------------------------

// Remote hosts we recognise, and the kind each maps to. Anything else is out
// of scope (self-hosted host mapping is a deliberate design decision that
// arrives with the GitLab adapter) and rejected.
const HOST_KIND = Object.freeze({
  "github.com": "github",
  "gitlab.com": "gitlab",
});

/**
 * Parse a git remote URL into its forge identity.
 *
 * Handles the HTTPS, `ssh://` and scp-like (`git@host:owner/repo.git`) forms,
 * GitHub's flat `owner/repo`, GitLab's nested `group/subgroup/project`,
 * trailing slashes, an optional `.git` suffix, and strips any credentials
 * that appear in the URL.
 *
 * Returns `{ kind, host, owner, repo }` — all lowercased, owner is the full
 * `group/subgroup` path for GitLab. `host` is "github.com" | "gitlab.com".
 *
 * Returns `null` for a local path, a non-URL string, an empty string,
 * `undefined`, and any host that is not github.com or gitlab.com.
 *
 * A credential appearing anywhere in the return value is a security bug —
 * there is an explicit test pinning that.
 *
 * @param {unknown} remoteUrl
 * @returns {{ kind: ForgeKind, host: string, owner: string, repo: string } | null}
 */
export function detectForge(remoteUrl) {
  if (typeof remoteUrl !== "string") return null;
  const input = remoteUrl.trim();
  if (input === "") return null;

  let host;
  let path;
  const scp = input.match(/^[^@\s/]+@([^:\s]+):(.+)$/);
  if (scp) {
    // scp-like form: `git@github.com:owner/repo.git` — not a URL, no scheme.
    host = scp[1];
    path = scp[2];
  } else {
    let url;
    try {
      url = new URL(input);
    } catch {
      return null;
    }
    // Only http(s)/ssh remote URLs are git remotes. Anything else (ftp,
    // file, a bare host with no scheme that somehow parsed) is not one.
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ssh:") {
      return null;
    }
    // We use hostname + pathname only, so credentials (user:pass@host) are
    // structurally excluded from the result.
    host = url.hostname;
    path = url.pathname;
  }

  host = host.toLowerCase();
  const kind = HOST_KIND[host];
  if (kind === undefined) return null;

  const parsed = parseOwnerRepo(path);
  if (parsed === null) return null;
  return { kind, host, owner: parsed.owner, repo: parsed.repo };
}

// Split `/owner/repo/` (or `owner/repo.git`) into { owner, repo }. `owner` is
// every path segment before the repo, joined with `/`, so GitLab subgroups
// fall out naturally (`group/subgroup/project` → owner "group/subgroup"). The
// `.git` suffix is optional on the repo segment. Strips leading/trailing
// slashes and rejects anything without both an owner and a repo.
function parseOwnerRepo(rawPath) {
  const path = rawPath.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (path === "") return null;
  const parts = path.split("/").filter((segment) => segment !== "");
  if (parts.length < 2) return null;
  const owner = parts.slice(0, -1).join("/").toLowerCase();
  const repo = parts[parts.length - 1].toLowerCase().replace(/\.git$/, "");
  if (owner === "" || repo === "") return null;
  return { owner, repo };
}

// ---------------------------------------------------------------------------
// Canonical join key
// ---------------------------------------------------------------------------

/**
 * A canonical, stable join key for a repository: `host/owner/repo`, all
 * lowercased, no `.git` suffix, no trailing slash. Used as the join key by
 * the repo probe, the rules store and project metadata, so it must be
 * identical for the HTTPS and SSH forms of the same repository (both forms
 * parse to the same host/owner/repo via `detectForge`).
 *
 * @param {{ host: string, owner: string, repo: string }} repo
 * @returns {string}
 */
export function repoKey({ host, owner, repo }) {
  const h = String(host).toLowerCase().replace(/\/+$/, "");
  const o = String(owner).toLowerCase().replace(/^\/+|\/+$/g, "");
  const r = String(repo).toLowerCase().replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  return `${h}/${o}/${r}`;
}

/**
 * The inverse of `repoKey`: split a `host/owner/repo` key back into its forge
 * identity. `host` is the first segment and must map to a known forge kind
 * (github.com / gitlab.com); `owner` is every middle segment joined with `/`
 * (so GitLab subgroups fall out unchanged); `repo` is the last segment.
 *
 * Cross-repo inbox rows carry only this join key (host/owner/repo) plus a PR
 * number — there is no cwd to resolve from. This is what lets the diff/draft
 * reads address an explicit inbox PR instead of the session's cwd (BET-850).
 *
 * Returns `null` for a non-string, a key with fewer than three segments, or a
 * host that is not a known forge (mirrors `detectForge`'s loud rejection of
 * unknown hosts).
 *
 * @param {unknown} key `host/owner/repo`
 * @returns {{ kind: ForgeKind, host: string, owner: string, repo: string } | null}
 */
export function repoKeyParts(key) {
  if (typeof key !== "string") return null;
  const parts = key
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter((s) => s !== "");
  if (parts.length < 3) return null;
  const host = parts[0].toLowerCase();
  const kind = HOST_KIND[host];
  if (kind === undefined) return null;
  const owner = parts.slice(1, -1).map((s) => s.toLowerCase()).join("/");
  const repo = parts[parts.length - 1].toLowerCase().replace(/\.git$/, "");
  if (owner === "" || repo === "") return null;
  return { kind, host, owner, repo };
}

// ---------------------------------------------------------------------------
// PR/MR state normalisation
// ---------------------------------------------------------------------------

// What each forge's raw `state` string means, after the merged/draft flags
// (which live outside `state` on both forges) have been considered. GitLab
// emits `opened` (not `open`) and its own `locked`; GitHub emits `closed` for
// both a closed and a merged PR (the `merged` flag disambiguates).
const STATE_BY_KIND = Object.freeze({
  github: Object.freeze({
    open: "open",
    closed: "closed",
  }),
  gitlab: Object.freeze({
    opened: "open",
    closed: "closed",
    // A locked GitLab MR is an *open* MR whose discussion has been locked
    // (admin action, or a bot); it is not merged, not closed, not draft, so
    // it normalises to "open". The spec has no sixth state — the shared enum
    // is four values and locked must land on one of them.
    locked: "open",
    merged: "merged",
  }),
});

/**
 * Normalise a forge's raw PR/MR state into the shared `PullRequestState`.
 *
 * Both forges carry `merged` and `draft` as booleans OUTSIDE `state`, so the
 * raw `state` string alone is ambiguous in exactly two places, which is the
 * whole reason this function exists:
 *   - GitHub reports a merged PR as `state: "closed"` + `merged: true` — so
 *     `closed` alone cannot mean "merged".
 *   - GitLab reports `state: "opened"`, not `"open"`, and also emits
 *     `"locked"`.
 *
 * Order is: a merged PR wins over everything; a draft PR wins over the
 * open/closed classification; then the per-forge `state` table maps the rest.
 * Graceful handling: merged is checked before draft so a merged-but-shown-as-
 * draft PR is still "merged".
 *
 * @param {{ state: string, merged?: boolean, draft?: boolean }} raw the forge PR/MR payload fields
 * @param {ForgeKind} kind
 * @returns {PullRequestState}
 * @throws {Error} if the raw state is not one the forge emits (unknown input
 *   is rejected loudly rather than coerced — module invariant).
 */
export function normalizePrState({ state, merged, draft }, kind) {
  if (merged === true) return "merged";
  if (draft === true) return "draft";

  const table = STATE_BY_KIND[kind];
  const normalized = table ? table[state] : undefined;
  if (normalized === undefined) {
    throw new Error(
      `normalizePrState: unknown ${kind} state ${JSON.stringify(state)}`,
    );
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Checks rollup
// ---------------------------------------------------------------------------

// Conclusion values that make a check read as RED (the run did not pass).
const RED_CONCLUSIONS = new Set(["failure", "failed", "timed_out", "timeout", "action_required"]);

// Status values that mean the check is still PENDING/RUNNING (not finished).
const PENDING_STATUSES = new Set([
  "queued",
  "pending",
  "in_progress",
  "running",
  "waiting",
  "started",
]);

/**
 * Roll the already-normalised per-check array up to a single traffic-light.
 *
 * Rules, in order: any red → `"red"`; else any pending/running → `"yellow"`;
 * else any green → `"green"`; else `"none"` (including empty input).
 *
 * This returns ONLY the tri-state. It must not mutate, filter or discard the
 * input array — callers keep the raw list for display. That split (tri-state
 * for logic, raw list for display) is spec §3.4② and the single most-copied
 * lesson from Renovate's eleven-platform abstraction.
 *
 * @param {Array<{ name: string, status?: string, conclusion?: string, url?: string }>} checks
 * @returns {CheckRollup}
 */
export function rollupChecks(checks) {
  let sawPending = false;
  let sawGreen = false;
  for (const check of checks) {
    if (RED_CONCLUSIONS.has(check.conclusion)) return "red";
    if (PENDING_STATUSES.has(check.status)) sawPending = true;
    if (check.conclusion === "success") sawGreen = true;
  }
  if (sawPending) return "yellow";
  if (sawGreen) return "green";
  return "none";
}

// ---------------------------------------------------------------------------
// Typed capability-gap error
// ---------------------------------------------------------------------------

/**
 * A typed error for a capability a forge simply does not have (e.g. "GitLab
 * has no pending-review concept"). Carries `.kind` and `.capability` so a
 * capability gap is a value a caller can pattern-match, not a thrown string
 * to regex. The optional capability methods on a forge adapter are the
 * feature flag (spec §3.2), and this error is what an adapter throws when
 * one is invoked anyway.
 *
 * @extends {Error}
 */
export class UnsupportedByForgeError extends Error {
  /**
   * @param {ForgeKind} kind
   * @param {string} capability
   */
  constructor(kind, capability) {
    super(`${capability} is not supported by ${kind}`);
    this.name = "UnsupportedByForgeError";
    this.kind = kind;
    this.capability = capability;
  }
}

/**
 * Construct an {@link UnsupportedByForgeError}.
 * @param {ForgeKind} kind
 * @param {string} capability
 * @returns {UnsupportedByForgeError}
 */
export function unsupportedByForge(kind, capability) {
  return new UnsupportedByForgeError(kind, capability);
}
