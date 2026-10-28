import SwiftUI

// ===========================================================================
// WS04 §10 — the quick session switcher (desktop ⌘K palette). Search every
// session by its name or its workspace's; an empty search lists the sessions
// opened most recently first. Opening one goes through the navigator, which
// replaces whatever screen is showing.
// ===========================================================================

struct SessionSwitcherSheet: View {
    @ObservedObject var sessionStore: SessionListStore
    let onOpen: (SessionSwitcherCandidate) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var query = ""

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    private var results: [SessionSwitcherCandidate] {
        SessionSwitcher.results(candidates: sessionStore.switcherCandidates, query: query, recents: sessionStore.recents)
    }

    var body: some View {
        NavigationStack {
            let rows = results
            List {
                if rows.isEmpty {
                    Text("No sessions match")
                        .foregroundColor(tokens.tx3)
                }
                ForEach(rows, id: \.key) { candidate in
                    Button {
                        dismiss()
                        onOpen(candidate)
                    } label: {
                        row(candidate)
                    }
                    .buttonStyle(.plain)
                }
            }
            .listStyle(.plain)
            .navigationTitle("Switch session")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(
                text: $query,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Search sessions"
            )
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func row(_ candidate: SessionSwitcherCandidate) -> some View {
        let window = sessionStore.window(project: candidate.project, index: candidate.windowIndex)
        let status = window.map { sessionStore.rowStatus(for: $0) }
        return HStack(spacing: Metrics.spacing.sp3) {
            Circle()
                .fill(dotColor(status))
                .frame(width: Metrics.spacing.sp2, height: Metrics.spacing.sp2)
            VStack(alignment: .leading, spacing: 2) {
                Text(candidate.name)
                    .foregroundColor(tokens.tx1)
                    .lineLimit(1)
                Text(subtitle(candidate, status))
                    .font(.footnote)
                    .foregroundColor(tokens.tx3)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }

    private func subtitle(_ candidate: SessionSwitcherCandidate, _ status: SessionRowStatus?) -> String {
        guard let status else { return candidate.project }
        return SessionRowSubtitle.text(for: status, projectName: candidate.project) ?? candidate.project
    }

    private func dotColor(_ status: SessionRowStatus?) -> Color {
        guard let status else { return tokens.tx4 }
        switch SessionDotState.forRow(status) {
        case .running: return tokens.accent
        case .needsYou: return tokens.warn
        case .halted: return tokens.warn
        case .idle: return tokens.tx4
        }
    }
}
