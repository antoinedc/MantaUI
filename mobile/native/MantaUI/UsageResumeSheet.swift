import SwiftUI
import Combine
import os

// ===========================================================================
// WS09 F6 — "Resume after limit reset". Everything the sheet shows is the box's
// (`usage-stopped:view`): title, header, groups, rows, chips, cost labels, the cold
// note. The arm / disarm plan and the button's title / enabled state are the box's
// too (`usage-stopped:apply`, a dry run on every selection change). What stays
// here is view state: the checkbox selection, its reconciliation when the box's
// list changes under the open sheet, and the footer sum.
//
// The model is per presentation: responses that arrive after dismissal are dropped.
// ===========================================================================

@MainActor
final class UsageResumeModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case loaded
        case updateYourBox
        case failed(String)
    }

    @Published private(set) var view: UsageResumeViewWire?
    @Published private(set) var selected: Set<String> = []
    @Published private(set) var phase: Phase = .loading
    /// The newest dry-run plan for the CURRENT selection; nil disables the button.
    @Published private(set) var plan: UsageResumePlanWire?
    @Published private(set) var applying = false
    /// The box's last message (apply result, or why the plan could not be checked).
    @Published private(set) var message: String?

    private let api: MantaAPIClient
    private let usage: UsageAlertsStore
    private let refreshStopped: @MainActor () async -> Void
    private let planDebounce: Double
    private var pristine = true
    private var viewSeq = 0
    private var planSeq = 0
    private var planTask: Task<Void, Never>?
    private var cancellables: Set<AnyCancellable> = []
    private var closed = false
    private static let log = Logger(subsystem: "com.antoinedc.mantaui", category: "usage-resume")

    init(api: MantaAPIClient = .live(), usage: UsageAlertsStore = .shared, planDebounce: Double = 0.15,
         refreshStopped: @escaping @MainActor () async -> Void) {
        self.api = api
        self.usage = usage
        self.planDebounce = planDebounce
        self.refreshStopped = refreshStopped
    }

    // MARK: - Lifecycle

    /// Load, then keep the list fresh while presented: every `usage-stopped.updated`
    /// frame and every reconnect reloads (both arrive through the store's subjects).
    func start() {
        guard cancellables.isEmpty else { return }
        usage.stoppedUpdates
            .merge(with: usage.reconnects)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] in Task { await self?.load() } }
            .store(in: &cancellables)
        Task { await load() }
    }

    /// Dismissal by any route: stamp "last looked" (a failure is logged only —
    /// the user did nothing wrong), then refresh the session list's markers.
    func close() async {
        guard !closed else { return }
        closed = true
        planTask?.cancel()
        cancellables.removeAll()
        do {
            try await api.usageStoppedStampLastLooked()
        } catch {
            Self.log.error("usage-stopped:stamp-last-looked failed: \(ModelsCapability.reason(error), privacy: .public)")
        }
        await refreshStopped()
    }

    func load() async {
        viewSeq += 1
        let seq = viewSeq
        do {
            let fresh = try await api.usageStoppedView()
            guard !closed, seq == viewSeq else { return }
            let ids = Set(fresh.rows.map(\.conversation))
            let armed = Set(fresh.rows.filter(\.armed).map(\.conversation))
            selected = UsageResumeSelection.reconcile(selected: selected, pristine: pristine, viewIDs: ids, armedIDs: armed)
            view = fresh
            phase = .loaded
            invalidatePlan()
        } catch {
            guard !closed, seq == viewSeq else { return }
            if ModelsCapability.isUnsupported(error) {
                phase = .updateYourBox
            } else if view == nil {
                phase = .failed(ModelsCapability.reason(error))
            } else {
                message = "Couldn't refresh the list — \(ModelsCapability.reason(error))"
            }
        }
    }

    // MARK: - Selection

    func toggle(_ conversation: String) {
        pristine = false
        if selected.contains(conversation) { selected.remove(conversation) } else { selected.insert(conversation) }
        invalidatePlan()
    }

    func checkAll() {
        pristine = false
        selected = Set(view?.rows.map(\.conversation) ?? [])
        invalidatePlan()
    }

    func uncheckAll() {
        pristine = false
        selected = []
        invalidatePlan()
    }

    var selectedRows: [UsageResumeRowWire] {
        (view?.rows ?? []).filter { selected.contains($0.conversation) }
    }

    // MARK: - Plan (dry run) and apply

    /// The current plan no longer matches: disable the button and ask the box (debounced).
    private func invalidatePlan() {
        plan = nil
        planSeq += 1
        let seq = planSeq
        let wanted = selected.sorted()
        planTask?.cancel()
        planTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: .seconds(self.planDebounce))
            guard !Task.isCancelled, !self.closed else { return }
            do {
                let reply = try await self.api.usageStoppedApply(selected: wanted, dryRun: true)
                guard !self.closed, seq == self.planSeq else { return }
                self.plan = reply
            } catch {
                guard !self.closed, seq == self.planSeq else { return }
                self.message = "Couldn't check what this will change — \(ModelsCapability.reason(error))"
            }
        }
    }

    /// Returns true when the sheet should close (everything applied).
    func apply() async -> Bool {
        guard let plan, plan.canApply, !applying else { return false }
        applying = true
        message = nil
        defer { applying = false }
        do {
            let reply = try await api.usageStoppedApply(selected: selected.sorted(), dryRun: false)
            guard !closed else { return false }
            message = reply.message
            await refreshStopped()
            if !(reply.failed ?? []).isEmpty || !reply.ok {
                // Keep the sheet open with the box's message; show what is there now.
                await load()
                return false
            }
            // The sheet closes on success, so the box's sentence goes to the app banner.
            usage.showNotice(reply.message ?? "Updated.")
            return true
        } catch {
            message = "Couldn't update — \(ModelsCapability.reason(error)). Nothing was confirmed; check the list and try again."
            await load()
            return false
        }
    }
}

struct UsageResumeSheet: View {
    @ObservedObject var sessions: SessionListStore
    @ObservedObject var usage: UsageAlertsStore
    @StateObject private var model: UsageResumeModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    init(sessions: SessionListStore, usage: UsageAlertsStore) {
        self.sessions = sessions
        self.usage = usage
        _model = StateObject(wrappedValue: UsageResumeModel(usage: usage, refreshStopped: { await sessions.refreshStopped() }))
    }

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .loading:
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                case .updateYourBox:
                    ContentUnavailableView(ModelsCapability.updateYourBox, systemImage: "arrow.down.circle")
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Couldn't load", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Retry") { Task { await model.load() } }
                    }
                case .loaded:
                    if let view = model.view { content(view) }
                }
            }
            .navigationTitle(model.view?.title ?? "Resume after limit reset")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button((model.view?.rows.isEmpty ?? true) ? "Close" : "Cancel") { dismiss() }
                }
            }
        }
        .task { model.start() }
        .onDisappear { Task { await model.close() } }
    }

    // MARK: - Loaded

    @ViewBuilder
    private func content(_ view: UsageResumeViewWire) -> some View {
        if view.rows.isEmpty {
            ContentUnavailableView(view.emptyText, systemImage: "pause.circle")
        } else {
            List {
                Section {
                    Text(view.header).font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(view.groups) { group in
                    Section(group.workspace) {
                        ForEach(group.rows) { row in
                            Button { model.toggle(row.conversation) } label: { rowView(row) }
                                .buttonStyle(.plain)
                        }
                    }
                }
            }
            .safeAreaInset(edge: .bottom) { footer(view) }
        }
    }

    private func rowView(_ row: UsageResumeRowWire) -> some View {
        let isSelected = model.selected.contains(row.conversation)
        return HStack(alignment: .top, spacing: Metrics.spacing.sp2) {
            Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(isSelected ? tokens.accentTx : tokens.tx4)
                .font(.title3)
            VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                HStack(spacing: Metrics.spacing.sp1) {
                    Text(row.name).font(.body.weight(.semibold)).lineLimit(1)
                    if row.armed { chip("armed", tint: tokens.accentTx) }
                    if row.isNew { chip("new", tint: tokens.warn) }
                }
                if let snippet = row.snippet, !snippet.isEmpty {
                    Text(snippet).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                HStack(spacing: Metrics.spacing.sp1) {
                    if let provider = row.provider {
                        chip([UsageMeters.providerLabel(provider), row.model].compactMap { $0 }.joined(separator: " · "), tint: tokens.tx3)
                    }
                    chip(windowText(row.window), tint: tokens.tx3)
                    chip(row.cost.label, tint: row.cost.warm ? tokens.ok : tokens.tx3)
                }
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func windowText(_ window: UsageResumeRowWire.Window) -> String {
        guard let resetsAt = window.resetsAt else { return window.label }
        let date = Date(timeIntervalSince1970: resetsAt / 1000)
        let now = Date()
        let seconds = Int(date.timeIntervalSince(now))
        return "\(window.label) · \(UsageMeters.resetAt(date, now: now)) · in \(UsageMeters.resetDistance(seconds))"
    }

    private func chip(_ text: String, tint: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, Metrics.spacing.sp1)
            .padding(.vertical, 1)
            .background(tokens.fill, in: Capsule())
            .foregroundStyle(tint)
            .lineLimit(1)
    }

    private func footer(_ view: UsageResumeViewWire) -> some View {
        let rows = model.selectedRows
        let cold = UsageResumeFooter.coldCount(selectedRows: rows)
        return VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            if let note = UsageResumeFooter.coldNote(view.coldNote, count: cold) {
                Label(note, systemImage: "snowflake").font(.caption).foregroundStyle(tokens.warn)
            }
            if let message = model.message {
                Text(message).font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Button(model.selected.count == view.rows.count ? "Uncheck all" : "Check all") {
                    if model.selected.count == view.rows.count { model.uncheckAll() } else { model.checkAll() }
                }
                .font(.footnote)
                Spacer()
                Text("\(rows.count) of \(view.rows.count) selected").font(.footnote).foregroundStyle(.secondary)
            }
            Text(UsageResumeFooter.text(selectedRows: rows)).font(.footnote).foregroundStyle(.secondary)
            Button {
                Task { if await model.apply() { dismiss() } }
            } label: {
                HStack {
                    if model.applying { ProgressView() }
                    Text(model.plan?.title ?? "Resume at reset").frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.plan?.canApply != true || model.applying)
        }
        .padding(Metrics.spacing.sp3)
        .background(.regularMaterial)
    }
}

// MARK: - Session-list entry point (M-09-2)

/// `pause.circle` + N in warn tint; shown by the session list when WS04's
/// `unarmedStoppedCount > 0`. The action opens this sheet.
struct UsageStoppedCapsule: View {
    let count: Int
    let action: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let tokens = Tokens.scheme(colorScheme)
        Button(action: action) {
            Label("\(count)", systemImage: "pause.circle")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(tokens.warn)
        }
        .accessibilityLabel("\(count) \(count == 1 ? "conversation" : "conversations") stopped by a provider limit")
    }
}
