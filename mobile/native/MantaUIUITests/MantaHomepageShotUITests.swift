import XCTest

// ===========================================================================
// Marketing-capture driver (BET-931): open one named session row and capture
// the SETTLED chat screen at native resolution, for compositing into Apple's
// iPhone Product Bezel on the website.
//
// Why it is not one of the BET-625 drivers: `MantaLoadCaptureUITests` captures
// 0.3s after the tap (that is its point — the loading skeleton), which lands
// before the composer's model pill and context dial have resolved, and
// `MantaMidTurnCaptureUITests` types its own prompt into the transcript. A
// marketing shot needs the opposite of both: no injected text, and everything
// finished rendering.
//
// The transcript content comes from the box — seed the session before running
// this, then pass the row label through MantaPairFixture.openRow.
// ===========================================================================

final class MantaHomepageShotUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testCaptureSettledChat() throws {
        let app = XCUIApplication()
        app.launch()

        _ = app.staticTexts["Sessions"].waitForExistence(timeout: 20)

        let wanted = ProcessInfo.processInfo.environment["MANTA_OPEN_ROW"] ?? MantaPairFixture.openRow
        let hops = wanted.split(separator: "|").map(String.init)
        if hops.isEmpty {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.28)).tap()
        }
        for hop in hops {
            let prefix = NSPredicate(format: "label BEGINSWITH %@", hop)
            let users = app.descendants(matching: .any).matching(prefix)
            let target = users.allElementsBoundByIndex
                .first { $0.elementType != .button }
                ?? users.firstMatch
            guard target.waitForExistence(timeout: 15) else {
                print("PAIRDRIVE open-miss=\(hop)")
                break
            }
            target.tap()
            print("PAIRDRIVE open-row=\(hop)")
        }

        // Let the transcript, the model pill and the context dial all resolve.
        // A marketing shot with a spinner where the model name belongs is the
        // failure this delay exists to avoid.
        sleep(12)

        let shot = XCUIScreen.main.screenshot()
        let out = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("manta-homepage.png")
        try? shot.pngRepresentation.write(to: out)
        print("PAIRDRIVE shot=\(out.path)")
    }
}
