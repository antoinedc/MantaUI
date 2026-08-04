import XCTest

// ===========================================================================
// BET-630 acceptance captures — the running-state working row and the ambient
// refetch sweep, on the native chat screen, driven to a REAL composer-bearing
// chat against the local capture-fixture box (127.0.0.1:8787).
//
// Two states, two captures:
//   1. Mid-turn — a prompt is sent so a turn runs; the row above the composer
//      (spinner + verb + live elapsed, e.g. "Cogitating… (5s)") is captured
//      while the turn is still in flight.
//   2. Refetch — with NO turn running, a background transcript sync is
//      triggered; the ambient accent hairline sweep on the composer's top
//      divider is captured, and the run asserts NO running row is present.
//
// Determinism: the fixture box owns the live stream. `start-turn` / `end-turn`
// / `baseline` on its /__control channel emit the interpreted stream frames a
// real box would, so the exact running / refetch transition is reproducible
// instead of gambling on real model output. `opencode:messages` is delayed by
// the fixture (FIXTURE_MSGS_DELAY_MS) so the `refreshing` window the sweep
// needs is wide enough to catch.
//
// Evidence: each capture writes a settled PNG to the runner's tmp container
// AND prints the live accessibility tree between markers, so both the visual
// leg and the diffable hierarchy survive the xcodebuild log (the plugin globs
// the PNG the same way MantaOverflowCaptureUITests does).
// ===========================================================================

final class MantaRunningStateCaptureUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private let pairCode = ProcessInfo.processInfo.environment["MANTA_PAIR_CODE"] ?? "123456"
    private let pairServer = ProcessInfo.processInfo.environment["MANTA_PAIR_SERVER"] ?? "http://127.0.0.1:8787"

    // MARK: - 1. Mid-turn running row

    func testCaptureMidTurnRunningRow() throws {
        let app = XCUIApplication()
        app.launch()

        pairIfNeeded(app)
        openChatRow(app)

        // Send a real prompt so a turn runs (composer echo sets running=true
        // and runningSince immediately; the fixture holds that state).
        let input = app.textViews["composer-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 20), "composer input missing")
        input.tap()
        input.typeText("Say the alphabet slowly, one letter per line.")
        let send = app.buttons["send-button"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "no send button")
        send.tap()
        print("MID630 sent=true")

        // Wait out the fixture's message delay so the canonical transcript
        // settles, then give the running row a few seconds of real elapsed.
        sleep(6)
        let indicator = app.descendants(matching: .any).matching(identifier: "running-indicator").firstMatch
        XCTAssertTrue(indicator.exists, "running-indicator missing — turn did not stay running")
        snap(app, marker: "MID-TURN", png: "bet630-mid-turn.png")

        // Second frame shortly after: the elapsed label must have ticked, which
        // is the "live" part of the acceptance.
        sleep(3)
        snap(app, marker: "MID-TURN-B", png: "bet630-mid-turn-b.png")
    }

    // MARK: - 2. Refetch sweep (no running turn)

    func testCaptureRefetchSweep() throws {
        let app = XCUIApplication()
        app.launch()

        pairIfNeeded(app)
        openChatRow(app)

        let send = app.buttons["send-button"]
        XCTAssertTrue(send.waitForExistence(timeout: 25), "no send button — chat did not finish loading")

        // NO turn is running. First arm the store's snapshot, then end a turn:
        // running=false + turnComplete triggers the canonical refetch, whose
        // messages RPC the fixture holds open — that is the `refreshing` window
        // the composer-hairline sweep lives in.
        post(action: "baseline")
        post(action: "end-turn")

        // The sweep is animating on the composer's top divider; capture inside
        // the refreshed window. The running row must NOT be present.
        usleep(700_000)
        let indicator = app.descendants(matching: .any).matching(identifier: "running-indicator").firstMatch
        XCTAssertFalse(indicator.exists, "running-indicator present during a non-running refetch — states collided")
        snap(app, marker: "REFETCH", png: "bet630-refetch.png")
        usleep(900_000)
        snap(app, marker: "REFETCH-B", png: "bet630-refetch-b.png")
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

        answerNotificationAlertIfPresent()
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
        // The chat shows ONLY a loader during its initial (delayed) load, so
        // wait for the composer's send button before proceeding.
        XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 30), "chat did not open to a composer")
    }

    /// POST to the fixture box's /__control channel to emit a stream frame.
    private func post(action: String) {
        let sema = DispatchSemaphore(value: 0)
        var request = URLRequest(url: URL(string: "\(pairServer)/__control")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["action": action])
        URLSession.shared.dataTask(with: request) { _, _, _ in sema.signal() }.resume()
        _ = sema.wait(timeout: .now() + 5)
        print("MID630 control=\(action)")
    }

    /// Writes a settled PNG and prints the accessibility tree between markers.
    private func snap(_ app: XCUIApplication, marker: String, png: String) {
        let shot = XCUIScreen.main.screenshot()
        let out = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(png)
        try? shot.pngRepresentation.write(to: out)
        print("MID630SHOT marker=\(marker) path=\(out.path)")
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
                return
            }
        }
    }
}
