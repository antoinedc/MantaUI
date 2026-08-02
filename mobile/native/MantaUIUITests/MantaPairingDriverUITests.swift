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
        let env = ProcessInfo.processInfo.environment
        guard let code = env["MANTA_PAIR_CODE"], !code.isEmpty,
              let server = env["MANTA_PAIR_SERVER"], !server.isEmpty
        else {
            throw XCTSkip("MANTA_PAIR_CODE / MANTA_PAIR_SERVER not set — live pairing drive skipped")
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
            XCTFail("pairing failed: \(failure.label)")
            return
        }
        XCTAssertTrue(notifications.exists, "neither the notifications primer nor a failure card appeared")

        app.buttons["Continue"].firstMatch.tap()

        print("AX-TREE-BEGIN")
        print(app.debugDescription)
        print("AX-TREE-END")
    }
}
