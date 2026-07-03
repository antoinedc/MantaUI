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

8. **Push IMMEDIATELY after your first commit — before any further
   verification (the e2e-smoke gate, extra manual checks, self-check).**
   `git push -u origin multica/BET-N-<slug>`.

   **Why this ordering is load-bearing (do NOT defer the push):** each
   multica run executes in a *fresh, ephemeral workdir* that is discarded
   when the run ends. A run that times out (e.g. the e2e-smoke Electron
   launch hangs → 30-min "no new messages" force-stop) throws away every
   uncommitted/unpushed change with it — and the **rerun starts from a
   clean `origin` clone, so it cannot resume your work**. A completed
   implementation that only lived in the workdir is lost, and the loop
   redoes it from scratch (or never converges). Pushing the branch the
   moment you have a green `typecheck && test` (step 6) makes the work
   durable: even if verification later hangs, the rerun — or a human —
   picks up your pushed branch and continues. **Push early, push often:**
   after the e2e-smoke gate or any follow-up commits, push again. The
   branch on `origin` is the only thing that survives a run.

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

## Discovered-follow-up gate (MANDATORY — file it, don't just narrate it)

While doing the work you WILL surface follow-ups — gaps you deliberately
left out of scope, a sibling path you didn't migrate, a drift trap you
created, a deferred cleanup, a missing edge-case test. **A follow-up
written only as prose in your PR body or completion comment does not
exist.** Comments are not the system of record; the next reader closes the
issue and your "follow-ups flagged: 1,2,3" evaporates into a `done`
issue's history. This is a real cross-workspace incident (Tenanture
TEN-350): a "consolidate to a single source of truth" task shipped `done`
while other consumers still read the retired shape; the gap lived only in a
completion comment and was one config edit from showing users a wrong
value. The owner had to catch it by hand.

**The rule: FILE every ACTIONABLE follow-up. Do not use "is it important?"
to decide whether to file — that judgment call, made under budget pressure
at the cheapest moment to skip, is exactly what leaks. Importance decides
ASSIGNMENT, not existence.** Two decisions, kept separate:

**Decision 1 — file or not? (mechanical, no judgment).** Is there a
concrete change a person could pick up and do? → **FILE it.** The only
things that stay prose are genuinely non-actionable musings ("we might one
day want X", "worth thinking about caching someday") — no concrete task.
When unsure whether it's actionable, file it; a cheap `todo` beats a lost
gap.

**Decision 2 — assign PM or park? (this is where the severity bar lives).**
Apply the bar to the filed issue:

FILE **and assign `bui-pm`** (priority ≥ parent's, min `high` for a
correctness gap) when ANY of:
- **(a) Dual source of truth / drift trap** — two shapes/paths/configs that
  can silently diverge, with no sync.
- **(b) Wrong-value / wrong-behavior risk to a user** — a reader still
  consumes a value the writer no longer maintains, or the UI shows
  something the logic won't honor.
- **(c) The parent's own goal/title implies it** — "remove X everywhere" /
  "single source of truth" done in *most* places = the unfinished half of
  THIS task.

FILE **unassigned, `todo`, labeled `follow-up`** (park it — real work, just
not urgent; the PM's backlog triage handles it) for everything else
actionable: dead-code deletion, a missing edge-case test, a
behavior-neutral refactor, a stale doc.

> **NOTE:** you do NOT `assign` to other implementers. "Assign `bui-pm`"
> means file it, set priority, and `assign` it to **`bui-pm`** so it lands
> in the PM's triage lane. Parked items stay unassigned. Never self-dispatch
> an above-bar follow-up to `better-ui-dev`.

How to file:

```bash
export MULTICA_WORKSPACE_ID=264c89bb-4659-4570-af7b-5f8daaf87985
# Above-bar → route to the PM to triage/prioritize:
multica issue create --title "<concrete, scoped title>" --description-file <path> \
  --status todo --priority <inherit parent's, min high> \
  --parent <PARENT-ISSUE-UUID> --assignee bui-pm
# Parked (actionable but minor) → unassigned + labeled:
multica issue create --title "<concrete, scoped title>" --description-file <path> \
  --status todo --priority <medium/low> \
  --parent <PARENT-ISSUE-UUID>
multica issue label add <NEW-KEY> follow-up
```

Every filed follow-up's description must carry a `## Dispatch` block and
name the concrete files + the divergence/risk, not just "migrate the
consumers." Then, in your PR/completion comment, **link every filed issue
by key** (`Follow-up filed: <KEY> (PM)`, `Parked: <KEY>`) rather than
describing any of them in prose.

Self-check addendum (add to the self-check scoring): one criterion is
**"every actionable follow-up I mention is FILED (not narrated), and every
above-the-bar one is assigned to `bui-pm`"** — score it, must be 8+ before
you submit. `bui-pm` re-checks this at its merge gate (GATE 2b) and
`bui-reviewer`'s `Block (followup-issue)` protocol covers follow-ups *it*
finds — three lines of defense; yours is the cheapest.

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
