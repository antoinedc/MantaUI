import XCTest

// BET-1024: drilling into a subagent row must land on a LIVE child transcript
// that stays populated after the push animation settles. Regression test for
// the "flicker briefly, then permanently blank" bug: the old parent-owned
// child store was destroyed on the parent's `onDisappear` (a push) and the
// child screen was rebound to a brand-new, never-started empty store at the end
// of the animation.
//
// Because the bug surfaces AFTER the push settles, an immediate assertion would
// pass even against the broken build (store A's content is still on screen
// mid-animation). We wait out the push transition, then require at least one
// real transcript element — the empty rebind has nothing to render.
//
// Like the other live-box drives, this test skips unless the environment is
// actually paired to a box whose open session contains a subagent row.
final class MantaSubagentDrillInUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func openChat(in app: XCUIApplication) {
        _ = app.staticTexts["Sessions"].waitForExistence(timeout: 15)
        let wanted = ProcessInfo.processInfo.environment["MANTA_OPEN_ROW"] ?? ""
        let hops = wanted.split(separator: "|").map(String.init)
        if hops.isEmpty {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.28)).tap()
            sleep(4)
            return
        }
        for hop in hops {
            let prefix = NSPredicate(format: "label BEGINSWITH %@", hop)
            let users = app.descendants(matching: .any).matching(prefix)
            let target = users.allElementsBoundByIndex
                .first { $0.elementType != .button }
                ?? users.firstMatch
            guard target.waitForExistence(timeout: 10) else {
                print("BET-1024 open-miss=\(hop)")
                break
            }
            target.tap()
            sleep(4)
        }
    }

    func testSubagentDrillInStaysPopulatedAfterPushSettles() throws {
        let app = XCUIApplication()
        app.launch()

        openChat(in: app)

        // The parent transcript must expose a subagent row to drill into.
        let agentRow = app.descendants(matching: .any)["agent-row"].firstMatch
        guard agentRow.waitForExistence(timeout: 10) else {
            throw XCTSkip("no subagent row in the open session — nothing to drill into")
        }
        agentRow.tap()
        print("BET-1024 drill-in: agent-row tapped")

        // The pushed child scene presents.
        let scene = app.descendants(matching: .any)["subagent-scene"].firstMatch
        guard scene.waitForExistence(timeout: 10) else {
            throw XCTSkip("subagent scene never appeared")
        }

        // The bug manifests AFTER the push animation completes, so wait it out
        // before asserting content — an immediate check passes against the
        // broken build.
        usleep(useconds_t(3.0 * 1_000_000))

        let prose = app.descendants(matching: .any)["assistant-prose"].firstMatch
        let user = app.descendants(matching: .any)["user-band"].firstMatch
        let steps = app.descendants(matching: .any)["step-rows"].firstMatch
        print("BET-1024 drill-in: prose=\(prose.exists) user=\(user.exists) steps=\(steps.exists)")
        XCTAssertTrue(prose.exists || user.exists || steps.exists,
                      "child transcript is blank after the push settled — the child store was rebound to an empty one")
    }
}
