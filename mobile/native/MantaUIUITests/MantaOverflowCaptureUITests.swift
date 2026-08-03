import XCTest

// ===========================================================================
// BET-627 capture driver — Sheet items 1-3 (attach · scheduled tasks live
// count · secrets) on the pinned simulator.
//
// Drives the REAL app (paired to the local capture-fixture box at
// 127.0.0.1:8787) through the chat overflow sheet and captures each required
// surface, so the DONE WHEN — "the overflow sheet showing the three rows, the
// scheduled-tasks count badge non-zero with a schedule present, and each row
// (Attach / Scheduled tasks / Secrets) opening its card" — has screenshot +
// accessibility-hierarchy evidence.
//
// Pairing: if the app is not yet paired it claims a code against the fixture
// box ("123456") via the advanced server-URL path, exactly like a user would.
// It is idempotent — a re-run lands straight on the session list.
//
// Evidence: each surface captures BOTH legs the visual harness wants — a
// settled XCUIScreen PNG (written to the runner's tmp container) and a
// print-marker accessibility tree (extracted from the xcodebuild log).
// ===========================================================================

final class MantaOverflowCaptureUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testCaptureOverflowSheetItems() throws {
        let code = ProcessInfo.processInfo.environment["MANTA_PAIR_CODE"] ?? "123456"
        let server = ProcessInfo.processInfo.environment["MANTA_PAIR_SERVER"] ?? "http://127.0.0.1:8787"
        let app = XCUIApplication()
        app.launch()

        // --- Pair if needed (idempotent) -------------------------------------
        let otp = app.textFields["onboarding-otp"]
        if otp.waitForExistence(timeout: 3) {
            otp.tap()
            otp.typeText(code)

            let advanced = app.buttons["My box isn't reachable from the internet"]
            if advanced.exists { advanced.tap() }
            let serverField = app.textFields["onboarding-server-url"]
            XCTAssertTrue(serverField.waitForExistence(timeout: 5), "server URL field never appeared")
            serverField.tap()
            serverField.typeText(server)

            app.buttons["Continue"].firstMatch.tap()

            let notifications = app.staticTexts["Know when it needs you"]
            let failure = app.staticTexts["onboarding-failure-subtitle"]
            let deadline = Date().addingTimeInterval(45)
            while Date() < deadline, !notifications.exists, !failure.exists {
                usleep(300_000)
            }
            XCTAssertFalse(failure.exists, "pairing failed: \(failure.label)")
            XCTAssertTrue(notifications.exists, "notifications primer never appeared after claim")
            app.buttons["Continue"].firstMatch.tap()

            answerNotificationAlertIfPresent()
            app.terminate()
            app.launch()
        }

        // --- Session list → open the chat row -------------------------------
        XCTAssertTrue(app.staticTexts["Sessions"].waitForExistence(timeout: 20), "session list never appeared")
        // Rows combine their children for accessibility, so match by label
        // prefix (window name "Chat") the way the repo's open-row driver does.
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH 'Chat'"))
            .firstMatch
        let actions = app.buttons["Session actions"]
        if row.waitForExistence(timeout: 10) {
            row.tap()
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.30)).tap()
        }
        XCTAssertTrue(actions.waitForExistence(timeout: 25), "chat screen did not open (no Session actions button)")

        // --- A. Overflow sheet: three rows + non-zero count badge ------------
        actions.tap()
        let scheduledRow = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Scheduled tasks'")).firstMatch
        XCTAssertTrue(scheduledRow.waitForExistence(timeout: 10), "overflow sheet did not open (Scheduled tasks row missing)")
        XCTAssertTrue(app.staticTexts["Secrets"].exists, "Secrets row missing from overflow sheet")
        XCTAssertTrue(app.staticTexts["Attach photo or file"].exists, "Attach row missing from overflow sheet")
        // The count arrives async once `schedule:list` returns; wait for the
        // badge (either merged into the row label or as its own static text).
        let countVisible = waitNonZeroBadge(app: app, scheduledRow: scheduledRow)
        print("META627 count-badge-visible=\(countVisible)")
        usleep(800_000)
        snap(app, marker: "META-SHEET")

        // --- B. Scheduled tasks card (open from its row) ---------------------
        scheduledRow.tap()
        XCTAssertTrue(app.staticTexts["Morning standup"].waitForExistence(timeout: 10), "Scheduled tasks card did not show the seeded job")
        usleep(400_000)
        snap(app, marker: "META-SCHEDULES")
        app.buttons["Done"].firstMatch.tap()

        // --- C. Secrets card -------------------------------------------------
        app.buttons["Session actions"].tap()
        let secretsRow = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Secrets'")).firstMatch
        XCTAssertTrue(secretsRow.waitForExistence(timeout: 10), "Secrets row missing on reopen")
        secretsRow.tap()
        XCTAssertTrue(app.staticTexts["GITHUB_TOKEN"].waitForExistence(timeout: 10), "Secrets card did not show the seeded secret")
        usleep(400_000)
        snap(app, marker: "META-SECRETS")
        app.buttons["Done"].firstMatch.tap()

        // --- D. Attach card --------------------------------------------------
        app.buttons["Session actions"].tap()
        // Match the sheet row, not the composer's `attach-button` ("Attach").
        let attachRow = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Attach photo'")).firstMatch
        XCTAssertTrue(attachRow.waitForExistence(timeout: 10), "Attach row missing on reopen")
        attachRow.tap()
        // The card loads instantly (no RPC); the PhotosPicker + File button are
        // system controls that can vary in element type, so confirm on the
        // card's own nav title, then settle before the screenshot.
        XCTAssertTrue(app.staticTexts["Attach"].waitForExistence(timeout: 10),
                      "Attach card did not present its navigation title")
        XCTAssertTrue(app.buttons["File"].exists, "Attach card did not show the File row")
        usleep(800_000)
        snap(app, marker: "META-ATTACH")
    }

    /// True once the scheduled-tasks count badge is visible — either merged into
    /// the row button's label or as its own "1" static text.
    private func waitNonZeroBadge(app: XCUIApplication, scheduledRow: XCUIElement) -> Bool {
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            if app.staticTexts["1"].exists { return true }
            if scheduledRow.label.contains("1") { return true }
            usleep(200_000)
        }
        return false
    }

    /// Writes a settled PNG to the runner's tmp container and prints the
    /// current accessibility tree between marker lines for log extraction.
    private func snap(_ app: XCUIApplication, marker: String) {
        let shot = XCUIScreen.main.screenshot()
        let name = "bet627-\(marker.lowercased()).png"
        let out = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(name)
        try? shot.pngRepresentation.write(to: out)
        print("META627SHOT marker=\(marker) path=\(out.path)")
        print("AX-TREE-BEGIN \(marker)")
        print(app.debugDescription)
        print("AX-TREE-END \(marker)")
    }

    private func answerNotificationAlertIfPresent() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Allow", "Don't Allow", "OK"] {
            let button = springboard.buttons[label]
            if button.waitForExistence(timeout: 3) {
                button.tap()
                print("META627 alert-answered=\(label)")
                return
            }
        }
        print("META627 alert-answered=none")
    }
}
