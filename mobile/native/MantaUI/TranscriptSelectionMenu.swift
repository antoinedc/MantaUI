import SwiftUI
import UIKit

// ===========================================================================
// Quote on the SYSTEM text-selection menu (BET-1364).
//
// Assistant prose renders through `MantaProse` → `MarkdownText` (the
// MarkdownView package), which drops a plain `UITextView` (owned by the
// transitive RichText package) into the cell. iOS lets an app add items to a
// text-selection menu ONLY through that text view's `UITextViewDelegate`, and
// MarkdownView exposes no hook — its coordinator wires nothing to the
// edit-menu callback.
//
// This file installs our OWN forwarding delegate on that `UITextView` at
// runtime: every message is forwarded to whatever delegate was already there
// (so the library keeps working) and exactly one method is implemented on top
// — `textView(_:editMenuForTextInRanges:suggestedActions:)` — to append the
// two quote actions.
//
// Scope (deliberate): assistant prose (`MantaProse`) ONLY. User bands, the
// live streaming tail and step-row tool output are plain SwiftUI `Text` with
// no UIKit text view to hook, and stay on the stock menu.
// ===========================================================================

/// The edit-menu forwarding delegate installed on the assistant prose text
/// view. `@MainActor`: `UITextViewDelegate` is main-actor isolated in the iOS
/// 26 SDK.
@MainActor
final class TranscriptEditMenuDelegate: NSObject, UITextViewDelegate {
    private weak var wrapped: (any UITextViewDelegate)?
    private let onQuote: (String, QuoteDestination) -> Void

    init(wrapping wrapped: (any UITextViewDelegate)?, onQuote: @escaping (String, QuoteDestination) -> Void) {
        self.wrapped = wrapped
        self.onQuote = onQuote
        super.init()
    }

    /// Obj-C message forwarding so the library's own delegate keeps receiving
    /// everything it did before this delegate was interposed.
    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || (wrapped?.responds(to: aSelector) ?? false)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        wrapped
    }

    /// The ONE method this delegate implements itself: adds `Quote` and
    /// `Quote in new session` to the selection menu, appended AFTER the system
    /// suggested actions.
    func textView(_ textView: UITextView,
                  editMenuForTextInRanges ranges: [NSValue],
                  suggestedActions: [UIMenuElement]) -> UIMenu? {
        let selection = ranges
            .compactMap { Range($0.rangeValue, in: textView.text) }
            .map { String(textView.text[$0]) }
            .joined(separator: " ")

        // Empty / whitespace-only selection → show the default system menu.
        guard QuoteText.buildQuoteBlock(selection) != nil else { return nil }

        let quoteAction = UIAction(title: "Quote") { [onQuote] _ in
            onQuote(selection, .thisSession)
        }
        let quoteNewSessionAction = UIAction(title: "Quote in new session") { [onQuote] _ in
            onQuote(selection, .newSession)
        }

        // The RAW selection, not a built block — `ChatScreen.quote(_:into:)`
        // already runs it through `QuoteText.buildQuoteBlock`.
        return UIMenu(children: suggestedActions + [quoteAction, quoteNewSessionAction])
    }
}

/// A zero-size, non-interactive probe placed as the `.background` of the prose
/// view. Its only job is to find the rendered `UITextView` and install the
/// forwarding delegate.
struct TranscriptEditMenuAttachment: UIViewRepresentable {
    let onQuote: (String, QuoteDestination) -> Void

    @MainActor
    final class Coordinator {
        /// Strong reference to the installed delegate (`UITextView.delegate` is
        /// `weak`, so without this the delegate deallocates immediately and the
        /// menu silently never appears).
        private var delegate: TranscriptEditMenuDelegate?
        private let onQuote: (String, QuoteDestination) -> Void

        init(onQuote: @escaping (String, QuoteDestination) -> Void) {
            self.onQuote = onQuote
        }

        func attach(in probe: ProbeView?) {
            guard let probe, let textView = Self.firstTextView(from: probe) else { return }
            // Idempotent: leave an already-installed delegate alone.
            guard !(textView.delegate is TranscriptEditMenuDelegate) else { return }
            let delegate = TranscriptEditMenuDelegate(wrapping: textView.delegate, onQuote: onQuote)
            textView.delegate = delegate
            self.delegate = delegate
        }

        /// Search: starting at the probe, walk up at most 8 superviews; at each
        /// node breadth-first search its subtree for the first `UITextView`;
        /// stop at the first one found. If none is found, do nothing silently.
        private static func firstTextView(from start: UIView) -> UITextView? {
            var node: UIView? = start
            var steps = 0
            while let current = node, steps <= 8 {
                if let textView = bfsFirstTextView(in: current) {
                    return textView
                }
                node = current.superview
                steps += 1
            }
            return nil
        }

        private static func bfsFirstTextView(in root: UIView) -> UITextView? {
            var queue: [UIView] = [root]
            var index = 0
            while index < queue.count {
                let node = queue[index]
                index += 1
                if let textView = node as? UITextView {
                    return textView
                }
                queue.append(contentsOf: node.subviews)
            }
            return nil
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onQuote: onQuote)
    }

    func makeUIView(context: Context) -> ProbeView {
        let probe = ProbeView()
        probe.onProbe = { [weak coordinator = context.coordinator, weak probe] in
            coordinator?.attach(in: probe)
        }
        return probe
    }

    func updateUIView(_ uiView: ProbeView, context: Context) {}

    /// The attachment must never affect row height.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ProbeView, context: Context) -> CGSize? {
        .zero
    }

    /// The zero-size, non-interactive probe view.
    final class ProbeView: UIView {
        var onProbe: (() -> Void)?

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            backgroundColor = .clear
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            onProbe?()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            onProbe?()
        }
    }
}
