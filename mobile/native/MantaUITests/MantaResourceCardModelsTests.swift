import XCTest
@testable import MantaUI

// ===========================================================================
// BET-627 — wire contract for the overflow-sheet resource cards.
//
// Pins the two RPC channels (schedule:list / secrets:list) and the decode of
// their payloads against the box (src/shared/types.ts + src/server/rpc.mjs),
// so a rename on either side fails the build instead of rendering an empty
// card on device.
// ===========================================================================

final class MantaResourceCardModelsTests: XCTestCase {

    private func json(_ text: String) throws -> Data {
        try Data(text.utf8)
    }

    func testDecodesScheduledJobPayload() throws {
        let payload = """
        {"result": [{
          "id": "a1b2c3d4",
          "cron": "0 9 * * 1-5",
          "prompt": "Summarise open PRs",
          "recurring": true,
          "label": "morning summary",
          "sessionID": "ses_1",
          "directory": "/home/dev/projects/manta",
          "createdAt": 1750000000000,
          "lastFiredMinute": "2026-08-03 09:00"
        }]}
        """
        let jobs = try MantaAPIClient.decode(json(payload), as: [ScheduledJob].self)
        let job = try XCTUnwrap(jobs?.first)
        XCTAssertEqual(job.id, "a1b2c3d4")
        XCTAssertEqual(job.cron, "0 9 * * 1-5")
        XCTAssertEqual(job.prompt, "Summarise open PRs")
        XCTAssertTrue(job.recurring)
        XCTAssertEqual(job.label, "morning summary")
        XCTAssertEqual(job.sessionID, "ses_1")
        XCTAssertEqual(job.lastFiredMinute, "2026-08-03 09:00")
    }

    func testDecodesSecretMetaPayloadWithKeyAndScope() throws {
        let payload = """
        {"result": [{
          "id": "ab12cd34",
          "key": "ANTHROPIC_API_KEY",
          "scope": "session",
          "sessionID": "ses_1",
          "project": null,
          "hint": "anthropic auth",
          "hasValue": true,
          "createdAt": 1750000000000,
          "updatedAt": 1750000000000
        }]}
        """
        let secrets = try MantaAPIClient.decode(json(payload), as: [SecretMeta].self)
        let secret = try XCTUnwrap(secrets?.first)
        XCTAssertEqual(secret.id, "ab12cd34")
        XCTAssertEqual(secret.key, "ANTHROPIC_API_KEY")
        XCTAssertEqual(secret.scope, "session")
        XCTAssertEqual(secret.sessionID, "ses_1")
        XCTAssertEqual(secret.hint, "anthropic auth")
        XCTAssertTrue(secret.hasValue)
    }

    func testListSchedulesRoutesToScheduleListChannel() throws {
        let url = try XCTUnwrap(URL(string: "https://0123abcd.boxes.mantaui.com"))
        let request = try MantaAPIClient.makeRequest(serverURL: url, channel: "schedule:list", args: ["ses_1"], token: "tok_abc")
        XCTAssertEqual(request.url?.path, "/rpc/schedule:list")
        let object = try XCTUnwrap(request.httpBody.map { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? nil)
        let args = try XCTUnwrap(object["args"] as? [String])
        XCTAssertEqual(args, ["ses_1"])
    }

    func testListSecretsRoutesToSecretsListChannel() throws {
        let url = try XCTUnwrap(URL(string: "https://0123abcd.boxes.mantaui.com"))
        let request = try MantaAPIClient.makeRequest(serverURL: url, channel: "secrets:list", args: ["ses_1"], token: "tok_abc")
        XCTAssertEqual(request.url?.path, "/rpc/secrets:list")
        let object = try XCTUnwrap(request.httpBody.map { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? nil)
        let args = try XCTUnwrap(object["args"] as? [String])
        XCTAssertEqual(args, ["ses_1"])
    }
}
