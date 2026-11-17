import XCTest
@testable import MantaUI

// ===========================================================================
// iOS stability — what the /events socket subscribes to and when it is open
// (spec 2026-11-17: C1, B2, B5, B6, B7). Pure logic only: no socket, no timer.
// ===========================================================================

@MainActor
final class MantaEventKindsTests: XCTestCase {
    func testUnionIsTheStoreKindsPlusEveryRegistration() {
        let union = MantaEventKinds.union(registrations: [["media"], ["widget", "media"], []])
        XCTAssertTrue(union.isSuperset(of: MantaEventKinds.storeOwned))
        XCTAssertTrue(union.contains("media"))
        XCTAssertTrue(union.contains("widget"))
        XCTAssertEqual(union.count, MantaEventKinds.storeOwned.count + 2)
    }

    func testStoreOwnedKindsCoverTheSubjectsTheStoreFeeds() {
        for kind in ["heartbeat", "runningSet", "stream", "delegate.updated", "delegate.approval.requested",
                     "progress.updated", "accounts.updated", "accounts.moved", "handoff"] {
            XCTAssertTrue(MantaEventKinds.storeOwned.contains(kind), kind)
        }
        XCTAssertFalse(MantaEventKinds.storeOwned.contains("pty"), "pty is requested only by a running sign-in flow")
        XCTAssertFalse(MantaEventKinds.storeOwned.contains("opencode"), "raw opencode events are never wanted")
    }

    func testQueryValueIsSortedAndCommaSeparated() {
        XCTAssertEqual(MantaEventKinds.queryValue(["stream", "heartbeat", "status"]), "heartbeat,status,stream")
    }

    func testKindsMessageIsTheC1Shape() throws {
        let text = MantaEventKinds.kindsMessage(["stream", "heartbeat"])
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "kinds")
        XCTAssertEqual(object["kinds"] as? [String], ["heartbeat", "stream"])
    }

    func testFocusMessageIsTheC1Shape() throws {
        let text = MantaEventKinds.focusMessage(["ses_1", "ses_2"])
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "focus")
        XCTAssertEqual(object["sessions"] as? [String], ["ses_1", "ses_2"])
        let none = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(MantaEventKinds.focusMessage([]).utf8)) as? [String: Any])
        XCTAssertEqual(none["sessions"] as? [String], [], "an empty focus means no heavy frames at all")
    }

    func testUrlCarriesTheKindsQuery() throws {
        let server = URL(string: "https://0123.boxes.mantaui.com")
        let url = try XCTUnwrap(MantaEventStore.eventsWebSocketURL(from: server, kinds: ["stream", "heartbeat"]))
        XCTAssertEqual(url.scheme, "wss")
        XCTAssertEqual(url.path, "/events")
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        XCTAssertEqual(items?.first(where: { $0.name == "kinds" })?.value, "heartbeat,stream")
    }

    func testUrlOmitsAKindsListTheBoxWouldIgnore() throws {
        let server = URL(string: "https://0123.boxes.mantaui.com")
        let tooMany = Set((0...MantaEventKinds.maxEntries).map { "k\($0)" })
        let url = try XCTUnwrap(MantaEventStore.eventsWebSocketURL(from: server, kinds: tooMany))
        XCTAssertNil(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        let bare = try XCTUnwrap(MantaEventStore.eventsWebSocketURL(from: server))
        XCTAssertEqual(bare.absoluteString, "wss://0123.boxes.mantaui.com/events")
    }

    /// The kinds are DERIVED from registrations, so a registration that forgot to declare them would silently
    /// subscribe to nothing. Every call site in the app must say which kinds it consumes.
    func testEveryRawFrameRegistrationDeclaresItsKinds() throws {
        let appDir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("MantaUI")
        let files = try FileManager.default.contentsOfDirectory(at: appDir, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
        XCTAssertFalse(files.isEmpty, "the app sources were not found next to the tests")
        var registrations = 0
        for url in files {
            let lines = try String(contentsOf: url, encoding: .utf8).components(separatedBy: "\n")
            for (index, line) in lines.enumerated() where line.contains("addRawFrameHandler") {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.hasPrefix("//") || line.contains("func addRawFrameHandler") { continue }
                registrations += 1
                // The argument list may wrap onto the next line.
                let window = lines[index...min(index + 1, lines.count - 1)].joined(separator: " ")
                XCTAssertTrue(window.contains("kinds:"), "\(url.lastPathComponent):\(index + 1) registers a handler without kinds")
            }
        }
        XCTAssertGreaterThanOrEqual(registrations, 9)
    }
}

@MainActor
final class MantaFocusSetTests: XCTestCase {
    func testTheUnionOfOwnersIsDeterministicAndDeduplicated() {
        var focus = MantaFocusSet()
        XCTAssertTrue(focus.set(owner: "b", sessions: ["ses_2", "ses_1"]))
        XCTAssertTrue(focus.set(owner: "a", sessions: ["ses_1", "ses_3"]))
        XCTAssertEqual(focus.sessions, ["ses_1", "ses_3", "ses_2"], "owners in key order, ids in the order given, no duplicates")
    }

    func testChangedIsFalseWhenTheUnionDoesNotMove() {
        var focus = MantaFocusSet()
        focus.set(owner: "a", sessions: ["ses_1"])
        XCTAssertFalse(focus.set(owner: "a", sessions: ["ses_1"]))
        XCTAssertFalse(focus.set(owner: "b", sessions: ["ses_1"]), "a second owner of the same session changes nothing")
        XCTAssertFalse(focus.remove(owner: "b"))
        XCTAssertTrue(focus.remove(owner: "a"))
        XCTAssertEqual(focus.sessions, [])
    }

    func testTheUnionIsCappedAtThirtyTwo() {
        var focus = MantaFocusSet()
        focus.set(owner: "a", sessions: (0..<40).map { "ses_\($0)" })
        XCTAssertEqual(focus.sessions.count, MantaFocusSet.maxSessions)
        XCTAssertEqual(focus.sessions.first, "ses_0")
    }

    func testEmptyIdsAreIgnored() {
        var focus = MantaFocusSet()
        focus.set(owner: "a", sessions: ["", "ses_1"])
        XCTAssertEqual(focus.sessions, ["ses_1"])
    }
}

@MainActor
final class MantaSocketLifecyclePolicyTests: XCTestCase {
    func testAfterTheGraceAwayTheSocketIsAlwaysReopened() {
        XCTAssertEqual(MantaForegroundPolicy.onForeground(awayFor: 5, connected: true, stale: false), .forceReconnect)
        XCTAssertEqual(MantaForegroundPolicy.onForeground(awayFor: 90, connected: true, stale: false), .forceReconnect)
    }

    func testAShortTripKeepsAHealthySocket() {
        XCTAssertEqual(MantaForegroundPolicy.onForeground(awayFor: 2, connected: true, stale: false), .keep)
        XCTAssertEqual(MantaForegroundPolicy.onForeground(awayFor: nil, connected: true, stale: false), .keep)
    }

    func testAShortTripReopensAnUnhealthySocket() {
        XCTAssertEqual(MantaForegroundPolicy.onForeground(awayFor: 2, connected: false, stale: false), .forceReconnect)
        XCTAssertEqual(MantaForegroundPolicy.onForeground(awayFor: 2, connected: true, stale: true), .forceReconnect)
    }

    func testTheBackgroundGraceIsFiveSeconds() {
        XCTAssertEqual(MantaForegroundPolicy.backgroundCloseGraceSeconds, 5)
    }

    func testDeadStatesAreRecoveredAfterTheStaleWindow() {
        let since = Date(timeIntervalSince1970: 1_000)
        let late = since.addingTimeInterval(46)
        let early = since.addingTimeInterval(44)
        XCTAssertTrue(MantaLivenessPolicy.shouldRecoverFromDeadState(state: .connecting(attempt: 0), since: since, now: late, staleMs: 45_000))
        XCTAssertTrue(MantaLivenessPolicy.shouldRecoverFromDeadState(state: .stalled, since: since, now: late, staleMs: 45_000))
        XCTAssertTrue(MantaLivenessPolicy.shouldRecoverFromDeadState(state: .closed(reason: "reconnect window exceeded"), since: since, now: late, staleMs: 45_000))
        XCTAssertFalse(MantaLivenessPolicy.shouldRecoverFromDeadState(state: .connecting(attempt: 0), since: since, now: early, staleMs: 45_000))
    }

    func testStatesTheAppChoseAreNeverRecovered() {
        let since = Date(timeIntervalSince1970: 1_000)
        let late = since.addingTimeInterval(600)
        for reason in [MantaCloseReason.noServer, MantaCloseReason.storeStopped, MantaCloseReason.background] {
            XCTAssertFalse(MantaLivenessPolicy.shouldRecoverFromDeadState(state: .closed(reason: reason), since: since, now: late, staleMs: 45_000), reason)
        }
        XCTAssertFalse(MantaLivenessPolicy.shouldRecoverFromDeadState(state: .reconnecting(attempt: 3, backoffMs: 8000), since: since, now: late, staleMs: 45_000),
                       "a reconnecting stream has its own backoff timer")
        XCTAssertFalse(MantaLivenessPolicy.shouldRecoverFromDeadState(state: .connected, since: since, now: late, staleMs: 45_000))
        XCTAssertFalse(MantaLivenessPolicy.shouldRecoverFromDeadState(state: .idle, since: since, now: late, staleMs: 45_000))
    }

    func testTheForegroundBackoffClimbsFromOneToThirtySeconds() {
        let backoff = ExponentialBackoff(base: 1000, max: 30_000, jitter: false)
        XCTAssertEqual(backoff.cappedDelayMs(forAttempt: 0), 1_000)
        XCTAssertEqual(backoff.cappedDelayMs(forAttempt: 3), 8_000)
        XCTAssertEqual(backoff.cappedDelayMs(forAttempt: 5), 30_000)
        XCTAssertEqual(backoff.cappedDelayMs(forAttempt: 50), 30_000)
        let jittered = ExponentialBackoff(base: 1000, max: 30_000)
        XCTAssertLessThanOrEqual(jittered.delayMs(forAttempt: 9, rng: { 0.999 }), 30_000)
    }
}

@MainActor
final class MantaPollPolicyTests: XCTestCase {
    func testTheIntervalsAreTheSpecifiedOnes() {
        XCTAssertEqual(MantaPollPolicy.branchSeconds, 15)
        XCTAssertEqual(MantaPollPolicy.forgeSeconds, 30)
        XCTAssertEqual(MantaPollPolicy.approvalsSeconds, 3)
        XCTAssertEqual(MantaPollPolicy.ageLabelSeconds, 10)
        XCTAssertEqual(MantaPollPolicy.artifactsSeconds, 5)
        XCTAssertEqual(MantaPollPolicy.usageAccountsSeconds, 60)
        XCTAssertEqual(BranchFreshnessPolicy.pollInterval, 15)
    }

    func testAPollRunsOnlyWhileTheAppIsActiveAndTheScreenIsInFront() {
        XCTAssertTrue(MantaPollPolicy.shouldRun(sceneActive: true, visible: true))
        XCTAssertTrue(MantaPollPolicy.shouldRun(sceneActive: true))
        XCTAssertFalse(MantaPollPolicy.shouldRun(sceneActive: false, visible: true))
        XCTAssertFalse(MantaPollPolicy.shouldRun(sceneActive: true, visible: false))
    }
}

// MARK: - Frame parsing (B2)

@MainActor
final class MantaFrameParseTests: XCTestCase {
    func testAnEscapedQuoteOrBraceInsideTheTextDoesNotConfuseTheScanner() throws {
        let text = #"{"kind":"stream","sub":"flush","sessionId":"ses_1","payload":{"messageID":"m","partID":"p","field":"text","text":"say \"hi\" } { ] \\ done"}}"#
        let frame = try MantaStreamFrame.parse(text)
        XCTAssertEqual(frame.kind, "stream")
        XCTAssertEqual(frame.sessionId, "ses_1")
        let payload = try XCTUnwrap(frame.decodedPayload(StreamFlushPayload.self))
        XCTAssertEqual(payload.text, #"say "hi" } { ] \ done"#)
    }

    func testFieldOrderDoesNotMatterAndInnerKeysNeverOverrideTheEnvelope() throws {
        let text = #"{"payload":{"kind":"inner","sessionId":"ses_inner","sub":"inner"},"sessionId":"ses_1","sub":"running","kind":"stream"}"#
        let frame = try MantaStreamFrame.parse(text)
        XCTAssertEqual(frame.kind, "stream")
        XCTAssertEqual(frame.sub, "running")
        XCTAssertEqual(frame.sessionId, "ses_1")
    }

    func testPrettyPrintedFramesParse() throws {
        let text = "{\n  \"kind\" : \"stream\",\n  \"sub\" : \"running\",\n  \"sessionId\" : \"ses_1\",\n  \"payload\" : { \"running\" : true }\n}"
        let frame = try MantaStreamFrame.parse(text)
        XCTAssertEqual(try XCTUnwrap(frame.decodedPayload(StreamRunningPayload.self)).running, true)
    }

    func testAHeartbeatHasNoPayload() throws {
        let frame = try MantaStreamFrame.parse(#"{"kind":"heartbeat","ts":1750000000000}"#)
        XCTAssertTrue(frame.isHeartbeat)
        XCTAssertNil(frame.payload)
        XCTAssertNil(frame.payloadData)
    }

    func testAnArrayPayloadStaysAvailableForTheStatusFrames() throws {
        let frame = try MantaStreamFrame.parse(#"{"kind":"status","payload":[{"session":"p","windowIndex":1,"running":true,"subagents":0}]}"#)
        guard case .array(let rows)? = frame.payload else { return XCTFail("expected an array payload") }
        XCTAssertEqual(rows.count, 1)
    }

    func testAnEmptyEnvelopeSessionIdFallsBackToThePayload() throws {
        let frame = try MantaStreamFrame.parse(#"{"kind":"opencode","sessionId":"","payload":{"type":"question.asked","properties":{"sessionID":"ses_p"}}}"#)
        XCTAssertEqual(frame.sessionId, "ses_p")
        XCTAssertEqual(frame.eventType, "question.asked")
    }

    func testAStringWithUnicodeAndEscapesRoundTrips() throws {
        let frame = try MantaStreamFrame.parse(#"{"kind":"stream","sub":"flush","sessionId":"ses_é","payload":{"messageID":"m","partID":"p","field":"text","text":"héllo ✓ \u00e9"}}"#)
        XCTAssertEqual(frame.sessionId, "ses_é")
        XCTAssertEqual(try XCTUnwrap(frame.decodedPayload(StreamFlushPayload.self)).text, "héllo ✓ é")
    }

    func testAnEscapedEnvelopeStringIsDecoded() throws {
        let frame = try MantaStreamFrame.parse(#"{"kind":"stream","sub":"run\u006eing","sessionId":"ses_1"}"#)
        XCTAssertEqual(frame.sub, "running")
    }

    func testMalformedFramesThrow() {
        XCTAssertThrowsError(try MantaStreamFrame.parse(""))
        XCTAssertThrowsError(try MantaStreamFrame.parse("{"))
        XCTAssertThrowsError(try MantaStreamFrame.parse(#"{"kind":"stream""#))
        XCTAssertThrowsError(try MantaStreamFrame.parse(#"{"kind":7}"#))
        XCTAssertThrowsError(try MantaStreamFrame.parse(#""kind""#))
    }

    func testTheFixtureInitialiserEncodesThePayloadOnce() throws {
        let frame = MantaStreamFrame(kind: "usage.alert", sub: nil, sessionId: nil,
                                     payload: .object(["a": .number(1), "b": .string("x")]), eventType: nil)
        XCTAssertEqual(frame.payload, .object(["a": .number(1), "b": .string("x")]))
        XCTAssertNil(MantaStreamFrame(kind: "x", sub: nil, sessionId: nil, payload: nil, eventType: nil).payload)
    }

    func testTheScannerFindsTheTopLevelValuesWithoutTouchingThePayload() throws {
        let data = Data(#"{"kind":"k","payload":{"a":[1,{"b":"}"}]},"sub":"s"}"#.utf8)
        let top = try XCTUnwrap(MantaFrameScanner.scan(data))
        XCTAssertEqual(MantaFrameScanner.string(top.kind, in: data), "k")
        XCTAssertEqual(MantaFrameScanner.string(top.sub, in: data), "s")
        XCTAssertNil(top.sessionId)
        let payload = try XCTUnwrap(top.payload)
        XCTAssertEqual(String(decoding: data.subdata(in: payload), as: UTF8.self), #"{"a":[1,{"b":"}"}]}"#)
    }

    func testWindowStatusCarriesAttentionBelow() throws {
        let frame = try MantaStreamFrame.parse(#"{"kind":"stream","sub":"windowStatus","sessionId":"ses_1","payload":{"running":false,"busy":true,"attention":null,"attentionBelow":"question","subagents":1,"stopped":false}}"#)
        let status = try XCTUnwrap(frame.decodedPayload(StreamWindowStatusPayload.self))
        XCTAssertNil(status.attention)
        XCTAssertEqual(status.attentionBelow, "question")
        XCTAssertEqual(status.waitingAttention, "question")
        let older = try XCTUnwrap(MantaStreamFrame.parse(#"{"kind":"stream","sub":"windowStatus","sessionId":"ses_1","payload":{"busy":true}}"#).decodedPayload(StreamWindowStatusPayload.self))
        XCTAssertNil(older.attentionBelow, "an older box sends none")
        XCTAssertNil(older.waitingAttention)
        XCTAssertEqual(StreamWindowStatusPayload(attention: "permission", attentionBelow: "question").waitingAttention, "permission")
    }
}
