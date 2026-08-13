import Foundation
import Combine
import SwiftUI

// ===========================================================================
// S3 — session-list store (BET-595).
//
// Owns the live data behind the §7.1 list:
//   - the grouped project/window list from `tmux:list` (refreshed on demand
//     and on every healthy stream reconnect via `resyncHandler`);
//   - per-row live status (running / attention / subagents / model) merged
//     from the S1b event store (`sessionStates` keyed by the window's
//     `opencodeSessionId`) plus attention tracking on the raw frame surface;
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
    /// opencodeSessionID -> when its turn started running (drives the §7.1
    /// timer slot while running).
    @Published private(set) var runningSince: [String: Date] = [:]

    private let api: MantaAPIClient
    private let mutations: SessionListMutationAPI
    private let eventStore: MantaEventStore
    private var undoTimers: [String: Timer] = [:]
    private var cancellables: Set<AnyCancellable> = []
    private var attentionSessions: Set<String> = []
    private var modelLabels: [String: String] = [:]
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
        self.eventStore.rawFrameHandler = { [weak self] frame in
            self?.trackAttention(frame: frame)
        }
        eventStore.$sessionStates
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.trackRunning(now: Date()) }
            .store(in: &cancellables)
    }

    private func trackRunning(now: Date) {
        var changed = false
        for (sid, state) in eventStore.sessionStates {
            if state.running == true {
                if runningSince[sid] == nil {
                    runningSince[sid] = now
                    changed = true
                }
            } else if runningSince[sid] != nil {
                runningSince.removeValue(forKey: sid)
                changed = true
            }
        }
        if changed { objectWillChange.send() }
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
            await refreshModels()
        } catch {
            // Keep whatever was already on screen — a failed fetch must never
            // blank a list we successfully loaded before.
            loadError = Self.describe(error)
        }
    }

    private static func describe(_ error: Error) -> String {
        if let known = error as? MantaError, known == .authRequired {
            return "Your box rejected this device — pair it again."
        }
        return "Couldn't reach your box"
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
    }

    private func refreshModels() async {
        guard let sessions = try? await api.listSessions() else { return }
        var labels: [String: String] = [:]
        for s in sessions {
            if let model = s.model {
                labels[s.id] = ModelLabel.text(providerID: model.providerID, modelID: model.id)
            }
        }
        modelLabels = labels
    }

    // MARK: - Row status (reads the S1b store)

    /// The window's live status, merging the box's stream state with the
    /// attention set. Pure inputs; presentation decided in SessionModels.
    func rowStatus(for window: MantaWindow) -> SessionRowStatus {
        let sid = window.opencodeSessionId ?? ""
        let stream = eventStore.sessionStates[sid]
        let running = stream?.running == true
        let subagents = runningSubagents(stream?.subagents ?? [])
        return SessionRowStatus(
            running: running,
            attention: attentionSessions.contains(sid),
            subagentsRunning: subagents,
            modelLabel: modelLabels[sid]
        )
    }

    /// Number of live child subagents for a session (box-published).
    private func runningSubagents(_ subagents: [StreamSubagentPayload]) -> Int {
        let counted = subagents.filter { $0.status == "running" }.count
        if counted > 0 { return counted }
        if let last = subagents.last, let count = last.runningCount {
            return Int(count)
        }
        return 0
    }

    // MARK: - Attention (needs-you dot / subtitle)

    /// Track `question.*` / `permission.*` request/response frames as a per-
    /// session "needs you" signal for the §7.1 warn dot + §7.1a subtitle.
    private func trackAttention(frame: MantaStreamFrame) {
        guard let kind = kind(frame), let sid = frame.sessionId else { return }
        // Compute the new value first and publish ONLY when it actually differs
        // from the stored one (BET-672): the raw frame surface carries a row
        // for every raw event, so an unconditional `objectWillChange.send()`
        // re-rendered the whole session list per frame even when the attention
        // set did not change.
        var changed = false
        if kind == "question.asked" || kind == "permission.asked" {
            if !attentionSessions.contains(sid) {
                attentionSessions.insert(sid)
                changed = true
            }
        } else if kind == "question.replied" || kind == "question.rejected"
            || kind == "permission.replied" || kind == "permission.rejected" {
            changed = attentionSessions.remove(sid) != nil
        }
        if changed { objectWillChange.send() }
    }

    private func kind(_ frame: MantaStreamFrame) -> String? {
        guard case .object(let obj) = frame.payload ?? .object([:]) else {
            return frame.kind
        }
        // Raw opencode events carry `kind` at the top frame level; fall back
        // to the envelope kind.
        if case .string(let s)? = obj["kind"] { return s }
        return frame.kind
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
    /// it fires from `commitExpiredDeletes` only after the toast expires.
    func beginIdleDelete(session: String, index: Int) {
        let id = SessionPinID.window(session, index: index)
        cancelPendingDelete(id)
        let pending = PendingDelete(
            target: .window(session: session, index: index),
            pinID: id,
            startedAt: Date()
        )
        pendingDeletes[id] = pending
        let timer = Timer(timeInterval: PendingDelete.undoWindow, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.commitPendingDelete(id) }
        }
        RunLoop.main.add(timer, forMode: .common)
        undoTimers[id] = timer
    }

    /// Undo an idle delete within its undo window.
    func undoPendingDelete(_ id: String) {
        cancelPendingDelete(id)
    }

    /// Fire the RPC for anything still pending whose window has expired.
    /// Called by the view when the undo toast is auto-dismissed.
    func commitExpiredDeletes(now: Date = Date()) {
        let expired = pendingDeletes.values.filter { $0.expired(now: now) }.map(\.pinID)
        for id in expired { commitPendingDelete(id) }
    }

    private func cancelPendingDelete(_ id: String) {
        pendingDeletes.removeValue(forKey: id)
        undoTimers[id]?.invalidate()
        undoTimers[id] = nil
    }

    private func commitPendingDelete(_ id: String) {
        guard let pending = pendingDeletes.removeValue(forKey: id) else { return }
        undoTimers[id]?.invalidate()
        undoTimers[id] = nil
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
        for (_, timer) in undoTimers { timer.invalidate() }
        undoTimers = [:]
        runningSince = [:]
        attentionSessions = []
        modelLabels = [:]
        pinnedWindows = []
        hapticsEnabled = true
    }
}
