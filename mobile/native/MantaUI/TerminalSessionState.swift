import SwiftUI
import Combine

// ===========================================================================
// S6 — terminal shared state (BET-598).
//
// A small observable the SwiftUI chrome (header, floating bar) reads while the
// UIKit terminal container owns the WKWebView, the keyboard accessory and the
// socket. The container writes into this; the SwiftUI reads it, so cross-
// framework coordination is a single `@Published` object, not threading callbacks.
// ===========================================================================

@MainActor
final class TerminalSessionState: ObservableObject {
    /// Live `cols×rows` for the header (§9.2 Chrome).
    @Published var geometryText = ""
    /// Whether the software keyboard (and therefore the key row) is visible.
    @Published var keyboardVisible = false
    /// The last selection reported by the webview's xterm (for Copy).
    @Published var selectedText: String?
    /// True while the shell reports a running process → esc tints red.
    @Published var isRunning = false
    /// Connection label for debugging / a thin status affordance.
    @Published var connectionLabel = ""

    /// Per-device font size (UserDefaults), read once by the container.
    static func storedFontSize() -> Double {
        let v = UserDefaults.standard.double(forKey: TerminalZoomStore.key)
        return v == 0 ? TerminalZoom.defaultValue : TerminalZoom.clamped(v)
    }

    static func store(fontSize: Double) {
        UserDefaults.standard.set(TerminalZoom.clamped(fontSize), forKey: TerminalZoomStore.key)
    }
}

enum TerminalZoomStore {
    static let key = "manta.terminal.fontSize"
}
