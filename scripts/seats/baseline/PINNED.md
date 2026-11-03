# Pinned baseline — the seat-placement policy BEFORE the weekly-deadline change

Commit: **`f95bfe2b`** (the last commit before the placement rules changed).
Spec: `docs/superpowers/specs/2026-11-03-seat-placement-weekly-deadline.md` §8.

The replay harness (`scripts/seats/replay.mjs`) runs the **real pure decision
code** of that commit as its "before" policy. Two files are vendored here:

| File | Source | Modification |
|---|---|---|
| `seatChoice.mjs` | `git show f95bfe2b:src/shared/seatChoice.mjs` | none (byte-identical) |
| `seatAssignment.mjs` | `git show f95bfe2b:src/server/seatAssignment.mjs` | everything from the `// The service` banner down is dropped (`createSeatAssigner` and its helpers); the four service imports (`jsonStore`, `paths`, `seatChoice` via `../shared`, `accounts`) are replaced by one import of `./seatChoice.mjs` and `const ACCOUNT_PROVIDERS = ["claude", "codex"]` |

`decideSeat` and everything it calls sits above that banner, so the vendored
file is the full closure of the decision.

`src/server/seatReplayBaseline.test.mjs` rebuilds the expected text of both files
from `git show f95bfe2b:…` and fails if the vendored copy differs. **Never edit
these two files**: if the baseline needs to move, pin a new commit, re-vendor,
and say so here.
