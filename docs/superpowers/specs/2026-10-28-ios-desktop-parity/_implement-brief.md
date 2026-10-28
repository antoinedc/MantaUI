# Implementer brief (Sonnet 5.5) — iOS ↔ desktop parity

You implement ONE workstream of a reviewed, approved spec set. Worktree:
`/home/dev/projects/better-ui-ios-parity` (branch `feat/ios-desktop-parity`).
Never touch `/home/dev/projects/better-ui` (another checkout). Other
implementers are working in this SAME worktree at the same time on OTHER files.

## Read first (in this order)
1. `docs/superpowers/specs/2026-10-28-ios-desktop-parity/00-master.md` — binding:
   ground rules, contracts C1–C7, decisions D1–D21, **Mount ledger (canonical)**,
   **Shared member registry**.
2. Your workstream spec `docs/superpowers/specs/2026-10-28-ios-desktop-parity/<ID>.md`
   — including its "Review responses" and any "Round 3 SHOULDs" sections, which
   are binding.
3. `mobile/native/AGENTS.md` (Swift 6 rules, transcript row-identity risk, tests).
4. The root `AGENTS.md` section "NEVER STUB A CONTROL TO DO NOTHING".

## What to do
Implement every feature in your spec, plus every mount the ledger assigns to
YOUR workstream as applier in YOUR (sub)wave. Edit ONLY the files your spec's
"Files" section and the ledger allow. Do NOT edit: `Package.swift`,
`project.yml`, `MantaUI.xcodeproj/**`, `generated/swift/**` (except WS10 via its
generator), or any file owned by another workstream unless the ledger names you
as its applier. If something you need from another workstream is not there yet,
code against the exact signature pinned in the ledger/registry — do NOT stub or
redeclare it. If a pinned signature is impossible against the real code, stop
and report it rather than inventing a different one.

Keep working until everything is done, and only stop to ask when you can't go on
without the user or before a risky step. When the work is done and checked, stop
and report. Don't add features, files, docs or refactors that weren't asked for;
mention ideas at the end instead.

## Swift rules (non-negotiable)
`@MainActor final class` stores; no global mutable state; no new `try!`, `as!`,
force-unwrap, `Task.detached`, empty `catch {}`; every user action reports
success or failure; destructive actions confirmed; secrets never rendered or
logged. Transcript rows need deterministic ids derived from the block alone.

## Verification — run a real check that exercises the change before reporting it done
There is no Xcode here; SwiftUI/UIKit code cannot compile on this box. What you
CAN and MUST run:
- **Pure Swift (Foundation-only) logic + XCTests** via Docker, in a PRIVATE copy
  so you don't collide with other implementers:
  ```
  S=/mnt/HC_Volume_105783934/dev-cache/opencode-tmp/<ID>-native
  rm -rf $S && mkdir -p $S && rsync -a --exclude .build mobile/native/ $S/
  # in $S/Package.swift ONLY (never the real one): append your Foundation-only
  # sources and test files to the two `sources:` lists (your spec's manifest row)
  docker run --rm -v $S:/work -w /work swift:6.1 bash -lc "swift build --build-path .build && swift test --build-path .build"
  ```
  Your new pure tests must pass and the pre-existing ones must stay green. Report
  the exact Package.swift lines you added (the integration step applies them).
- **Server changes** (if your spec has any): `npm run typecheck` and
  `node --import ./scripts/testSandbox.mjs --test <your test files>`, then
  `npm run test:server`.
- **Desktop/shared TS changes** (if any): `npm run typecheck` and the relevant
  vitest files.
- For SwiftUI code you cannot compile: re-read every changed file once end to
  end, checking each referenced symbol exists (grep its declaration) with the
  exact signature, all `switch`es are exhaustive, optionals are handled, and
  `@MainActor` isolation is consistent. Say plainly in your report which files
  were only desk-checked.
A syntax-only check or a check that failed to start does not count; only if no
real check can run, say which and why.

## Do not commit
Leave changes uncommitted; the orchestrator reviews and commits by path.

## Report (concise, no reasoning narrative)
- Files created / modified (full paths).
- Mounts applied (ledger IDs) and mounts you could not apply + why.
- Package.swift manifest lines for the integration step.
- Deviations from the spec (with reason).
- Check results (commands + pass/fail counts); which files are desk-checked only.
- Open doubts.
