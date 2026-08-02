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
        // elects the scene at launch (via the app's UserDefaults); the parent
        // transcript has the first full-bleed user band as its stable element
        // and the child drill-in has its `subagent · running 1m12s` subtitle.
        // One of the two must appear; the other belongs to the other scene.
        let subtitle = app.staticTexts["subagent · running 1m12s"]
        let userBand = app.staticTexts["check bet-520 and see if it's blocked correctly"]
        let appeared = subtitle.waitForExistence(timeout: 4) || userBand.waitForExistence(timeout: 12)
        XCTAssertTrue(appeared, "neither the parent user band nor the child subtitle appeared")

        print("AX-TREE-BEGIN")
        print(app.debugDescription)
        print("AX-TREE-END")
    }
}
