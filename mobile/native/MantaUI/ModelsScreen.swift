import SwiftUI

// ===========================================================================
// WS09 — Settings → Models. One list: the unidentified-model fix-up (F4), the
// saved default, every model (F1), unpriced models (F5) and the Insights
// entries (F2 spend ledger, F3 optimizer). Every string and state comes from the
// box's views; this file lays them out.
//
// Every control does something and says so: a write ends in a "Saved" line, a
// specific failure, or the "saved, but the subagent list wasn't updated" line
// with Try again (`ModelsFeedbackBar`).
// ===========================================================================

struct ModelsScreen: View {
    @StateObject private var store = ModelsStore()
    @StateObject private var unidentified = ModelsUnidentifiedStore()
    @StateObject private var prices = ModelsPriceStore()
    @ObservedObject private var alerts = UsageAlertsStore.shared
    @Environment(\.colorScheme) private var colorScheme

    @State private var query = ""
    @State private var detail: ModelsDetailTarget?

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        List {
            ModelsUnidentifiedSection(store: unidentified)
            modelsSections
            ModelsPriceSection(store: prices)
            insightsSection
        }
        .navigationTitle("Models")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search models")
        .refreshable {
            await store.refresh()
            await unidentified.refresh()
            await prices.refresh()
        }
        .task {
            store.start()
            unidentified.start()
            prices.start()
        }
        .onDisappear {
            store.stop()
            unidentified.stop()
        }
        .safeAreaInset(edge: .bottom) {
            ModelsFeedbackBar(feedback: store.feedback ?? unidentified.feedback, tokens: tokens,
                              retry: { Task { await store.retrySubSync() } },
                              dismiss: {
                                  store.dismissFeedback()
                                  unidentified.dismissFeedback()
                              })
        }
        .sheet(item: $detail) { target in
            ModelsDetailSheet(store: store, key: target.key)
        }
        .sheet(item: $unidentified.editor) { target in
            ModelsIdentifyForm(store: unidentified, target: target)
        }
    }

    // MARK: - Models

    @ViewBuilder
    private var modelsSections: some View {
        switch store.phase {
        case .loading:
            Section {
                HStack(spacing: Metrics.spacing.sp2) {
                    ProgressView()
                    Text("Loading models…").foregroundStyle(.secondary)
                }
            }
        case .unsupported:
            Section { Text(ModelsCapability.updateYourBox).foregroundStyle(.secondary) }
        case .failed(let message):
            Section {
                Text("Couldn't load your models — \(message)").foregroundStyle(.secondary)
                Button("Retry") { Task { await store.refresh() } }
            }
        case .loaded(let table):
            Section("Default") {
                defaultRow(table)
            }
            Section("Models") {
                let rows = filtered(table.rows)
                if rows.isEmpty {
                    if query.isEmpty {
                        Text("No models on this box yet.").foregroundStyle(.secondary)
                    } else {
                        ContentUnavailableView.search(text: query)
                    }
                } else {
                    ForEach(rows) { row in
                        Button { detail = ModelsDetailTarget(key: row.key) } label: {
                            ModelsRow(row: row, busy: store.busyKey == row.key, tokens: tokens)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func defaultRow(_ table: ModelsTableWire) -> some View {
        Group {
            if let line = table.defaultLine {
                HStack {
                    Text(line.name)
                    Spacer()
                    Text(UsageMeters.providerLabel(line.providerID))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("No default set — opencode default (server decides)")
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// Search is a client-side, case-insensitive substring over the box's `searchText`.
    private func filtered(_ rows: [ModelsTableRowWire]) -> [ModelsTableRowWire] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return rows }
        return rows.filter { $0.searchText.contains(q) }
    }

    // MARK: - Insights

    private var insightsSection: some View {
        Section {
            NavigationLink { ModelsLedgerScreen() } label: { Label("Where your spend goes", systemImage: "dollarsign.circle") }
            NavigationLink { OptimizerScreen() } label: { Label("Token optimizer", systemImage: "gauge.with.dots.needle.67percent") }
        } header: {
            Text("Insights")
        } footer: {
            if alerts.unsupported {
                Text("Update your box to get usage alerts.")
            }
        }
    }
}

struct ModelsDetailTarget: Identifiable, Equatable {
    let key: String
    var id: String { key }
}

// MARK: - Row

struct ModelsRow: View {
    let row: ModelsTableRowWire
    let busy: Bool
    let tokens: Tokens

    var body: some View {
        HStack(alignment: .top, spacing: Metrics.spacing.sp2) {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                HStack(spacing: Metrics.spacing.sp1) {
                    Text(row.name).foregroundStyle(.primary).lineLimit(1)
                    if row.isDefault {
                        Image(systemName: "checkmark").foregroundStyle(tokens.accentTx)
                            .accessibilityLabel("Default model")
                    }
                }
                HStack(spacing: Metrics.spacing.sp1) {
                    Text(UsageMeters.providerLabel(row.providerID)).font(.caption).foregroundStyle(.secondary)
                    if let ctx = row.contextLabel { chip(ctx) }
                    if let tier = row.tier { chip(tier) }
                    if row.deprecated { chip("deprecated", warn: true) }
                }
                if let description = row.description, !description.isEmpty {
                    Text(description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: 0)
            if busy {
                ProgressView()
            } else {
                HStack(spacing: Metrics.spacing.sp1) {
                    if row.isMain { Image(systemName: "square.grid.2x2").accessibilityLabel("In picker") }
                    if row.isSub { Image(systemName: "person.2").accessibilityLabel("Subagent") }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary)
        }
        .opacity(row.deprecatedLocked ? 0.55 : 1)
        .contentShape(Rectangle())
    }

    private func chip(_ text: String, warn: Bool = false) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, Metrics.spacing.sp1)
            .padding(.vertical, 1)
            .background((warn ? tokens.warn : tokens.fill).opacity(warn ? 0.18 : 1), in: Capsule())
            .foregroundStyle(warn ? tokens.warn : tokens.tx3)
    }
}

// MARK: - Feedback

/// The one status line under the list: saved (auto-clears), failed, or the partial
/// "saved, but …" with an optional Try again. Not rendered when there is nothing to say.
struct ModelsFeedbackBar: View {
    let feedback: ModelsStore.Feedback?
    let tokens: Tokens
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        if let feedback {
            HStack(alignment: .top, spacing: Metrics.spacing.sp2) {
                Image(systemName: icon(feedback)).foregroundStyle(color(feedback))
                Text(text(feedback)).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
                if case .partial(_, let canRetry) = feedback, canRetry {
                    Button("Try again", action: retry).font(.footnote.weight(.semibold))
                }
                if case .saved = feedback {} else {
                    Button { dismiss() } label: { Image(systemName: "xmark.circle.fill") }
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Dismiss")
                }
            }
            .padding(Metrics.spacing.sp3)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: Metrics.radius.lg))
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.bottom, Metrics.spacing.sp2)
            .accessibilityIdentifier("models-feedback")
        }
    }

    private func text(_ f: ModelsStore.Feedback) -> String {
        switch f {
        case .saved(let m), .failed(let m): return m
        case .partial(let m, _): return m
        }
    }

    private func icon(_ f: ModelsStore.Feedback) -> String {
        switch f {
        case .saved: return "checkmark.circle.fill"
        case .failed: return "exclamationmark.triangle.fill"
        case .partial: return "exclamationmark.circle.fill"
        }
    }

    private func color(_ f: ModelsStore.Feedback) -> Color {
        switch f {
        case .saved: return tokens.ok
        case .failed: return tokens.danger
        case .partial: return tokens.warn
        }
    }
}
