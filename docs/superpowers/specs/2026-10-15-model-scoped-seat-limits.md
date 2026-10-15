# Model-scoped seat limits — a capped model must not make a seat "full" for every model

## Problem (observed live 2026-10-15)

11 Claude seats. 8 of them had **0%** of their 5-hour window used but **100%**
of the model-scoped weekly window "7d · Fable". The other 3 were at 100% of
their 5h window. Five Opus 5.5 / Sonnet 5.5 conversations on one of the 5h-full
seats were stuck in opencode's rate-limit retry, and the seat logic never moved
them: every seat read as full.

Cause: the Claude usage adapter sets `exhausted: true` whenever ANY active
window is at 100% — including a model-scoped weekly. Anthropic reports such a
window as `is_active: true` even on a seat whose conversations are not on that
model. `isSeatFull` / `seatLoad` / `leastLoadedSeat` then treat the seat as
full for every model, so `decideMove` finds no candidate and the retry watch
never wakes the conversation ("N retrying, 0 woken" forever).

## Rule

A **model-scoped window** (a window with a `scope`, kind `weekly_scoped:<name>`)
limits **only requests for that model**. Unscoped windows (5h session, account
weekly) limit everything, exactly as today.

- A scoped window **applies** to a model when the scope name, lowercased with
  non-alphanumerics removed, appears as a token inside the model id (`"Fable"`
  ↔ `claude-fable-5`, `claude-fable-5-1`; `"Opus"` ↔ `claude-opus-5-5`). Match
  on hyphen/dot-separated tokens of the model id, not a raw substring.
- **Model unknown → scoped windows do not apply.** The reactive path (a 429 →
  `markLimited` → seat full for 5 min → move) still covers a conversation on the
  capped model that lands on such a seat.

## Contract

### `src/shared/seatChoice.mjs`
- New `windowAppliesToModel(w, model)` — `model` is a model id string or
  null/undefined. Unscoped → true. Scoped → true only when the model matches.
- `seatLoad(snap, { model } = {})`, `seatLoadWindow(snap, { model } = {})`,
  `leastLoadedSeat(snaps, { activeSeatId, model })`: windows that do not apply
  to `model` are skipped (in addition to inactive/stale, as today). Default
  (no model) ignores scoped windows. All existing callers without a model keep
  working.
- `isSeatExhausted` unchanged (reads the provider flag).

### `src/server/usageAdapters/claude.mjs`
- `exhausted` is computed from **unscoped** windows only. A seat whose only
  full window is a model scope is not exhausted — it can serve other models.
  (Codex/Kimi adapters unchanged.) The scoped window stays in `windows` so the
  UI still shows it.

### `src/server/seatAssignment.mjs`
- `isSeatFull(snap, { model } = {})` = exhausted flag OR `seatLoad(snap,{model}) >= 100`.
- `chooseSeat`, `decideMove`, `decideSeat` accept `model` and thread it to every
  load/full/least-loaded call.
- The assignment record gains optional `model` (string, ≤200 chars) = the model
  of the conversation's most recent request. `normalizeAssignments` keeps it.
  It is written when it changes (not on every request).
- `resolve(provider, sessionID, parentSessionID, { model } = {})`: uses the
  request's model for the decision and records it on the conversation.
- `reconsider` and `conversationSeatFull` use the conversation's stored
  `model` (null if none).
- Any other server-side mover/poller that calls these must pass the stored
  model too.

### `/api/accounts/resolve` and `/api/accounts/limit` (`accountsRoute.mjs`)
- Accept optional `model` (query param on resolve, same place the other ids
  travel on limit). Validate: string, 1–200 chars, `[A-Za-z0-9._:/-]` only;
  otherwise ignore it (treat as unknown — never 400 on it, an old/odd plugin
  must keep working).

### Plugin `docs/opencode-plugins/manta-accounts.ts`
- Read `model` from the intercepted request's JSON body (top-level `model`
  string) when the body is a string; send it to resolve and limit. Any parse
  failure → no model. Never alter the body.

## Out of scope
- Renderer seat hints (they keep calling without a model → scoped ignored).
- Changing the usage stopper / routing semantics beyond the adapter's
  `exhausted` flag.

## Done
- Unit tests: scoped-only-full seat is a move target for an Opus conversation
  and not for a Fable one; unknown model ignores scope; adapter `exhausted`
  false when only a scoped window is at 100%; stored model round-trips;
  route ignores a malformed model.
- `npm run typecheck && npm test` green.
