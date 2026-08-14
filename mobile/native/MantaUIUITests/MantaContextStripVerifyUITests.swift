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
