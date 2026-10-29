import { test } from "node:test";
import assert from "node:assert/strict";
import { cloneErrorKind, cloneFailureMessage, decorateCloneStatus, repoListErrorMessage, decorateRepoList } from "./cloneView.mjs";

test("S8: every kind regex, destination checked before permission", () => {
  assert.equal(cloneErrorKind("fatal: destination path 'x' already exists and is not an empty directory."), "destination");
  assert.equal(cloneErrorKind("fatal: could not create leading directories of '/x/y'"), "destination");
  // a destination problem that also mentions a permission word is still a destination problem
  assert.equal(cloneErrorKind("destination path 'x' already exists; permission denied"), "destination");
  assert.equal(cloneErrorKind("fatal: could not read Username for 'https://github.com'"), "permission");
  assert.equal(cloneErrorKind("remote: Repository not found."), "permission");
  assert.equal(cloneErrorKind("The requested URL returned error: 403"), "permission");
  assert.equal(cloneErrorKind("write error: No space left on device"), "disk");
  assert.equal(cloneErrorKind("fatal: unable to access 'https://x': Could not resolve host: github.com"), "network");
  assert.equal(cloneErrorKind("SSL certificate problem"), "network");
  assert.equal(cloneErrorKind("something odd"), "unknown");
  assert.equal(cloneErrorKind(undefined), "unknown");
});

test("S8: a failed status gains kind + sentence; a running, ok or cancelled one is untouched; raw stderr stays in `error` only", () => {
  const failed = { id: "1", done: true, ok: false, cancelled: false, error: "fatal: could not read Username" };
  const out = decorateCloneStatus(failed);
  assert.equal(out.errorKind, "permission");
  assert.equal(out.message, "permission denied. The token may not have access to this repository.");
  assert.doesNotMatch(out.message, /fatal/);
  assert.deepEqual(decorateCloneStatus({ done: false, ok: false }), { done: false, ok: false });
  assert.deepEqual(decorateCloneStatus({ done: true, ok: true }), { done: true, ok: true });
  assert.deepEqual(decorateCloneStatus({ done: true, ok: false, cancelled: true }), { done: true, ok: false, cancelled: true });
  assert.equal(decorateCloneStatus(null), null);
  for (const k of ["permission", "disk", "network", "destination", "unknown"]) assert.ok(cloneFailureMessage(k).endsWith("."));
});

test("S8: repo list errors carry a sentence and needsSignIn", () => {
  assert.equal(repoListErrorMessage("rate_limited"), "GitHub's rate limit is used up. Try again in a few minutes.");
  assert.equal(repoListErrorMessage("forbidden").startsWith("GitHub refused"), true);
  assert.equal(repoListErrorMessage("network").startsWith("Couldn't reach GitHub"), true);
  assert.equal(repoListErrorMessage("weird"), "Couldn't list your repositories from GitHub.");
  assert.deepEqual(decorateRepoList({ repos: [], stale: false, error: "rejected" }), {
    repos: [], stale: false, error: "rejected", message: "GitHub isn't connected. Go back and sign in again.", needsSignIn: true,
  });
  assert.equal(decorateRepoList({ repos: [], stale: false, error: "network" }).needsSignIn, false);
  assert.deepEqual(decorateRepoList({ repos: [1], stale: false, error: null }), { repos: [1], stale: false, error: null });
});
