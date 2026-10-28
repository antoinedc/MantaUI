import Foundation

// ===========================================================================
// WS04 §12 — the app-only adapter from a finished create to the navigation
// value (`SessionOpenTarget` lives in the app-only `SessionListView.swift`, so
// the pure plan can't build it).
//
// The draft is the ONLY carrier of the first message: `seed` stays nil so the
// text can't reach the composer twice (`ChatScreen(…, draft:)` applies it once).
// ===========================================================================

extension SessionCreated {
    /// The destination to push for this session. `windowName` is the window's
    /// real name (resolved against the newest project list by the caller).
    func openTarget(windowName: String) -> SessionOpenTarget {
        SessionOpenTarget(
            project: project,
            windowIndex: windowIndex,
            name: windowName,
            sessionId: sessionId,
            seed: nil,
            mode: mode,
            draft: draft
        )
    }
}
