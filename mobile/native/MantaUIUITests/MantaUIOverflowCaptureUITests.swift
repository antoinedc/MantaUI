import XCTest
import CryptoKit

// ===========================================================================
// One purpose (BET-628): capture the Clear confirmation from the real
// ChatOverflowSheet — it must be a NATIVE presentation (never a web dialog)
// with the destructive "Clear session" item FIRST (DECISIONS.md:709-715).
//
// It drives the app into the harness scene `chat-overflow-clear` (which raises
// the overflow sheet), taps the "Clear session" row, waits on a REAL rendered
// state (the confirmation's message text), then captures a settled screenshot
// AND dumps the accessibility tree so the destructive-first ordering (and the
// presence/absence of the detached Cancel) is auditable.
//
// The screenshot is written to NSTemporaryDirectory() and its path + md5 are
// printed to stdout (the xcodebuild log), which is how the runner hands files
// out — xcodebuild does not forward arbitrary env into the test process.
// ===========================================================================

final class MantaUIOverflowCaptureUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testCaptureClearActionSheet() throws {
        let app = XCUIApplication()
        app.launchEnvironment["MANTA_SCENE"] = "chat-overflow-clear"
        app.launch()

        // 1. The overflow sheet is raised by the scene; the Clear row is the
        //    destructive Button in the LAST section, below the medium-detent
        //    fold, so scroll the sheet to reveal it before querying.
        XCTAssertTrue(app.staticTexts["Attach photo or file"].waitForExistence(timeout: 8), "overflow sheet did not present")
        let clearRow = app.buttons["Clear session"]
        if !clearRow.waitForExistence(timeout: 3) {
            for _ in 0..<4 where !clearRow.exists {
                app.swipeUp()
            }
            _ = clearRow.waitForExistence(timeout: 4)
        }
        XCTAssertTrue(clearRow.exists, "overflow-sheet Clear row did not appear (was it below the fold)")

        // 2. Tap Clear → its confirmationDialog (a native action sheet) presents.
        clearRow.tap()

        // 3. The gate that proves the ACTION SHEET (not the overflow sheet) is
        //    up: the native action sheet's unique message text OR its Cancel
        //    button (UIAlertController may expose the two differently).
        let message = app.staticTexts["Starts a fresh session in this window. The transcript stays on the box."]
        let presented = message.waitForExistence(timeout: 8)
            || app.buttons["Cancel"].waitForExistence(timeout: 8)
        if !presented {
            print("AX-TREE-BEGIN")
            print(app.debugDescription)
            print("AX-TREE-END")
        }
        XCTAssertTrue(presented, "Clear action sheet did not present")

        // 4. Wait out the presentation animation to a SETTLED frame.
        let png = try saveConvergedScreenshot()
        XCTAssertTrue(FileManager.default.fileExists(atPath: png.path), "settled screenshot was not written")

        // 5. Evidence: the action sheet is present and is a NATIVE presentation
        //    (a .sheet/.popover — never a web dialog, which would not appear as
        //    a system sheet). Record the destructive-first + Cancel facts.
        print("AX-TREE-BEGIN")
        print(app.debugDescription)
        print("AX-TREE-END")

        let nativeSheet = app.sheets.firstMatch.exists || app.popovers.firstMatch.exists || app.alerts.firstMatch.exists
        let clearButtons = app.buttons.matching(identifier: "Clear session").allElementsBoundByIndex
        let cancelButton = app.buttons["Cancel"].firstMatch
        let hasOrdering = !clearButtons.isEmpty
        let clearMaxY = clearButtons.map { $0.frame.minY }.max() ?? 0
        let orderOK = hasOrdering && cancelButton.exists && clearMaxY < cancelButton.frame.minY

        print("RESULT nativeSheet=\(nativeSheet)")
        print("RESULT destructiveClearPresent=\(hasOrdering)")
        print("RESULT cancelPresent=\(cancelButton.exists)")
        print("RESULT destructiveFirstAboveCancel=\(orderOK)")

        XCTAssertTrue(nativeSheet, "Clear should present a NATIVE action sheet, not a web dialog")
        XCTAssertTrue(hasOrdering, "destructive Clear session should be present in the action sheet")
        XCTAssertTrue(cancelButton.exists, "detached Cancel should be present in the action sheet (DECISIONS.md:709-715)")
        XCTAssertTrue(orderOK, "destructive Clear session must be FIRST, above the detached Cancel")
    }

    // Two consecutive byte-identical screenshots, else fail (no retry-until-pass).
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
        XCTAssertTrue(converged, "screenshot never converged (frames kept differing)")
        let data = try Data(contentsOf: url)
        print("SCREENSHOT_PATH \(url.path)")
        print("SCREENSHOT_MD5 \(Insecure.MD5.hash(data: data).map { String(format: "%02x", $0) }.joined())")
        return url
    }
}
