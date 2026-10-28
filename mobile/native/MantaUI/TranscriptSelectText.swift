import SwiftUI
import UIKit

// ===========================================================================
// WS01 F6 — "Select text…": a sheet with the turn's text in a selectable
// UITextView whose edit menu offers Quote / Quote in new session.
//
// Why a sheet: MarkdownText's UITextView delegate is owned by RichText, so the
// transcript's own prose cannot have the edit menu extended, and a whole-row
// context menu would take long-press away from native text selection
// (BET-1363). This sheet owns its own text view and delegate.
//
// `onQuote == nil` (a read-only surface) leaves the system menu untouched: no
// Quote items are offered where nothing could receive them.
// ===========================================================================

struct TranscriptSelectTextSheet: View {
    let text: String
    let tokens: Tokens
    /// nil on a surface that cannot quote.
    let onQuote: ((String, QuoteDestination) -> Void)?

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TranscriptSelectableTextView(
                text: text,
                tokens: tokens,
                quoteAvailable: onQuote != nil,
                onQuote: { selection, destination in
                    // The CALLER fires the quote from the sheet's onDismiss, once
                    // the sheet is really gone.
                    onQuote?(selection, destination)
                    dismiss()
                }
            )
            .background(tokens.canvas.ignoresSafeArea())
            .navigationTitle("Select text")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .accessibilityIdentifier("transcript-select-text-sheet")
    }
}

struct TranscriptSelectableTextView: UIViewRepresentable {
    let text: String
    let tokens: Tokens
    let quoteAvailable: Bool
    let onQuote: (String, QuoteDestination) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(quoteAvailable: quoteAvailable, onQuote: onQuote)
    }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = true
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(
            top: Metrics.spacing.sp3, left: Metrics.spacing.sp3,
            bottom: Metrics.spacing.sp3, right: Metrics.spacing.sp3
        )
        view.delegate = context.coordinator
        view.accessibilityIdentifier = "transcript-select-text-view"
        apply(to: view)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.quoteAvailable = quoteAvailable
        context.coordinator.onQuote = onQuote
        if view.attributedText.string != attributed().string {
            apply(to: view)
        }
    }

    private func baseFont() -> UIFont {
        UIFontMetrics.default.scaledFont(for: UIFont.systemFont(ofSize: Metrics.type.body))
    }

    /// The turn's text with its INLINE markdown applied. `UITextView` does not
    /// render `inlinePresentationIntent`, so bold / italic / code are mapped to
    /// fonts here while the runs are enumerated; the markers themselves are gone.
    /// Falls back to plain text when the markdown does not parse.
    private func attributed() -> NSAttributedString {
        let base = baseFont()
        let color = UIColor(tokens.tx1)
        guard let parsed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) else {
            return NSAttributedString(string: text, attributes: [.font: base, .foregroundColor: color])
        }
        let result = NSMutableAttributedString()
        for run in parsed.runs {
            let piece = String(parsed[run.range].characters)
            let intent = run.inlinePresentationIntent ?? []
            var font = base
            var traits: UIFontDescriptor.SymbolicTraits = []
            if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
            if intent.contains(.emphasized) { traits.insert(.traitItalic) }
            if intent.contains(.code) {
                font = UIFont.monospacedSystemFont(ofSize: base.pointSize, weight: .regular)
            }
            if !traits.isEmpty, let descriptor = font.fontDescriptor.withSymbolicTraits(traits) {
                font = UIFont(descriptor: descriptor, size: base.pointSize)
            }
            result.append(NSAttributedString(string: piece, attributes: [.font: font, .foregroundColor: color]))
        }
        return result
    }

    private func apply(to view: UITextView) {
        view.attributedText = attributed()
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var quoteAvailable: Bool
        var onQuote: (String, QuoteDestination) -> Void

        init(quoteAvailable: Bool, onQuote: @escaping (String, QuoteDestination) -> Void) {
            self.quoteAvailable = quoteAvailable
            self.onQuote = onQuote
        }

        func textView(
            _ textView: UITextView,
            editMenuForTextIn range: NSRange,
            suggestedActions: [UIMenuElement]
        ) -> UIMenu? {
            guard quoteAvailable,
                  let selection = TranscriptSelection.text(in: textView.text, range: range) else {
                // Nothing selected, or nothing could receive a quote: the
                // system's own menu.
                return nil
            }
            let quote = UIAction(title: "Quote", image: UIImage(systemName: "text.quote")) { [weak self] _ in
                self?.onQuote(selection, .thisSession)
            }
            let quoteInNewSession = UIAction(title: "Quote in new session", image: UIImage(systemName: "plus.bubble")) { [weak self] _ in
                self?.onQuote(selection, .newSession)
            }
            return UIMenu(children: [quote, quoteInNewSession] + suggestedActions)
        }
    }
}
