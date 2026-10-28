import SwiftUI
import UIKit

// ===========================================================================
// WS01 F5 — the shared Copy button (tool output in the Activity sheet).
//
// `doc.on.doc` → `checkmark` for 1.5 s. Writing to the pasteboard cannot fail,
// so there is no error state; the confirmation is the checkmark, a success
// haptic and a VoiceOver announcement ("Copied"). Code blocks in assistant
// prose already carry the markdown library's own Copy button.
// ===========================================================================

struct TranscriptCopyButton: View {
    let text: String
    let tokens: Tokens

    @State private var copied = false
    @State private var feedbackTick = 0
    @State private var resetToken = 0

    var body: some View {
        Button(action: copy) {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.system(size: Metrics.type.small, weight: .medium))
                .foregroundColor(copied ? tokens.ok : tokens.tx3)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.success, trigger: feedbackTick)
        .accessibilityLabel(copied ? "Copied" : "Copy")
        .accessibilityIdentifier("transcript-copy-button")
    }

    private func copy() {
        UIPasteboard.general.string = text
        copied = true
        feedbackTick += 1
        UIAccessibility.post(notification: .announcement, argument: "Copied")
        resetToken += 1
        let token = resetToken
        Task {
            // Only the latest tap resets the glyph.
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if token == resetToken { copied = false }
        }
    }
}
