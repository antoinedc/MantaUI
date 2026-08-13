// Hand-written type declarations for forge.mjs. The implementation is plain
// JS so any server code imports it natively; the renderer imports through
// bundler resolution. Keep in sync with src/shared/forge.mjs.

// The forges we model. Deliberately only these two — adding a kind is a
// design decision that ships with that forge's adapter (spec §3.5).
export type ForgeKind = "github" | "gitlab";

// A normalised pull-request / merge-request state. Four values only; the
// forge raw values ("opened", "locked", merged-as-closed) are reconciled by
// `normalizePrState`, never surfaced here.
export type PullRequestState = "draft" | "open" | "merged" | "closed";

// The normalised CI rollup — a traffic-light for logic. The raw per-check
// array is kept separately for display (spec §3.4②).
export type CheckRollup = "green" | "yellow" | "red" | "none";

// A normalised review verdict. GitLab has no review object at all; this is
// what the box-buffered draft review produces.
export type ReviewVerdict =
  | "approved"
  | "changes_requested"
  | "commented"
  | "pending";

// The shared PR/MR type. Always normalised, never a raw forge payload.
// `number` is GitHub `number` and GitLab `iid` — never GitLab's global `id`.
// `mergeable` is `null` while the forge is still computing it. `mergeBlockedReason`
// is human readable (e.g. "checks failing", "not approved").
export type PullRequest = {
  number: number;
  title: string;
  body: string;
  url: string;
  state: PullRequestState;
  draft: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  author: string;
  reviewers: string[];
  mergeable: true | false | null;
  mergeBlockedReason: string | null;
  unresolvedThreads: number;
};

// A normalised per-check row, as fed to `rollupChecks`. Already normalised at
// the adapter boundary — its `status`/`conclusion` are the adapter's words,
// not a raw forge enum.
export type ForgeCheck = {
  name: string;
  status?: string;
  conclusion?: string;
  url?: string;
};

// Parse a git remote URL into its forge identity. Returns
// `{ kind, host, owner, repo }` (lowercased; `owner` is the full
// `group/subgroup` path for GitLab) or `null` for a local path, a non-URL
// string, an empty string, `undefined`, or a non-github/gitlab host.
// Credentials in the URL are always stripped.
export function detectForge(
  remoteUrl: unknown,
): { kind: ForgeKind; host: string; owner: string; repo: string } | null;

// Canonical stable join key `host/owner/repo`, lowercased, no `.git`, no
// trailing slash. Identical for the HTTPS and SSH forms of the same repo.
export function repoKey(repo: {
  host: string;
  owner: string;
  repo: string;
}): string;

// Normalise a forge's raw PR/MR state into the shared `PullRequestState`.
// Handles GitLab `opened`/`locked` and GitHub merged-as-closed. Throws on an
// unknown raw state.
export function normalizePrState(
  raw: { state: string; merged?: boolean; draft?: boolean },
  kind: ForgeKind,
): PullRequestState;

// Roll the already-normalised per-check array up to a single traffic-light.
// Returns ONLY the tri-state; never mutates the input array.
export function rollupChecks(checks: ForgeCheck[]): CheckRollup;

// A typed error for a capability a forge does not have. Carries `.kind` and
// `.capability` so a capability gap is a value to pattern-match, not a thrown
// string.
export class UnsupportedByForgeError extends Error {
  readonly kind: ForgeKind;
  readonly capability: string;
  constructor(kind: ForgeKind, capability: string);
}

// Construct an {@link UnsupportedByForgeError}.
export function unsupportedByForge(
  kind: ForgeKind,
  capability: string,
): UnsupportedByForgeError;
