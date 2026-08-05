import SwiftUI
import UIKit

// ===========================================================================
// Edge-swipe back (left-edge interactive pop gesture).
//
// The chat screens paint their own floating-glass header and therefore hide the
// system navigation bar (`.toolbar(.hidden, for: .navigationBar)`) and the back
// button (`.navigationBarBackButtonHidden(true)`). Hiding the bar also disables
// the navigation controller's left-edge interactive pop gesture, so the only
// way back was the floating chevron button.
//
// This representable re-arms that gesture. Attached as a `.background(...)` on
// the pushed view, its host resolves the enclosing navigation controller and
// forces the interactive pop gesture back on, overriding its delegate so the
// pop always begins on this (non-root) screen. The host is invisible and
// ignores touches, so it adds nothing to the canvas.
// ===========================================================================

struct EdgeSwipeRestorer: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController {
        PopRestorerHost(coordinator: context.coordinator)
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        /// Always allow the pop-from-edge gesture. UIKit still refuses to pop
        /// the root controller, so an unconditional true is safe here.
        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            true
        }
    }

    @MainActor
    private final class PopRestorerHost: UIViewController {
        private let coordinator: Coordinator

        init(coordinator: Coordinator) {
            self.coordinator = coordinator
            super.init(nibName: nil, bundle: nil)
            view.backgroundColor = .clear
            view.isUserInteractionEnabled = false
        }

        required init?(coder: NSCoder) { fatalError("not used") }

        override func viewDidLoad() {
            super.viewDidLoad()
            arm()
        }

        // The reliable moment the host has joined the navigation stack (the
        // nav controller is non-nil here; it can still be nil at viewDidLoad).
        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            arm()
        }

        private func arm() {
            guard let nav = navigationController else { return }
            nav.interactivePopGestureRecognizer?.delegate = coordinator
            nav.interactivePopGestureRecognizer?.isEnabled = true
        }
    }
}
