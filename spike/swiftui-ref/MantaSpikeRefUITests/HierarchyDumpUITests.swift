import XCTest

// One purpose: dump the live accessibility element hierarchy of a screen so a
// capture is reproducible *and* auditable as text. The dump is the native
// analog of the web client's DOM read — what a later measurement layer reads
// geometry/type/colour out of.
//
// BET-481 needs to know what SwiftUI does with scroll position while the
// transcript streams. The screen's pixels move, so the measurement is the
// *accessible text*: which static texts are on screen (materialised by the
// LazyVStack) and at what frames, sampled at three points during the stream.
// The hierarchy dump is that text — it is what this target exists to produce.
//
// The app launches into the chat screen via `-chatRoot` and starts streaming
// automatically on appear. Streaming is: a fixed 40-char string appended every
// 100ms for a fixed 60 ticks (6s total). We sample three phases (early/mid/
// late) of that stream so the harness can both screenshot (SHOT-* marker, from
// capture.sh) and read the visible text (VISIBLE-* AX snapshots) at the same
// moment.
final class HierarchyDumpUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    // Stream phase names, in chronological order. Used as tags in the dump and
    // as the `stream-case{1,2}-{phase}.png` filenames.
    private let phases = ["early", "mid", "late"]

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

    // Opens the chat screen (the streaming transcript) and dumps its AX tree at
    // a settled early state. Used to baseline the element set before streaming
    // measurement; the BET-481 capture methods below do the timed sampling.
    func testDumpChatAccessibilityHierarchy() throws {
        let app = XCUIApplication()
        launchChat(app)
        dumpVisibleTexts(app, tag: "baseline")
    }

    // Case 1 — user is at the bottom, does not scroll. The stream runs; at
    // three phases we dump the visible text and raise a SHOT marker so the
    // harness screenshots the same moment.
    // Expected correct behaviour: the view stays anchored to the bottom and the
    // newest text remains visible as it arrives.
    func testStreamCase1() throws {
        let app = XCUIApplication()
        launchChat(app)

        // Let the captures land during active streaming: begin the first phase
        // only once the tail is past a few ticks, and fail loudly if the stream
        // has already expired (a slow automation session must not turn a
        // post-stream frame into a "held" result).
        preconditionStreamActive(in: app, minimumChunks: 8, context: "case1")
        print("STREAM-CASE1-READY")

        for (i, phase) in phases.enumerated() {
            if i > 0 { Thread.sleep(forTimeInterval: 0.9) }
            runLoopTick()
            dumpVisibleTexts(app, tag: "case1-\(phase)")
            print("SHOT-CASE1-\(phase.uppercased())")
        }
        // Hold the app in-window while the harness finishes its last capture.
        Thread.sleep(forTimeInterval: 2)
    }

    // Case 2 — user has scrolled up so earlier messages are visible, then lets
    // the stream run. Same three-phase sampling.
    // Expected correct behaviour: the view stays where the user put it; content
    // below grows but the visible text does not move.
    func testStreamCase2() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-chatRoot"]
        app.launch()

        // Scroll up immediately — in the stream's first ~2s, while msg8 is still
        // short — so the setup itself costs as little of the 6s stream as
        // possible. Two quick flicks are enough to reveal earlier messages at
        // this point in the transcript.
        let scroll = app.scrollViews.firstMatch
        scroll.swipeDown(velocity: .fast)
        scroll.swipeDown(velocity: .fast)

        print("STREAM-CASE2-READY")

        // Fail loudly rather than capture a post-stream frame (stream expired
        // during a slow automation session). See preconditionStreamActive.
        preconditionStreamActive(in: app, minimumChunks: 6, context: "case2")

        for (i, phase) in phases.enumerated() {
            if i > 0 { Thread.sleep(forTimeInterval: 0.7) }
            runLoopTick()
            dumpVisibleTexts(app, tag: "case2-\(phase)")
            print("SHOT-CASE2-\(phase.uppercased())")
        }
        Thread.sleep(forTimeInterval: 2)
    }

    // -- helpers -------------------------------------------------------------

    // Launch the app straight into the chat screen and wait for the content
    // scroll view (streaming auto-starts on appear). Waiting on the scroll
    // view (not the slow nav title) keeps the BET-481 timing window as wide as
    // possible within the fixed 6s stream.
    private func launchChat(_ app: XCUIApplication) {
        app.launchArguments = ["-chatRoot"]
        app.launch()
        let scroll = app.scrollViews.firstMatch
        XCTAssertTrue(scroll.waitForExistence(timeout: 10), "chat scroll view did not appear")
    }

    // Drain the event loop so the rendering/streaming settles before the
    // dump/screenshot that follows it. Without this the automation session
    // never advances and the element tree reports a stale frame.
    private func runLoopTick() {
        RunLoop.current.run(until: Date().addingTimeInterval(0.15))
    }

    // How many 40-char stream chunks are currently appended to the streaming
    // tail message. 0 = the tail is not (yet) in the accessibility tree;
    // 60 = the stream has finished. Reading the label triggers one snapshot.
    private func streamChunks(in app: XCUIApplication) -> Int {
        let tail = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Restore complete")).firstMatch
        guard tail.exists else { return 0 }
        let chunk = "0123456789012345678901234567890123456789"
        return tail.label.components(separatedBy: chunk).count - 1
    }

    // A measurement of scroll position under a *streaming* transcript is only
    // meaningful while the stream is actually running. If the automation setup
    // was so slow that the 6s stream finished first, the captures would be a
    // static post-stream frame and "held" would be tautological. Fail that run
    // loudly instead of recording it.
    private func preconditionStreamActive(in app: XCUIApplication, minimumChunks: Int, context: String) {
        let chunks = streamChunks(in: app)
        XCTAssertGreaterThan(chunks, minimumChunks,
                             "\(context): streaming not active — tail has \(chunks) chunks (expected > \(minimumChunks))")
        XCTAssertLessThan(chunks, 60,
                          "\(context): stream already finished before capture — re-run needed, this frame is invalid")
    }

    // Print the current accessibility hierarchy as one atomic snapshot. The
    // LazyVStack materialises only rows near the viewport, so what is in the
    // tree is what is on screen — this is the auditable "visible text".
    // `debugDescription` is a single snapshot, so it cannot race with the
    // streaming LazyVStack re-materialising rows mid-enumeration (indexed it
    // threw "No matches found for Element at index N" whenever the count
    // changed between building the array and reading it).
    private func dumpVisibleTexts(_ app: XCUIApplication, tag: String) {
        print("VISIBLE-\(tag)-BEGIN")
        print(app.debugDescription)
        print("VISIBLE-\(tag)-END")
    }
}
