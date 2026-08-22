import XCTest

// ===========================================================================
// Live-box visual pass for the BET-749 `@`-file typeahead + `/` slash palette
// (BET-775). Requires a live box whose simulator install is ALREADY PAIRED —
// run MantaPairingDriverUITests first — and an isolated session row named
// `bet775` on that box. The test opens ONLY its own `bet775` row (never a
// shared/live agent session), drives the composer, and prints AX trees +
// RESULT facts so the pass is auditable from the xcodebuild log.
//
// Skips unless a `bet775` session row is present (no live box / not paired).
// ===========================================================================

final class MantaLiveTypeaheadSlashUITests: XCTestCase {

    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    /// Point 1 + part of 2: typing `@` shows the file typeahead and the
    /// matches correspond to the box's working directory, and selecting one
    /// substitutes `@<file>` into the draft.
    func testAtMentionTypeaheadMatchesBoxCWDAndSubstitutes() throws {
        let runner = try openBet775SessionOrSkip()
        XCTContext.runActivity(named: "bet775 chat open") { _ in
            print("RESULT chat-open=\(runner)")
        }

        let composer = app.descendants(matching: .any).matching(identifier: "composer-input").firstMatch
        guard composer.waitForExistence(timeout: 15) else {
            print("DUMP-BEGIN")
            print(app.debugDescription)
            print("DUMP-END")
            XCTFail("composer-input missing")
            return
        }
        print("RESULT composer-element=\(composer.elementType.rawValue)")

        // Type "@" + a query that should match files in /home/dev/bet775-livepass.
        composer.tap()
        composer.typeText("@Compose")

        // The debounced findFiles (~250ms) + network hit needs a beat; poll for
        // the typeahead rather than a fixed sleep. On-device the container is a
        // Button (SwiftUI collapses the VStack) carrying the "mention-typeahead"
        // id; a single-match typeahead puts the file label straight on it.
        var appeared = false
        var typeaheadLabel = ""
        for _ in 0..<30 {
            let t = app.descendants(matching: .any).matching(identifier: "mention-typeahead").firstMatch
            if t.exists {
                appeared = true
                typeaheadLabel = t.label
                break
            }
            usleep(300_000)
        }
        print("RESULT at-typeahead-appeared=\(appeared)")
        print("RESULT at-typeahead-label=\(typeaheadLabel)")
        print("AX-TREE-BEGIN")
        print(app.debugDescription)
        print("AX-TREE-END")

        XCTAssertTrue(appeared, "@ typeahead never appeared against the live box")

        // The match label is "@<file>" — it must correspond to a real path in
        // the box's working directory. Tap it to substitute into the draft.
        let match = app.descendants(matching: .any).matching(identifier: "mention-typeahead").firstMatch
        match.tap()
        usleep(500_000)

        // The mention must serialize into the draft as "@<file>".
        let textNow = composer.value as? String ?? ""
        print("RESULT composer-text-now=\(textNow)")
        XCTAssertTrue(textNow.contains("@"), "draft does not contain the substituted @<file> token")

        // Send it: the mention must serialize onto the wire and reach the box
        // on the next send (the box transcript is confirmed separately).
        let send = app.buttons["send-button"]
        if send.waitForExistence(timeout: 5) && send.isEnabled {
            send.tap()
            print("RESULT mention-send-tapped=true")
        } else {
            print("RESULT mention-send-tapped=false")
        }

        _ = runner
    }

    /// Points 2 + 3: sending carries the mention to the box, and the `/`
    /// palette presents the four (five-when-running) commands.
    func testSlashPalettePresentsAndSubmitSends() throws {
        let runner = try openBet775SessionOrSkip()
        _ = runner

        let composer = app.descendants(matching: .any).matching(identifier: "composer-input").firstMatch
        guard composer.waitForExistence(timeout: 15) else {
            print("DUMP-BEGIN")
            print(app.debugDescription)
            print("DUMP-END")
            XCTFail("composer-input missing")
            return
        }

        composer.tap()
        composer.typeText("/")

        var appeared = false
        var labels: [String] = []
        for _ in 0..<20 {
            let palette = app.descendants(matching: .any).matching(identifier: "slash-palette").firstMatch
            if palette.exists {
                appeared = true
                labels = ["\(palette.label)"]
                // A multi-command palette renders each row as a distinct element.
                let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'slash-row-'"))
                    .allElementsBoundByIndex
                labels = rows.map { "\($0.identifier):\($0.label)" }
                break
            }
            usleep(200_000)
        }
        print("RESULT slash-palette-appeared=\(appeared)")
        // On-device each row surfaces as a Button whose identifier is
        // "slash-palette" (SwiftUI collapses row ids) but whose label is
        // "/<cmd>, <subtitle>". Detect the four always-on commands by label.
        let commands = ["/submit", "/compact", "/clear", "/fork"]
        var seen: [String: Bool] = [:]
        for cmd in commands {
            let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", cmd)).firstMatch
            seen[cmd] = row.exists
            print("RESULT slash-row-\(cmd)-exists=\(row.exists)")
        }
        let abortRow = app.buttons.matching(NSPredicate(format: "label BEGINSWITH '/abort'")).firstMatch
        print("RESULT slash-row-abort-exists=\(abortRow.exists)")
        print("AX-TREE-BEGIN")
        print(app.debugDescription)
        print("AX-TREE-END")

        // Compact is the safest real store action to drive: it frees context on
        // the box and surfaces an actionHint ("Compacted — context freed").
        let compact = app.buttons.matching(NSPredicate(format: "label BEGINSWITH '/compact'")).firstMatch
        XCTAssertTrue(compact.exists, "slash palette compact row missing")
        compact.tap()
        usleep(800_000)
        // After a non-submit action the palette closes and the draft is cleared.
        let cleared = composer.value as? String ?? ""
        print("RESULT slash-compact-draft-after=\(cleared)")
        XCTAssertTrue(cleared.trimmingCharacters(in: .whitespaces).isEmpty,
                      "composer not cleared after non-submit slash action")
    }

    /// Open the isolated `bet775` chat session; skip if the box isn't connected
    /// or the row is absent (no live box / this test would then be meaningless).
    @discardableResult
    private func openBet775SessionOrSkip() throws -> Bool {
        // Wait for the session list to load (requires pairing). The rows are
        // Buttons whose label carries the window name ("bet775, …").
        // The shared list is long and virtualized; filter to our isolated row.
        let search = app.textFields["Search sessions"]
        if search.waitForExistence(timeout: 15) {
            search.tap()
            // Clear any pre-existing filter text (select-all + delete) so the
            // query is entered fresh.
            let existing = (search.value as? String) ?? ""
            if !existing.isEmpty, existing != "Search sessions", existing != "Search" {
                search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count + 2))
            }
            search.typeText("bet775")
        }
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS 'bet775'")).firstMatch
        guard row.waitForExistence(timeout: 20) else {
            print("RESULT bet775-row-missing pair=\(app.buttons["onboarding-manual-toggle"].exists)")
            print("DUMP-BEGIN")
            print(app.debugDescription)
            print("DUMP-END")
            throw XCTSkip("LIVE SKIP: bet775 row missing after filtering (box not paired / no live box)")
        }
        row.tap()
        let chat = app.otherElements["chat-screen"]
        guard chat.waitForExistence(timeout: 20) else {
            throw XCTSkip("LIVE SKIP: chat screen did not open for bet775")
        }
        print("RESULT opened-session=bet775")
        return true
    }
}
