import XCTest
@testable import MantaUI

// `BoxViewFixture` stamps a turn footer / truncation onto raw mapper fixtures with the box's rules. This ties it to the
// box: src/server/transcriptView.test.mjs pins `annotateView` to Fixtures/transcript-view.golden.json, and this test pins
// the stamper to the same file, so a rule changed in transcriptView.mjs fails the node test and then this one (update
// the stamper alongside the golden).
final class BoxViewFixtureParityTests: XCTestCase {
    func testTheStamperProducesWhatTheBoxProducesForEveryGoldenScenario() throws {
        let scenarios = try TranscriptViewGolden.load()
        XCTAssertFalse(scenarios.isEmpty)
        for scenario in scenarios {
            let stamped = BoxViewFixture.stamp(scenario.input, running: scenario.running)
            XCTAssertEqual(stamped.map(\.info.id), scenario.output.map(\.info.id), scenario.name)
            for (mine, boxes) in zip(stamped, scenario.output) {
                XCTAssertEqual(mine.view?.turn, boxes.view?.turn, "\(scenario.name) — turn of \(mine.info.id)")
                XCTAssertEqual(mine.view?.truncation, boxes.view?.truncation, "\(scenario.name) — truncation of \(mine.info.id)")
            }
        }
    }

    /// The run membership the stamper gives equals the box's, for every golden scenario: which run each tool part is in, its
    /// segment, and which message owns each run.
    func testTheRunStamperAssignsTheSameMembershipAsTheBox() throws {
        for scenario in try TranscriptViewGolden.load() {
            let stamped = BoxViewFixture.stampRuns(scenario.input)
            XCTAssertEqual(stamped.map(\.info.id), scenario.output.map(\.info.id), scenario.name)
            for (mine, boxes) in zip(stamped, scenario.output) {
                for (a, b) in zip(mine.parts, boxes.parts) {
                    XCTAssertEqual(a.id, b.id, scenario.name)
                    XCTAssertEqual(TranscriptPartView.of(a)?.runId, TranscriptPartView.of(b)?.runId, "\(scenario.name) — run of \(a.id)")
                    XCTAssertEqual(TranscriptPartView.of(a)?.segmentId, TranscriptPartView.of(b)?.segmentId, "\(scenario.name) — segment of \(a.id)")
                    XCTAssertEqual(TranscriptPartView.of(a)?.activity?.kind, TranscriptPartView.of(b)?.activity?.kind, "\(scenario.name) — kind of \(a.id)")
                }
                func owners(_ m: OpencodeMessage) -> [String: String] {
                    var out: [String: String] = [:]
                    for case .view(let v) in m.view?.runs ?? [] { out[v.id] = v.ownerMessageId }
                    return out
                }
                XCTAssertEqual(owners(mine), owners(boxes), "\(scenario.name) — owners on \(mine.info.id)")
                func segmentIDs(_ m: OpencodeMessage) -> [String: [String]] {
                    var out: [String: [String]] = [:]
                    for case .view(let v) in m.view?.runs ?? [] { out[v.id] = v.segments.map(\.id) }
                    return out
                }
                XCTAssertEqual(segmentIDs(mine), segmentIDs(boxes), "\(scenario.name) — segments on \(mine.info.id)")
            }
        }
    }

    /// The kinds the phone BRANCHES ON (`task`, `delegate`, `patch`) are not in the golden's scenarios, so they are pinned
    /// here against the box's rule (transcriptRuns.mjs `describeTool` / `describePatch`): a stamper that drifts on one of
    /// them fails here, not in an unrelated mapper test.
    func testTheRunStamperGivesTheBoxsKindToTaskDelegateAndPatchCalls() throws {
        func tool(_ id: String, _ name: String) -> OpencodePart {
            OpencodePart(type: "tool", id: id, messageID: "a1", extra: ["tool": .string(name), "state": .object(["status": .string("completed")])])
        }
        let patch = OpencodePart(type: "patch", id: "p1", messageID: "a1", extra: ["files": .array([.string("/w/a.ts")])])
        let message = OpencodeMessage(
            info: OpencodeMessageInfo(id: "a1", sessionID: "ses", role: OpencodeRole(rawValue: "assistant"),
                                      time: OpencodeTime(created: 0, completed: 1), modelID: nil, providerID: nil),
            parts: [tool("t1", "task"), tool("t2", "delegate_delegate"), tool("t3", "MCP_delegate"), tool("t4", "bash"),
                    tool("t5", "delegate_list"), tool("t6", "mystery"), patch]
        )
        let stamped = BoxViewFixture.stampRuns([message])
        guard stamped.count == 1, stamped[0].parts.count == 7 else { return XCTFail("expected one message of seven parts, got \(stamped)") }
        let kinds = stamped[0].parts.map { TranscriptPartView.of($0)?.activity?.kind }
        let expected: [ActivityKind?] = [.task, .delegate, .delegate, .bash, .other, .other, .patch]
        XCTAssertEqual(kinds, expected)
    }
}
