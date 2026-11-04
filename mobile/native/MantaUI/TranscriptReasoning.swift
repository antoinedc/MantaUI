import SwiftUI

// ===========================================================================
// WS01 F2 — a reasoning ("Thinking…") row, shown only while the app-wide
// "Show reasoning & full output" switch is on (desktop Ctrl+O).
// ===========================================================================

/// One reasoning part. The id is the part id (`<msg>:reasoning:<n>`), which a
/// refetch reproduces, so the row keeps its identity.
struct TranscriptReasoning: Equatable, Sendable {
    let id: String
    let text: String
}

struct TranscriptReasoningView: View {
    let reasoning: TranscriptReasoning
    let tokens: Tokens

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            Image(systemName: "sparkle")
                .font(.system(size: Metrics.type.xs))
                .foregroundColor(tokens.accent.opacity(0.6))
                .frame(width: 16, alignment: .leading)
                .padding(.top, 2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                Text("Thinking…")
                    .font(.manta(size: Metrics.type.twoXS))
                    .foregroundColor(tokens.tx4)
                Text(TranscriptLinkify.attributed(reasoning.text, linkColor: tokens.accent))
                    .textSelection(.enabled)
                    .font(.manta(size: Metrics.type.small).italic())
                    .foregroundColor(tokens.tx3)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("transcript-reasoning")
    }
}
