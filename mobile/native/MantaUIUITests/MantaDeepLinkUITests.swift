import XCTest

// S8 (BET-600) + BET-702: a pairing link opens the app. This exercises the
// app-side of the custom-scheme / universal-link entry: the system hands the
// app the URL and onOpenURL routes it into the pairing machinery.
//
// Two regimes (BET-702):
//   • UNPAIRED launch — the link routes into the S2 onboarding flow and claims
//     directly (the pairing code is the secret — no confirm step). A stray
//     `verify` param is ignored.
//   • PAIRED launch — the link is a re-pair onto a different box and must
//     present the "Switch box?" confirmation sheet (the old dead behavior was
//     to silently ignore it because the onboarding root wasn't mounted).
final class MantaDeepLinkUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testPairingLinkRoutesIntoOnboarding() throws {
        let app = XCUIApplication()
        app.launch()

        // Fresh-install onboarding entry gate; skip when already paired.
        let entry = app.scrollViews["onboarding-root"]
        guard entry.waitForExistence(timeout: 4) else {
            throw XCTSkip("device already paired — onboarding is not reachable")
        }

        // Old desktop QRs still carry a `verify` param — it must be ignored.
        let url = URL(string: "manta://pair?box=0123abcd0123abcd0123abcd0123abcd&code=123456&verify=K7Q2")!
        XCUIDevice.shared.system.open(url)

        // The link is consumed by claiming directly. Because the derived
        // host here (an unregistered boxes.mantaui.com) is unreachable, the
        // linking screen is transient and the stable outcome is the failure
        // card. Accept either so the assertion is not timing-coupled to the
        // auto-advancing linking frame.
        let linking = app.staticTexts["Linking"]
        let failure = app.staticTexts["onboarding-failure-subtitle"]
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline, !linking.exists, !failure.exists {
            usleep(200_000)
        }
        XCTAssertTrue(linking.exists || failure.exists,
                      "pairing link was not routed into the onboarding flow")
        if failure.exists {
            print("PAIR-LINK consumed: unreachable host — \(failure.label)")
        }
    }

    // BET-702: a pairing link while PAIRED must surface the "Switch box?" sheet
    // instead of being silently dropped. `MANTA_UI_FORCE_PAIRED` boots the app
    // into the paired destination without writing the real Keychain, so this
    // works on a fresh simulator without polluting it.
    func testPairLinkWhilePairedPresentsSwitchBox() throws {
        let app = XCUIApplication()
        app.launchEnvironment["MANTA_UI_FORCE_PAIRED"] = "1"
        app.launchEnvironment["MANTA_UI_PAIR_HOST"] = "https://currentbox.boxes.mantaui.com"
        app.launch()

        // Wait for the paired destination to appear before delivering the link.
        let sessions = app.staticTexts["Sessions"]
        _ = sessions.waitForExistence(timeout: 8)

        let newBox = "0123abcd0123abcd0123abcd0123abcd"
        let url = URL(string: "manta://pair?box=\(newBox)&code=123456")!
        XCUIDevice.shared.system.open(url)

        // The "Switch box?" sheet must present with both the current and the
        // new box host.
        let title = app.staticTexts["Switch box?"]
        XCTAssertTrue(title.waitForExistence(timeout: 5),
                      "a paired device did not present the Switch box sheet for an incoming pair link")

        let currentRow = app.descendants(matching: .any)["switch-box-current"].firstMatch
        let newRow = app.descendants(matching: .any)["switch-box-new"].firstMatch
        XCTAssertTrue(currentRow.exists, "Switch box sheet is missing the current box host")
        XCTAssertTrue(newRow.exists, "Switch box sheet is missing the new box host")
        XCTAssertTrue(newRow.label.contains(newBox), "new box row does not carry the new box id")
        print("SWITCH-BOX current=\(currentRow.label) new=\(newRow.label)")

        // Cancel must dismiss the sheet and leave the app paired.
        app.buttons["Cancel"].firstMatch.tap()
        XCTAssertFalse(title.waitForExistence(timeout: 2), "Cancel did not dismiss the Switch box sheet")
    }
}
