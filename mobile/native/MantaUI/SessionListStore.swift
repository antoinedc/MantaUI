import Foundation
import Combine
import SwiftUI

// ===========================================================================
// S3 — session-list store (BET-595).
//
// Owns the live data behind the §7.1 list:
//   - the grouped project/window list from `tmux:list` (refreshed on demand
//     and on every healthy stream reconnect via `resyncHandler`);
//   - per-row live status (running / attention / background jobs / model)
//     merged from the S1b event store (`sessionStates` keyed by the window's
//     `opencodeSessionId`) plus the `delegate:list` jobs fetch and attention
//     tracking on the raw frame surface;
//   - pinned windows (`pinnedWindows`) and the haptics enable flag, both
//     persisted through `config:update`;
//   - §7.3 delete-with-undo: an idle delete is held 5 s, the RPC fires only
//     when the toast expires; running deletes are gated on the view's confirm.
//
// The PURE decisions (subtitle, dot, durations, delete-window expiry) live in
// `SessionModels.swift`; this store is the I/O + state wiring around them.
// ===========================================================================

/// The mutation/read seam for the session-list surface, so the store's
/// orchestration ("refresh only after a successful mutation", the close queue,
/// the launcher catalog) is unit-testable without a live box. The live adapter
/// wraps `MantaAPIClient`'s RPCs unchanged.
@MainActor
protocol SessionListMutationAPI {
    func renameWindow(session: String, index: Int, newName: String) async throws
    func forkSession(sessionId: String, sessionName: String, windowName: String) async throws
    func renameProject(oldName: String, newName: String) async throws
    /// WS11 D6: the close flow is the box's. `windowIndex` nil = the whole project.
    func closePreview(project: String, windowIndex: Int?) async throws -> SessionClosePreview
    func close(project: String, windowIndex: Int?, dirtyWorktree: String?, deleteConversation: Bool, expect: SessionCloseExpect?) async throws -> SessionCloseResult
    func configGet() async throws -> [String: JSONValue]?
    func launchersList() async throws -> [AvailableLauncher]
    func usageStoppedList() async throws -> SessionStoppedList
}

@MainActor
struct ServerSessionListMutations: SessionListMutationAPI {
    let api: MantaAPIClient

    func renameWindow(session: String, index: Int, newName: String) async throws {
        try await api.renameWindow(session: session, index: index, newName: newName)
    }

    func forkSession(sessionId: String, sessionName: String, windowName: String) async throws {
        _ = try await api.forkSession(sessionId: sessionId, sessionName: sessionName, windowName: windowName)
    }

    func renameProject(oldName: String, newName: String) async throws {
        try await api.tmuxRenameSession(oldName: oldName, newName: newName)
    }

    func closePreview(project: String, windowIndex: Int?) async throws -> SessionClosePreview {
        try await api.sessionsClosePreview(project: project, windowIndex: windowIndex)
    }

    func close(project: String, windowIndex: Int?, dirtyWorktree: String?, deleteConversation: Bool, expect: SessionCloseExpect?) async throws -> SessionCloseResult {
        try await api.sessionsClose(project: project, windowIndex: windowIndex, dirtyWorktree: dirtyWorktree, deleteConversation: deleteConversation, expect: expect)
    }

    func configGet() async throws -> [String: JSONValue]? {
        try await api.configGet()
    }

    func launchersList() async throws -> [AvailableLauncher] {
        try await api.launchersList()
    }

    func usageStoppedList() async throws -> SessionStoppedList {
        try await api.usageStoppedList()
    }
}

/// Lightweight per-session presentation metadata resolved from the opencode
/// session list (BET-897): the friendly model label and last known activity.
struct SessionMeta: Equatable, Sendable {
    var modelLabel: String?
    var lastActivity: Date?
}

@MainActor
final class SessionListStore: ObservableObject {

    @Published private(set) var projects: [MantaProject] = []
    @Published private(set) var loading = false
    @Published private(set) var loadError: String?
    /// A transient, user-facing failure message from a mutation (rename/fork).
    /// Set only when the RPC rejected; the view surfaces it as a brief toast
    /// (mirrors `ChatSessionStore.actionHint`, the BET-716 composer surface).
    @Published var actionMessage: String?
    /// True once a fetch has come back successfully. Without it an EMPTY list
    /// is ambiguous — "this box has no sessions" and "we never managed to ask"
    /// look identical — and the view rendered the inviting "No sessions yet.
    /// Tap + to create one." for both. That is the reassuring-lie state the
    /// user hit: sessions existed, the list was blank, and nothing said so.
    @Published private(set) var loadedOnce = false
    @Published private(set) var pinnedWindows: Set<String> = []
    @Published private(set) var hapticsEnabled = true
    /// pinID -> pending delete being held within its 5 s undo window.
    @Published private(set) var pendingDeletes: [String: PendingDelete] = [:]
    /// The box's prompt-cache TTL in milliseconds (`"5m"` → 300_000, `"1h"` →
    /// 3_600_000, anything else/absent → 300_000). Drives the age chip cutoff
    /// and the Recent filter (BET-1349).
    @Published private(set) var cacheTtlMs: Double = SessionCacheTtl.defaultMs
    /// opencodeSessionID → the last running/idle TRANSITION the event stream
    /// reported for it (spec §3). Only feeds the Latest-activity ordering, where
    /// it is combined with the box's `time.updated` (`lastActivity(for:)`) so a
    /// turn that just started or ended sorts to the top before the next fetch
    /// lands. It never feeds the age chip — that keeps reading the box's own
    /// `time.updated`, never the device clock. Published, but written only on
    /// an actual transition, so the per-frame stream cannot re-render the list
    /// through it.
    @Published private(set) var liveActivity: [String: Date] = [:]

    // MARK: WS04 state (spec 04): launchers, stopped conversations, recents,
    // the close queue. All device/box decoration — none of it may blank the list.

    /// Which AI CLIs are installed on the box, and how sure we are (spec §2).
    @Published private(set) var launcherCatalog: SessionLauncherCatalog = .loading
    /// The last good `launchers:list` (kept across a failed refresh).
    @Published private(set) var launchers: [AvailableLauncher] = []
    /// The box's durable list of conversations a provider limit stopped (D16 —
    /// the ONLY stopped-state source on iOS; WS09 reads it).
    @Published private(set) var stoppedRecords: [SessionStoppedRecord] = []
    /// Epoch milliseconds, exactly as the box sent it (compare with `stoppedAt`).
    @Published private(set) var stoppedLastLooked: Double?
    @Published private(set) var stoppedConversations: Set<String> = []
    /// Window keys (`"<project>#<index>"`), most recently opened first. Device-local.
    @Published private(set) var recents: [String]
    /// Dirty-worktree decisions waiting for the user, in the order they arose.
    @Published private(set) var worktreePrompts: [SessionWorktreePrompt] = []
    /// Real outcomes of closes, consumed by the view (haptic + toast).
    @Published private(set) var closeFeedback: [SessionCloseFeedback] = []
    /// How many times a refresh was asked for (an observation point for tests).
    private(set) var refreshRequestCount = 0

    private let api: MantaAPIClient
    private let mutations: SessionListMutationAPI
    private let eventStore: MantaEventStore
    /// opencodeSessionID → lightweight per-session metadata resolved from the
    /// opencode session list (BET-897). One dictionary replaces the old separate
    /// `modelLabels` map and feeds both the running subtitle and the new idle
    /// recency line without any extra fetch.
    private var sessionMeta: [String: SessionMeta] = [:]
    /// opencodeSessionID → the model-authored progress label for a working turn
    /// (BET-791). Fed from `progress:get` on `progress.updated` frames + a
    /// backfill on refresh; drives the row subtitle via `rowStatus`.
    private var progressBySession: [String: String] = [:]
    /// Parent opencodeSessionID → count of non-terminal jobs nested under it
    /// (BET-1213). Drives the background-job subtitle via `rowStatus`.
    private var backgroundJobsBySession: [String: Int] = [:]
    /// Project tmuxSession → child window indices hidden because they're jobs.
    private var hiddenByProject: [String: Set<Int>] = [:]
    /// A refresh asked for while one was already in flight. The request used to
    /// be DROPPED (`guard !loading else { return }`) and never rescheduled, so
    /// the foreground/reconnect refresh that raced the launch fetch simply
    /// vanished and the list stayed on whatever the first one returned.
    private var refreshQueued = false
    /// The set of opencode session ids seen running on the last `$sessionStates`
    /// tick (BET-1349). Diffed against the current tick so a turn ENDING —
    /// running→idle — triggers a refresh that re-fetches the authoritative
    /// `time.updated` for the age chip at the exact moment it becomes eligible.
    private var previouslyRunning: Set<String> = []
    /// `tmuxSession#windowIndex` -> live tmux-poller status for TERMINAL
    /// windows (BET-1350). Chat-mode windows are NOT in here: their status
    /// comes from the interpreted stream, and the box's pane scrape cannot see
    /// them anyway (a chat window's pane runs `sleep infinity`, so
    /// capture-pane returns blank). Read by `rowStatus` for terminal windows
    /// only; one source per window type, no merging.
    private(set) var terminalStatus: [String: WindowPollStatus] = [:]
    private var cancellables: Set<AnyCancellable> = []
    private let defaults: UserDefaults
    private static let recentsKey = "sessionRecents"
    /// Closes run through ONE worker, in the order they were asked for.
    private var closeQueue: [SessionCloseRequest] = []
    private var closeWorker: Task<Void, Never>?
    /// Bumped by `resetForBoxChange`. A worker (or refresh) started before the
    /// reset sees a stale generation and neither publishes into the new box's
    /// state nor clears the handle of the worker that replaced it.
    private var closeGeneration = 0
    private var boxGeneration = 0
    private var launcherTask: Task<Void, Never>?

    init(api: MantaAPIClient = MantaAPIClient.live(), eventStore: MantaEventStore, mutations: SessionListMutationAPI? = nil, defaults: UserDefaults = .standard) {
        self.api = api
        self.mutations = mutations ?? ServerSessionListMutations(api: api)
        self.eventStore = eventStore
        self.defaults = defaults
        self.recents = defaults.stringArray(forKey: Self.recentsKey) ?? []
        self.loadConfig()
        self.eventStore.addRawFrameHandler { [weak self] frame in
            self?.trackProgress(frame: frame)
            self?.trackStatus(frame: frame)
            self?.trackNesting(frame: frame)
            self?.trackStopped(frame: frame)
        }
        // A turn completing is the moment the age chip becomes eligible
        // (`!running`), and it is precisely when the cached `lastActivity` is
        // stale. This sink diffs only a small running-id set and touches
        // published state ONLY on an actual running↔idle edge (`liveActivity`),
        // so the hot per-frame `$sessionStates` stream cannot re-render the
        // whole list.
        self.eventStore.$sessionStates
            .receive(on: DispatchQueue.main)
            .sink { [weak self] states in
                self?.trackRunningTransitions(states)
            }
            .store(in: &cancellables)
    }

    /// The set diff that notices a turn just ended (BET-1349). A running→idle
    /// edge triggers a coalescing `refresh()` so the list re-fetches the box's
    /// authoritative `time.updated` rather than stamping the device clock
    /// (mirrors the "NEVER fabricate the local clock" rule at
    /// `MantaEventStore.swift:260-272`).
    private func trackRunningTransitions(_ states: [String: MantaSessionStreamState]) {
        let runningNow = Set(states.filter { $0.value.running == true }.map(\.key))
        let started = runningNow.subtracting(previouslyRunning)
        let stopped = previouslyRunning.subtracting(runningNow)
        previouslyRunning = runningNow
        guard !started.isEmpty || !stopped.isEmpty else { return }
        // Latest-activity ordering (spec §3): stamp the edge. A turn that
        // started keeps the box's own start time; one that ended (or whose
        // start the box did not report) uses the device clock, so it sorts to
        // the top at once instead of after the refresh below brings back the
        // box's `time.updated`. `lastActivity(for:)` takes whichever is later,
        // so clock skew can at worst leave a just-ended turn marginally ahead
        // of another that ended in the same moment.
        let now = Date()
        var next = liveActivity
        for sid in started { next[sid] = states[sid]?.runningSince ?? now }
        for sid in stopped { next[sid] = now }
        if next != liveActivity { liveActivity = next }
        guard !stopped.isEmpty else { return }
        Task { await refresh() }
    }

    /// When this window's running turn started, as reported by the box.
    func runningStart(for window: MantaWindow) -> Date? {
        guard let sid = window.opencodeSessionId else { return nil }
        return eventStore.sessionStates[sid]?.runningSince
    }

    /// Re-fetch the list (pull-to-refresh / foreground / reconnect / after
    /// create). Overlapping calls are COALESCED, not discarded: the second
    /// caller marks a re-run and the loop fires once more when the in-flight
    /// fetch lands, so a refresh request can never be silently lost.
    func refresh() async {
        refreshRequestCount += 1
        if loading {
            refreshQueued = true
            return
        }
        loading = true
        defer { loading = false }
        repeat {
            refreshQueued = false
            await fetchOnce()
        } while refreshQueued
    }

    private func fetchOnce() async {
        do {
            let list = try await readProjects()
            projects = list
            loadedOnce = true
            loadError = nil
            // Which windows are job windows, and their parents' live-job counts, come from the list itself (the
            // box nests them: `windows[].job`) — derived before anything awaits so a job window never flashes as a
            // row while the session-meta fetch below runs.
            recomputeNesting()
            await refreshSessionMeta()
            // The stopped list is cheap decoration (a failure keeps what we had). Launcher discovery
            // is NOT here — it spawns a login shell per CLI (seconds), so it runs
            // once after launch / box change, on foreground and on demand.
            await refreshStopped()
            if launcherCatalog == .loading { Task { await refreshLaunchers() } }
        } catch {
            // Keep whatever was already on screen — a failed fetch must never
            // blank a list we successfully loaded before.
            loadError = Self.describe(error)
        }
    }

    private static func describe(_ error: Error) -> String {
        if let known = error as? MantaError, known == .authRequired {
            return "Your server rejected this device — pair it again."
        }
        return "Couldn't reach your server"
    }

    /// Adopt the project list a mutating RPC already returned (post-create),
    /// so the caller resolves the new window against a list that contains it
    /// instead of the pre-create snapshot.
    func applyProjects(_ list: [MantaProject]) {
        // A project list that has just been mutated CANNOT be empty — the
        // window we created is in it. An empty one therefore means the reply
        // was not the list we asked for, and adopting it would blank a list we
        // had loaded fine. Re-fetch rather than believe it.
        guard !list.isEmpty else {
            Task { await refresh() }
            return
        }
        projects = list
        loadedOnce = true
        loadError = nil
        recomputeNesting()
    }

    /// The window at `index` of a project, as the list holds it right now.
    func window(session: String, index: Int) -> MantaWindow? {
        projects.first(where: { $0.tmuxSession == session })?.windows.first(where: { $0.index == index })
    }

    /// The windows that actually render for a project — its top-level rows with
    /// background-job child windows filtered out (BET-1213).
    func visibleWindows(in project: MantaProject) -> [MantaWindow] {
        let hidden = hiddenByProject[project.tmuxSession] ?? []
        return project.windows.filter { !hidden.contains($0.index) }
    }

    /// The projects that actually render: background-job windows removed
    /// (spec §2), and a project whose only windows were jobs dropped. Search,
    /// the Recent filter and both orderings all start from this, so a job
    /// window can never surface through any of them.
    var visibleProjects: [MantaProject] {
        SessionJobWindows.visible(projects, hidden: hiddenByProject)
    }

    /// Re-derive which windows are job windows and the per-parent live-job counts from the project list the box
    /// sent (`windows[].job`). Called whenever the list changes.
    private func recomputeNesting() {
        var hidden: [String: Set<Int>] = [:]
        var counts: [String: Int] = [:]
        for p in projects {
            hidden[p.tmuxSession] = SessionJobWindows.hiddenIndices(project: p)
            for (index, count) in SessionJobWindows.activeChildCounts(project: p) {
                if let w = p.windows.first(where: { $0.index == index }),
                   let sid = w.opencodeSessionId, !sid.isEmpty {
                    counts[sid] = count
                }
            }
        }
        hiddenByProject = hidden
        backgroundJobsBySession = counts
    }

    /// How many per-directory session lists are fetched at once (desktop's
    /// `OPENCODE_FANOUT_CONCURRENCY` plays the same role).
    private static let sessionFetchConcurrency = 4

    private func refreshSessionMeta() async {
        // Spec §3: the unscoped list stops at 100 sessions, so an older window
        // never learned its model or last activity. Ask per DISTINCT window
        // directory as well and merge — the unscoped list stays as a fallback
        // for a window whose pane cwd differs from its session's directory.
        let unscoped = try? await api.listSessions()
        let scoped = await listSessions(inDirectories: SessionActivityOrder.chatDirectories(projects))
        // Every fetch failed: keep whatever was resolved before, exactly as a
        // failed unscoped fetch always has.
        guard unscoped != nil || !scoped.isEmpty else { return }
        var meta: [String: SessionMeta] = [:]
        for s in (unscoped ?? []) + scoped.flatMap({ $0 }) {
            meta[s.id] = SessionMeta(
                modelLabel: s.model.map { ModelLabel.text(providerID: $0.providerID, modelID: $0.id) },
                lastActivity: s.time?.updated.map { Date(timeIntervalSince1970: $0 / 1000) }
            )
        }
        sessionMeta = meta
        // BET-791: backfill the working progress label for every WINDOW's
        // session so the subtitle is right even when the app (re)connected
        // after a progress_report but before any live `progress.updated`
        // frame. The record fetched for a session that has none (or whose turn
        // isn't `working`) clears any stale label — authoritative to the box.
        // Window sessions only: a session with no row has no subtitle to show.
        var progress: [String: String] = [:]
        var seen = Set<String>()
        for window in projects.flatMap(\.windows) {
            guard let sid = window.opencodeSessionId, !sid.isEmpty, seen.insert(sid).inserted else { continue }
            if let label = await workingProgressLabel(sessionID: sid) {
                progress[sid] = label
            }
        }
        progressBySession = progress
    }

    /// One `opencode:list-sessions(directory)` per directory, a few at a time.
    /// A directory whose fetch fails is simply absent from the result (its
    /// windows keep whatever the unscoped list knew) — never fatal.
    private func listSessions(inDirectories directories: [String]) async -> [[OpencodeSessionListItem]] {
        guard !directories.isEmpty else { return [] }
        let api = self.api
        let limit = Self.sessionFetchConcurrency
        return await withTaskGroup(of: [OpencodeSessionListItem]?.self) { group in
            var pending = directories.makeIterator()
            var started = 0
            while started < limit, let dir = pending.next() {
                group.addTask { try? await api.listSessions(directory: dir) }
                started += 1
            }
            var results: [[OpencodeSessionListItem]] = []
            while let result = await group.next() {
                if let result { results.append(result) }
                if let dir = pending.next() {
                    group.addTask { try? await api.listSessions(directory: dir) }
                }
            }
            return results
        }
    }

    // MARK: - Row status (reads the S1b store)

    /// The window's live status, merging the box's stream state with the
    /// attention derived from its pending questions/permissions. Pure inputs;
    /// presentation decided in SessionModels.
    func rowStatus(for window: MantaWindow) -> SessionRowStatus {
        let sid = window.opencodeSessionId ?? ""
        let isTerminal = window.opencodeSessionId == nil
        let stream = eventStore.sessionStates[sid]
        // Own turn from the stream; busy beneath (subagents at any depth, a running job) and the direct-subagent
        // count are the box's rollup (`windowStatus`, WS11 D7). An older box has no rollup: the row shows its own turn.
        var running = (stream?.running == true) || (stream?.windowStatus?.busy == true)
        var subagents = stream?.windowStatus?.subagents ?? 0
        let attention = !(stream?.questions?.questions.isEmpty ?? true)
            || !(stream?.permissions?.permissions.isEmpty ?? true)
        if isTerminal,
           let project = projects.first(where: { $0.windows.contains(window) }),
           let polled = terminalStatus[Self.terminalKey(project: project.tmuxSession, windowIndex: window.index)] {
            // A terminal window's running status comes ONLY from the box's
            // tmux poller (BET-1350). The interpreted stream cannot see it (a
            // terminal pane runs claude's TUI, not an opencode session), so the
            // poller is this window type's single source — deliberately no
            // fallback to the stream. Chat windows are untouched (the branch is
            // terminal-only; one source per window type, no merging).
            running = polled.running
            subagents = polled.subagents
        }
        return SessionRowStatus(
            running: running || subagents > 0,
            attention: attention,
            backgroundJobs: backgroundJobsBySession[sid] ?? 0,
            modelLabel: sessionMeta[sid]?.modelLabel,
            progressLabel: progressBySession[sid],
            lastActivity: sessionMeta[sid]?.lastActivity,
            isTerminal: isTerminal,
            runningSubagents: subagents,
            halted: !sid.isEmpty && stoppedConversations.contains(sid)
        )
    }

    /// The instant to order this window by in the Latest-activity list: the
    /// later of the box's `time.updated` and the last running↔idle transition
    /// seen live. Nil for a terminal window (it has no session) and for a chat
    /// window whose session has not been listed yet.
    func lastActivity(for window: MantaWindow) -> Date? {
        guard let sid = window.opencodeSessionId, !sid.isEmpty else { return nil }
        return SessionActivityOrder.latest(sessionMeta[sid]?.lastActivity, liveActivity[sid])
    }

    /// How many of a project's visible windows are mid-turn (drives the group
    /// header chip). Hidden background-job windows are excluded — a job is
    /// represented by its parent's count, not by a running row of its own.
    func runningCount(in project: MantaProject) -> Int {
        visibleWindows(in: project).filter { rowStatus(for: $0).running }.count
    }

    // MARK: - Progress (BET-791)

    /// Track `progress.updated` frames: refetch that session's progress record
    /// (the frame carries only a {sessionID} hint) and stash the working label
    /// so the row subtitle can show it. Published only when the label actually
    /// differs (mirrors the old trackAttention's BET-672 re-render guard).
    private func trackProgress(frame: MantaStreamFrame) {
        guard (frame.eventType ?? frame.kind) == "progress.updated", let sid = frame.sessionId else { return }
        Task { [weak self] in
            let label = await self?.workingProgressLabel(sessionID: sid)
            guard let self else { return }
            if self.progressBySession[sid] != label {
                self.progressBySession[sid] = label
                self.objectWillChange.send()
            }
        }
    }

    /// The model-authored label for a WORKING turn; any other state clears it
    /// (blocked yields to the card, done/failed to the turn ending). Returns
    /// nil when the fetch fails or the session has no qualifying record.
    private func workingProgressLabel(sessionID: String) async -> String? {
        guard let record = try? await api.progressGet(sessionID: sessionID) else { return nil }
        return record.workingLabel
    }

    // MARK: - Background jobs (spec §2)

    /// The project list read; a test replaces it to count the reads.
    var projectsReader: (@MainActor () async throws -> [MantaProject])?

    private func readProjects() async throws -> [MantaProject] {
        if let projectsReader { return try await projectsReader() }
        return try await api.projects()
    }

    private var nestingTask: Task<Void, Never>?
    private var nestingRefreshQueued = false

    /// `sessions.nesting` — the box says a background job's window appeared, nested, finished or was superseded. That is
    /// the ONLY signal that re-reads the list for nesting: `delegate.updated` also fires about every 10 s per running job
    /// for activity text, and each of those used to mean a full refresh (a `tmux:list` plus the per-window session,
    /// progress and stopped reads). Only the project list is re-read here, never that decoration.
    private func trackNesting(frame: MantaStreamFrame) {
        guard frame.kind == "sessions.nesting" else { return }
        if nestingTask != nil {
            nestingRefreshQueued = true
            return
        }
        nestingTask = Task { [weak self] in
            guard let self else { return }
            repeat {
                self.nestingRefreshQueued = false
                if let list = try? await self.readProjects(), !list.isEmpty {
                    self.projects = list
                    self.recomputeNesting()
                }
            } while self.nestingRefreshQueued
            self.nestingTask = nil
        }
    }

    /// Completes once a nesting refresh has run (for tests).
    func waitForNestingRefresh() async {
        await nestingTask?.value
    }

    // MARK: - Terminal-window status (BET-1350)

    /// The `tmuxSession#windowIndex` composite key for terminal-window poller
    /// status. REUSES the existing id shape — `SessionRowEntry.id` is the
    /// `"\(project)#\(windowIndex)"` composite already used for a row's
    /// `project#window` identity (`SessionListView.swift`); this is the SAME
    /// composite, not a third id format. `SessionPinID.window` (a `/`
    /// separator, pin identity) is a different shape and is deliberately not
    /// used here.
    static func terminalKey(project: String, windowIndex: Int) -> String {
        "\(project)#\(windowIndex)"
    }

    /// The wire shape of one `kind: "status"` payload entry. The payload is a
    /// JSON ARRAY of these (per `src/server/status.mjs`), e.g.
    /// `[{"session":"proj","windowIndex":2,"running":true,"subagents":0}]`.
    private struct TerminalStatusFrame: Decodable {
        var session: String
        var windowIndex: Int
        var running: Bool
        var subagents: Int
    }

    /// Consume `kind: "status"` frames (the box's 2s tmux activity poller,
    /// `src/server/status.mjs`) for TERMINAL windows. Each batch REPLACES the
    /// entries for the windows it names; a window absent from a batch keeps
    /// its previous value (the batch is per-tick and complete for live
    /// windows; a vanished window is cleaned up by the next `refresh()`
    /// dropping the row). Publishes only on an actual change so a 2s tick
    /// cannot re-render the whole list unconditionally (the guard that
    /// `trackRunningTransitions` already follow).
    private func trackStatus(frame: MantaStreamFrame) {
        guard frame.kind == "status",
              let entries = try? frame.decodedPayload([TerminalStatusFrame].self),
              !entries.isEmpty else { return }
        var next = terminalStatus
        for e in entries {
            next[Self.terminalKey(project: e.session, windowIndex: e.windowIndex)] =
                WindowPollStatus(running: e.running, subagents: e.subagents)
        }
        if next != terminalStatus {
            terminalStatus = next
            objectWillChange.send()
        }
    }

    // MARK: - Pin (§7.2 swipe-right)

    func togglePin(session: String, index: Int) {
        let id = SessionPinID.window(session, index: index)
        var next = pinnedWindows
        if next.contains(id) { next.remove(id) } else { next.insert(id) }
        pinnedWindows = next
        Task { _ = try? await api.configUpdate(["pinnedWindows": Array(next)] as [String: Any]) }
    }

    func isPinned(session: String, index: Int) -> Bool {
        pinnedWindows.contains(SessionPinID.window(session, index: index))
    }

    // MARK: - Haptics flag (user-disableable, §7.4)

    func setHapticsEnabled(_ enabled: Bool) {
        hapticsEnabled = enabled
        Task { _ = try? await api.configUpdate(["hapticsEnabled": enabled]) }
    }

    // MARK: - Delete (§7.3)

    /// An idle delete: hold it in the 5 s undo window. The RPC is NOT fired;
    /// it fires from `commitExpiredDeletes` only after the toast expires. The
    /// toast's `.task(id:)` is the SOLE timing owner (BET-752 task 6) — there
    /// is deliberately no timer here, so a second delete during a live toast
    /// restarts the view's task and the counts stay coherent.
    func beginIdleDelete(session: String, index: Int) {
        let id = SessionPinID.window(session, index: index)
        cancelPendingDelete(id)
        let pending = PendingDelete(
            target: .window(session: session, index: index),
            pinID: id,
            startedAt: Date(),
            expect: SessionCloseExpect(window: window(session: session, index: index))
        )
        pendingDeletes[id] = pending
    }

    /// Undo an idle delete within its undo window.
    func undoPendingDelete(_ id: String) {
        cancelPendingDelete(id)
    }

    /// Hand everything still pending whose undo window has expired to the close
    /// queue. Called by the undo toast's `.task(id:)` when it times out. Returns
    /// whether anything was enqueued. It does NOT mean anything was closed: the
    /// queue reports real outcomes through `closeFeedback`.
    @discardableResult
    func commitExpiredDeletes(now: Date = Date()) -> Bool {
        // Oldest first, so the queue (and any worktree prompts) follow the order
        // the user deleted in rather than the dictionary's.
        let expired = pendingDeletes.values
            .filter { $0.expired(now: now) }
            .sorted { ($0.startedAt, $0.pinID) < ($1.startedAt, $1.pinID) }
            .map(\.pinID)
        var enqueued = false
        for id in expired where commitPendingDelete(id) { enqueued = true }
        return enqueued
    }

    private func cancelPendingDelete(_ id: String) {
        pendingDeletes.removeValue(forKey: id)
    }

    @discardableResult
    private func commitPendingDelete(_ id: String) -> Bool {
        guard let pending = pendingDeletes.removeValue(forKey: id) else { return false }
        switch pending.target {
        case .window(let session, let index):
            enqueueClose(project: session, index: index, expect: pending.expect)
        }
        return true
    }

    // MARK: - Close queue (spec 04 §8)

    /// Ask for a session to be closed. Requests run ONE at a time, in order, so
    /// two quick deletes can never race each other's worktree decisions.
    func enqueueClose(project: String, index: Int, decision: SessionCloseChoice = .none, expect: SessionCloseExpect? = nil) {
        // The window as it is NOW when the caller had no row to bind to; a queued close can run later, and the box
        // refuses it if the index has come to name another window.
        let request = SessionCloseRequest(
            project: project, index: index, decision: decision,
            expect: expect ?? SessionCloseExpect(window: window(session: project, index: index))
        )
        // The same window can't be closed twice over.
        if closeQueue.contains(where: { $0.key == request.key && $0.decision == request.decision }) { return }
        closeQueue.append(request)
        guard closeWorker == nil else { return }
        let generation = closeGeneration
        closeWorker = Task { [weak self] in
            await self?.drainCloseQueue(generation: generation)
        }
    }

    /// Completes once the queue has run dry (for tests and for callers that
    /// must act after the close).
    func waitForCloseQueue() async {
        await closeWorker?.value
    }

    private func drainCloseQueue(generation: Int) async {
        while generation == closeGeneration, !closeQueue.isEmpty {
            let request = closeQueue.removeFirst()
            await processClose(request, generation: generation)
        }
        // Only the CURRENT worker may clear the handle: a stale one finishing
        // after a box reset must not wipe the new worker's, or the next enqueue
        // would start a second concurrent worker.
        if generation == closeGeneration { closeWorker = nil }
    }

    private func processClose(_ request: SessionCloseRequest, generation: Int) async {
        let window = projects.first(where: { $0.tmuxSession == request.project })?
            .windows.first(where: { $0.index == request.index })
        let result: SessionCloseResult
        do {
            // The box runs the whole close: worktree removal, the kill, the refresh of its own state. A chat window is
            // DELETED (its conversation goes with it) — this app's "delete".
            // Both are decided from the window the user CONFIRMED (`request.expect`), never from whatever the index names now.
            result = try await mutations.close(
                project: request.project, windowIndex: request.index, dirtyWorktree: request.decision.wire,
                deleteConversation: request.expect?.opencodeSessionId != nil,
                expect: request.expect
            )
        } catch {
            guard generation == closeGeneration else { return }
            // The row's real state is shown instead of a phantom removal.
            publishFeedback(.failed(BoxCapabilities.isUnknownChannel(error) ? UpdateBoxNote.text : SessionActionError.message("delete", error: error)))
            await refresh()
            return
        }
        // The close belonged to a box we have since left: say nothing about it.
        guard generation == closeGeneration else { return }
        if let ask = result.needsConfirm {
            // Nothing was deleted. The row stays; the user decides.
            let prompt = SessionWorktreePrompt(
                key: request.key, project: request.project, index: request.index,
                windowName: window?.name ?? "session", worktreePath: ask.path, ask: ask, expect: request.expect
            )
            worktreePrompts = SessionWorktreePromptQueue.append(prompt, to: worktreePrompts)
            return
        }
        guard result.ok else {
            // The box's sentence says what already happened ("…its worktree was already removed"); show it as is.
            publishFeedback(.failed(result.error ?? SessionActionError.message("delete", error: MantaError.server(""))))
            await refresh()
            return
        }
        if !result.warnings.isEmpty {
            publishFeedback(.closedWithWarnings(([result.notice].compactMap { $0 }) + result.warnings))
        } else if let notice = result.notice {
            publishFeedback(.closedWithNotice(notice))
        } else {
            publishFeedback(.closed)
        }
        await refresh()
    }

    private func publishFeedback(_ kind: SessionCloseFeedbackKind) {
        closeFeedback.append(SessionCloseFeedback(kind: kind))
    }

    func consumeFeedback(id: UUID) {
        closeFeedback.removeAll { $0.id == id }
    }

    /// The user's answer to the prompt for `key`. Cancel does nothing at all.
    func resolveWorktreePrompt(key: String, decision: SessionWorktreeAnswer) {
        guard let prompt = worktreePrompts.first(where: { $0.key == key }) else { return }
        worktreePrompts = SessionWorktreePromptQueue.resolve(key: key, in: worktreePrompts)
        switch decision {
        case .cancel: return
        case .keep: enqueueClose(project: prompt.project, index: prompt.index, decision: .keep, expect: prompt.shownExpect)
        case .remove: enqueueClose(project: prompt.project, index: prompt.index, decision: .remove, expect: prompt.shownExpect)
        }
    }

    /// `worktreePerSession`, read fresh when the create sheet opens. Off on failure.
    func readWorktreePerSession() async -> Bool {
        guard let config = try? await mutations.configGet() else { return false }
        if case .bool(let on)? = config["worktreePerSession"] { return on }
        return false
    }

    // MARK: - Rename / Fork (transient-feedback mutations)

    /// Rename a window. Refreshes only after a successful RPC and returns nil;
    /// on a rejected rename the in-memory list is left untouched (there is no
    /// optimistic rename to revert) and the message is RETURNED for the caller
    /// to show — the rename sheet keeps itself open with it.
    func renameSession(project: String, index: Int, newName: String) async -> String? {
        do {
            try await mutations.renameWindow(session: project, index: index, newName: newName)
            await refresh()
            return nil
        } catch {
            return SessionActionError.message("rename", error: error)
        }
    }

    /// Rename a whole project (a tmux session). Same contract as `renameSession`.
    /// Pins are not migrated — the desktop doesn't either.
    func renameProject(oldName: String, newName: String) async -> String? {
        do {
            try await mutations.renameProject(oldName: oldName, newName: newName)
            await refresh()
            return nil
        } catch {
            return SessionActionError.message("rename", error: error)
        }
    }

    /// Fork a window. Refreshes only after a successful RPC; on a rejected fork
    /// the list is left unchanged and a transient message is published. The
    /// view never navigates on failure — navigation only ever follows success.
    func forkSession(sessionId: String, project: String, newName: String) async {
        do {
            try await mutations.forkSession(sessionId: sessionId, sessionName: project, windowName: newName)
            await refresh()
        } catch {
            actionMessage = "Couldn't fork — check the connection"
        }
    }

    /// The window for a project/index pair.
    func window(project: String, index: Int) -> MantaWindow? {
        projects.first(where: { $0.tmuxSession == project })?.windows.first(where: { $0.index == index })
    }

    /// The window (and its project) a chat session lives in.
    func window(forSessionID sessionID: String) -> (project: String, window: MantaWindow)? {
        guard !sessionID.isEmpty else { return nil }
        for project in projects {
            if let window = project.windows.first(where: { $0.opencodeSessionId == sessionID }) {
                return (project.tmuxSession, window)
            }
        }
        return nil
    }

    // MARK: - Close a whole project (spec 04 §7, WS11 D6)

    /// The confirm's words and facts for closing a window (`index`) or the whole project — from the box.
    func closePreview(project: String, index: Int? = nil) async throws -> SessionClosePreview {
        try await mutations.closePreview(project: project, windowIndex: index)
    }

    /// Closes every window of a project on the box: it removes each worktree safely when its setting asks (dirty
    /// ones are KEPT and reported), kills the session, forgets the project's stored settings. The report carries
    /// the box's notice and warnings, in order.
    func closeProject(_ name: String) async -> SessionCloseReport {
        var report = SessionCloseReport()
        do {
            let result = try await mutations.close(project: name, windowIndex: nil, dirtyWorktree: nil, deleteConversation: false, expect: nil)
            if result.ok {
                report.killed = true
                report.lines = ([result.notice].compactMap { $0 }) + result.warnings
            } else {
                report.lines = [result.error ?? SessionActionError.message("close the project", error: MantaError.server(""))]
            }
        } catch {
            report.lines = [BoxCapabilities.isUnknownChannel(error) ? UpdateBoxNote.text : SessionActionError.message("close the project", error: error)]
        }
        await refresh()
        return report
    }

    // MARK: - Recents + switcher (spec 04 §10)

    /// Remember that a session was opened (row tap, push link, navigator, create).
    func noteOpened(project: String, index: Int) {
        let next = SessionRecents.push(SessionRouteLogic.windowKey(project: project, windowIndex: index), into: recents)
        guard next != recents else { return }
        recents = next
        defaults.set(next, forKey: Self.recentsKey)
    }

    /// Every visible session, in list order — what the switcher searches.
    /// Background-job windows are excluded.
    var switcherCandidates: [SessionSwitcherCandidate] {
        visibleProjects.flatMap { project in
            visibleWindows(in: project).map { window in
                SessionSwitcherCandidate(
                    key: SessionRouteLogic.windowKey(project: project.tmuxSession, windowIndex: window.index),
                    project: project.tmuxSession, windowIndex: window.index, name: window.name
                )
            }
        }
    }

    /// One project's visible sessions, most recent activity first (`lastActivity(for:)`:
    /// opencode's `time.updated` joined with the live running/idle transitions) —
    /// what the switcher opened from inside a chat of that project lists.
    func switcherCandidates(inProject name: String) -> [SessionSwitcherCandidate] {
        SessionSwitcher.candidates(inProject: name, projects: visibleProjects) { [self] _, window in
            lastActivity(for: window)
        }
    }

    // MARK: - Launchers (spec 04 §2)

    /// Refresh which AI CLIs are installed and the user's saved launch flags.
    /// Decoration: a failure keeps the last good list and never touches the
    /// session list. Callers coalesce onto one in-flight refresh, and nothing is
    /// published unless it changed (the list re-renders on every publish).
    func refreshLaunchers() async {
        if let running = launcherTask {
            await running.value
            return
        }
        let task = Task { await self.performLauncherRefresh() }
        launcherTask = task
        await task.value
    }

    private func performLauncherRefresh() async {
        let generation = boxGeneration
        defer { if generation == boxGeneration { launcherTask = nil } }
        let catalog: SessionLauncherCatalog
        var list: [AvailableLauncher]?
        do {
            let fetched = try await mutations.launchersList()
            list = fetched
            catalog = .loaded(ids: fetched.map(\.id))
        } catch {
            catalog = .failed(
                message: SessionActionError.message("check the installed AI CLIs", error: error),
                lastGood: launcherCatalog.authoritativeIDs
            )
        }
        // The box resolves the saved launch options when the CLI starts (WS11 D3), so
        // there is nothing to read here but the list.
        guard generation == boxGeneration else { return }
        if let list, list != launchers { launchers = list }
        if catalog != launcherCatalog { launcherCatalog = catalog }
    }

    // MARK: - Stopped conversations (spec 04 §9, D16)

    var unarmedStoppedCount: Int { stoppedRecords.filter { $0.armed != true }.count }

    func isStopped(sessionID: String) -> Bool { stoppedConversations.contains(sessionID) }

    /// Refetch `usage-stopped:list`. A box that predates the channel, or a
    /// failure, keeps the previous set and shows rows normally.
    func refreshStopped() async {
        guard let list = try? await mutations.usageStoppedList() else { return }
        stoppedRecords = list.records
        stoppedLastLooked = list.lastLooked
        stoppedConversations = Set(list.records.map(\.conversation))
    }

    /// A `usage-stopped.updated` frame: refetch the list. Returns the refetch
    /// task (nil for any other frame) so a caller can await it.
    @discardableResult
    func trackStopped(frame: MantaStreamFrame) -> Task<Void, Never>? {
        guard frame.kind == "usage-stopped.updated" else { return nil }
        return Task { await refreshStopped() }
    }

    // MARK: - Create (§7 creation)

    func loadConfig() {
        Task {
            guard let config = try? await api.configGet() else { return }
            if case .array(let pins)? = config["pinnedWindows"] {
                var set = Set<String>()
                for pin in pins {
                    if case .string(let s) = pin { set.insert(s) }
                }
                pinnedWindows = set
            }
            if case .bool(let h)? = config["hapticsEnabled"] {
                hapticsEnabled = h
            }
            if case .string(let ttl)? = config["cacheTtl"] {
                cacheTtlMs = SessionCacheTtl.ms(for: ttl)
            } else {
                cacheTtlMs = SessionCacheTtl.ms(for: nil)
            }
        }
    }

    // MARK: - Refresh on reconnect

    func bindResync() {
        eventStore.resyncHandler = { [weak self] in
            Task { @MainActor in await self?.refresh() }
        }
    }

    // MARK: - Reset on credential change (BET-702 Switch box)

    /// Wipe per-box state after a re-pair switches this device onto a NEW box.
    /// The old box's project list and per-session status bookkeeping must not
    /// bleed into the new box; the next `refresh()` repopulates from it. This
    /// is the single reset path for a credential change — reused by the
    /// "Switch box?" re-pair flow, never duplicated.
    func resetForBoxChange() {
        projects = []
        loading = false
        loadError = nil
        loadedOnce = false
        pendingDeletes = [:]
        sessionMeta = [:]
        progressBySession = [:]
        backgroundJobsBySession = [:]
        hiddenByProject = [:]
        pinnedWindows = []
        hapticsEnabled = true
        previouslyRunning = []
        liveActivity = [:]
        terminalStatus = [:]
        // WS04 box state. Device-local recents and saved modes are kept — they
        // are the user's habits on this phone, not facts about a box.
        launcherCatalog = .loading
        launchers = []
        stoppedRecords = []
        stoppedLastLooked = nil
        stoppedConversations = []
        closeGeneration += 1
        boxGeneration += 1
        closeQueue = []
        closeWorker?.cancel()
        closeWorker = nil
        launcherTask?.cancel()
        launcherTask = nil
        worktreePrompts = []
        closeFeedback = []
    }
}
