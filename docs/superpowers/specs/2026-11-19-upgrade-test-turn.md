# Upgrade test turn: report the real reason, don't block on the Claude account

Status: agreed 2026-11-19. Scope: box server only (`src/server/`). No client change.

## Problem

A user's V1 → V2 upgrade stopped at "Verifying the upgrade" with
"The test turn failed: the model returned no text", offering only "Check again".

- The verify step sends one tiny prompt through the Claude login (`tinyTurn` in
  `src/server/opencodeUpgradeCalls.mjs`) whenever `~/.claude/.credentials.json` exists.
- OpenCode V2 does not fail the HTTP calls when a turn fails. The turn ends and the
  timeline carries the reason. Measured on 2.0.30 (dev box, 2026-11-19):
  - success: an `assistant` message with `content: [{type:"text", text:"ok"}]`, then
    `{type:"idle", outcome:"succeeded"}`.
  - failure (unknown model): NO assistant message, then
    `{type:"idle", outcome:"failed", error:{type:"provider.no-route", message:"Model unavailable: anthropic/claude-nonexistent-9"}}`.
  - an `assistant` message may itself carry `error: {type, message, status?}` (the shape
    `errorFromV2` in `src/shared/opencodeV2.mjs` already reads).
- `tinyTurn` only checks "is there assistant text", so every in-turn failure reads
  "the model returned no text" and the real reason is lost.
- A verify failure offers only "Check again" (no rollback, `upgradeView.mjs`). When the
  cause is the user's Claude account (expired sign-in, usage limit, model not on the
  plan), "Check again" fails forever and the gate never goes away, although the
  migration itself already succeeded (plugins active, conversation count checked).

## Behaviour

### 1. `tinyTurn` returns a classified outcome

`tinyTurn()` resolves to one of:

| Outcome | When |
|---|---|
| `{ ok: true }` | an assistant message has non-empty text |
| `{ ok: false, kind: "turn", error, errorType?, status? }` | the turn ran to its end (create, prompt, wait and list all succeeded) without text. `error`/`errorType`/`status` come from the `idle` message's `error` (outcome `failed`), else the newest assistant message's `error`; with neither, `error` = `"the model returned no text"` |
| `{ ok: false, kind: "api", error }` | any of the four OpenCode calls threw (non-2xx, timeout, connection) — unchanged message format |

The session is still deleted in `finally`.

### 2. Verify blocks only on `api` failures

In `verify()` (`src/server/upgradeV2.mjs`):

- `ok` → pass, as today.
- `kind: "api"` → unchanged: `UpgradeError("The test turn failed: <error>", {retryable:true})`.
  OpenCode itself is misbehaving, which is an upgrade problem.
- `kind: "turn"` (or a result with no `kind`, for safety) → the step PASSES. OpenCode
  ran a full turn, so the upgrade works; what failed is the Claude account. Record
  `state.warning = { step: "verify", message: <plain sentence>, detail: <raw error ≤ 300 chars> }`
  and log `[upgrade] test turn did not answer (not blocking): <raw>`.

Plain sentence (`describeTestTurnFailure(result)`, exported, pure):

| Signal | Sentence |
|---|---|
| `errorType === "provider.auth"` or `status` 401/403 | "The upgrade finished, but Claude rejected this box's sign-in. Sign in to Claude again in Settings." |
| `status === 429` | "The upgrade finished, but Claude's usage limit has been reached. Claude will answer again once the limit resets." |
| `errorType === "provider.no-route"` | "The upgrade finished, but the Claude model used for the check isn't available on this account." |
| anything else | "The upgrade finished, but Claude didn't answer a test message (<raw error, ≤ 200 chars>)." |

### 3. The warning reaches the user

- `status()` includes `warning: { step, message } | null` (additive field; clients that
  don't know it ignore it — the desktop and iOS decoders tolerate unknown keys).
- When the run reaches `completed` with a warning, send ONE notification through the
  existing router: a new optional dep `notify(args)` wired in `index.mjs` to
  `push.fireNotify({ title: "Upgrade finished", message: warning.message, tag: "upgrade-warning" })`,
  awaited with errors caught and logged (never fails the upgrade). Not urgent.
- `state.warning` is cleared when a run starts (`runFromFirstPending`) so a retry that
  passes cleanly doesn't keep a stale warning. It persists in the state file.

### 4. Boxes already stuck at this step recover on update

In `boot()`: if `state.state === "failed"`, `state.error.step === "verify"` and the
message starts with `"The test turn failed: the model returned no text"`, log
`[upgrade] retrying a verify failure the new rules no longer block on` and run the same
path as `retry()`. Any other failed state stays as it is.

## Out of scope

- No renderer / iOS change; the warning is surfaced by notification.
- Which model the check uses (still `claude-haiku-4-5`).
- `hasClaudeLogin` is unchanged (file existence).

## Tests (node:test, pure / injected)

- `opencodeClient.test.mjs` (tinyTurn): success; idle `outcome:"failed"` with error →
  `kind:"turn"` carrying `error`/`errorType`; assistant-message error; no text and no
  error → `kind:"turn"`, "the model returned no text"; a non-2xx on create → `kind:"api"`
  with the existing message (keep the existing 500 assertion passing); session always deleted.
- `upgradeV2.test.mjs`: `kind:"turn"` → completed, `status().warning.message` set,
  notify called once with that message; `kind:"api"` → failed, retryable, message as before;
  a retry clears the warning; boot auto-retries the legacy "no text" verify failure and
  completes; boot leaves other failed states alone; a throwing `notify` doesn't fail the run.
- `describeTestTurnFailure` rows above.

## Libraries considered

| Need | Chosen | Considered / why |
|---|---|---|
| Classify a provider error into a sentence | own ~20-line pure function | No library maps OpenCode V2 error types; the inputs are OpenCode's own `{type,status,message}`. Trivially small. |
| Deliver the warning | existing `push.fireNotify` router | A new UI surface would need desktop + iOS changes for a one-off message. |
| Read the turn's outcome | existing typed client (`createOcClient`) | Already used by these calls. |
