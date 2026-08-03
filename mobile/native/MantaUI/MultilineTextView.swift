import SwiftUI
import UIKit

// ===========================================================================
// S5 — composer text input (BET-597).
//
// A UITextView-backed multiline input that owns the caret, so voice dictation
// can insert AT the caret (the issue's dictate behaviour) rather than only
// appending to the end. The controller is the bridge: the representable hands
// it the live UITextView, and the composer calls `insertAtCaret` / `focus`.
// Thin — no transcript/logic here.
// ===========================================================================

@MainActor
final class ComposerTextController: ObservableObject {
    weak var textView: UITextView?

    func insertAtCaret(_ string: String) {
        guard let textView else { return }
        let selected = textView.selectedRange
        let location = selected.location
        guard let current = textView.text else { return }
        let newText = (current as NSString).replacingCharacters(in: selected, with: string)
        textView.text = newText
        let cursor = NSRange(location: location + (string as NSString).length, length: 0)
        textView.selectedRange = cursor
        textView.delegate?.textViewDidChange?(textView)
    }

    func focus() {
        textView?.becomeFirstResponder()
    }
}

struct MultilineTextView: UIViewRepresentable {
    @Binding var text: String
    /// Measured height of the text, clamped to [minHeight, maxHeight]. A
    /// scroll-enabled UITextView reports NO intrinsic content size, so without
    /// this the representable is a greedy view: SwiftUI hands it every point of
    /// free space and the composer grows to the full screen — the field pinned
    /// to the top with its own send/mic buttons stranded at the bottom. The
    /// height is measured here and applied by the composer as a real frame.
    @Binding var height: CGFloat
    @ObservedObject var controller: ComposerTextController
    var placeholder: String
    var font: UIFont
    var textColor: UIColor
    var placeholderColor: UIColor
    var minHeight: CGFloat
    var maxHeight: CGFloat

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WrappingTextView {
        let view = WrappingTextView()
        view.isScrollEnabled = true
        view.alwaysBounceVertical = false
        view.backgroundColor = .clear
        view.font = font
        view.textContainerInset = UIEdgeInsets(top: 8, left: 0, bottom: 8, right: 0)
        view.textContainer.lineFragmentPadding = 0
        view.textContainer.lineBreakMode = .byWordWrapping
        // widthTracksTextView auto-updates the container width from Auto Layout,
        // but our frame is set imperatively (not via Auto Layout), so the
        // container never sees the real width and text scrolls sideways instead
        // of wrapping. WrappingTextView.layoutSubviews() sets the container size
        // manually from the actual bounds every layout pass instead.
        view.textContainer.widthTracksTextView = false
        view.textColor = textColor
        view.delegate = context.coordinator
        view.accessibilityIdentifier = "composer-input"
        controller.textView = view
        view.setContentHuggingPriority(.required, for: .vertical)
        updatePlaceholder(view)
        DispatchQueue.main.async { self.recalculateHeight(view) }
        return view
    }

    func updateUIView(_ view: WrappingTextView, context: Context) {

    func updateUIView(_ view: WrappingTextView, context: Context) {
        // Only touch the text view when SwiftUI's value actually differs. It
        // used to reassign the placeholder twice and re-measure on EVERY
        // update, including the update its own height change triggered, so each
        // keystroke did several full text layouts.
        if view.text != text {
            view.text = text
        }
        if view.font != font { view.font = font }
        if view.textColor != textColor { view.textColor = textColor }
        updatePlaceholder(view)
        recalculateHeight(view)
    }

    /// Measure, clamp, and publish. Above `maxHeight` the text view scrolls
    /// instead of growing, so a long draft can never push the composer off
    /// screen.
    private func recalculateHeight(_ view: WrappingTextView) {
        let width = view.bounds.width
        guard width > 0 else { return }
        let fitted = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let clamped = min(max(fitted, minHeight), maxHeight)
        view.isScrollEnabled = fitted > maxHeight
        if abs(clamped - height) > 0.5 {
            DispatchQueue.main.async { height = clamped }
        }
    }

    private func updatePlaceholder(_ view: WrappingTextView) {
        let label: UILabel
        if let existing = view.viewWithTag(919_001) as? UILabel {
            label = existing
        } else {
            label = UILabel()
            label.tag = 919_001
            label.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(label)
            NSLayoutConstraint.activate([
                label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 2),
                label.topAnchor.constraint(equalTo: view.topAnchor, constant: 8),
                label.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -2),
            ])
        }
        label.text = placeholder
        label.font = font
        label.textColor = placeholderColor
        label.isHidden = !text.isEmpty
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: MultilineTextView
        init(_ parent: MultilineTextView) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            parent.recalculateHeight(textView as! WrappingTextView)
        }
    }
}

/// A UITextView subclass that sets its text container width to its own bounds
/// width in every `layoutSubviews` pass.
///
/// Why this exists: UITextView's text container width has to match the view's
/// actual rendered width for word wrapping to work. `widthTracksTextView = true`
/// is supposed to do this automatically via Auto Layout, but our view is sized
/// imperatively with SwiftUI's `.frame(height:)` — not through Auto Layout
/// constraints — so Auto Layout never resolves the bounds and the container
/// keeps its initial size (effectively infinite). The result: text lays out
/// as one long single line and the view scrolls sideways instead of wrapping.
///
/// Setting the container size here, in `layoutSubviews`, fires AFTER the
/// system has committed the real bounds, so the width is always correct.
final class WrappingTextView: UITextView {
    override func layoutSubviews() {
        super.layoutSubviews()
        let w = bounds.width
        if w > 0 && textContainer.size.width != w {
            textContainer.size = CGSize(width: w, height: .greatestFiniteMagnitude)
            setNeedsLayout()
        }
    }
}
