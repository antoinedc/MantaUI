# Integration notes (orchestrator scratch)

## Package.swift manifests reported by implementers
- WS03: sources `ComposerInsertion.swift`, `ComposerModels.swift`; tests `ComposerInsertionTests.swift`, `ComposerModelsTests.swift`.

- WS01 (M-01-6): sources `TranscriptMediaModel.swift`, `TranscriptTurns.swift`, `TranscriptDisplayOptions.swift`; tests `TranscriptParityTests.swift`.

- WS10 (M-10-3): sources `MantaPairingModels.swift`, `SettingsWireModels.swift`, `SettingsAppearance.swift`, `SettingsBackupModels.swift`, `SettingsUpdatesModels.swift`, `SettingsNotificationModels.swift`, `BoxPairingModels.swift`, `BoxDevicesModels.swift`, `ExtensionsModels.swift`; tests `SettingsAppearanceTests.swift`, `SettingsBoxTests.swift`, `SettingsExtensionsTests.swift`, `SettingsUpdatesTests.swift`, `SettingsBackupTests.swift`, `SettingsNotificationReminderTests.swift`.

- WS04 (M-04-8): sources `SessionModels.swift`, `SessionForgeModels.swift`, `SessionCreateLogic.swift`, `SessionModeLogic.swift`, `SessionCloseLogic.swift`, `SessionSwitcherLogic.swift`, `SessionRouteLogic.swift`, `CloneFromGitHubLogic.swift`, `CloneFromGitHubSignInLogic.swift`; tests `SessionModelsTests.swift`, `SessionsTests.swift`, `CloneFromGitHubTests.swift`, `GitHubDeviceSignInTests.swift`.

## Review follow-ups
- WS10: Mac compile risks: `SettingsNavRow` @ViewBuilder let init; `confirmationDialog(presenting:)`. Theme via `.preferredColorScheme` on NavigationStack — check on device.
- WS10: desktop resetAllPayload now writes hapticsEnabled:true — OK.
- node_modules in worktree is a broken symlink farm → run `npm ci` after A2 finishes (before typecheck).
- REPORT TO USER: server treats revoke with empty device_id as whole-box reset; client now guards; propose server 400 on empty string (outside D7).
- REPORT TO USER / follow-up tickets: read-only-job guard does not cover clear/delete/handoff or server-injected prompts (schedules/webhooks/peers).
- REPORT TO USER: desktop "Edit last" queued message without box snapshot → "text couldn't be recovered" (was local fallback).
- REPORT TO USER: desktop "Open plan file" now opens markdown preview (row tap still opens page).
- Follow-up: routingCatalog matcher deletion after endpoint eligibility moves to box (WS09 deferred).
- npm: modelLedger.test.mjs timing flake (passes alone) — re-check at final verify, compare origin/main. to verify at integration
- WS03: `agentsLoadError`/`retryAgents` are private nil stubs in ComposerView until M-03-6 (IB).
- WS01: footer may briefly show under a running turn until WS02 passes `running` (M-01-x) — confirm in WS02.
- WS01: Mac compile risks flagged: `sending UIImage?` in TranscriptMediaThumbnail; Task captures in TranscriptSelectTextSheet / TranscriptFileStager.
- WS01: media tool-name matcher accepts `media_show` suffixes; confirm against a real V2 transcript.
- WS03: `.quote` insert returning false because composer read-only shows "Nothing to quote" — revisit when M-03-7 lands (message should say read-only).
- WS06 (IB, MUST APPLY, order 07 → 09 → 06): `_appliers/ws06-appliers.diff` (types.ts, api.ts, rpc.mjs = M-06-dsk-1/2, M-06-srv-1) applies clean to HEAD and MUST land before any build/release of this branch — the committed desktop palette sends `scope:"all"`, which the committed rpc handler answers `degraded:true` until M-06-srv-1 is applied. M-06-srv-2 is NOT in the diff (the one-line `BOX_CAPABILITIES` array is edited by WS07/WS09's rows too): append `"search-scope-all-1"` to `BOX_CAPABILITIES` in `src/server/boxCapabilities.mjs` after their ids, and add `assert.ok(BOX_CAPABILITIES.includes("search-scope-all-1"))` to `boxCapabilities.test.mjs`.
- Follow-up (out of WS06): `cto.mjs:412` (CTO search) maps only `hits`, so a box-side `degraded:true` reads to the model as "no matches" — pass `degraded` through.

## REMIND USER AFTER EVERYTHING SHIPS (user request 2026-10-28)
Gaps shipped as-is:
- Reconnect link: can't re-sign the box's OWN login from the app (server refuses live-seat); shows instructions (`claude auth login`). One-click needs a server change.
- Codex re-sign via Disconnect→Connect unverified (copy gated on a test).
- `@@` popup shows "No matching agents" when the agent catalog fails to load (agentCatalog.ts has no error state).
- Decline fix: a settled approval id stays suppressed for the session.
- Read-only-job 409 guard doesn't cover clear/delete/handoff or server-injected prompts (schedules/webhooks/peers).
- ReviewPane "Open on GitHub" only when caller passes prUrl (ArtifactsPanel doesn't).
- Using opencode V2 saved permission rules (GET /api/permission/saved) to restore a SAFE auto-cover for delegate approvals.
Follow-ups to file:
- 30 MOVE-LATER items in server-first-audit.md.
- Delete routingCatalog matcher once endpoint eligibility moves to the box.
- CTO search should pass `degraded` through (cto.mjs ~412).
- WS09 NIT 14 (box writes resolve ok:false instead of rejecting) + NIT 15 (desktop hydration retry).
- Pre-existing flakes: tests/unit/e2e-smoke.test.ts playwright 5s timeout; upgradeV2Reclaim inode test under load; modelLedger timing.
- (from bug-fix reviews) Jobs started with NO approval card and NO access rules → opencode default permissions: CTO work dispatch/review and the inbox "Delegate in background" button (same class as BET-1519).
- (from bug-fix reviews) Approval card: clearing every tool then Start → box falls back to the tool's own requested list instead of granting nothing.
- (from bug-fix reviews) iOS has no delegate approval card → a job raised from iOS just times out.
- (WS05) A rate-limited PR list read with no last-PR cache returns draft:null (clients keep their snapshot).
