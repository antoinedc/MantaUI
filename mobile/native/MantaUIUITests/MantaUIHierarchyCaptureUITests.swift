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
        // trade a deterministic failure for an intermittent one. S4a's spec
        // fixture renders the transcript; the first full-bleed user band is its
        // stable first element, so gate on that rather than the retired title.
        let userBand = app.staticTexts["check bet-520 and see if it's blocked correctly"]
        XCTAssertTrue(userBand.waitForExistence(timeout: 15), "transcript user band did not appear")

        print("AX-TREE-BEGIN")
        print(app.debugDescription)
        print("AX-TREE-END")
    }
}
