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
}
