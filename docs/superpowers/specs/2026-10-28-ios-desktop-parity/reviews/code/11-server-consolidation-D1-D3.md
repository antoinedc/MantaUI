# Code review — WS11 server consolidation, steps D1–D3

Scope: commits `03b13276` (D1), `af5ee7b6` (D2), `1842766a` (D3) on
`feat/ios-parity-server-consolidation`, read from the committed tree (`git archive 1842766a`),
not the live worktree. D4–D11 are out of scope and not flagged.

Checks run on the `1842766a` snapshot: `npm run typecheck` clean; node tests
(serverFirstGuard, boxCapabilities, sessionContext, settingsViews, upgradeView,
launchersConfig, streamInterp, rpc, upgradeV2, rpc.delegateView, ptyWs) 308/308 pass; vitest
(useBoxCapabilities, UpgradeGate, ChatPanel.cacheContext, ChatPanel.handoff, upgradeGateLogic,
updateTargets, chatUtils, chatShared, demoCoverage) 793/793 pass. Swift was read, not compiled
(no toolchain on this box).

Overall: the server modules are clean and well tested, wire changes are additive, and each step
does delete its client copies (the guard table enforces most of them). Swift 6 isolation looks
right: `BoxCapabilitiesStore` is `@MainActor`, the loader closures are `@Sendable` and capture only
`Sendable` values, its `Task`s inherit the main actor, and no test uses `XCTAssert(await …)`. I
found no default-argument or nested-function isolation traps. Two behaviour bugs need fixing.
Both affect what a user sees on an older box, or when an update check fails.

---

## BLOCKING

### 1. Desktop: a failed update check tells the user to update their box
`src/renderer/Settings.tsx:323` with `src/renderer/updateCheck.ts:63`, `src/shared/updateTargets.mjs`

When `server:update-check` rejects or times out, `refreshUpdateTargets` passes
`serverCheck = null`. `buildUpdateTargets` then builds a server row with no `view`, and
`UpdateTargetRow` treats `!target.view` as an older box. So the row shows "Update your box to use
this" instead of "Couldn't check". D1 ("a failure is never evidence of an old box") and the D3
fallback table both forbid this. iOS handles the same case correctly (`checkFailed` vs
`needsBoxUpdate` in `SettingsUpdatesStore`).

There is also a related bug that predates this work: with `serverCheck == null`, `ok:
serverCheck?.ok !== false` evaluates to `true`.

**Fix:**
- In `buildUpdateTargets`, set the server row to `ok: serverCheck != null && serverCheck.ok !== false`.
- In `UpdateTargetRow`, set `oldBox = target.id !== "desktop" && !target.view && target.ok`.
- When `!target.ok` and there is no view, render `describeUpdateTarget(target)` (error tone, "Couldn't check").

Add a vitest: when the update-check RPC rejects, the server row shows "Couldn't check" and no update note. Add a second vitest: when a verdict arrives without `view`, the row shows the note.

### 2. Older box: CLI sessions silently lose their launch options (spec's stated fallback is false)
`src/renderer/App.tsx:2176`, `mobile/native/MantaUI/TerminalScreen.swift:58` (plus `SessionModeLogic.swift` `SessionPtyLauncher`)

Both clients now always spawn with `{id}` and no `flags`. The spec says "old box uses defaults",
but a pre-D3 box does not do that. Its `pty.mjs` runs `def.buildArgs(launcher.flags || {})`, and
`buildArgs` only adds an arg when `values[key]` is truthy. So on an older box, Claude Code starts
**without** `--dangerously-skip-permissions`, even though that flag's registry default is `true`
and the user's saved choice may also be `true`. Nothing tells the user; they just start getting
permission prompts.

**Fix (no client rule copy needed):** the old box's own `launchers:list` row still carries each
flag's `default`. When any flag in the row lacks `value` (an older box), send
`{id, flags: Object.fromEntries(flags.map(f => [f.key, f.default]))}` on desktop. On iOS, send
`SessionPtyLauncher(id:, flags:)` built the same way from `sessionStore.launchers`. When `value` is
present (a new box), keep sending `{id}` only.

Add tests:
- vitest for the desktop launcher payload, old row vs new row.
- XCTest for `SessionPtyLauncher.queryJSON`, old row vs new row.

Correct the spec's fallback cell to match.

---

## SHOULD

### 3. A second iOS capability reader survives in `GitForgeStore`
`mobile/native/MantaUI/GitForgeStore.swift:34`

`capabilities: { Set(try await api.apiVersion().capabilities ?? []) }` reads `/api/version`
directly. That bypasses `BoxCapabilitiesStore`: it gets no three-state handling, no shared
request, no backoff and no reset on a box change. D1 requires every wave-C `Git*` store to move to
the store.

**Fix:**
- Inject the app's `BoxCapabilitiesStore` (or a `@MainActor` closure over `has(_:)`) into `GitForgeStore`.
- Map `.loading` / `.failed(nil)` to "unknown", not to an empty set.
- Add a guard row that forbids `apiVersion()` outside `BoxCapabilitiesStore.swift` / `MantaAPIClient.swift`.

### 4. Hidden per-screen capability stores (each with its own endless retry loop)
`mobile/native/MantaUI/ChatSessionStore.swift:456` (`capabilities ?? BoxCapabilitiesStore(api: api)`)

Two callers rely on this default:
- the read-only child-transcript store, `ChatScreen.swift:~1950`;
- `HandoffViews.swift:~501`.

Each therefore builds a private store that issues its own `/api/version` call. On failure, each
retries every 10 s until the screen deallocates.

**Fix:**
- Make the `capabilities:` parameter non-optional, or default it to a shared instance.
- Pass the `@EnvironmentObject` store down at both call sites.
- Tests can keep the explicit `BoxCapabilitiesStore(load:)` seam.

### 5. Desktop never resets the capability list on a box change
`src/renderer/hooks/useBoxCapabilities.ts:65`

`resetBoxCapabilities()` is only called by tests. If the user re-pairs to a different box and the
first read fails, `failed` keeps `prev.ids` and `loadedOnce`, so the old box's capabilities gate
the new box's surfaces.

**Fix:** call `resetBoxCapabilities()` where the pairing or box identity changes (the
`apiGeneration` bump in `App.tsx`, before `refreshBoxCapabilities()`). Add a test: switching box
with the read failing returns `null`, not the old ids.

### 6. 401 retries forever on both clients
`src/renderer/hooks/useBoxCapabilities.ts:48`, `mobile/native/MantaUI/BoxCapabilitiesStore.swift:69`

The spec says "a 401 follows the existing sign-in path". Today `AuthRequiredError` /
`MantaError.authRequired` lands in `failed` and is retried on the 1→2→5→10 s schedule
indefinitely. Both retry loops also keep running while the stream is disconnected.

**Fix:**
- Do not schedule a retry on an auth error; the existing sign-in flow takes over.
- Optionally pause the retry while the connection is not `connected`, since the reconnect refresh covers it.

### 7. iOS cannot decode the box's context when the selected model's limit is unknown
`mobile/native/MantaUI/MantaStreamModels.swift:309`

`StreamContextPayload.pct` is a non-optional `Double`, but `computeContextBreakdown` sends
`pct: null` whenever `hasLimit` is false. That happens:
- for a selected model opencode doesn't list;
- on the first `contextLimitFor` call, before the model limits are cached.

Decoding fails (`MantaEventStore.swift:287` uses `try?`, as does the RPC path), so the meter goes
blank and the existing `!ctx.hasLimit` UI (`ChatScreen.swift:1376`) can never be reached. This bug
existed before D2, but D2 made the box the only source.

**Fix:** declare `pct: Double?` and update the consumers (`contextPct`, `shouldShowContext`). Add a decode test with
`"pct":null,"hasLimit":false`.

### 8. Decision 4 ("last reply's model" label) is not implemented; the iOS sheet can name a different model than the one measured
`mobile/native/MantaUI/ChatScreen.swift:1453`, desktop `SessionHeader.tsx` context popover

The box sends `model` and `basis`, but neither client labels the sheet "(last reply's model)" when
`basis == "last-used"`. iOS still passes the client-computed `activeModelName`, which can disagree
with `ctx.model`, for example while the selection hasn't reached model-prefs yet, or when the box
used `config.defaultModel`.

**Fix:** derive the sheet's model line from `ctx.model` (catalog label lookup) and append
"(last reply's model)" for `basis == "last-used"`, on both clients. Add tests on both clients.

### 9. A model switch doesn't re-measure a session the interpreter hasn't seen since boot
`src/server/rpc.mjs:2587` → `streamInterp.reemitContext`

`reemitContext` returns silently when `sessions` has no state, or no `lastStepTokens`, for that
session. That is the case for any idle session after a manta-server restart. The D2 acceptance
check ("switch 200k → 1M: both clients change within one frame") then fails until the next turn.

**Fix:** in `model-prefs:set`, when the interpreter has no state for the session, compute the
payload the same way `opencode:context` does and publish a `{kind:"stream", sub:"context"}` frame.
Add an rpc test covering `model-prefs:set` for both a known session and an unknown one.

### 10. Desktop update rows still compute the version text and status wording locally
`src/renderer/Settings.tsx:325` and the action branch below it

For box and CLI rows the desktop takes only `view.tone` from the box. Everything else is local:
- `hasUpdate` is computed from `latest !== current`;
- the version text is rebuilt locally, and differs from the box's `versionText` when `current` is null;
- "Up to date" / "Couldn't check" are hard-coded strings.

X3's acceptance check ("renders box text identically on desktop and iOS") is therefore only met by
coincidence.

**Fix:** for non-desktop rows, render `target.view.text`, `target.view.versionText` and
`target.view.hasUpdate`. Keep the local derivation only for the Electron row.

### 11. `/pty` WebSocket: async launcher resolution can leak a PTY
`src/server/ptyWs.mjs:127` (and the close handler at `:156`)

When a launcher arrives without `flags`, the spawn now waits on a config read. During that wait,
two things can go wrong:
- If the socket closes, the close handler's `kill(sessionKey)` runs first and does nothing. The spawn then proceeds and leaves an orphan CLI process with no socket.
- `data` / `resize` frames that arrive before the spawn are written to a PTY that doesn't exist yet, and are dropped.

**Fix:**
- Track `let closed = false` (set it in the close handler) and skip `spawnWith` when it is set.
- Queue control frames until the spawn has happened, or chain the message handler on the same spawn promise.
- Add a ptyWs test: close before the resolve finishes → no spawn.

### 12. Older box mid-failed-upgrade: the gate is a dead end
`src/renderer/upgradeGateLogic.ts:307-309`, `mobile/native/MantaUI/UpgradeModels.swift:409-411`

This is spec-conformant (D3 fallback: "Retry/Rollback hidden"), but there is a consequence to
decide on deliberately. Any box stuck in a failed V2 migration today is running a pre-D3 release,
because the box doesn't self-update while it is stuck. A user who updates their desktop or iOS app
then gets a full-screen gate with no way out.

**Suggestion:** when `view` is absent, still offer Retry. `POST /api/upgrade/retry` already refuses
with the box's own sentence, and the client already shows that sentence, so no client rule is
needed. Roll back can stay hidden. This needs an orchestrator/spec decision; flagged rather than
required.

### 13. Tests the spec lists are missing
- iOS `UpgradeStoreTests`: a fresh client mid-migration (`running` and `failed`) with the capability list `loading` / `failed` renders from `/api/upgrade` alone (spec D1, Tests). The desktop half was added.
- An rpc-level `model-prefs:set` → `context` frame test (spec D2 Tests; only the interpreter-level re-emit is tested). See #9.
- A route-level `DELETE /auth/revoke` test for blank vs absent `device_id` (only the pure `hasBlankDeviceId` is tested).
- A `writeVersionResponse` vs `server:version` same-list assertion (spec D1). Only the RPC side is compared with `BOX_CAPABILITIES`.

---

## NIT

14. `mobile/native/MantaUI/UpdateBoxNote.swift:22`: `.settings(section: "updates")` is not a Settings section id. The ids are `general`, `box`, …, and "Software updates" (`updatesMobile`) lives in `general`. `SettingsDeepLink.target` drops it and Settings opens at the top. Use `"general"` (the typo is in the spec too).
15. Guard table gaps (`serverFirstGuard.test.mjs`):
    - iOS: the deleted `enum ExtensionsForge` and `UpgradePresentation.(details|currentStep|fraction|etaText|diskText|sentence|bytes)` are not guarded.
    - Desktop: `upgradeGateLogic` `currentStep`, `stepFraction`, `diskSentence`, `NO_ROLLBACK_STEPS`, `CHECK_AGAIN_STEPS` are not guarded.
16. The desktop `UpdateBoxNote` migration is incomplete: `ModelsCard.tsx:248` and `UsageResumeModal.tsx:161` still inline the string. There are also three copies of the note text: `UPDATE_BOX_NOTE` in the hook, `UPDATE_BOX_NOTE_TEXT`, and `UPDATE_YOUR_BOX`.
17. `mobile/native/MantaUI/BoxDevicesScreen.swift:147`: on an older box, `UpdateBoxNote()` is rendered on every row. The spec asks for one note under the list.
18. `launchers:list` (`rpc.mjs:2842`) now rejects entirely if `configGet()` throws, which hides every launcher. Catch the error and fall back to registry defaults.
19. `ContextSheet.staleLine` (`UsageSheets.swift`) uses `Date()` with no timer, so an open sheet doesn't flip at `staleAt`. Pass the parent's `cacheIsStale` instead.
20. Stale comments: `ExtensionsLaunchersScreen.swift:7` and `ExtensionsForgeScreen.swift:7` still cite deleted helpers. `store.ts` `launcherFlags` is now unused for spawns; drop it or document it as legacy.
21. `chatUtils.ts:288`: there is an `import` in the middle of the file; move it to the import block.
22. `ChatPanel.cacheContext.test.tsx` uses a real 700 ms `setTimeout`. Fake timers would keep the suite fast and deterministic.

---

## Implementer deviations (observed in the diff; the commits carry no notes)

| Deviation | Verdict |
|---|---|
| iOS `apiVersion()` in `MantaAPIClient.swift`, not `+Settings` (needs private transport members) | OK, justified |
| Desktop slice adds `loadedOnce` (answers from the last loaded ids while `failed`) | OK, implements "keep last loaded" |
| `GitForgeStore` reads `apiVersion()` directly | Not OK, see #3 |
| `ChatSessionStore` keeps an optional `capabilities` with a private-store fallback | Not OK in production paths, see #4 |
| `describeUpdateTarget` + `formatBytes` moved to `src/shared/` (one implementation) | OK |
| `forge:status.secondary` only on `connected:true`; old-box fallback `@login` / "connected" | OK (spec: "login only") |
| `UpdateBoxNote(showsLink:)` hides the link where Settings is unreachable (upgrade screen) | OK, avoids a dead control |
| iOS Updates screen adds "Couldn't check for updates. Try again." on `verdict == nil` | OK, the right three-state split (desktop lacks it, #1) |
| `pty:spawn` became async to resolve launcher flags on the box | OK for RPC; the WS path has #11 |
| Old-box upgrade gate hides Retry/Rollback on both clients | Spec-conformant, see #12 |

VERDICT: CHANGES REQUIRED
