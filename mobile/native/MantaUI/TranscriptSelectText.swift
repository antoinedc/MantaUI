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
                    // Dismiss first, then quote, so a fork's navigation does not
                    // race the sheet's own dismissal.
                    dismiss()
                    Task {
                        try? await Task.sleep(nanoseconds: 350_000_000)
                        onQuote?(selection, destination)
                    }
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
        view.adjustsFontForContentSizeCategory = true
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

    private func attributed() -> NSAttributedString {
        let font = UIFont.systemFont(ofSize: MantaDynamicType.scaled(Metrics.type.body))
        let color = UIColor(tokens.tx1)
        let base: AttributedString
        if let parsed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            base = parsed
        } else {
            base = AttributedString(text)
        }
        let result = NSMutableAttributedString(attributedString: NSAttributedString(base))
        let whole = NSRange(location: 0, length: result.length)
        // The inline markdown parse can set bold/italic/code traits through
        // `inlinePresentationIntent`; the platform font and colour are the base.
        result.addAttribute(.foregroundColor, value: color, range: whole)
        result.enumerateAttribute(.font, in: whole) { value, range, _ in
            if value == nil { result.addAttribute(.font, value: font, range: range) }
        }
        return result
    }

    private func apply(to view: UITextView) {
        view.font = UIFont.systemFont(ofSize: MantaDynamicType.scaled(Metrics.type.body))
        view.textColor = UIColor(tokens.tx1)
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
