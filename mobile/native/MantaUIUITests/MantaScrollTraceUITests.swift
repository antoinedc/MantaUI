import XCTest

/// BET-1211 trace capture against the REAL dev box. Baselines the parent, then
/// opens the "Map iOS transcript rendering" subagent child, swiping each while
/// the os_log `[scroll]` probe (off/content/visible) records parent/child.
final class MantaScrollTraceUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testReverseScrollTrace() throws {
        let app = XCUIApplication()
        app.launch()
        pairIfNeeded(app)

        // 1) Baseline: open the real parent session.
        _ = openParentChat(app)
        print("RESULT parent-ready"); usleep(1_000_000)
        swipePattern(app)
        print("RESULT parent-swiped"); usleep(500_000)

        // 2) Open the real child.
        _ = tapSubagentCard(app)
        let scene = app.otherElements["subagent-scene"]
        XCTAssertTrue(scene.waitForExistence(timeout: 25), "child scene never appeared")
        usleep(2_000_000)
        print("RESULT child-ready")
        swipePattern(app)
        print("RESULT child-swiped")
    }

    private func pairIfNeeded(_ app: XCUIApplication) {
        let otp = app.textFields["onboarding-otp"]
        guard otp.waitForExistence(timeout: 4) else { return }
        let srv = "https://3655737043030f5927b6c531f05ea650.boxes.mantaui.com"
        let code = ProcessInfo.processInfo.environment["MANTA_PAIR_CODE"] ?? ""
        otp.tap()
        otp.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 6))
        otp.typeText(code)
        let adv = app.buttons["My server isn't reachable from the internet"].firstMatch
        if adv.waitForExistence(timeout: 3) { adv.tap() }
        let sf = app.textFields["onboarding-server-url"]
        if sf.waitForExistence(timeout: 5) { sf.tap(); sf.typeText(srv) }
        app.buttons["Continue"].firstMatch.tap()
        let fail = app.staticTexts["onboarding-failure-subtitle"]
        let dl = Date().addingTimeInterval(60)
        while Date() < dl, !app.staticTexts["Know when it needs you"].exists, !fail.exists { usleep(300_000) }
        if !fail.exists { app.buttons["Continue"].firstMatch.tap(); answerNotifications() }
        usleep(3_000_000)
    }

    // Swipe on the app itself (avoids element-coordinate staleness): a slow
    // upward drag, a fast flick, then a downward drag back.
    private func swipePattern(_ app: XCUIApplication) {
        let w = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.82))
        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        w.press(forDuration: 0.3, thenDragTo: top)
        usleep(900_000)
        w.press(forDuration: 0.01, thenDragTo: top, withVelocity: .fast, thenHoldForDuration: 0.01)
        usleep(900_000)
        let bot = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9))
        top.press(forDuration: 0.3, thenDragTo: bot)
        usleep(900_000)
    }

    @discardableResult
    private func openParentChat(_ app: XCUIApplication) -> XCUIElement {
        let composer = app.textViews["composer-input"].firstMatch
        _ = composer.waitForExistence(timeout: 15)
        if !composer.exists {
            // Session list → find the real session window.
            let row = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Native iOS UI polish'")).firstMatch
            if row.waitForExistence(timeout: 15) {
                var s = 0; while !row.isHittable && s < 12 { app.swipeUp(); usleep(250_000); s += 1 }
                if row.isHittable { row.tap() }
                _ = composer.waitForExistence(timeout: 15)
                usleep(2_000_000)
            }
        }
        return composer
    }

    @discardableResult
    private func tapSubagentCard(_ app: XCUIApplication) -> XCUIElement {
        var sc = 0
        let probe = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Map iOS transcript rendering'")).firstMatch
        while !probe.exists && sc < 60 { app.swipeDown(); usleep(300_000); sc += 1 }
        let e = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Map iOS transcript rendering'")).firstMatch
        XCTAssertTrue(e.waitForExistence(timeout: 12), "subagent card never found")
        var h = 0; while !e.isHittable && h < 40 { app.swipeDown(); usleep(250_000); h += 1 }
        XCTAssertTrue(e.isHittable, "card not hittable")
        e.tap()
        return e
    }

    private func answerNotifications() {
        let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for l in ["Allow", "Don't Allow", "OK"] { let b = sb.buttons[l]; if b.waitForExistence(timeout: 3) { b.tap(); return } }
    }
}
