import XCTest

// ===========================================================================
// BET-1028 acceptance captures — the WhatsApp-style recording surfaces.
//
// Driven to a REAL composer-bearing chat against the local capture-fixture box
// (127.0.0.1:8787), exactly like MantaRunningStateCaptureUITests:
//   1. Tap the mic button → assert `voice-recording-held` appears.
//   2. Swipe UP on the held surface → assert `voice-recording-locked` appears
//      with `voice-discard` / `voice-pause` / `voice-send` present.
//
// No audio is asserted (the fixture box owns the live stream; the mic hardware
// path is not asserted). The fixture box must have a Groq key configured so the
// mic button is available, and the simulator must grant mic permission once.
// Evidence: each capture writes a settled PNG + prints the accessibility tree.
// ===========================================================================

final class MantaVoiceRecordingUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private let pairCode = ProcessInfo.processInfo.environment["MANTA_PAIR_CODE"] ?? "123456"
    private let pairServer = ProcessInfo.processInfo.environment["MANTA_PAIR_SERVER"] ?? "http://127.0.0.1:8787"

    func testVoiceRecordingHeldThenLocked() throws {
        let app = XCUIApplication()
        app.launch()

        pairIfNeeded(app)
        openChatRow(app)

        let mic = app.buttons["mic-button"]
        XCTAssertTrue(mic.waitForExistence(timeout: 25), "mic button missing — is the mic available (Groq key)?")
        mic.tap()

        let held = app.descendants(matching: .any)["voice-recording-held"]
        XCTAssertTrue(held.waitForExistence(timeout: 5), "recording did not start — voice-recording-held missing")
        snap(app, marker: "REC-HELD", png: "bet1028-held.png")

        // Slide UP to lock.
        let start = held.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
        let end = held.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        start.press(forDuration: 0.2, thenDragTo: end)

        let locked = app.descendants(matching: .any)["voice-recording-locked"]
        XCTAssertTrue(locked.waitForExistence(timeout: 6), "slide up did not lock — voice-recording-locked missing")
        XCTAssertTrue(app.buttons["voice-discard"].exists, "locked bar missing voice-discard")
        XCTAssertTrue(app.buttons["voice-pause"].exists, "locked bar missing voice-pause")
        XCTAssertTrue(app.buttons["voice-send"].exists, "locked bar missing voice-send")
        snap(app, marker: "REC-LOCKED", png: "bet1028-locked.png")
    }

    // MARK: - Pairing (idempotent)

    private func pairIfNeeded(_ app: XCUIApplication) {
        let otp = app.textFields["onboarding-otp"]
        guard otp.waitForExistence(timeout: 3) else { return }
        otp.tap()
        otp.typeText(pairCode)

        let advanced = app.buttons["My box isn't reachable from the internet"]
        if advanced.exists { advanced.tap() }
        let serverField = app.textFields["onboarding-server-url"]
        XCTAssertTrue(serverField.waitForExistence(timeout: 5), "server URL field never appeared")
        serverField.tap()
        serverField.typeText(pairServer)

        app.buttons["Continue"].firstMatch.tap()

        let notifications = app.staticTexts["Know when it needs you"]
        let failure = app.staticTexts["onboarding-failure-subtitle"]
        let deadline = Date().addingTimeInterval(45)
        while Date() < deadline, !notifications.exists, !failure.exists {
            usleep(300_000)
        }
        XCTAssertFalse(failure.exists, "pairing failed")
        XCTAssertTrue(notifications.exists, "notifications primer never appeared after claim")
        app.buttons["Continue"].firstMatch.tap()

        answerAlertIfPresent()
        app.terminate()
        app.launch()
    }

    private func openChatRow(_ app: XCUIApplication) {
        XCTAssertTrue(app.staticTexts["Sessions"].waitForExistence(timeout: 20), "session list never appeared")
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH 'Chat'"))
            .firstMatch
        if row.waitForExistence(timeout: 10) {
            row.tap()
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.30)).tap()
        }
        XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 30), "chat did not open to a composer")
    }

    /// Writes a settled PNG and prints the accessibility tree between markers.
    private func snap(_ app: XCUIApplication, marker: String, png: String) {
        let shot = XCUIScreen.main.screenshot()
        let out = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(png)
        try? shot.pngRepresentation.write(to: out)
        print("BET1028SHOT marker=\(marker) path=\(out.path)")
        print("AX-TREE-BEGIN \(marker)")
        print(app.debugDescription)
        print("AX-TREE-END \(marker)")
    }

    private func answerAlertIfPresent() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        // Mic permission — grant the first time it appears.
        for label in ["Allow", "OK", "Don't Allow"] {
            let button = springboard.buttons[label]
            if button.waitForExistence(timeout: 2) {
                button.tap()
                return
            }
        }
    }
}
