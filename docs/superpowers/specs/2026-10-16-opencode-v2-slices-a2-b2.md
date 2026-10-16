# OpenCode V2 — slices A2 (renderer onto frames) and B2 (auth, seats, optimizer plugins)

Parent plan: `docs/opencode-v2/MIGRATION-MASTER-PLAN.md`. Previous slices: A (#1587, frame
vocabulary + V1 corpus), B (#1588, `manta` V2 tool plugin + harness). Disjoint ownership;
both run in parallel. Neither changes anything users can see.

---

## Slice A2 — desktop renderer consumes only interpreted frames

### Goal
The desktop renderer stops subscribing to raw `{kind:"opencode"}` events. Every behaviour
those handlers drive today is driven by the `stream` frames instead (vocabulary pinned in
`docs/superpowers/specs/2026-10-16-opencode-v2-phase1-frames-phase3-plugins.md` and
`src/shared/types.ts` `StreamEnvelope`). Visible behaviour is identical on V1.

### Owned paths
`src/renderer/**` (mainly `hooks/useSseBus.ts`, `App.tsx`, `api/httpApi.ts`,
`chatUtils.ts`, their tests), plus `src/server/streamInterp.mjs` + its tests and golden
frames **only** for the two server additions below. Must NOT touch `mobile/**`,
`docs/opencode-plugins-v2/**`, `scripts/opencode-v2/**`.

### Mapping (pinned)
| Today (raw event → handler) | After (frame) |
|---|---|
| `App.tsx` `session.created` → setSessionParent | `childSession` |
| `App.tsx` idle/error/status → setChatRunning | `running` + `runningSet` (already subscribed) |
| `App.tsx` question/permission asked/replied → setChatAttention | `attention` |
| `useSseBus` child-session part/message events → scheduleChildRefetch | `messageChanged` for a child session id; **plus** `flush` frames for that child (deltas) so an expanded subagent card still streams text |
| `useSseBus` child `session.idle`/`session.status` → liveChildStatus | `running` / `turnComplete` for the child id |
| `useSseBus` `session.status` retry → retry banner | `retry` (null clears) |
| `useSseBus` `session.error` → drain-abort suppression, auth banner, typed messages | `sessionError` (`name` is raw) |
| `useSseBus` `session.next.step.ended` → stepTokens + drain | `stepEnded` |
| `useSseBus` plan mode | `planMode` |
| `useSseBus` `session.next.compaction.*` | `compaction` |
| `useSseBus` `vcs.branch.updated` | dropped (branch is polled; opencode's event is unreliable — AGENTS.md `/vcs`) |
| `useSseBus` `command.executed` | `commandExecuted` |
| `useSseBus` `message.part.updated`/`message.updated` → spliceMessage | `messageChanged` (keep the per-message max-wait guard) |
| `useSseBus` tool part terminal → queued-prompt drain | `toolBoundary` |
| `useSseBus` `session.compacted` | `transcriptStale` |
| `useSseBus` `server.connected` | unchanged — synthesised by `httpApi` on reconnect, not an opencode event |
| `useSseBus` `permission.asked/replied` → refreshPermissions | `permissions` frame (use its list directly) |

### Server additions (only these)
1. **`stepEnded` from the step-finish part.** The deployed V1 build never emits
   `session.next.step.ended`. When a `message.part.updated` carries a part with
   `type === "step-finish"`, emit `stepEnded` from its `tokens`/`cost`/`reason`
   (`finish` = `reason`), once per part id. Keep the existing `session.next.step.ended`
   path; de-dup so a build emitting both produces one frame per step.
2. **`attention` in the connect-time snapshot.** `snapshotState()` replays one `attention`
   frame per session with a pending question/permission, so a reconnecting sidebar shows
   the badge.
Regenerate golden frames (`UPDATE_GOLDEN=1`) and review the diff: only additions.

### Rules
- Keep every AGENTS.md-documented invariant: queued drain ordering (setInput sync,
  submit deferred), drain-abort suppression via `isDrainAbortError`, the follow/pin-to-
  bottom rules, memoized transcript rows, live tool output via splice max-wait.
- After the change `grep -n 'onOpencodeEvent' src/renderer` must show no subscriber
  (the API method may stay for now; mark it deprecated in a comment).
- `demoApi.ts` must emit equivalent frames so demo mode still animates.

### Done
`npm run typecheck`, `npm test` green (update the renderer tests that fed raw events to
feed frames instead — same assertions). Manual regression in the dev desktop is done by
the reviewer; the implementer lists exactly which behaviours its tests now cover.

---

## Slice B2 — `manta-claude-max`, seats, optimizer as V2 plugins

### Goal
V2 twins of the remaining opencode plugins, proven on the pinned V2 binary, including real
Claude Max subscription turns. Nothing installs them yet (Phase 4).

### Owned paths
`docs/opencode-plugins-v2/manta-claude-max/**`, `docs/opencode-plugins-v2/manta-optimizer/**`,
`scripts/opencode-v2/**` (extend the harness), `package.json` (scripts only). Must NOT touch
`docs/opencode-plugins/**` (V1), `docs/opencode-plugins-v2/manta/**`, `src/**`.

### `manta-claude-max` (auth + seats in ONE plugin)
Start from `docs/opencode-v2/spikes/p1/manta-claude-max.ts` and the V1 sources
(`opencode-claude-auth@2.2.1` via `npm pack`, `docs/opencode-plugins/manta-accounts.ts`).
Must implement every mechanism M1–M7 and fix risks R1, R2, R4 from `p1/FINDINGS.md`:
- **M1/R4:** make the anthropic provider usable with no API key through
  `ctx.provider.transform` (not a config `apiKey:""` side-channel), if V2 allows; else
  document why not.
- **Credentials & seats:** per request, resolve the seat exactly as `manta-accounts.ts`
  does today — `GET /api/accounts/resolve` on manta-server (same params, 1.5 s timeout,
  30 s cache, 500-entry cap), credential file must be under
  `<state>/.manta-secrets/accounts/`; no seat → the single login
  (`~/.claude/.credentials.json`). Selection keys on the request's session id (V2
  `http.request` event `sessionID`) and the parent session id.
- **Refresh:** never in the plugin. Near expiry (60 s) or 401 → `POST /api/accounts/refresh`
  (30 s), re-read, retry once. 429 → `POST /api/accounts/limit`, retry once if the seat
  moved. Fail open everywhere, exactly like V1.
- **Version claim:** `ANTHROPIC_CLI_VERSION` env, fallback constant.
- **R1:** response un-prefixing of tool names buffered to SSE event boundaries (no regex
  over arbitrary chunk splits). **R2:** clone the body once, rebuild the Request.
- Codex seat rewrite (`chatgpt.com/backend-api/codex/*`, `ChatGPT-Account-Id`,
  residency header) is part of V1 `manta-accounts`: include it in the same plugin for the
  `openai` provider, behind the same resolve call.
- Tokens are never logged (sha12 at most).

### `manta-optimizer`
Port `docs/opencode-plugins/manta-optimizer.ts`: `experimental.chat.messages.transform` →
`ctx.session.hook("context")` editing `event.messages`; `experimental.session.compacting` →
`ctx.session.hook("compaction")`. Same manta-server routes, same caching, same fail-open,
same counterfactual report payload. Map the V2 message shape (typed timeline, `content[]`,
tool `state.completed.content`) for the mask; unit-test the mask on V2-shaped fixtures.

### Harness proof
- Unit tests in `npm test` (node:test under `scripts/opencode-v2/`): body/header
  transforms, SSE un-prefix across arbitrary chunk splits (property test), seat resolve
  cache/timeouts/fail-open with a fake server, optimizer mask on V2 fixtures.
- Live e2e `npm run test:opencode-v2:max` (opt-in, NOT in `npm test`):
  - **Credential safety (mandatory):** builds a sandbox credentials file from
    `~/.claude/.credentials.json` containing ONLY `accessToken` + `expiresAt` (+
    `subscriptionType`, `scopes`), **never the refresh token**, mode 0600, inside the
    sandbox temp dir; aborts if the token expires within 20 min; deletes it on exit
    (including on failure/SIGINT). The fake manta-server answers `/api/accounts/refresh`
    with an error (the plugin must never be able to rotate a real token).
  - Proves: plugin loads; a Haiku and an Opus turn succeed on the subscription with no API
    key; a stale `ANTHROPIC_CLI_VERSION` (2.1.100) yields the gating error; a tool
    round-trip (shell) works through the prefix/un-prefix; two sessions resolved to two
    seats — if a second real seat exists in `<state>/.manta-secrets/accounts/`, copy its
    access token the same way; otherwise prove per-session selection with the same token
    under two seat files and say so.
  - Optimizer: one turn with the fake policy `enabled:true` shows a masked tool output in
    the request (assert via the `http.request` body) and a counterfactual report at the
    fake server.

### Done
`npm run typecheck`, `npm test` green; both live e2es green with pasted summaries; sandbox
credential copies verified deleted; live box untouched (`systemctl --user is-active
opencode-serve`).
