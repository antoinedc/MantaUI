import Foundation
import Combine
import SwiftUI
import UIKit

// ===========================================================================
// Auto-handoff — the per-chat store (spec 2026-10-26-auto-handoff §3, §6.4, §7,
// §8, §9, §15).
//
// One store per open chat. It mirrors the box's handoff records for that
// session (`handoff:list`, refreshed on every `handoff` bus frame and on every
// reconnect), runs the card actions (`handoff:start` / `retry` / `create` /
// `draft-consumed`) and turns a committed handoff into the one thing the screen
// must do about it: switch to the successor (replacement), open the branch
// (only on the device that started it), or load a draft into the composer.
//
// The DECISIONS are pure and live in `HandoffModels.swift`; this file is the
// I/O + published state around them. It reaches the screen through callbacks
// (`onSwitchToSuccessor`, `onOpenBranch`, `onDraft`, `onHint`) set by the chat
// screen, so it never touches navigation or the composer itself.
// ===========================================================================

/// What a replacement carries from the predecessor's composer onto the
/// successor's (§8): unsent text and the attachments already uploaded.
/// Attachments still uploading are bound to the old composer and cannot follow;
/// `skippedUploads` lets the new screen say so instead of dropping them silently.
struct HandoffCarryOver {
    var text: String
    var attachments: [ComposerAttachment]
    var skippedUploads: Int
}

/// `UserDefaults` behind the pure draft-storage seam.
struct DefaultsHandoffStore: HandoffKeyValueStore {
    var defaults: UserDefaults = .standard

    func string(forKey key: String) -> String? { defaults.string(forKey: key) }

    func set(_ value: String?, forKey key: String) {
        if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
    }
}

@MainActor
final class HandoffStore: ObservableObject {

    /// Every record this chat knows, by id: the box's list for the session plus
    /// any fetched individually for a transcript card.
    @Published private(set) var records: [String: HandoffRecord] = [:]
    /// Ids whose `handoff:get` came back expired (retention) — the card says so.
    @Published private(set) var expiredIDs: Set<String> = []
    /// Ids whose fetch failed for another reason — the card offers a retry.
    @Published private(set) var loadFailedIDs: Set<String> = []
    /// Records with an action in flight; their buttons are disabled.
    @Published private(set) var busyIDs: Set<String> = []
    /// The record whose text was just copied — drives the "Copied" confirmation.
    @Published private(set) var copiedID: String?
    /// Cards whose body is expanded (kept here, not in the cell: a transcript
    /// cell is recycled on scroll and would forget a `@State`).
    @Published private(set) var expandedIDs: Set<String> = []
    @Published private(set) var links: HandoffLinks?
    @Published private(set) var continuation: HandoffContinuation?
    @Published private(set) var mode: HandoffMode?
    @Published private(set) var modeError: String?
    @Published private(set) var previous: [HandoffPreviousEntry] = []
    @Published private(set) var titles: [String: String] = [:]
    /// A create (`/handoff`, "Hand off") is in flight.
    @Published private(set) var creating = false

    let sessionId: String
    private let api: MantaAPIClient
    private let eventStore: MantaEventStore
    private let defaults: HandoffKeyValueStore

    /// A committed replacement while this chat shows the predecessor.
    var onSwitchToSuccessor: ((String) -> Void)?
    /// A committed branch this device started.
    var onOpenBranch: ((String) -> Void)?
    /// A draft to load into the composer (already persisted locally).
    var onDraft: ((String) -> Void)?
    /// A visible one-line result or failure.
    var onHint: ((String) -> Void)?

    private var cancellables = Set<AnyCancellable>()
    private var started = false
    private var refreshing = false
    private var refreshAgain = false
    private var didSwitch = false
    private var awaitingBranch: Set<String> = []
    private var unackedDrafts: [String: HandoffLocalDraft] = [:]
    private var lastWalkedLinks: HandoffLinks?
    private var walkGeneration = 0
    private var titlesLoaded = false

    init(sessionId: String, api: MantaAPIClient, eventStore: MantaEventStore,
         defaults: HandoffKeyValueStore = DefaultsHandoffStore()) {
        self.sessionId = sessionId
        self.api = api
        self.eventStore = eventStore
        self.defaults = defaults
    }

    // MARK: - Lifecycle

    /// Subscribe to the bus + reconnects and load the box's view. Idempotent.
    func start() {
        guard !started else { return }
        started = true
        eventStore.handoffUpdates
            .receive(on: DispatchQueue.main)
            .sink { [weak self] event in self?.handle(event) }
            .store(in: &cancellables)
        // A reconnect may have missed frames: re-read rather than assume.
        eventStore.$connectionState
            .dropFirst()
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                if case .connected = state { self?.refresh() }
            }
            .store(in: &cancellables)
        refresh()
        Task { await loadMode() }
    }

    // MARK: - Derived

    /// Server records pinned above the composer (not the agent-tool ones, which
    /// render inline as the `handoff` tool part).
    var pinned: [HandoffRecord] {
        HandoffCardLogic.pinned(records: Array(records.values), sessionId: sessionId)
    }

    /// The armed preamble ("Carried-over context — sent with the next message"),
    /// shown until the box clears it on the first accepted message.
    var armedPreamble: String? {
        continuation?.hasPreamble == true ? continuation?.preamble : nil
    }

    /// The notice at the top of a successor.
    var notice: HandoffPrevious.Notice? {
        let tokens = records.values
            .first { $0.successorId == sessionId && $0.how == HandoffHow.clear.rawValue }?
            .contextTokens
        return HandoffPrevious.notice(links: links, title: { [titles] in titles[$0] }, handedOffTokens: tokens)
    }

    func title(for sessionId: String) -> String {
        titles[sessionId] ?? "Previous session"
    }

    func isExpanded(_ id: String) -> Bool { expandedIDs.contains(id) }

    func toggleExpanded(_ id: String) {
        if !expandedIDs.insert(id).inserted { expandedIDs.remove(id) }
    }

    // MARK: - Refresh / reconcile

    func refresh() {
        if refreshing { refreshAgain = true; return }
        refreshing = true
        Task {
            repeat {
                refreshAgain = false
                // A background re-read: a failure keeps what is on screen and the
                // next frame or reconnect tries again.
                if let result = try? await api.handoffList(sessionId: sessionId) { apply(result) }
            } while refreshAgain
            refreshing = false
        }
    }

    private func apply(_ result: HandoffListResult) {
        for record in result.records {
            records[record.id] = record
            expiredIDs.remove(record.id)
            loadFailedIDs.remove(record.id)
        }
        links = result.links
        continuation = result.continuation

        if case .switchTo(let next) = HandoffReconcile.action(viewing: sessionId, links: result.links) {
            fireSwitch(next)
        }
        for record in result.records { reconcile(record.commit) }
        consumeDraftIfNeeded(records: result.records, continuation: result.continuation)
        retryUnackedDrafts()
        walkPreviousIfNeeded(result.links)
    }

    private func handle(_ event: HandoffBusEvent) {
        let relevant = event.fromSessionId == sessionId || event.successorId == sessionId || records[event.id] != nil
        guard relevant else { return }
        if var known = records[event.id] {
            known.state = event.state
            if let successor = event.successorId { known.successorId = successor }
            if let how = event.how { known.how = how }
            if let disposition = event.disposition { known.disposition = disposition }
            records[event.id] = known
        }
        reconcile(event.commit)
        refresh()
    }

    private func reconcile(_ commit: HandoffCommit) {
        guard !didSwitch else { return }
        switch HandoffReconcile.action(viewing: sessionId, commit: commit, awaitingBranch: awaitingBranch) {
        case .none:
            break
        case .switchTo(let next):
            fireSwitch(next)
        case .openBranch(let next):
            awaitingBranch.remove(commit.id)
            onOpenBranch?(next)
        }
    }

    private func fireSwitch(_ successor: String) {
        guard !didSwitch else { return }
        didSwitch = true
        onSwitchToSuccessor?(successor)
    }

    // MARK: - Records

    private func upsert(_ record: HandoffRecord) {
        records[record.id] = record
        expiredIDs.remove(record.id)
        loadFailedIDs.remove(record.id)
    }

    /// Make sure a transcript card's record is loaded. An expired record is
    /// remembered so the card says so; any other failure is remembered so the
    /// card can offer a retry instead of an endless "Loading…".
    func ensure(_ id: String) async {
        if records[id] != nil || expiredIDs.contains(id) { return }
        do {
            upsert(try await api.handoffGet(id: id))
        } catch {
            if HandoffFailure.isExpired(error) {
                expiredIDs.insert(id)
            } else {
                loadFailedIDs.insert(id)
            }
        }
    }

    func reload(_ id: String) {
        loadFailedIDs.remove(id)
        Task { await ensure(id) }
    }

    // MARK: - Actions

    /// `/handoff [goal]`, "Hand off": make a card for this session (§4.1: every
    /// manual entry yields a `ready` card in any mode).
    func create(trigger: String, goal: String? = nil) {
        guard !creating else { return }
        creating = true
        Task {
            defer { creating = false }
            do {
                upsert(try await api.handoffCreate(sessionId: sessionId, trigger: trigger, action: "suggest", goal: goal))
                onHint?("Preparing a handoff prompt…")
            } catch {
                onHint?(HandoffFailure.message(error, doing: "Couldn't start a handoff"))
            }
        }
    }

    /// Clear & start (`clear` + `send`), Start in new session (`new-session` +
    /// `send`), Edit first (either way, `draft`). Enabled only in `ready`.
    func start(_ record: HandoffRecord, how: HandoffHow, disposition: HandoffDisposition) {
        guard HandoffCardLogic.actionsEnabled(record), !busyIDs.contains(record.id) else { return }
        busyIDs.insert(record.id)
        // Set BEFORE the call: the commit frame can beat the reply, and only the
        // device that started a branch may open it (§6.4).
        if how == .newSession { awaitingBranch.insert(record.id) }
        Task {
            defer { busyIDs.remove(record.id) }
            do {
                let updated = try await api.handoffStart(id: record.id, how: how, disposition: disposition)
                upsert(updated)
                reconcile(updated.commit)
            } catch {
                // A refusal (or another device winning the race) means this device
                // did not start it, so it is not the one that opens a branch. A
                // transport failure proves nothing — the start may have landed,
                // so keep waiting for its commit frame.
                if case MantaError.server = error { awaitingBranch.remove(record.id) }
                onHint?(HandoffFailure.message(error, doing: "Couldn't start the handoff"))
                if HandoffFailure.isAlreadyStarted(error) { refresh() }
            }
        }
    }

    func retry(_ record: HandoffRecord) {
        guard HandoffCardLogic.showsRetry(record), !busyIDs.contains(record.id) else { return }
        busyIDs.insert(record.id)
        Task {
            defer { busyIDs.remove(record.id) }
            do {
                upsert(try await api.handoffRetry(id: record.id))
            } catch {
                onHint?(HandoffFailure.message(error, doing: "Couldn't retry the handoff"))
            }
        }
    }

    /// Copy the raw markdown (§3). The button flips to "Copied" for two seconds.
    func copy(_ record: HandoffRecord) {
        guard HandoffCardLogic.actionsEnabled(record) else { return }
        UIPasteboard.general.string = record.text
        copiedID = record.id
        let id = record.id
        Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if copiedID == id { copiedID = nil }
        }
    }

    /// "Started" badge tap: a branch opens in its own window; a replacement is
    /// the window already showing it, so this switches to the successor.
    func openSuccessor(_ record: HandoffRecord) {
        guard let successor = record.successorId, !successor.isEmpty else { return }
        if record.how == HandoffHow.newSession.rawValue {
            onOpenBranch?(successor)
        } else {
            didSwitch = true
            onSwitchToSuccessor?(successor)
        }
    }

    // MARK: - Draft (§7)

    /// Persist the draft locally FIRST, then load it into the composer, then
    /// tell the box it was consumed — so a crash between any two steps cannot
    /// lose the only copy.
    private func consumeDraftIfNeeded(records: [HandoffRecord], continuation: HandoffContinuation?) {
        guard let pending = HandoffDraftStorage.pending(
            sessionId: sessionId,
            records: records,
            continuation: continuation,
            isConsumed: { [defaults] id, revision in
                HandoffDraftStorage.isConsumed(recordId: id, revision: revision, in: defaults)
            }
        ), let revision = continuation?.draftRevision else { return }
        HandoffDraftStorage.save(pending, in: defaults)
        // Marked locally BEFORE loading so a second refresh can never load the
        // same revision into the composer twice, even if the ack below fails.
        HandoffDraftStorage.markConsumed(recordId: pending.recordId, revision: pending.revision, in: defaults)
        onDraft?(pending.text)
        unackedDrafts[pending.recordId] = pending
        acknowledge(pending, revision: revision)
    }

    private func acknowledge(_ draft: HandoffLocalDraft, revision: JSONValue) {
        Task {
            // A failure leaves the draft in `unackedDrafts` and the next refresh
            // re-sends it; the local copy already exists, so nothing is at risk.
            if (try? await api.handoffDraftConsumed(id: draft.recordId, draftRevision: revision)) != nil {
                unackedDrafts.removeValue(forKey: draft.recordId)
            }
        }
    }

    private func retryUnackedDrafts() {
        guard let revision = continuation?.draftRevision else { return }
        for draft in unackedDrafts.values where HandoffDraftStorage.revisionKey(revision) == draft.revision {
            acknowledge(draft, revision: revision)
        }
    }

    /// A draft persisted by a previous run (the app was killed after the box
    /// consumed it) that was never sent or cleared.
    func restoreLocalDraft() -> String? {
        HandoffDraftStorage.load(sessionId: sessionId, from: defaults)?.text
    }

    /// The composer was emptied (sent or cleared): the local copy has done its job.
    func clearLocalDraft() {
        HandoffDraftStorage.clear(sessionId: sessionId, in: defaults)
    }

    // MARK: - Mode (§9)

    func loadMode() async {
        guard let config = try? await api.configGet() else { return }
        mode = HandoffMode.from(config: config)
    }

    /// Persist the three-way mode over `config:update`; a failure reverts the
    /// control and says so.
    func setMode(_ next: HandoffMode) {
        guard next != mode else { return }
        let old = mode
        mode = next
        modeError = nil
        Task {
            do {
                _ = try await api.configUpdate(["handoffMode": next.rawValue])
            } catch {
                mode = old
                modeError = "Couldn't change handoff mode — check the connection"
            }
        }
    }

    // MARK: - Previous sessions (§9)

    /// Walk the replacement chain backwards (one `handoff:list` per hop, bounded
    /// and cycle-safe) and build the "Previous sessions" list. Only when this
    /// session's own links changed — not on every frame.
    private func walkPreviousIfNeeded(_ newLinks: HandoffLinks?) {
        guard newLinks != lastWalkedLinks else { return }
        lastWalkedLinks = newLinks
        walkGeneration += 1
        let generation = walkGeneration
        guard let newLinks else {
            previous = []
            return
        }
        Task {
            var lineage: [(sessionId: String, links: HandoffLinks?)] = [(sessionId, newLinks)]
            var visited: Set<String> = [sessionId]
            var cursor = newLinks.replaces
            while let id = cursor, !id.isEmpty, !visited.contains(id), lineage.count < 25 {
                visited.insert(id)
                let hop = (try? await api.handoffList(sessionId: id))?.links
                lineage.append((id, hop))
                cursor = hop?.replaces
            }
            guard generation == walkGeneration else { return }
            previous = HandoffPrevious.entries(lineage: lineage)
            await loadTitlesIfNeeded()
        }
    }

    /// Titles for the previous sessions' names, fetched once. Best effort: an
    /// unknown title reads "Previous session".
    func loadTitlesIfNeeded() async {
        guard !titlesLoaded, links?.replaces != nil || links?.branchedFrom != nil || !previous.isEmpty else { return }
        titlesLoaded = true
        guard let sessions = try? await api.listSessions() else {
            titlesLoaded = false
            return
        }
        var map: [String: String] = [:]
        for session in sessions {
            if let title = session.title, !title.isEmpty { map[session.id] = title }
        }
        titles = map
    }
}

// MARK: - Environment

private struct HandoffStoreKey: EnvironmentKey {
    static let defaultValue: HandoffStore? = nil
}

extension EnvironmentValues {
    /// The chat's handoff store, injected into transcript cells (the same
    /// delivery as `widgetLiveStore`). nil on read-only surfaces, where a
    /// handoff card renders without actions.
    var handoffStore: HandoffStore? {
        get { self[HandoffStoreKey.self] }
        set { self[HandoffStoreKey.self] = newValue }
    }
}
