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
}
