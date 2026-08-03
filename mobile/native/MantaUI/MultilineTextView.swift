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

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isScrollEnabled = true
        view.alwaysBounceVertical = false
        view.backgroundColor = .clear
        view.font = font
        view.textContainerInset = UIEdgeInsets(top: 8, left: 0, bottom: 8, right: 0)
        view.textContainer.lineFragmentPadding = 0
        // Wrap to the view's width rather than laying out one endless line.
        view.textContainer.widthTracksTextView = true
        view.textContainer.lineBreakMode = .byWordWrapping
        view.textColor = textColor
        view.delegate = context.coordinator
        view.accessibilityIdentifier = "composer-input"
        controller.textView = view
        view.setContentHuggingPriority(.required, for: .vertical)
        updatePlaceholder(view)
        DispatchQueue.main.async { recalculateHeight(view) }
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
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
    private func recalculateHeight(_ view: UITextView) {
        let width = view.bounds.width
        guard width > 0 else { return }
        let fitted = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let clamped = min(max(fitted, minHeight), maxHeight)
        view.isScrollEnabled = fitted > maxHeight
        if abs(clamped - height) > 0.5 {
            DispatchQueue.main.async { height = clamped }
        }
    }

    private func updatePlaceholder(_ view: UITextView) {
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
            parent.recalculateHeight(textView)
        }
    }
}
