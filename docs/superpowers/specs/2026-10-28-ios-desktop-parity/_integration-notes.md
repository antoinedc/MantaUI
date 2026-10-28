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
- npm: modelLedger.test.mjs timing flake (passes alone) — re-check at final verify, compare origin/main. to verify at integration
- WS03: `agentsLoadError`/`retryAgents` are private nil stubs in ComposerView until M-03-6 (IB).
- WS01: footer may briefly show under a running turn until WS02 passes `running` (M-01-x) — confirm in WS02.
- WS01: Mac compile risks flagged: `sending UIImage?` in TranscriptMediaThumbnail; Task captures in TranscriptSelectTextSheet / TranscriptFileStager.
- WS01: media tool-name matcher accepts `media_show` suffixes; confirm against a real V2 transcript.
- WS03: `.quote` insert returning false because composer read-only shows "Nothing to quote" — revisit when M-03-7 lands (message should say read-only).
