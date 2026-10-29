import SwiftUI

// ===========================================================================
// WS01 F3 — a user turn that came from a `/command` or skill, drawn as ONE
// collapsed band (`› /name args`) instead of the expanded template.
//
// The desktop expands the prompt inline. iOS opens a sheet instead: inline
// expansion state would live in a recycled TiledView cell and change the row's
// height, and a fixed row height is part of the transcript's crash-avoidance
// contract (mobile/native/AGENTS.md §6).
// ===========================================================================

struct TranscriptCommandRow: View {
    let turn: TranscriptCommandTurn
    let tokens: Tokens

    @State private var showSheet = false

    var body: some View {
        Button { showSheet = true } label: {
            HStack(spacing: Metrics.spacing.sp2) {
                Text("›")
                    .font(.manta(size: Metrics.type.body, weight: mantaFontWeight(Metrics.type.medium)))
                    .foregroundColor(tokens.tx3)
                Text("/\(turn.name)")
                    .font(.manta(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium), design: .monospaced))
                    .foregroundColor(tokens.accent)
                    .lineLimit(1)
                    .fixedSize()
                if !turn.arguments.isEmpty {
                    Text(turn.arguments)
                        .font(.manta(size: Metrics.type.small, design: .monospaced))
                        .foregroundColor(tokens.tx3)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: Metrics.type.xs))
                    .foregroundColor(tokens.tx4)
            }
            .padding(Metrics.spacing.sp3)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(tokens.fill, in: bandShape)
            .overlay(alignment: .leading) {
                tokens.accent
                    .frame(width: Metrics.spacing.spPx * 2)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(turn.arguments.isEmpty ? "/\(turn.name)" : "/\(turn.name) \(turn.arguments)")
        .accessibilityHint("Shows the full prompt")
        .accessibilityIdentifier("transcript-command-band")
        .sheet(isPresented: $showSheet) {
            TranscriptCommandSheet(turn: turn, tokens: tokens)
        }
    }

    /// The same shape as `UserBand`: square on the leading side, rounded on the
    /// trailing side.
    private var bandShape: some Shape {
        UnevenRoundedRectangle(
            topLeadingRadius: 0,
            bottomLeadingRadius: 0,
            bottomTrailingRadius: Metrics.radius.md,
            topTrailingRadius: Metrics.radius.md
        )
    }
}

/// The full expanded prompt behind a command band. Selectable, so a user can
/// copy any part of it.
struct TranscriptCommandSheet: View {
    let turn: TranscriptCommandTurn
    let tokens: Tokens

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(TranscriptLinkify.attributed(turn.expandedText, linkColor: tokens.accent))
                    .textSelection(.enabled)
                    .font(.manta(size: Metrics.type.small, design: .monospaced))
                    .foregroundColor(tokens.tx2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Metrics.spacing.sp3)
            }
            .background(tokens.canvas.ignoresSafeArea())
            .navigationTitle("/\(turn.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .accessibilityIdentifier("transcript-command-sheet")
    }
}
