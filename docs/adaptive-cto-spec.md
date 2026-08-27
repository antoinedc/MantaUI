# Adaptive CTO — specification

Status: draft v2 — post-review, 59 findings reconciled · Owner: Antoine · Sources: research pass 2026-08-27
(mixed-initiative/interruption, agent memory/summarization, user modeling,
budget-constrained computation), design session 2026-08-27, mockup v3
(`/pages/cto-view`).

The Adaptive CTO is a background system on the box that maintains a live model
of all agent work, produces absence-aware digests, builds an editable profile
of the user, discovers the user's external tools, suggests work, and — with
earned trust and budget headroom — performs work autonomously. It is quiet
(never demands attention it hasn't earned), inspectable (every action is
ledgered), and budget-bounded (hard caps independent of everything else).

**Two invariants govern everything below:**

1. **Quiet ≠ covert.** Every autonomous act is recorded in an append-only
   activity ledger the user can read. Acting without reporting is forbidden
   (an autonomous action the user cannot discover is a bug, not a feature).
2. **No dead controls.** Per the repo-wide rule (AGENTS.md "NEVER STUB A
   CONTROL"), every UI element in §10 has a defined behavior in this spec.
   There are no "later" placeholders; if a control is listed, its handler is
   specified.

**No assumptions about the user's setup.** Linear, PostHog, GitHub, Multica,
Jira etc. appear in this document only as *examples*. The system discovers
whatever tools the user actually has (§7) from generic evidence channels; no
tool is special-cased, hardcoded, or assumed present. A user with zero
external tools gets a fully functional CTO minus the tool-dependent features.

---

## 1. Glossary

| Term | Meaning |
|---|---|
| **Evidence layer** | The merged, timestamped record all signal channels converge into (§4) |
| **Segment** | A contiguous burst of activity in one session, bounded by inactivity gaps (§5) |
| **Rollup** | A write-once summary at hour/day/week granularity (§5) |
| **Blackboard** | Per-project standing-facts store, collaboratively maintained (§6) |
| **Fact** | One `{kind, statement, refs, confidence}` entry on the blackboard |
| **Profile** | The per-dimension (μ, σ) model of the user (§8) |
| **Tool registry** | Discovered external tools with engagement + vitality scores (§7) |
| **Probe** | A declarative, GET-only scheduled read against an external tool (§7.5) |
| **Verdict** | Any user response to CTO output: accept / dismiss / edit / veto / expire / correct (§9.5) |
| **Verb** | One of the five surfacing/action modes: silent-log, inbox card, notify, veto-window, act-and-report (§9.2) |
| **Needs-you item** | A blocker or decision card — the only loud UI elements (§10.3) |
| **Dial** | The user-facing effort setting: Low / Medium / High (§12.1) |

---

## 2. Decisions log (locked in the design session)

| # | Decision |
|---|---|
| D1 | Runtime = deterministic engine + **ephemeral headless opencode sessions**; no persistent "mind" session. Memory lives in durable stores, plus a capped **CTO journal** for unstructured notes-to-self. |
| D2 | This system **supersedes** the existing CTO tooling: `cto` read belt → evidence query API; `watch`/`unwatch`/`list_watches` → standing-query engine; `send_to_cto` → the inbox tool (§4.4); the on-call CTO chat agent remains as the conversational surface over the same stores. |
| D3 | Blackboard gatekeeper serializes proposals per project through a queue (single writer per project). |
| D4 | Preemption of background jobs is folded into the delegate engine (§11.6): stop at next step boundary, resume from branch. |
| D5 | Per-provider quota semantics are a v1 must-have (§11.2). |
| D6 | Presence = max of desktop heartbeats, app opens, prompt activity (§5.4). |
| D7 | All stores are schema-versioned from day 1 (§13.4). |
| D8 | UI: **CTO button at the top of the sidebar**, opening a **global** (not per-workspace) pane. iOS out of scope. Settings pane carries health stats, the on/off switch, and the internals drill-downs. |
| D9 | Digest timing: sensible default (pre-workday rising edge from the profile), a **Digest now** button, and the CTO learns the best time from observed open times. |
| D10 | Blackboard is collaborative from the start (v2 semantics): agents propose, gatekeeper resolves. |
| D11 | Fact decay: half-life is system policy per `kind`, outcome-tuned. Writers may set `valid_until` (event-time knowledge) which can only **shorten** a fact's life, never extend it. |
| D12 | Token budget: one user dial (Low/Medium/High) in behavior terms; hard daily cap independent of the dial; model per task class resolved by the router, never pinned. |
| D13 | Tool model has two orthogonal axes: **engagement** (used through agents) and **vitality** (holds fresh data). Consent rings: metadata → deep-read → write; each ring is a separate ask; "never for this tool" kills all rings. |
| D14 | Decision cards do **not** show cost estimates on options. |
| D15 | CTO view is light by default: needs-you first and loudest; Now + Just-finished card rails; short digest; tonight as a one-line opt-in; blackboard/profile/rhythm/ledger/tools live behind Settings → Internals, never on the main view. |
| D16 | "Beliefs overturned" is not a digest section; when relevant it appears as a subordinate clause on the item it belongs to. |
| D17 | Sidebar badge counts **needs-you items only** (blockers + open decisions). |
| D18 | Digest-now placement: header, small button. |
| D19 | Cold-start backfill depth: **30 days** of transcript history. |
| D20 | Blocker-tier items also route through the existing notification router (they do not wait for a view visit). |
| D21 | "Just finished" rail includes finished CTO jobs (label `review →`) alongside user sessions. |

---

## 3. Runtime model

### 3.1 Engine + ephemeral sessions (D1)

The CTO is **not** a long-running agent conversation. It is:

- **`src/server/ctoEngine.mjs`** (new) — deterministic server code: schedulers,
  stores, queues, scoring, thresholds, probe runner, budget math. Same
  dependency-injected style as `delegate.mjs`. Owns every timer.
- **Ephemeral headless opencode sessions** — for every step that needs a
  model: segment summaries, gatekeeper resolution, digest composition,
  suggestion generation, overnight planning. Lifecycle: create session (no
  tmux window, no `@manta-session-id` stamp → no sidebar row) → inject
  assembled context → one or few turns → read result → **delete session**.
  Result reads are synchronous (`GET …/message` on the session) — ephemeral
  sessions do not depend on scoped SSE streams, so no directory registration
  is needed (avoids the documented scoped-stream trap). Sessions are tagged
  (title prefix `cto:`) and recorded in `engine-state.json`'s active set; a
  reaper sweeps orphans (created > 30 min ago, still present, not in the
  active set) every 10 min, so an engine crash between create and delete
  cannot leak sessions. Nothing may exist only in a transcript; every
  conclusion is written to a durable store before deletion.
- **Delegate jobs** — for anything that edits files (unchanged contract:
  worktree, branch, visible sidebar row, machine gates).

**Context assembly** for an ephemeral session is a pure function
`assembleContext(taskClass, scope)` reading from: relevant blackboard facts,
profile slice, recent rollups, tool registry entries, and the journal. Budgeted
(≤ N tokens per class, see §12.3).

### 3.2 The CTO journal

A durable store for unstructured residue that fits no schema: timing
observations ("digest opened late on Mondays"), meta-lessons ("user dislikes
dep-bump suggestions"), hypotheses about preferences. Entries:
`{id, text, created, last_accessed, refs[]}`. Same discipline as the
blackboard: hard cap (50 entries), retention by access, decay, eviction at
admission (the lowest-retention entry is displaced, exactly like facts §6.3),
append via the engine only (ephemeral sessions *propose* journal entries in their structured
output; the engine writes them). Inspectable under Settings → Internals →
Profile & rhythm (journal tab).

### 3.3 System identity

All in-process RPC calls the engine makes (create session, new window, send
prompt, rename) carry an actor tag `actor: "cto"` in the server logs and the
activity ledger. Rate limits: ≤ 30 session creations/hour, ≤ 5 concurrent
ephemeral sessions, ≤ 2 concurrent delegate jobs started by the CTO (inside
the global cap of 5). Exceeding a rate limit pauses the engine and raises a
health warning (§10.6).

### 3.4 Control etiquette (hard rules)

1. **Never send a prompt into a user-owned session.** Sessions carry an
   `owner ∈ {user, cto, job}` tag (new tmux user-option `@manta-owner`,
   default `user`; delegate stamps `job`; the engine stamps `cto`). The single
   exception: a deliverable the user explicitly routed to a session, delivered
   through the existing prompt-delivery engine (defers until idle).
2. Persistent CTO working sessions live in one dedicated tmux session
   (workspace) named `cto`, collapsed by default in the sidebar, TTL-swept
   (7 days) like delegate records.
3. Heavy work (rollup batches, probe fan-outs, overnight jobs) runs only in
   presence states `away`/`gone` (§5.4). While `present`, only the trickle
   runs: event ingestion, deterministic updates, segment-close summaries
   (single nano calls).
4. User returns early → all CTO background jobs stop at their next step
   boundary (§11.6); the overnight window closes.

### 3.5 Autonomy tiers for manta control

| Action | Tier |
|---|---|
| Read anything (transcripts, config, usage, git, stores) | always, silent |
| Create/delete own ephemeral sessions; run consented probes | always, ledgered |
| Create user-visible project/session; start an overnight job | veto-window → act-and-report as the class earns trust (§9.4) |
| Prompt into a user-owned session | never autonomous; user-routed delivery only |
| Restart services, modify config, touch secrets/webhooks definitions | always ask |

---

## 4. Evidence layer

All signals converge into one merged, timestamped record. Four channels, each
with a distinct trust property and salience prior:

### 4.1 Event stream (ambient, complete, unranked)

The existing in-process bus + opencode SSE streams. The engine subscribes like
any other consumer. No new plumbing. Salience prior: none (statistical only).

### 4.2 Stigmergy (ground truth)

Traces of work read from the environment: git state on job branches, todo
states, artifacts, CI results, transcripts' tool-call records. Never written
as a signal; only observed. Used to **verify claims** from the other channels
(a blackboard proposal or inbox note whose refs show no supporting trace is
rejected and dings the sender, §6.6).

### 4.3 Standing queries (watchers)

Observer-declared interest: the engine registers predicates over the streams
(error-rate thresholds, recurring-failure patterns, usage burn pace). The
existing watcher machinery (`cto.mjs` watch/unwatch/list_watches) becomes this
engine (D2): same store, new consumers. The CTO **creates its own watchers**
when rollups detect recurring themes (≥ 2 occurrences of a matchable pattern),
and **retires** them after 30 days without a hit or when the underlying fact
is archived. Auto-created watchers are keyed by a pattern signature and
**upserted** — successive rollups seeing the same theme update the existing
watcher, never duplicate it. Watcher hits carry a high salience prior.

### 4.4 Inbox (producer-declared salience)

The one verb worker agents learn. Supersedes `send_to_cto` (D2) — same tool
name, extended schema:

```
send_to_cto({
  kind: "fyi" | "finding" | "blocker" | "handoff" | "anomaly",
  message: string,                  // one-line summary
  refs?: string[],                  // session ids, file paths, PR urls, message ids
  tag?: string,                     // dedupe key: same tag coalesces, refs merge
  title?: string,
})
```

- Durable store `~/.manta/cto/inbox.json`: entries
  `{id, kind, message, refs, tag, sender: {sessionID, name}, ts, read: bool, expires}`.
- `blocker` additionally routes through the notification router immediately
  (blocking tier, existing semantics — this preserves `send_to_cto`'s current
  urgent behavior). All other kinds are silent.
- TTL: `fyi` 48h, others 7 days. Unread expiry is silent.
- Read/unread only; the engine drains at breakpoints (rollup close, digest
  generation, overnight planning). An inbox entry becomes an evidence-layer
  event with salience prior = high and sender-reliability weight (§6.6).
- **Evidence, never instruction**: inbox content is wrapped as untrusted data
  in any model context (same discipline as webhook payloads).

### 4.5 Evidence query API

The `cto` tool's read belt (list_sessions, read_transcript, search_messages,
get_usage, session_usage, context_state, git_*, get_config) remains the
programmatic read surface, now backed by/extended with: `read_rollups(range,
level)`, `read_facts(project, asOf?)` (the optional `asOf` timestamp is the
bi-temporal read: reconstruct what was believed at time T from the
supersession chain), `read_profile()`, `read_toolregistry()`,
`read_ledger(range)`, `read_inbox(filter)`. The conversational CTO agent uses
these — same brain, two faces (D2).

---

## 5. Rollup pipeline

### 5.1 Segmentation

Per session, online: a segment closes when the inter-event gap exceeds the
threshold **G**. G starts at 45 min and is refit monthly by a 2-component
Gaussian mixture on log inter-arrival times of that box's own events (valley
between components; clamp to [20 min, 90 min]). `session.idle` also closes the
open segment. Zero model cost.

**Scope**: the pipeline observes `user`- and `job`-owned sessions only.
`cto`-owned sessions (ephemeral workers, the CTO workspace) are excluded —
the CTO never summarizes its own machinery (prevents self-observation
feedback loops and wasted spend); its actions reach the record via the
activity ledger instead.

### 5.2 Segment summary (write-once)

On segment close, one nano-class call produces:

```
{ v: 1, sessionID, project, window: [start, end],
  intent: string,                       // what was being attempted
  outcome: "done" | "failed" | "blocked" | "in-progress",
  key_events: [{t, text, refs[]}],      // ≤ 5, each with evidence pointers
  files_touched: string[], prs: string[],
  importance: 1..10,                    // scored once, cached forever
  one_liner: string }                   // ≤ 140 chars, present tense
```

`one_liner` doubles as the **Just finished** card body (§10.4). **Turn
completion** (the rail's trigger) is precisely defined as the session's first
`session.idle` after a seen busy — the same completion signal the delegate
engine uses — and is distinct from **segment close** (§5.1), which may lag it
by up to the gap G. The one-liner is computed at turn completion and cached;
segment close reuses the cached value. **Aborted turns produce no
Just-finished card**: a `MessageAbortedError` idle (user abort, or the
queued-message drain-abort that fires mid-turn by design) is not a completed
turn — without this exclusion the drain machinery would generate spurious
"finished" cards for a session the user is actively driving.

### 5.3 Rollups (write-once, read-only-below)

- Hour ← that hour's segment summaries; Day ← hours; Week ← days.
- Each reduce is one cheap-model call conditioned on the preceding same-level
  summary (running context) and carries `ADD/UPDATE/NOOP` semantics against
  the project's blackboard facts (§6) so news is never re-reported.
- Each level reads only the level below. Evidence pointers propagate: every
  rollup bullet keeps refs to segment ids → message ids.
- Quiet periods produce no rollup rows (absence of data is free).
- **Rollups are immutable once written**: a later correction (fact
  supersession) never rewrites a rollup — corrections live on the blackboard
  and in later digests, and the running-context chain is accepted as a
  best-effort record, not a corrected history.
- Rollup reduce batches are preemptible **between reduce calls** (each call
  is the checkpoint) — this satisfies §3.4 rule 4 for non-delegate work
  without any delegate machinery.

### 5.4 Presence & absence

`last_seen = max(desktop presence heartbeat, app open/focus events, user
prompt submissions)` (D6). **Boxes with no desktop client never heartbeat** —
presence then derives from app opens + prompt activity alone, and the state
machine gains `unknown` (no positive signal either way). `unknown` is treated
as `present` for etiquette (§3.4: quiet is the safe default), while the
overnight window (§11.1) requires a POSITIVE absence signal. Absence Δ =
now − last_seen. Digest granularity by Δ (the first boundary is the fitted G;
16h and 3d are fixed policy constants, deliberately not G-derived):

| Δ | Digest reads from | Item unit |
|---|---|---|
| < G | live events | events |
| G – 16h | segment summaries | work episodes per project |
| 16h – 3d | hour/day rollups | sessions/threads with outcomes |
| > 3d | day rollups | themes + trends |

Item budget is constant (4–7 items) at every level. Blocking items **never
roll up and never occupy a digest slot** at any Δ — they are extracted into
needs-you cards (§10.3) entirely outside the item budget.

### 5.5 Digest composition

One mid-class model call at generation time: input = the Δ-appropriate rollup
slice + open needs-you items + tool-probe findings + facts changed in the
window; output = ordered digest items `{tier, text, sub?, refs[], deep?: string}`.
Tier lattice (deterministic, outranks any learned score):
`blocker ≫ failure ≫ decision-made ≫ shipped/milestone ≫ external ≫ progress`.
Blockers are *extracted out* of the digest into needs-you cards (§10.3); the
digest itself never contains an actionable blocker (D15). "Nothing important
happened" is a legal output (renders the resting state). Per-item technicality
adapts to the profile (§8.4); `deep` is the expandable technical layer, always
present when the item summarizes technical work.

Timing (D9): generated on view-open if stale (> 30 min since last), on
**Digest now**, and pre-generated at the learned delivery time — default =
30 min before the rising edge of the dominant workday component (§8.2), with
a fixed fallback of 09:00 in the profile's inferred timezone when its
confidence is high, else 09:00 box-local, when no dominant component exists
(flat/multimodal rhythm, or < 14 days of data); learned = median of observed
digest-open times over the trailing 14 days once ≥ 7 opens exist. The last
30 generated digests persist in the `digests/` store (§13.1) — the view
renders from the store, so a restart never blanks the digest section.

**Single-flight**: generation holds a server-side lock keyed by
absence-window id. Concurrent triggers (view-open racing the scheduled
pre-generation; Digest-now from two views) **join** the in-flight generation,
never start a second. Generation state is published as a bus event; the
Digest-now button renders the server's state, not per-view state.

If "Push digest to phone" is enabled (§10.5), the pre-generated digest also
fires an informational-tier notification. It follows the router's normal
informational deferral (desktop-first; mobile deferred while the user is
present) — in the typical pre-workday case the user is `gone` and the phone
fires immediately. The notification deep-links to the desktop CTO pane; on
mobile (no CTO pane, D8) it is informational text only.

---

## 6. Blackboard

Per-project standing facts; the shared belief state. Store
`~/.manta/cto/facts/<project>.json`.

### 6.1 Fact schema

```
{ v: 1, id, kind: "status" | "blocker" | "decision" | "theory" | "invariant" | "anomaly",
  statement: string,                    // ≤ 200 chars
  refs: string[],                       // evidence pointers, ≥ 1 REQUIRED
  confidence: 0..1,
  created, last_accessed, access_count,
  valid_until?: ts,                     // writer-set, event-time knowledge (D11)
  checkable?: {probe: string, last_checked, result},   // §6.7
  superseded_by?: id,                   // never deleted, superseded
  sender: {sessionID | "cto" | "user"} }
```

### 6.2 Proposals (collaborative, D10)

Any agent (worker session, delegate job, ephemeral CTO session) proposes via a
new global opencode tool `cto_fact` (thin registrar → `POST /api/cto/facts`):

```
cto_fact({ project, kind, statement, refs, valid_until?, supersedes?: id })
```

Proposals with zero refs are rejected client-side. The gatekeeper (per-project
serialized queue, D3) resolves each proposal against the existing set with one
nano-class call + deterministic pre-checks into: **add / update / supersede /
merge / reject**. Merge unions refs. Reject returns the reason to the caller.

Queue semantics: **durable** (pending queue persisted in
`engine-state.json`), at-least-once with client-generated idempotent proposal
ids, so a crash mid-resolution re-resolves harmlessly. A proposal may only
supersede the **live head** of a fact chain; one targeting an
already-superseded fact is rejected with the live head's id (this prevents
supersession cycles and unbounded chains).

### 6.3 Caps & displacement

Hard cap: **50 active facts per project**. Admission beyond the cap must
displace the lowest-retention fact (which moves to the archive). Archive
(`facts-archive/<project>.json`) is queryable, never in any prompt by default,
swept at 10× cap.

### 6.4 Retention & decay

```
retention = kind_weight · 0.5^(hours_since_last_access / half_life(kind))
            · (1 + ln(1 + access_count)) · sender_reliability
```

Access = retrieval into any digest, spawn context, suggestion, or drill-down
view. Half-lives (initial policy, outcome-tuned per §6.8): `status` 3d,
`anomaly` 7d, `theory` 21d, `blocker` until resolved (no decay while an
unresolved ref exists), `decision`/`invariant` 180d. `valid_until` expires a
fact at that instant regardless (can only shorten, D11).

### 6.5 Supersession

A contradicting accepted proposal sets `superseded_by` on the old fact; both
persist. Digest generation reads facts with `superseded_by` set inside the
absence window to phrase "this overturns X" clauses (D16). A supersession
that happens **while the user is present** is silent (ledger only); its
clause appears in the next digest whose window covers it.

### 6.6 Sender reliability

Per sender (session-name-stable identity or agent class): Beta counters
`(confirmed, rejected)`. Confirmed = fact later verified, used, or survived to
natural expiry; rejected = gatekeeper reject or later overturned within 48h.
`sender_reliability = (confirmed+1)/(confirmed+rejected+2)`, used in retention
and as a gatekeeper prior. Trace check: the gatekeeper spot-verifies refs
exist (message ids resolve, commits exist); failed spot-checks reject and
count as `rejected`.

### 6.7 Checkable facts

Facts whose statement maps to a deterministic probe (branch exists, CI status,
issue open/closed, dependency version — matched by pattern at admission) are
stamped `checkable` and re-verified on a 6h cycle by the engine (no model
cost). A failed check supersedes the fact automatically (`sender: "cto"`).
A fact is only stamped checkable when its verification surface actually
exists (git present for branch facts, a consented tool for issue facts, CI
detectable for CI facts) — otherwise it is an ordinary fact; checkability is
opportunistic, never assumed.

### 6.8 Outcome tuning

Monthly, the engine recomputes per-kind half-lives from observed overturn
times (median time-to-supersession per kind, clamped to ±50% of policy
default). Ledgered.

### 6.9 Spawn-context contract

`assembleContext` for any delegate job or ephemeral session includes the
target project's top-K facts by retention (K ≤ 15). This is how a job started
tonight knows "payment path is mid-migration — don't touch webhook handlers."

---

## 7. Tool discovery & adapter registry

Discovers the user's external tools generically. **No tool list ships with the
system**; a small *pattern catalog* ships (domain → tool-identity heuristics,
issue-key regex shapes, CLI name list) purely to label evidence, and an
LLM-classification fallback handles anything the catalog doesn't know (result
cached). The catalog labels; it never assumes presence.

### 7.1 Evidence channels (fused)

1. **Secret-provide ledger** (new): `secret_provide` is instrumented
   server-side to append `{key, sessionID, project, ts}` to
   `~/.manta/cto/tool-usage.json` — `project` is resolved server-side from
   the calling session's directory → project mapping (`secret_provide`
   itself carries only key + sessionID). Exact usage, zero parsing, zero
   value exposure.
2. **Deterministic transcript extractors**: regex over tool-call parts in
   opencode's store — CLI invocations, API domains in network calls, issue-key
   patterns in branch names/commit subjects. Batched daily + in the cold-start
   backfill.
3. **Config surfaces**: MCP servers in opencode config, forge rules, inbound
   webhooks, git remotes, schedule targets.
4. **LLM fallback**: classify unknown domains/CLIs once; cache.

### 7.2 Registry schema

```
{ v: 1, tool: string,                     // canonical identity
  evidence: [{channel, detail, ts}],
  engagement: {ewma_per_week, last_used, per_project: {}},
  vitality:   {last_event?, inflow_rate?, ewma, last_probed},
  role: "workflow" | "data-source" | "both" | "dead",   // derived, §7.3
  relevance: {project: 0..1},             // blackboard match, §7.6
  as_source: {reports, accepted},         // Thompson counters for insights
  as_workflow: {suggestions, accepted},   // separate counters
  consent: {metadata: yes|no|never, deep_read: ..., write: ...},   // rings, D13
  status: "observed" | "candidate" | "integrated" | "trusted:<class>" }
```

### 7.3 The two axes (D13)

- **Engagement** = agent-mediated usage (channels 1–3), EWMA with decay.
- **Vitality** = freshness × inflow of data inside the tool, measured by
  metadata probes (§7.5), cadence adaptive to observed inflow (daily ↔ weekly).

Quadrants derive `role`: high/high = both; high engagement only = workflow;
high vitality only = **data-source** (mine it, don't expect workflow items);
low/low with prior engagement = dead (candidate-for-removal note in the tool
drill-down; never auto-deleted). `dead` is a label, not a terminal state:
renewed engagement or vitality re-promotes through the normal lifecycle.

### 7.4 Lifecycle & consent rings

`observed` (evidence accumulates, nothing runs) → `candidate` when either axis
crosses its bar (engagement: ≥ 3 uses across ≥ 2 weeks; vitality path: a
credential exists at all → eligible for the *metadata consent ask*) →
**one connect ask** (a needs-you decision card, §10.3, with the evidence trail
and the three-way answer: connect read-only / not now / **never for this
tool**) → `integrated` (probes run) → `trusted:<action-class>` per the
standard promotion ladder (§9.4). Rings (D13): metadata consent ≠ deep-read
consent ≠ write; each escalation is a separate ask; "never" kills all rings
and suppresses future asks for that tool (revocable only in the tool
drill-down).

Ring semantics, precisely:

- **Re-eligibility**: "not now" re-arms after 30 days or a fresh axis-bar
  crossing; on the vitality path (whose bar — a credential exists — cannot
  re-cross) the 30-day timer is the only re-arm. "Un-never" (tool
  drill-down) returns the tool to `observed`; a new ask still requires a
  fresh bar crossing.
- **Rings govern the CTO's autonomous access only.** Worker agents may
  already use a tool's credential at the user's direction — that is the
  user's own workflow and implies nothing about the CTO's standing access.
  The rings bound what the CTO may do on its own schedule with no human in
  the loop.
- **The write ring creates no standing write specs.** Writes are always
  one-off engine-executed requests bound to an accepted decision-card option
  (§9.1 `tool-write`), never probes. Tool trust promotion
  (`trusted:<action-class>`) is backed by per-tool-per-action-class Beta
  counters — a finer partition of the same verdict ledger — on the §9.4
  ladder.

### 7.5 Probe specs (declarative, AI-authored)

`~/.manta/cto/probes/<tool>.yaml`, written by the engine after consent,
validated like forge rules (unknown keys fail by name):

```yaml
tool: <canonical id>
auth: { secret: <KEY_NAME>, header: <header template> }   # by reference only
probes:
  - name: <probe id>
    method: GET                    # GET-only, enforced by the runner
    url: <https url on the consented domain allowlist>
    extract: { <field>: <json-path> }
    cadence: <duration ≥ 5m>
    ring: metadata | deep_read     # must be ≤ consented ring
```

Runner enforcement: domain allowlist derived from the tool's evidence (exact
hosts, no redirects off-list, public DNS only — RFC1918/localhost/link-local
rejected), 256 KB response cap, 10 s timeout, secrets resolved at spawn via
`$(cat path)`-equivalent (value never in any context or log), responses
wrapped as untrusted data. Probe results are evidence-layer events. The whole
probe subsystem sits behind the master CTO toggle (§10.5) and additionally
does nothing for tools without consent.

### 7.6 Relevance & the data-source path

`relevance[project]` = match strength between the tool's data domain and the
project's active blackboard facts + recent rollups (one nano call, refreshed
weekly). Overnight data-analysis candidates (e.g. "analyze the analytics
tool's funnel data for the flow touched this week; report changes + feature
recommendations") get `p_use = vitality.ewma × max(relevance)` in the §11.4
scoring. First deep analysis of any source is a deliberately small experiment;
its verdict seeds `as_source` counters. Sources whose reports are repeatedly
dismissed decay: deep analysis stops, then metadata probing drops to weekly,
then dormant (evidence still accumulates passively).

---

## 8. Profile engine

### 8.1 Schema (all inferred values carry provenance + confidence)

```
{ v: 1,
  identity: { stated: {} },                     // user-editable, always wins
  skills: { <dimension>: {mu, sigma, evidence: [refs], updated} },
  repo_familiarity: { <repo/area>: {doa, doi, updated} },
  temporal: { tz_offset: {value, confidence},
              workday: {components: [{mu_hour, kappa, weight}], r_bar, weekend_ratio} },
  interaction: { prompt_freq_ewma, session_len_median,
                 question_mix: {}, correction_rate,
                 verbosity_pref: {value, source}, depth_pref: {value, source} },
  provenance: append-only [{field, delta, evidence, ts}] }
```

Skill dimensions are **created on demand** from observed topics (no fixed
list); capped at 40 dimensions by the same retention discipline as facts.

### 8.2 Updates

- **Deterministic per event** (free): timestamps → incremental circular stats
  (running S,C sums → mean hour, resultant length R̄, von Mises components via
  24-bin histogram peaks); EWMAs; correction-rate counters. TZ inference:
  activity trough = local night; flagged low-confidence until 14 days of data.
- **Per closed segment** (one nano call, shared with §5.2's pass): structured
  evidence atoms `{dimension, direction, weight, ref}` — never free-form
  prose. Applied as Bayesian updates: binary evidence → BKT-style update;
  graded → TrueSkill-style `μ ± (σ²/c)·v(t)` with topic difficulty as the
  opponent. Hard-topic evidence moves estimates more (information weighting).
- **Decay is numeric**: `σ' = √(σ² + c²·weeks_idle)` per dimension (never
  LLM-judged); repo familiarity erodes ∝ log of others'/agents' edits to that
  area.

### 8.3 Anti-assumption rule

Any behavior conditioned on expertise acts on **μ − 2σ** (the conservative
bound). Default rendering is the shorter form with an expandable deep layer,
so estimation errors degrade gracefully in both directions.

### 8.4 Consumption

- Digest technicality per item: topics in the item → μ−2σ →
  `audience` block injected into the composition prompt (explicit profile
  beats implicit history for controllability).
- Suggestion-type routing: review-heavy users get diffs-to-review; delegate-
  heavy users get background-job proposals; low repo familiarity on a touched
  area adds orientation context to items about it.
- Digest delivery time (§5.5). Deviation-from-own-baseline flags (a 3am
  session for a 10–18h user) — surfaced only to the user, only as a digest
  `progress`-tier aside, never in any shared artifact.
- **Scope of μ−2σ**: the conservative bound applies to expertise-conditioned
  behavior (digest technicality, explanation depth, orientation context —
  repo familiarity uses `doa` with its own staleness discount). Consumers
  keyed on interaction stats (suggestion-type routing on `question_mix`,
  `correction_rate`) use raw EWMAs: those are observed preferences, not
  expertise claims, and need no conservatism.

### 8.5 Transparency

Profile drill-down (Settings → Internals): every dimension with μ, a σ
confidence bar, top-3 evidence refs, inline edit. Edits write
`source: stated`, which wins over inferred permanently (until re-edited).
Sensitive inferences (sleep window, overwork pattern) are marked, visible only
in this drill-down, and individually deletable; deleting one suppresses that
inference class for 90 days.

---

## 9. Suggestion engine

### 9.1 Pipeline

```
evidence events (+salience priors) 
  → candidate generator (mid-class model; MAY output nothing; ≤ 3 candidates per finding)
  → worthiness gate p(want|E) (calibrated: nano-model score × class prior × sender reliability)
  → per-class thresholds (p_ask, p_act) → verb
```

Silence is logged: gated-out candidates are recorded (id, score, reason) in
the ledger for the silence audit (§14.3).

Candidate schema (what the generator emits is exactly what the card renders —
no unbound options):

```
{ id,                      // stable: hash(finding-id, class). Regenerations
                           // UPDATE the existing card (age, counts, open
                           // verdicts carry forward), never duplicate it.
  class: string,           // action class, for thresholds + trust counters
  finding: {text, refs[]},
  options: [{label, action: {type, payload}}] }        // ≤ 3
```

`action.type` is a closed enum: `config-change` (option opens a confirm
showing the concrete diff, then applies it), `queue-tonight` (adds the
payload task to the §11.4 portfolio), `start-job` (starts a delegate job with
the payload prompt), `tool-write` (one-off engine-executed request; the
generator may emit it ONLY for tools holding the `write` consent ring, §7.4),
`record-decision` (writes a blackboard `decision` fact — the universal
fallback when no tool ring or tracker applies). No option type outside this
enum exists; an option is always executable the moment it renders.

### 9.2 The five verbs

| Verb | Behavior |
|---|---|
| silent-log | ledger entry only |
| inbox card | a needs-you **decision card** (§10.3) — options rendered as buttons, no cost estimates (D14) |
| notify | decision card + notification-router delivery at the informational tier (breakpoint-timed) |
| veto-window | announce with countdown (default 30 min); executes unless cancelled; cancellation is a verdict |
| act-and-report | execute (reversible/isolated actions only); ledger + digest report mandatory |

Blockers (worker questions/permissions, `blocker` inbox notes) are not
suggestions — they bypass the gate, render as blocker cards, and route through
the notification router at blocking tier (D20).

### 9.3 Eligibility by reversibility

`act-and-report` and `veto-window` are only reachable for actions that are
read-only, worktree-isolated, or trivially reversible. Anything touching a
user session, protected refs, production systems, money, config, or secrets is
capped at inbox/notify (ask) permanently.

### 9.4 Earned trust (per action class)

Beta counters per class. Promotion ask→veto-window when
`P(acceptance > 0.9) > 0.95` with ≥ 8 observations; veto-window→act-and-report
at the same bar over the veto-window record (a cancel counts as rejection).
Any 2 rejections in a rolling 10 demote one step. Promotions/demotions are
themselves ledgered and announced in the next digest (`progress` tier).
**The global cold-start gate dominates** (§10.6-4): no class may leave ask
verbs before the ≥ 15-verdict minimum clears, whatever its own counters say.

### 9.5 Verdict ledger

`~/.manta/cto/verdicts.json`, append-only:
`{ts, subject: {type, id, class, sender?}, verdict: accept|dismiss|edit|veto|expire|correct|open,
never?: bool}`. Single source feeding: worthiness thresholds, trust counters,
tool `as_*` counters, fact sender reliability, digest-item open-rate,
depth-pref updates, and the reserve fractile (§11.3). Every UI control in §10
that expresses a judgment writes exactly one verdict.

Counter mapping (which verdicts feed which learners — this table is
normative):

| Verdict | Acceptance/trust Beta | Importance/retention | Note |
|---|---|---|---|
| accept, edit | success | access | edit = accept-with-signal |
| dismiss, veto, correct, never | rejection | — | veto = cancelled veto-window |
| open | — | access | **never** enters acceptance counters |
| expire | — | decay signal | **never** enters acceptance counters |

Estimator policy (deliberate, not an inconsistency): Thompson sampling is
used where the system *selects under exploration* (portfolio categories,
tool-as-source); Beta tail tests / means where it *gates* (trust promotion,
sender reliability). Selection wants exploration; gates want stability.

---

## 10. UI specification

### 10.1 Entry point & placement

- **Sidebar button "CTO"** pinned above the project list (D8). Global scope.
- Badge: count of open needs-you items only (D17), red, hidden at zero.
- Status dot on the button: green = active, gray = disabled, amber = thrifty
  mode, red = paused.
- Clicking opens the CTO pane in the main content area (replaces the active
  session panel, same navigation model as Settings).
- **Data path**: the engine publishes a `{kind: "ctoState"}` bus event
  (needs-you count, status-dot state, generation-in-flight flag, tonight
  count) on every change; the renderer subscribes over the existing `/events`
  SSE — the badge, dot, Digest-now spinner, and tonight line all render from
  this one event, with a `GET /api/cto/state` read for initial mount. No
  polling.

### 10.2 Overview page — fixed order, single 960px column

Section **order** is invariant — sections may be absent (each collapses to
nothing when empty) but never reorder: **Needs you → Now → Just finished →
While you were away → Tonight**. On a good day the page is nearly empty
(resting state §10.6-1); that is intended.

Header row: title "CTO" · spacer · **Digest now** (small button: joins or
starts the §5.5 single-flight generation; renders the *server's* generation
state as a spinner via the bus event, so two views/devices can never
double-generate; on completion scrolls to the digest section, or to the
resting-state line when the digest is empty; failure → error toast naming the
cause) · **⚙** (opens Settings & health).

### 10.3 Needs-you cards

The only loud elements. Two variants:

- **Blocker card** (red left edge, 3px): title, verbatim question/ask, age
  stamp, one primary action **Answer now →** (question/permission sources:
  navigates to the owning session with the question card focused — the
  existing `manta-scroll-to-question` bridge; inbox-note and health sources:
  navigates to the first ref / the fix surface). If a card's target session
  or window no longer exists, the action falls back to opening the matching
  ledger entry — the button always lands somewhere. Sources: worker questions/permissions pending > 10 min, `blocker`
  inbox notes, health escalations (§10.6-7). Two timers by design: the
  blocking-tier *notification* fires immediately (D20); the *card* appears at
  > 10 min (most questions are answered in-session before that).
- **Decision card** (accent left edge): title, one-paragraph why (with
  occurrence counts/evidence inline), 2–3 option buttons, each bound at
  generation time to a §9.1 action (`config-change` / `queue-tonight` /
  `start-job` / `tool-write` where the write ring is consented /
  `record-decision` as the universal fallback), `dismiss` (writes verdict),
  `evidence ▸` (expands the refs list inline; each ref deep-links).
  **No cost estimates on options** (D14).
- **Veto-window card** (warn left edge): countdown (live, 1s tick), **Cancel
  tonight** (cancels the run, writes veto verdict), **Edit plan** (opens the
  tonight drill-down §10.4), `run now instead` (starts the window
  immediately — an explicit user command, so it overrides the §11.1
  positive-absence gate and the §3.4 presence rule for this window; user-
  initiated is consent to run while present).
- **Connect-ask card** (accent, §7.4): **Connect read-only** / **Not now**
  (re-eligibility per §7.4's ring semantics) / `never for this tool` (writes
  `never` verdict, kills all rings).

**Liveness (all needs-you cards)**: every card carries a resolution predicate
re-checked on the relevant events (question answered in-session, permission
granted, worker aborted, probe recovered, condition gone). A card whose
predicate goes false **auto-retracts** with a `resolved` ledger entry — never
an accept/dismiss verdict, so self-resolution cannot pollute acceptance
stats. Card ids are stable across digest regenerations (§9.1): a regeneration
updates the existing card in place (age, counts, carried-forward `open`
verdicts), never re-creates it.

### 10.4 Rails & sections

- **Now**: card grid (min 230px), active sessions only (working/blocked):
  state dot + name + state chip, current step one-liner — sourced per window
  type: chat sessions from progress reports + live SSE status (the status
  poller cannot see chat holder panes), TUI sessions from the status poller —
  project · cost · elapsed. Card click → opens that session. Blocked cards
  say "blocked — question above ↑" and never repeat the question.
- **Just finished**: same card anatomy; latest completed turns (user sessions
  and CTO jobs, D21), most recent first, cap 6, window 24h: name, relative
  time, the cached `one_liner` (§5.2, 2-line clamp), `open →` (session) /
  `review →` (job PR/branch). A gate-failed CTO job (§11.5) renders with a
  `failed` chip and a `logs →` link instead of `review →`.
- **While you were away**: absence duration in the header; 4–7 tier-badged
  items per §5.5; every item's `refs` render as one deep-link; `technical
  detail ▸` expands `deep` inline. Item open/expand events are `open`
  verdicts (feeds importance learning).
- **Tonight**: one muted line "🌙 N tasks queued for tonight (window)" —
  hidden entirely when nothing is queued or High tier is off. Expands
  (opt-in, D15) to the task list (name + category chip) + **Cancel tonight**
  / **Edit plan** (per-task remove toggles + reorder; a manual reorder
  **pins the order for that window and is exempt from the 30-min re-scoring**
  — otherwise the next tick would silently undo it; edits are verdicts) +
  a pointer "budget & forecast in ⚙".

### 10.5 Settings & health page

Four cards (all controls live):

1. **Behavior**: master **Enabled** switch (off = §10.6-5 paused semantics
   minus the banner; passive event ingestion continues, nothing else runs) ·
   **Effort dial** Low/Medium/High (D12; radio cards with plain-language
   scope; switching applies immediately and is ledgered) · **Overnight
   work** switch (gates §11 entirely; only visible/effective at High) ·
   **Push digest to phone** switch (default off; on = §5.5 pre-generated
   digest also notifies) · **Pause everything now** (→ §10.6-5; the same
   control shows **Resume** while paused) · caption stating the hard daily
   cap and its independence from the dial.
2. **Health** (read-only stats, each row live data): ambient spend today /
   cap · last-night job spend / budget · suggestion acceptance 30d · digest
   opens 7d + median open time · pipeline lag (segment close → summary) ·
   probe health per consented tool · cap-hits caused 30d · forecast accuracy
   (MAPE 14d) · the self-reported ROI line + tier recommendation (§12.4).
   Every stat row defines a minimum sample size and renders `collecting
   (n/k)` below it — a stat never displays noise as signal; the ROI row
   renders `collecting — first report <date>` until the first monthly roll.
3. **Tonight's budget**: gauge (used today / planned tonight / reserve line),
   legend, provider-window notes (per configured provider, from §11.2
   adapters), forecast accuracy. Read-only; plan editing lives in §10.4.
   Renders fully only at High with Overnight on; at Low/Medium (overnight
   off) the card shows ambient spend vs cap only — never a gauge for a
   pool that cannot run.
4. **Internals** — four drill-down rows, each a full page:
   - **Blackboard**: facts per project (kind chip, confidence bar, statement,
     refs, sender, age); superseded shown struck-through; per-fact actions:
     `wrong` (supersedes with `sender: "user"`, writes `correct` verdict —
     highest weight), `pin` (resets access clock), archive browser.
   - **Profile & rhythm**: §8.5 surface + the 24h histogram + TZ + journal
     tab (entries listed; per-entry delete).
   - **Activity ledger**: reverse-chron, filterable by actor/type; append-only.
   - **Tool integrations**: registry table (tool, role, engagement, vitality,
     consent rings with per-ring revoke, probe cadence + last result, `never`
     list with un-never), dead-tool candidates flagged.

### 10.6 States (all reachable, all specified)

1. **Resting**: no needs-you items → the section renders a single centered
   "Nothing needs you ✓" line with a one-line context summary. Digest and
   rails render normally below.
2. **Veto window** — §10.3.
3. **Connect ask** — §10.3.
4. **Cold start**: a `learning`-chipped card shows backfill progress
   (segments processed / total, ETA) and the ask-only promise; suggestion
   engine is pinned to ask-verbs until ≥ 15 verdicts exist. Backfill = 30
   days (D19) of transcript history through the §5 pipeline at
   batch-priority; profile fields render "low confidence" until their
   minimums are met. Backfill runs behind a **watermark**: live ingestion
   owns everything after the backfill's start instant, so a backfilled and a
   live segment can never overlap or double-count. Backfill has its own
   one-time spend bound (default $3, batch-routed where available); if the
   bound is hit before 30 days are processed, backfill stops at the depth
   reached and says so on the card — a deep history never surprises the
   first day's bill.
5. **Paused**: kill switch replaces the header with a banner (paused-at time,
   "no probes, no jobs, no analysis; digest data keeps accumulating
   passively") + **Resume**. Engine stops all timers except event ingestion.
   Existing needs-you cards persist frozen (liveness predicates stop being
   re-checked); open veto-window countdowns are abandoned and ledgered, never
   executed on resume (the no-catch-up rule, §11.6).
6. **Thrifty (cap hit)**: quiet warn chip in the header; degradation order
   §12.2; auto-clears at the daily reset.
7. **Health warning**: internals failures surface in ⚙ Health; they escalate
   to a needs-you blocker card only when they block user-facing output (probe
   auth failure degrading the digest, pipeline lag > 30 min, engine rate-limit
   trip). The card's action deep-links to the fix surface (e.g. secrets card).
8. **Week-away digest**: same digest section; items are themes/trends with
   week-detail links (per §5.4 granularity table).

### 10.7 Design tokens

The pane uses the existing token substrate (`src/renderer/tokens.css`)
exclusively; mockup values snapped to it:

| Usage | Token |
|---|---|
| Page/panel/card surfaces | `--canvas` / `--panel` / `--card` / `--inset` |
| Borders | `--border-subtle` (cards), `--border` (buttons); needs-you edges use `color-mix(in srgb, var(--danger|--accent|--warn) 45%, transparent)` — tokens.css defines no `--*-rgb` companions, so `color-mix` over the existing semantic tokens is the only form that adds no tokens |
| Text tiers | `--tx1`..`--tx4` per existing contrast rules |
| State colors & chips | `--ok/--warn/--danger/--info` + `--*-bg` fills |
| Radii | cards `--r-lg`, chips `--r-full`, buttons/options `--r-md` |
| Spacing | 4px grid via `--sp-*`; section gap `--sp-8`; card padding `--sp-4` |
| Type | `--font-size-body/small/xs/2xs`, `--font-sans/mono`, `--weight-medium/semibold` |
| Motion | countdown/toggle transitions `--motion-fast`; card expand `--motion-base`; `--ease-out` |
| Shadows | resting cards flat; popover/drill-down `--shadow-sm` |

**New tokens introduced** (add to `tokens.css` `:root` — they are dimensional
and theme-shared; nothing per-theme is needed):

```
--cto-card-min-w: 230px;   /* Now / Just-finished rail card minimum */
--cto-col-max-w: 960px;    /* pane column */
--need-edge-w: 3px;        /* needs-you card left edge */
--tier-col-w: 76px;        /* digest tier-chip column */
```

No hardcoded hexes anywhere in the implementation; the needs-you edge colors
are the existing semantic tokens. Light theme requires no new values (the new
tokens are dimensional only).

---

## 11. Overnight scheduler

Gated on: High tier + Overnight switch + not paused.

### 11.1 Window

Opens at the start of the profile's quiet trough (§8.2) once a **positive
absence signal** exists: presence `gone` (desktop-confirmed), or — on boxes
with no desktop client (§5.4) — ≥ 60 min of zero user-originated events
inside the trough. Prolonged signal *absence* alone never opens the window.
Closes at trough end or on user return (whichever first). Announced by a
veto-window card 30 min before open (§10.3).

### 11.2 Per-provider budget (D5)

The existing usage adapters (per-provider plan windows) are the source of
truth. Per provider: remaining quota in the current window, window reset time,
and whether a batch/off-peak pool exists (adapter capability flag). The
scheduler plans per provider pool; request-shaped tasks route to batch pools
where the adapter reports one (cheaper, non-competing); agentic tasks draw on
the interactive pool only.

Adapters also expose a `windowed` capability flag. For **windowless
providers** (pure pay-as-you-go: no plan window, no reset, nothing that
"runs out"): the reserve math (§11.3) is disabled — there is nothing to
reserve — and overnight spend is bounded by an absolute $ budget instead
(user-set in Behavior, default $5/night). The forecaster still runs to feed
the Health card, but produces no reserve. A provider with **no adapter at
all** is treated identically to windowless, with spend measured from the
model ledger (token costs) — an unrecognized provider never blocks the
overnight path and never bypasses its $ bound.

### 11.3 Reserve

Forecast tomorrow's own demand per provider: Holt-Winters (damped trend,
weekly seasonality) over a rolling 8 weeks of the box's usage ledger; under
14 days of history, fall back to `reserve = max(observed daily max, 60% of
window)`. Reserve = P95 of forecast demand (newsvendor fractile with
C_u ≫ C_o). `spendable = remaining − reserve`, floored at 0. Every user
cap-hit event raises the fractile one notch (max P99); 30 clean days lower it
one notch (min P90). The fractile initializes at P95; notch adaptation begins
only once the forecaster is active (≥ 14 days) — the pre-forecast fallback is
not a fractile and does not notch. Re-evaluated every 30 min during the
window; a shrinking spendable stops task starts and preempts at boundaries if
already negative.

### 11.4 Task portfolio

Candidates from: accepted decision-card options marked "tonight", suggestion
engine candidates below act thresholds but scoring high on value, data-source
analyses (§7.6), maintenance (hygiene class), watcher-driven investigations.

```
Score = p_use · Value · Confidence · Decay(t) / (λ · PredictedCost)
```

Value ∈ {3,2,1,0.5,0.25}, Confidence ∈ {1.0,0.8,0.5} (coarse on purpose,
model-scored); `Decay` covers staleness (per-category τ) and rising urgency
(untouched-project pressure); λ = shadow price, 0 when spendable is fat,
rising as it thins (so one expensive high-value job can win early, cheap jobs
win near dawn). Hygiene floor: maintenance category is guaranteed 20% of the
night's budget when any maintenance candidate exists. Category
Value·Confidence is blended with Thompson-sampled acceptance posteriors
(two counters per category, from verdicts).

Every candidate class degrades to empty gracefully: a class with no
candidates allocates nothing (the hygiene floor applies only when maintenance
candidates exist; no class is required to be non-empty), and a night with
zero candidates opens no window at all.

### 11.5 Execution contract

Every job: delegate engine (worktree, branch, never protected refs), machine
gates before surfacing (typecheck/tests/lint where the project defines them —
gate set read from project config; a job failing gates is filed as
`failed, logs attached` in the ledger and next digest, never as a needs-you
item), legible logs retained, output = draft artifact (branch/PR/report).
Unreviewed drafts expire: after 7 days a draft is closed with a one-line
digest note (an `expire` verdict).

Two setup-neutral rules: an **empty gate set** (project defines no
typecheck/tests/lint) passes with a `no-gates` note carried on the artifact,
the Just-finished card, and the digest item — review expectations are
calibrated, never silently absent. And overnight **delegate jobs require a
git project** (worktrees are git); non-git projects are read/digest-only
surfaces and never receive file-editing jobs.

### 11.6 Preemption (D4)

This is a scoped **delegate-engine change**, not a config tweak — the engine
today has exactly `running/done/failed/stopped` and a 30-min running sweep:

- **New state `paused`**: `pauseJob(id)` sets a flag the job's session
  observes at its next tool-call boundary (the existing completed-tool-part
  machinery); the session is aborted with the drain-abort pattern; worktree +
  branch kept.
- **Cap accounting**: `paused` releases both the global running cap (5) and
  the CTO sub-cap (2 — tracked by the CTO engine itself, since delegate only
  knows the global cap, §3.3). `resumeJob(id)` re-acquires both like a fresh
  start; if either cap is full the job stays `paused` and retries next
  scheduler tick.
- **Resume context**: a new session in the same worktree with context =
  original prompt + `git log/status` of its own branch + its last progress
  report.
- **Sweeper changes**: `paused` > 7 days → `stopped`. CTO-owned overnight
  jobs (`actor: cto`) get a running-sweep allowance equal to the remaining
  overnight window instead of the flat 30 min — without this the sweep would
  kill any long overnight job. User-started jobs keep the 30-min rule.
- **Restart recovery** (`engine-state.json` contract): on boot the engine
  re-derives the window from trough + presence, reconciles job states against
  the delegate store (a job `running` at crash whose session is gone →
  `paused`, resume-eligible if the window still holds), and re-runs the
  reserve computation before starting anything new.
- **Missed veto windows do not catch up** (same rule as the scheduler's
  no-catch-up): a countdown that elapsed while the box was down is abandoned
  and ledgered, never executed late.

---

## 12. Economics

### 12.1 The dial (D12)

| Tier | Features | Ambient cap (default) |
|---|---|---|
| Low | rollups, digest, blackboard, Now/Just-finished rails, ledger | ~1–2% of plan usage, $/day derived |
| Medium | + suggestions, watchers, profile extraction, tool discovery + probes | ~5% |
| High | + overnight autonomy, veto-window actions | Medium cap + overnight spendable pool |

Hard daily ambient cap (default $2.50, user-editable in Behavior) applies at
every tier, independent of the dial. Overnight spend is bounded separately by
§11.3 and never draws from the ambient cap.

### 12.2 Degradation order (cap hit → thrifty mode)

Shed in order: (1) speculative candidate generation, (2) probe fan-outs
(blocker-relevant probes exempt), (3) profile extraction passes, (4) hourly
rollups (segments still summarized; hours reconstructed next day), keeping to
the last token: blocker detection, segment one-liners, digest-on-open.

### 12.3 Model routing

Task classes with requirements, resolved by the existing model router (never
pinned): `ambient-summarize` (structured output, ≤ 4k ctx) → cheapest
qualifying nano; `gatekeeper`, `worthiness` → nano with logprob-free scoring
rubric; `digest-compose`, `suggest` → mid-class; `overnight-job` → router
default for agents. Context assembly budgets: ambient ≤ 4k tokens, digest ≤
12k, spawn ≤ 8k. Cascade rule: ambient classes escalate one class on
low-confidence output, at most once.

### 12.4 ROI self-report

Monthly ledger roll: total CTO spend vs counted outcomes (accepted
suggestions, merged CTO branches, incidents where a watcher/digest surfaced
the issue before the user hit it) + a tier recommendation. Rendered in Health;
never auto-changes the dial.

---

## 13. Storage, security, supersession

### 13.1 Stores

All under `~/.manta/cto/` via `statePath()` (test-sandbox rule applies):
`inbox.json`, `facts/<project>.json` + `facts-archive/`, `rollups/<level>/`,
`digests/` (last 30 generated digests — the view renders from here, §5.5),
`cards.json` (open needs-you cards + their state — cards survive restart;
resolved/dismissed cards move to the ledger), `profile.json`, `journal.json`,
`tool-registry.json`, `tool-usage.json`,
`probes/*.yaml`, `verdicts.json`, `ledger.jsonl`, `budget.json`,
`engine-state.json`. Atomic writes via the existing jsonStore for JSON
stores; `ledger.jsonl` uses an append-only writer and `probes/*.yaml` the
plugin-style YAML writer — all three resolve paths through `statePath()`, so
the test sandbox covers every store. All 0600. Retention:
ledger + verdicts 180d rolling; rollups: hours 14d, days 120d, weeks 2y;
segments 30d (evidence pointers into opencode's store survive as ids).

### 13.2 Schema versioning (D7)

Every store carries `v`; readers migrate forward on load (pure migration
functions, unit-tested); unknown future versions fail loudly, never silently
truncate.

### 13.3 Security summary

- Probe runner hardening per §7.5. Secrets by reference everywhere; values
  never in contexts, logs, or stores.
- All external content (probe responses, inbox notes, tool data) is untrusted
  data, wrapped as such in every model context.
- The engine's global on/off is a deliberate trust boundary (like plugins /
  forge rules): off = nothing scans, probes, proposes, or spends.
- Kill switch (§10.6-5) is engine-external: a flag file checked by every
  timer tick and job start, so a wedged engine still stops.
- Watchdog: a deterministic monitor outside the engine (index.mjs timer)
  checks engine liveness + ambient spend rate; > 2× expected hourly burn →
  auto-thrifty + health warning; > 4× → auto-pause + blocker card.
- Sensitive profile inferences per §8.5.

### 13.4 Supersession of existing tooling (D2)

Shipped as an explicit migration, not a parallel system:

- `send_to_cto` keeps its tool name and route (`POST /api/cto/inbound`); the
  handler now writes the §4.4 inbox store. Backward compatible: a bare
  `{message}` becomes `kind: "blocker"`, preserving today's urgent
  semantics exactly.
- The watcher poller in the current CTO inbound engine is replaced by the
  §4.3 standing-query engine; existing watches migrate one-time onto its
  store, guarded by a migration marker in `engine-state.json` (idempotent —
  a re-deploy cannot double-migrate).
- The `cto` tool's read belt gains the §4.5 verbs; each ships in the phase
  that ships its store (P1: `read_rollups`, `read_ledger`; P2: `read_facts`
  incl. `asOf`, `read_profile`, `read_toolregistry`, `read_inbox`).

No parallel systems remain after P2.

---

## 14. Instrumentation (v1 schema, not later)

1. **Digest**: generated/opened, per-item open + expand, time-to-open.
2. **Suggestions**: per-verb counts, verdicts, false-alarm rate proxy
   (dismiss-rate), time-to-verdict.
3. **Silence audit** (§9.1): monthly digest aside "I held back N items —
   review?" links to the gated-out list; each reviewed item takes a verdict.
4. **Facts**: proposals by outcome, retrieval rates, overturn times.
5. **Budget**: forecast MAPE, cap-hits caused, reserve fractile history.
6. **Engine health**: pipeline lag, probe error rates, rate-limit trips.

All are ledger-derived; the Health card renders them.

---

## 15. Phasing

- **P1 — read layer**: evidence layer, segmentation + rollups, digest (all
  granularities), Now/Just-finished rails, needs-you blockers, resting state,
  activity ledger, instrumentation, cold-start backfill, master switch +
  kill switch + Low tier caps. Blackboard single-writer (engine only).
- **P2 — judgment layer**: suggestion engine (ask verbs only until verdict
  minimum), collaborative blackboard (`cto_fact`, gatekeeper, sender
  reliability), profile engine + drill-down, tool discovery + connect asks +
  metadata probes, watcher supersession, inbox supersession, Medium tier.
- **P3 — autonomy layer**: quota forecasting + reserve, overnight scheduler +
  portfolio, veto-window verb, trust promotion ladder, deep-read data-source
  analyses, delegate pause/resume, High tier, ROI report.

Each phase ships with its tests (pure logic injected-I/O, per repo
conventions) and its Health rows.
