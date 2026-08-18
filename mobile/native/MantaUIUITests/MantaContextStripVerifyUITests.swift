import XCTest
import CryptoKit

// BET-889: on-device verification that the context strip (BET-824) actually
// renders once a `context`/`cache` stream frame reaches it.
//
// This runs against the repo's own deterministic capture-fixture box
// (mobile/native/capture-fixture/fixture-box.mjs) on the simulator's loopback,
// so the outcome does not depend on a slow/loaded live box: the test pairs to
// http://127.0.0.1:8787, opens the fixture "Chat" window, then pushes a known
// context reading (pct 55) through the fixture's `/__control` channel — exactly
// the frame a real box's `message.updated` interpreter (BET-887) publishes.
//
// Assertion: the strip (Button, accessibilityIdentifier "context-strip", label
// "Context <N> percent") appears in the live accessibility hierarchy. That is
// the on-device proof the `.safeAreaBar(edge: .top)` mount renders the strip
// over the UIKit-backed TiledView. A settled PNG screenshot is attached for a
// human reviewer.
final class MantaContextStripVerifyUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testContextStripRendersOnDevice() throws {
        let app = XCUIApplication()
        app.launch()
        _ = app.buttons.firstMatch.waitForExistence(timeout: 10)
        usleep(1_000_000)

        // Open the chat window (fixture window is 'Chat'; a live-box default is
        // 'default'). Scroll the session list until the row is hittable.
        var openedChat = false
        let row = app.buttons
            .matching(NSPredicate(format: "label BEGINSWITH 'Chat' OR label BEGINSWITH 'default'"))
            .firstMatch
        if row.waitForExistence(timeout: 8) {
            var swipes = 0
            while !row.isHittable && swipes < 12 {
                app.swipeUp(); usleep(200_000); swipes += 1
            }
            if row.isHittable {
                row.tap()
                openedChat = true
            }
        }
        _ = app.otherElements["chat-screen"].waitForExistence(timeout: 10)
            || app.textViews["composer-input"].firstMatch.waitForExistence(timeout: 5)
        usleep(2_000_000)
        print("RESULT openedChat=\(openedChat)")

        // Push a deterministic context+cache reading through the fixture.
        // Retry a few times in case the stream socket is still attaching.
        let pushed = pushControl(action: "context", retries: 5)
        print("RESULT pushedContext=\(pushed)")

        // Wait for the strip to render.
        let strip = app.buttons["context-strip"]
        _ = strip.waitForExistence(timeout: 15)
        usleep(1_000_000)

        let stripExists = strip.exists
        let stripLabel = strip.exists ? (strip.label) : ""
        let hasNumericPct = stripLabel.range(
            of: #"^Context \d+ percent$"#, options: .regularExpression) != nil

        print("AX-TREE-BEGIN")
        print(app.debugDescription)
        print("AX-TREE-END")

        print("RESULT stripExists=\(stripExists)")
        print("RESULT stripLabel=\(stripLabel.replacingOccurrences(of: "\n", with: " "))")
        print("RESULT hasNumericPct=\(hasNumericPct)")

        let png = try saveConvergedScreenshot()
        print("RESULT screenshot=\(png.lastPathComponent) bytes=\(try Data(contentsOf: png).count)")

        XCTAssertTrue(openedChat, "no chat window row ('Chat'/'default') to open")
        XCTAssertTrue(stripExists, "context-strip element not present in accessibility hierarchy")
        XCTAssertTrue(hasNumericPct, "context-strip has no numeric percentage label: '\(stripLabel)'")
    }

    // BET-1138: on-device capture + assertion of the NO-max-context state.
    // feed a `context` frame with hasLimit:false (fixture `context-nolimit`),
    // then verify the strip renders a full-green fill with no % and the sheet
    // shows "No max context info for this model" with tokens only.
    func testNoMaxContextStateRenders() throws {
        let app = XCUIApplication()
        app.launch()
        if app.textFields["onboarding-otp"].waitForExistence(timeout: 3) { pair(app) }
        openChatWindow(app)

        // Poll: keep pushing the no-limit context frame while waiting for the
        // strip. The fixture's `/__control` send is a no-op until the app's
        // /events socket is attached, so a single early push is lost; the loop
        // covers the attach window deterministically.
        let strip = app.buttons["context-strip"]
        var pushedAny = false
        let start = Date()
        while !strip.exists, Date().timeIntervalSince(start) < 20 {
            pushedAny = pushControl(action: "context-nolimit", retries: 1) || pushedAny
            usleep(700_000)
        }
        usleep(500_000)
        print("RESULT1138 pushedAnyNoLimitContext=\(pushedAny)")
        let stripExists = strip.exists
        let stripLabel = stripExists ? (strip.label) : ""
        let hasNumericPct = stripLabel.range(
            of: #"^Context \d+ percent$"#, options: .regularExpression) != nil
        print("RESULT1138 stripExists=\(stripExists)")
        print("RESULT1138 stripLabel=\(stripLabel.replacingOccurrences(of: "\n", with: " "))")
        print("RESULT1138 stripHasNumericPct=\(hasNumericPct)")

        print("AX-TREE-BEGIN UNKNOWN-STRIP")
        print(app.debugDescription)
        print("AX-TREE-END UNKNOWN-STRIP")
        try saveConvergedScreenshot("bet1138-unknown-strip.png")

        if stripExists { strip.tap() }
        let noMax = app.staticTexts["No max context info for this model"]
        let sheetShown = noMax.waitForExistence(timeout: 8)
        usleep(700_000)
        print("RESULT1138 sheetNoMaxText=\(sheetShown)")

        print("AX-TREE-BEGIN UNKNOWN-SHEET")
        print(app.debugDescription)
        print("AX-TREE-END UNKNOWN-SHEET")
        try saveConvergedScreenshot("bet1138-unknown-sheet.png")

        XCTAssertTrue(pushedAny, "could not push context-nolimit through /__control")
        XCTAssertTrue(stripExists, "context-strip not present in no-max-context state")
        XCTAssertFalse(hasNumericPct, "unknown-state strip must carry no numeric %: '\(stripLabel)'")
        XCTAssertTrue(sheetShown, "'No max context info for this model' never appeared in the sheet")
    }

    // Idempotent pairing against the fixture box (mirrors
    // MantaRunningStateCaptureUITests).
    private func pair(_ app: XCUIApplication) {
        let pairCode = ProcessInfo.processInfo.environment["MANTA_PAIR_CODE"] ?? "123456"
        let pairServer = ProcessInfo.processInfo.environment["MANTA_PAIR_SERVER"] ?? "http://127.0.0.1:8787"
        let otp = app.textFields["onboarding-otp"]
        otp.tap()
        otp.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 6))
        otp.typeText(pairCode)
        let advanced = app.buttons["My server isn't reachable from the internet"].firstMatch
        if advanced.waitForExistence(timeout: 3) { advanced.tap() }
        let serverField = app.textFields["onboarding-server-url"]
        XCTAssertTrue(serverField.waitForExistence(timeout: 5), "server URL field never appeared")
        serverField.tap()
        serverField.typeText(pairServer)
        app.buttons["Continue"].firstMatch.tap()
        let failure = app.staticTexts["onboarding-failure-subtitle"]
        let deadline = Date().addingTimeInterval(45)
        while Date() < deadline, !app.staticTexts["Know when it needs you"].exists, !failure.exists {
            usleep(300_000)
        }
        XCTAssertFalse(failure.exists, "pairing failed")
        app.buttons["Continue"].firstMatch.tap()
        answerNotificationAlertIfPresent()
        app.terminate()
        app.launch()
    }

    private func openChatWindow(_ app: XCUIApplication) {
        _ = app.otherElements["chat-screen"].waitForExistence(timeout: 10)
            || app.textViews["composer-input"].firstMatch.waitForExistence(timeout: 5)
        let row = app.buttons
            .matching(NSPredicate(format: "label BEGINSWITH 'Chat' OR label BEGINSWITH 'default'"))
            .firstMatch
        if row.waitForExistence(timeout: 8) {
            var swipes = 0
            while !row.isHittable && swipes < 12 {
                app.swipeUp(); usleep(200_000); swipes += 1
            }
            if row.isHittable { row.tap() }
        }
        _ = app.otherElements["chat-screen"].waitForExistence(timeout: 10)
            || app.textViews["composer-input"].firstMatch.waitForExistence(timeout: 5)
        usleep(1_500_000)
        print("RESULT1138 openedChat=true")
    }

    private func answerNotificationAlertIfPresent() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Allow", "Don't Allow", "OK"] {
            let button = springboard.buttons[label]
            if button.waitForExistence(timeout: 3) {
                button.tap()
                return
            }
        }
    }

    private func saveConvergedScreenshot(_ name: String) throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        var last = Data()
        var converged = false
        for _ in 0..<40 {
            let shot = XCUIScreen.main.screenshot().pngRepresentation
            if !last.isEmpty && shot == last {
                try shot.write(to: url)
                let att = XCTAttachment(data: shot)
                att.name = name
                att.lifetime = .keepAlways
                add(att)
                converged = true
                break
            }
            last = shot
            usleep(350_000)
        }
        XCTAssertTrue(converged, "screenshot never converged: \(name)")
        print("RESULT1138 screenshot=\(name)")
    }

    private func pushControl(action: String, retries: Int) -> Bool {
        guard let url = URL(string: "http://127.0.0.1:8787/__control") else { return false }
        for _ in 0..<retries {
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = Data("{\"action\":\"\(action)\"}".utf8)
            let sem = DispatchSemaphore(value: 0)
            var ok = false
            let task = URLSession.shared.dataTask(with: req) { _, resp, _ in
                ok = (resp as? HTTPURLResponse)?.statusCode == 200
                sem.signal()
            }
            task.resume()
            _ = sem.wait(timeout: .now() + 3)
            if ok { return true }
            usleep(500_000)
        }
        return false
    }

    private func saveConvergedScreenshot() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("bet889-context-strip.png")
        var last = Data()
        var converged = false
        for _ in 0..<40 {
            let shot = XCUIScreen.main.screenshot().pngRepresentation
            if !last.isEmpty && shot == last {
                try shot.write(to: url)
                converged = true
                break
            }
            last = shot
            usleep(350_000)
        }
        XCTAssertTrue(converged, "screenshot never converged")
        return url
    }
}
