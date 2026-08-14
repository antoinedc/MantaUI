## Summary

Follow-up to BET-767 (deep `src/server/*.mjs` audit, reviewed PASS). Fixes the systemic finding that the engine job stores were each mutated by multiple async writers with no per-store write serialization, and that the shared atomic-write primitive could collide on its temp name.

### Root cause -> fix

- **`src/server/jsonStore.mjs`** — P3-1: temp name was `pid-Date.now()`, so two same-process, same-millisecond writes to one path collided (one `rename` throws ENOENT into a poller, or the final file is clobbered). Now a monotonic per-process counter is appended (`pid-ts-counter`), generated inside a new per-path writer mutex, so concurrent same-path writes can never collide. Also exports `createMutex` — the shared single-writer primitive used by the stores below — and serializes writers to the same path.
- **`src/server/delegate.mjs`** — P2-1/2-2/2-3: all writers now run their read-modify-write under one module-level `jobsLock`, and each re-reads the store inside the lock: `startJob` (nesting + `MAX_RUNNING_JOBS` cap check and the record append), `adoptSubagentJob`, `finishJob`, `stopJob`, `deleteJob`, `tickActivity`, and the sweeper's retention. `startJob` now checks the cap *inside* the lock, before the worktree/window is created, so a burst of concurrent `delegate` POSTs can never exceed `MAX_RUNNING_JOBS` (previously the read-then-act cap passed twice). `finishJob` re-reads the job under the lock and bails if already terminal, so a stale writer can't flip a completed job to "timed out" (and notify a false timeout) nor resurrect a terminal job to `running`.
- **`src/server/capabilities.mjs`** — P2-3: `createCapJob`, `startJob` (claim), `appendLog`, `completeJob`, and `sweepCapJobs` all run under one module-level `jobsLock`. `completeJob` holds the lock across `markTerminal` (including its async session-notify gap), so an executor "done" POST can no longer race the 60s timeout sweep into flipping a completed job to "timed out" or vice versa.
- The pollers' inFlight re-entrancy guards + `timer.unref()` are preserved unchanged (`startActivityPoller`, `startSweeper`, `startCapSweeper`); only `tickActivity` is now exported (additively) so the resurrection test can drive the real poller body.
- Anti-spaghetti: `createMutex` + the per-path lock live once in `jsonStore.mjs` (the existing single source for the atomic write) and are shared — no per-store copies.

### Tests added (`src/server/auditJobsConcurrency.test.mjs`, node:test)

- Two concurrent same-path jsonStore writes both land — no ENOENT, no clobber, no temp left.
- Two concurrent `appendLog` writers to one job — no lost update.
- >`MAX_RUNNING_JOBS` concurrent `delegate` starts never exceed the cap (exactly 5 succeed).
- A completing (delegate + cap) job racing the timeout sweep is not flipped to "timed out" / not notified of a false timeout.
- A done job is not resurrected to `running` by a stale activity-poller write.

Verified these tests fail when the lock is disabled (e.g. the lost-update test fails on the unlocked path), so they are non-vacuous.

### Out of scope (tracked separately per the issue)

- `ensureAuth`/`revoke` race and the promptDelivery bounded-queue item — their own follow-ups.

**Files changed:** `4`. `src/server/jsonStore.mjs`, `src/server/delegate.mjs`, `src/server/capabilities.mjs`, `src/server/auditJobsConcurrency.test.mjs`.

**Base: `origin/main` @ `3f41ae8`**

## Verification results

- PR branch (`multica/BET-770-serialize-job-store-writes` @ `f7a00d3`):
  - typecheck: exit 0. Errors: none. log sha256: `75342603966d11824516b89baa97128413853820f43086df3254737d95622e1f`
  - test: exit 0. vitest `2364 pass / 7 skip`; node `1637 pass / 0 fail / 0 skip` (1631 pre-existing + 6 new). Failures: none. log sha256: `20906a8dcc82f245fc6b2f216714ac4aa6650a34c6d50751429c9669fd979805`
- Base (`main` @ `3f41ae8`): not re-run locally (base is freshly synced `origin/main`; the PR's 6 added tests are purely additive and the delta to `main` is only the 3 fixed modules + 1 new test file).
- **Conclusion:** 0 new failures. All 1631 pre-existing tests pass unchanged on the PR branch; the 6 new tests target the exact audit scenarios and pass.

Logs cached at `/tmp/tc.log`, `/tmp/test.log`.
