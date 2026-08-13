import XCTest

// S8 (BET-600): a pairing link opens the app. This exercises the app-side of
// the custom-scheme / universal-link entry: the system hands the app the URL
// and onOpenURL routes it into the S2 onboarding flow (the pairing code is the
// secret — no confirm step). A stray `verify` param is ignored. Deterministic
// gate: only runs on a fresh-install (unpaired) launch — a device that is
// already paired skips, since a pairing link is consumed by onboarding.
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
}
