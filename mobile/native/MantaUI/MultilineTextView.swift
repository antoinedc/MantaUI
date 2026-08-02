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
    @ObservedObject var controller: ComposerTextController
    var placeholder: String
    var font: UIFont
    var textColor: UIColor
    var placeholderColor: UIColor
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
        view.textColor = textColor
        view.delegate = context.coordinator
        view.accessibilityIdentifier = "composer-input"
        controller.textView = view
        updatePlaceholder(view)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text {
            view.text = text
            updatePlaceholder(view)
        }
        if view.font != font { view.font = font }
        if view.textColor != textColor { view.textColor = textColor }
        // Enforce the bounded max height so the input scrolls instead of
        // pushing the whole composer off-screen on a long draft.
        view.isScrollEnabled = neededScrolling(containerHeight: view.bounds.height)
        updatePlaceholder(view)
    }

    private func neededScrolling(containerHeight: CGFloat) -> Bool {
        guard let view = controller.textView else { return false }
        let size = view.sizeThatFits(CGSize(width: view.bounds.width, height: .greatestFiniteMagnitude))
        return size.height > maxHeight
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
        }
    }
}
