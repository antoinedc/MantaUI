---
name: bui-pr-workflow
description: The standard implementer workflow for BUI (Better UI) agents — checkout, branch, implement, typecheck + test, push, draft PR, verification results template, reassign to reviewer. Plus the 50-turn self-policed budget cap. Load this when you're about to take action on an assigned implementer issue.
---

# bui-pr-workflow

The standard implementer workflow for the BUI agents.

## Steps

1. `multica repo checkout git@github.com:antoinedc/better-ui.git` inside
   your workdir. Never edit files outside the workdir. (A human-owned
   checkout at `/home/dev/projects/better-ui` bypasses isolation.)

2. **Sync `master` to `origin/master` BEFORE you branch (mandatory — stale-base
   antibody).** A reused/cached workdir can hold a `master` that is days behind
   `origin/master`; branching off it makes your diff appear to *delete* files
   that were merged to `origin/master` after your stale checkout, producing
   phantom "you deleted X" review Blocks that no fix can resolve. Always:

   ```bash
   git fetch origin
   git checkout master
   git reset --hard origin/master      # workdir is disposable; make master == origin/master
   git checkout -b multica/BET-N-<slug>
   # Record the base you branched from, for the PR body (step 11):
   git rev-parse --short origin/master
   ```

   The recorded `origin/master` short-sha is your **base SHA** — put it in the
   PR body so the reviewer can confirm freshness in one glance.

3. Read the issue. If it touches IPC, renderer, main process, preload, or
   server routes, re-read the matching architecture docs in the repo.

4. **Run the anti-spaghetti contract (below) before writing any new
   code.** Search for an existing implementation first; the default move
   is to extend/reuse, not to add a parallel copy.

5. Implement. Add or update tests under `tests/` or `__tests__/`.

6. Run `npm run typecheck && npm test`. Both must pass.

7. Commit with `feat(scope): …` / `fix(scope): …` / `refactor(scope): …`
   on the task branch. Match the scope to where the change lives
   (`main`, `renderer`, `preload`, `server`, `mobile`, `ipc`, `electron`, etc.).

8. Push: `git push -u origin multica/BET-N-<slug>`.

9. Open draft PR: `gh pr create --draft --base master`. Body must include
   typecheck result, test result, any cross-cutting follow-ups (e.g.
   "this changes an IPC channel that `renderer` reads — flagged BET-XX"),
   and a **`Base: origin/master @ <short-sha>`** line (the SHA you recorded
   in step 2) so the reviewer can confirm the branch isn't stale. Before
   pushing, sanity-check your own diff: `git diff --stat origin/master...HEAD`
   — if it lists files you never touched (especially deletions of CI/config
   you didn't intend), you branched off a stale `master`; **go back to step 2,
   re-`reset --hard origin/master`, and re-apply your commits** (cherry-pick or
   re-branch) rather than "restoring" the phantom-deleted files by hand.

10. **Self-check (mandatory — runs before you submit to reviewer).**
    Extract every acceptance criterion from the issue body (checklist,
    "Definition of done", requirements section, measurable claims). For
    each criterion, score your work 1-10 honestly:

    ```
    CRITERION 1: <restatement>  →  score: <N>/10  →  weakness: <one line>
    CRITERION 2: <restatement>  →  score: <N>/10  →  weakness: <one line>
    ...
    ```

    Rules:
    - **Never call it done until every criterion is 8 or higher.**
    - Each pass must fix the **weakest** score from the last self-check.
    - "Typecheck passes" is not a criterion — it's a gate you already ran in
      step 6. The criteria are what the *issue* asks for, not what the
      compiler accepts.
    - If a criterion is "fix X in all N locations", verify by grepping
      that X is actually gone from every location — don't trust your
      memory of having fixed it.
    - If any criterion is below 8, fix the weakest point first, then
      re-score. Repeat until all are 8+.

    Print the scores. If all 8+, you may submit.

    Then: Post the PR URL on the Multica issue **with a structured
    `Verification results` block** (template below), stamp `loop_history`
    metadata (see below), and reassign to the reviewer via
    `multica issue assign <KEY> --to <reviewer-slug>`. **Do not mark
    `done` or `in_review` yourself** — the reviewer handles the status
    transition based on review outcome.

11. **Stamp `loop_history` metadata.** Before reassigning to reviewer,
    record this attempt:

    ```bash
    export MULTICA_WORKSPACE_ID=264c89bb-4659-4570-af7b-5f8daaf87985
    EXISTING=$(multica issue metadata get <KEY> --key loop_history --output json 2>/dev/null || echo '[]')
    VALUE=$(echo "$EXISTING" | python3 -c "
    import json, sys
    h = json.load(sys.stdin)
    h.append({
        'attempt': len(h) + 1,
        'phase': 'initial' if len(h) == 0 else 'review-return',
        'approach': '<one-line: what you tried>',
        'self_check': '<N>/10 weakest: <criterion>',
        'result': 'submitted'
    })
    print(json.dumps(h))
    ")
    multica issue metadata set <KEY> --key loop_history --value "$VALUE"
    ```

    This is how the loop learns across iterations — when the reviewer
    returns the issue, you (or the next run) read `loop_history` before
    starting to fix, so you don't repeat the same mistake.

## Anti-spaghetti contract (mandatory, runs before you write code)

LLMs reason locally and default to the smallest-looking patch — a band-aid
on the failing call site instead of a fix at the source. Counter it
deliberately on every issue:

1. **Search before you write.** Before adding a route/service/helper/type,
   grep for an existing one that already does this. Reuse or extend the
   canonical implementation. If you genuinely must add a new one, say *why
   the existing one couldn't be extended* in the PR body.

2. **Fix the root cause, not the symptom.** If a bug exists at one call
   site, find every call site (grep the pattern across the repo) and check
   whether they share the defect. A patch that fixes 3 of N identical sites
   is an incomplete fix, not a smaller one — list all N in the PR body and
   either fix them or explicitly defer with a one-line reason per site.

3. **"Refactoring is risky" is not a reason to skip it.** When the correct
   fix is to centralize duplicated logic into one source of truth, do it
   *and* add a test that pins the behavior so the duplication can't silently
   regress. Risk is mitigated by tests, not by avoidance. If a refactor is
   genuinely out of this issue's scope, that's a `Block (followup-issue)`
   you file — not a band-aid you ship silently.

4. **Make the duplicate-site list explicit.** When an issue is "this is
   wrong / duplicated," your plan must name: every duplicate site, the
   chosen single source of truth, the delete/replace count, and the
   characterization test. If your diff only touches the failing sites, you
   patched a symptom — re-read the issue.

5. **DRY is semantic, not textual — do NOT over-correct.** Two snippets
   that look alike *by coincidence* (no shared underlying concept, will
   evolve independently) must stay separate. Abstracting accidental
   similarity introduces wrong coupling.

6. **No dead code, no speculative abstraction.** Don't leave the old path
   behind "just in case" after replacing it, and don't build extension
   points for inputs that don't exist yet.

7. **BUI-specific: respect the process boundary.** Changes in `src/main/`
   (Electron main process) must not leak into `src/renderer/` (Chromium
   renderer) without going through IPC. If you're adding a new IPC channel,
   update the preload (`src/preload/`) to expose it, and add the renderer
   types — all three layers must be in sync. Don't patch just one.

8. **BUI-specific: server routes are not renderer code.** `src/server/`
   (Express/Koa/etc.) runs in a separate Node process. Don't import
   renderer modules into server code or vice versa. If you need shared
   logic, put it in a shared module (e.g. `src/shared/` or `src/common/`).

This contract is the implementer half; the reviewer enforces the same
checklist as a second line of defense (root-cause + duplication
findings are Block-severity). Cheap to honor up front, expensive to
retrofit.

## Turn-budget soft cap (self-policed)

Keep an internal counter of consecutive turns since your last source-file
mutation (`Write`, `Edit`, or `git commit`). If you reach **50 turns**
without mutating anything, **stop investigating and post a status comment**
on the Multica issue with:

- **Current hypothesis** (1-2 sentences — what you think is going on)
- **What you've found so far** (bullet list of concrete observations)
- **What's blocking you** (what would unblock — a missing precedent, a
  doc that disagrees with reality, an external system you can't access)
- **Recommended next step** (one specific action, with confidence level)

Then **wait for guidance** instead of continuing. Don't reassign anywhere.

## `Verification results` PR-comment template

The reviewer reads this block instead of re-running both suites — if the
block is missing, the reviewer falls back to a full two-branch run AND
raises a `Question`. Capture both runs first:

```bash
git checkout multica/BET-N-<slug> && npm run typecheck 2>&1 | tee /tmp/typecheck-pr.log && npm test 2>&1 | tee /tmp/test-pr.log
git checkout master && npm run typecheck 2>&1 | tee /tmp/typecheck-master.log && npm test 2>&1 | tee /tmp/test-master.log
git checkout multica/BET-N-<slug>
sha256sum /tmp/typecheck-pr.log /tmp/typecheck-master.log /tmp/test-pr.log /tmp/test-master.log
```

Then post:

```
**Files changed:** `<N>` files. `[list of changed files or diff --stat]`

**Verification results:**
- PR branch (`multica/BET-N-<slug>` @ `<short-sha>`):
  - typecheck: exit `<N>`. Errors: `[<file:line list>]` or "none". log sha256: `<hash>`
  - test: exit `<N>`, `<X>` pass / `<Y>` fail / `<Z>` skip. Failures: `[<file:line list>]`. log sha256: `<hash>`
- Base (`master` @ `<short-sha>`):
  - typecheck: exit `<N>`. Errors: `[<file:line list>]` or "none". log sha256: `<hash>`
  - test: exit `<N>`, `<X>` pass / `<Y>` fail / `<Z>` skip. Failures: `[<file:line list>]`. log sha256: `<hash>`
- **Conclusion:** `<N>` test failures are pre-existing (identical between branches), `<M>` failures are new and caused by this PR, `<K>` failures were resolved by this PR.

Logs cached at `/tmp/typecheck-pr.log`, `/tmp/typecheck-master.log`, `/tmp/test-pr.log`, `/tmp/test-master.log` for reviewer spot-check.
```

If your conclusion is "0 new failures, N pre-existing," the reviewer
will skip the base-branch re-run and just spot-check by re-running on
the PR branch. Skipping this block triggers a `Question` from the
reviewer AND a full two-branch verification on its side (≈3× the reviewer
cost).
