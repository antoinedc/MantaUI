import XCTest
@testable import MantaUI

// ===========================================================================
// WS07 — the `artifacts:list` wire types. Derivation itself is pinned by the
// node tests in src/server/artifacts.test.mjs; these only prove the app DECODES
// what the box sends (including additive-wire tolerance) and classifies the
// "unknown channel" refusal of an older box. Pure — runs under `verify.sh`.
// ===========================================================================

final class ArtifactWireTests: XCTestCase {

    private func decode(_ json: String) throws -> ArtifactsListResult {
        try JSONDecoder().decode(ArtifactsListResult.self, from: Data(json.utf8))
    }

    private let example = #"""
    {
      "sessionId": "ses_1",
      "generatedAt": 1761650000000,
      "items": [
        {
          "id": "prt_9", "kind": "file", "origin": "agent", "label": "report.pdf",
          "href": "/home/dev/.manta-outbox/ses_1/report.pdf", "mime": "application/pdf",
          "size": 63488, "at": 1761649000000, "messageId": "msg_4", "context": null,
          "isHosted": false, "expiry": { "state": "live", "expiresAt": 1762253800000 }, "plan": null
        },
        {
          "id": "page:p", "kind": "link", "origin": "agent", "label": "p",
          "href": "https://box.example/pages/p", "mime": null, "size": null, "at": 1761648000000,
          "messageId": null, "context": "Here's your page", "isHosted": true,
          "expiry": { "state": "never", "expiresAt": null }, "plan": null
        },
        {
          "id": "plan:.opencode/plans/ship-it.md", "kind": "plan", "origin": "agent", "label": "ship it",
          "href": "/proj/.opencode/plans/ship-it.md", "mime": "text/markdown", "size": null,
          "at": 1761647000000, "messageId": "msg_2", "context": null, "isHosted": false, "expiry": null,
          "plan": { "status": "draft", "steps": 3, "pageUrl": "https://box.example/pages/plan-ses1",
                    "pageUrlReason": null, "fileAvailable": true }
        }
      ],
      "counts": { "link": 2, "image": 1, "file": 4, "plan": 1 },
      "degraded": []
    }
    """#

    func testDecodesTheServerExampleCompletely() throws {
        let result = try decode(example)
        XCTAssertEqual(result.sessionId, "ses_1")
        XCTAssertEqual(result.generatedAt, 1761650000000)
        XCTAssertEqual(result.counts, ArtifactCountsWire(link: 2, image: 1, file: 4, plan: 1))
        XCTAssertEqual(result.degraded, [])
        XCTAssertEqual(result.items.count, 3)

        let file = result.items[0]
        XCTAssertEqual(file.id, "prt_9")
        XCTAssertEqual(file.kind, .file)
        XCTAssertEqual(file.origin, .agent)
        XCTAssertEqual(file.label, "report.pdf")
        XCTAssertEqual(file.mime, "application/pdf")
        XCTAssertEqual(file.size, 63488)
        XCTAssertEqual(file.at, 1761649000000)
        XCTAssertEqual(file.messageId, "msg_4")
        XCTAssertNil(file.context)
        XCTAssertFalse(file.isHosted)
        XCTAssertEqual(file.expiry, ArtifactExpiry(state: .live, expiresAt: 1762253800000))
        XCTAssertNil(file.plan)

        let page = result.items[1]
        XCTAssertTrue(page.isHosted)
        XCTAssertEqual(page.expiry, ArtifactExpiry(state: .never, expiresAt: nil))
        XCTAssertEqual(page.context, "Here's your page")
        XCTAssertNil(page.mime)
        XCTAssertNil(page.size)

        let plan = result.items[2]
        XCTAssertEqual(plan.kind, .plan)
        XCTAssertNil(plan.expiry)
        XCTAssertEqual(plan.plan, ArtifactPlanInfo(status: .draft, steps: 3,
                                                   pageUrl: "https://box.example/pages/plan-ses1",
                                                   pageUrlReason: nil, fileAvailable: true))
        XCTAssertEqual(result.renderable.count, 3)
    }

    func testUnknownKindAndExpiryStateDecodeAsUnknownAndAreNotRendered() throws {
        let result = try decode(#"""
        { "sessionId": "s", "generatedAt": 1, "counts": {"link":0,"image":0,"file":1,"plan":0}, "degraded": [],
          "items": [
            { "id": "a", "kind": "hologram", "origin": "agent", "label": "x", "href": "/x", "at": 1 },
            { "id": "b", "kind": "file", "origin": "robot", "label": "y", "href": "/y", "at": 2,
              "expiry": { "state": "frozen", "expiresAt": 5 } },
            { "id": "c", "kind": "file", "origin": "agent", "label": "z", "href": "/z", "at": 3 }
          ] }
        """#)
        XCTAssertEqual(result.items.count, 3, "the decode does not fail")
        XCTAssertEqual(result.items[0].kind, .unknown)
        XCTAssertEqual(result.items[1].expiry?.state, .unknown)
        XCTAssertEqual(result.items[1].origin, .unknown)
        XCTAssertEqual(result.renderable.map(\.id), ["c"])
    }

    func testMissingOptionalFieldsDecodeWithDefaults() throws {
        let result = try decode(#"""
        { "items": [ { "id": "a", "kind": "link", "label": "l", "href": "https://x.example/" } ] }
        """#)
        XCTAssertEqual(result.degraded, [])
        XCTAssertEqual(result.counts, ArtifactCountsWire())
        let item = result.items[0]
        XCTAssertNil(item.context)
        XCTAssertNil(item.messageId)
        XCTAssertNil(item.size)
        XCTAssertNil(item.mime)
        XCTAssertNil(item.expiry)
        XCTAssertFalse(item.isHosted)
        XCTAssertEqual(item.at, 0)
    }

    func testPlanPageReasonsAndDegradedDecode() throws {
        let result = try decode(#"""
        { "sessionId": "s", "generatedAt": 1, "counts": {}, "degraded": ["public-address"],
          "items": [
            { "id": "p1", "kind": "plan", "label": "a", "href": "/a.md", "at": 1,
              "plan": { "status": "draft", "steps": 0, "pageUrl": null, "pageUrlReason": "other-session", "fileAvailable": false } },
            { "id": "p2", "kind": "plan", "label": "b", "href": "/b.md", "at": 2,
              "plan": { "status": "draft", "steps": 1, "pageUrl": null, "pageUrlReason": "no-public-address", "fileAvailable": true } },
            { "id": "p3", "kind": "plan", "label": "c", "href": "/c.md", "at": 3,
              "plan": { "status": "someday", "steps": 1, "pageUrl": null, "pageUrlReason": "brand-new-reason", "fileAvailable": true } }
          ] }
        """#)
        XCTAssertEqual(result.items[0].plan?.pageUrlReason, "other-session")
        XCTAssertNil(result.items[0].plan?.pageUrl)
        XCTAssertEqual(result.items[1].plan?.pageUrlReason, "no-public-address")
        XCTAssertEqual(result.items[2].plan?.pageUrlReason, "brand-new-reason")
        XCTAssertEqual(result.items[2].plan?.status, .unknown)
        XCTAssertEqual(result.degraded, ["public-address"])
    }

    func testDegradedFooterCopy() {
        XCTAssertNil(ArtifactDegradedCopy.footer([]))
        XCTAssertEqual(ArtifactDegradedCopy.footer(["public-address"]),
                       "Published pages are hidden — this box has no public address.")
        XCTAssertEqual(ArtifactDegradedCopy.footer(["outbox"]), "Some items couldn't be loaded.")
        XCTAssertEqual(ArtifactDegradedCopy.footer(["pages", "directory"]), "Some items couldn't be loaded.")
        XCTAssertEqual(ArtifactDegradedCopy.footer(["public-address", "outbox"]),
                       "Published pages are hidden — this box has no public address. Some items couldn't be loaded.")
    }

    func testCountsForKind() {
        let counts = ArtifactCountsWire(link: 1, image: 2, file: 3, plan: 4)
        XCTAssertEqual(counts.count(for: .link), 1)
        XCTAssertEqual(counts.count(for: .image), 2)
        XCTAssertEqual(counts.count(for: .file), 3)
        XCTAssertEqual(counts.count(for: .plan), 4)
        XCTAssertEqual(counts.count(for: .unknown), 0)
    }
}
