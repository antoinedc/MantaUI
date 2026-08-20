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

    /// The opencode sessionId of the ChatScreen currently on screen, nil when
    /// none is. Written by ChatScreen appear/disappear; read by the notification
    /// delegate (foreground suppression) and mirrored to the box (/push/focus).
    @Published var visibleSessionID: String?

    private init() {}

    func open(sessionID: String) {
        pendingSessionID = sessionID
    }
}

#if DEBUG
// ===========================================================================
// BET-1211/BET-1257 — DEBUG-only deep link to open a subagent drill-in on the
// REAL failing child, with no finger required to reach it. The blocker last
// time was circular: you can't tap the drill-in card because you can't scroll
// the parent to reach it. This route breaks that: it appends a SubagentSession
// to the navigation path (through the real `navigationDestination`), so the
// child's live scroll layer can be probed directly.
//
//   manta://debug/subagent?session=<parentSessionId>&child=<childSessionId>
//
// Compiled out entirely in Release.
// ===========================================================================
@MainActor
final class MantaDebugRouter: ObservableObject {
    static let shared = MantaDebugRouter()

    /// A DEBUG request to open `<childSessionID>`'s drill-in, having first
    /// pushed `<parentSessionID>`'s chat screen (so the SubagentSession
    /// destination is registered on the stack). Consumed by SessionListView.
    struct Request: Equatable {
        var parentSessionID: String
        var childSessionID: String
    }

    @Published var pendingSubagentPush: Request?

    /// A DEBUG request to start the pan/offset recorder (`PanProbe`) on
    /// whatever is currently on screen, labelled `tag` — used to record the
    /// parent control after popping back. Consumed by SessionListView.
    @Published var pendingPanTag: String?

    private init() {}

    /// Parse a `manta://debug/subagent?...` link. Returns true iff handled.
    @discardableResult
    static func route(_ url: URL) -> Bool {
        guard url.scheme == "manta", url.host == "debug" else { return false }
        if url.path == "/subagent" {
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
            let session = items?.first(where: { $0.name == "session" })?.value
            let child = items?.first(where: { $0.name == "child" })?.value
            guard let session, !session.isEmpty, let child, !child.isEmpty else { return false }
            shared.pendingSubagentPush = Request(parentSessionID: session, childSessionID: child)
            return true
        }
        if url.path == "/pan" {
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
            let tag = items?.first(where: { $0.name == "tag" })?.value
            shared.pendingPanTag = tag ?? "pan"
            return true
        }
        return false
    }
}
#endif

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
