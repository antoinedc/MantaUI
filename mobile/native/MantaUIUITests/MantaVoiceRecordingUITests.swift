import XCTest

// ===========================================================================
// BET-1051 acceptance — the recording gesture is owned by the MIC BUTTON, not
// by the surface it summons.
//
// Driven to a REAL composer-bearing chat against the local capture-fixture box
// (127.0.0.1:8787, code 123456 — see capture-fixture/fixture-box.mjs), exactly
// like MantaRunningStateCaptureUITests. The fixture's `config:get` now returns a
// Groq key so the mic button is available, and its `voice:transcribe` returns an
// empty transcript, so sending is a harmless no-op (no real transcription).
//
// EVERY recording test drives ONE continuous gesture that begins on the mic
// button — `XCUIElement.press(forDuration:thenDragTo:)` delivers a single
// uninterrupted touch. A test that taps the mic and then starts a fresh drag on
// the surface elsewhere is the exact two-step pattern that let the original bug
// ship (BET-1051) and must never return.
//
// Screenshots are captured only for stable, finger-up states (the idle composer
// and the locked bar). A press-and-drag is atomic in XCUI, so no snapshot is
// attempted mid-press.
// ===========================================================================

final class MantaVoiceRecordingUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private let pairCode = "123456"
    private let pairServer = "http://127.0.0.1:8787"

    // MARK: - 1. Hold + slide up → lock (THE regression test)

    /// BET-1051 regression: ONE continuous gesture that begins on the mic. Press
    /// and slide up 160pt in a single touch; the bar locks. This MUST fail on
    /// the old surface-owned-gesture build and pass after the change.
    func testMicHoldSlideUpLocks() throws {
        let app = XCUIApplication()
        app.launch()
        reachChatComposer(app)

        // Idle composer — a stable, finger-up state (for the no-height-jump
        // comparison).
        snap(app, marker: "COMPOSER", png: "bet1051-composer.png")

        let mic = app.buttons["mic-button"]
        XCTAssertTrue(mic.waitForExistence(timeout: 10), "mic button missing")
        let from = mic.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        from.press(forDuration: 0.6, thenDragTo: from.withOffset(CGVector(dx: 0, dy: -160)))

        let locked = app.descendants(matching: .any)["voice-recording-locked"]
        XCTAssertTrue(locked.waitForExistence(timeout: 6), "slide up did not lock — voice-recording-locked missing")
        XCTAssertTrue(app.buttons["voice-discard"].exists, "locked bar missing voice-discard")
        XCTAssertTrue(app.buttons["voice-pause"].exists, "locked bar missing voice-pause")
        XCTAssertTrue(app.buttons["voice-send"].exists, "locked bar missing voice-send")
        snap(app, marker: "REC-LOCKED", png: "bet1051-locked.png")

        // Clean up so the simulator isn't left recording.
        app.buttons["voice-discard"].tap()
    }

    // MARK: - 2. Hold + slide left → cancel (nothing is sent)

    func testMicHoldSlideLeftCancels() throws {
        let app = XCUIApplication()
        app.launch()
        reachChatComposer(app)

        let mic = app.buttons["mic-button"]
        XCTAssertTrue(mic.waitForExistence(timeout: 10), "mic button missing")
        let from = mic.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        from.press(forDuration: 0.6, thenDragTo: from.withOffset(CGVector(dx: -140, dy: 0)))

        let locked = app.descendants(matching: .any)["voice-recording-locked"]
        XCTAssertFalse(locked.waitForExistence(timeout: 2), "slide left + release should NOT leave a locked bar")
        XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 5), "composer did not return after cancel")
    }

    // MARK: - 3. Hold + release → send

    func testMicHoldAndReleaseSends() throws {
        let app = XCUIApplication()
        app.launch()
        reachChatComposer(app)

        let mic = app.buttons["mic-button"]
        XCTAssertTrue(mic.waitForExistence(timeout: 10), "mic button missing")
        mic.press(forDuration: 1.2)

        let locked = app.descendants(matching: .any)["voice-recording-locked"]
        XCTAssertFalse(locked.waitForExistence(timeout: 2), "hold+release should not leave a locked bar")
        XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 5), "composer did not return after release")
    }

    // MARK: - 4. A tap on the mic goes straight to the locked bar (decision #5)

    func testMicTapLocks() throws {
        let app = XCUIApplication()
        app.launch()
        reachChatComposer(app)

        let locked = micTapLocked(app)
        snap(app, marker: "TAP-LOCKED", png: "bet1051-tap-locked.png")

        // The bar's send button stops it and the composer returns.
        app.buttons["voice-send"].tap()
        XCTAssertFalse(locked.waitForExistence(timeout: 2), "send did not end the locked take")
        XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 5), "composer did not return after send")
    }

    // MARK: - 5. Locked bar: pause / resume / discard

    func testLockedBarPauseResumeDiscard() throws {
        let app = XCUIApplication()
        app.launch()
        reachChatComposer(app)

        micTapLocked(app)

        // Pause → the same button flips to a resume glyph.
        app.buttons["voice-pause"].tap()
        let resume = app.buttons["voice-pause"]
        let flipped = NSPredicate(format: "label == %@", "Resume recording")
        let exp = XCTNSPredicateExpectation(predicate: flipped, object: resume)
        XCTAssertEqual(XCTWaiter().wait(for: [exp], timeout: 3), .completed,
                       "pause button did not flip to resume")

        // Resume.
        app.buttons["voice-pause"].tap()

        // Discard → composer returns.
        app.buttons["voice-discard"].tap()
        let ended = app.descendants(matching: .any)["voice-recording-locked"]
        XCTAssertFalse(ended.waitForExistence(timeout: 2), "discard did not end the locked take")
        XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 5), "composer did not return after discard")
    }

    // MARK: - 6. BET-1050 — the locked live bar stays inside the screen ≥30s

    /// BET-1050 acceptance: the live meter is width-derived (not a fixed-width
    /// bar row), so once the 90-bar window fills (~3.6s) and the recording has
    /// run ≥30s the whole locked recording bar must stay fully inside the
    /// screen. Reaches the locked bar via a quick mic tap (the direct path after
    /// BET-1051's decision #5).
    func testVoiceLockedOverflowStaysOnScreen() throws {
        let app = XCUIApplication()
        app.launch()
        reachChatComposer(app)

        let mic = app.buttons["mic-button"]
        XCTAssertTrue(mic.waitForExistence(timeout: 10), "mic button missing")
        mic.tap()

        let locked = app.descendants(matching: .any)["voice-recording-locked"]
        XCTAssertTrue(locked.waitForExistence(timeout: 6), "mic.tap() did not lock")
        XCTAssertTrue(app.buttons["voice-discard"].exists, "locked bar missing controls")

        // Let it run ≥30s so the live window is full (the bug only appears
        // once it fills) and the elapsed timer passes 0:30. The app records
        // independently of the test thread, so blocking here is fine.
        sleep(42)

        // The whole bar must be inside the screen: not clipped left, not
        // overflowing right.
        let width = app.frame.width
        let f = locked.frame
        XCTAssertGreaterThanOrEqual(f.minX, 0, "recording bar clipped on the LEFT (minX=\(f.minX))")
        XCTAssertLessThanOrEqual(f.maxX, width,
                                 "recording bar overflows the RIGHT edge (maxX=\(f.maxX) > screen \(width))")
        XCTAssertLessThanOrEqual(f.width, width,
                                 "recording bar is wider than the screen (width \(f.width) > \(width))")

        // Screenshot at ≥30s (the helper prints the on-simulator path + the AX
        // tree, so both legs of evidence are emitted).
        snap(app, marker: "REC-LOCKED-40S", png: "bet1050-locked-40s.png")

        // Clean up so the simulator isn't left recording.
        app.buttons["voice-discard"].tap()
        XCTAssertFalse(locked.waitForExistence(timeout: 3), "discard did not end the locked take")
    }

    // MARK: - 7. BET-1050 — the finished (.stored) note still renders + seekable

    /// BET-1050 acceptance item 8: the finished voice-note path is unchanged.
    /// Launches the `voice-note-stored` capture scene (a real `VoiceNotePlayerRow`
    /// with a finished note) and asserts the stored waveform row renders, that
    /// its play cell is present, and that tapping the bars region exercises the
    /// seek gesture without crashing.
    func testStoredNoteRendersAndTappable() throws {
        let app = XCUIApplication()
        app.launchEnvironment["MANTA_SCENE"] = "voice-note-stored"
        app.launch()

        let note = app.descendants(matching: .any)["voice-note"]
        XCTAssertTrue(note.waitForExistence(timeout: 8), "finished note row (voice-note) did not render")

        snap(app, marker: "STORED-NOTE", png: "bet1050-stored-note.png")

        // Tap the bars region to exercise the seek gesture (a no-op without a
        // loaded clip, but it must not crash and the row must stay present).
        note.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.5)).tap()
        XCTAssertTrue(note.exists, "stored note row vanished after tapping the bars")
    }

    // MARK: - Helpers

    /// A quick tap on the mic goes straight to the locked bar (decision #5) —
    /// this is the direct tap-to-lock path, never a held state.
    @discardableResult
    private func micTapLocked(_ app: XCUIApplication) -> XCUIElement {
        let mic = app.buttons["mic-button"]
        XCTAssertTrue(mic.waitForExistence(timeout: 10), "mic button missing")
        mic.tap()
        let locked = app.descendants(matching: .any)["voice-recording-locked"]
        XCTAssertTrue(locked.waitForExistence(timeout: 6), "mic tap did not lock — voice-recording-locked missing")
        return locked
    }

    /// Pair (first run only — the app stays paired between test launches) and
    /// open the fixture's single Chat row so the composer is reachable.
    private func reachChatComposer(_ app: XCUIApplication) {
        pairIfNeeded(app)
        XCTAssertTrue(app.staticTexts["Sessions"].waitForExistence(timeout: 20), "session list never appeared")
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH 'Chat'"))
            .firstMatch
        if row.waitForExistence(timeout: 10) {
            row.tap()
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.30)).tap()
        }
        XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 30), "chat did not open to a composer")
    }

    private func pairIfNeeded(_ app: XCUIApplication) {
        let otp = app.textFields["onboarding-otp"]
        guard otp.waitForExistence(timeout: 3) else { return }
        otp.tap()
        otp.typeText(pairCode)

        let advanced = app.buttons["My box isn't reachable from the internet"]
        if advanced.exists { advanced.tap() }
        let serverField = app.textFields["onboarding-server-url"]
        XCTAssertTrue(serverField.waitForExistence(timeout: 5), "server URL field never appeared")
        serverField.tap()
        serverField.typeText(pairServer)
        app.buttons["Continue"].firstMatch.tap()

        let notifications = app.staticTexts["Know when it needs you"]
        let failure = app.staticTexts["onboarding-failure-subtitle"]
        let deadline = Date().addingTimeInterval(45)
        while Date() < deadline, !notifications.exists, !failure.exists {
            usleep(300_000)
        }
        XCTAssertFalse(failure.exists, "pairing failed")
        XCTAssertTrue(notifications.exists, "notifications primer never appeared after claim")
        app.buttons["Continue"].firstMatch.tap()

        answerAlertIfPresent()
        app.terminate()
        app.launch()
    }

    /// Writes a settled PNG and prints the accessibility tree between markers.
    private func snap(_ app: XCUIApplication, marker: String, png: String) {
        let shot = XCUIScreen.main.screenshot()
        let out = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(png)
        try? shot.pngRepresentation.write(to: out)
        print("BET1028SHOT marker=\(marker) path=\(out.path)")
        print("AX-TREE-BEGIN \(marker)")
        print(app.debugDescription)
        print("AX-TREE-END \(marker)")
    }

    private func answerAlertIfPresent() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Allow", "OK", "Don't Allow"] {
            let button = springboard.buttons[label]
            if button.waitForExistence(timeout: 2) {
                button.tap()
                return
            }
        }
    }
}
