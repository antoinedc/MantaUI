import XCTest

// One purpose: dump the live accessibility element hierarchy of the session-list
// screen so a capture is reproducible *and* auditable as text. The dump is the
// "Layer 1 structure" equivalent for the native app — it is what a later
// measurement layer will read geometry/type/colour out of. Launching the app and
// waiting on a real rendered element (the "Sessions" large title) means the dump
// reflects the settled layout, not a transient frame.
final class HierarchyDumpUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testDumpSessionListAccessibilityHierarchy() throws {
        let app = XCUIApplication()
        app.launch()

        // Wait on a real rendered state (a plain waitForTimeout would trade a
        // deterministic failure for an intermittent one).
        let navBar = app.navigationBars["Sessions"]
        XCTAssertTrue(navBar.waitForExistence(timeout: 10), "session list nav bar did not appear")

        let tree = app.debugDescription
        // Bounded delimiters so the capture script can extract exactly the dump.
        print("AX-TREE-BEGIN")
        print(tree)
        print("AX-TREE-END")
    }
}