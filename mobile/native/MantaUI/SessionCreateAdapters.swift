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

extension SessionOpenTarget {
    /// A target for opening an existing session, with this device's saved mode
    /// resolved INTO the value. `mode` is part of a target's identity, so
    /// switching a session's mode produces a different value (a real stack
    /// replace) while re-opening it in the mode it is already in stays equal (no
    /// flicker). A window with no chat session has no mode.
    static func opened(project: String, windowIndex: Int, name: String, sessionId: String?,
                       defaults: UserDefaults = .standard) -> SessionOpenTarget {
        let mode = (sessionId ?? "").isEmpty ? nil : SessionModeStore.read(sessionID: sessionId ?? "", defaults: defaults)
        return SessionOpenTarget(project: project, windowIndex: windowIndex, name: name, sessionId: sessionId, mode: mode)
    }
}
