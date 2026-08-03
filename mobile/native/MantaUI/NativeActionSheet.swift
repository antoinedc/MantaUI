import SwiftUI
import UIKit

// ===========================================================================
// Native bottom action sheet (BET-628).
//
// The spec demands the real system action sheet for a destructive confirmation:
// "Native alerts and action sheets replace window.confirm. ... an action sheet
// is the consequence of something the user just chose. Clear-session is an
// action sheet. Destructive item at the top of an action sheet, Cancel
// detached at the bottom" (DECISIONS.md:709-715). And never a web dialog.
//
// SwiftUI's `confirmationDialog` cannot produce this on iOS 26: it presents as
// a centered popover card and DROPS the `.cancel`-role button — verified
// on-device (iPhone 17 Pro / iOS 26.5) at every attachment point (inside the
// sheet, at the presenter root, and on the pushed chat screen). The tolerance
// is not there to coerce. `UIAlertController(preferredStyle: .actionSheet)`
// renders the requirement exactly: destructive item first, Cancel detached at
// the bottom, and a genuinely native sheet (not a web dialog).
//
// The presenter is a backgrounded `UIViewControllerRepresentable` so the alert
// presents from the chat screen's own hosting hierarchy. A `UIAlertController`
// action sheet shows in its own alert window, so it appears above an already-
// presented overflow sheet; we keep the confirmation state on the presenter
// (the ChatScreen), not inside the sheet content.
// ===========================================================================

/// Presents a native action sheet with one destructive item first and a Cancel
/// detached at the bottom.
private struct NativeActionSheetPresenter: UIViewControllerRepresentable {
    @Binding var isPresented: Bool
    var title: String?
    var message: String?
    var destructiveTitle: String
    var destructiveAction: () -> Void
    var cancelTitle: String

    final class Coordinator {
        var hasPresented = false
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIViewController(context: Context) -> UIViewController {
        let presenter = UIViewController()
        presenter.view.backgroundColor = .clear
        return presenter
    }

    func updateUIViewController(_ presenter: UIViewController, context: Context) {
        if isPresented {
            // Present once per true edge; the destructive/Cancel actions reset
            // the binding, so re-tapping the row re-presents.
            guard !context.coordinator.hasPresented else { return }
            let alert = UIAlertController(title: title, message: message, preferredStyle: .actionSheet)
            let destructive = UIAlertAction(title: destructiveTitle, style: .destructive) { _ in
                isPresented = false
                destructiveAction()
            }
            let cancel = UIAlertAction(title: cancelTitle, style: .cancel) { _ in
                isPresented = false
            }
            alert.addAction(destructive)
            alert.addAction(cancel)
            if let popover = alert.popoverPresentationController {
                // iPad anchors the sheet; on iPhone it is ignored.
                popover.sourceView = presenter.view
                popover.sourceRect = CGRect(
                    x: presenter.view.bounds.midX,
                    y: presenter.view.bounds.midY,
                    width: 0, height: 0
                )
                popover.permittedArrowDirections = []
            }
            context.coordinator.hasPresented = true
            presenter.present(alert, animated: true, completion: nil)
        } else {
            context.coordinator.hasPresented = false
            if presenter.presentedViewController != nil {
                presenter.dismiss(animated: true, completion: nil)
            }
        }
    }
}

extension View {
    /// A native action sheet (destructive item first, Cancel detached at the
    /// bottom) built on `UIAlertController(.actionSheet)` — see
    /// `NativeActionSheetPresenter`.
    func nativeActionSheet(
        isPresented: Binding<Bool>,
        title: String? = nil,
        message: String? = nil,
        destructiveTitle: String,
        destructiveAction: @escaping () -> Void,
        cancelTitle: String = "Cancel"
    ) -> some View {
        background(
            NativeActionSheetPresenter(
                isPresented: isPresented,
                title: title,
                message: message,
                destructiveTitle: destructiveTitle,
                destructiveAction: destructiveAction,
                cancelTitle: cancelTitle
            )
        )
    }
}
