# Swift CI — what exists, what it would cost

A pull request that touches Swift (the native mobile client reborn in Swift,
per the settled `docs/spike-rn-vs-swift.md` / `docs/mobile-redesign/DECISIONS.md`
stack decision) cannot be verified by today's CI: every job in
`.github/workflows/ci.yml` runs on the Linux self-hosted runner, which can
neither compile Swift nor boot a simulator. This document inventories the Mac
build machinery that already exists and prices the options for closing that
gap before the implementation epic is written. It is a comparison, not a
decision: it ends with the question a human has to answer.

## What CI does today

Everything gates through **one required check** over **one self-hosted Linux
runner**.

- **`ci.yml` has three jobs.** `typecheck-test`
  (`.github/workflows/ci.yml:51`, `runs-on: [self-hosted, linux]` at
  `.github/workflows/ci.yml:52`) runs typecheck, the vitest+node:test suites,
  the visual + shot-drift gates, the gitleaks secret scan, a conditional
  dependency audit, and posts an advisory duplication comment. It is the only
  job in `required-checks.json`.
  `duplication-gate` (`.github/workflows/ci.yml:290`) and `E2E Smoke Test`
  (`.github/workflows/ci.yml:315`) still run but are deliberately **not**
  required. Only `typecheck-test` is in `required-checks.json` (line 3) and in
  the `main` branch ruleset's required contexts.
- **One self-hosted runner ⇒ jobs queue.** `ci.yml:10-16` states the cost
  discipline: exactly one `manta-dev-runner`, so jobs do not run in parallel —
  every extra job is wall-clock time every other open PR waits behind. A
  previous pass cut a PR from **13.2 minutes** of exclusive runner time across
  six jobs down to three (`.github/workflows/ci.yml:12-16`; the same fact is
  in `AGENTS.md`). The three fixes — node_modules cached on the lockfile hash,
  and the secret scan + dependency audit collapsed from separate workflows
  into steps of `typecheck-test` — are documented at
  `.github/workflows/ci.yml:17-30`.

Mac-critical work already exists, but **none of it is a per-PR Swift gate
today**:

- **`macos-install-smoke.yml`** is the existing Mac job. It runs on a
  **GitHub-hosted `macos-14`** (Apple Silicon) runner (`.github/workflows/
  macos-install-smoke.yml:94`) and is explicitly justified in the face of the
  one-runner rule: GitHub-hosted, so "it costs zero wall-clock on
  `manta-dev-runner` … and blocks nobody" (lines 14-18; ~10 minutes at lines
  21-22). It is **not a required check** (lines 20-22). It fires on
  `workflow_dispatch`, a weekly cron (Mon 06:00 UTC, lines 71-74), and on PRs
  **only** whose changed `paths` are in `scripts/install.sh`,
  `scripts/install-lib.mjs`, `scripts/launchd/**`, `scripts/manta-pair.mjs`
  or the workflow file itself (lines 75-85). It installs the box end-to-end a
  user's way and asserts the macOS-specific path — it does not touch the
  mobile app.
- **`server-tarball-deploy.yml`** builds a `darwin-arm64` leg of its
  `arch: [x64, arm64, darwin-arm64]` matrix on **`macos-14`**
  (`.github/workflows/server-tarball-deploy.yml:159-163`). It **cannot
  cross-compile**: node-pty's native binding is host-tied, so the macOS build
  must run on a Mac (lines 12-15, 26-30, 153-155). It fires on a `server-v*`
  git tag or a manual `workflow_dispatch` (lines 61-75) — never on a PR.
- **`codemagic.yaml`** defines the two Mac workflows. `ios-testflight`
  (app → TestFlight) and `mac-desktop` (desktop → DMG) both run on
  **`mac_mini_m2`** instances (`codemagic.yaml:24` and
  `codemagic.yaml:177`) and both trigger on git tags only (`ios-v*` at lines 53-58, `mac-v*`
  at lines 205-210). Codemagic's free tier is **500 M2 minutes/month**
  (`codemagic.yaml:24`). There is already a working
  GitHub-Actions → Codemagic bridge: `codemagic-ios-trigger.yml` POSTs to the
  Codemagic REST API (`api.codemagic.io/builds`) with a `CODEMAGIC_API_KEY`
  secret on `ubuntu-latest` (`.github/workflows/codemagic-ios-trigger.yml:59-89`).
- **`required-checks.json`** names a single required context, `typecheck-test`
  (`.github/workflows/required-checks.json:3`). Its header comment binds it to
  the `main` branch ruleset: the two are separate places, and "requiring a
  context no job produces blocks every PR forever" (line 2).

## Constraints any option must respect

Each comes from `AGENTS.md`; an option that violates one is not viable.

- **An extra *job* costs every other open PR; an extra *step* does not.** One
  runner, jobs queue. This is the load-bearing reason the security and audit
  work became steps of `typecheck-test` rather than their own jobs. Any Swift
  verification added as a job on the self-hosted runner inherits this cost;
  anything that avoids that runner (GitHub-hosted or Codemagic) doesn't.
- **The dependency audit runs only when the lockfile changes.** Its result
  depends on the dependency *set*, not the PR's code; auditing every PR
  re-measures `main`, so the day an upstream advisory lands every open PR goes
  red at once (a mass-block `dep-audit-nightly.yml` covers `main` daily
  instead). Not directly a Swift-verification constraint, but it is why
  "verify the Swift toolchain's deps on every PR" would need the same
  lockfile-only gating rather than a blanket run.
- **The `main` ruleset is deliberately *not* strict** (branches need not be up
  to date with `main` before merging). Turning that on forces every merge to
  invalidate every other in-flight PR — O(N²) rebase + re-review + re-run
  churn. A new required check must not reintroduce this indirectly.
- **`required-checks.json` must stay in sync with the ruleset's required
  contexts.** They are two separate places. Requiring a context no job
  produces blocks every PR forever; the documented ordering is to change the
  ruleset *first*, then the file. Adding a required Swift check therefore
  always means touching both, in that order.

## Options

### A. A GitHub-hosted Mac runner job (following `macos-install-smoke.yml`)

A new job, e.g. `swift-build`, on a GitHub-hosted `macos-14` runner, wired
into `ci.yml` (or a sibling file).

- **What it verifies:** the Swift project compiles and (if a test target
  exists) its tests pass, and the Xcode project / scheme resolve under a real
  `xcodebuild` on Apple Silicon.
- **What it does not verify:** anything about the Linux box server or the
  runtime the phone talks to — it is a build-and-test gate whose scope is the
  iOS project only.
- **Where it runs:** GitHub-hosted `macos-14`, off the self-hosted runner.
- **Cost in queue time for other PRs:** zero on `manta-dev-runner` — this is
  the one part of the `macos-install-smoke.yml` precedent that **does carry
  over** verbatim (its own justification at lines 14-18 is exactly this). The
  cost shifts to GitHub-hosted macOS minutes and to the wall-clock of each
  PR's own run.
- **Does the precedent's second half ("blocks nobody") apply?** No — and this
  is the difference from the precedent. `macos-install-smoke.yml` is
  deliberately *not* required and is path-gated to installer-only PRs
  (lines 20-22, 75-85); a per-PR Swift check, by definition, is a gate every
  Swift-touching PR waits on. So the "blocks nobody" justification is
  specific to that workflow's narrow, non-required trigger — it does not
  generalise to "a SWIFT PR must be green before merge."
- **Required-checks change:** add the new context to the `main` ruleset
  required contexts *first*, then to `required-checks.json` (the documented
  ordering above). Until that happens the job runs but is not a merge gate.

### B. Codemagic (following the existing Mac workflows)

Extend Codemagic to run a build/tests on a `mac_mini_m2` per PR, fired through
the existing GitHub-Actions → Codemagic REST API bridge
(`codemagic-ios-trigger.yml`) or by adding a `pull_request` trigger to
`codemagic.yaml`.

- **What it verifies:** the same thing as A on real Apple hardware — Xcode
  build + test on `mac_mini_m2`. This is the same machine family that already
  ships the app to TestFlight, so it exercises the closest thing to the
  release path (instances at `codemagic.yaml:24` and `:177`).
- **What it does not verify:** the Linux server/runtime is out of scope, same
  as A.
- **Where it runs:** Codemagic's `mac_mini_m2` infrastructure. Existing
  workflows are tag-triggered and produce release artifacts; this option adds
  a per-PR verification leg alongside them.
- **Cost in queue time for other PRs:** zero on the self-hosted runner. It
  consumes the Codemagic free-tier pool (500 M2 minutes/month,
  `codemagic.yaml:24`); a per-PR build burns minutes proportional to PR
  volume, so the free pool is the practical ceiling to price against. Exact
  minutes-per-build are **not determined from the repository**.
- **Required-checks change:** the merge gate would be Codemagic's status
  reported back to the PR, not a job produced by this repo's Actions. The
  ruleset's required contexts would still need editing; `required-checks.json`
  currently names only the single Actions check `typecheck-test`, so it and the
  ruleset would have to be reconciled whichever provider owns the new gate.

### C. The `macos` agent (on-demand, not CI)

The sibling agent already builds and captures on the connected Mac on demand.

- **What it verifies:** the same Swift build/test, when a human (or an issue)
  dispatches it. It can capture compiler output, logs, simulator/hierarchy
  artifacts and hand them back.
- **What it does not verify, and what it plainly cannot do:** it is **not
  CI**. It runs only when someone asks it to; it has no webhook from PRs and
  produces no GitHub check run, so **it cannot gate a merge**. Nothing enforces
  that it ran before a Swift PR merges, and it depends on the laptop being
  awake.
- **Where it runs:** Antoine's Mac, on request.
- **Cost in queue time for other PRs:** none to CI (it uses no runner at all),
  but it spends a human's or a dispatched agent's attention on demand.
- **Required-checks change:** none — it cannot be a required context. This is
  a manual verification tool, not a gate.

### D. No per-PR Swift verification at all

Keep today's CI exactly as it is for Swift.

- **What it verifies:** nothing Swift — a Swift-only PR merges with no compile
  or test gate.
- **What it does not verify:** every Swift change, by construction.
- **Where it runs:** nowhere new; no new runner, no new expense.
- **Cost in queue time for other PRs:** none added.
- **Risk, stated honestly:** incorrectly or half-completed Swift would go
  straight to the release path (the ios-v* tag → TestFlight) or to a manual
  `macos`-agent check, and be caught there instead of at the PR. The cost of a
  broken build is deferred to release time and to whichever human or agent is
  doing the manual verification — which is exactly the gap this epic exists to
  close.
- **Required-checks change:** none.

## What each option does not verify

All three verification options (A, B, C) share the same blind spot and the
"none" option has it plus everything else: **none of them exercise the Linux
box server or the end-to-end phone↔box runtime**. They compile and test the iOS
project in isolation. Behavior that only shows up when the app talks to
`manta-server` — transport, pairing rework (epic child E), streaming, push —
is outside every per-PR Swift build above and would still rely on the existing
`typecheck-test`, a release-stage run, or manual Mac testing. Whether any
per-PR Swift verification needs to reach into runtime behavior (e.g. by booting
a simulator and driving a flow) is one of the things the choice below should
settle; the per-PR compile+test options here do not cover it.

## Open question for the human

The human is choosing between four ways to cover Swift: a **GitHub-hosted Mac
job** (free self-hosted-runner queue time, but becomes a real per-PR gate that
every Swift PR waits on), **Codemagic** on the existing M2 machines (same
coverage, costs against the 500-minute free pool and needs the release-capable
infrastructure to double as a per-PR gate), the **`macos` agent** (verified
only when someone remembers to dispatch it, and it can never be a merge
requirement), or **no per-PR gate** (nothing new to run or pay for, at the
price of catching broken Swift only at release or by hand). The decision is
really about which combination of (a) real per-PR compile coverage, (b) what it
costs in money and PR wall-clock, and (c) how much runtime behavior — if any —
the new gate must also verify — and that is a product call about how much
assurance the mobile implementation epic needs before merge, not a question
this document can answer for you.
