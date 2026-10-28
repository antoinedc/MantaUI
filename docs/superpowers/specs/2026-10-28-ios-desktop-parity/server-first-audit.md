# Server-first audit (authority for D23)

Status: draft · Date: 2026-10-28 · Branch: `feat/ios-desktop-parity`

## Purpose and method

D23 makes the box server the only owner of logic. This audit lists every piece of
**non-presentational** logic that exists in both clients today, exists in iOS as
a port of desktop logic, or is planned as a port in an unbuilt spec (02, 05, 06,
07, 09). For each piece it says whether it moves to the server now, later, or
stays in the client, and why.

Sources read: `00-master.md` (D23), specs 01–10, the desktop renderer
(`src/renderer/**`, mostly `chatUtils.ts`, `toolActivity.ts`, `artifacts.ts`,
`usageEscalation.ts`, `usageResume.ts`, `inboxState.ts`, `chatShared.tsx`,
`upgradeGateLogic.ts`), `src/shared/**`, the server (`src/server/**`), and the
iOS app as built after wave A (WS01, WS03, WS04, WS10; WS08 in progress) plus the
iOS ports that predate this effort (`ArtifactDerivation`, `PlanDerivation`,
`ChatModel`, `AccountsSelectors`, `InboxModels`, …).

### What counts as client-side (KEEP-CLIENT)

D23 lets clients keep view state, gestures, device preferences, purely
presentational layout or formatting, and optimistic UI. Applied here, that means:

- **Runs on every keystroke** (typeahead filtering, fuzzy session switcher, artifact
  and inbox filters, slug previews) — a round trip per key adds lag for no gain.
  The server still validates on write.
- **Runs on every streamed frame or scroll** (live delta merging, transcript
  windowing/row stabilisation, follow-to-bottom).
- **Formatting tied to the device clock or locale** (relative ages, "resets in
  2h", day groups, token/duration strings, chart axes).
- **Device-local state** (theme, history, pins, recents, session view mode,
  "dismissed" flags, notice timers).
- **Logic that has to work without a box** (pairing payload parsing, reconnect
  and backoff, the update-apply "box restarted mid-call" check).

**Copy that must match.** D23 moves "copy that must match across clients" to the
server. This audit reads that as: **text whose content depends on a rule** —
error explanations, reasons, pressure/expiry verdicts, generated prompts — moves.
**Fixed labels and plurals** stay in the client.

### Legend

- **Server today**: yes / partial / no.
- **Effort**: S ≤ ½ day, M ≈ 1–3 days, L > 3 days. Covers the server module, node
  tests, desktop switch-over and iOS switch-over.
- **Rec**: **MN** = MOVE-NOW (into an unbuilt spec or WS11) · **ML** = MOVE-LATER
  (follow-up ticket) · **KC** = KEEP-CLIENT.
- File refs are `file:line` at the worktree HEAD (`cc54b741`).
  `cu` = `src/renderer/chatUtils.ts`, `si` = `src/shared/streamInterpretation.mjs`.

---

## 1. Inventory

### WS01 — Transcript (built on iOS)

| ID | Logic | Desktop | iOS | Server today | Proposed server home / shape | Clients | Eff | Risk / notes | Rec |
|---|---|---|---|---|---|---|---|---|---|
| T1 | Per-tool-part activity descriptor (kind, verb, present/past/failed label, target, detail, status normalisation) | `toolActivity.ts:84,257` | `ToolActivity.swift:84,229,365,431`; parity fixture `src/shared/fixtures/tool-activity-cases.json` | no | `src/server/transcriptView.mjs` `describeToolPart(part)`. Attach as `part.view.activity` on `opencode:messages` when called with opt-in `{view:true}`, and as `activity` on streamInterp tool frames | desktop + iOS | M | Computed once when the part is emitted, so there is no per-frame client cost. Adds about 150 B per part. Additive opt-in, so K2-safe. Retires the fixture and the vitest/XCTest parity pair | **MN** |
| T2 | Tool-run summary + tone ("Read 3 files, edited 2", failed/ok) | `toolActivity.ts:285,326`; `ToolGroup.tsx:32,75`, `Transcript.tsx:299` | `ToolActivity.swift:323,559`; `ActivitySheet.swift:34` | no | `transcriptView.summarizeRun(parts)`. Canonical transcript: `view.runs[] {id, partIds, summary, tone}`. Live: a streamInterp `toolRun` frame, re-emitted on every tool state change in the open run | desktop + iOS | M | Run boundaries move while streaming. The server must re-emit the open run's summary on each tool update (a few per second at most). Run ids must be deterministic from the first part id (iOS row-identity rule §6) | **MN** |
| T3a | Message/part visibility classification (hidden parts, background-job completion turns, renderable messages) | `cu:1925,1947,1964` | `ToolActivity.swift:651,672` | no | `view.hidden` flags on parts/messages in the T1 annotation | desktop + iOS | S | Low value until T1/T2 land. Depends on them | ML |
| T3b | Layout + row stabilisation, visible-row location, virtualization ids | `toolActivity.ts:362,428,464,504` | `ToolActivity.swift:688`, `ChatModels.swift:219` | — | — | — | — | Bound to rendering and scrolling. iOS row identity is a crash-avoidance contract | KC |
| T4 | Turn footer: duration, tokens, background-result turns, which turns get a footer | `cu:3093,3170`; `ChatPanel.tsx:2639`, `Transcript.tsx:662`, `CtoChat.tsx:885` | `TranscriptTurns.swift:100,108,152,241` | no | `transcriptView.turnInfo(messages)` → `view.turns[lastAssistantMessageId] = {durationMs, tokens{input,output,cacheRead,cacheWrite}, truncation?, running}`. The live turn comes from the box's own step state | desktop (incl. CtoChat) + iOS | M | Footer must not appear while running (server sets `running`). Desktop CtoChat must switch too, otherwise two implementations remain | **MN** |
| T5 | Finish → truncation kind + label/hint on reload | `si:53,76` (client-run on transcript) | `TranscriptTurns.swift:26,37,62` | partial — live frame only (`streamInterp.mjs:887-891`) | Folded into T4 `turn.truncation {kind,label,hint}` | desktop + iOS | S | Needs D22 (step-finish kept in slim fetch), which is already done | **MN** |
| T6 | Duration/token string formatting | `cu:219,460,478` | `TranscriptTurns.swift:164,177`, `ToolActivity.swift:37`, `UsageMeters.swift:146` (+ planned `ChatCardTokens.desktopCompact`, `ModelsFormat.tokens`) | — | — | — | — | Presentational. Separate client hygiene item: iOS now has four token formatters — consolidate them | KC |
| T7 | `/command` turn origin (durable + live) | `useSseBus` `commandExecuted`; `MessageRow` | `TranscriptTurns.swift:248-262` | **yes** — box stamps `info.command` (`MantaModels.swift:87`), `commandExecuted` frame | — | — | — | Only a trivial durable-vs-live merge stays in the client | KC |
| T8 | Inline media/file classification: mime → kind, `media_show`/begin output parsing, canonical media entries, preview size cap | `cu:4654,4663,4715,4736,4800` | `TranscriptMediaModel.swift:299,317,337,347,379,581`; `TranscriptMediaReconcile` | partial — live `media` frames | `transcriptView.mediaEntries(message)` → `view.media[] {id, path, mime, kind, width, height, size}` on the tool/file part | desktop + iOS | M | Ids must be the same handle-or-path ids iOS uses now (row identity). The live path is unchanged | **MN** |
| T9 | Media aspect/box/grid geometry | `cu:4691,4706` | `TranscriptMediaModel.swift:491-530` | — | — | — | — | Presentational | KC |
| T10 | Reasoning visibility + slim fetch toggle | Ctrl+O | `TranscriptDisplayOptions.swift` | yes (slim) | — | — | — | Device preference (D9/D22) | KC |
| T11 | Quote block build + middle truncation | `cu:570,581` | `SessionModels.swift:1026-1056` | — | — | — | — | Composer text editing with a per-device budget | KC |
| T12 | Tool output resolution/preview tail/verbose trim | `cu:1180,1184` | `ToolActivity.swift:475,484,500`; `ChatModels.swift:745-783` | — | — | — | — | Presentational truncation | KC |
| T13 | Task/delegate part → child session, run status, job id/name | `si:754,802,850`; `TaskCard.tsx` | `ToolActivity.swift:795-966`; `ChatModels.swift:87` | partial — `subagent` frames | `view.child {sessionId, status, jobId, name}` on task/delegate parts, using the box's live child status | desktop + iOS | M | Desktop TaskCard is intricate. Do after T1/T2 | ML |
| T14 | Voice note ↔ message association | `cu:4526` | `ChatModels.swift:647` | no (voice store is box-side) | `view.voiceNote` on the user message | desktop + iOS | S | Low churn | ML |
| T15 | Question answer assembly + submit gating | `cu:737,753` | `ChatModels.swift:709-723` | box validates the form reply | — | — | — | Recomputed on every tap while filling the form | KC |
| T16 | Plan-exit question detection + plan card data (refs, title, steps, files, page URL) | `cu:2612,2651,2684`; `src/shared/planMode.mjs` | `PlanDerivation.swift:66,82,109,126,162,182,193` | partial — `planMode.mjs` is shared | streamInterp `questions` frame: each question gets `plan {isPlanExit, title, steps, files, refs, pageUrl}`. Same on `form` hydration | desktop + iOS | M | The box already holds the messages. `buildHere` stays client (it is an action) | **MN** |
| T17 | Todo selection, terminal predicate, progress, dismiss-on-submit | `si:466,476,493,515`; `cu:650,682,711` | `ToolActivity.swift:1024-1099` | yes (`todos` frame) | — | — | — | Dismissal is view state. The rest is trivial reads | KC |
| T18 | Running-indicator label ("Editing x… · N tools · 1m") | `cu:3236` | `RunningIndicator.swift:71` | partial | Reuse T1's live `activity` label | desktop + iOS | S | Becomes trivial once T1 lands | ML |
| T19 | Live/transcript merge, optimistic user reconciliation, delta buffering | `cu:1135,2827-2880`; `si:244` | `ChatModels.swift:516` | — | — | — | — | Runs on every frame | KC |
| T20 | Context breakdown against the SELECTED model (limit) | `si:32,384`, client recompute at `ChatPanel.tsx:2574-2578` | `UsageMeters.swift:187`; `ChatScreen.swift:1101` | partial — `context` frame (`streamInterp.mjs:900`) and `opencode:context` (`rpc.mjs:1322`) use the last-used model | The box already stores the selection (`model-prefs`). Compute the frame and `opencode:context` against it, and re-emit on `model-prefs:set` | desktop + iOS | S | Re-emit on selection change. Old desktop keeps recomputing (harmless) | **MN** |
| T21 | Stale prompt-cache predicate | `si:341`, client recompute + 10 s timer at `ChatPanel.tsx:2557` | reads frame `isStale` (`UsageMeters.swift:173`, `ChatScreen.swift:1119`) | **partial / anomaly** — `cache` frame emitted only on step end (`streamInterp.mjs:317-326`), so `isStale` is always false then and never flips while idle | Add `staleAt` (epoch ms = lastCompleted + ttl, null when not eligible) to the `cache` frame. The client compares it with its clock. Desktop drops its recompute | desktop + iOS | S | Fixes an iOS bug: the stale warning cannot appear without a new event. Time comparison stays local (clock), the rule is the server's | **MN** |

### WS02 — Chat cards & queue (unbuilt)

| ID | Logic | Desktop | iOS planned | Server today | Proposed server home / shape | Clients | Eff | Risk / notes | Rec |
|---|---|---|---|---|---|---|---|---|---|
| C1 | Retry card headline/caption ("Retrying… (attempt N)", action title) | `Cards.tsx:86-129`; `useSseBus.ts:593-615` | 02 F1 `ChatCardRetryCopy` | partial (`retry` frame: attempt/message/action, `streamInterp.mjs:776`) | `retry` payload adds `headline`, `caption` | desktop + iOS | S | Additive field | **MN** |
| C2 | Compaction notice text ("Compacted while you were away · 128k → 31k") + finished first line | `cu:305`; `ChatPanel.tsx:3170-3180` | 02 F2 `ChatCardCompactionNotice.text`, `ChatCardTokens.desktopCompact`, `firstLine` | partial (`optimizer.compacted` `index.mjs:1932`) | `optimizer.compacted` adds `text`. `compaction` ended frame adds `firstLine` | desktop + iOS | S | Removes the iOS-only fifth token formatter | **MN** |
| C3 | Compaction/notice visibility latch + 3 s/10 s expiry | `ChatPanel` timers | 02 F2 `ChatCardExpiryLatch` | — | — | — | — | View timing | KC |
| C4 | "Blocked — needs a decision" rule | `ChatPanel.tsx:3150-3159` | 02 F3 `ChatCardProgressRule.isBlocked` | yes (`state` field) | — | — | — | Field equality | KC |
| C5 | Send-error description + Reconnect target (typed prefixes, credential regex, provider → Claude/Codex/Kimi, accounts id) | `cu:800,1777-1853`; `useSseBus.ts:628-637` | 02 F4 `ChatCardSendError.describe` | partial (`sessionError {name,message,rawMessage}`, `streamInterp.mjs:752`; `humanizeProviderError` shared) | Move `describeSessionError` + `authErrorAdvice` into `src/shared/streamInterpretation.mjs`, run in streamInterp. Payload adds `display {text, reconnect: {providerID, label, accountsId} \| null}`. The box knows the failing message's provider | desktop + iOS | S–M | Removes the "iOS must work out the provider from the model store" plumbing (02 F4 `sessionErrorProviderID`). The desktop Reconnect D10 bug is out of scope | **MN** |
| C6 | Approval card edit gating (non-empty, no blank field), footnotes | `PanelCards.tsx:585-707` | 02 F5 `ChatCardApprovalLogic.canStart/footnote` | no enforcement | Client gating stays (re-checked on every edit). **Add server enforcement:** `delegate:approve` refuses empty/blank rules with a message | iOS + desktop | S | The enforcement part is folded into C9's module | KC |
| C7 | Auto-approve when covered by an "always" rule | `cu:2245-2280` (desktop-only, D10) | — (02 forbids) | no | Delegate engine decides with the box's always-rules | desktop | M | Behaviour change on desktop. Needs its own decision | ML |
| C8 | Pending-approvals response in two wire shapes | — | 02 F5 `ChatCardApprovalsDecoding` | inconsistent | `delegate:pending-approvals` returns one shape | iOS | S | Cleanup | ML |
| C9 | Read-only job resolution + bar content (job for session, `correlation.kind !== "work"`, headline with model, status line/summary, parent, stoppable) | `cu:1869,1875,1892,1901`; `ChatPanel.tsx:360-373`; `PanelCards.tsx:715-774` | 02 F6 `ChatCardJobLogic`, `ChatCardOwnershipResolver` | no (raw `delegate:list`) | `src/server/delegateView.mjs`: `delegate:job-for-session {sessionId}` → `{readOnly:false} \| {readOnly:true, job:{id, headline, statusLine, parent:{sessionId, name, windowKey}, stoppable}}`. Refreshed on `delegate.updated` | desktop + iOS | S–M | The `.resolving` policy machine stays client-side (connection state) | **MN** |
| C10 | Mutation refusal for read-only job sessions | client-only today | 02 F6 `ChatCardMutationGate` | no | Box refuses `opencode:prompt`/`inbox`/`compact` aimed at a read-only job session (`{ok:false, error:"read_only_job"}`). The client gate stays as UX | desktop + iOS | S | Without this, an old client can still type into a job | **MN** |
| C11 | Inbox cancel / set-delivery outcome copy ("Already sent…", "Attachments weren't restored…") | `inboxState.ts:175-230` | existing `InboxModels.swift:249` (`InboxActionReport`); 02 F8 `ChatCardEditLast.report` | no | `opencode:inbox-cancel` / `inbox-set-delivery` results add `notice` | desktop + iOS | S | Additive | **MN** |
| C12 | Edit-last pick | `ChatPanel.tsx:918-923` | 02 F8 `ChatCardEditLast.pick` | — | — | — | — | Trivial. A race is already covered by the cancel outcome | KC |
| C13 | Inbox snapshot acceptance / epoch tracking | `inboxState.ts:16-80` | `InboxModels.swift:130,156` | — | — | — | — | Stream ordering | KC |
| C14 | Busy-send planning + prompt error classification (HTTP status scraping) | `inboxState.ts:122` | `InboxModels.swift:288-312`; `ComposerModels.swift:128-158` | partial | `opencode:prompt` errors carry `{code, message}` | desktop + iOS | S | Scraping status codes out of strings is fragile | ML |
| C15 | Pending-row badge/note/stopped footer | `inboxState.ts:154-174` | `InboxModels.swift:355-388` | — | — | — | — | Fixed labels per enum value | KC |
| C16 | Conversation seat line ("Seat: Work · Seat 2") | `cu:3812` | `AccountsModels.swift:745-763,946`; 02 F9 `ChatCardSeatLine` | partial | Seat projection carries `displayName` (see K4) | desktop + iOS | S | Do with K4 | ML |
| C17 | `.message` focus planner / highlight | — | 02 F10 | — | — | — | — | View logic | KC |
| C18 | Queued-message drain at step boundary | V2 `delivery` | already at parity | **yes** (V2 inbox, `streamInterp.mjs` `inbox`) | — | — | — | Nothing to do | KC |

### WS03 — Composer (built on iOS)

| ID | Logic | Desktop | iOS | Server today | Proposed | Clients | Eff | Risk / notes | Rec |
|---|---|---|---|---|---|---|---|---|---|
| P1 | `/` palette rows: built-ins + commands/skills, dedupe, filter | `cu:597,610` | `ComposerTypeahead.swift:346,355` | partial (`opencode:commands`) | — | — | — | Runs on every keystroke. Built-in sets differ per client by design | KC |
| P2 | Slash-send plan: built-in vs command vs prompt, refuse while running, always-background | `ChatPanel`/`useComposerController` | `ComposerTypeahead.swift:416,438` | partial (`opencode:run-command`) | `opencode:submit {sessionId, text, …}`: the box parses a leading `/name` against its own command list | desktop + iOS | M | Changes the desktop send path. New channel, so K2-safe | ML |
| P3 | `@@agent` mention resolution into mention parts | `useTypeahead` | `ComposerTypeahead.swift:108` | no | Box resolves mentions from text on prompt | desktop + iOS | S | Pair with P2 | ML |
| P4 | Mention / agent typeahead rows | `useTypeahead` | `ComposerTypeahead.swift:146,200` | — | — | — | — | Runs on every keystroke | KC |
| P5 | Anchor detection / token insertion | `useTypeahead` | `ComposerTypeahead.swift:58,89,293,377` | — | — | — | — | Text editing | KC |
| P6 | Prompt history | `useInputHistory.ts`, `chatShared.tsx` | `ComposerHistory.swift` | — | — | — | — | Device-local | KC |
| P7 | Insert/attach API + rejection reasons | — | `ComposerInsertion.swift` | — | — | — | — | Client state | KC |
| P8 | Submit error copy | `ChatPanel` | `ComposerModels.swift:156` | partial | With C14 | desktop + iOS | S | — | ML |

### WS04 — Sessions (built on iOS)

| ID | Logic | Desktop | iOS | Server today | Proposed | Clients | Eff | Risk / notes | Rec |
|---|---|---|---|---|---|---|---|---|---|
| S1 | Project/session naming: slugify, `deriveProjectName`, tmux-safe, unique against live tmux, scratch hint | `src/shared/projectName.mjs` (client-run) | `SessionCreateLogic.swift:48-117` | no (names taken verbatim) | `tmux:new-session` / `project:create-scratch` accept `nameHint` and return the final unique, tmux-safe name. `sessions:propose-name {hint}` serves the live preview (debounced) | desktop + iOS | S | Removes a create race (two devices pick the same name). An old desktop's exact names still work | **MN** |
| S2 | Rename validation/sanitising | Sidebar inline rename | `SessionCreateLogic.swift:36-45` | partial (app-control rename validates 1–40, no `:`) | `tmux:rename-window` validates and returns the final name or `{error}` | desktop + iOS | S | — | **MN** |
| S3 | Proposed workspace root from repo paths | `NewSessionScreen.tsx` | `SessionCreateLogic.swift:121-147` | no | The repo scan result adds `proposedRoot` | desktop + iOS | S | — | **MN** |
| S4 | Worktree branch/name defaults | `store.ts:979-1006` | `SessionCreateLogic.swift:150` | no | `git:add-worktree` with no name → box default + uniqueness | desktop + iOS | S | — | ML |
| S5 | Create orchestration (worktree → session → window → mode, undo on failure, locating the created window) | `store.ts` create flows | `SessionCreateLogic.swift:187-345`; `SessionCreateSheet.swift:762-777` | no | `src/server/sessionCreate.mjs` `sessions:create {cwd, worktree?, scratch?, mode, launcher?}` → `{project, windowIndex, windowKey, sessionId}`, atomic with undo (pattern: `delegate.mjs` startJob) | desktop + iOS | L | Large. Desktop has several flows (worktree fan-out, scratch) | ML |
| S6 | Draft prefill into the create form | — | `SessionCreateLogic.swift:364-372` | — | — | — | — | Form state | KC |
| S7 | Repo zero-state + row text | `cu:4198,4211,4223` | `SessionCreateLogic.swift:425-460` | — | — | — | — | Presentational | KC |
| S8 | Clone stderr classification, repo-list error copy, clone destination | `cu:4248,4275`; `CloneFromGitHub.tsx` | `CloneFromGitHubLogic.swift:17,41,55,94` | no | `forge:clone-status` adds `{errorKind, message}`. `forge:repos` errors carry `message` + `needsSignIn`. `forge:clone-start {root, name}` computes the destination | desktop + iOS | S | — | **MN** |
| S9 | GitHub device-flow poll rules (expiry, slow-down, error copy, code parsing) | `cu:1555-1700`; `ConnectGithub.tsx` | `CloneFromGitHubSignInLogic.swift` | partial | `forge:device-poll` → `{state, message, nextPollMs}` | desktop + iOS | S | Just built; low churn | ML |
| S10 | Close confirmations + worktree-on-close decision (running count, dirty check, kept/removed notice) | `cu:5131,5149`; `Sidebar.tsx:240-294,337-342` | `SessionCloseLogic.swift:21-140` | no | `src/server/sessionClose.mjs`: `sessions:close-preview {project, windowIndex?}` → `{title, body, worktrees:[{path, dirty}], runningCount}`; `sessions:close {project, windowIndex?, worktrees:"keep"\|"remove", force?}` → `{removed, kept, needsConfirm?:{path, reason}, notice}` | desktop + iOS | M | The box sees git dirtiness and running state directly | **MN** |
| S11 | Session view mode (chat / terminal / CLI) persistence + resolution against the launcher catalog | `chatShared.tsx:422-457` | `SessionModeLogic.swift:61-90` | — | — | — | — | Device preference. Revisit only if the mode should follow the user across devices | KC |
| S12 | Switcher fuzzy score + recents | `cu:2038` | `SessionSwitcherLogic.swift:23,50,89` | — | — | — | — | Runs on every keystroke; recents are local | KC |
| S13 | Job nesting / hidden job windows under parents | `cu:2082,2150,2221` | `SessionModels.swift:210-260` | no | `tmux:list` windows add `job {id, parentSessionId, status}` (joins the delegate store) | desktop + iOS | S | Shares the join with C9 | **MN** |
| S14 | Session row status: running, started-at, attention, running-subagent count, stopped-by-limit | `cu:845` sidebar frame handler; `ChatPanel.tsx:2851` `countRunningSubagents`; `store.ts:738` | `SessionModels.swift:367-535`; `SessionListStore.isStopped` | partial (`runningSet`, `attention`, `subagent` frames; `status.mjs` for terminals) | streamInterp `windowStatus` for chat windows `{sessionId, running, startedAt, attention, subagents, stopped}` + snapshot on connect | desktop + iOS | M | Desktop counts open-panel subagents from the transcript, so both must use the frame or the two numbers can disagree. Additive frame | **MN** |
| S15 | Row ordering, pins, latest-activity flattening | `cu:1985-2022` | `SessionModels.swift:612-750` | — | — | — | — | View preference | KC |
| S16 | Background-job row text (status label, summary, timing, sort) | `cu:1901`; `BackgroundJobsSheet` | `SessionModels.swift:755-810` | no | `delegate:list` rows add `statusLabel`, `summary` (from `delegateView.mjs`, C9) | desktop + iOS | S | Same module as C9 | **MN** |
| S17 | Folder-picker path helpers, worktree badge/name | `folderPicker.ts:14-84` | `SessionModels.swift:862-950` | — | — | — | — | Path presentation | KC |
| S18 | Model short label | `cu:2302` | `SessionModels.swift:814-840`; `ChatModel.swift:306` | partial (names in `opencode:models`) | Covered by M2 picker view `displayName` | desktop + iOS | S | — | ML |
| S19 | Action / create failure copy from transport errors | — | `SessionCreateLogic.swift:16`; `SessionModels.swift:987` | — | — | — | — | Client transport | KC |
| S20 | Cache-TTL → row "recent" window | — | `SessionModels.swift:477-505` | — | — | — | — | Trivial config read | KC |

### WS05 — Git / PR / review / inbox (unbuilt)

| ID | Logic | Desktop | iOS planned | Server today | Proposed | Clients | Eff | Risk / notes | Rec |
|---|---|---|---|---|---|---|---|---|---|
| G1 | Branch panel state, ship state (has-pr/detached/unknown/on-base/no-commits/ready) + no-ship copy, chip label, interactivity | `cu:4073,4379,4416`; `SessionHeader.tsx:1284-1288` | 05 A.4 `GitPanel` | no | `src/server/forge/view.mjs` `pullRequestView(result)`. `forge:pull-request` adds `view {panel, ship:{state, copy}, chipLabel, interactive}` | desktop + iOS | S–M | 5 s poll; response stays small | **MN** |
| G2 | Merge gating + reason, mergeable display | `cu:4331`; `SessionHeader.tsx:1390-1395` | 05 A.4 `canMerge`, `mergeableDisplay`, `GitMergeTarget` | no | `view.merge {can, reason, mergeable:{text, tone}}`. `forge:merge` re-checks on the box | desktop + iOS | S | — | **MN** |
| G3 | Merge failure copy | `cu:4358` | 05 A.4 `describeMergeFailure` | no | `forge:merge` returns `message` | desktop + iOS | S | — | **MN** |
| G4 | Ship / ship-preview error copy | raw on desktop | 05 A.4 `GitCopy.shipError` | no | `forge:ship` / `ship-preview` return `message` | desktop + iOS | S | Desktop gains plain-word errors | **MN** |
| G5 | Keep the last PR when a poll is rate-limited (`pr:null, stale:true`) | flips to "Create PR" (bug) | 05 A.4 `GitForgeState.applying` | no (`forge/index.mjs:758`) | The box caches the last PR per cwd and returns it with `stale:true` | desktop + iOS | S | **Changes desktop behaviour** (fixes the flip) | **MN** |
| G6 | Check tone/order/counts + chip descriptor | `cu:4010,4020,4027,4052` | 05 B.3 `GitChecks` | no | `checks[]` come pre-ordered with `tone`; `view.checks {counts, chip:{glyph, label, tone}}` | desktop + iOS | S | — | **MN** |
| G7 | "Send failures to the agent" prompt + log URL choice | `cu:4101` | 05 B.3 `failuresPrompt`, `logURL` | no | `view.checks.failuresPrompt`, `view.checks.logsUrl` | desktop + iOS | S | Insertion mode stays per-client (D6) | **MN** |
| G8 | Offer "Connect GitHub" | `cu:4084` | 05 A.4 `shouldOfferConnect` | — | — | — | — | Includes a device-local "dismissed" flag | KC |
| G9 | Ship-preview async state (accept/invalidate/canCreate) | `ChatPanel.tsx:1084-1139` | 05 A.4 `GitShipPreviewState` | — | — | — | — | Client request sequencing | KC |
| G10 | Diff parsing, commentable anchors, thread/draft placement | `cu:4454-4492`; `ToolBodies.tsx:318-500` (loses threads on context lines, `:340-355`) | 05 D.3 `ReviewDiff.parse/anchors/place` | no | `src/server/forge/diffView.mjs`. `forge:diff` adds `files[{path, added, removed, rows[{kind, text, oldLine, newLine, anchor}]}]` + `placement {threadId → {file,row}\|"top"\|"unplaced"}`. `forge:draft-get` places drafts the same way | desktop + iOS | M | **Changes desktop behaviour** (stops losing threads). Large diffs get bigger as JSON (~3×): keep raw `diff` for K2, consider a row cap | **MN** |
| G11 | Review copy: pending label, submit/load error sentences | `ReviewPane.tsx:140-180,418-452` | 05 D.3 `pendingLabel`, `submitErrorCopy` | partial | Errors carry `message` (`no_pr`, `not_connected`, `nothing to submit`, `http_422`) | desktop + iOS | S | Plurals stay in the client | **MN** |
| G12 | Composer-insert policy (read-only chats) | — | 05 A.3a `GitComposerPolicy.canInsert` | — | — | — | — | Client composer state | KC |
| G13 | Work-inbox sort/dedupe/priority, reason label, identifier, secondary, worktree branch name, local checkout join | `cu:4934,4953`; `InboxPalette.tsx:73-80`; `forge:probe` merge | 05 E.3 `WorkInbox` | partial (seed from box, `forge/index.mjs:803`) | `forge:inbox` returns sorted, deduped `items[{…, label, identifier, secondary, branchName, localPath}]` | desktop + iOS | S | Desktop drops its second `forge:probe` call | **MN** |
| G14 | Inbox filter | `InboxPalette` | 05 E.3 `filter` | — | — | — | — | Runs on every keystroke | KC |
| G15 | Delegate parent candidates | — | 05 E.3 `parentCandidates` | — | — | — | — | Ranks the local project list | KC |
| G16 | Inbox → `NewSessionDraft` | — | 05 E.2 | — | — | — | — | Client navigation (D12) | KC |

### WS06 — Search (unbuilt)

| ID | Logic | Desktop | iOS planned | Server today | Proposed | Clients | Eff | Risk / notes | Rec |
|---|---|---|---|---|---|---|---|---|---|
| Q1 | Search scope: primary first, every window with a session id in sidebar order, dedupe, `maxPrimary: 3` without a primary | `SearchPalette.tsx:74-86`; `store.ts:1774-1781` | 06 `SearchScope.build`, `request` | no | `opencode:search-messages {query, scope:"all", primarySessionId?}`. The box enumerates tmux windows itself. `sessionIds` stays accepted | desktop + iOS | S | K2: an old desktop keeps sending `sessionIds` | **MN** |
| Q2 | Grouping + section labels (`ws › name`, current first) | `SearchPalette.tsx:42-54,282-305` | 06 `SearchGrouping.sections`, `SearchCopy.header` | no | Response adds `groups[{sessionId, label, isCurrent, hits}]` alongside flat `hits` | desktop + iOS | S | Additive | **MN** |
| Q3 | "Search failed" vs "no matches" | swallowed (`SearchPalette.tsx:116-119`) | 06 (inherited limitation) | no (`messageSearch.mjs:94-97`) | Add `degraded:true` on a DB/worker error | desktop + iOS | S | Desktop and iOS can now say so | **MN** |
| Q4 | Query trim/min length/debounce/sequence | `SearchPalette.tsx:27-28,100-125` | 06 state machine | box trims too | — | — | — | Runs on every keystroke | KC |
| Q5 | Count/footer plurals | `SearchPalette.tsx:170-173` | 06 `SearchCopy` | — | — | — | — | Labels | KC |
| Q6 | Jump reachability | `SearchPalette.tsx:139-156` | 06 `SearchJump` | — | — | — | — | Local navigation | KC |

### WS07 — Artifacts & cards (unbuilt; partial iOS port exists)

| ID | Logic | Desktop | iOS | Server today | Proposed | Clients | Eff | Risk / notes | Rec |
|---|---|---|---|---|---|---|---|---|---|
| A1 | Artifact derivation: files/images/links/hosted pages/outbox rows, link context, message ids, dedupe, plan-page exclusion | `artifacts.ts:227-412` (`deriveArtifacts :329`) | `ArtifactDerivation.swift:48-250` (incomplete port); 07 F1–F3 extend it | no | `src/server/artifacts.mjs` `artifacts:list {sessionId}` → `{items[{id, kind, label, href, mime, origin, at, messageId, context, isHosted, expiry, plan?}], counts}` (box has messages, serve-page registry, outbox) | desktop + iOS | M | iOS polls every 3 s: memoize on (session, last message time, outbox/page mtimes). Deletes the incomplete iOS port instead of finishing it | **MN** |
| A2 | Plan artifact: title from path, step count, status, page URL match | `artifacts.ts:180-266,365-388` | 07 F1 (+ `PlanDerivation.swift:182,193`) | partial (`planMode.mjs` shared) | Folded into A1 `plan {status, steps, pageUrl}` | desktop + iOS | S | — | **MN** |
| A3 | Expiry state (expired / soon ≤6 h / live) | `artifacts.ts:448`; `cu:451` | `ArtifactDerivation.swift:282`; 07 F5 `ArtifactExpiry` | no | A1 `expiry {state, expiresAt}`. The label text stays client (relative to now) | desktop + iOS | S | 3 s poll keeps the state fresh. Label recomputed locally | **MN** |
| A4 | Day grouping | `artifacts.ts:420` | `ArtifactDerivation.swift:324` | — | — | — | — | Device calendar/timezone | KC |
| A5 | Counts by kind | `artifacts.ts:454` | `ArtifactDerivation.swift:307` | no | A1 `counts` | desktop + iOS | S | — | **MN** |
| A6 | Search filter + per-tab live counts | `ArtifactsPanel.tsx:699-722` | 07 F2 `ArtifactSearch` | — | — | — | — | Runs on every keystroke | KC |
| A7 | Action eligibility (attach/jump/open plan file) | `ArtifactsPanel.tsx` | 07 `ArtifactActions` | — | — | — | — | Depends on composer/client state | KC |
| A8 | Byte-source routing, data-URI decode | — | 07 `ArtifactByteSource` | — | — | — | — | Client fetch | KC |
| A9 | Agent-file announce decision | `outbox.mjs:283-327` | 07 F6 machine | **yes** | — | — | — | Notice state machine is UI | KC |
| A10 | Webhook "last delivery"/URL display | `PanelCards.tsx:113-213` | 07 F7 `WebhookFormat` | — | — | — | — | Presentational | KC |
| A11a | Secret scope encoding/badges | `SecretEditor.tsx:23-25` | 07 F7b | — | — | — | — | Input encoding | KC |
| A11b | Secret shadowing / overrides / orphaned sessions | `secretsView.ts:135-260` | (not planned) | no | `secrets:list` adds `shadowedBy`, `overrides` | desktop | S | Desktop-only today | ML |
| A12 | Secret key validation | `secretsView.ts:12` | 07 | **yes** (`secrets.mjs` `isValidKey`) | — | — | — | Client pre-check runs on every keystroke | KC |

### WS08 — Accounts (in progress; many earlier ports)

| ID | Logic | Desktop | iOS | Server today | Proposed | Clients | Eff | Risk / notes | Rec |
|---|---|---|---|---|---|---|---|---|---|
| K1 | Accounts section plan; seat-provider ↔ status-id table | `cu:3568-3590` (`SEAT_PROVIDER_OPENCODE_IDS`) | 08 `AccountsSectionPlan.build` | no | `src/server/accountsView.mjs` `accounts:overview` → joined sections | desktop + iOS | M | WS08 is mid-flight. Avoid churn now | ML |
| K2 | Connection row state text + control (status + health precedence) | `AccountsCard`/`describeAccountState` | 08 F6 `AccountRowState.describe` | no | Subscription status / `accounts:health` add `stateText`, `control` | desktop + iOS | S | — | **MN** |
| K3 | Endpoint health line ("retry in Nm · HTTP 429 · last success 5m ago · N attempts") + no-healthy copy | `cu:5229,5266`; `src/shared/providerHealthLabel.mjs` | 08 F6 badge | partial (shared module, run in the client) | `accounts:health` rows add `stateLine`. The relative-time part is computed at response time | desktop + iOS | S | Health is polled, so "5m ago" can lag by one poll — acceptable | **MN** |
| K4 | Seat selectors: all seats, choice, replacement, conversation seat, next-seat hint, ordering, row action, remove-block reason, status text, windows | `cu:3548-3906` | `AccountsModels.swift:866-1074` | no | `accounts:list` view fields (`rowAction`, `removeBlockReason`, `isNext`, `statusText`, `conversationSeat {displayName}`) | desktop + iOS | M | A large pre-existing port | ML |
| K5 | Seat-move notice text | `cu:3777,3791` | `AccountsModels.swift:518-616` | no | The seat-move bus event adds `text` | desktop + iOS | S | — | **MN** |
| K6 | Sign-in connect → phase; seat-status poll interpretation | `SeatSignIn.tsx:33`; AddSeatFlow | `AccountsSignInModels.swift:96,289` | partial | `seat-status` / `resign-status` return `phase` | desktop + iOS | M | Just built | ML |
| K7 | Accounts error-code copy | `cu:3851` | `AccountsModels.swift:768-808` | no | Error replies carry `message` | desktop + iOS | S | — | **MN** |
| K8 | Connect route (connect vs add account vs blocked) | `ConnectProvider.tsx` | 08 `ConnectRoute.decide` | no | `accounts:connect-route {provider}` | desktop + iOS | S | — | ML |
| K9 | Custom endpoint slug/validation/collision | `cu:1608,1625` | `ProviderEndpointModels.swift` | partial | `opencode:set-providers` returns field errors. The slug preview stays client (keystroke) | desktop + iOS | S | — | ML |
| K10 | Endpoint write reconciliation after a non-atomic write | — | 08 F4 `EndpointWriteReconcile` | no | Make `set-providers` atomic and return the post-state; the client logic then goes away | iOS | M | Server fix | ML |
| K11 | Model-discovery error text | — | 08 `discoverErrorText` | no | `discover-models` returns `message` | desktop + iOS | S | With K9 | ML |
| K12 | Model checklist filter/rows | — | `ProviderEndpointModels.rows` | — | — | — | — | UI | KC |
| K13 | OAuth lease / attempt gates | — | `ProviderOAuthLease.swift` | — | — | — | — | Client concurrency | KC |
| K14 | Connect panel phase labels | `cu:1645`; `connectPanelLogic.ts:134` | `ProviderConnectFlow.swift` rules | partial | Provider auth status returns `phase` + `label` | desktop + iOS | M | — | ML |

### WS09 — Models & usage (unbuilt)

| ID | Logic | Desktop | iOS planned | Server today | Proposed | Clients | Eff | Risk / notes | Rec |
|---|---|---|---|---|---|---|---|---|---|
| M1 | Models table row state + invariants (Main off clears the default, Sub → sync-subagents outcome, deprecated lock/opt-in, override diff) | `ModelsCard.tsx:244-380` | 09 F1 `ModelsTable` | no (raw `config:update` + `opencode:sync-subagents`) | `src/server/modelsTable.mjs`: `models:table` → rows `{key, name, providerID, context, deprecated, deprecatedLocked, isMain, isSub, isDefault, canMakeDefault, description}`. Writes: `models:set-main {key,on}` (clears default atomically), `models:set-sub {key,on}` → `{outcome}`, `models:opt-in`, `models:set-default`, `models:set-override {key, fields}` | desktop + iOS | M | Fixes read-modify-write races between devices on `modelOverrides` and `optInModels`. `subOutcome` heuristics disappear | **MN** |
| M2 | Picker groups + selectability (Main-hidden, deprecated locked, fast-sibling hiding), visible recents | `cu:188,2335-2470`; `modelGuide.mjs` `isDeprecated` | `ChatModel.swift:158,176`; `DeprecatedModelOptIns.swift` (**device-local**); `ModelRecents.swift`; 09 `ModelsPicker` | no | `models:picker` → `{groups[{provider, models[{key, displayName, contextLabel?, locked, fastSibling?}]}], recents}` | desktop + iOS | M | **iOS behaviour change**: deprecated opt-ins move from UserDefaults to config `optInModels` (seed once from the device). Search inside the picker stays client | **MN** |
| M3 | Effective selection precedence + fast/plan toggles | `cu:2498,2564`; `modelPrefs.ts:145`; `ChatPanel.tsx` | `ChatModel.swift:47,94,221` | partial (`model-prefs` stores the choice) | `model-prefs:get` returns `effective` per session; toggles go through `model-prefs:set` | desktop + iOS | M | Composer hot path; needs optimistic UI | ML |
| M4 | Fuzzy model match | `modelGuide.mjs` | `ChatModel.swift:245` | yes (app control) | — | — | — | Client use is search | KC |
| M5 | Context-size label | `cu:139` | `ChatModel.swift:262` | — | — | — | — | Presentational | KC |
| M6 | Ledger insight view (segment % rounding + inline-label rule, cache caption, top models, agent label) | `ModelLedgerCard.tsx:84-140` | 09 F2 `ModelsInsights` | partial (aggregates) | `ledger:summary` adds `view {segments[{kind, pct, inline}], caption, topModels}` | desktop + iOS | S | Money formatting stays client | **MN** |
| M7 | Optimizer derived values (pressure text/tone, activity headline/detail, cache-hit %, TTL label, gauge band, series totals/counterfactual, saved stat, worst window, empty texts) | `cu:246,290`; `OptimizerCard.tsx:278-581` | 09 F3 `OptimizerLogic` | partial | `optimizer:summary` / `optimizer:series` add a `view` block | desktop + iOS | M | Chart geometry stays client | **MN** |
| M8 | Cumulative path, axis ticks | `cu:319,352` | 09 `cumulative`, `axisTicks` | — | — | — | — | Presentational | KC |
| M9 | Unidentified-model rows | `ModelsWeCouldntIdentify.tsx:328-390` (+ `modelIdentity.mjs`, `autoEligibility.mjs`) | 09 F4 (new `models:unidentified`, D7) | planned server | **Amend D7/09 F4: the desktop switches to `models:unidentified`** in the same change. Drop the "desktop not changed" clause and the parity node test | desktop + iOS | S | D7 contradicts D23 as written | **MN** |
| M10 | Missing-phrase join + row help text | `AccountsCard.tsx:170-187` | 09 `missingPhrase`, `helpText` | no | Rows add `help` | desktop + iOS | S | — | **MN** |
| M11 | Declaration build + routing merge + post-declare outcome | `ModelsWeCouldntIdentify.tsx:290-313` | 09 `declaration`, `mergedRouting`, `declareOutcome` | no | `models:declare {key, decl}`: the box does the read-modify-write and returns the refreshed row or `resolved` | desktop + iOS | S | Fixes a lost-update race | **MN** |
| M12 | Catalogue typeahead + Save gating | `IdentifyEditor` | 09 `search`, `canSave` | — | — | — | — | Runs on every keystroke | KC |
| M13 | Price-draft validation messages + unpriced grouping by provider | `ModelPriceForm.tsx:55-91` | 09 F5 `ModelsPricing` | partial (`set-model-cost` validates) | `set-model-cost` returns `{field, message}` with the desktop copy. `optimizer:prices` adds `unpricedByProvider` | desktop + iOS | S | Validation now happens on Save (it already did on desktop) | **MN** |
| M14 | Resume view: name, workspace groups, reset instant, warm/cold re-read cost, snippet, "new", header text, window chip | `usageResume.ts:24-151`; `UsageResumeModal.tsx` | 09 F6 `UsageResume` | partial (records) | `src/server/usageResumeView.mjs` `usage-stopped:view` → `{header, unarmedCount, groups[{workspace, rows[{conversation, name, armed, isNew, snippet, model, window{label, resetsAt}, cost{warm, reReadTokens}}]}]}` | desktop + iOS | M | The snippet reads messages on the box (DB read). The "in 2h" chip text stays client | **MN** |
| M15 | Apply plan (arm/disarm diff, can-apply) | `UsageResumeModal.tsx:97-109,229-230` | 09 `applyPlan`, `canApply`, `applyTitle` | no | `usage-stopped:apply {selected[]}` → `{armed, disarmed}` | desktop + iOS | S | **Fixes the desktop defect** (the last armed row could not be disarmed) | **MN** |
| M16 | Usage alert escalation (levels, upward transition, baseline seeding, warn/limit text) | `usageEscalation.ts:33-130`; `App.tsx:794-917` | 09 F7 `UsageEscalation`, `UsageBaseline` | no (`usage.updated` raw) | The usage poller (box keeps the previous snapshot) emits a `usage.alert` frame `{id, key, level, provider, window, text, resetsAt}`. `usage:alerts` lists active alerts for reconnect seeding. Optional APNs via `fireNotify` | desktop + iOS | M | Both clients lose all baseline/seed logic. Alerts raised while a client is offline arrive through `usage:alerts`. Push is a new behaviour — decide explicitly | **MN** |
| M17 | Remind-at-reset policy (expired / unavailable, `fireAt = resetsAt + 60 s`) | `App.tsx` limit toast (bug: past `fireAt` → yearly cron) | 09 `actionPolicy` | partial (`schedule:create`) | `usage:remind-at-reset {provider, window, sessionID}`: the box uses the current reset and refuses one in the past | desktop + iOS | S | **Fixes the desktop bug** | **MN** |
| M18 | Meter tone, stale window, session/weekly window choice | `cu:3348-3520` | `UsageMeters.swift:33,63,68,87` | partial (staleness known box-side) | `usage:list` windows add `tone` and `role:"session"\|"weekly"` | desktop + iOS | S | Thresholds already match (70/90). Desktop "over" ≥100 gets unified too | **MN** |
| M19 | Reset time / distance formatting | `cu:3459-3505` | `UsageMeters.swift:97-146` | — | — | — | — | Clock-relative | KC |

### WS10 — Settings & box (built on iOS)

| ID | Logic | Desktop | iOS | Server today | Proposed | Clients | Eff | Risk / notes | Rec |
|---|---|---|---|---|---|---|---|---|---|
| X1 | Launcher flag resolution (saved ?? default) + flag update patch | `chatShared.tsx:504`; `App.tsx:2190`; `settingsShared.ts:41`; `Settings.tsx:786` | `ExtensionsModels.swift:187-227` | no | `launchers:list` adds `flags[].value`. A PTY spawn with `{launcher:{id}}` and no flags is resolved on the box. New `launchers:set-flag {id, key, value}` | desktop + iOS | S | K2: an old desktop's explicit flags are still honoured | **MN** |
| X2 | Settings defaults / modified / section + all reset values | `settingsSchema.ts` (+ desktop Settings) | `MantaSettingsModels.swift:72-139` over generated schema | — (single TS source + codegen) | Optional `config:reset {section?}` | desktop + iOS | S | Codegen from one source already prevents drift. Lowest priority | ML |
| X3 | Update target rows: tone/text/has-update/landed/version text | `src/shared/updateTargets.mjs`; `cu:1311,1357,1431` | `SettingsUpdatesModels.swift:123-172` | partial (shared module, run in the client) | `server:update-check` returns targets with `{tone, text, hasUpdate, versionText}` | desktop + iOS | S | The desktop-app leg (Electron updater) stays desktop | **MN** |
| X4 | Apply-update "transient network error = restarted" | `cu:1384` | `SettingsUpdatesModels.swift:83` | — | — | — | — | The box restarts mid-call, so only the client can tell | KC |
| X5 | Upgrade gate view: status normalisation, headline/body/details, disk shortfall, ETA, allowed actions | `upgradeGateLogic.ts:56-390` | `UpgradeModels.swift:194-505` | partial (`GET /api/upgrade` state) | `/api/upgrade` adds `view {headline, body, details, disk, actions:{retry, rollback}}` | desktop + iOS | S–M | Must stay on the upgrade-exempt path. Additive. The client-vs-box major check stays client | **MN** |
| X6 | Device list order + revocable | Settings devices | `BoxDevicesModels.swift:94-150` | partial (`current` added by WS10) | `/auth/devices` returns sorted rows with `revocable` | desktop + iOS | S | — | **MN** |
| X7 | Pair link build, QR server override | `pairPayload.ts`; `pairPanel.ts` | `BoxPairingModels.swift:31-60` | partial | `authPair` returns `link` | desktop + iOS | S | Override rules depend on how the device reached the box. The countdown stays client | ML |
| X8 | Pair-payload parse, claim classification, URL normalisation | `pairPayload.ts`, `claim.mjs`, `setupLogic.ts` | `MantaPairingModels.swift` | — | — | — | — | Runs before pairing, when no authenticated box is reachable | KC |
| X9 | Forge credential secondary text | `cu:4293` | `ExtensionsModels.swift:78-104` | no | `forge:status` adds `secondary` | desktop + iOS | S | — | **MN** |
| X10 | Skill-registry add/remove validation | `Settings.tsx` onAdd/onRemove | `ExtensionsModels.swift:106-118` | no | `config:registries {add\|remove}` | desktop + iOS | S | — | ML |
| X11 | Reference alias validation, target classification, upsert payload | `settingsSchema.ts` `validateReferenceAlias` | `ExtensionsModels.swift:121-184` | partial | `opencode:set-references` validates and normalises | desktop + iOS | S | — | ML |
| X12 | Plugin row format | `Settings.tsx` `formatTimeout` | `ExtensionsModels.swift:18-75` | — | — | — | — | Presentational | KC |
| X13 | Backup preview lines + restore outcome | Settings backup | `SettingsBackupModels.swift:20-80` | partial | `restore:preview` returns `summary` lines | desktop + iOS | S | — | ML |
| X14 | Theme preference, notification reminder | — | `SettingsAppearance.swift`, `SettingsNotificationModels.swift` | — | — | — | — | Device-local | KC |

### Cross-cutting

| ID | Logic | Desktop | iOS | Rec | Why |
|---|---|---|---|---|---|
| Z1 | Reconnect controller, backoff, connection state | `src/shared/net/*`, `net/wsTransport.ts` | `MantaReconnectController.swift`, `MantaStreamModels.swift:20-180` | KC | It is the client's link to the box, so it must work when the box is unreachable |
| Z2 | Handoff card badge/actions/pinning | `handoff*.ts` | `HandoffModels.swift:370-480` | KC | Records are already box-owned. What remains maps a state to a badge |

---

## 2. Counts

| | MOVE-NOW | MOVE-LATER | KEEP-CLIENT | Total |
|---|---|---|---|---|
| WS01 | 8 | 4 | 10 | 22 |
| WS02 | 6 | 4 | 8 | 18 |
| WS03 | 0 | 3 | 5 | 8 |
| WS04 | 8 | 4 | 8 | 20 |
| WS05 | 10 | 0 | 6 | 16 |
| WS06 | 3 | 0 | 3 | 6 |
| WS07 | 4 | 1 | 8 | 13 |
| WS08 | 4 | 8 | 2 | 14 |
| WS09 | 13 | 1 | 5 | 19 |
| WS10 | 5 | 5 | 4 | 14 |
| Cross | 0 | 0 | 2 | 2 |
| **All** | **61** | **30** | **61** | **152** |

---

## 3. Work units

### 3a. MOVE-NOW items inside unbuilt specs

Each spec gains a **server section** with the module, channel/frame contract and
node tests. The **desktop switch-over** happens in the same change (D23), and
the iOS port the spec planned is not written. Every listed "Pure logic" type that
maps to a moved row is deleted from the spec. Its XCTests become decode tests of
the server shape.

| Spec | Items | New/changed server pieces |
|---|---|---|
| **02** chat cards | C1, C2, C5, C9, C10, C11, S16 | `streamInterp.mjs` (retry `headline/caption`, `sessionError.display`, compaction `firstLine`); `index.mjs` `optimizer.compacted.text`; `describeSessionError`/`authErrorAdvice` move to `src/shared/streamInterpretation.mjs`; new `src/server/delegateView.mjs` (`delegate:job-for-session`, `delegate:list` `statusLabel/summary`, `delegate:approve` rule check, read-only job refusal on prompt/inbox/compact); inbox result `notice` |
| **05** git/PR/review | G1–G7, G10, G11, G13 | new `src/server/forge/view.mjs` (PR view, merge gate, checks view, failures prompt, logs URL, last-PR cache) and `src/server/forge/diffView.mjs` (structured diff + placement); `forge:merge`/`ship`/`draft-*` `message`; `forge:inbox` sorted + `localPath` |
| **06** search | Q1–Q3 | `messageSearch.mjs`: `scope:"all"` + `primarySessionId`, server-side `groups`, `degraded` |
| **07** artifacts | A1, A2, A3, A5 | new `src/server/artifacts.mjs` + `artifacts:list` (memoized); desktop `ArtifactsPanel` consumes it; iOS `ArtifactDerivation.swift` is **deleted**, not extended (WS07 owns that file) |
| **09** models/usage | M1, M2, M6, M7, M9, M10, M11, M13, M14, M15, M16, M17, M18 | new `src/server/modelsTable.mjs` (`models:table`, `models:picker`, `models:set-*`, `models:declare`); `modelsUnidentified.mjs` rows add `help`, **desktop switches**; `ledger`/`optimizer` `view` blocks; `set-model-cost` field errors, `unpricedByProvider`; new `src/server/usageResumeView.mjs` (`usage-stopped:view`, `usage-stopped:apply`); usage poller `usage.alert` + `usage:alerts` + `usage:remind-at-reset`; `usage:list` window `tone/role` |

Master changes this implies:

- **D7** must be amended. The list of "accepted server changes" grows as above,
  and the WS09 clause "the desktop renderer is NOT changed" is withdrawn.
- The **"one workstream per wave edits `rpc.mjs`/`index.mjs`"** rule now binds
  hard in wave B: 02, 06, 07 and 09 all register channels.
- Proposal: each workstream keeps its logic in its own module, with its own node
  tests. The channel-registration lines in `rpc.mjs` and the `streamInterp.mjs`
  edits are applied **serially by integration agent B** in the order 02 → 07 →
  09 → 06, as the same kind of ledger mount the iOS files use (`M-<ws>-srv-n`).

### 3b. WS11 — consolidation (new workstream)

WS11 covers logic **already ported** in wave A (and earlier). It moves that logic
to the box, switches the desktop over, and deletes the iOS ports. Proposed slot:
**wave D**, after C, running alone. It edits WS01/03/04/08/10-owned iOS files
and shared server files, so it cannot run beside them.

| Unit | Items | Server | Desktop switch | iOS switch (delete ports) |
|---|---|---|---|---|
| **U1 Transcript view** | T1, T2, T4, T5, T8, T16 | new `src/server/transcriptView.mjs`. `opencode:messages {view:true}` adds `view {activity, runs, turns, media}`. streamInterp: tool frames carry `activity`; new `toolRun` frame; `questions` carry `plan` | `toolActivity.ts` describe/summarize/groupTone, `computeTurnInfo` (incl. `CtoChat`), media parsing in `chatUtils`, plan question helpers | `ToolActivity.swift` describe/summarize/target/detail, `TranscriptTurns.swift` info/truncation, `TranscriptMediaModel.swift` parse/canonical, `PlanDerivation.swift` plan-question half. **Retire `tool-activity-cases.json`** and both parity tests |
| **U2 Sessions & windows** | S1, S2, S3, S8, S10, S13, S14 | `tmux:new-session`/scratch `nameHint` → final name; `sessions:propose-name`; rename validation; repo-scan `proposedRoot`; clone `errorKind/message`/dest; new `src/server/sessionClose.mjs` (`sessions:close-preview`, `sessions:close`); `tmux:list` window `job`; `windowStatus` frame | `projectName.mjs` client use, Sidebar close flow, job nesting, sidebar running/subagent derivation | `SessionNaming`, `SessionRenameLogic`, `SessionWorkspaceRoot`, `CloneFromGitHubLogic` classify/dest, `SessionCloseLogic` copy/decision, `SessionJobNesting`, `SessionSubagentCount` |
| **U3 Small derived fields** | T20, T21, X1, X3, X5, X6, X9 | `cache.staleAt`; context against the selected model + re-emit; `launchers:list` values + spawn-side resolve + `launchers:set-flag`; update targets view; `/api/upgrade` `view`; `/auth/devices` `revocable` + order; `forge:status.secondary` | ChatPanel stale-cache and context recompute, `resolveLauncherFlags`, `describeUpdateTarget`, `upgradeGateLogic` view parts, `forgeCredentialSecondary` | `UsageMeters.recompute`, `ExtensionsLaunchers`, `UpdateTargets`, `UpgradeScreenModel`/`UpgradePresentation` text, `BoxDevices.sorted/canRevoke`, `ExtensionsForge` |
| **U4 Accounts copy** | K2, K3, K5, K7 | `accounts:health` `stateLine`/`stateText`/`control`; seat-move `text`; error `message` | `describeAccountState`, `formatEndpointStateLine`, `accountsErrorMessage`, move-notice text | `AccountRowState`, the badge formatter, `AccountsCopy.reason`, `moveNoticeText` |
| **U5 Compatibility + guardrails** | all of the above | `/api/version` gains `capabilities: string[]` (one id per new channel/field family); node tests per module; a lint/grep check that the deleted client functions stay deleted | client capability gate | client capability gate |

**MOVE-LATER tickets** (one per row, or grouped): T3a, T13, T14, T18 (after U1);
C7, C8, C14 + P8; C16 + K4; P2 + P3; S4, S5, S9, S18; A11b; K1, K6, K8, K9 + K11,
K10, K14; M3; X2, X7, X10, X11, X13.

---

## 4. Risks and wire-compatibility

### Old desktop ↔ new box (K2)

Every proposal is **additive**: new fields on existing responses/frames, new
channels, opt-in request flags (`{view:true}`, `scope:"all"`, flagless launcher
spawn). Existing channel names, response shapes and frame payloads are
unchanged. So an old desktop on a new box keeps its client-side derivation and
keeps working. Three items need explicit care:

- **C10 (read-only job refusal)**: an old desktop that today lets a user type
  into a non-`work` job gets a refused send. This is intended (the old desktop
  hides the composer there anyway). The refusal must come back as a normal
  `{ok:false, error}` the old desktop already shows.
- **G5 (last-PR cache)**: changes what `forge:pull-request` returns on a rate
  limit (`pr` present + `stale:true`, where today it is `pr:null`). Old desktop
  renders the PR instead of flipping — strictly better, no shape change.
- **M2 (opt-ins to config)**: iOS deprecated opt-ins move from UserDefaults to
  config `optInModels`. A one-time seed from the device is needed so a user
  does not lose them. Desktop already used config.

### New client ↔ old box (the real hazard)

D23 deletes client logic. A new desktop or iOS build talking to a box that
predates a channel would lose the feature, or worse, show a dead control.
Required:

- Add `capabilities` to `GET /api/version` (U5). Every moved surface checks for
  its capability. If it is missing, the surface follows the no-dead-control
  rule: it is hidden, or shown disabled with "Update your box to use this"
  (that copy is static, so it can live in the client).
- Alternatively, raise the compatibility matrix minimum box version for the
  release that removes client logic. That is coarser, and it blocks the whole
  app rather than one feature.
- Do **not** keep a fallback copy of the old client logic "for old boxes". That
  recreates the parallel implementation D23 forbids. Boxes self-update, so the
  window is short.

### Latency, offline and streaming

- **Streaming (T1, T2, T4)**: the summary must be produced by the box as frames
  arrive, never fetched per frame. The `toolRun` frame is re-emitted per tool
  state change, a few per second at most. Row ids must stay derived from data
  (iOS AGENTS §6), so run ids come from the first part id.
- **Polling (A1 at 3 s, G1 at 5 s)**: memoize server views on cheap change keys
  (last message time, outbox/page mtimes, PR etag). Otherwise the box re-derives
  per poll per client.
- **Offline / degraded mode**: iOS lets the user type while the box is
  unreachable (02 F6 `.resolving`). None of the moved items are needed to
  compose. The views simply show their last fetched state. The time-relative
  labels (T21 `staleAt`, A3 expiry, M14 chips, K3 "ago") keep a server-supplied
  **instant** and do the comparison locally. That avoids a stale "5m ago" while
  the rule itself stays server-owned.
- **Payload size**: the structured diff (G10) can be about 3× the raw diff. The
  transcript `view` (U1) adds about 150 B per tool part. Both are opt-in or
  capped.

### Desktop behaviour changes (call out in the PR body)

- G5 — the PR sheet no longer flips to "Create pull request" on a rate-limited
  poll.
- G10 — review threads on context lines are no longer dropped.
- M15 — the last armed conversation can be disarmed.
- M17 — "Remind me at reset" can no longer schedule a reminder a year away.
- M16 — 90%/limit alerts come from the box. If push is enabled for them, that is
  a new notification type: decide before shipping.
- T21 — the stale-cache warning now appears on iOS (it could never flip before).
  On desktop the warning moves from a client timer to a server instant.
- C5 — desktop error lines get exactly the box's wording (unchanged text, new
  source).

### Anomalies found while auditing

- **T21**: the `cache` frame is computed only at step end, so `isStale` is false
  at emit time. iOS reads `isStale` and therefore never shows the stale-cache
  warning while a session sits idle.
- **D7 vs D23**: WS09 F4 keeps desktop on its own derivation plus a parity node
  test. Under D23 the desktop must switch.
- **iOS keeps device-local deprecated opt-ins** (`DeprecatedModelOptIns.swift`)
  while the desktop uses config `optInModels`. The two disagree today.
- **iOS has four separate token formatters**, and 02/09 plan a fifth and a sixth.
  This is a client-hygiene item, independent of D23.
