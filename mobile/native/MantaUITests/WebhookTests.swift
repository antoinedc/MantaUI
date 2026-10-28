import XCTest
@testable import MantaUI

// ===========================================================================
// WS07 F7 — webhook metadata decode + row text. Pure — runs under `verify.sh`.
// ===========================================================================

final class WebhookTests: XCTestCase {

    private func decode(_ json: String) throws -> [WebhookMeta] {
        try JSONDecoder().decode([WebhookMeta].self, from: Data(json.utf8))
    }

    func testDecodesAFullRow() throws {
        let hooks = try decode(#"""
        [{"id":"ab12cd34","provider":"manta","label":"multica done","url":"https://app.example.com/hook/tok","unsigned":true,
          "sessionID":"ses_1","instructions":"Pull the output","createdAt":1761640000000,"lastDeliveredAt":1761650000000,"deliveries":3}]
        """#)
        XCTAssertEqual(hooks.count, 1)
        let h = hooks[0]
        XCTAssertEqual(h.id, "ab12cd34")
        XCTAssertEqual(h.provider, "manta")
        XCTAssertEqual(h.label, "multica done")
        XCTAssertEqual(h.url, "https://app.example.com/hook/tok")
        XCTAssertTrue(h.unsigned)
        XCTAssertEqual(h.sessionID, "ses_1")
        XCTAssertEqual(h.instructions, "Pull the output")
        XCTAssertEqual(h.createdAt, 1761640000000)
        XCTAssertEqual(h.lastDeliveredAt, 1761650000000)
        XCTAssertEqual(h.deliveries, 3)
    }

    func testDecodesNullsAndOlderBoxesWithoutProviderOrInstructions() throws {
        let hooks = try decode(#"""
        [{"id":"x","label":"","url":null,"unsigned":false,"sessionID":null,"createdAt":null,"lastDeliveredAt":null,"deliveries":0}]
        """#)
        let h = hooks[0]
        XCTAssertNil(h.provider)
        XCTAssertNil(h.instructions)
        XCTAssertNil(h.url)
        XCTAssertNil(h.sessionID)
        XCTAssertNil(h.createdAt)
        XCTAssertEqual(h.deliveries, 0)
    }

    func testLastDelivery() {
        XCTAssertEqual(WebhookFormat.lastDelivery(WebhookMeta(id: "a")), "never fired")
        let fired = WebhookMeta(id: "b", lastDeliveredAt: 1761650000000, deliveries: 3)
        XCTAssertTrue(WebhookFormat.lastDelivery(fired).hasSuffix(" · 3×"), WebhookFormat.lastDelivery(fired))
        XCTAssertNotEqual(WebhookFormat.lastDelivery(fired), "never fired")
        XCTAssertEqual(WebhookFormat.lastDelivery(WebhookMeta(id: "c", deliveries: 2)), "2×")
    }

    func testDisplayURLStripsTheScheme() {
        XCTAssertEqual(WebhookFormat.displayURL("https://app.example.com/hook/t"), "app.example.com/hook/t")
        XCTAssertEqual(WebhookFormat.displayURL("http://127.0.0.1:8787/hook/t"), "127.0.0.1:8787/hook/t")
        XCTAssertEqual(WebhookFormat.displayURL("HTTPS://X.example/y"), "X.example/y")
        XCTAssertEqual(WebhookFormat.displayURL("ftp://x"), "ftp://x")
        XCTAssertNil(WebhookFormat.displayURL(nil))
    }

    func testTitleFallsBackForAnEmptyLabel() {
        XCTAssertEqual(WebhookFormat.title(WebhookMeta(id: "a", label: "  ")), "Untitled webhook")
        XCTAssertEqual(WebhookFormat.title(WebhookMeta(id: "a", label: "ping me")), "ping me")
    }
}
