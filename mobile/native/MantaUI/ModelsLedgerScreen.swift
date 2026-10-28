import SwiftUI

// ===========================================================================
// WS09 F2 — "Where your spend goes". Renders `ledger:summary.view` verbatim (the
// box computes the split, the caption, the top models and the agents); only the
// money / integer formatting is the phone's (`ModelsFormat`).
// ===========================================================================

@MainActor
final class ModelsLedgerStore: ObservableObject {
    enum Phase: Equatable {
        case loading
        case loaded(LedgerViewWire)
        /// `{supported:false}` — the box has no spend runtime.
        case needsNewerRuntime
        /// An older box: the summary has no `view`.
        case updateYourBox
        case failed(String)
    }

    @Published private(set) var phase: Phase = .loading
    private let api: MantaAPIClient

    init(api: MantaAPIClient = .live()) {
        self.api = api
    }

    func refresh() async {
        do {
            let summary = try await api.ledgerSummary()
            if !summary.supported {
                phase = .needsNewerRuntime
            } else if let view = summary.view {
                phase = .loaded(view)
            } else {
                phase = .updateYourBox
            }
        } catch {
            if ModelsCapability.isUnsupported(error) {
                phase = .updateYourBox
            } else {
                phase = .failed(ModelsCapability.reason(error))
            }
        }
    }
}

struct ModelsLedgerScreen: View {
    @StateObject private var store = ModelsLedgerStore()
    @Environment(\.colorScheme) private var colorScheme

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        List {
            switch store.phase {
            case .loading:
                Section { ProgressView("Reading your history…") }
            case .needsNewerRuntime:
                Section { Text("Spend history needs a newer box runtime.").foregroundStyle(.secondary) }
            case .updateYourBox:
                Section { Text(ModelsCapability.updateYourBox).foregroundStyle(.secondary) }
            case .failed(let message):
                Section {
                    Text("Couldn't load spend history — \(message)").foregroundStyle(.secondary)
                    Button("Retry") { Task { await store.refresh() } }
                }
            case .loaded(let view):
                billSplit(view)
                byModel(view)
                byAgent(view)
            }
        }
        .navigationTitle("Where your spend goes")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.refresh() }
        .task { await store.refresh() }
    }

    // MARK: - Sections

    private func billSplit(_ view: LedgerViewWire) -> some View {
        Section {
            GeometryReader { geo in
                // The box rounds each share, so they can sum to 101: scale by the
                // larger of 100 and the sum so the bar never outgrows its track.
                let total = CGFloat(max(100, view.segments.reduce(0) { $0 + $1.pct }))
                HStack(spacing: 0) {
                    ForEach(view.segments, id: \.kind) { segment in
                        Rectangle()
                            .fill(color(segment.kind))
                            .frame(width: geo.size.width * CGFloat(segment.pct) / total)
                            .overlay {
                                if segment.inline {
                                    Text("\(segment.pct)%")
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(.white)
                                        .lineLimit(1)
                                }
                            }
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: Metrics.radius.md))
            }
            .frame(height: 24)
            ForEach(view.segments, id: \.kind) { segment in
                HStack(spacing: Metrics.spacing.sp2) {
                    Circle().fill(color(segment.kind)).frame(width: 10, height: 10)
                    Text(segment.label)
                    Spacer()
                    Text("\(segment.pct)%").foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text("Bill split")
        } footer: {
            Text(view.caption)
        }
    }

    private func byModel(_ view: LedgerViewWire) -> some View {
        Section("By model") {
            if view.topModels.isEmpty {
                Text(view.emptyModels).foregroundStyle(.secondary)
            }
            ForEach(view.topModels, id: \.key) { model in
                VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                    HStack {
                        Text(model.key).font(.caption.monospaced()).lineLimit(1)
                        Spacer()
                        Text(ModelsFormat.money(model.cost)).font(.body.weight(.semibold))
                    }
                    Text("\(ModelsFormat.count(model.turns)) turns · \(ModelsFormat.money(model.costPerTurn))/turn · \(tokensPerSecond(model.tokensPerSec))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func byAgent(_ view: LedgerViewWire) -> some View {
        Section("By agent") {
            if view.agents.isEmpty {
                Text(view.emptyAgents).foregroundStyle(.secondary)
            }
            ForEach(Array(view.agents.enumerated()), id: \.offset) { _, agent in
                VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                    HStack {
                        Text(agent.label)
                        if agent.isChild {
                            Text("subagent")
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, Metrics.spacing.sp1)
                                .background(tokens.fill, in: Capsule())
                                .foregroundStyle(tokens.tx3)
                        }
                        Spacer()
                        Text(ModelsFormat.money(agent.cost)).font(.body.weight(.semibold))
                    }
                    Text("\(ModelsFormat.count(agent.turns)) turns · \(ModelsFormat.money(agent.costPerTurn))/turn")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func tokensPerSecond(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return "\(Int(value.rounded())) tok/s"
    }

    private func color(_ kind: String) -> Color {
        switch kind {
        case "cacheRead": return tokens.danger
        case "cacheWrite": return tokens.warn
        case "output": return tokens.accentSolid
        default: return tokens.tx4
        }
    }
}
