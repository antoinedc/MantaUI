import XCTest

// BET-1211 fixture-driven diagnostic (author: macos). Against the subagent
// fixture box (FIXTURE_SUBAGENT=1), open the parent chat, drill into the child
// subagent screen, and record whether the CHILD transcript scrolls under a
// synthetic swipe (with the PARENT as control).
//
// NOTE (verified 2026-08-20): synthetic XCUITest swipes do NOT move this custom
// TiledView at all — the parent (which scrolls by hand) also does not move
// under scrollView.swipeUp/app.swipeUp/press-drag. So this automated check can
// never be a pass/fail verdict for the scroll bug; the authoritative read is a
// HUMAN drag while `log stream --predicate 'eventMessage CONTAINS "[scroll]"'`
// runs. This file is kept as the fixture driver reference, not a gate.
final class MantaSubagentScrollDiagUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    @MainActor
    func testSubagentChildScrollDiag() throws {
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(app.staticTexts["Sessions"].waitForExistence(timeout: 20),
                      "no session list — is the app paired to the fixture box?")

        // Open the fixture chat (parent), drill into the child.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.28)).tap()
        usleep(4_000_000)

        let agentByLabel = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "fixture subagent"))
            .firstMatch
        let agentRow = app.descendants(matching: .any)["agent-row"].firstMatch
        let target = agentByLabel.exists ? agentByLabel : agentRow
        XCTAssertTrue(target.exists, "no subagent task row in the fixture parent chat")
        target.tap()
        print("DIAG child pushed")

        let scene = app.descendants(matching: .any)["subagent-scene"].firstMatch
        XCTAssertTrue(scene.waitForExistence(timeout: 10), "child scene never appeared")
        usleep(3_000_000)

        // Observe only; the verdict comes from a human drag + the [scroll] probe.
        let childBar = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Vertical scroll bar"))
            .firstMatch
        print("DIAG child-scene-present scrollBar=\(childBar.exists ? childBar.label : "absent")")
    }
}
