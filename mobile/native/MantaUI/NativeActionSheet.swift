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
// on-device (iPhone 17 Pro / iOS 26.5) at every attachment point. The tolerance
// is not there to coerce. `UIAlertController(preferredStyle: .actionSheet)`
// renders the requirement exactly: destructive item first, Cancel detached at
// the bottom, and a genuinely native sheet (not a web dialog).
//
// Presentation: the representable's own view controller (sitting in a
// `.background`) is NOT a valid presenting context on this toolchain — the alert
// never surfaces from it. So the sheet is presented from the app's key-window
// TOPMOST view controller (walk `presentedViewController` to the top), which is:
// (a) reliably in the windowing hierarchy, and (b) above any already-presented
// overflow sheet, so the action sheet appears over it.
// ===========================================================================

/// Presents a native action sheet with one destructive item first and a Cancel
/// detached at the bottom.
struct NativeActionSheetPresenter: UIViewControllerRepresentable {
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
            if let popover = alert.popoverPresentationController,
               let top = NativeActionSheet.topmostViewController(),
               let anchor = top.view {
                // iPad anchors the sheet; on iPhone it is ignored.
                popover.sourceView = anchor
                popover.sourceRect = CGRect(
                    x: anchor.bounds.midX,
                    y: anchor.bounds.midY,
                    width: 0, height: 0
                )
                popover.permittedArrowDirections = []
            }
            context.coordinator.hasPresented = true
            NativeActionSheet.topmostViewController()?.present(alert, animated: true, completion: nil)
        } else {
            context.coordinator.hasPresented = false
        }
    }
}

enum NativeActionSheet {
    /// The windowing-hierarchy view controller that can present a modal today:
    /// the app's key-window root, walking up through whatever is currently
    /// presented (e.g. the overflow sheet).
    @MainActor
    static func topmostViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first
        guard let window = scene?.windows.first(where: { $0.isKeyWindow }) ?? scene?.windows.first,
              let root = window.rootViewController
        else { return nil }
        var top = root
        while let presented = top.presentedViewController { top = presented }
        return top
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
