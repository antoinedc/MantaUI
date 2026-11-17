# iOS stability, battery, and status freshness

Date: 2026-11-17 · Branch: `fix/ios-stability-status-freshness` · Base: `origin/main` 75e9961f

## Problem

Users report that the iOS app crashes often, feels slow, drains the battery, and that the
running / waiting indicators are not always current (on iOS and on the desktop).

Evidence (2026-11-17):

- Crashlytics, last 30 days: 3 fatal events (1 real, 1 from a UI-test run, 1 from a debug build).
  Builds 1.2.0 and 1.3.0 have reported none. Crashlytics cannot see the OS killing the app for a
  main-thread hang, for memory, or for CPU/energy. The app has no MetricKit hook, so those kills
  are invisible. The reported "crashes" are most likely these.
- The one real crash is `closure #4 in UpgradeStore.bind(eventStore:)` (EXC_BREAKPOINT, iOS 27.0.1,
  app 1.1.0). It is still present on main. `UpgradeStore` is `@MainActor`, and Swift 6 checks that
  its Combine `.sink` closures run on the main thread. The `.mantaBoxUpgrading` notification is posted
  from a URLSession background thread (`MantaAPIClient.swift` ~1001, `BoxRESTClient.swift` ~153).
- Code audit (iOS): every streaming chunk from any session causes the main event store to publish
  its whole per-session dictionary. The app root, the session list and both chat layers observe the
  whole store, so they all redraw for every chunk of every session. Each frame is decoded three times
  on the main thread. The Keychain is read on the main thread on every chat redraw. Long answers cost
  O(n²) per turn. About nine timers and polls run while a chat is open (several every 3–5 s).
- Code audit (box): `/events` sends every bus envelope to every device unfiltered. That includes raw
  `opencode` events, `pty` output from other sessions, CTO state, and a `status` batch every 2 s.
- Code audit (status freshness, affects all clients):
  - pending questions/permissions are not re-read on the box's FIRST connection to opencode, only
    on reconnects, so a restart loses them;
  - nothing ever re-checks running/asks state against opencode;
  - a stalled (open but silent) opencode stream is never detected;
  - a question raised inside a subagent shows the parent as "running", not "waiting on you";
  - desktop: a red ?/! badge survives the reconnect replay;
  - iOS: the event socket stops retrying after 10 minutes while the app is in the foreground;
  - iOS: returning from a short trip to the background can keep a dead socket for up to ~60 s.

## Goals

1. Stop the crash; make OS kills (hang, memory, CPU, disk, crash) visible to us.
2. Cut iOS main-thread work and radio traffic sharply: a chunk for session A must not redraw
   anything that isn't showing session A.
3. Make the running / waiting indicators converge to the truth within ~1 minute on every client,
   even after missed events, box restarts or a silent opencode stream.

Non-goals: redesigning any screen; changing transcript row identity or ordering (see
`mobile/native/AGENTS.md` §6, high-risk); APNs push changes; Android.

## Libraries considered

| Need | Chosen | Considered / why not |
|---|---|---|
| Capture OS kills (hang, jetsam, CPU, disk, crash) on iOS | Apple **MetricKit**: `MXMetricManager` + `MXMetricManagerSubscriber` (iOS 13+, still functional on iOS 27, soft-deprecated with no compiler warning) on every OS, plus the iOS 27 `MetricManager.diagnosticReports` async stream under `#if compiler(>=6.4)` + `#available(iOS 27, *)`, which is the only source of memory-exception diagnostics | Firebase Crashlytics: removed its own MetricKit integration (firebase-ios-sdk #16444, 2026-07-27) and never reported SIGKILL terminations. Sentry / Embrace / KSCrash (MIT, KSCrash 3.x has MetricKit OOM support): each is a second crash reporter competing with Crashlytics for the Mach exception port (root AGENTS.md: "do not run both"). We need forwarding only, not a reporter, so first-party MetricKit is the fit. |
| Where diagnostics go | Raw JSON to a new box endpoint (stored on the box, readable by agents), plus one Crashlytics non-fatal per diagnostic for counting/alerting in the console we already read | Crashlytics `ExceptionModel` with MetricKit frame addresses: the addresses come from the dead process (different ASLR slide), so Crashlytics would symbolicate them wrongly. |
| Main-thread → background hop for events (Combine) | Foundation/Combine built-ins: `.receive(on: DispatchQueue.main)` / `RunLoop.main`, `@MainActor` hops | none needed |
| Fine-grained SwiftUI observation | Swift **Observation** (`@Observable`, iOS 17+, already available at deployment target 26) for the new per-session live state objects; existing stores stay `ObservableObject` (out of scope) | Keep everything on `ObservableObject` + `objectWillChange`: that is what makes every observer redraw on every chunk. Third-party state libs (TCA etc.): far too large for this change. |
| JSON decode of frames | Foundation `JSONDecoder` / `JSONSerialization`, decoded once per frame, off the main actor | swift-json / ZippyJSON: not needed once the triple-decode is gone. |
| Keychain caching | In-memory cache inside `KeychainCredentialStore` (a few lines) | KeychainAccess / Valet: wrappers around the same calls; they don't remove the per-redraw reads, the cache does. |
| Server event filtering | Plain code in `src/server/events.mjs` (a predicate per connection) | No library does "filter my own bus envelopes". |
| Periodic reconcile / stall timer | `setInterval(...).unref()` like every other box poller | `croner`, already a dependency, is for wall-clock cron, not a 45 s interval. |

## Contract (pinned — both sides code against this)

### C1. `/events` subscription filter (box ↔ iOS)

Applies to the WebSocket `/events` path (`attachEventsWs`). The SSE path takes only `kinds`.

- **Query parameter `kinds`** (comma-separated envelope `kind` values). When present, the connection
  receives only envelopes whose `kind` is listed. `heartbeat` is always delivered. The connect-time
  snapshot replay is filtered the same way. When absent, everything is delivered (desktop unchanged).
  Unknown kinds are ignored. Max 64 entries; longer lists → the parameter is ignored (deliver all) and
  the server logs a warning.
- **Client → server WS text message** `{"type":"kinds","kinds":[…]}` replaces the connection's
  kinds set at runtime (same limits; an empty or missing list = deliver all). Used by iOS to add
  `pty` only while a Claude sign-in / CLI-install flow is running (`AccountsStore` consumes `pty`
  frames for it) and remove it afterwards.
- **Client → server WS text message** `{"type":"focus","sessions":["ses_…", …]}` (max 32 ids; extra
  ids are dropped). Sets the connection's *focus set*. `kind:"stream"` envelopes whose `sub` is a
  **heavy sub** are delivered only when the envelope's `sessionId` is in the focus set.
  - Heavy subs: `flush`, `toolOutput`, `messageChanged`. (Exported constant `HEAVY_STREAM_SUBS` in
    `events.mjs`.) The desktop never sends focus, so it is unaffected.
  - Before any focus message, heavy subs are delivered for all sessions (back-compat).
  - `{"type":"focus","sessions":[]}` = no heavy subs at all.
  - Every other `stream` sub (`running`, `questions`, `permissions`, `attention`, `turnComplete`,
    `transcriptStale`, `todos`, `subagent*`, …) is always delivered for every session.
  - A `stream` envelope with no `sessionId` is always delivered.
  - The focus filter applies whether or not `kinds` was given.
  - Malformed messages are ignored (never close the socket).
- `heartbeat` is sent by `attachEventsWs` outside the bus; the filter sits in the bus subscriber
  callback only, so heartbeats are never filtered.
- **Ordering rule (client):** when a session is added to the focus set, the client sends the focus
  message FIRST and only then fetches that session's transcript, so no `flush` frame can fall
  between the fetch and the focus taking effect. Overlap duplicates are absorbed by B3's dedupe.
  After every reconnect the client re-sends its kinds and focus messages before relying on frames.
- The pure decision lives in `events.mjs` as an exported, unit-tested
  `createEventFilter({ kinds })` returning `{ accepts(evt), setKinds(list), setFocus(ids) }`.

### C2. Row status: attention below (box → desktop + iOS)

The per-row status object (`sessionStatus.mjs`, `DEFAULT_STATUS`) gains
`attentionBelow: "question" | "permission" | null` — the strongest pending ask (question beats
permission) among the row's descendants at any depth (subagents, background jobs), excluding the
row's own `attention`. Clients show the row as **waiting on you** when `attention ?? attentionBelow`
is non-null, with the same badge they use for `attention` today. Old clients ignore the new field.

### C4. Replay boundary (box → clients, existing behaviour, now relied on)

The connect-time snapshot replay always starts with the `runningSet` frame
(`streamInterp.mjs` ~1237), followed by `attention` / `questions` / `permissions` frames only for
sessions that still ask. Clients treat a received `runningSet` as "replay starts": clear every
session's ask-derived attention, then let the following frames repopulate it. The box keeps
`runningSet` first in the replay (add a test pinning it).

### C3. iOS diagnostics upload (iOS → box)

`POST /api/diagnostics/ios` (Bearer auth, like every `/api/*`).

- Body: JSON `{ "kind": "crash"|"hang"|"cpuException"|"diskWriteException"|"memoryException"|"appLaunch"|"other",
  "appVersion": string, "build": string, "osVersion": string, "device": string,
  "source": "mxdiagnostic"|"metricManager", "payload": <the diagnostic's own JSON> }`.
- Max body 2 MiB → `413 {"error":"too large"}`. Invalid JSON / missing `kind` → `400`.
- Stored at `statePath("ios-diagnostics", "<UTC yyyymmddTHHMMSSZ>-<kind>-<6 random hex>.json")`, dir 0700,
  file 0600, atomic write. Retention sweep (on write and hourly): keep at most 500 files / 50 MiB /
  30 days, oldest first.
- Response `200 {"ok":true,"id":"<filename>"}`. Errors are class-2 (consumed by the app's upload
  loop only, never shown to a user) and carry the `// class-2 (BET-1460): …` marker.
- Not exempt from upgrade mode (a 503 during an upgrade is fine; the app retries).

## Work items

Each item says who owns it: **[S]** = server + desktop renderer worker,
**[A]** = iOS worker A (small, isolated files), **[B]** = iOS worker B (event store / screens).

### Crash and visibility

- **A1 [A] Upgrade crash.** In `UpgradeStore.bind`, every Combine sink that can be fed off the main
  thread receives on main before touching the store (`.receive(on: DispatchQueue.main)` on the
  `.mantaBoxUpgrading` publisher and on `$connectionState`). Also post `.mantaBoxUpgrading` from the
  main actor at both post sites. Audit every other `NotificationCenter.default.publisher(for:)` +
  `.sink` inside a `@MainActor` type: fix `TranscriptDisplayOptions.swift` (A-owned) if needed; for
  the sites in B-owned files (`ChatSessionStore.swift`, `MantaAppRoot.swift`) B applies the same
  `.receive(on: DispatchQueue.main)` fix. Unit test: posting the notification from a background
  queue no longer traps and updates the store.
- **A2 [A] MetricKit forwarding.** New `DiagnosticsReporter.swift` (`@MainActor final class`, started
  once from `MantaUIApp.init()` right after `FirebaseApp.configure()`):
  - subscribes with `MXMetricManager.shared.add(_:)` and handles `didReceive(_ payloads: [MXDiagnosticPayload])`
    (crash, hang, CPU, disk-write, app-launch diagnostics). MetricKit calls this on a background
    queue: implement it `nonisolated`, extract the JSON there, and hop to the main actor with plain
    `Sendable` values (same bug class as A1). Unit test: calling it from a background queue doesn't
    trap;
  - on iOS 27+ (guarded `#if compiler(>=6.4)` + `#available(iOS 27, *)`) also consumes
    `MetricManager().diagnosticReports` and forwards **only** memory exceptions from it (the
    others already arrive through the legacy path; no duplicates);
  - for each diagnostic: build the C3 body, persist it to `Application Support/diagnostics-outbox/`
    (bounded to 20 files, oldest dropped), then upload; delete on 200, keep on any failure, and retry
    the outbox at next launch and on each foreground;
  - also records one Crashlytics non-fatal per diagnostic: `NSError(domain: "MetricKit", code:
    <stable per kind>, userInfo: [reason / termination code / duration if present])`, and sets the
    Crashlytics custom key `last_os_kill` to the kind.
  - Pure parts (building the body from a decoded payload dictionary, the outbox bound) are extracted
    and unit-tested.
- **S6 [S] Box endpoint** per C3 (`src/server/iosDiagnostics.mjs` + route in `index.mjs`), with tests
  for validation, size limit, file mode, retention.

### iOS performance and battery

- **B1 [B] Per-session observation.** The event store keeps each session's live streaming state
  (streamed text, tool rows, todos, progress) in a per-session object that views observe on their
  own (Swift Observation `@Observable`, or one `ObservableObject` per session). A chunk for session X
  must only invalidate views showing X. The store-level published values that the app root and
  session list observe change only on **edges**: running set, attention, connection state, list
  membership. `MantaAppRoot`, `SessionListView` and the chat screens must not observe the whole
  per-session dictionary. Listeners that loop over every session per frame
  (`ChatSessionStore` ~499, `SessionListStore` ~218, `TranscriptMediaStore` ~43) are rewritten to
  react to the session they care about.
- **B2 [B] Decode once, off main.** Each `/events` frame is parsed once (no re-encode/re-decode of
  the payload, `MantaStreamModels.swift` ~123–131), and the parse happens off the main actor; only
  the decoded value hops to main.
- **B3 [B] Streaming without O(n²).** The live text of a part is a single growing buffer (append,
  don't re-join pieces). The duplicate check compares ids/lengths, not full text. Transcript rows are
  republished only when they actually changed. Do not change row ids or ordering.
- **B4 [A] Keychain cache.** `KeychainCredentialStore` caches the loaded credentials in memory;
  writes and deletes update/clear the cache. **[B]** creates the chat screen's API client once per
  screen (not in `body` and not per rebuild).
- **B5 [B] Timers and polls.** Every timer/poll pauses when `scenePhase != .active` or when its
  screen is not visible, and resumes (with one immediate tick) on return:
  - git branch: 5 s → 15 s, chat visible only;
  - git forge status: 5 s → 30 s, chat visible only;
  - approvals: 3 s, only while a turn runs and the chat is visible;
  - session-list age labels: 10 s, list visible only;
  - artifacts sheet: 3 s → 5 s, only while open;
  - usage / accounts: 60 s, foreground only — gated by B at the call sites (start/stop on
    `scenePhase`); B does not edit `UsageStore.swift`.
  **[A]** fixes the `UsageStore` loop so it exits when its owner is gone (no spin without a sleep).
- **B6 [B] Event subscription.** The kinds list is DERIVED FROM REGISTRATIONS, never hand-kept:
  every raw-frame handler registration declares the envelope kinds it consumes
  (`addRawFrameHandler(kinds: Set<String>, …)`), and the event store builds the `kinds=` query
  from the union of registrations (plus the kinds the store itself consumes). A registration made
  after connect sends a C1 `kinds` update. As of base the set is: `heartbeat, runningSet, stream,
  status, delegate.updated, delegate.approval.requested, progress.updated, upgrade, handoff,
  accounts.updated, accounts.moved, model-prefs.updated, models.updated, widget, media, usage.alert,
  usage-stopped.updated, sessions.nesting, agentFile` — verify against the code; the derived set wins.
  `pty` is NOT in the default set: `AccountsStore`'s sign-in / CLI-install flow registers it while the
  flow runs and unregisters afterwards (C1 `kinds` update both ways). A unit test pins that every
  `addRawFrameHandler` call declares kinds. The app sends a C1 focus message with the open chat
  session plus any expanded subagent child sessions, re-sent whenever that set changes and after
  every reconnect, following the C1 ordering rule.
- **B7 [B] Background / foreground.** On entering the background, close the `/events` socket after a
  5 s grace (cancel if the app returns). On returning to the foreground after ≥ 5 s away, always
  reconnect (fresh snapshot replay) instead of trusting the old socket. While the app is in the
  foreground, reconnect attempts never give up: backoff 1 s → 30 s cap with jitter. The 10-minute
  give-up applies only in the background. The 45 s liveness watchdog also runs while disconnected so
  nothing can stay silently dead.
- **B8 [B] Waiting badge from below.** Session rows show "waiting on you" from
  `attention ?? attentionBelow` (C2). On a `runningSet` frame, apply the C4 replay rule (clear
  ask-derived state, then repopulate).
- **B9 [B] Animations.** The running loader and pulsing row dot stop animating when not visible
  (off-screen / background).
- **B10 [B] Notification sinks.** Apply A1's `.receive(on: DispatchQueue.main)` fix to the
  `NotificationCenter` publisher sinks in `ChatSessionStore.swift` and `MantaAppRoot.swift` where the
  poster can be off the main thread.

### Status freshness (box — fixes all clients)

- **S1 [S] First-connect hydrate.** On EVERY connection to opencode (first and reconnect), the box
  enumerates sessions FROM OPENCODE — `oc.listActiveSessionIds()` plus the sessions it already knows
  — reads each one's running state and pending questions/permissions, and seeds the interpreter
  with them, then publishes through the normal path. `resyncAfterReconnect` today iterates only
  `streamInterp.knownSessionIds()` (`index.mjs` ~3891), which is empty after a restart, so reusing
  it unchanged would fix nothing. S1 and S2 share one reconcile function.
- **S2 [S] Periodic reconcile.** Every 45 s (`unref`'d interval, in-flight guarded) the box re-reads
  opencode's active sessions and the pending asks of every session that is active or has a pending
  ask on record, compares with what it holds, and corrects only the differences through the same
  publish path as live events (so clients receive normal frames). No publish when nothing changed.
  An opencode read failure skips the tick (never clears state).
- **S3 [S] Stall detection.** The opencode event stream reader tracks the time of the last received
  byte (including `: heartbeat` comments). If nothing arrives for 90 s (or 3× the observed heartbeat
  interval, whichever is larger — measure V2's interval against the pinned binary in the sandbox or
  by reading its source in `/mnt/HC_Volume_105783934/dev-cache/opencode-src-2.0.30`), abort the
  request; the existing reconnect + resync then runs. Log one line per stall. Arm the timer only
  after at least one heartbeat has been seen on the current connection, so a box whose opencode
  sends no heartbeat while idle never reconnect-loops.
- **S8 [S] Quiet `status` batches.** `status.mjs` publishes its 2 s `status` batch only when it
  differs from the previous one (signature compare), plus once on each new `/events` subscriber
  through the snapshot. Benefits every client; iOS must keep `status` in its kinds for terminal rows.
- **S4 [S] Stale asks at turn end.** When a session's turn ends (succeeded / failed / interrupted),
  the box re-reads that session's pending asks from opencode once and drops any it holds that
  opencode no longer reports.
- **S5 [S] attentionBelow** per C2 in `sessionStatus.mjs`, published with the row status.
- **D1 [S] Desktop badges.** The desktop applies the C4 replay rule: on a `runningSet` frame it
  clears every chat session's ?/! attention, then the replay's following frames repopulate it
  (`src/renderer/store.ts` ~1457). The desktop sidebar shows the
  waiting badge from `attention ?? attentionBelow` (C2).
- **S7 [S] Box event filter** per C1, wired into `attachEventsWs` and `handleEventsRequest`.

## File ownership

| Worker | Owns | Must not touch |
|---|---|---|
| S | `src/server/**`, `src/renderer/**`, `src/shared/**`, `docs/superpowers/specs/**` (notes only) | `mobile/**` |
| A | `mobile/native/MantaUI/UpgradeStore.swift`, `MantaAPIClient.swift` and `BoxRESTClient.swift` (only the two notification post sites), `TranscriptDisplayOptions.swift`, `KeychainCredentialStore.swift`, `UsageStore.swift`, new `DiagnosticsReporter.swift` (+ any new pure helper file), `MantaUIApp.swift` (startup wiring only), new `MantaUITests/` test files for these | everything B owns (report needed changes there instead); `project.yml` (MetricKit is a system framework; implicit linking suffices) |
| B | `MantaEventStore.swift`, `MantaStreamModels.swift`, `MantaReconnectController.swift`, `ChatSessionStore.swift`, `ChatScreen.swift`, `SessionListStore.swift`, `SessionListView.swift`, `MantaAppRoot.swift`, `TranscriptMediaStore.swift`, `GitForgeStore.swift`, `ChatCardApprovalStore.swift`, `SessionResourceCards.swift`, `RunningIndicator.swift`, `MantaLoader.swift`, `AccountsStore.swift`, every file that calls `addRawFrameHandler` (signature change for B6), related existing tests, new test files | A's files (coordinate through this spec only) |

## Verification

- Server/renderer: targeted test files locally; the full suite (`npm run typecheck && npm test`) on a
  Freestyle VM via `~/.local/bin/fs-run.sh manta <worktree> 'npm ci && npm run typecheck && npm test'`
  (heavy work never runs on the dev box). Every failing test is fixed.
- iOS: no Swift toolchain on the box. The orchestrator commits, pushes the branch, and runs the Mac
  plugin gate `ios-mantaui action=test-unit` (or `ios-unit-gate` with the exact sha). Compiler errors
  are read with `ios-build-errors` / `ios-unit-failures`. Workers write tests but cannot run them.
- Manual check after merge (user): install the build on a phone, use it during a busy session for
  10 minutes; Settings → Battery should no longer list MantaUI as a top consumer, and the box should
  start receiving files under `~/.manta/ios-diagnostics/` within a day if the OS kills the app.

## Follow-up (routine)

After this ships, a routine checks for one week: Crashlytics fatal count and the new `MetricKit`
non-fatals per kind, and the files in `~/.manta/ios-diagnostics/`, to tell whether the OS kills
stopped. Created at merge time.

## Release

No version bumps in this PR. The server change ships with the next `server-v*` tag, the iOS change
with the next iOS `MARKETING_VERSION` bump, the desktop badge change with the next `mac-v*`. Deploy
is the user's call.

New Swift files are added to `project.yml`'s sources by directory; the committed
`MantaUI.xcodeproj/project.pbxproj` is regenerated on the Mac (`ios-regen-pbxproj` plugin) and the
result committed on this branch before merge.
