import XCTest
import CryptoKit

// ===========================================================================
// Live-box verification of the BET-628 Clear confirmation (native action sheet
// with destructive item first + detached Cancel). Requires the simulated app
// to be ALREADY PAIRED (run MantaPairingDriverUITests first) so launching shows
// the session list; this test then opens a real chat session on the box,
// raises the overflow sheet, taps Clear, and captures the settled confirmation.
//
// Skips unless a chat session row is present (no box).
// ===========================================================================

final class MantaLiveChatClearCaptureUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testRealChatClearActionSheet() throws {
        let app = XCUIApplication()
        app.launch()

        // 1. Session list → open the chat-mode session (a row whose label holds
        //    a window name; the staging box's chat window is "default").
        let chatRow = app.buttons.matching(NSPredicate(format: "label CONTAINS 'default'")).firstMatch
        guard chatRow.waitForExistence(timeout: 20) else {
            throw XCTSkip("LIVE SKIP: no session-list chat row (box not connected / no chat session)")
        }
        chatRow.tap()

        // 2. ChatScreen is up; let it settle so the header is interactive.
        let chatScreen = app.otherElements["chat-screen"].firstMatch
        guard chatScreen.waitForExistence(timeout: 15) else {
            throw XCTSkip("LIVE SKIP: chat screen did not open")
        }
        _ = app.buttons["Session actions"].waitForExistence(timeout: 10)

        // 3. Open the overflow sheet; retry the tap until the sheet appears.
        var opened = false
        for _ in 0..<4 {
            if app.buttons["Session actions"].exists { app.buttons["Session actions"].tap() }
            if app.staticTexts["Scheduled tasks"].waitForExistence(timeout: 4) { opened = true; break }
        }
        XCTAssertTrue(opened, "overflow sheet did not present")

        // 4. Raise to the large detent, then scroll to the destructive Clear row.
        app.swipeUp()
        app.swipeUp()
        let clearRow = app.buttons["Clear session"]
        if !clearRow.waitForExistence(timeout: 3) {
            var swipes = 0
            while !clearRow.exists && swipes < 8 {
                app.swipeUp()
                swipes += 1
                usleep(300_000)
            }
            _ = clearRow.waitForExistence(timeout: 4)
        }
        XCTAssertTrue(clearRow.exists, "overflow-sheet Clear row missing")

        // 5. Tap Clear → native action sheet presents (message OR Cancel).
        clearRow.tap()
        let presented = app.staticTexts["Starts a fresh session in this window. The transcript stays on the server."].waitForExistence(timeout: 8)
            || app.buttons["Cancel"].waitForExistence(timeout: 8)
            || app.alerts.firstMatch.waitForExistence(timeout: 4)
        print("RESULT actionSheetPresented=\(presented)")

        // 6. Settled screenshot.
        let png = try saveConvergedScreenshot()
        XCTAssertTrue(FileManager.default.fileExists(atPath: png.path), "settled screenshot not written")

        print("AX-TREE-BEGIN")
        print(app.debugDescription)
        print("AX-TREE-END")

        // 7. The DONE-WHEN: native presentation, destructive Clear first,
        //    detached Cancel present.
        let nativeSheet = app.staticTexts["Clear this session?"].exists
            && !app.buttons.matching(identifier: "Clear session").allElementsBoundByIndex.isEmpty
            && app.buttons["Cancel"].exists
        let clearButtons = app.buttons.matching(identifier: "Clear session").allElementsBoundByIndex
        let cancelButton = app.buttons["Cancel"].firstMatch
        let clearMaxY = clearButtons.map { $0.frame.minY }.max() ?? 0
        let orderOK = !clearButtons.isEmpty && cancelButton.exists && clearMaxY < cancelButton.frame.minY

        print("RESULT nativeSheet=\(nativeSheet)")
        print("RESULT destructiveClearPresent=\(!clearButtons.isEmpty)")
        print("RESULT cancelPresent=\(cancelButton.exists)")
        print("RESULT destructiveFirstAboveCancel=\(orderOK)")

        XCTAssertTrue(presented, "Clear action sheet did not present")
        XCTAssertTrue(nativeSheet, "Clear should present a NATIVE action sheet, not a web dialog")
        XCTAssertTrue(!clearButtons.isEmpty, "destructive Clear session should be present")
        XCTAssertTrue(cancelButton.exists, "detached Cancel should be present (DECISIONS.md:709-715)")
        XCTAssertTrue(orderOK, "destructive Clear session must be FIRST, above the detached Cancel")
    }

    private func saveConvergedScreenshot() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("manta-clear-action-sheet.png")
        var last = Data()
        var converged = false
        for _ in 0..<40 {
            let shot = XCUIScreen.main.screenshot().pngRepresentation
            if !last.isEmpty && shot == last {
                try shot.write(to: url)
                converged = true
                break
            }
            last = shot
            usleep(350_000)
        }
        XCTAssertTrue(converged, "screenshot never converged")
        let data = try Data(contentsOf: url)
        print("SCREENSHOT_PATH \(url.path)")
        print("SCREENSHOT_MD5 \(Insecure.MD5.hash(data: data).map { String(format: "%02x", $0) }.joined())")
        return url
    }
}
