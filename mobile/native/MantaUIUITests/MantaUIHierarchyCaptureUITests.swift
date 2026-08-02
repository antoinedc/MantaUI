import XCTest

// One purpose: dump the live accessibility element hierarchy of the running
// app as plain text so a capture is reproducible *and* auditable. This is the
// native analog of the web client's DOM accessibility-tree read — it is the
// geometry/text leg of the native visual-verification harness (the screenshot
// is the other leg, covering colour/typography/radius that the hierarchy
// cannot see).
//
// `XCUIApplication.debugDescription` is a single atomic snapshot (it cannot
// race with the renderer re-materialising rows mid-enumeration), so the dump
// is one consistent frame. The bounded AX-TREE-BEGIN / AX-TREE-END markers let
// the capture script extract exactly the tree from the xcodebuild log.
final class MantaUIHierarchyCaptureUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testDumpAccessibilityHierarchy() throws {
        let app = XCUIApplication()
        app.launch()

        // Wait on a REAL rendered state, never a fixed timer — a timeout would
        // trade a deterministic failure for an intermittent one. The harness
        // elects the scene at launch (via the app's UserDefaults); the stable
        // gate differs per scene family:
        //   • parent transcript  — the first full-bleed user band
        //   • child drill-in     — the `subagent · running 1m12s` subtitle
        //   • S2 joiner screens  — the `onboarding-root` container
        // One of the three must appear; the others belong to other scenes.
        let subtitle = app.staticTexts["subagent · running 1m12s"]
        let userBand = app.staticTexts["check bet-520 and see if it's blocked correctly"]
        let onboardingGate = app.scrollViews["onboarding-root"]
        let appeared = subtitle.waitForExistence(timeout: 4)
            || userBand.waitForExistence(timeout: 8)
            || onboardingGate.waitForExistence(timeout: 8)
        XCTAssertTrue(appeared, "no stable gate element appeared (transcript or onboarding)")

        print("AX-TREE-BEGIN")
        print(app.debugDescription)
        print("AX-TREE-END")
    }
}
