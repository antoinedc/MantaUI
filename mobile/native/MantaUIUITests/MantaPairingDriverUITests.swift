import XCTest

// Drives the S2 onboarding joiner end-to-end against a REAL box, so pairing
// can be exercised from CI or from a plugin run without a human typing into
// the Simulator. The app registers no URL scheme, so `simctl openurl` cannot
// deliver a pair payload — the only faithful path is the one a user takes:
// type the six digits, reveal the advanced server field, submit.
//
// Skipped unless BOTH env vars are present, so an ordinary test run (which
// has no live box and no unexpired code) is unaffected:
//
//   MANTA_PAIR_CODE   six digits from `curl 127.0.0.1:8787/auth/pair` ON the box
//   MANTA_PAIR_SERVER https://<box_id>.boxes.mantaui.com
//
// xcodebuild forwards `TEST_RUNNER_MANTA_PAIR_CODE=…` to the runner process
// with the prefix stripped, which is how a plugin supplies them.
final class MantaPairingDriverUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testPairAgainstLiveBox() throws {
        // Credentials reach the runner through MantaPairFixture, which the driver
        // plugin overwrites immediately before `xcodebuild test`. A UI test cannot
        // read the host filesystem, and TEST_RUNNER_* env passthrough does NOT
        // reach the runner on this toolchain (verified empty), so the compiler is
        // the channel; env is kept as a fallback.
        let env = ProcessInfo.processInfo.environment
        var code = env["MANTA_PAIR_CODE"] ?? ""
        var server = env["MANTA_PAIR_SERVER"] ?? ""
        if code.isEmpty { code = MantaPairFixture.code }
        if server.isEmpty { server = MantaPairFixture.server }
        // The plugin's job log is head-capped, so the ONE thing that must
        // always be greppable is whether the credentials arrived.
        print("PAIRDRIVE input code-digits=\(code.count) server=\(server.isEmpty ? "MISSING" : server)")
        guard !code.isEmpty, !server.isEmpty else {
            throw XCTSkip("PAIRDRIVE SKIP: no pairing code/server (MantaPairFixture is empty and no env override)")
        }

        let app = XCUIApplication()
        app.launch()

        // Entry screen. A previously-paired install would boot straight into
        // the session list, so a missing OTP field is a real signal (stale
        // Keychain credentials) rather than a timing flake.
        let otp = app.textFields["onboarding-otp"]
        XCTAssertTrue(otp.waitForExistence(timeout: 15),
                      "onboarding entry screen never appeared — is the app already paired?")
        otp.tap()
        otp.typeText(code)

        // The six-digit code alone cannot address a box; the claim target is
        // the server URL behind the advanced disclosure.
        let advanced = app.buttons["My box isn't reachable from the internet"]
        if advanced.waitForExistence(timeout: 3) { advanced.tap() }
        let serverField = app.textFields["onboarding-server-url"]
        XCTAssertTrue(serverField.waitForExistence(timeout: 5), "server URL field never appeared")
        serverField.tap()
        serverField.typeText(server)

        app.buttons["Continue"].firstMatch.tap()

        // Success lands on the notifications primer; every failure kind lands
        // on the failure card. Wait on both so a failed claim reports what the
        // user would actually see instead of timing out anonymously.
        let notifications = app.staticTexts["Know when it needs you"]
        let failure = app.staticTexts["onboarding-failure-subtitle"]
        let deadline = Date().addingTimeInterval(45)
        while Date() < deadline, !notifications.exists, !failure.exists {
            usleep(300_000)
        }
        if failure.exists {
            print("PAIRDRIVE FAIL \(failure.label)")
            XCTFail("pairing failed: \(failure.label)")
            return
        }
        XCTAssertTrue(notifications.exists, "neither the notifications primer nor a failure card appeared")

        app.buttons["Continue"].firstMatch.tap()
        print("PAIRDRIVE PAIRED")

        print("AX-TREE-BEGIN")
        print(app.debugDescription)
        print("AX-TREE-END")
    }
}

// Answering the system notification alert is not something `simctl` can do
// (`simctl privacy` has no notifications service), and the alert re-presents
// on every launch until it is answered — which obscures every screenshot taken
// after pairing. Springboard is an ordinary accessibility target, so tapping it
// from a UI test is the deterministic way to clear it.
final class MantaSystemAlertUITests: XCTestCase {

    func testAnswerNotificationAlert() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Allow", "Don't Allow", "OK"] {
            let button = springboard.buttons[label]
            if button.waitForExistence(timeout: 3) {
                button.tap()
                print("PAIRDRIVE alert-answered=\(label)")
                return
            }
        }
        print("PAIRDRIVE alert-answered=none")
    }
}

// Opens the first session row so the screenshot after this run shows the
// terminal/chat screen rather than the list — i.e. it exercises the box
// connection past the session list (websocket attach for a TUI window).
final class MantaOpenSessionUITests: XCTestCase {

    func testOpenFirstSession() {
        let app = XCUIApplication()
        app.launch()
        // The rows combine their children for accessibility, so they are not
        // reliably queryable as buttons; a normalized coordinate tap lands on
        // the first row under the "Sessions" title regardless of element type.
        _ = app.staticTexts["Sessions"].waitForExistence(timeout: 15)
        // MANTA_OPEN_ROW names the row to open; empty falls back to the first
        // row by coordinate. A named row matters because a chat-mode window
        // and a plain tmux window land on completely different screens.
        let wanted = ProcessInfo.processInfo.environment["MANTA_OPEN_ROW"] ?? MantaPairFixture.openRow
        let hops = wanted.split(separator: "|").map(String.init)
        if hops.isEmpty {
            print("PAIRDRIVE open-row=first-by-coordinate")
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.28)).tap()
        }
        // Each hop is one push (session row, then e.g. a subagent row), so a
        // drill-in can be driven end to end rather than only the first screen.
        for hop in hops {
            let target = app.staticTexts[hop]
            guard target.waitForExistence(timeout: 10) else {
                print("PAIRDRIVE open-miss=\(hop)")
                break
            }
            target.tap()
            print("PAIRDRIVE open-row=\(hop)")
            sleep(3)
        }
        sleep(6)
        // The runner tears the app down the moment the test ends, so a
        // host-side `simctl io screenshot` always catches Springboard instead.
        // Capture from inside the test and drop the PNG in the runner's own
        // container, which the driver plugin globs for on the host.
        let shot = XCUIScreen.main.screenshot()
        let out = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("manta-open-session.png")
        try? shot.pngRepresentation.write(to: out)
        print("PAIRDRIVE opened shot=\(out.path)")
    }
}
