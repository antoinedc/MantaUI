// requestShared.mjs — the pieces the GitHub and GitLab adapters have in common:
// the typed request/merge errors, the merge-failure mapping, query-string
// building, and the three REST calls both adapters make the same way (merge,
// list plain comments, create a plain comment). Everything here is
// forge-neutral transport shape; URLs and payloads stay in each adapter.

// Error thrown when a request to the forge fails in a way that is not a
// rate-limit (a genuine network/HTTP failure the caller should surface, not
// swallow into a stale value). Carries the URL for diagnostics.
export class GithubRequestError extends Error {
  constructor(status, url) {
    super(`github request failed (${status}) for ${url}`);
    this.name = "GithubRequestError";
    this.status = status;
    this.url = url;
  }
}

// Typed merge failures (issue §4). The UI cannot act on a generic "merge
// failed" — each status has a different next action, so each is its own class:
//   405 → cannot merge (branch protection / draft / conflict)
//   409 → the head SHA no longer matches what the user reviewed
//   403 → no permission to merge
// Anything else falls through to the generic GithubRequestError. The base
// error class carries `.status` so callers can still switch on the raw code.
export class MergeNotAllowedError extends Error {
  constructor(url) {
    super(`cannot merge ${url}`);
    this.name = "MergeNotAllowedError";
    this.status = 405;
    this.kind = "cannot_merge";
    this.url = url;
  }
}
export class MergeShaMismatchError extends Error {
  constructor(url) {
    super(`head sha no longer matches for ${url}`);
    this.name = "MergeShaMismatchError";
    this.status = 409;
    this.kind = "sha_mismatch";
    this.url = url;
  }
}
export class MergePermissionError extends Error {
  constructor(url) {
    super(`no permission to merge ${url}`);
    this.name = "MergePermissionError";
    this.status = 403;
    this.kind = "permission";
    this.url = url;
  }
}

// Map a merge PUT's failure status to its distinguished error kind. Anything
// not in the three known statuses stays an ordinary GithubRequestError (the
// caller can still read `.status`). 404 is not a merge state — a vanished PR
// is surfaced generically rather than as one of the three actionable kinds.
export function mergeFailure(status, url) {
  if (status === 405) return new MergeNotAllowedError(url);
  if (status === 409) return new MergeShaMismatchError(url);
  if (status === 403) return new MergePermissionError(url);
  return new GithubRequestError(status, url);
}

export function qs(params) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (entries.length === 0) return "";
  return "?" + new URLSearchParams(entries).toString();
}

// PUT the merge request through the write transport, mapping a failed request
// to its distinguished merge error kind (an error that is not a
// GithubRequestError passes through untouched).
export async function putMerge(requestWrite, url, body) {
  try {
    const { data } = await requestWrite(url, { method: "PUT", body });
    return { data, stale: false };
  } catch (err) {
    if (err && typeof err === "object" && typeof err.status === "number" && err.name === "GithubRequestError") {
      throw mergeFailure(err.status, url);
    }
    throw err;
  }
}

// The plain (non-review) comments at `url`, reduced to {id, body}.
export async function listPlainComments(request, url) {
  const { data, stale } = await request(url);
  const raw = Array.isArray(data) ? data : [];
  return { data: raw.map((c) => ({ id: c?.id ?? null, body: c?.body ?? "" })), stale };
}

// Write a plain comment with `method` (POST creates, PUT/PATCH update in place).
export async function writePlainComment(requestWrite, url, method, body) {
  const { data } = await requestWrite(url, { method, body: { body } });
  return { data: { id: data?.id ?? null }, stale: false };
}
