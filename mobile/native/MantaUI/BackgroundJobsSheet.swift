import Combine
import SwiftUI

// ===========================================================================
// Background jobs (spec §4).
//
// The sheet behind the chat overflow menu's "Background jobs" entry: every job
// THIS session started — a `delegate` job and a `task` subagent launched with
// `background: true` come through the same `delegate:list` — with its status,
// what it is doing, and a way to open its own session or stop it.
//
// Built from stock SwiftUI (NavigationStack + List), the same family as the
// Scheduled tasks / Secrets / Artifacts cards it sits beside, and refreshed the
// same way: on open, on `delegate.updated`, and on a 10 s poll while it is on
// screen.
//
// Tapping a job leaves the sheet and pushes the job's session as a normal chat
// screen (a sheet is the wrong container for content navigation); the caller
// owns that push through `onOpenSession`.
// ===========================================================================

/// Where a job's own window lives, so a caller that is handed only a child
/// session id can still build the navigation target for it.
struct BackgroundJobWindow: Equatable, Sendable {
    let project: String
    let index: Int
    let name: String
}

/// Live data behind the Background jobs sheet and the overflow entry's count.
@MainActor
final class BackgroundJobsStore: ObservableObject {

    /// The jobs this session started, live ones first, newest first.
    @Published private(set) var jobs: [DelegateJob] = []
    /// Child session ids whose tmux window still exists, i.e. the jobs whose
    /// session can actually be opened. A finished job's window is removed by the
    /// box, so most terminal rows are NOT in here.
    @Published private(set) var openableChildIDs: Set<String> = []
    /// True once a job fetch has come back (a first-load spinner vs. an empty
    /// list).
    @Published private(set) var loaded = false
    /// Set when the last fetch failed; the jobs already on screen are kept.
    @Published private(set) var loadError: String?
    /// True once the window lookup has succeeded at least once. Until then an
    /// unopenable row cannot honestly say "window closed" — it does not know.
    @Published private(set) var windowsKnown = false

    let sessionId: String
    private let api: MantaAPIClient
    private let eventStore: MantaEventStore?
    private var childWindows: [String: BackgroundJobWindow] = [:]
    private var pollTask: Task<Void, Never>?
    private var updatesSubscription: AnyCancellable?
    private var refreshing = false
    private var refreshQueued = false
    private var autoRefreshHolders = 0

    /// How often the sheet re-reads the list while it is on screen.
    private static let pollIntervalNanoseconds: UInt64 = 10_000_000_000

    /// `eventStore` is what lets the sheet refetch the instant the box reports a
    /// job change; without one the 10 s poll still keeps it fresh, just slower.
    init(api: MantaAPIClient, sessionId: String, eventStore: MantaEventStore? = nil) {
        self.api = api
        self.sessionId = sessionId
        self.eventStore = eventStore
    }

    /// Jobs still in flight (running, or paused awaiting a resume).
    var runningCount: Int { jobs.filter(\.isActive).count }

    /// The job record for a child session, if this session started it — the
    /// transcript uses it to tell a still-working background subagent from a
    /// finished one.
    func childStatus(_ childSessionID: String) -> String? {
        jobs.first(where: { $0.childSessionID == childSessionID })?.status
    }

    /// The window a child session lives in, when it has one.
    func window(forChild childSessionID: String) -> BackgroundJobWindow? {
        childWindows[childSessionID]
    }

    /// Re-fetch the jobs and which of their windows still exist. Overlapping
    /// calls are coalesced into one re-run rather than dropped.
    func refresh() async {
        if refreshing {
            refreshQueued = true
            return
        }
        refreshing = true
        defer { refreshing = false }
        repeat {
            refreshQueued = false
            await fetchOnce()
        } while refreshQueued
    }

    private func fetchOnce() async {
        do {
            let fetched = try await api.delegateList(sessionId: sessionId)
            let list = BackgroundJobFormat.sorted(fetched)
            if list != jobs { jobs = list }
            loadError = nil
        } catch {
            // Keep the jobs already on screen: a failed refresh must not blank
            // a list that loaded fine a moment ago.
            loadError = BackgroundJobFormat.failureReason(error)
        }
        loaded = true
        await refreshWindows()
    }

    private func refreshWindows() async {
        let children = Set(jobs.compactMap(\.childSessionID).filter { !$0.isEmpty })
        guard !children.isEmpty else {
            childWindows = [:]
            openableChildIDs = []
            return
        }
        guard let projects = try? await api.projects() else { return }
        var found: [String: BackgroundJobWindow] = [:]
        for project in projects {
            for window in project.windows {
                if let sid = window.opencodeSessionId, children.contains(sid) {
                    found[sid] = BackgroundJobWindow(project: project.tmuxSession, index: window.index, name: window.name)
                }
            }
        }
        childWindows = found
        let ids = Set(found.keys)
        if ids != openableChildIDs { openableChildIDs = ids }
        windowsKnown = true
    }

    /// True while at least one holder has asked for auto-refresh.
    var isAutoRefreshing: Bool { autoRefreshHolders > 0 }

    /// Take a hold on the 10 s poll and the `delegate.updated` refetch. The
    /// store is shared (the chat screen holds it for task-row status, the
    /// Background jobs sheet holds it while open), so this is reference-counted:
    /// the poll starts on the first hold and runs until the last is released.
    /// Every call must be balanced by one `stopAutoRefresh()`.
    func startAutoRefresh() {
        autoRefreshHolders += 1
        guard autoRefreshHolders == 1 else { return }
        updatesSubscription = eventStore?.delegateUpdates
            .receive(on: DispatchQueue.main)
            .sink { [weak self] in
                Task { @MainActor in await self?.refresh() }
            }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                // Re-bound every pass, so a store nobody holds any more ends
                // the loop instead of leaving it ticking on a nil.
                guard let self else { return }
                await self.refresh()
                try? await Task.sleep(nanoseconds: Self.pollIntervalNanoseconds)
            }
        }
    }

    /// Release one hold; the poll is torn down when the last one goes. Extra
    /// calls never take the count below zero.
    func stopAutoRefresh() {
        guard autoRefreshHolders > 0 else { return }
        autoRefreshHolders -= 1
        guard autoRefreshHolders == 0 else { return }
        pollTask?.cancel()
        pollTask = nil
        updatesSubscription?.cancel()
        updatesSubscription = nil
    }

    /// Stop a running or paused job. THROWS when the box refuses or cannot be
    /// reached, so the caller can tell the user why; refreshes on success.
    func stop(_ jobId: String) async throws {
        try await api.delegateStop(id: jobId)
        await refresh()
    }
}

struct BackgroundJobsSheet: View {
    @ObservedObject var store: BackgroundJobsStore
    private let onOpenSession: (_ childSessionID: String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    /// Ticks so a running job's elapsed time and a finished one's "ago" keep
    /// moving while the sheet sits open.
    @State private var now = Date()
    @State private var showStopConfirm = false
    /// The job the open confirmation is about. Deliberately NOT cleared when the
    /// confirmation dismisses itself: its destructive button dismisses and then
    /// acts in the same call, so the action must still be able to read it.
    @State private var stopTarget: DelegateJob?
    @State private var stopping: Set<String> = []
    @State private var banner: Banner?

    private struct Banner: Equatable {
        let id = UUID()
        let text: String
        let isError: Bool
    }

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    init(store: BackgroundJobsStore, onOpenSession: @escaping (_ childSessionID: String) -> Void) {
        _store = ObservedObject(wrappedValue: store)
        self.onOpenSession = onOpenSession
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Background jobs")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
        .overlay(alignment: .bottom) { bannerView }
        .confirmActionSheet(
            isPresented: $showStopConfirm,
            title: "Stop this job?",
            message: stopTarget.map { "\(displayName($0)) will be interrupted. Work it has already committed stays on its branch." },
            destructiveTitle: "Stop job",
            destructiveAction: {
                guard let job = stopTarget else { return }
                stopTarget = nil
                Task { await stop(job) }
            }
        )
        .onAppear { store.startAutoRefresh() }
        .onDisappear { store.stopAutoRefresh() }
        .onReceive(Timer.publish(every: 5, on: .main, in: .common).autoconnect()) { now = $0 }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if !store.loaded {
            ProgressView()
        } else if store.jobs.isEmpty {
            if let error = store.loadError {
                VStack(spacing: 12) {
                    Text("Couldn't load background jobs.")
                        .foregroundStyle(.secondary)
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Try again") { Task { await store.refresh() } }
                }
                .padding(.horizontal)
            } else {
                ContentUnavailableView(
                    "No background jobs",
                    systemImage: "square.stack.3d.up",
                    description: Text("Jobs this session starts in the background show up here.")
                )
            }
        } else {
            List {
                Section {
                    ForEach(store.jobs) { job in
                        row(job)
                    }
                } footer: {
                    if let error = store.loadError {
                        Text("Couldn't refresh — showing the last result. \(error)")
                    }
                }
            }
            .listStyle(.insetGrouped)
        }
    }

    // MARK: - Row

    @ViewBuilder
    private func row(_ job: DelegateJob) -> some View {
        let openable = isOpenable(job)
        Group {
            if openable {
                Button { open(job) } label: { rowBody(job, openable: true) }
                    .buttonStyle(.plain)
            } else {
                rowBody(job, openable: false)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if job.isStoppable {
                Button(role: .destructive) { requestStop(job) } label: {
                    Label("Stop", systemImage: "stop.circle")
                }
                .disabled(stopping.contains(job.id))
            }
        }
        .contextMenu {
            if job.isStoppable {
                Button(role: .destructive) { requestStop(job) } label: {
                    Label("Stop job", systemImage: "stop.circle")
                }
                .disabled(stopping.contains(job.id))
            }
        }
    }

    private func rowBody(_ job: DelegateJob, openable: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Circle()
                .fill(dotColor(job))
                .frame(width: 8, height: 8)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(displayName(job))
                        .font(.body)
                        .lineLimit(1)
                    if job.origin == "subagent" {
                        Text("subagent")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(tokens.fill, in: Capsule())
                    }
                }
                Text(detailLine(job))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if let activity = job.activity, !activity.isEmpty {
                    Text(activity)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if let note = unavailableNote(job, openable: openable) {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer(minLength: 8)
            if openable {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .padding(.top, 4)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint(openable ? "Opens the job's session." : "")
    }

    // MARK: - Pure-ish row helpers

    private func displayName(_ job: DelegateJob) -> String {
        let name = (job.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "Background job" : name
    }

    /// "running · ⎇ feat/x · 4m" — status, branch when present, then timing.
    private func detailLine(_ job: DelegateJob) -> String {
        var parts = [BackgroundJobFormat.statusLabel(job)]
        if let branch = job.branch, !branch.isEmpty { parts.append("⎇ \(branch)") }
        if let timing = BackgroundJobFormat.timing(job, now: now) { parts.append(timing) }
        return parts.joined(separator: " · ")
    }

    private func isOpenable(_ job: DelegateJob) -> Bool {
        guard let child = job.childSessionID, !child.isEmpty else { return false }
        return store.openableChildIDs.contains(child)
    }

    /// Why a row that cannot be tapped cannot be tapped. Silent until the
    /// window lookup has answered — claiming "window closed" before knowing
    /// would be a guess.
    private func unavailableNote(_ job: DelegateJob, openable: Bool) -> String? {
        guard !openable else { return nil }
        guard !(job.childSessionID ?? "").isEmpty else { return "no session yet" }
        return store.windowsKnown ? "window closed" : nil
    }

    private func dotColor(_ job: DelegateJob) -> Color {
        switch job.status {
        case "running": return tokens.accent
        case "paused": return tokens.warn
        case "done": return tokens.ok
        case "failed": return tokens.danger
        default: return tokens.tx4
        }
    }

    // MARK: - Actions

    private func open(_ job: DelegateJob) {
        guard let child = job.childSessionID, store.openableChildIDs.contains(child) else { return }
        dismiss()
        onOpenSession(child)
    }

    private func requestStop(_ job: DelegateJob) {
        stopTarget = job
        showStopConfirm = true
    }

    private func stop(_ job: DelegateJob) async {
        stopping.insert(job.id)
        defer { stopping.remove(job.id) }
        do {
            try await store.stop(job.id)
            show(Banner(text: "Stopped \(displayName(job))", isError: false))
        } catch {
            show(Banner(text: "Couldn't stop \(displayName(job)) — \(BackgroundJobFormat.failureReason(error))", isError: true))
        }
    }

    private func show(_ next: Banner) {
        withAnimation { banner = next }
    }

    // MARK: - Result banner

    @ViewBuilder
    private var bannerView: some View {
        if let banner {
            HStack(spacing: 8) {
                Image(systemName: banner.isError ? "exclamationmark.triangle" : "checkmark.circle")
                    .foregroundStyle(banner.isError ? tokens.warn : tokens.ok)
                Text(banner.text)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(2)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
            .padding(.horizontal, 12)
            .padding(.bottom, 12)
            .task(id: banner.id) {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                withAnimation { if self.banner?.id == banner.id { self.banner = nil } }
            }
        }
    }
}
