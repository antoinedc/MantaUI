import XCTest
@testable import MantaUI

// ===========================================================================
// WS07 — the overflow sheet's mode-row mount gate (master ledger M-04-2). The
// "Chat / Terminal / AI CLI" rows are mounted ONLY when the caller passes the
// mode, the select closure AND the retry closure (so a failed catalog's "Try
// again" can never be a dead button), and never in a read-only background-job
// chat. Otherwise the legacy "Open terminal" row stays — except in a read-only
// job, which shows neither. Mac-only (`ChatOverflowSheet.swift` is SwiftUI).
// ===========================================================================

final class ChatOverflowGateTests: XCTestCase {

    private func mount(_ mode: Bool, _ select: Bool, _ retry: Bool, readOnly: Bool = false) -> Bool {
        OverflowModeRowsGate.mount(hasMode: mode, hasSelect: select, hasRetry: retry, readOnly: readOnly)
    }

    private func terminal(_ mode: Bool, _ select: Bool, _ retry: Bool, readOnly: Bool = false) -> Bool {
        OverflowModeRowsGate.showsOpenTerminal(hasMode: mode, hasSelect: select, hasRetry: retry, readOnly: readOnly)
    }

    func testTheModeRowsMountOnlyWhenAllThreeArePresentAndTheChatIsWritable() {
        XCTAssertTrue(mount(true, true, true))
        XCTAssertFalse(mount(false, true, true))
        XCTAssertFalse(mount(true, false, true))
        XCTAssertFalse(mount(true, true, false), "no retry closure → no mode rows (no dead 'Try again')")
        XCTAssertFalse(mount(true, true, true, readOnly: true))
    }

    func testOpenTerminalStaysForEveryLegacyCombination() {
        // the capture scene / older callers pass none of the three
        XCTAssertTrue(terminal(false, false, false))
        for combo in [(true, false, false), (false, true, false), (false, false, true),
                      (true, true, false), (true, false, true), (false, true, true)] {
            XCTAssertTrue(terminal(combo.0, combo.1, combo.2), "\(combo)")
        }
    }

    func testOpenTerminalIsHiddenWhenTheModeRowsReplaceItOrTheChatIsReadOnly() {
        XCTAssertFalse(terminal(true, true, true), "the mode rows replace it")
        XCTAssertFalse(terminal(false, false, false, readOnly: true))
        XCTAssertFalse(terminal(true, true, true, readOnly: true))
    }

    func testTheTwoDecisionsNeverBothShowAndNeverBothHide() {
        for mode in [false, true] {
            for select in [false, true] {
                for retry in [false, true] {
                    XCTAssertNotEqual(mount(mode, select, retry), terminal(mode, select, retry),
                                      "exactly one of the two when writable: \(mode) \(select) \(retry)")
                }
            }
        }
    }
}
