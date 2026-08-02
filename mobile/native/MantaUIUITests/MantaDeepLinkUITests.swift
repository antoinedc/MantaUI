import XCTest

// S8 (BET-600): a pairing link opens the app. This exercises the app-side of
// the custom-scheme / universal-link entry: the system hands the app the URL
// and onOpenURL routes it into the S2 onboarding flow's confirm phase (§6.2).
// Deterministic gate: only runs on a fresh-install (unpaired) launch — a device
// that is already paired skips, since a pairing link is consumed by onboarding.
final class MantaDeepLinkUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testPairingLinkRoutesToConfirmScreen() throws {
        let app = XCUIApplication()
        app.launch()

        // Fresh-install onboarding entry gate; skip when already paired.
        let entry = app.scrollViews["onboarding-root"]
        guard entry.waitForExistence(timeout: 4) else {
            throw XCTSkip("device already paired — onboarding confirm is not reachable")
        }

        let url = URL(string: "manta://pair?box=0123abcd0123abcd0123abcd0123abcd&code=123456&verify=K7Q2")!
        XCUIDevice.shared.system.open(url)

        let heading = app.staticTexts["Link this phone?"]
        XCTAssertTrue(heading.waitForExistence(timeout: 8),
                      "pairing link did not open the confirm screen")
    }
}
