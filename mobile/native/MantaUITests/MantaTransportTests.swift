import XCTest
@testable import MantaUI

final class MantaTransportTests: XCTestCase {

    override func tearDown() {
        try? KeychainCredentialStore().delete()
        super.tearDown()
    }

    private func json(_ text: String) throws -> Data {
        try Data(text.utf8)
    }

    func testDecodesRealCapturedSessionListPayload() throws {
        let payload = """
        {"result": [{
          "id": "ses_a12b",
          "directory": "/home/dev/projects/better-ui",
          "title": "better-ui",
          "parentID": "ses_p99",
          "cost": 0.00421,
          "tokens": { "input": 12345, "output": 987 },
          "model": { "id": "claude-sonnet-4-6", "providerID": "anthropic", "variant": "extended" },
          "time": { "created": 1750000000, "updated": 1750000123 }
        }]}
        """
        let sessions = try MantaAPIClient.decode(json(payload), as: [OpencodeSessionListItem].self)
        XCTAssertEqual(sessions?.count, 1)
        let session = try XCTUnwrap(sessions?.first)
        XCTAssertEqual(session.id, "ses_a12b")
        XCTAssertEqual(session.directory, "/home/dev/projects/better-ui")
        XCTAssertEqual(session.parentID, "ses_p99")
        XCTAssertEqual(session.cost, 0.00421)
        XCTAssertEqual(session.tokens?.input, 12345)
        XCTAssertEqual(session.tokens?.output, 987)
        XCTAssertEqual(session.model?.id, "claude-sonnet-4-6")
        XCTAssertEqual(session.model?.providerID, "anthropic")
        XCTAssertEqual(session.model?.variant, "extended")
        XCTAssertEqual(session.time?.created, 1750000000)
    }

    func testDecodesRealCapturedMessagesPayloadIncludingToolExtras() throws {
        let payload = """
        {"result": [
          {
            "info": { "id": "msg_1", "sessionID": "ses_a12b", "role": "user",
                      "time": { "created": 1750000000 } },
            "parts": [ { "type": "text", "id": "part_1", "messageID": "msg_1", "text": "hello" } ]
          },
          {
            "info": { "id": "msg_2", "sessionID": "ses_a12b", "role": "assistant",
                      "time": { "created": 1750000001, "completed": 1750000020 },
                      "modelID": "claude-sonnet-4-6", "providerID": "anthropic" },
            "parts": [
              { "type": "reasoning", "id": "part_2", "messageID": "msg_2", "text": "thinking..." },
              { "type": "text", "id": "part_3", "messageID": "msg_2", "text": "hello back" },
              { "type": "tool", "id": "part_4", "messageID": "msg_2", "tool": "Bash",
                "state": { "status": "completed",
                           "input": { "command": "ls" },
                           "metadata": { "output": "file1" } } }
            ]
          }
        ]}
        """
        let messages = try MantaAPIClient.decode(json(payload), as: [OpencodeMessage].self)
        XCTAssertEqual(messages?.count, 2)
        let first = try XCTUnwrap(messages?[0])
        XCTAssertEqual(first.info.role, .user)
        XCTAssertEqual(first.parts.first?.type, "text")
        XCTAssertEqual(first.parts.first?.text, "hello")

        let assistant = try XCTUnwrap(messages?[1])
        XCTAssertEqual(assistant.info.role, .assistant)
        XCTAssertEqual(assistant.info.modelID, "claude-sonnet-4-6")
        XCTAssertEqual(assistant.info.providerID, "anthropic")
        XCTAssertEqual(assistant.info.time?.completed, 1750000020)
        XCTAssertEqual(assistant.parts[1].text, "hello back")

        let toolPart = assistant.parts[2]
        XCTAssertEqual(toolPart.type, "tool")
        XCTAssertEqual(toolPart.extra["tool"], .string("Bash"))
        if case .object(let state) = toolPart.extra["state"] {
            XCTAssertEqual(state["status"], .string("completed"))
        } else {
            XCTFail("tool state extra not decoded as object")
        }
    }

    func testDecodesRealCapturedPermissionsPayload() throws {
        let payload = """
        {"result": [{
          "id": "per_a1",
          "sessionID": "ses_a12b",
          "permission": "Bash",
          "patterns": ["/tmp/*"],
          "always": ["./src/*"],
          "tool": { "messageID": "msg_2", "callID": "toolu_9" }
        }]}
        """
        let permissions = try MantaAPIClient.decode(json(payload), as: [PermissionRequest].self)
        let permission = try XCTUnwrap(permissions?.first)
        XCTAssertEqual(permission.id, "per_a1")
        XCTAssertEqual(permission.sessionID, "ses_a12b")
        XCTAssertEqual(permission.permission, "Bash")
        XCTAssertEqual(permission.patterns, ["/tmp/*"])
        XCTAssertEqual(permission.always, ["./src/*"])
        XCTAssertEqual(permission.tool?.messageID, "msg_2")
        XCTAssertEqual(permission.tool?.callID, "toolu_9")
    }

    func testDecodesRealCapturedQuestionsPayload() throws {
        let payload = """
        {"result": [{
          "id": "q_1",
          "sessionID": "ses_a12b",
          "requestId": "que_42",
          "questions": [
            {
              "question": "Which database should we use?",
              "header": "Pick a DB",
              "options": [
                { "label": "Postgres", "description": "default, reliable" },
                { "label": "SQLite", "description": "embedded" }
              ],
              "multiple": true,
              "custom": true
            }
          ],
          "tool": { "messageID": "msg_3", "callID": "toolu_10" }
        }]}
        """
        let questions = try MantaAPIClient.decode(json(payload), as: [QuestionRequest].self)
        let question = try XCTUnwrap(questions?.first)
        XCTAssertEqual(question.id, "q_1")
        XCTAssertEqual(question.requestId, "que_42")
        XCTAssertEqual(question.questions.count, 1)
        XCTAssertEqual(question.questions[0].header, "Pick a DB")
        XCTAssertEqual(question.questions[0].options[0].label, "Postgres")
        XCTAssertEqual(question.questions[0].multiple, true)
        XCTAssertEqual(question.questions[0].custom, true)
        XCTAssertEqual(question.tool?.callID, "toolu_10")
    }

    func testDecodesTopLevelStringResultForVcsBranch() throws {
        // `opencode:vcs-branch` returns a bare git branch name as a top-level
        // String inside the envelope. Regression: decode must round-trip it
        // instead of throwing (a top-level String is a JSON fragment).
        let payload = #"{"result": "main"}"#
        let branch = try MantaAPIClient.decode(json(payload), as: String?.self)
        XCTAssertEqual(branch, "main")
    }

    func testDecodesVoidResultPayloadsForWriteMethods() throws {
        let payload = #"{"result":null}"#
        let data = try json(payload)

        XCTAssertNoThrow(try MantaAPIClient.decode(data, as: SendPromptResult.self))
        XCTAssertNoThrow(try MantaAPIClient.decode(data, as: SendPromptResult.self))
        XCTAssertNoThrow(try MantaAPIClient.decode(data, as: SendPromptResult.self))
        XCTAssertNoThrow(try MantaAPIClient.decode(data, as: SendPromptResult.self))
        XCTAssertNoThrow(try MantaAPIClient.decode(data, as: SendPromptResult.self))
        XCTAssertNoThrow(try MantaAPIClient.decode(data, as: SendPromptResult.self))
    }

    /// `callRequired` turns this nil into a throw. The distinction is the whole
    /// bug: a null result folded into `[]` made an unanswered `tmux:list` look
    /// like a box with no sessions.
    func testNullResultDecodesToNilRatherThanAnEmptyList() throws {
        let decoded = try MantaAPIClient.decode(json(#"{"result": null}"#), as: [MantaProject].self)
        XCTAssertNil(decoded)
    }

    func testEmptyArrayResultDecodesToAnEmptyList() throws {
        let decoded = try MantaAPIClient.decode(json(#"{"result": []}"#), as: [MantaProject].self)
        XCTAssertEqual(decoded?.count, 0)
    }

    func testDecodesServerErrorEnvelope() throws {
        let payload = #"{"error":"opencode sendPrompt 500: oops"}"#
        XCTAssertThrowsError(try MantaAPIClient.decode(json(payload), as: [OpencodeMessage].self)) { error in
            guard case MantaError.server(let message) = error else {
                return XCTFail("expected server error, got \\(error)")
            }
            XCTAssertTrue(message.contains("oops"))
        }
    }

    func testSendPromptRequestCarriesBearerHeaderAndArgs() throws {
        let url = try XCTUnwrap(URL(string: "https://0123abcd.boxes.mantaui.com"))
        let input = SendPromptInput(
            sessionId: "ses_1",
            text: "run it",
            model: SendPromptInput.Model(providerID: "anthropic", modelID: "claude-sonnet-4-6"),
            attachments: [SendPromptInput.Attachment(remotePath: "/tmp/a.txt", mime: "text/plain", filename: "a.txt")]
        )
        let argsDict: [String: Any] = [
            "sessionId": "ses_1",
            "text": "run it",
            "model": ["providerID": "anthropic", "modelID": "claude-sonnet-4-6"],
            "attachments": [["remotePath": "/tmp/a.txt", "mime": "text/plain", "filename": "a.txt"]],
        ]
        let request = try MantaAPIClient.makeRequest(serverURL: url, channel: "opencode:prompt", args: [argsDict], token: "tok_abc")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok_abc")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request.url?.path, "/rpc/opencode:prompt")

        let body = try XCTUnwrap(request.httpBody)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let args = try XCTUnwrap(object["args"] as? [[String: Any]])
        XCTAssertEqual(args.count, 1)
        XCTAssertEqual(args[0]["sessionId"] as? String, "ses_1")
        XCTAssertEqual(args[0]["text"] as? String, "run it")
    }

    func testSendPromptRequestOmitsOptionalModelWhenNil() throws {
        let url = try XCTUnwrap(URL(string: "https://0123abcd.boxes.mantaui.com"))
        let argsDict: [String: Any] = ["sessionId": "ses_1", "text": "hi"]
        let request = try MantaAPIClient.makeRequest(serverURL: url, channel: "opencode:prompt", args: [argsDict], token: nil)
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))

        let body = try XCTUnwrap(request.httpBody)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let args = try XCTUnwrap(object["args"] as? [[String: Any]])
        XCTAssertNil(args[0]["model"])
        XCTAssertNil(args[0]["attachments"])
        XCTAssertNil(args[0]["mentions"])
    }

    func testTokenRoundTripsThroughKeychainAndIsAbsentFromUserDefaults() throws {
        let store = KeychainCredentialStore()
        try store.delete()
        XCTAssertNil(try store.load())

        let credentials = MantaCredentials(
            serverUrl: "https://0123abcd.boxes.mantaui.com",
            boxId: "0123abcd0123abcd0123abcd0123abcd",
            boxToken: "feedfacefeedfacefeedfacefeedface"
        )
        try store.save(credentials)

        let loaded = try store.load()
        XCTAssertEqual(loaded, credentials)
        XCTAssertEqual(store.boxToken, "feedfacefeedfacefeedfacefeedface")
        XCTAssertEqual(store.serverURL?.absoluteString, "https://0123abcd.boxes.mantaui.com")

        let defaultsStore = UserDefaults.standard.dictionaryRepresentation()
        let serialized = defaultsStore.values.map { String(describing: $0) }.joined(separator: "\n")
        XCTAssertFalse(serialized.contains("feedfacefeedfacefeedfacefeedface"), "boxToken leaked into UserDefaults")
        XCTAssertFalse(serialized.contains("0123abcd0123abcd0123abcd0123abcd"), "boxId leaked into UserDefaults")

        try store.delete()
        XCTAssertNil(try store.load())
    }

    // MARK: - Branch-freshness poll (BET-747 task 3)

    /// A tick with no prior fetch always refetches.
    func testBranchPollRefetchesWhenNeverFetched() {
        let now = Date(timeIntervalSince1970: 1_000)
        XCTAssertTrue(BranchFreshnessPolicy.shouldRefetchAfterTick(now: now, lastFetch: nil),
                      "the first tick with no prior fetch must refetch")
    }

    /// A tick before the 5s interval elapses does not refetch.
    func testBranchPollSkipsEarlyTick() {
        let lastFetch = Date(timeIntervalSince1970: 1_000)
        let early = lastFetch.addingTimeInterval(BranchFreshnessPolicy.pollInterval - 1)
        XCTAssertFalse(BranchFreshnessPolicy.shouldRefetchAfterTick(now: early, lastFetch: lastFetch))
    }

    /// A tick at/after the 5s interval refetches — the desktop's cadence, so a
    /// terminal-side checkout reflects within one tick.
    func testBranchPollRefetchesOnInterval() {
        let lastFetch = Date(timeIntervalSince1970: 1_000)
        let at = lastFetch.addingTimeInterval(BranchFreshnessPolicy.pollInterval)
        let later = lastFetch.addingTimeInterval(BranchFreshnessPolicy.pollInterval + 5)
        XCTAssertTrue(BranchFreshnessPolicy.shouldRefetchAfterTick(now: at, lastFetch: lastFetch))
        XCTAssertTrue(BranchFreshnessPolicy.shouldRefetchAfterTick(now: later, lastFetch: lastFetch))
    }

    /// A submit ALWAYS refetches, even immediately after a fetch (the 5s tick
    /// interval has not yet elapsed) — the next message may land on a freshly
    /// checked-out branch, so the submit edge can't wait for the next tick.
    func testBranchRefetchOnSubmitOverridesInterval() {
        let lastFetch = Date(timeIntervalSince1970: 1_000)
        XCTAssertTrue(
            BranchFreshnessPolicy.shouldRefresh(didSubmit: true, now: lastFetch.addingTimeInterval(1), lastFetch: lastFetch),
            "a submit must refetch even before the 5s interval elapses"
        )
    }

    /// A submit with no prior fetch also refetches.
    func testBranchRefetchOnSubmitWhenNeverFetched() {
        XCTAssertTrue(
            BranchFreshnessPolicy.shouldRefresh(didSubmit: true, now: Date(timeIntervalSince1970: 1_000), lastFetch: nil)
        )
    }

    /// A plain tick (didSubmit == false) still follows the 5s interval — it is
    /// not upgraded to an unconditional refetch by the submit path.
    func testBranchTickRespectsIntervalEvenWhenNotSubmit() {
        let lastFetch = Date(timeIntervalSince1970: 1_000)
        XCTAssertFalse(
            BranchFreshnessPolicy.shouldRefresh(didSubmit: false, now: lastFetch.addingTimeInterval(1), lastFetch: lastFetch)
        )
        XCTAssertTrue(
            BranchFreshnessPolicy.shouldRefresh(didSubmit: false, now: lastFetch.addingTimeInterval(5), lastFetch: lastFetch)
        )
    }
}

private struct SendPromptResult: Decodable {}
