import XCTest
@testable import MantaUI

// WS11 D8–D11 — decoding the box's transcript view. Foundation-only (Linux-eligible): the decode tests and the
// pieces that need no SwiftUI. Mapper/placement tests that need `ChatTranscriptMapper` live in TranscriptMapperTests
// (Mac).

final class TranscriptViewTests: XCTestCase {

    private func decode(_ json: String) throws -> [OpencodeMessage] {
        try JSONDecoder().decode([OpencodeMessage].self, from: Data(json.utf8))
    }

    private let info = #""info":{"id":"a1","sessionID":"s","role":"assistant"}"#

    func testAMessageWithoutAViewDecodesAsBefore() throws {
        let m = try decode(#"[{\#(info),"parts":[]}]"#)
        XCTAssertNil(m[0].view)
    }

    func testTurnAndTruncationDecode() throws {
        let json = #"[{\#(info),"parts":[],"view":{"turn":{"durationMs":4000,"tokens":42,"verbSeedId":"a0"},"truncation":{"kind":"output-cap","label":"truncated (output limit)","hint":"Ask to continue."}}}]"#
        let v = try XCTUnwrap(try decode(json)[0].view)
        XCTAssertEqual(v.turn, TranscriptTurnView(durationMs: 4000, tokens: 42, verbSeedId: "a0"))
        XCTAssertEqual(v.truncation, TranscriptTruncationView(kind: "output-cap", label: "truncated (output limit)", hint: "Ask to continue."))
    }

    func testNullDurationAndTokensDecodeAsNil() throws {
        let json = #"[{\#(info),"parts":[],"view":{"turn":{"durationMs":null,"tokens":null,"verbSeedId":"a1"}}}]"#
        let turn = try XCTUnwrap(try decode(json)[0].view?.turn)
        XCTAssertNil(turn.durationMs)
        XCTAssertNil(turn.tokens)
    }

    func testAMalformedViewNeverFailsTheMessageItRidesOn() throws {
        for bad in [#""view":"junk""#, #""view":[1,2]"#, #""view":{"turn":"x","truncation":7}"#, #""view":{"turn":{"verbSeedId":5}}"#, #""view":null"#] {
            let m = try decode(#"[{\#(info),"parts":[],\#(bad)}]"#)
            XCTAssertEqual(m[0].info.id, "a1", "the message survives: \(bad)")
            XCTAssertNil(m[0].view?.turn, bad)
            XCTAssertNil(m[0].view?.truncation, bad)
        }
    }

    func testAnEmptyHintIsNoHint() throws {
        let v = TranscriptTruncationView(kind: "output-cap", label: "L", hint: "")
        XCTAssertNil(v.hint)
        let json = #"[{\#(info),"parts":[],"view":{"truncation":{"kind":"output-cap","label":"L","hint":""}}}]"#
        XCTAssertNil(try decode(json)[0].view?.truncation?.hint)
    }

    func testTheStreamTruncationPayloadCarriesTheHint() throws {
        let p = try JSONDecoder().decode(StreamTruncationPayload.self, from: Data(#"{"kind":"output-cap","label":"L","hint":"H","messageID":"m"}"#.utf8))
        XCTAssertEqual(p.hint, "H")
        let old = try JSONDecoder().decode(StreamTruncationPayload.self, from: Data(#"{"kind":"output-cap","label":"L","messageID":"m"}"#.utf8))
        XCTAssertNil(old.hint)
    }

    func testTheMessagesRequestSendsViewOnlyWhenAsked() {
        // The option is the wire contract; `messages(... view:)` adds `view: true` and nothing else changes.
        // (Pinned end-to-end by MantaActionRPCWireTests on the Mac.)
        XCTAssertEqual(TranscriptTruncationKind(rawValue: "tool-cutoff"), .toolCutoff)
    }

    // MARK: - D9 media decode

    func testMediaEntriesDecodeAndAMalformedOneIsSkippedNotTheWholeList() throws {
        let json = #"[{\#(info),"parts":[],"view":{"media":[{"id":"media:h:a","kind":"image","path":"/a.png","mime":"image/png","width":null,"height":null,"aspectRatio":1.78,"count":null,"size":10,"title":null,"handle":"a"},"junk",{"kind":"image"},{"id":"media:s:m:/b.mp4","kind":"video","path":"/b.mp4"}]}}]"#
        let media = try XCTUnwrap(try decode(json)[0].view?.media)
        XCTAssertEqual(media.map(\.id), ["media:h:a", "media:s:m:/b.mp4"])
        XCTAssertEqual(media[0].aspectRatio, 1.78)
        XCTAssertEqual(media[1].kind, "video")
    }

    func testAMessageViewWithoutMediaHasAnEmptyList() throws {
        XCTAssertEqual(try decode(#"[{\#(info),"parts":[],"view":{}}]"#)[0].view?.media, [])
    }

    // MARK: - D10 plan question decode

    private func decodeQuestion(_ json: String) throws -> QuestionRequest {
        try JSONDecoder().decode(QuestionRequest.self, from: Data(json.utf8))
    }

    func testAQuestionWithAPlanDecodesIt() throws {
        let json = ##"{"id":"q1","sessionID":"s","questions":[],"tool":{"messageID":"m","callID":"c"},"plan":{"title":"Ship login","text":"# Ship login","steps":3,"files":2,"path":".opencode/plans/x.md","pageUrl":"https://b.example/pages/plan-s"}}"##
        let plan = try XCTUnwrap(try decodeQuestion(json).plan)
        XCTAssertEqual(plan, PlanQuestionView(title: "Ship login", text: "# Ship login", steps: 3, files: 2, path: ".opencode/plans/x.md", pageUrl: "https://b.example/pages/plan-s"))
    }

    func testAnOrdinaryQuestionAndAMalformedPlanBothDecodeWithNoPlan() throws {
        XCTAssertNil(try decodeQuestion(#"{"id":"q1","sessionID":"s","questions":[]}"#).plan)
        for bad in [#""plan":"junk""#, #""plan":{"text":"no title"}"#, #""plan":null"#] {
            let q = try decodeQuestion(#"{"id":"q1","sessionID":"s","questions":[],\#(bad)}"#)
            XCTAssertEqual(q.id, "q1", "the question stays answerable: \(bad)")
            XCTAssertNil(q.plan, bad)
        }
    }

    func testAPlanWithNoPathOrPageDecodesThoseAsNil() throws {
        let plan = try XCTUnwrap(try decodeQuestion(#"{"id":"q1","sessionID":"s","questions":[],"plan":{"title":"T","text":"","steps":0,"files":0,"path":null,"pageUrl":null}}"#).plan)
        XCTAssertNil(plan.path)
        XCTAssertNil(plan.pageUrl)
    }

    // MARK: - D11 runs: decode

    func testRunsDecodeAsFullViewsAndReferencesAndAMalformedOneIsSkipped() throws {
        let json = #"[{\#(info),"parts":[],"view":{"runs":[{"id":"t1","ownerMessageId":"a0","rev":{"epoch":"E1","gen":1,"seq":4},"label":"Read 3 files","calls":3,"failed":1,"tone":"warn","live":{"kind":"read","label":"Reading x.ts"},"segments":[{"id":"t1","label":"Read a file","calls":1,"failed":0,"tone":"ok","live":null},{"id":"t3","label":"Read 2 files","calls":2,"failed":1,"tone":"warn"}]},{"id":"t9","rev":{"epoch":"E1","gen":1,"seq":2},"ref":true},"junk",{"id":"bad"}]}}]"#
        let runs = try XCTUnwrap(try decode(json)[0].view?.runs)
        XCTAssertEqual(runs.count, 2)
        guard case .view(let full) = runs[0], case .ref(let ref) = runs[1] else { return XCTFail("expected [view, ref], got \(runs)") }
        XCTAssertEqual(full.id, "t1")
        XCTAssertEqual(full.ownerMessageId, "a0")
        XCTAssertEqual(full.rev, TranscriptRunRev(epoch: "E1", gen: 1, seq: 4))
        XCTAssertEqual(full.summary, TranscriptRunSummary(label: "Read 3 files", calls: 3, failed: 1, tone: .warn,
                                                         live: TranscriptLiveActivity(kind: .read, label: "Reading x.ts")))
        XCTAssertEqual(full.segments.map(\.id), ["t1", "t3"])
        XCTAssertEqual(full.summary(forSegment: "t3").label, "Read 2 files")
        XCTAssertEqual(full.summary(forSegment: nil).label, "Read 3 files", "no segment: the whole run speaks")
        XCTAssertEqual(ref.id, "t9")
    }

    func testAPartViewIsReadFromItsExtras() throws {
        let json = #"[{\#(info),"parts":[{"type":"tool","id":"t1","messageID":"a1","tool":"read","state":{"status":"completed"},"view":{"activity":{"kind":"read","status":"completed","label":"Read a.ts","target":"/w/a.ts","counted":true},"runId":"t1","segmentId":"t1","gen":2}},{"type":"tool","id":"t2","messageID":"a1","tool":"read","state":{}}]}]"#
        let parts = try decode(json)[0].parts
        let view = try XCTUnwrap(TranscriptPartView.of(parts[0]))
        XCTAssertEqual(view.activity, TranscriptActivityView(kind: .read, status: .completed, label: "Read a.ts", target: "/w/a.ts", counted: true))
        XCTAssertEqual(view.runId, "t1")
        XCTAssertEqual(view.segmentId, "t1")
        XCTAssertEqual(view.gen, 2)
        XCTAssertNil(TranscriptPartView.of(parts[1]), "a part the box did not stamp has no view")
    }

    func testAnUnknownKindFromANewerBoxReadsOther() throws {
        let a = try JSONDecoder().decode(TranscriptActivityView.self, from: Data(#"{"kind":"teleport","status":"running","label":"Teleporting"}"#.utf8))
        XCTAssertEqual(a.kind, .other)
        XCTAssertEqual(a.status, .running)
        XCTAssertTrue(a.counted)
    }

    // MARK: - D11 runs: the revision rules (TranscriptRunStore)

    private func run(_ id: String, _ label: String, epoch: String = "E1", gen: Int = 1, seq: Int = 1) -> TranscriptRunEntry {
        .view(TranscriptRunView(id: id, ownerMessageId: "m", rev: TranscriptRunRev(epoch: epoch, gen: gen, seq: seq),
                                summary: TranscriptRunSummary(label: label)))
    }

    private func known() -> TranscriptRunStore { TranscriptRunStore().settingEpoch("E1", connGen: 1) }
    private let ctx = TranscriptRunContext(currentEpoch: "E1", connGen: 1)

    func testAHigherSeqWinsAnEqualSeqWinsAndALowerSeqIsIgnored() {
        var s = known().merging([run("A", "one", seq: 2)], context: ctx)
        s = s.merging([run("A", "newer", seq: 3)], context: ctx)
        XCTAssertEqual(s.runs["A"]?.summary.label, "newer")
        XCTAssertEqual(s.merging([run("A", "newer", seq: 3)], context: ctx).runs["A"]?.summary.label, "newer")
        XCTAssertEqual(s.merging([run("A", "stale", seq: 1)], context: ctx), s, "a lower seq is ignored")
    }

    func testAValueOfAnotherEpochIsRejected() {
        XCTAssertTrue(known().merging([run("A", "old process", epoch: "E0", seq: 99)], context: ctx).runs.isEmpty)
    }

    func testAnAnswerIssuedUnderAnOlderConnectionIsDiscarded() {
        let late = TranscriptRunContext(currentEpoch: "E2", connGen: 2, issuedConnGen: 1)
        XCTAssertTrue(known().merging([run("A", "late")], context: late).runs.isEmpty)
    }

    func testAChangeOfEpochDropsOtherEpochRunsAndWritesBeforeTheEpochAreQueued() {
        var s = known().merging([run("A", "e1")], context: ctx)
        s = s.settingEpoch("E2", connGen: 2)
        XCTAssertTrue(s.runs.isEmpty)

        var early = TranscriptRunStore()
        early = early.merging([run("A", "early")], context: TranscriptRunContext(currentEpoch: nil, connGen: 1, issuedConnGen: 1))
        early = early.merging([run("B", "other", epoch: "E0")], context: TranscriptRunContext(currentEpoch: nil, connGen: 1))
        XCTAssertTrue(early.runs.isEmpty)
        early = early.settingEpoch("E1", connGen: 1)
        XCTAssertEqual(early.runs["A"]?.summary.label, "early")
        XCTAssertNil(early.runs["B"], "a queued value of another epoch is rejected through the same rule")
    }

    func testAReferenceNeverOverwritesAndNeverCreates() {
        var s = known().merging([run("A", "stored", seq: 2)], context: ctx)
        s = s.merging([.ref(TranscriptRunRef(id: "A", rev: TranscriptRunRev(epoch: "E1", gen: 1, seq: 9))),
                       .ref(TranscriptRunRef(id: "Z", rev: TranscriptRunRev(epoch: "E1", gen: 1, seq: 1)))], context: ctx)
        XCTAssertEqual(s.runs["A"]?.summary.label, "stored")
        XCTAssertNil(s.runs["Z"])
    }

    func testTheE1FetchE2ReconnectE1ResolvesSequenceKeepsE2() {
        var s = TranscriptRunStore().settingEpoch("E2", connGen: 2)
        s = s.merging([run("A", "from E2", epoch: "E2", seq: 3)], context: TranscriptRunContext(currentEpoch: "E2", connGen: 2))
        let after = s.merging([run("A", "from E1", epoch: "E1", seq: 50)],
                              context: TranscriptRunContext(currentEpoch: "E2", connGen: 2, issuedConnGen: 1))
        XCTAssertEqual(after, s)
        XCTAssertEqual(after.runs["A"]?.summary.label, "from E2")
    }

    func testARebuildDeletesTheRetiredIdAndRaisesMinGen() {
        var s = known().merging([run("A", "a"), run("B", "b")], context: ctx)
        s = s.retiring(["B"], gen: 2)
        XCTAssertNil(s.runs["B"])
        XCTAssertEqual(s.minGen, 2)
        s = s.merging([run("B", "resurrected", gen: 1, seq: 99)], context: ctx)
        XCTAssertNil(s.runs["B"], "a gen-1 value after a gen-2 rebuild is rejected")
        s = s.merging([run("A", "merged", gen: 2, seq: 3)], context: ctx)
        XCTAssertEqual(s.runs["A"]?.summary.label, "merged")
    }

    func testStaleMembershipIsDetectedFromAMessagesPartGens() throws {
        let json = #"[{\#(info),"parts":[{"type":"tool","id":"t1","messageID":"a1","tool":"read","state":{},"view":{"runId":"A","gen":1}}]}]"#
        let messages = try decode(json)
        XCTAssertFalse(TranscriptRunStore.hasStaleMembership(messages, minGen: 0))
        XCTAssertFalse(TranscriptRunStore.hasStaleMembership(messages, minGen: 1))
        XCTAssertTrue(TranscriptRunStore.hasStaleMembership(messages, minGen: 2))
    }

    // MARK: - D11 live frames (TranscriptLiveRunsState)

    private func frame(_ json: String) throws -> StreamToolRunsPayload {
        try JSONDecoder().decode(StreamToolRunsPayload.self, from: Data(json.utf8))
    }

    func testAToolRunsFrameDecodesTheOrderedLayoutAndTheCalls() throws {
        let p = try frame(#"{"epoch":"E1","full":true,"gen":1,"layout":[{"kind":"run","id":"A","segmentId":"A"},{"kind":"text","partID":"m:text:0","messageID":"m"},{"kind":"reasoning","partID":"m:reasoning:0","messageID":"m"},{"kind":"bogus"}],"runs":[{"id":"A","ownerMessageId":"m","rev":{"epoch":"E1","gen":1,"seq":2},"label":"Read a file","calls":1,"failed":0,"tone":"running","live":{"kind":"read","label":"Reading a.ts"}}],"closed":[],"parts":[{"id":"t1","callID":"c1","messageID":"m","runId":"A","tool":"read","status":"running","activity":{"kind":"read","status":"running","label":"Reading a.ts","target":"/w/a.ts","counted":true}}]}"#)
        XCTAssertEqual(p.layout, [.run(id: "A", segmentId: "A"), .text(partID: "m:text:0", messageID: "m"), .reasoning(partID: "m:reasoning:0", messageID: "m")],
                       "an unknown layout entry is dropped, never the frame")
        XCTAssertEqual(p.runs.count, 1)
        XCTAssertEqual(p.parts.first?.activity.label, "Reading a.ts")
        XCTAssertTrue(p.full)
        XCTAssertFalse(p.rebuilt)
    }

    func testTheLiveStateReplacesOnFullMergesOtherwiseAndRejectsAnotherEpoch() throws {
        let ctx1 = TranscriptRunContext(currentEpoch: "E1", connGen: 1)
        var state = TranscriptLiveRunsState().settingEpoch("E1", connGen: 1)
        state = state.applying(try frame(#"{"epoch":"E1","full":true,"gen":1,"layout":[{"kind":"run","id":"A","segmentId":"A"}],"runs":[{"id":"A","ownerMessageId":"m","rev":{"epoch":"E1","gen":1,"seq":1},"label":"Read a file","calls":1,"failed":0,"tone":"running"}],"closed":[],"parts":[{"id":"t1","messageID":"m","runId":"A","tool":"read","status":"running","activity":{"kind":"read","status":"running","label":"Reading a","target":"","counted":true}}]}"#), context: ctx1)
        XCTAssertEqual(state.parts.map(\.id), ["t1"])
        state = state.applying(try frame(#"{"epoch":"E1","full":false,"gen":1,"layout":[{"kind":"run","id":"A","segmentId":"A"},{"kind":"text","partID":"m:text:0","messageID":"m"}],"runs":[{"id":"A","ownerMessageId":"m","rev":{"epoch":"E1","gen":1,"seq":2},"label":"Read a file","calls":1,"failed":0,"tone":"ok"}],"closed":["A"],"parts":[{"id":"t1","messageID":"m","runId":"A","tool":"read","status":"completed","activity":{"kind":"read","status":"completed","label":"Read a","target":"","counted":true}}]}"#), context: ctx1)
        XCTAssertEqual(state.parts.count, 1, "parts are upserted by id")
        XCTAssertEqual(state.parts[0].status, "completed")
        XCTAssertEqual(state.closed, ["A"])
        XCTAssertEqual(state.layout.count, 2)
        XCTAssertEqual(state.store.runs["A"]?.rev.seq, 2)

        let foreign = state.applying(try frame(#"{"epoch":"E0","full":true,"gen":1,"layout":[],"runs":[],"closed":[],"parts":[]}"#), context: ctx1)
        XCTAssertEqual(foreign, state, "a frame of another epoch is a retired process's word")

        let reconnected = state.settingEpoch("E2", connGen: 2)
        XCTAssertTrue(reconnected.layout.isEmpty)
        XCTAssertTrue(reconnected.parts.isEmpty)
        XCTAssertTrue(reconnected.store.runs.isEmpty)
    }

    func testARebuiltFrameRetiresTheRunsAndCountsTheRebuild() throws {
        let ctx1 = TranscriptRunContext(currentEpoch: "E1", connGen: 1)
        var state = TranscriptLiveRunsState().settingEpoch("E1", connGen: 1)
        state = state.applying(try frame(#"{"epoch":"E1","full":true,"gen":1,"layout":[{"kind":"run","id":"A","segmentId":"A"},{"kind":"run","id":"B","segmentId":"B"}],"runs":[{"id":"A","ownerMessageId":"m","rev":{"epoch":"E1","gen":1,"seq":1},"label":"x","calls":1,"failed":0,"tone":"ok"},{"id":"B","ownerMessageId":"m2","rev":{"epoch":"E1","gen":1,"seq":2},"label":"y","calls":1,"failed":0,"tone":"ok"}],"closed":["A"],"parts":[]}"#), context: ctx1)
        state = state.applying(try frame(#"{"epoch":"E1","full":true,"rebuilt":true,"retired":["B"],"gen":2,"layout":[{"kind":"run","id":"A","segmentId":"A"}],"runs":[{"id":"A","ownerMessageId":"m","rev":{"epoch":"E1","gen":2,"seq":5},"label":"merged","calls":2,"failed":0,"tone":"ok"}],"closed":[],"parts":[]}"#), context: ctx1)
        XCTAssertNil(state.store.runs["B"])
        XCTAssertEqual(state.store.runs["A"]?.summary.label, "merged")
        XCTAssertEqual(state.store.minGen, 2)
        XCTAssertEqual(state.rebuildSeq, 1)
        XCTAssertEqual(state.lastRetired, ["B"])
    }

    // MARK: - D11 live placement rule

    func testThePlacementRuleWithReasoningShownAndHidden() {
        let layout: [LiveBlock] = [
            .run(id: "A", segmentId: "A"), .reasoning(partID: "r1", messageID: "m"), .run(id: "A", segmentId: "B"),
            .text(partID: "t1", messageID: "m"), .run(id: "C", segmentId: "C"),
        ]
        XCTAssertEqual(TranscriptLiveTailPlan.items(layout: layout, showReasoning: true), [
            .run(rowID: "run-A", runID: "A", segmentID: "A"), .reasoning(partID: "r1"), .run(rowID: "run-B", runID: "A", segmentID: "B"),
            .text(partID: "t1"), .run(rowID: "run-C", runID: "C", segmentID: "C"),
        ])
        XCTAssertEqual(TranscriptLiveTailPlan.items(layout: layout, showReasoning: false), [
            .run(rowID: "run-A", runID: "A", segmentID: nil), .text(partID: "t1"), .run(rowID: "run-C", runID: "C", segmentID: nil),
        ], "hidden: reasoning draws nothing and consecutive blocks of one run collapse at the FIRST (its id is the run id)")
    }

    // MARK: - The box's golden (src/server/transcriptView.test.mjs pins the box to the same file)

    func testTheBoxGoldenDecodesAndCarriesTheRulesTheBoxPins() throws {
        let scenarios = try TranscriptViewGolden.load()
        XCTAssertGreaterThanOrEqual(scenarios.count, 8)
        let multi = try XCTUnwrap(scenarios.first { $0.name.hasPrefix("a multi-step turn") })
        XCTAssertNil(multi.output.first { $0.info.id == "a1" }?.view)
        XCTAssertEqual(multi.output.first { $0.info.id == "a2" }?.view?.turn,
                       TranscriptTurnView(durationMs: 6000, tokens: 30, verbSeedId: "a1"))
        let running = try XCTUnwrap(scenarios.first { $0.name.hasPrefix("a still-running turn") })
        XCTAssertTrue(running.output.allSatisfy { $0.view == nil })
        let trunc = try XCTUnwrap(scenarios.first { $0.name.hasPrefix("truncation:") })
        XCTAssertEqual(trunc.output.compactMap { $0.view?.truncation?.kind }, ["output-cap", "tool-cutoff", "context-wall", "output-cap"])
        XCTAssertTrue(trunc.output.compactMap { $0.view?.truncation }.allSatisfy { $0.hint != nil })
    }
}

/// `Fixtures/transcript-view.golden.json`: raw messages + the box's `view` annotation for each scenario. A test resource
/// of the app's test bundle; a bare `swift test` has no resource bundle, so it falls back to the checkout the test was
/// compiled from.
struct TranscriptViewGolden: Decodable {
    var name: String
    var running: Bool
    var input: [OpencodeMessage]
    var output: [OpencodeMessage]

    static func load(file: StaticString = #filePath) throws -> [TranscriptViewGolden] {
        let data: Data
        if let url = Bundle(for: TranscriptViewTests.self).url(forResource: "transcript-view.golden", withExtension: "json") {
            data = try Data(contentsOf: url)
        } else {
            var url = URL(fileURLWithPath: "\(file)")
            url.deleteLastPathComponent()
            url.appendPathComponent("Fixtures/transcript-view.golden.json")
            data = try Data(contentsOf: url)
        }
        return try JSONDecoder().decode([TranscriptViewGolden].self, from: data)
    }
}
