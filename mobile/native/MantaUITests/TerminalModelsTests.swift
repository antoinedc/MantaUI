import XCTest
@testable import MantaUI

// ===========================================================================
// S6 — terminal pure-logic tests (BET-598).
//
// The acceptance reason terminal mode exists is that Ctrl-C must be reachable
// from the phone (§9.1). That is a pure mapping (TerminalKeyInput), as are the
// sticky-ctrl state machine, the /pty URL, the WS control frames, the geometry
// header and the pinch-zoom clamp — all unit-testable without a simulator UI.
// ===========================================================================

final class TerminalModelsTests: XCTestCase {

    // MARK: - Key → bytes (the Ctrl-C fix)

    func testEscIsEscapeByte() {
        XCTAssertEqual(TerminalKeyInput.bytes(for: .esc, ctrl: false), "\u{1b}")
    }

    func testTab() {
        XCTAssertEqual(TerminalKeyInput.bytes(for: .tab, ctrl: false), "\t")
    }

    func testCtrlTabIsReverseTab() {
        XCTAssertEqual(TerminalKeyInput.bytes(for: .tab, ctrl: true), "\u{1b}[Z")
    }

    func testArrowSequences() {
        XCTAssertEqual(TerminalKeyInput.bytes(for: .arrow(.up), ctrl: false), "\u{1b}[A")
        XCTAssertEqual(TerminalKeyInput.bytes(for: .arrow(.down), ctrl: false), "\u{1b}[B")
        XCTAssertEqual(TerminalKeyInput.bytes(for: .arrow(.right), ctrl: false), "\u{1b}[C")
        XCTAssertEqual(TerminalKeyInput.bytes(for: .arrow(.left), ctrl: false), "\u{1b}[D")
    }

    func testPlainCharPassesThrough() {
        XCTAssertEqual(TerminalKeyInput.bytes(for: .char("/"), ctrl: false), "/")
        XCTAssertEqual(TerminalKeyInput.bytes(for: .char("$"), ctrl: false), "$")
    }

    func testCtrlCPutsCTRLCOnTheWire() {
        // The whole point of terminal mode (§9.1). Ctrl-C from the sticky key
        // must produce 0x03, not the letter "c".
        XCTAssertEqual(TerminalKeyInput.bytes(for: .char("c"), ctrl: true), "\u{03}")
    }

    func testCtrlCodeMapping() {
        XCTAssertEqual(TerminalKeyInput.ctrlCode(for: "a"), "\u{01}")
        XCTAssertEqual(TerminalKeyInput.ctrlCode(for: "c"), "\u{03}")
        XCTAssertEqual(TerminalKeyInput.ctrlCode(for: "z"), "\u{1a}")
    }

    func testCtrlCodeIsCaseInsensitive() {
        XCTAssertEqual(TerminalKeyInput.ctrlCode(for: "C"), "\u{03}")
    }

    func testCtrlCodeRejectsNonLetters() {
        XCTAssertNil(TerminalKeyInput.ctrlCode(for: "1"))
        XCTAssertNil(TerminalKeyInput.ctrlCode(for: "$"))
        XCTAssertNil(TerminalKeyInput.ctrlCode(for: "ab"))
    }

    // MARK: - Sticky ctrl state machine (§9.2)

    func testTapCyclesOffArmedLockedOff() {
        XCTAssertEqual(StickyModifierState.off.tapped, .armed)
        XCTAssertEqual(StickyModifierState.armed.tapped, .locked)   // double-tap locks
        XCTAssertEqual(StickyModifierState.locked.tapped, .off)     // a further tap unlocks
    }

    func testArmedReleaseOnNextKeypress() {
        XCTAssertEqual(StickyModifierState.armed.consumed, .off)
        XCTAssertFalse(StickyModifierState.armed.consumed.isActive)
    }

    func testLockedStaysLatched() {
        XCTAssertEqual(StickyModifierState.locked.consumed, .locked)
        XCTAssertTrue(StickyModifierState.locked.consumed.isActive)
    }

    func testOffStaysOff() {
        XCTAssertEqual(StickyModifierState.off.consumed, .off)
    }

    func testIsActive() {
        XCTAssertFalse(StickyModifierState.off.isActive)
        XCTAssertTrue(StickyModifierState.armed.isActive)
        XCTAssertTrue(StickyModifierState.locked.isActive)
    }

    // MARK: - Row layout (§9.2)

    func testRow1ExactOrder() {
        XCTAssertEqual(TerminalKeyRowLayout.row1.map(\.label),
                       ["esc", "ctrl", "tab", "↑", "↓", "←", "→"])
    }

    func testRow2Chars() {
        XCTAssertEqual(TerminalKeyRowLayout.row2.map(\.label), ["|", "~", "/", "-", "_", ":", "$"])
    }

    // MARK: - Transport (§9.2 chrome)

    func testPtyURLBuildsWSS() {
        let server = URL(string: "https://box.example.com")!
        let url = TerminalURLBuilder.ptyURL(serverURL: server, sessionKey: "ws:1", cols: 80, rows: 24)
        XCTAssertNotNil(url)
        XCTAssertEqual(url?.scheme, "wss")
        XCTAssertEqual(url?.path, "/pty")
        let items = URLComponents(url: url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let dict = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(dict["session"], "ws:1")
        XCTAssertEqual(dict["cols"], "80")
        XCTAssertEqual(dict["rows"], "24")
    }

    func testPtyURLPlainHTTPUsesWS() {
        let server = URL(string: "http://127.0.0.1:8787")!
        let url = TerminalURLBuilder.ptyURL(serverURL: server, sessionKey: "k", cols: 80, rows: 24)
        XCTAssertEqual(url?.scheme, "ws")
    }

    func testDataFrameEnvelope() {
        let data = TerminalFrame.data("hi")
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        XCTAssertEqual(obj?["type"] as? String, "data")
        XCTAssertEqual(obj?["data"] as? String, "hi")
    }

    func testResizeFrameEnvelope() {
        let data = TerminalFrame.resize(cols: 100, rows: 50)
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        XCTAssertEqual(obj?["type"] as? String, "resize")
        XCTAssertEqual(obj?["cols"] as? Int, 100)
        XCTAssertEqual(obj?["rows"] as? Int, 50)
    }

    func testControlErrorParsed() {
        let data = (try! JSONSerialization.data(withJSONObject: ["type": "error", "error": "session_required"]))
        XCTAssertEqual(TerminalFrame.controlError(from: data), "session_required")
    }

    func testRawBytesAreNotControlError() {
        let data = Data("hello".utf8)
        XCTAssertNil(TerminalFrame.controlError(from: data))
    }

    // MARK: - Chrome (§9.2)

    func testGeometryFormatting() {
        XCTAssertEqual(TerminalGeometry.format(cols: 80, rows: 24), "80×24")
    }

    func testZoomClampsAndRounds() {
        XCTAssertEqual(TerminalZoom.clamped(15), 15)
        XCTAssertEqual(TerminalZoom.clamped(100), TerminalZoom.max)
        XCTAssertEqual(TerminalZoom.clamped(-5), TerminalZoom.min)
        XCTAssertEqual(TerminalZoom.clamped(.nan), TerminalZoom.defaultValue)
    }
}
