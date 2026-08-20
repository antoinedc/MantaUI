import XCTest

// BET-1211 real-HID drag harness (author: macos). XCUITest synthetic swipes
// cannot drive TiledView's scroll; real macOS-mouse input over the Simulator
// window becomes real device touches that can. These tests navigate the app to
// a surface and HOLD it in place while a host-side CGEvent drag runs. Verdict is
// read from the os_log "[scroll]" probe (off= changes on a real pan).
// Hold tests are not gates; they are the touch-injection window.
final class MantaSubagentScrollDiagUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    @MainActor
    func testHoldParent() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Sessions"].waitForExistence(timeout: 20))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.28)).tap()
        usleep(4_000_000)
        print("DIAG parent held")
        // Hold ~95s: reveal a window for the host-side drag.
        sleep(95)
    }

    @MainActor
    func testHoldChild() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Sessions"].waitForExistence(timeout: 20))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.28)).tap()
        usleep(4_000_000)
        let agentByLabel = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "fixture subagent"))
            .firstMatch
        let agentRow = app.descendants(matching: .any)["agent-row"].firstMatch
        let target = agentByLabel.exists ? agentByLabel : agentRow
        XCTAssertTrue(target.exists, "no subagent task row")
        target.tap()
        usleep(4_000_000)
        print("DIAG child held")
        sleep(95)
    }
}
