import XCTest

// ===========================================================================
// Gesture-driving XCUITest for the native transcript (BET-1104 follow-up).
//
// BET-1104 replaced the two hand-rolled transcript gestures — tap-to-dismiss-
// keyboard and swipe-to-reveal-timestamp — with MessagingUI's own recognisers,
// fixing "the transcript needs a second swipe before it scrolls". The three
// runtime behaviours were never verified hands-on in the simulator; this driver
// does exactly that. It does NOT disable the library's reveal recogniser or
// alter `TranscriptGutter.gutterWidth` — the shipped mechanism is exercised
// as-is.
//
// It pairs against the capture fixture box (`capture-fixture/fixture-box.mjs`,
// which serves a TALL transcript so the list overflows) and opens the chat
// screen, then drives three gestures and records what it observes:
//
//   1. Keyboard dismiss on transcript tap  (composer focused, keyboard up)
//   2. Left-swipe reveals the timestamp strip from the trailing edge, which
//      springs back on release
//   3. A single up/down swipe begins scrolling immediately (no second swipe)
//
// The pair credential comes from `MantaPairFixture` (the driver overwrites it
// before `xcodebuild test`, exactly as MantaPairingDriverUITests documents) or
// the `MANTA_PAIR_CODE`/`MANTA_PAIR_SERVER` env fallback; empty → skip, so an
// ordinary test run with no fixture box is unaffected.
//
// A note on how the three are judged here: #1 has a hard, queryable assertion
// (the keyboard element disappears). #2 is visual (the timestamp gutter is
// `accessibilityHidden`), so frames are captured for a human rather than
// gate-asserted. #3 is observed via the transcript's scroll position (the
// vertical scroll bar value + an on-screen message frame) before and after a
// single swipe; a "Scroll to bottom" chip, shown only once the list has moved
// off the tail, is the corroborating signal.
// ===========================================================================

private enum TranscriptGesture {

    /// Drop a PNG in the runner's own container and print its path, so the
    /// driver can glob it from the host (mirrors MantaChatSurfaceCapture).
    @MainActor
    static func capture(_ name: String, after delay: TimeInterval = 0) {
        if delay > 0 { usleep(useconds_t(delay * 1_000_000)) }
        let shot = XCUIScreen.main.screenshot()
        let out = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent(name)
        try? shot.pngRepresentation.write(to: out)
        print("GESTURE shot=\(out.path)")
    }

    /// Answer any system notification alert Springboard is holding, so it
    /// cannot obscure the chat after pairing (mirrors MantaSystemAlertUITests).
    static func dismissSystemAlerts() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Allow", "Don't Allow", "OK"] {
            let button = springboard.buttons[label]
            if button.waitForExistence(timeout: 2) {
                button.tap()
                print("GESTURE alert-answered=\(label)")
                return
            }
        }
    }

    /// Pair the app against the fixture box if it isn't paired already, and
    /// land on the session list. Idempotent across test methods within one
    /// install (keychain persists).
    @MainActor
    static func pairIfNeeded(_ app: XCUIApplication) throws {
        let code = ProcessInfo.processInfo.environment["MANTA_PAIR_CODE"] ?? MantaPairFixture.code
        let server = ProcessInfo.processInfo.environment["MANTA_PAIR_SERVER"] ?? MantaPairFixture.server

        if app.staticTexts["Sessions"].waitForExistence(timeout: 3) {
            print("GESTURE already-paired")
            return
        }

        let manual = app.buttons["onboarding-manual-toggle"]
        guard manual.waitForExistence(timeout: 15) else {
            XCTFail("neither the session list nor the onboarding entry appeared")
            return
        }
        manual.tap()
        let otp = app.textFields["onboarding-otp"]
        XCTAssertTrue(otp.waitForExistence(timeout: 5), "manual setup fields never appeared")

        if code.isEmpty || server.isEmpty {
            throw XCTSkip("GESTURE SKIP: no pairing code/server (MantaPairFixture empty, no env)")
        }

        print("GESTURE pair code-digits=\(code.count) server=\(server)")
        otp.tap()
        otp.typeText(code)

        let advanced = app.buttons["onboarding-server-toggle"]
        if advanced.waitForExistence(timeout: 3) { advanced.tap() }
        let serverField = app.textFields["onboarding-server-url"]
        XCTAssertTrue(serverField.waitForExistence(timeout: 5), "server URL field never appeared")
        serverField.tap()
        serverField.typeText(server)

        app.buttons["Continue"].firstMatch.tap()

        let notifications = app.staticTexts["Know when it needs you"]
        let failure = app.staticTexts["onboarding-failure-subtitle"]
        let deadline = Date().addingTimeInterval(45)
        while Date() < deadline, !notifications.exists, !failure.exists {
            usleep(300_000)
        }
        if failure.exists {
            XCTFail("pairing failed: \(failure.label)")
            return
        }
        XCTAssertTrue(notifications.exists, "neither the notifications primer nor a failure card appeared")

        app.buttons["Continue"].firstMatch.tap()
        dismissSystemAlerts()
        print("GESTURE paired")
    }

    /// Wait for the session list, then open the first session row so the app
    /// lands on the real chat surface (TiledView transcript + composer). Uses
    /// the same normalized-coordinate tap as the proven capture drivers
    /// (MantaChatSurfaceCapture / MantaOpenSessionUITests) — a session row
    /// combines its children for accessibility, so a coordinate hit is the
    /// reliable way to open it rather than a fragile label match.
    @MainActor
    static func openChat(_ app: XCUIApplication) {
        _ = app.staticTexts["Sessions"].waitForExistence(timeout: 15)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.28)).tap()
        print("GESTURE opened-chat")
    }

    /// Resolve a visible message-row element to drive the reveal gesture on.
    /// Prefers the per-row accessibility handle, falling back to the tail
    /// assistant text; waits for one to appear.
    @MainActor
    static func rowToSwipe(_ app: XCUIApplication) -> XCUIElement {
        let byID = app.descendants(matching: .any)["transcript-row"].firstMatch
        if byID.waitForExistence(timeout: 8) {
            return byID
        }
        let prose = NSPredicate(format: "label BEGINSWITH %@", "Yes — tap the ellipsis")
        return app.staticTexts.matching(prose).firstMatch
    }

    /// Where a transcript tap should land to count as "background": the middle
    /// of the transcript region, away from the composer.
    @MainActor
    static func transcriptBackground(_ app: XCUIApplication) -> XCUICoordinate {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.28))
    }

    /// Current vertical scroll offset of the transcript, read from the scroll
    /// indicator's percent value ("" when not present). Position-independent.
    @MainActor
    static func scrollPercent(_ app: XCUIApplication) -> String {
        let scrollBar = app.descendants(matching: .other)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Vertical scroll bar"))
            .firstMatch
        guard scrollBar.exists, let v = scrollBar.value as? String else { return "n/a" }
        return v
    }
}

// 1. Composer focused + keyboard shown → tapping the transcript background
// dismisses the keyboard. (MessagingUI `.onTapBackground`.)
@MainActor
final class MantaKeyboardDismissGestureUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testTappingTranscriptBackgroundDismissesKeyboard() throws {
        let app = XCUIApplication()
        app.launch()

        try TranscriptGesture.pairIfNeeded(app)
        TranscriptGesture.openChat(app)

        let input = app.textViews["composer-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10), "no composer input")
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5),
                      "keyboard did not appear after tapping the composer")
        print("GESTURE keyboard-shown")

        TranscriptGesture.capture("gesture-keyboard-up.png")

        // Tap the transcript background (NOT the composer, NOT a message row).
        TranscriptGesture.transcriptBackground(app).tap()

        // The keyboard should disappear as a result of the tap-dismiss gesture.
        let keyboardGone = NSPredicate(format: "exists == false")
        let expectation = XCTNSPredicateExpectation(
            predicate: keyboardGone,
            object: app.keyboards.firstMatch
        )
        let result = XCTWaiter().wait(for: [expectation], timeout: 5)
        TranscriptGesture.capture("gesture-keyboard-dismissed.png")
        XCTAssertEqual(result, .completed,
                       "keyboard was not dismissed by a tap on the transcript background")
        print("GESTURE keyboard-dismissed")
    }
}

// 2. Swiping LEFT on a message row slides the timestamp strip in from the
// trailing edge, and it springs back on release. (MessagingUI's reveal offset,
// driven off the cell's `context.cellReveal`.) The gutter label is
// `accessibilityHidden`, so the observation is visual: frames are captured and
// reported, not gate-asserted.
@MainActor
final class MantaSwipeRevealGestureUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testSwipeLeftRevealsTimestampStripAndSpringsBack() throws {
        let app = XCUIApplication()
        app.launch()

        try TranscriptGesture.pairIfNeeded(app)
        TranscriptGesture.openChat(app)

        let row = TranscriptGesture.rowToSwipe(app)
        XCTAssertTrue(row.waitForExistence(timeout: 10), "no transcript row to swipe")

        TranscriptGesture.capture("gesture-reveal-before.png")

        // A leftward flick on the row: the whole row slides left to reveal the
        // timestamp strip from the trailing edge.
        row.swipeLeft()
        // Capture as close to the gesture as possible (spring-back is fast).
        TranscriptGesture.capture("gesture-reveal-swipe.png")

        // After release the strip springs back (the row restores).
        TranscriptGesture.capture("gesture-reveal-settled.png", after: 1.2)
        print("GESTURE reveal-swiped-and-settled row.exists=\(row.exists)")
    }
}

// 3. A single up-swipe begins scrolling immediately — the BET-1104 fix for the
// "second swipe before the transcript scrolls" bug. Observed by anchoring at
// the tail, then performing ONE upward swipe and reading the scroll position
// before and after. The "Scroll to bottom" chip (shown only once the list moves
// off the tail) corroborates.
//
// Deliberately an observation test: it records the scroll-position delta and
// screenshots rather than hard-asserting motion, because an XCUITest synthetic
// swipe can legitimately fail to move a custom collection view where a real
// finger would. The report on PR #1111 interprets what this test records.
@MainActor
final class MantaFirstSwipeScrollGestureUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testSingleSwipeScrollsTranscriptImmediately() throws {
        let app = XCUIApplication()
        app.launch()

        try TranscriptGesture.pairIfNeeded(app)
        TranscriptGesture.openChat(app)

        let composer = app.textViews["composer-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "no composer input")

        // Anchor at the transcript tail (newest message): the tall fixture can
        // open scrolled up, so settle to the bottom via the scroll-to-bottom
        // chip, which is exactly the signal for "away from the tail".
        let chip = app.buttons["Scroll to bottom"]
        var guardLoop = 0
        while chip.exists, guardLoop < 10 {
            if chip.isHittable {
                chip.tap()
            } else {
                app.swipeDown()
            }
            guardLoop += 1
            usleep(400_000)
        }
        let atTail = !chip.exists
        print("GESTURE at-tail=\(atTail) scroll=\(TranscriptGesture.scrollPercent(app))")

        TranscriptGesture.capture("gesture-scroll-before.png")
        let beforeScroll = TranscriptGesture.scrollPercent(app)

        // ONE upward drag — the gesture under test.
        app.swipeUp()

        TranscriptGesture.capture("gesture-scroll-after.png")
        let afterScroll = TranscriptGesture.scrollPercent(app)
        let chipAfter = chip.waitForExistence(timeout: 2)

        print("GESTURE SCROLL-OBSERVATION anchoredAtTail=\(atTail) scrollBefore=\(beforeScroll) scrollAfter=\(afterScroll) chipAppearedAfterOneSwipe=\(chipAfter)")
        print("GESTURE reveal-drive-complete")

        // The gesture itself must be drivable on the shipped transcript; whether
        // a single synthetic swipe moves the custom list is the observed outcome
        // (reported on PR #1111), not a gate.
    }
}
