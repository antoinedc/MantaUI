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

/// The rename/fork RPC seam for the session-list surface, so the store's
/// "refresh only after a successful mutation" orchestration is unit-testable
/// without a live box. The live adapter wraps `MantaAPIClient`'s existing RPCs
/// unchanged (no semantics change — only the swallowing call sites move here).
@MainActor
protocol SessionListMutationAPI {
    func renameWindow(session: String, index: Int, newName: String) async throws
    func forkSession(sessionId: String, sessionName: String, windowName: String) async throws
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
    /// Background-delegation jobs keyed by the job's child opencode session id
    /// (BET-1213). Decoration ONLY: fetched on the same cadence as `projects`
    /// but tolerated — a box that predates delegation errors on `delegate:list`,
    /// and that must leave the list fully visible with no counts (a missing job
    /// list is missing decoration, never missing sessions).
    @Published private(set) var delegateJobs: [String: DelegateJob] = [:]

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

    init(api: MantaAPIClient = MantaAPIClient.live(), eventStore: MantaEventStore, mutations: SessionListMutationAPI? = nil) {
        self.api = api
        self.mutations = mutations ?? ServerSessionListMutations(api: api)
        self.eventStore = eventStore
        self.loadConfig()
        self.eventStore.addRawFrameHandler { [weak self] frame in
            self?.trackProgress(frame: frame)
        }
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
            let list = try await api.projects()
            projects = list
            loadedOnce = true
            loadError = nil
            await refreshSessionMeta()
            // The job list is decoration: if `delegate:list` fails (an older
            // box errors on the unknown channel), every window stays visible
            // and no count shows — never a blank list. On success adopt it; on
            // failure keep whatever we had (stale jobs still resolve to real
            // windows) and just re-derive nesting against the new projects.
            if let jobs = try? await api.delegateList() {
                applyJobs(jobs)
            } else {
                recomputeNesting()
            }
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

    /// The windows that actually render for a project — its top-level rows with
    /// background-job child windows filtered out (BET-1213).
    func visibleWindows(in project: MantaProject) -> [MantaWindow] {
        let hidden = hiddenByProject[project.tmuxSession] ?? []
        return project.windows.filter { !hidden.contains($0.index) }
    }

    /// Adopt the fetched job list, keyed by childSessionID, and re-derive
    /// nesting (hidden windows + per-parent counts) against the current
    /// projects.
    private func applyJobs(_ list: [DelegateJob]) {
        var jobs: [String: DelegateJob] = [:]
        for j in list {
            if let child = j.childSessionID, !child.isEmpty { jobs[child] = j }
        }
        delegateJobs = jobs
        recomputeNesting()
    }

    /// Re-run the pure nesting computation over the current projects+jobs and
    /// publish the derived maps. Called whenever either input changes.
    private func recomputeNesting() {
        var hidden: [String: Set<Int>] = [:]
        var counts: [String: Int] = [:]
        let jobs = Array(delegateJobs.values)
        for p in projects {
            let nesting = SessionJobNesting.compute(project: p, jobs: jobs)
            hidden[p.tmuxSession] = nesting.hidden
            for (index, count) in nesting.activeChildCounts {
                if let w = p.windows.first(where: { $0.index == index }),
                   let sid = w.opencodeSessionId, !sid.isEmpty {
                    counts[sid] = count
                }
            }
        }
        hiddenByProject = hidden
        backgroundJobsBySession = counts
    }

    private func refreshSessionMeta() async {
        guard let sessions = try? await api.listSessions() else { return }
        var meta: [String: SessionMeta] = [:]
        for s in sessions {
            meta[s.id] = SessionMeta(
                modelLabel: s.model.map { ModelLabel.text(providerID: $0.providerID, modelID: $0.id) },
                lastActivity: s.time?.updated.map { Date(timeIntervalSince1970: $0 / 1000) }
            )
        }
        sessionMeta = meta
        // BET-791: backfill the working progress label for every session so
        // the subtitle is right even when the app (re)connected after a
        // progress_report but before any live `progress.updated` frame. The
        // record fetched for a session that has none (or whose turn isn't
        // `working`) clears any stale label — authoritative to the box.
        var progress: [String: String] = [:]
        for s in sessions {
            if let label = await workingProgressLabel(sessionID: s.id) {
                progress[s.id] = label
            }
        }
        progressBySession = progress
    }

    // MARK: - Row status (reads the S1b store)

    /// The window's live status, merging the box's stream state with the
    /// attention derived from its pending questions/permissions. Pure inputs;
    /// presentation decided in SessionModels.
    func rowStatus(for window: MantaWindow) -> SessionRowStatus {
        let sid = window.opencodeSessionId ?? ""
        let stream = eventStore.sessionStates[sid]
        let running = stream?.running == true
        let attention = !(stream?.questions?.questions.isEmpty ?? true)
            || !(stream?.permissions?.permissions.isEmpty ?? true)
        return SessionRowStatus(
            running: running,
            attention: attention,
            backgroundJobs: backgroundJobsBySession[sid] ?? 0,
            modelLabel: sessionMeta[sid]?.modelLabel,
            progressLabel: progressBySession[sid],
            lastActivity: sessionMeta[sid]?.lastActivity,
            isTerminal: window.opencodeSessionId == nil
        )
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
            startedAt: Date()
        )
        pendingDeletes[id] = pending
    }

    /// Undo an idle delete within its undo window.
    func undoPendingDelete(_ id: String) {
        cancelPendingDelete(id)
    }

    /// Fire the RPC for anything still pending whose window has expired.
    /// Called by the undo toast's `.task(id:)` when it times out. Returns
    /// whether anything was committed (so the caller can gate a confirm haptic).
    @discardableResult
    func commitExpiredDeletes(now: Date = Date()) -> Bool {
        let expired = pendingDeletes.values.filter { $0.expired(now: now) }.map(\.pinID)
        var committed = false
        for id in expired where commitPendingDelete(id) { committed = true }
        return committed
    }

    private func cancelPendingDelete(_ id: String) {
        pendingDeletes.removeValue(forKey: id)
    }

    @discardableResult
    private func commitPendingDelete(_ id: String) -> Bool {
        guard let pending = pendingDeletes.removeValue(forKey: id) else { return false }
        switch pending.target {
        case .window(let session, let index):
            let chatID = chatSessionID(session: session, index: index)
            Task {
                do {
                    if let chatID {
                        try await api.deleteSession(sessionId: chatID, sessionName: session, windowIndex: index)
                    } else {
                        try await api.killWindow(KillWindowInput(sessionName: session, windowIndex: index))
                    }
                    await refresh()
                } catch {
                    // Server rejected the delete — refresh so the row's real
                    // state is shown rather than a phantom removal.
                    await refresh()
                }
            }
        }
        return true
    }

    // MARK: - Rename / Fork (transient-feedback mutations)

    /// Rename a window. Refreshes only after a successful RPC; on a rejected
    /// rename the in-memory list is left untouched (the pre-failure snapshot —
    /// there is no optimistic rename to revert) and a transient message is
    /// published for the view to surface.
    func renameSession(project: String, index: Int, newName: String) async {
        do {
            try await mutations.renameWindow(session: project, index: index, newName: newName)
            await refresh()
        } catch {
            actionMessage = "Couldn't rename — check the connection"
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

    /// The opencode session id for a window, if any (for chat deletes).
    private func chatSessionID(session: String, index: Int) -> String? {
        projects
            .first(where: { $0.tmuxSession == session })?
            .windows
            .first(where: { $0.index == index })?
            .opencodeSessionId
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
        delegateJobs = [:]
        backgroundJobsBySession = [:]
        hiddenByProject = [:]
        pinnedWindows = []
        hapticsEnabled = true
    }
}
