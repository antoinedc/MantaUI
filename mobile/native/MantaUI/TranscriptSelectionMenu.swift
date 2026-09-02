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
// (so the library keeps working) and the edit-menu methods are implemented on
// top to append the two quote actions.
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
    // swiftlint:disable:next implicitly_unwrapped_optional
    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || (wrapped?.responds(to: aSelector) ?? false)
    }

    // swiftlint:disable:next implicitly_unwrapped_optional
    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        wrapped
    }

    /// The multiple-ranges edit-menu variant (iOS 26). UIKit prefers this when
    /// the delegate implements it and only falls back to the single-range
    /// variant when it does not, so this is the primary path.
    func textView(_ textView: UITextView,
                  editMenuForTextInRanges ranges: [NSValue],
                  suggestedActions: [UIMenuElement]) -> UIMenu? {
        let selection = ranges
            .compactMap { Range($0.rangeValue, in: textView.text) }
            .map { String(textView.text[$0]) }
            .joined(separator: " ")
        return editMenu(for: selection, suggestedActions: suggestedActions)
    }

    /// The single-range edit-menu variant (16.0+). Implemented alongside the
    /// ranges variant so the two items appear regardless of which selector
    /// UIKit dispatches on a given OS/selection mode.
    func textView(_ textView: UITextView,
                  editMenuForTextIn range: NSRange,
                  suggestedActions: [UIMenuElement]) -> UIMenu? {
        guard let swiftRange = Range(range, in: textView.text) else { return nil }
        return editMenu(for: String(textView.text[swiftRange]), suggestedActions: suggestedActions)
    }

    private func editMenu(for selection: String, suggestedActions: [UIMenuElement]) -> UIMenu? {
        // Empty / whitespace-only selection → show the default system menu
        // (returning nil; an empty UIMenu would suppress the menu entirely).
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
        private weak var probe: ProbeView?
        private var firstAttempt: Date?
        private let maxTriesMilliseconds: TimeInterval = 5_000

        init(onQuote: @escaping (String, QuoteDestination) -> Void) {
            self.onQuote = onQuote
        }

        func attach(in probe: ProbeView?) {
            self.probe = probe
            let now = Date()
            if firstAttempt == nil { firstAttempt = now }
            tryAttach()
        }

        /// One install attempt. Idempotent (an already-installed delegate is
        /// left alone). If no text view is found yet — RichText lays its text
        /// view into the hierarchy asynchronously after the probe's own
        /// `didMoveToWindow`/`layoutSubviews` fire — schedules a bounded retry;
        /// the probe's subsequent layout passes also re-invoke `attach`.
        private func tryAttach() {
            guard let probe, let textView = Self.firstTextView(from: probe) else {
                scheduleRetryIfNeeded()
                return
            }
            // Idempotent: leave an already-installed delegate alone.
            guard !(textView.delegate is TranscriptEditMenuDelegate) else { return }
            let original = textView.delegate
            let delegate = TranscriptEditMenuDelegate(wrapping: original, onQuote: onQuote)
            textView.delegate = delegate
            self.delegate = delegate
            // Single line of runtime evidence: which text view we attached to,
            // so a sighted/on-device check can confirm it is the assistant-prose
            // text view (and that we wrapped RichText's own delegate).
            NSLog("[BET1364] attached edit-menu delegate to \(type(of: textView)) frame=\(textView.frame) wrapped=\(String(describing: type(of: original)))")
        }

        /// Bounded retry backstop for the async text-view appear: retry with a
        /// short backoff while the probe is still in a window and within a
        /// generous time budget, stopping as soon as the delegate is attached.
        /// Not a polling loop — finite (time-bounded), and each pass returns
        /// immediately once attached.
        private func scheduleRetryIfNeeded() {
            guard let probe, probe.window != nil else { return }
            guard let firstAttempt else { return }
            let elapsed = Date().timeIntervalSince(firstAttempt) * 1_000
            guard elapsed < maxTriesMilliseconds else { return }
            let delay = min(pow(1.3, CGFloat(retryStep())), 0.5)
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                self?.tryAttach()
            }
        }

        private var retryStepValue = 0
        private func retryStep() -> Int {
            retryStepValue += 1
            return retryStepValue
        }

        /// Search: starting at the probe, walk up at most 8 superviews; at each
        /// node breadth-first search its subtree for the first `UITextView`;
        /// stop at the first one found. If none is found, do nothing silently —
        /// the stock menu still works and a missing quote item is not worth a
        /// crash or log spam.
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
