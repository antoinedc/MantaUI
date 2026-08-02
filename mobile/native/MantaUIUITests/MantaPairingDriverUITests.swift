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
        // Credentials reach the runner through a JSON drop at /tmp/manta-pair.json
        // INSIDE the simulator (the host writes it to the device's own
        // data/tmp). `xcodebuild`'s TEST_RUNNER_* env passthrough does NOT
        // reach a UI-test runner here — verified empty — so the file is the
        // supported channel, with the env kept as a fallback.
        let env = ProcessInfo.processInfo.environment
        var code = env["MANTA_PAIR_CODE"] ?? ""
        var server = env["MANTA_PAIR_SERVER"] ?? ""
        if code.isEmpty || server.isEmpty,
           let data = FileManager.default.contents(atPath: "/tmp/manta-pair.json"),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            code = json["code"] ?? code
            server = json["server"] ?? server
        }
        // The plugin's job log is head-capped, so the ONE thing that must
        // always be greppable is whether the credentials arrived.
        print("PAIRDRIVE input code-digits=\(code.count) server=\(server.isEmpty ? "MISSING" : server)")
        guard !code.isEmpty, !server.isEmpty else {
            throw XCTSkip("PAIRDRIVE SKIP: no pairing code/server (env and /tmp/manta-pair.json both empty)")
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
