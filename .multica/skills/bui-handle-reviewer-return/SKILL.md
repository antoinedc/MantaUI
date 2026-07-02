---
name: bui-handle-reviewer-return
description: Protocol for BUI implementer agents when reviewer reassigns an issue back. Distinguishes `Block (fix-here)` vs `Block (followup-issue)` and handles `Question` resolutions. Load this when an issue you previously sent to reviewer comes back to you with status `todo`.
---

# bui-handle-reviewer-return

If the reviewer reassigns an issue back to you (status `todo`,
your PR still open in the comment chain), **read `loop_history` FIRST**,
before doing anything else. This is how the loop learns — without it,
each return starts from zero and repeats the same mistake.

```bash
export MULTICA_WORKSPACE_ID=264c89bb-4659-4570-af7b-5f8daaf87985
multica issue metadata get <ISSUE-KEY> --key loop_history --output json
```

Read the history. For each prior attempt, note:
- **What you tried** (`approach` field) — do NOT repeat this approach.
- **What was weak** (`self_check` field — the criterion that scored lowest).
- **The reviewer's actual Block/Question** from each cycle — these are
  the ground-truth failures, more reliable than your memory of fixing them.

If the SAME Block reappeared after you "fixed" it, that's your signal:
your fix didn't address the root cause. See "Recurring / phantom Block"
below for diagnosis. **Do not start fixing until you've read this.**

Then read the reviewer's most recent Multica comment to identify which
kind of return.

## Two cases

### "Review found N Block-severity findings"

For each `Block`, check the scope suffix:

- **`Block (fix-here)`** → fix the code per the Block list in the PR
  review, push to the same branch, then reassign back to the reviewer.
  Do not open a new PR.

- **`Block (followup-issue)`** → do NOT try to fix it in this PR. The
  reviewer's PR comment includes a one-paragraph description meant for
  a new issue body. File the new issue via
  `multica issue create --title "<reviewer's title>" --description-stdin <<< "<reviewer's paragraph>" --status todo --priority medium`
  (unassigned by default — the human triages). Post a PR comment
  `Addressed via BET-XX (separate issue). Resuming this PR.`, then
  reassign this issue back to the reviewer for the next review pass.

- **Don't conflate the two.** Treating a `Block (followup-issue)` as if
  it were `fix-here` is the costliest failure mode — unbounded scope
  creep.

### "Review found 0 Blocks + N Questions"

Resolve each Question in the PR review. Three valid resolutions, in
order of preference:

1. **Answer in a PR comment** with rationale. Use this when the Question
   is asking "is this intentional / why this choice?" — the reviewer
   wants the design rationale captured, not a code change. This is the
   default.

2. **Make a code change** addressing the Question's underlying concern.
   Use this when the Question reveals an actual oversight (e.g. a test
   assertion can't hold in production, a missing edge case).

3. **Explicit deferral** in a PR comment, citing why the resolution
   belongs in a follow-up issue (not this PR). Use sparingly.

After resolving, reassign back to the reviewer for a re-check
pass. Do not assign yourself to the human — only the reviewer routes to
human.

## Recurring / phantom Block → suspect a stale base (do NOT re-fix)

**If the reviewer returns the SAME Block you already "fixed" on a prior
cycle — especially a Block of the form "this PR deletes / removes
`<file>`" for a file you never touched — STOP. Do not apply the same fix
again.** A Block that re-appears after you addressed it is almost never a
real defect you keep getting wrong; it's a structural artifact. The most
common cause is a **stale base**: your branch was cut from a
`master` that is behind `origin/master`, so your diff *appears* to delete
files that were merged upstream after your checkout. Each cycle you "restore"
them, the next `git diff` against the fresher base shows them deleted again,
and the loop never converges.

Diagnose before re-fixing any repeated/deletion Block:

```bash
git fetch origin
git rev-parse --short HEAD                       # your branch tip
git merge-base HEAD origin/master                   # where you branched
git rev-parse --short origin/master                 # current upstream
git diff --stat origin/master...HEAD                # what your PR REALLY changes
```

- If `merge-base` ≠ `origin/master` AND the "deleted" files exist on
  `origin/master` (`git show origin/master:<file>` succeeds) but not on your
  branch → **stale base confirmed.** Fix the base, not the files:

  ```bash
  git rebase origin/master        # or: reset to origin/master and re-apply your commits
  git push --force-with-lease
  ```

  Post a PR comment naming the root cause ("phantom deletions were a stale
  base — rebased onto `origin/master @ <sha>`; the diff now touches only the
  N intended files"), then reassign to the reviewer. Do **not** re-add the
  files by hand — that re-creates the loop.

- If the base is fresh and the Block is genuinely the same real defect
  recurring, that's a true disagreement → let the 3-cycle cap escalate it
  rather than thrashing.

## After fixing — stamp `loop_history` before reassigning

Before you reassign back to the reviewer, record this fix cycle:

```bash
export MULTICA_WORKSPACE_ID=264c89bb-4659-4570-af7b-5f8daaf87985
EXISTING=$(multica issue metadata get <KEY> --key loop_history --output json 2>/dev/null || echo '[]')
VALUE=$(echo "$EXISTING" | python3 -c "
import json, sys
h = json.load(sys.stdin)
h.append({
    'attempt': len(h) + 1,
    'phase': 'review-return',
    'approach': '<one-line: what you changed this cycle>',
    'self_check': '<N>/10 weakest: <criterion>',
    'result': 'submitted'
})
print(json.dumps(h))
")
multica issue metadata set <KEY> --key loop_history --value "$VALUE"
```

This lets the NEXT return cycle (yours or a successor's) see what was
already tried and avoid repeating it.

## Iteration cap

The 3-cycle iteration cap covers both Block AND Question loops. If you
and the reviewer can't converge in 3 cycles, the reviewer escalates to
human automatically.
