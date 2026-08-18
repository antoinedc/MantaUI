import Foundation
import UIKit

// ===========================================================================
// S6 — terminal models + pure logic (BET-598).
//
// Implements DECISIONS.md §9.2's terminal-mode behaviours as PURE, testable
// units — the box around the text. The text itself lives in xterm.js hosted
// in a WKWebView (the webview is the terminal surface, per §9; Swift never
// emulates a terminal). Everything here is transport + interaction logic with
// no HTTP / view / Keychain so it is unit-testable:
//
//   § key row       — `TerminalKey` + `TerminalKeyInput.bytes(for:ctrl:)`
//                      (the accessory maps a tapped key to the byte sequence)
//   § sticky ctrl   — `StickyModifierState` (latch on tap → next key → release;
//                      double-tap locks) — §9.2 "Sticky modifiers"
//   § annex chrome  — `TerminalURLBuilder` (wss /pty URL),
//                      `TerminalFrame` (WS control frames),
//                      `TerminalGeometry` (the live `80×24` header),
//                      `TerminalZoom` (per-device font-size persistence)
//   § selection     — `TerminalSelection` (selection → clipboard handoff)
//
// The WS socket that connects to the box lives in `TerminalSocket` (native);
// the WKWebView surface + its keyboard accessory live in
// `TerminalWebView.swift` / `TerminalKeyRow.swift`; the screen composing them
// lives in `TerminalScreen.swift`.
// ===========================================================================

// MARK: - Key row (§9.2)

/// A key the native accessory row can emit. Row 1: `esc · ctrl · tab · ↑ ↓ ← →`.
/// Row 2 (horizontally scrollable): `| ~ / - _ : $`.
enum TerminalKey: Equatable, Sendable {
    enum Arrow: String, Sendable { case up, down, left, right }

    case char(String)
    case esc
    case ctrl
    case tab
    case arrow(Arrow)
    case backspace
    case returnKey
    case space

    /// The label shown on the accessory key (the arrow glyphs mirror the spec).
    var label: String {
        switch self {
        case .char(let s): return s
        case .esc: return "esc"
        case .ctrl: return "ctrl"
        case .tab: return "tab"
        case .arrow(.up): return "↑"
        case .arrow(.down): return "↓"
        case .arrow(.left): return "←"
        case .arrow(.right): return "→"
        case .backspace: return "⌫"
        case .returnKey: return "⏎"
        case .space: return "␣"
        }
    }
}

/// Maps a tapped key (+ whether ctrl is sticky) to the byte sequence to write
/// to the shell. PURE. This is what makes Ctrl-C reachable from the phone —
/// the lone acceptance reason terminal mode exists (§9.1).
enum TerminalKeyInput {
    static func bytes(for key: TerminalKey, ctrl: Bool) -> String {
        switch key {
        case .esc:
            return "\u{1b}"
        case .tab:
            // ctrl-tab → reverse tab (CSI Z), the shell's shift-tab.
            return ctrl ? "\u{1b}[Z" : "\t"
        case .returnKey, .space:
            return " "
        case .backspace:
            return ctrl ? "\u{08}" : "\u{7f}"
        case .arrow(.up):
            return "\u{1b}[A"
        case .arrow(.down):
            return "\u{1b}[B"
        case .arrow(.right):
            return "\u{1b}[C"
        case .arrow(.left):
            return "\u{1b}[D"
        case .char(let s):
            if ctrl, let code = ctrlCode(for: s) { return code }
            return s
        case .ctrl:
            // The ctrl key itself produces no bytes — it only latches.
            return ""
        }
    }

    /// Ctrl-<letter> → 0x01..0x1A (Ctrl-A is 0x01, Ctrl-C is 0x03, …).
    static func ctrlCode(for char: String) -> String? {
        guard char.count == 1, let c = char.lowercased().first,
              let v = c.asciiValue, (97...122).contains(Int(v)) else {
            return nil
        }
        guard let scalar = UnicodeScalar(Int(v) - 96) else { return nil }
        return String(scalar)
    }
}

/// The two accessory rows per §9.2:
///   row 1: esc · ctrl · tab · ↑ ↓ ← →
///   row 2: the shell-constant chars buried three taps deep on iOS.
enum TerminalKeyRowLayout {
    static let row1: [TerminalKey] = [
        .esc, .ctrl, .tab,
        .arrow(.up), .arrow(.down), .arrow(.left), .arrow(.right),
    ]
    static let row2: [TerminalKey] = ["|", "~", "/", "-", "_", ":", "$"].map { .char($0) }
}

// MARK: - Sticky modifiers (§9.2)

/// The sticky-ctrl latch state machine. Tap → armed (lights up); the next
/// keypress consumes it and it releases; double-tap locks it on. PURE.
///
/// Spec: "`ctrl` latches on tap, lights up, applies to the next keypress,
/// then releases. Double-tap to lock."
enum StickyModifierState: Equatable, Sendable {
    case off
    case armed
    case locked

    /// A tap on the modifier key cycles off → armed → locked → off.
    var tapped: StickyModifierState {
        switch self {
        case .off: return .armed
        case .armed: return .locked   // double-tap locks
        case .locked: return .off     // a further tap unlocks
        }
    }

    /// A keypress (other than the modifier itself) applied the modifier.
    /// Armed releases; locked stays locked.
    var consumed: StickyModifierState {
        switch self {
        case .armed: return .off
        case .locked: return .locked
        case .off: return .off
        }
    }

    /// Whether the modifier is currently active (armed applies to one press;
    /// locked applies until unlocked).
    var isActive: Bool { self == .armed || self == .locked }
}

// MARK: - Transport (§9.2 chrome)

/// Builds the box `/pty` WebSocket URL. The socket is owned by NATIVE code
/// (`TerminalSocket`), so the webview never opens one; this is purely the URL
/// shape. PURE.
enum TerminalURLBuilder {
    /// `https://host/...` → `wss://host/pty?session=<k>&cols=<c>&rows=<r>[&cwd=<p>]`.
    /// The token travels as a header (set separately by the socket), never in
    /// the URL.
    static func ptyURL(serverURL: URL, sessionKey: String, cols: Int, rows: Int, cwd: String? = nil) -> URL? {
        var scheme = "wss"
        if let s = serverURL.scheme?.lowercased(), s == "http" { scheme = "ws" }
        guard var comps = URLComponents(url: serverURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        comps.scheme = scheme
        comps.path = "/pty"
        var items = [
            URLQueryItem(name: "session", value: sessionKey),
            URLQueryItem(name: "cols", value: String(max(20, min(500, cols)))),
            URLQueryItem(name: "rows", value: String(max(5, min(200, rows)))),
        ]
        if let cwd, !cwd.isEmpty {
            items.append(URLQueryItem(name: "cwd", value: cwd))
        }
        comps.queryItems = items
        return comps.url
    }
}

/// WS control frames per the server contract (src/server/ptyWs.mjs):
///   client → server: {type:"data",data} | {type:"resize",cols,rows}
///   server → client: raw PTY bytes, or {type:"error", error} as JSON text.
enum TerminalFrame {
    static func data(_ s: String) -> Data {
        (try? JSONSerialization.data(withJSONObject: ["type": "data", "data": s])) ?? Data()
    }

    static func resize(cols: Int, rows: Int) -> Data {
        (try? JSONSerialization.data(withJSONObject: ["type": "resize", "cols": cols, "rows": rows])) ?? Data()
    }

    /// Best-effort parse of a server control frame (error / close reason).
    /// Returns the error string if the frame is a JSON control error, else nil
    /// (meaning it is a raw PTY byte payload).
    static func controlError(from data: Data) -> String? {
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = obj["type"] as? String else {
            return nil
        }
        if type == "error", let err = obj["error"] as? String { return err }
        if type == "close", let err = obj["message"] as? String { return err }
        return nil
    }
}

/// The `cols×rows` header (§9.2 "Chrome: header shows window name and the live
/// geometry (80×24)") — the number you need when a TUI renders wrong.
enum TerminalGeometry {
    static func format(cols: Int, rows: Int) -> String {
        "\(cols)×\(rows)"
    }
}

/// Font-size state, persisted per device (§9.2 "Pinch to zoom… persisted per
/// device, not per session"). PURE over a small clamp; the actual UserDefaults
/// persistence lives in `TerminalZoomStore`.
enum TerminalZoom {
    static let min: Double = 8
    static let max: Double = 40
    static let defaultValue: Double = 15
    static let step: Double = 1.5

    /// Clamp a requested size and round to the nearest step so repeated pinches
    /// land on a stable grid.
    static func clamped(_ px: Double) -> Double {
        guard px.isFinite else { return defaultValue }
        let rounded = (px / step).rounded() * step
        return Swift.max(min, Swift.min(max, rounded))
    }
}

// MARK: - Selection (§9.2)

/// Selection → clipboard handoff shape. The webview reports selected text
/// (`window.__manta` selection event); native owns the UIPasteboard.
enum TerminalSelection {
    static func copy(_ text: String) {
        UIPasteboard.general.string = text
    }
}
