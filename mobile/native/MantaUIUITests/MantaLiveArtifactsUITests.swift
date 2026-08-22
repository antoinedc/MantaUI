import XCTest

// ===========================================================================
// Live-box visual pass for the BET-750 artifacts/outbox receive panel +
// downloads (BET-776). Requires a live box whose simulator install is ALREADY
// PAIRED — run MantaPairingDriverUITests first — and a box that has:
//   - an isolated chat session `bet776` whose outbox contains the artifact
//     `hello-artifact.md` (and `unreadable.bin`, an unreadable file to force a
//     genuine download failure), and
//   - an isolated chat session `bet776-empty` with an EMPTY outbox.
// Each test opens ONLY its own isolated row (never a shared/live agent
// session), drives the overflow sheet's Artifacts card, and prints AX trees +
// RESULT facts so the pass is auditable from the xcodebuild log.
//
// Skips unless the expected session rows are present (no live box / not
// paired / artifacts not staged).
// ===========================================================================

final class MantaLiveArtifactsUITests: XCTestCase {

    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    /// Points 1 + 2: a pushed artifact appears in the Artifacts card (via
    /// `outbox:list` + the card's live refetch) and tapping Download fetches
    /// the bytes and swaps the row to a Save (ShareLink) control — the visible
    /// saved state.
    func testArtifactAppearsAndDownloads() throws {
        try openSessionRow("bet776-main") // skips if absent

        // The artifacts card lives behind the overflow sheet ("Session
        // actions" → "Artifacts").
        openArtifactsCard()

        // Point 1: the pushed artifact must appear in the card. It arrives via
        // outbox:list + the card's 3s live refetch, so poll rather than sleep.
        let name = app.descendants(matching: .any)
            .matching(identifier: "artifact-name-hello-artifact.md").firstMatch
        var appeared = false
        for _ in 0..<30 {
            if name.exists {
                appeared = true
                break
            }
            usleep(300_000)
        }
        print("RESULT artifact-appeared=\(appeared)")
        print("RESULT artifact-row-label=\(name.exists ? name.label : "MISSING")")
        print("AX-TREE-BEGIN")
        print(app.debugDescription)
        print("AX-TREE-END")
        saveScreenshot("artifacts-card-populated")
        XCTAssertTrue(appeared, "pushed artifact never appeared in the card")

        // Point 2: tapping download must fetch the bytes and swap to a Save
        // (ShareLink) control — the visible saved state.
        tapDownload("hello-artifact.md")
        let saved = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "Save hello-artifact.md")).firstMatch
        var savedAppeared = false
        for _ in 0..<40 {
            if saved.exists {
                savedAppeared = true
                break
            }
            usleep(300_000)
        }
        print("RESULT artifact-download-saved-state=\(savedAppeared)")
        print("AX-TREE-SAVED-BEGIN")
        print(app.debugDescription)
        print("AX-TREE-SAVED-END")
        saveScreenshot("artifacts-card-downloaded")
        XCTAssertTrue(savedAppeared, "download did not reach a visible saved state")
    }

    /// Point 3 (failure): a download that cannot be served must NOT fabricate a
    /// saved state. The `unreadable.bin` row lists (it is a real outbox row)
    /// but its bytes cannot be read on the box, so the download fails and the
    /// row must keep its Download control — no Save control appears.
    func testUnreadableDownloadSurfacesFailureNotSilentSuccess() throws {
        try openSessionRow("bet776-main")

        openArtifactsCard()

        let rowName = app.descendants(matching: .any)
            .matching(identifier: "artifact-name-unreadable.bin").firstMatch
        var listed = false
        for _ in 0..<30 {
            if rowName.exists {
                listed = true
                break
            }
            usleep(300_000)
        }
        print("RESULT unreadable-row-listed=\(listed)")
        XCTAssertTrue(listed, "unreadable outbox row never listed")

        // Tap its download. It must fail server-side (unreadable bytes → 404).
        tapDownload("unreadable.bin")

        // Give the failed fetch a beat, then confirm NO Save control appeared
        // (no fabricated saved state) and the Download control remains.
        usleep(2_000_000)
        let fakeSaved = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "Save unreadable.bin")).firstMatch
        let downloadStill = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "Download unreadable.bin")).firstMatch
        print("RESULT unreadable-false-saved-state=\(fakeSaved.exists)")
        print("RESULT unreadable-download-control-retained=\(downloadStill.exists)")
        print("AX-TREE-BEGIN")
        print(app.debugDescription)
        print("AX-TREE-END")
        saveScreenshot("artifacts-card-unreadable")
        XCTAssertFalse(fakeSaved.exists,
                       "unreadable download reported a saved state that could not have succeeded")
        XCTAssertTrue(downloadStill.exists,
                      "failed download lost its Download control (should stay, not silently save)")
    }

    /// Point 3 (empty): a session with an empty outbox shows the honest empty
    /// state rather than a blank list or an error.
    func testEmptyOutboxShowsHonestEmptyState() throws {
        try openSessionRow("bet776-empty-main")

        openArtifactsCard()

        let empty = app.descendants(matching: .any)
            .matching(identifier: "artifacts-empty").firstMatch
        var showed = false
        for _ in 0..<30 {
            if empty.exists {
                showed = true
                break
            }
            usleep(300_000)
        }
        print("RESULT empty-outbox-state-shown=\(showed)")
        print("RESULT empty-outbox-title=\(showed ? empty.label : "MISSING")")
        print("AX-TREE-BEGIN")
        print(app.debugDescription)
        print("AX-TREE-END")
        saveScreenshot("artifacts-card-empty")
        XCTAssertTrue(showed, "empty outbox did not show the honest empty state")
    }

    // MARK: - Helpers

    /// Open the overflow sheet and its "Artifacts" row. Both the trigger
    /// ("Session actions") and the sheet row ("Artifacts") are buttons.
    private func openArtifactsCard() {
        let trigger = app.buttons["Session actions"]
        XCTAssertTrue(trigger.waitForExistence(timeout: 10), "overflow trigger missing")
        trigger.tap()

        let artifactsRow = app.buttons["Artifacts"]
        XCTAssertTrue(artifactsRow.waitForExistence(timeout: 8), "Artifacts row missing")
        print("RESULT overflow-artifacts-row=\(artifactsRow.exists)")
        artifactsRow.tap()

        // Let the card's first outbox:list resolve.
        usleep(1_500_000)
    }

    /// Tap a row's download control by its accessibility label
    /// ("Download <name>").
    private func tapDownload(_ name: String) {
        let button = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "Download \(name)")).firstMatch
        guard button.waitForExistence(timeout: 10) else {
            print("RESULT download-button-missing=\(name)")
            print("DUMP-BEGIN")
            print(app.debugDescription)
            print("DUMP-END")
            XCTFail("download button missing for \(name)")
            return
        }
        button.tap()
    }

    /// Open the isolated chat session row. Skips if the box isn't connected or
    /// the row is absent (no live box / artifacts not staged / not paired).
    ///
    /// A project row renders as a group header (StaticText titled with the
    /// project name, e.g. "Bet776") above its window row (a Button whose label
    /// starts with the window name, e.g. "main, …"). The header is not tappable
    /// — the window row is what opens the session. `query` is what we filter
    /// the session list by; `windowName` is the row's label prefix to tap.
    ///
    /// The box's `tmux:list` intermittently returns an empty list, which the
    /// app shows as the "No sessions yet" blank state. Each app launch
    /// refetches, so the drive relaunches (up to a few times) until a
    /// non-blank list comes up.
    @discardableResult
    private func openSessionRow(_ query: String) throws -> Bool {
        // Retry the whole open up to a few times. The box's `tmux:list`
        // intermittently returns an empty list (blank "No sessions yet" state)
        // and the AX snapshot can transiently throw; a fresh launch + retry
        // sidesteps both without fabricating a pass.
        for attempt in 0..<6 {
            if try openSessionRowOnce(query) {
                return true
            }
            print("RESULT open-retry attempt=\(attempt)")
            app.terminate()
            app.launch()
        }
        throw XCTSkip("LIVE SKIP: could not open \(query) row after retries (box not paired / no live box / not staged)")
    }

    /// Single attempt to open the isolated session row for `query`; returns
    /// false (never throws a hard failure) when the row can't be reached.
    private func openSessionRowOnce(_ query: String) throws -> Bool {
        let search = app.textFields["Search sessions"]
        guard waitExist(search, 15) else {
            return false
        }

        let blank = app.staticTexts["sessions-empty"]
        if blank.exists {
            print("RESULT blank-list relaunching")
            return false
        }

        // Deterministic clear of any pre-existing filter text: Cmd+A selects
        // all in the field, then the typed query replaces it.
        waittap(search)
        search.typeKey("a", modifierFlags: .command)
        search.typeText(query)

        // The tappable window row carries a unique label (we name the isolated
        // windows "bet776-main" / "bet776-empty-main" on the box), so a
        // `CONTAINS` match isolates exactly our row among the shared sessions.
        let row = app.buttons
            .matching(NSPredicate(format: "label CONTAINS %@", query))
            .firstMatch
        guard waitExist(row, 20) else {
            print("RESULT \(query)-row-missing pair=\(waitExist(app.buttons["onboarding-manual-toggle"], 1))")
            return false
        }
        // Capture the label BEFORE navigating (after `row.tap()` the element
        // is gone and reading `.label` raises an uncaught XCUITest exception).
        let label = row.label
        row.tap()
        let chat = app.otherElements["chat-screen"]
        guard waitExist(chat, 20) else {
            return false
        }
        print("RESULT opened-session=\(query) window=\(label)")
        return true
    }

    /// Poll `.exists` (which returns false for a non-existent element rather
    /// than throwing, matching the BET-775 harness) instead of relying on
    /// `waitForExistence`, which can raise an uncaught "Failed to get matching
    /// snapshot" exception when the queried element never appears.
    private func waitExist(_ element: XCUIElement, _ seconds: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if element.exists { return true }
            usleep(200_000)
        }
        return element.exists
    }

    private func waittap(_ element: XCUIElement) {
        do { try element.tap() } catch {}
    }

    /// Save an illustrative screenshot to the runner's temp dir so the driver
    /// can fetch it off the simulator afterward. Illustration only — never a
    /// verification gate (pixel-baseline verification is retired).
    private func saveScreenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let out = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("\(name).png")
        try? shot.pngRepresentation.write(to: out)
        print("RESULT screenshot-saved=\(out.path)")
    }
}
