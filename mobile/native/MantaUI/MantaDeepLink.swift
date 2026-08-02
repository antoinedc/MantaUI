import Foundation
import SwiftUI

// ===========================================================================
// S8 — app-wide routing for push deep-links and pairing universal links
// (BET-600).
//
// Two published holders, consumed by the SwiftUI tree:
//   • MantaPushRouter     — a notification tap opening a session
//   • MantaPairingRouter  — a pairing link (universal https:// or manta://)
//                           feeding S2's onboarding flow
//
// The app delegate is the delivery point for both when the app is cold-started
// by the OS; `MantaDeepLink.route` is the single parser used by the delegate's
// `continue userActivity` and by SwiftUI's `onOpenURL`. Both converge on the
// same /auth/claim contract via MantaPairing.parsePairPayload, so the custom
// scheme (`manta://pair?...`) and the universal-link form
// (`https://app.mantaui.com/m?...`) can never disagree.
// ===========================================================================

@MainActor
final class MantaPushRouter: ObservableObject {
    static let shared = MantaPushRouter()

    /// The opencode sessionId a tapped notification was about. Set by the
    /// notification delegate, consumed by SessionListView (which clears it
    /// once it has pushed the matching ChatScreen onto its NavigationStack).
    @Published var pendingSessionID: String?

    private init() {}

    func open(sessionID: String) {
        pendingSessionID = sessionID
    }
}

@MainActor
final class MantaPairingRouter: ObservableObject {
    static let shared = MantaPairingRouter()

    /// A parsed pairing payload awaiting hand-off to the onboarding flow.
    @Published var pendingPayload: MantaPairing.PairPayload?

    private init() {}

    /// Parse a deep link and stage it for the onboarding flow. Returns true iff
    /// the URL is a Manta pairing link that should be handled by the app.
    @discardableResult
    static func route(_ url: URL) -> Bool {
        guard let payload = MantaPairing.parsePairPayload(url.absoluteString) else {
            return false
        }
        shared.pendingPayload = payload
        return true
    }
}
