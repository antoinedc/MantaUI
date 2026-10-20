# Optimizer: sticky trims (fix the cache-busting masker)

Status: draft for review · Branch: `feat/optimizer-sticky-trims` · Date: 2026-10-20

## 1. Problem (measured)

The masking half of the optimizer replaces old tool outputs with a placeholder
before each model request. On the dev box it was costing more than it saved.
Evidence from opencode's own message ledger, 2026-10-17 09:00–13:00 UTC:

- 985 assistant requests; **145 (15%) re-cached their entire history**
  (cache read ≤ the system prefix, cache write > 100k), carrying **41.9M of the
  43.9M cache-write tokens (95%)**.
- Busiest sub-agent (`ses_eb7419…`): requests alternate between an ~800k
  unmasked history (read from cache) and a ~280k masked one (re-written in full
  almost every time, e.g. `273k write → 272k write → 803k read → 273k write`).

Three defects produce this. All three are in BOTH plugin copies
(`docs/opencode-plugins/manta-optimizer.ts` — V1, installed on boxes today — and
`docs/opencode-plugins-v2/manta-optimizer/` — the V2 twin), plus the shared pure
copy `src/shared/maskPlan.mjs`.

- **D1 — one policy slot for the whole process.** The policy cache holds one
  session. Parallel sessions evict each other; a cache miss returns
  `DEFAULT_POLICY` (`enabled:false`), so a session's requests alternate between
  masked and unmasked → the prefix flips → full re-cache on every flip.
- **D2 — masks are not sticky.** The mask is recomputed from scratch per
  request. Every new tool call pushes one more old output past the
  `maskAfterUses` / `protectTailTokens` line, so the masked history differs
  from the previous request's at an early position → it is never a cache hit.
  `decideApply` only checks "reclaimable ≥ batchTokens", which stays true on
  every request once crossed, so it does not batch anything.
- **D3 — the re-warm counter is fiction.** `rewarmTokens` is reported on every
  request (applied or not, changed or not) as "the tail after the deepest mask
  point". It is neither measured nor tied to an actual prefix change. Savings
  shown on the dashboard are therefore unreliable in both directions.

Minor, fixed in passing: the plugins never pass `directory` to
`/api/optimizer/policy`, so the per-repo tuner table is never applied.

## 2. Goal / non-goals

Goal: keep trimming, but only in a way that pays: a trimmed history must stay
byte-identical across requests until the next deliberate, profitable trim.

Non-goals: changing what counts as eligible (tail/recency/skill rules stay);
per-provider pricing in the plugin; compaction, pacing, routing, tuner logic
(beyond receiving `directory`); cleaning up leftover `*.tmp-*` files in
`~/.manta/` (separate ticket).

## 3. Design

### 3.1 Per-session policy (fixes D1)

- The policy client keeps a `Map<sessionID, {policy, at, authoritative}>`
  (cap 512 entries, LRU-evict). Fresh (< `POLICY_CACHE_MS`) → use; stale → use
  + background refresh. Unchanged: never awaits the network on the hot path.
- Cold session (no entry): use a **provisional** policy = the most recently
  fetched policy for ANY session (the `enabled` flag is global), else
  `DEFAULT_POLICY`; fire a refresh. Provisional policies are flagged
  `authoritative:false`.
- Refresh calls pass `directory` (V1: the session's directory from the first
  message's info / `input`; V2: from `ctx.session.get`, cached per session).

### 3.2 Sticky trim set (fixes D2)

Per session the plugin owns a **trim set**: the ids of tool outputs currently
replaced by a placeholder.

- **Identity:** the tool-call id (V1: `part.callID`, falling back to `part.id`;
  V2 lowered: `tool-result.id`; V2 timeline: `part.id`/`callID`). A part with
  no id is never trimmed.
- **Replay (every request, unconditional):** every part in the history whose
  id is in the trim set is replaced with its placeholder. Placeholder text is a
  pure function of `(tool, input, placeholderFormat)`, so replay is
  byte-identical. Ids no longer present (compaction, revert) are dropped from
  the set.
- **Change rule — the invariant:** the trim set may only GROW or be CLEARED on
  a request whose policy is **authoritative** (fetched for this session).
  Provisional/default policies replay only. This makes a cold start, an
  opencode restart, or a slow policy route unable to cause a flip.
- **Growth** (authoritative, `enabled:true`): candidates = currently eligible
  parts (existing scan rules) not already in the set. Add ALL of them at once,
  only if the gate in 3.3 passes. Otherwise add none — the history stays
  identical to the previous request.
- **Clear** (authoritative, `enabled:false`, set non-empty): clear the set.
  This costs one re-cache per conversation and is the user's explicit choice.
- **Persistence:** the plugin reads/writes the set itself, on the same box —
  `<stateHome>/.manta/optimizer-trims/<sessionID>.json`
  (`{version:1, ids:string[], shadowIds:string[], updatedAt}`), where
  `stateHome` honours `MANTA_STATE_HOME` like the server. Cold load is a
  synchronous `readFileSync` the first time a session is seen in a process
  (one small file — acceptable on the hot path; no network). Writes are
  async, atomic (temp + rename, temp removed on failure), only when the set
  changes. Unreadable/corrupt file → treat as empty and log once.
  Files untouched for 7 days are pruned by the plugin, at most once per hour.
  sessionID is validated against `^[A-Za-z0-9_-]{1,128}$` before use in a path.

### 3.3 Profitability gate (keeps D2 fixed)

Inputs per request: `R` = estimated tokens the candidates would remove;
`T` = estimated tokens from the earliest candidate to the end of the
post-trim history (what gets re-cached); `N` = expected further requests in
this session; `k` = cache-write ÷ cache-read price ratio.

- **Cache already dead** (time since this session's last activity >
  `cacheTtlMs`): grow if `R ≥ batchTokens` (re-cache is happening anyway).
- **Cache live:** grow only if `R ≥ chunkTokens` **and**
  `N ≥ margin × T × (k − 1) / R`.
- `N` = number of model requests this session has made so far (from the
  history's assistant turns), capped at 200 — a session that has run long is
  expected to run about as long again. Young sub-agents therefore rarely
  qualify unless their cache is dead.
- `k` comes from the policy (server-resolved): `12.5` when `cacheTtlMs ≤ 5 min`,
  `20` otherwise (Anthropic 1.25× / 2× write vs 0.1× read).
- New policy fields (pinned below): `chunkTokens` (default 100 000), `margin`
  (default 1.5), `rewriteCostRatio` (`k`).
- Worked example (the sub-agent above): `R≈520k`, `T≈280k`, `k=12.5` →
  break-even `N≈6.2`; with margin 1.5 needs `N ≥ 9.3`. It had ~50 requests →
  trims once, then reads the 280k history from cache for every later request.

### 3.4 Observe mode

With `enabled:false` the plugin runs the same state machine on `shadowIds`
(never applied to the request) so the dashboard's "potential" line reflects
what the sticky optimizer would really have done. Turning the switch ON starts
the real set empty (the shadow is not adopted — adopting it would itself be a
trim that skipped the gate).

### 3.5 Honest counting (fixes D3)

One report per request when either set is non-empty or changed:

- `trimmedTokens` — tokens currently replaced in THIS request (real set in
  act mode, shadow in observe). Each is a token not sent → savings token-turns.
- `changed` — whether the set grew this request.
- `rewarmTokens` — `T` when `changed && cache live`, else `0`. Never reported
  on an unchanged request.

Server: counterfactual store bumps to **v3**; v2 hour/day buckets are dropped
on load (same precedent as v1→v2: mixing two meanings is worse than a gap);
sessions map kept. Savings = `trimmed × readRate − rewarm × (writeRate − readRate)`
via the existing `savedUsd`, never clamped — the card shows a loss as a loss.
The card's copy changes from "re-warm" guesses to "re-cache cost" and shows net.

## 4. Pinned contracts

**C1 — policy route** `GET /api/optimizer/policy?sessionID=&directory=` adds:
```
chunkTokens: number      // default 100000
margin: number           // default 1.5
rewriteCostRatio: number // 12.5 if cacheTtlMs <= 300000 else 20
```
Defined in `src/shared/optimizerPolicy.mjs` `DEFAULT_POLICY` / `resolvePolicy`.

**C2 — counterfactual report** `POST /api/optimizer/counterfactual`:
```
{ sessionID, ts, mode: "act"|"observe",
  trimmedTokens: number>=0, trimmedParts: number>=0,
  changed: boolean, rewarmTokens: number>=0,
  providerID?, modelID? }
```
`maskedTokens`/`maskedParts`/`applied` are removed. The validator rejects
`rewarmTokens > 0` with `changed:false`. Bucket fields become
`trimmedTokens`, `appliedTokens` (act-mode trimmed), `rewarmTokens`,
`byModel`, `reports`.

**C3 — trim file** as in 3.2. Owned by the plugin; the server never writes it.

**C4 — shared logic.** `src/shared/maskPlan.mjs` is the tested source of truth
for: candidate scan, `planTrims({messages, policy, trimSet, now, lastActivityMs, authoritative})
→ {replay[], add[], clear, R, T, N, cacheDead, rewarmTokens}`, and the gate.
Both plugins inline/port it verbatim (they cannot import the repo). Today the
shared copy has already drifted from V1 (no `maxTailAtMask`); after this change
a test asserts the V1 plugin and `maskPlan.mjs` produce identical plans on a
fixture set (V2 has its own tests already, extend them with the same fixtures).

## 5. Ownership for implementation

- **A — plugins + shared logic:** `src/shared/maskPlan.mjs` (+ `.d.mts`, tests),
  `docs/opencode-plugins/manta-optimizer.ts` (+ test),
  `docs/opencode-plugins-v2/manta-optimizer/**`, `scripts/opencode-v2/optimizer.test.mjs`.
- **B — server + UI:** `src/shared/optimizerPolicy.mjs` (+ test),
  `src/server/optimizer/{counterfactual,series}.mjs` (+ tests),
  `src/shared/optimizerSavings.mjs`, `src/server/index.mjs` (policy/counterfactual
  routes only), `src/renderer/OptimizerCard.tsx` (+ test).
- Neither touches the other's paths. Both code against §4.

## 6. Tests (must exist)

- Per-session policy: interleaved sessions A,B,A,B never yield a default
  policy for a session that already has an authoritative one.
- Provisional policy never grows or clears a set; restart (empty map, file on
  disk) replays the same ids → byte-identical history.
- Sticky: 30 synthetic requests, each adding one tool call; with gate failing
  the trimmed history is identical request-to-request; when the gate passes it
  changes exactly once.
- Gate math incl. the worked example; dead-cache path; young sub-agent rejected.
- Clear on authoritative off; shadow never mutates the request.
- Report: unchanged request → `rewarmTokens:0`; validator rejects the bad combo.
- Store v3 drops v2 buckets; `savedUsd` goes negative when rewarm dominates.
- sessionID path validation rejects `../x`.

## 7. Acceptance after merge (manual, on the dev box)

Turn the switch on for one working day, then query the ledger for the same
window shape as §1: full-history re-caches must fall to near the pre-optimizer
baseline (sessions' first request + cache expiries), and the card's net savings
must be positive and roughly agree with ledger-derived read savings. If not,
switch off and revisit `chunkTokens`/`margin`.

## 8. Rollout

Ships with the next server release (plugins are synced by self-update).
The switch stays off on the dev box until §7 is run.
