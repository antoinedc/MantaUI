# Code review — WS07 artifacts / agent-file notice / webhooks / secrets scope

Commit `7fcb89e6` ("feat: WS07 artifacts — box artifacts:list (lru-cache) …").
Read in full: `src/server/artifacts.mjs` (+ test), `src/server/media.mjs` diff
(+ test), `package.json`, `src/shared/artifactsTypes.ts`,
`src/renderer/{artifacts.ts, ArtifactsPanel.tsx (diff), MediaBody.tsx (diff),
api/demoArtifacts.ts}`, `ArtifactsPanel.server.test.tsx` (test list),
`_appliers/ws07-ib-rows.patch`, and every iOS file in the commit:
`ArtifactModels`, `ArtifactPresentation`, `ArtifactAgentFileModel`,
`ArtifactAgentFile`, `MantaAPIClient+Artifacts`, `SessionResourceCards`,
`WebhookModels`, `WebhooksCard`, `ChatOverflowSheet` (diff + header), and the
tests (`ArtifactAPITests`, `ArtifactAgentFileStoreTests`, `ChatOverflowGateTests`,
`SecretScopeTests`, `ArtifactPresentationTests`; wire/agent-file/webhook tests
skimmed against the implementation).

Checks run here: `node --test src/server/artifacts.test.mjs src/server/media.test.mjs`
→ 59/59 pass; `vitest run ArtifactsPanel.server.test.tsx artifacts.test.ts
ArtifactPreview.test.tsx` → 20/20 pass; `git apply --check` of the IB patch → clean.

## What is right (no action)

- **Server path safety / leakage.** The outbox is read scoped
  (`listOutbox(undefined, { sessionID })` in the IB patch — the session id is only
  compared to a directory name, never joined into a path); hosted pages and outbox
  rows are filtered by `sessionID === sid`; plan-page resolution never falls back
  to the deterministic URL on a subdomain collision; plan `href` is
  `sessionDirectory + rel` where `rel` matches `\.opencode/plans/[\w.-]+\.md` (no
  separator, no traversal) and is only ever handed to the home-scoped `/api/peek`.
  Cache and in-flight map are keyed by session; the derivation key compare makes a
  cross-session or stale hit impossible. Errors are the two safe literals
  (class-1); optional-source failures are logged and named in `degraded`.
- **Cache.** `lru-cache` 11.5.3 with `ttl`, no `updateAgeOnGet`, `ttlResolution: 0`
  and `perf.now` wired to the injected clock; `degraded`, expiry state and counts
  are recomputed per response; the fake-clock tests cover every invalidation the
  spec lists.
- **media.mjs.** One table; `guessMime` keeps its octet-stream fallback; the only
  consumers (`saveMedia`/`showMedia` return values, `mediaKindFromMime` on both
  clients) key on `image/`/`video/`, so the eight new rows change no rendering.
- **Desktop.** No derivation left in `src/renderer` (only the `planRefsFromPart`
  copy in `chatUtils.ts`, which the IB patch deletes); latest-request-wins guard,
  unknown-channel → "Update your box to use this.", `rpc` (not `rpcOptional`) in
  the patch. The old "Open plan file" button actually opened the PAGE (it went
  through `openRow`); the new one opens the file — a fix.
- **iOS.** All referenced symbols exist with the pinned signatures
  (`ComposerTextController.attach/acceptsInput/lastAttachRejection`,
  `ComposerInsertion.AttachRejection` (3 cases, switch exhaustive),
  `SessionModeRows(current:launchers:catalog:onSelect:onRetry:)`,
  `SessionLauncherCatalog.loading`, `TranscriptDisplayOptions.defaultsKey/setShowDetails`,
  `MantaStreamFrame.kind/decodedPayload`, `addRawFrameHandler`,
  `SessionListStore.window(forSessionID:)/hapticsEnabled`, `SessionHaptics.fire`,
  `MantaEventStore(stream:tokenProvider:serverProvider:)`). No type-name
  collisions (each new type declared exactly once; nothing still references the
  deleted `ArtifactDerivation` types). `MantaAPIClient` is `Sendable`, so the
  nonisolated `ArtifactBytes.load` calls are clean under Swift 6. Package-safe
  files only reference package-listed types. The remote fetch uses its own
  ephemeral session with no `Authorization`, no cookies, 2xx-only. The notice
  machine matches every rule and interleaving in the spec; the store really
  deletes staged directories and the Xcode tests assert it on disk. Overflow
  mounts match M-01-5 / M-02-2 / M-04-1 / M-04-2 exactly (sibling Section, all-three
  gate, read-only hides the whole Compact/Fork/Rename section and Clear/Delete),
  and WS02's ChatScreen call sites match the provider signatures.

## Findings

1. **SHOULD — a failed presentation silently returns the notice to idle.**
   `ArtifactAgentFile.swift:117-121` (no `presenter`) and `:432-435` (`topMost`
   returns nil) both end in `presentationFinished(…, completed: false)`: the user
   taps Save, sees "Saving…", and the notice goes back to its idle state with no
   message — indistinguishable from a dead button (AGENTS "NEVER STUB A CONTROL").
   Rare, but it is a reachable failure path.
   **Fix:** add `mutating func presentationUnavailable(token:opID:fileURL:) -> AgentFileEffect`
   to `AgentFileNoticeMachine` (match → `.failed("Couldn't open the \(op == .save ? "save" : "share") sheet — try again.")`
   + `.deleteTemp(fileURL)`; mismatch → `.deleteTemp(fileURL)`), call it from both
   paths instead of `presentationFinished(completed:false)`, and add a machine test
   (match → failed + delete; stale → delete only) to `ArtifactAgentFileTests`.

2. **SHOULD — a revoke that fails while the reload also fails leaves the hook
   hidden.** `WebhooksCard.swift:203-213`: the row is removed optimistically; on a
   `deleteWebhook` error the card shows "Couldn't revoke …" and calls `load()`, but
   `load()` keeps the old (already-pruned) `hooks` when it fails, so a webhook that
   still exists — and can still wake the session — disappears from the list.
   **Fix:** capture `let previous = hooks` before the optimistic removal; in the
   `catch`, `hooks = previous` before `await load()`.

3. **SHOULD — desktop: a first-load failure renders the "No links yet" empty state
   under the error banner.** `ArtifactsPanel.tsx` (the `groups.length === 0` branch,
   ~:1035): the loading guard is `!(result…) && !loadError`, so with `loadError`
   set and no result the panel falls through to `emptyBig(tab)` + `emptySub` with
   all-zero counts — it asserts "no links, 0 images, 0 files" for a list it never
   received. **Fix:** when there is no current-session result and `loadError` is
   set, render nothing in the list area (the banner + Retry is the whole state);
   add a case to `ArtifactsPanel.server.test.tsx` ("another error → … and no
   empty-state copy"). While there, the banner reads "Couldn't load artifacts.
   Couldn't read this conversation's artifacts" — drop the prefix when the message
   is the box's safe literal, or show only the prefix (NIT-level copy).

4. **SHOULD — iOS: staged bytes are reused for the life of the card.**
   `SessionResourceCards.swift:777` / `:831` / `:916`: `stagedFiles[item.id]` is
   never invalidated, so "Open plan file" (and Share / Attach) keep showing the
   first-fetched copy after the agent rewrites the plan or re-pushes a same-path
   outbox file while the card is open (the 3 s poll updates the row, not the bytes).
   **Fix:** key the staging cache by a revision, e.g. store
   `stagedFiles[item.id] = (url, rev)` with `rev = "\(item.at)|\(item.size ?? -1)"`
   and treat a rev mismatch as unstaged; for `.plan` items (no size, `at` only moves
   on a new reference) always re-stage on "Open plan file".

5. **NIT — an older in-flight derivation can overwrite a newer cache entry.**
   `artifacts.mjs:575`: when the key changes mid-derivation a second derivation
   starts; whichever finishes last wins `cache.set`. Correctness holds (the key
   compare turns it into a miss) but it costs one extra full read. **Fix:** only
   `cache.set` when `inflight.get(sid) === mine` (or when no newer key is cached).

6. **NIT — patch comment placement.** In `ws07-ib-rows.patch`, the
   `"artifacts:list"` handler is inserted between the `outbox:list` doc comment and
   its handler, so that comment now sits above the wrong channel. **Fix:** insert
   the handler (with a one-line comment of its own) after the `outbox:list` block.

7. **NIT — `webhook:list` with an empty session id lists every hook on the box.**
   The server maps `""` to "all" (`rpc.mjs:2516`). iOS always passes
   `store.sessionId`, but a blank id would show other sessions' hooks with Revoke.
   **Fix:** `listWebhooks(sessionId:)` returns `[]` for a blank id.

8. **NIT — staged agent-file write runs on the main actor.**
   `ArtifactAgentFile.swift:99` writes the whole download on the MainActor task;
   a large file stalls the UI briefly. **Fix:** do the `stage` write in a
   `Task.detached`/nonisolated helper and hop back for `downloadFinished`.

9. **NIT — `Package.swift` still lists the deleted files.** `ArtifactDerivation.swift`
   / `ArtifactDerivationTests.swift` remain in the manifest, so `./verify.sh` is red
   until IB applies M-07-4 (expected by the ledger; recording it so IB does not miss
   it — the applier patch covers only the server/desktop rows).

Counts: BLOCKING 0 · SHOULD 4 · NIT 5.

VERDICT: APPROVE
