import Foundation
import Combine

// ===========================================================================
// WS04 §11 — C2: the app-wide router value. The route/draft TYPES are
// Foundation-only (`MantaNavigationModels.swift`); this is the observable
// carrier, injected as an `@EnvironmentObject` from `MantaAppRoot`.
//
// Anything can call `open(_:)` / `startNewSession(_:)`; `SessionListView` is the
// one consumer — it owns the navigation stack, so it resolves a route against
// the live project list, dismisses whatever sheet is up, and pushes (a `.review`
// route opens the review screen as a sheet).
// ===========================================================================

@MainActor
final class MantaNavigator: ObservableObject {
    @Published var pending: MantaRoute?
    /// A "start a new session with this" request waiting for the create sheet.
    @Published var pendingDraft: NewSessionDraft?
    @Published var switcherPresented = false

    func open(_ route: MantaRoute) {
        pending = route
    }

    /// D2/D12: presents the create sheet prefilled. Nothing is created until the
    /// user taps Create.
    func startNewSession(_ draft: NewSessionDraft) {
        pendingDraft = draft
    }

    func presentSwitcher() {
        switcherPresented = true
    }

    /// Saves the mode for this device, then reopens the session — the list
    /// replaces the top of the stack with the same session in the new mode.
    func switchMode(windowKey: String, sessionID: String, to mode: SessionMode) {
        SessionModeStore.write(mode, sessionID: sessionID)
        open(.session(windowKey: windowKey))
    }

    /// Forget everything addressed to the previous box (a pending route, a draft,
    /// the switcher): none of it means anything on another box.
    func reset() {
        pending = nil
        pendingDraft = nil
        switcherPresented = false
    }

    static func windowKey(project: String, windowIndex: Int) -> String {
        SessionRouteLogic.windowKey(project: project, windowIndex: windowIndex)
    }
}
