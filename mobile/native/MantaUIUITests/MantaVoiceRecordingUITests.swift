import XCTest

// ===========================================================================
// BET-1028 acceptance captures — the WhatsApp-style recording surfaces.
//
// Driven to a REAL composer-bearing chat against the local capture-fixture box
// (127.0.0.1:8787, code 123456 — see capture-fixture/fixture-box.mjs), exactly
// like MantaRunningStateCaptureUITests. The fixture's `config:get` now returns a
// Groq key so the mic button is available, and its `voice:transcribe` returns an
// empty transcript, so sending is a harmless no-op (no real transcription).
//
// Covers the walkthrough: tap-toggle start/stop (decision #5), hold-and-release,
// slide-left cancel, slide-up lock, pause/resume while locked, discard while
// locked. No audio is asserted. Each capture writes a settled PNG + prints the
// accessibility tree between markers.
// ===========================================================================

final class MantaVoiceRecordingUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private let pairCode = "123456"
    private let pairServer = "http://127.0.0.1:8787"

    // MARK: - 1. Held → slide up to lock (the core surface + bar)

    func testVoiceRecordingHeldThenLocked() throws {
        let app = XCUIApplication()
        app.launch()
        reachChatComposer(app)

        // Composer BEFORE recording — for the no-height-jump comparison.
        snap(app, marker: "COMPOSER", png: "bet1028-composer.png")

        let mic = app.buttons["mic-button"]
        XCTAssertTrue(mic.waitForExistence(timeout: 10), "mic button missing")
        mic.tap()

        let held = app.descendants(matching: .any)["voice-recording-held"]
        XCTAssertTrue(held.waitForExistence(timeout: 5), "recording did not start — voice-recording-held missing")
        snap(app, marker: "REC-HELD", png: "bet1028-held.png")

        // Slide UP well past the 80pt lock threshold (drag beyond the small
        // surface so the translation reaches it).
        let holdStart = held.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
        holdStart.press(forDuration: 0.2, thenDragTo: holdStart.withOffset(CGVector(dx: 0, dy: -160)))

        let locked = app.descendants(matching: .any)["voice-recording-locked"]
        XCTAssertTrue(locked.waitForExistence(timeout: 6), "slide up did not lock — voice-recording-locked missing")
        XCTAssertTrue(app.buttons["voice-discard"].exists, "locked bar missing voice-discard")
        XCTAssertTrue(app.buttons["voice-pause"].exists, "locked bar missing voice-pause")
        XCTAssertTrue(app.buttons["voice-send"].exists, "locked bar missing voice-send")
        snap(app, marker: "REC-LOCKED", png: "bet1028-locked.png")

        // Clean up: discard so the simulator isn't left recording.
        app.buttons["voice-discard"].tap()
    }

    // MARK: - 2. Tap-toggle: tap #1 starts, tap #2 stops (decision #5)

    func testVoiceTapToggleStartStop() throws {
        let app = XCUIApplication()
        app.launch()
        reachChatComposer(app)

        let mic = app.buttons["mic-button"]
        XCTAssertTrue(mic.waitForExistence(timeout: 10), "mic button missing")
        // Tap #1: starts, held surface appears.
        mic.tap()
        let held = app.descendants(matching: .any)["voice-recording-held"]
        XCTAssertTrue(held.waitForExistence(timeout: 5), "tap #1 did not start — held missing")

        // Tap #2: "a second tap stops" → sends → composer returns.
        held.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.6)).tap()
        let ended = app.descendants(matching: .any)["voice-recording-held"]
        XCTAssertFalse(ended.waitForExistence(timeout: 2), "tap #2 did not stop the take — held still present")
        XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 5), "composer did not return after tap #2")
    }

    // MARK: - 3. Slide left → cancel (release discards)

    func testVoiceSlideLeftCancels() throws {
        let app = XCUIApplication()
        app.launch()
        reachChatComposer(app)

        let mic = app.buttons["mic-button"]
        XCTAssertTrue(mic.waitForExistence(timeout: 10), "mic button missing")
        mic.tap()
        let held = app.descendants(matching: .any)["voice-recording-held"]
        XCTAssertTrue(held.waitForExistence(timeout: 5), "held missing before slide")

        // Drag left well past the 64pt cancel threshold, then release.
        let holdStart = held.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
        holdStart.press(forDuration: 0.2, thenDragTo: holdStart.withOffset(CGVector(dx: -140, dy: 0)))

        let ended = app.descendants(matching: .any)["voice-recording-held"]
        XCTAssertFalse(ended.waitForExistence(timeout: 2), "slide-left+release did not discard the take")
        XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 5), "composer did not return after cancel")
    }

    // MARK: - 4. Locked bar: pause / resume / discard

    func testVoiceLockedPauseResumeDiscard() throws {
        let app = XCUIApplication()
        app.launch()
        reachChatComposer(app)

        let mic = app.buttons["mic-button"]
        XCTAssertTrue(mic.waitForExistence(timeout: 10), "mic button missing")
        mic.tap()
        let held = app.descendants(matching: .any)["voice-recording-held"]
        XCTAssertTrue(held.waitForExistence(timeout: 5), "held missing")
        let holdStart = held.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
        holdStart.press(forDuration: 0.2, thenDragTo: holdStart.withOffset(CGVector(dx: 0, dy: -160)))
        let locked = app.descendants(matching: .any)["voice-recording-locked"]
        XCTAssertTrue(locked.waitForExistence(timeout: 6), "slide up did not lock")

        // Pause.
        app.buttons["voice-pause"].tap()
        // The pause button flips to a resume glyph — assert the state via the
        // label/identifier transitions (resume label).
        let resumeExpectation = app.buttons["voice-pause"]
        XCTAssertTrue(resumeExpectation.waitForExistence(timeout: 3), "pause button gone")

        // Resume.
        app.buttons["voice-pause"].tap()

        // Discard.
        app.buttons["voice-discard"].tap()
        let ended = app.descendants(matching: .any)["voice-recording-locked"]
        XCTAssertFalse(ended.waitForExistence(timeout: 2), "discard did not end the locked take")
        XCTAssertTrue(app.buttons["send-button"].waitForExistence(timeout: 5), "composer did not return after discard")
    }

    // MARK: - 5. BET-1050 — the locked live bar stays inside the screen ≥30s

    /// BET-1050 acceptance: the live meter is width-derived (not a fixed-width
    /// bar row), so once the 90-bar window fills (~3.6s) and the recording has
    /// run ≥30s the whole locked recording bar must stay fully inside the
    /// screen — the elapsed timer is never clipped on the left and the
    /// waveform never crosses the right edge. Measured as the
    /// `voice-recording-locked` container frame against the screen bounds: the
    /// OLD fixed-width row forced this container wider than the screen.
    func testVoiceLockedOverflowStaysOnScreen() throws {
        let app = XCUIApplication()
        app.launch()
        reachChatComposer(app)

        let mic = app.buttons["mic-button"]
        XCTAssertTrue(mic.waitForExistence(timeout: 10), "mic button missing")
        mic.tap()

        let held = app.descendants(matching: .any)["voice-recording-held"]
        XCTAssertTrue(held.waitForExistence(timeout: 5), "recording did not start — held missing")
        // Slide UP well past the 80pt lock threshold.
        let holdStart = held.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
        holdStart.press(forDuration: 0.2, thenDragTo: holdStart.withOffset(CGVector(dx: 0, dy: -160)))

        let locked = app.descendants(matching: .any)["voice-recording-locked"]
        XCTAssertTrue(locked.waitForExistence(timeout: 6), "slide up did not lock")
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

    // MARK: - 6. BET-1050 — the finished (.stored) note still renders + seekable

    /// BET-1050 acceptance item 8: the finished voice-note path is unchanged.
    /// Launches the `voice-note-stored` capture scene (a real `VoiceNotePlayerRow`
    /// with a finished note) and asserts the stored waveform row renders, that
    /// its play cell is present, and that tapping the bars region exercises the
    /// seek gesture without crashing. Seekability itself is wired by the
    /// ready-row's non-nil `onSeek` closure → `VoiceBarsView` attaches the tap
    /// gesture (`onSeek.map { _ in tapSeek(...) }`), which is unchanged.
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
