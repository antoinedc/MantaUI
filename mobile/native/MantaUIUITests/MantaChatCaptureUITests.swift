import XCTest

// ===========================================================================
// Chat-surface capture driver for the native chat epic (BET-624, row 0 =
// BET-625). The manta-sim-drive plugin builds each of these test classes in
// the Simulator and globs the PNG it drops into the runner's own container,
// then uploads it to the box. The order of this epic means the surfaces the
// captures show land AFTER this driver: the overflow sheet (BET-626), the
// running row (BET-630) and the loading skeleton (BET-631) are accepted by a
// screenshot produced through these actions.
//
// Shared navigation:
//   - MANTA_OPEN_ROW names a row to open (label-prefix hop, `|`-delimited);
//     empty falls back to the first row by normalized coordinate. A chat-mode
//     window and a plain tmux window land on different screens, so the caller
//     picks which row for which capture.
//   - Each test writes one uniquely named PNG so the plugin can pick it up.
// ===========================================================================

private enum MantaChatCapture {

    /// Open the first/named session row so the app lands on the chat screen
    /// (mirrors MantaOpenSessionUITests.testOpenFirstSession).
    static func openChat(in app: XCUIApplication) {
        _ = app.staticTexts["Sessions"].waitForExistence(timeout: 15)
        let wanted = ProcessInfo.processInfo.environment["MANTA_OPEN_ROW"] ?? MantaPairFixture.openRow
        let hops = wanted.split(separator: "|").map(String.init)
        if hops.isEmpty {
            print("PAIRDRIVE open-row=first-by-coordinate")
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.28)).tap()
        }
        for hop in hops {
            let prefix = NSPredicate(format: "label BEGINSWITH %@", hop)
            let target = app.descendants(matching: .any).matching(prefix).firstMatch
            guard target.waitForExistence(timeout: 10) else {
                print("PAIRDRIVE open-miss=\(hop)")
                break
            }
            target.tap()
            print("PAIRDRIVE open-row=\(hop) kind=\(target.elementType.rawValue)")
            sleep(4)
        }
        // Give the chat screen a moment to push into the navigation stack.
        sleep(2)
    }

    /// The runner tears the app down the moment the test ends, so a host-side
    /// `simctl io screenshot` always catches Springboard instead. Capture from
    /// inside the test and drop it in the runner's own container, which the
    /// driver plugin globs for on the host.
    static func capture(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let out = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent(name)
        try? shot.pngRepresentation.write(to: out)
        print("PAIRDRIVE shot=\(out.path)")
    }
}

// Opens the chat overflow sheet — taps the trailing 38×38 header button
// (`overflow-button`, BET-626's real sheet) — and captures the sheet.
final class MantaOverflowCaptureUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testCaptureOverflowSheet() throws {
        let app = XCUIApplication()
        app.launch()

        MantaChatCapture.openChat(in: app)

        // Wait for the chat surface to push, then locate the trailing header
        // overflow button. Query descendants + label fallback for resilience
        // across SwiftUI element taxonomies.
        _ = app.descendants(matching: .any)["chat-screen"].waitForExistence(timeout: 10)
        let byId = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == 'overflow-button'")).firstMatch
        let overflow = byId.exists ? byId : app.buttons["More options"]
        guard overflow.waitForExistence(timeout: 10) else {
            // Diagnose: dump the on-screen buttons so a mis-targeted row
            // (terminal vs chat) is obvious instead of a silent skip.
            let labels = app.buttons.allElementsBoundByIndex
                .prefix(40)
                .map { $0.identifier.isEmpty ? $0.label : $0.identifier }
            print("PAIRDRIVE overflow-missing buttons=\(labels.joined(separator: "|"))")
            throw XCTSkip("PAIRDRIVE overflow: no overflow-button (chat not open?)")
        }
        overflow.tap()
        print("PAIRDRIVE overflow=opened")

        // Let the sheet settle at its half-height detent (BET-626).
        sleep(2)
        MantaChatCapture.capture("manta-overflow-sheet.png")
    }
}

// Sends a prompt and captures while the turn is still running, so the
// mid-turn state (running row / elapsed time, BET-630) is visible.
final class MantaMidTurnCaptureUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testCaptureMidTurn() throws {
        let app = XCUIApplication()
        app.launch()

        MantaChatCapture.openChat(in: app)

        let input = app.textViews["composer-input"]
        guard input.waitForExistence(timeout: 10) else {
            throw XCTSkip("PAIRDRIVE midturn: no composer input")
        }
        input.tap()
        input.typeText("Say the alphabet slowly, one letter per line, pausing after each line.")
        let send = app.buttons["send-button"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "no send button")
        send.tap()
        print("PAIRDRIVE midturn=sent")

        // Capture while the turn is still in flight.
        sleep(5)
        MantaChatCapture.capture("manta-mid-turn.png")
    }
}

// Opens a session and captures as close to the push as possible, so the
// initial-load skeleton (BET-631) is on screen rather than a settled
// transcript.
final class MantaLoadCaptureUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testCaptureDuringLoad() throws {
        let app = XCUIApplication()
        app.launch()

        _ = app.staticTexts["Sessions"].waitForExistence(timeout: 15)
        let wanted = ProcessInfo.processInfo.environment["MANTA_OPEN_ROW"] ?? MantaPairFixture.openRow
        let hops = wanted.split(separator: "|").map(String.init)
        if hops.isEmpty {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.28)).tap()
        }
        for hop in hops {
            let prefix = NSPredicate(format: "label BEGINSWITH %@", hop)
            let target = app.descendants(matching: .any).matching(prefix).firstMatch
            guard target.waitForExistence(timeout: 10) else {
                print("PAIRDRIVE open-miss=\(hop)")
                break
            }
            target.tap()
            sleep(4)
        }

        // Minimal delay — don't wait for the transcript to settle, capture the
        // loading state.
        usleep(300_000)
        MantaChatCapture.capture("manta-load.png")
    }
}
