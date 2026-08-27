# Adaptive CTO — Multica decomposition (draft for review)

Source of truth: `docs/adaptive-cto-spec.md` (spec v2). This document is the
issue tree to be filed in Multica once the split is approved. Every issue
below is sized for **one PR by `manta-dev`**, self-contained, with zero design
decisions left to the implementer — the filing body for each issue will inline
its spec requirements verbatim plus the cross-cutting rules below.

## Cross-cutting rules (inlined into EVERY filing body)

These exist because the implementer is a weaker agent; nothing may depend on
its judgment:

1. **The spec section named in the issue is normative.** Read it before
   coding. Where the issue body and the spec disagree, STOP and comment on
   the issue instead of choosing.
2. **Reuse over new code, removal over addition.** Each issue names the
   existing module(s) to copy patterns from (and, where relevant, the code it
   DELETES). Do not hand-roll: JSON persistence = the existing atomic
   jsonStore pattern; paths = `statePath()` (never `join(homedir(),…)` — the
   test sandbox rule); tool registrars = copy an existing
   `docs/opencode-tools/*.ts` incl. `boxToken()`/`authHeaders()` via
   `./manta-auth`; bus events = the existing `createBus()`; dedupe =
   `createSeenIdFilter`; engine style = `delegate.mjs` (dependency-injected
   pure logic + injected I/O).
3. **One code path.** If the issue replaces something, the old path is
   DELETED in the same PR — never left as a fallback. A superseded function
   that still exists is a bug.
4. **No dead controls** (AGENTS.md rule). Every control shipped in a UI issue
   must perform its specified action and report both outcomes. If a
   dependency isn't merged yet, the control is NOT RENDERED (never stubbed).
5. **Pure logic gets tests** in the same PR: `src/server/*.test.mjs`
   (node:test) or `chatUtils`-style vitest for renderer logic. No live tmux /
   opencode / network in tests; injected I/O only.
6. **No new hexes, no new tokens beyond §10.7's four.** UI uses
   `src/renderer/tokens.css` variables; needs-you edges use `color-mix` over
   semantic tokens.
7. **Gate**: `npm run typecheck && npm test` green before hand-off; PR title
   carries the issue key.

## Sequencing model

Filed per the repo's board conventions: children start `blocked` with
`waiting_on: <real blockers only>` + `next_owner: manta-dev`; the unblock
sweep dispatches when blockers close. Issues with no dependency inside their
phase are filed `todo` + assigned directly. The three phase epics are
decomposition-tracking only (never in any child's `waiting_on` — the epic-
deadlock rule).

Legend: S/M/L ≈ ½ / 1 / 2 implementer-days.

---

## Epic CTO-A — P1: read layer

**A1 · Stores + schema-version harness** (M) — spec §13.1–13.2
`src/server/ctoStores.mjs`: every store under `~/.manta/cto/` (inbox, facts +
archive, rollups, digests, cards, profile, journal, tool-registry,
tool-usage, verdicts, ledger.jsonl, budget, engine-state), all via
`statePath()`; atomic JSON writes (copy the existing jsonStore shape),
append-only JSONL writer, YAML writer (copy the plugin-manifest writer
pattern); `v` field + forward-migration harness (pure, tested; unknown future
`v` fails loudly); retention sweeps (ledger/verdicts 180d, rollup tiers,
segments 30d, archive 10× cap). Tests: migration harness, sweep math, sandbox
canary (MANTA_STATE_HOME respected — copy `stateSandbox.test.mjs`).
Depends on: —

**A2 · Engine skeleton: timers, kill switch, watchdog, identity** (M) — §3.1,
§3.3, §13.3
`src/server/ctoEngine.mjs` skeleton in `delegate.mjs` style: injected I/O,
`timer.unref()` + inFlight guards (copy `createScheduler`/outbox-poller
shape); `actor:"cto"` tag on every RPC call; rate limits (30 sessions/h, 5
ephemeral, 2 delegate sub-cap) → exceed = pause + health warning; the
engine-external kill-switch flag file checked at every tick and job start;
the watchdog timer in `index.mjs` (liveness + spend rate → auto-thrifty at
2×, auto-pause + blocker card at 4×); `GET /api/cto/state` +
`{kind:"ctoState"}` bus event (§10.1 data path). Wire into `index.mjs` behind
the master toggle. Tests: rate-limit trip, kill-switch honored, watchdog
thresholds (all injected clocks/counters).
Depends on: A1

**A3 · Session owner tagging** (S) — §3.4
New tmux user-option `@manta-owner` (`user` default): read/stamp support in
`src/server/tmux.mjs` (mirror `@manta-session-id` / `restampSessionId`);
`delegate.mjs` stamps `job` at window creation; expose `owner` in
`listProjects()` window objects. Tests: parse/stamp round-trip in
`tmux.test.mjs` (pure parsing only).
Depends on: —

**A4 · Ephemeral session runner** (M) — §3.1, §12.3
`src/server/ctoSessions.mjs`: `runEphemeral(taskClass, context)` — create
headless opencode session via existing `opencode.mjs` `createSession` (no
tmux window; title prefix `cto:`), inject context, synchronous result read
(`GET …/message`, no SSE dependency), delete session; record in
engine-state's active set; orphan reaper (>30 min, not in active set, every
10 min); task-class → model resolution through the existing router with the
§12.3 class table + one-step escalation cascade; per-class context budgets.
Tests: reaper selection logic, cascade rule, active-set bookkeeping (injected
oc client).
Depends on: A1, A2

**A5 · Evidence ingestion + presence** (M) — §4.1, §5.4, §5.1-scope
Engine consumers on the existing bus: normalized evidence events; `last_seen`
= max(desktop heartbeat, app opens, prompt submissions); presence states incl.
`unknown` (= `present` for etiquette); **exclusion of `cto`-owned sessions**
from all pipeline observation. Pure: `computeLastSeen`, `presenceState`,
`isPipelineSession(owner)`. Tests for each.
Depends on: A2, A3

**A6 · Segmentation + segment summaries + turn completion** (L) — §5.1–5.2
Pure: online gap segmentation with threshold G; monthly G refit (2-component
mixture on log inter-arrivals, clamp [20,90] min); turn-completion detector
(first `session.idle` after seen busy; `MessageAbortedError` idles excluded —
the drain-abort rule); segment-summary call via A4 (`ambient-summarize`
class) producing the §5.2 schema incl. `one_liner` + `importance`; segment
store writes. Tests: segmentation edges, refit math, abort exclusion,
schema validation.
Depends on: A4, A5

**A7 · Rollups** (M) — §5.3
Hour/day/week reduces via A4; running same-level context; ADD/UPDATE/NOOP
against facts (P1: facts store exists but single-writer — the engine itself,
per §15); immutability (write-once); preemption between reduce calls;
evidence-pointer propagation. Tests: reduce ordering, write-once enforcement,
preemption checkpointing (injected).
Depends on: A6

**A8 · Needs-you card store + blocker cards** (M) — §10.3 (blocker variant),
§9.2-blockers, D20
`cards.json` store; blocker card lifecycle: sources = questions/permissions
pending >10 min (from existing bus events) + health escalations; immediate
blocking-tier routing through the existing notification router (`firePush`
path — reuse, do not duplicate) + card at >10 min (two timers); **liveness
predicates** re-checked on events → auto-retract with `resolved` ledger entry
(never a verdict); stable card ids. Tests: predicate lifecycle, two-timer
behavior, retraction never writes a verdict.
Depends on: A2, A5

**A9 · Digest engine** (L) — §5.4–5.5
Granularity selection from Δ (G-boundary + fixed constants); composition via
A4 (`digest-compose` class) with tier lattice, constant item budget, blockers
excluded from slots, `deep` layer, "nothing happened" legal; single-flight
lock keyed by absence-window id, generation state on the `ctoState` bus
event; `digests/` persistence (last 30); timing scheduler (learned median →
rising-edge default → 09:00 inferred-TZ/box-local fallback); digest-push
notification honoring informational deferral (only when the §10.5 toggle is
on — toggle itself ships in A12). Tests: granularity table, single-flight,
tier ordering, timing fallback chain.
Depends on: A7, A8

**A10 · Renderer: sidebar entry + pane shell** (M) — §10.1–10.2, §10.7
Sidebar CTO button (top, global) + badge (needs-you count) + status dot, all
from the `ctoState` event with `GET /api/cto/state` on mount (no polling);
pane routing (replaces active panel, Settings navigation model); 960px column
scaffold, section order scaffold, header row (title, Digest-now wired to the
single-flight state, ⚙ navigation); the four §10.7 dimensional tokens added
to `tokens.css` `:root`; `color-mix` edge rule. No section content yet — the
shell renders the resting state. Tests: badge/dot state mapping (pure
selectors, vitest).
Depends on: A2 (state endpoint); A8–A9 NOT required (sections land in A11)

**A11 · Renderer: overview sections** (L) — §10.3 (blocker card UI), §10.4,
§10.6 states 1/7/8
Blocker cards (red edge, Answer-now routing incl. ref/ledger fallbacks); Now
rail (chat-session status from SSE/progress, TUI from poller batches — both
already reach the renderer; cost/elapsed from existing data); Just-finished
rail (one-liners from segment store; `open →`/`review →`/`failed`+`logs →`
variants; abort exclusion is server-side in A6); digest section (tiers, refs
deep-links, `deep` expander, `open` verdicts on expand); resting state;
week-away variant is just data. Every control per rule 4. Tests: pure
selectors/formatting in vitest.
Depends on: A6, A8, A9, A10

**A12 · Renderer: Settings & health (P1 scope) + activity ledger drill-down**
(M) — §10.5 cards 1–2 (P1 rows), Internals row 3
Behavior card: Enabled switch, Pause/Resume (kill switch), ambient-cap
editor, digest-push toggle; Health card P1 rows (ambient spend/cap, digest
opens + median, pipeline lag) with `collecting (n/k)` minimums; activity
ledger drill-down (reverse-chron, filter by actor/type). Other Internals rows
NOT rendered (rule 4 — they ship with their features). Tests: stat
min-sample rendering logic.
Depends on: A2, A9

**A13 · Cold-start backfill** (M) — §10.6-4
30-day transcript backfill through the A6/A7 pipeline at batch priority;
watermark (live ingestion owns post-start-instant); one-time $3 spend bound
with stop-at-depth + honest card copy; `learning` card with progress
(segments n/total, ETA) on the overview. Tests: watermark exclusivity, bound
stop logic.
Depends on: A6, A7, A10

**A14 · Economics P1: ambient metering + thrifty mode** (M) — §12.1–12.2
Per-day ambient spend metering from the model ledger; hard cap enforcement;
degradation order (shed 1→4, keep blocker detection / one-liners /
digest-on-open); thrifty chip state on `ctoState`; auto-clear at daily reset.
Low-tier feature gating (dial itself ships as a config field read by the
engine; Medium/High gating activates in later phases — the dial UI shows all
three tiers, higher tiers labeled with what they'll enable, selectable, and
simply have nothing extra to run yet: selecting them is honest, not a no-op,
because the label says exactly that). Tests: cap math, shed order, gating.
Depends on: A2, A9, A12

---

## Epic CTO-B — P2: judgment layer

**B1 · Blackboard store + gatekeeper** (L) — §6.1–6.8
Fact schema; per-project serialized durable proposal queue (idempotent ids,
at-least-once); gatekeeper resolution (deterministic pre-checks + A4
`gatekeeper` class): add/update/supersede/merge/reject, live-head-only
supersession; caps + displacement + archive; retention formula; half-life
policy + monthly outcome tuning; sender-reliability Beta + trace spot-checks;
checkable-fact stamping (opportunistic, surface-must-exist) + 6h verify
cycle; present-time supersession is ledger-silent. Tests: every pure piece
(retention, queue idempotency, head-only rule, checkable matching).
Depends on: A1, A4 (P1 merged)

**B2 · `cto_fact` tool + spawn-context integration** (M) — §6.2, §6.9, §3.1
Global opencode tool `cto_fact` (copy an existing thin-registrar tool +
manta-auth; client-side zero-refs rejection) → `POST /api/cto/facts`;
`assembleContext` gains top-K facts (K≤15) for delegate jobs + ephemeral
sessions; A7's rollup fact-sync switches from engine-internal writes to the
B1 proposal queue (single writer path DELETED — one path). Docs blurb
appended to `docs/opencode-tools/AGENTS.md`. Tests: registrar payload,
context assembly budget.
Depends on: B1

**B3 · Verdict ledger + counter mapping** (M) — §9.5
`verdicts.json` writer + the normative counter-mapping table (open/expire
excluded from acceptance); single write helper every UI judgment control
calls; estimator helpers (Beta mean, Beta tail test, Thompson draw) as pure
shared functions used by B4/B6/C4. Tests: mapping table enforced, estimator
math.
Depends on: A1

**B4 · Suggestion engine + decision cards (ask verbs only)** (L) — §9.1–9.4
(ask tiers), §10.3 decision-card UI
Candidate generator via A4 (`suggest` class; MAY output nothing; ≤3 options;
closed action enum — `tool-write` emission gated on consent ring data from
B7, until then the generator's tool-write branch is unreachable *by data*,
not by a code stub); worthiness gate (`worthiness` class × class prior ×
sender reliability); per-class thresholds, ask verbs only; global 15-verdict
cold-start gate; silence logging; stable card ids (regeneration updates);
decision-card UI with all five action executors, dismiss/evidence, liveness
predicates. Tests: gate ordering, id stability, enum executors (injected),
cold-start dominance.
Depends on: B1, B3, A8, A11

**B5 · Profile engine** (L) — §8.1–8.3
Deterministic layer (circular stats incl. incremental S/C sums + von Mises
components, TZ trough inference, EWMAs, correction counters); per-segment
evidence atoms (extends A6's summary call — same pass, no second call);
BKT/TrueSkill-style updates; numeric σ decay; repo-familiarity erosion;
μ−2σ scope rule; on-demand dimensions capped at 40. Digest composition (A9)
gains the `audience` block; A9's timing scheduler reads the workday
component. Tests: all the math (circular stats against known fixtures, update
directions, decay).
Depends on: A6, A9 (P1 merged)

**B6 · Profile & journal drill-down UI** (M) — §8.5, §3.2, §10.5-Internals
Profile drill-down (μ/σ bars, evidence refs, inline edit → `source: stated`
wins; sensitive inferences marked, deletable, 90d suppression); journal store
consumer (cap-50 eviction ships server-side here with the tab); 24h histogram
+ TZ. Tests: stated-wins resolution, suppression window.
Depends on: B3, B5, A12

**B7 · Tool discovery: evidence channels + registry + connect asks** (L) —
§7.1–7.4
Secret-provide ledger instrumentation in `secrets.mjs` (append
key/session/project — project from session-directory mapping); deterministic
transcript extractors (CLIs, domains, issue-key regexes) batched daily + in
backfill; config-surface scan; pattern catalog + LLM-fallback classification
(cached); registry store with both axes + quadrants + `dead` revival;
lifecycle + connect-ask needs-you cards (three-way answer incl. `never`);
ring semantics (re-eligibility, un-never→observed). NO probes yet. Tests:
extractors, quadrant derivation, lifecycle transitions, ring re-arming.
Depends on: A1, A8, B3, B4 (card infra)

**B8 · Probe runner + vitality** (L) — §7.5, §7.3-vitality, §7.6-partial
Declarative probe YAML (validated forge-rules-style, unknown keys fail by
name); runner: GET-only, evidence-derived exact-host allowlist, no
off-list redirects, public-DNS only, 256KB/10s caps, secret by reference,
untrusted wrapping; metadata-ring probes → vitality EWMA, adaptive cadence;
probe results as evidence events; probe health rows + failure escalation
(auth-fail → blocker card). Relevance scoring (weekly nano call). Deep-read
analyses are P3 (C5). Tests: validator, allowlist/SSRF rules (pure URL
checks), cadence adaptation.
Depends on: B7

**B9 · Inbox supersession** (M) — §4.4, §13.4
`send_to_cto` tool file extended with the kind schema (bare `{message}` →
`blocker`); `/api/cto/inbound` handler rewritten to write `inbox.json`
(dedupe tag coalescing via refs-merge, TTLs, read/unread); blocker kind →
existing blocking-tier routing (reuse A8 path); engine drains at breakpoints
into evidence events; **DELETE the old inbound notification-only path**.
Tests: coalescing, TTL expiry, kind routing.
Depends on: A8, B1 (sender reliability weights)

**B10 · Watcher supersession + auto-watchers** (M) — §4.3, §13.4
Standing-query engine over the evidence stream; one-time idempotent migration
of existing watches (marker in engine-state); **DELETE the old watcher poller
in the CTO inbound engine**; `watch/unwatch/list_watches` verbs re-point;
auto-created watchers (pattern-signature upsert, ≥2 occurrences, 30d/archived
retirement). Tests: migration idempotency, upsert keying, retirement.
Depends on: A5, B1

**B11 · Blackboard + tool-integrations drill-down UIs, evidence read verbs**
(M) — §10.5-Internals rows 1+4, §4.5
Blackboard drill-down (`wrong`→user supersession + `correct` verdict, `pin`,
archive browser); tool-integrations drill-down (registry table, per-ring
revoke, un-never, dead flags); `cto` tool read-belt verbs `read_facts(asOf)`,
`read_profile`, `read_toolregistry`, `read_inbox` (P1's A9 ships
`read_rollups`/`read_ledger` — note in A9). Tests: asOf reconstruction
(pure chain walk).
Depends on: B1, B6, B7

---

## Epic CTO-C — P3: autonomy layer

**C1 · Usage forecast + reserve** (M) — §11.2–11.3
`windowed` capability flag on usage adapters (+ no-adapter = windowless with
ledger-measured $); Holt-Winters (damped, weekly seasonality) pure
implementation; newsvendor reserve with notch adaptation (init P95, active
only ≥14d, P90–P99 clamp); pre-forecast fallback; spendable computation +
30-min re-eval; budget store. Tests: HW against fixtures, notch rules,
windowless path.
Depends on: A14

**C2 · Delegate pause/resume + sweep changes** (M) — §11.6
`paused` state, `pauseJob`/`resumeJob` (drain-abort at tool boundary; resume
= new session, same worktree, branch-context prompt); cap release/re-acquire
(global + CTO sub-cap); sweep: paused>7d→stopped, `actor:cto` running
allowance = remaining window; restart reconciliation (running-at-crash →
paused). Pure/injected tests mirroring `delegate.test.mjs`.
Depends on: A3 (owner stamps); independent of C1

**C3 · Overnight scheduler + portfolio + veto-window + tonight UI** (L) —
§11.1, §11.4–11.5, §9.2-veto, §10.4-tonight
Window open/close (positive-absence rule; run-now override); portfolio
scoring (formula, coarse scales, shadow price λ, hygiene floor 20%, Thompson
category blend, graceful-empty); execution through delegate with gates
(empty gate set = pass-with-`no-gates` note; git-only rule); draft expiry
(7d → `expire` verdict); veto-window verb + card (countdown, cancel/edit/
run-now; no-catch-up incl. pause abandonment); tonight line + drill-down
(reorder pins the window); preempt-on-return. Tests: scoring, floor, window
state machine, pin exemption.
Depends on: C1, C2, B4 (cards/verdicts)

**C4 · Trust promotion ladder + act-and-report** (M) — §9.4, §9.2, §3.5
Promotion/demotion on B3's Beta tail helpers (8-obs bar, 2-in-10 demotion,
cold-start dominance already enforced); `act-and-report` execution restricted
by §9.3 reversibility list; ledger + digest announcements of tier changes.
Tests: promotion/demotion sequences, reversibility gate.
Depends on: B4, C3

**C5 · Data-source deep analyses** (M) — §7.6, §11.4
Deep-read ring asks; first-analysis-as-experiment seeding `as_source`;
dismissal decay chain (deep→weekly→dormant); overnight candidates with
`p_use = vitality × relevance`, batch-routed. Tests: decay chain, p_use
composition.
Depends on: B8, C3

**C6 · ROI report + full budget card** (S) — §12.4, §10.5-3
Monthly ledger roll (spend vs accepted/merged/caught), tier recommendation
(never auto-applies); Health ROI row leaves `collecting`; Tonight's-budget
card full render at High (gauge, reserve line, provider notes), ambient-only
below High. Tests: roll math.
Depends on: C1, C3

---

## Dependency graph (summary)

```
A1 ─┬─ A2 ─┬─ A4 ─ A6 ─ A7 ─ A9 ─┬─ A11   A13(A6,A7,A10)  A14(A2,A9,A12)
    │      ├─ A5(+A3) ─ A8 ──────┤        A12(A2,A9)
A3 ─┘      └─ A10 ───────────────┘
P2: B1(A1,A4) ─ B2 · B3(A1) · B4(B1,B3,A8,A11) · B5(A6,A9) ─ B6(B3,B5,A12)
    B7(A1,A8,B3,B4) ─ B8 · B9(A8,B1) · B10(A5,B1) · B11(B1,B6,B7)
P3: C1(A14) · C2(A3) · C3(C1,C2,B4) · C4(B4,C3) · C5(B8,C3) · C6(C1,C3)
```

31 issues: 14 P1 (incl. epic) · 11 P2 · 6 P3. Critical path:
A1→A2→A4→A6→A7→A9→A11.

## Open questions for review (answer before filing)

1. **A6 is the largest P1 issue** (segmentation + summaries + turn
   completion). It could split into A6a (pure segmentation/refit) + A6b
   (summary calls + turn completion), at the cost of one more hand-off. My
   lean: keep merged — the pieces share fixtures and a split invites an
   inconsistent boundary.
2. **UI split A10/A11/A12**: shell / sections / settings. Alternative is
   per-section issues (finer, more parallel, but more renderer merge
   conflicts in one new file tree). My lean: keep as three.
3. **Phases as three filing waves or all 31 at once?** My lean: file P1
   fully + P2/P3 as epics-with-children `blocked` on their real
   dependencies — the sweeps handle dispatch, and later bodies can absorb
   anything P1 implementation teaches us before their turn comes.

## Filed (2026-08-27)

Project: Adaptive CTO. Key map:

```
EPIC-A  BET-1372
EPIC-B  BET-1373
EPIC-C  BET-1374
A1      BET-1375
A2      BET-1376
A3      BET-1377
A4      BET-1378
A5      BET-1379
A6      BET-1380
A7      BET-1381
A8      BET-1382
A9      BET-1383
A10     BET-1384
A11     BET-1385
A12     BET-1386
A13     BET-1387
A14     BET-1388
B1      BET-1389
B2      BET-1390
B3      BET-1391
B4      BET-1392
B5      BET-1393
B6      BET-1394
B7      BET-1395
B8      BET-1396
B9      BET-1397
B10     BET-1398
B11     BET-1399
C1      BET-1400
C2      BET-1401
C3      BET-1402
C4      BET-1403
C5      BET-1404
C6      BET-1405
```
