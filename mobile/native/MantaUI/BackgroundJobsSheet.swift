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
    /// Per job: the clock skew taken when its current `view` was received (§5.3),
    /// so the detail sheet can tick elapsed / quiet / time-left locally.
    @Published private(set) var viewClocks: [String: JobViewClock] = [:]

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
            let merged = BackgroundJobViewMerge.merge(existing: jobs, fetched: fetched)
            let list = BackgroundJobFormat.sorted(merged.jobs)
            if list != jobs { jobs = list }
            rebaseClocks(applied: merged.applied, now: Date())
            loadError = nil
        } catch {
            // Keep the jobs already on screen: a failed refresh must not blank
            // a list that loaded fine a moment ago.
            loadError = BackgroundJobFormat.failureReason(error)
        }
        loaded = true
        await refreshWindows()
    }

    /// The clock for a job's current view, if it has one.
    func clock(for jobId: String) -> JobViewClock? { viewClocks[jobId] }

    /// Re-base the skew of every job whose view was just taken, and drop the
    /// clocks of jobs that no longer have a view.
    private func rebaseClocks(applied: Set<String>, now: Date) {
        var next = viewClocks.filter { id, _ in jobs.contains { $0.id == id && $0.view != nil } }
        for job in jobs where applied.contains(job.id) {
            if let view = job.view { next[job.id] = JobViewClock(asOf: view.asOf, localNow: now) }
        }
        if next != viewClocks { viewClocks = next }
    }

    /// Patch one job from a `delegate.updated` frame (the rev rule). Returns
    /// true when the list must be re-read as well: the job is unknown, its
    /// status changed (nesting may change), or the box sent no view.
    @discardableResult
    func apply(_ update: BackgroundJobUpdate, now: Date = Date()) -> Bool {
        let patched = BackgroundJobViewMerge.patch(jobs, with: update)
        if patched.jobs != jobs { jobs = patched.jobs }
        if let id = patched.appliedID { rebaseClocks(applied: [id], now: now) }
        return patched.needsRefetch
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
        updatesSubscription = eventStore?.delegateJobUpdates
            .receive(on: DispatchQueue.main)
            .sink { [weak self] update in
                Task { @MainActor in
                    guard let self else { return }
                    if self.apply(update) { await self.refresh() }
                }
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
    @State private var detailTarget: DetailTarget?

    private struct DetailTarget: Identifiable {
        let id: String
    }

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
        .sheet(item: $detailTarget) { target in
            BackgroundJobDetailView(store: store, jobID: target.id)
        }
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
        HStack(alignment: .top, spacing: 4) {
            if openable {
                Button { open(job) } label: { rowBody(job, openable: true) }
                    .buttonStyle(.plain)
            } else {
                rowBody(job, openable: false)
            }
            if job.view != nil {
                Button { detailTarget = DetailTarget(id: job.id) } label: {
                    Image(systemName: "info.circle")
                        .font(.body)
                        .foregroundStyle(tokens.tx3)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Job details")
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
                    if let steps = job.view?.steps {
                        Spacer(minLength: 4)
                        Text(verbatim: BackgroundJobProgressFormat.chip(steps))
                            .font(.caption2.weight(.medium).monospacedDigit())
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(tokens.fill, in: Capsule())
                            .accessibilityLabel("Step \(steps.done) of \(steps.total)")
                    }
                }
                Text(detailLine(job))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if let line = job.view.flatMap(BackgroundJobProgressFormat.headlineLine) {
                    Text(verbatim: line.text)
                        .font(.caption)
                        .foregroundStyle(line.needsDecision ? tokens.warn : Color.secondary)
                        .lineLimit(1)
                } else if let activity = job.activity, !activity.isEmpty {
                    Text(verbatim: activity)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if let view = job.view, let fraction = BackgroundJobProgressFormat.barFraction(view) {
                    JobProgressBar(fraction: fraction, tint: tokens.accent, track: tokens.fill)
                        .padding(.top, 2)
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

    /// "running · ⎇ feat/x · 4m" — the box's status word, branch when present, then
    /// timing; a finished job adds the box's summary ("2 files changed"). Both
    /// words are the box's (`delegate:list` `statusLabel` / `summary`); an older
    /// box sends neither, so the raw status shows as it is.
    private func detailLine(_ job: DelegateJob) -> String {
        var parts = [job.statusLabel ?? job.status]
        if let branch = job.branch, !branch.isEmpty { parts.append("⎇ \(branch)") }
        if let timing = BackgroundJobFormat.timing(job, now: now) { parts.append(timing) }
        if !job.isActive, let summary = job.summary, !summary.isEmpty { parts.append(summary) }
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

// MARK: - Progress bar

/// A thin determinate bar. Drawn by hand: `ProgressView(value:)` has no slim style.
struct JobProgressBar: View {
    let fraction: Double
    let tint: Color
    let track: Color

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(track)
                Capsule()
                    .fill(tint)
                    .frame(width: geometry.size.width * min(1, max(0, fraction)))
            }
        }
        .frame(height: 3)
        .accessibilityHidden(true)
    }
}

// MARK: - Detail sheet

/// Everything the box knows about one job's progress (spec B6, the same content
/// as the desktop's Details disclosure): the checklist, milestones newest first,
/// the tool running now, quiet time, files, usage, time left. It reads the job
/// from the store, so a patched view shows at once; elapsed / quiet / time left
/// tick locally once a second from the clock skew taken when the view arrived.
/// All model text is shown verbatim — no Markdown, no links.
struct BackgroundJobDetailView: View {
    @ObservedObject var store: BackgroundJobsStore
    let jobID: String

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                content(now: context.date)
            }
            .navigationTitle("Job details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private func content(now: Date) -> some View {
        if let job = store.jobs.first(where: { $0.id == jobID }), let view = job.view {
            let clock = store.clock(for: jobID) ?? JobViewClock(skewMs: 0)
            let detail = BackgroundJobProgressDetail(view: view, clock: clock, now: now)
            List {
                summarySection(job: job, view: view)
                if let steps = view.steps { stepsSection(steps: steps, detail: detail) }
                nowSection(detail: detail)
                if !detail.milestones.isEmpty { milestonesSection(detail.milestones) }
                statsSection(view: view, detail: detail)
            }
            .listStyle(.insetGrouped)
        } else {
            ContentUnavailableView("No details", systemImage: "info.circle", description: Text("This job is no longer listed."))
        }
    }

    private func summarySection(job: DelegateJob, view: DelegateJobProgressView) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(verbatim: displayName(job))
                    .font(.headline)
                Text(verbatim: BackgroundJobProgressFormat.stateLabel(view.state))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(view.needsDecision ? tokens.warn : Color.secondary)
                if !view.headline.isEmpty {
                    Text(verbatim: view.headline)
                        .font(.subheadline)
                }
                if let fraction = BackgroundJobProgressFormat.barFraction(view) {
                    JobProgressBar(fraction: fraction, tint: tokens.accent, track: tokens.fill)
                        .padding(.top, 2)
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func stepsSection(steps: DelegateJobProgressView.Steps, detail: BackgroundJobProgressDetail) -> some View {
        Section {
            if steps.items.isEmpty {
                Text(verbatim: steps.current ?? "Step \(min(steps.done + 1, steps.total)) of \(steps.total)")
                    .font(.subheadline)
            } else {
                ForEach(Array(steps.items.enumerated()), id: \.offset) { entry in
                    let item = entry.element
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: icon(item.status))
                            .foregroundStyle(color(item.status))
                            .frame(width: 20)
                        Text(verbatim: item.text)
                            .font(.subheadline)
                            .foregroundStyle(item.status == .pending ? Color.secondary : Color.primary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            if detail.planGrew {
                Label("Plan grew", systemImage: "plus.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text(verbatim: "Steps \(BackgroundJobProgressFormat.chip(steps))")
        }
    }

    @ViewBuilder
    private func nowSection(detail: BackgroundJobProgressDetail) -> some View {
        if detail.tool != nil || detail.quiet != nil {
            Section("Now") {
                if let tool = detail.tool {
                    Text(verbatim: tool)
                        .font(.subheadline.monospaced())
                        .lineLimit(2)
                }
                if let quiet = detail.quiet {
                    Text(verbatim: quiet)
                        .font(.subheadline)
                        .foregroundStyle(tokens.warn)
                }
            }
        }
    }

    private func milestonesSection(_ lines: [BackgroundJobProgressDetail.MilestoneLine]) -> some View {
        Section("Milestones") {
            ForEach(Array(lines.enumerated()), id: \.offset) { entry in
                let line = entry.element
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: line.text)
                        .font(.subheadline)
                    Text(verbatim: line.ago)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    @ViewBuilder
    private func statsSection(view: DelegateJobProgressView, detail: BackgroundJobProgressDetail) -> some View {
        let rows: [(label: String, value: String)] = {
            var out: [(label: String, value: String)] = []
            if let elapsed = detail.elapsed { out.append(("Elapsed", elapsed)) }
            if let left = detail.timeLeft { out.append(("Time left", left)) }
            if let files = detail.files { out.append(("Files", files)) }
            if let usage = detail.usage { out.append(("Usage", usage)) }
            if let model = view.model { out.append(("Model", model)) }
            return out
        }()
        if !rows.isEmpty {
            Section("Stats") {
                ForEach(rows, id: \.label) { row in
                    LabeledContent(row.label) { Text(verbatim: row.value) }
                        .font(.subheadline)
                }
            }
        }
    }

    private func displayName(_ job: DelegateJob) -> String {
        let name = (job.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "Background job" : name
    }

    private func icon(_ status: DelegateJobProgressView.StepItem.Status) -> String {
        switch status {
        case .done: return "checkmark.circle.fill"
        case .current: return "arrow.right.circle.fill"
        case .pending: return "circle"
        }
    }

    private func color(_ status: DelegateJobProgressView.StepItem.Status) -> Color {
        switch status {
        case .done: return tokens.ok
        case .current: return tokens.accent
        case .pending: return tokens.tx3
        }
    }
}
