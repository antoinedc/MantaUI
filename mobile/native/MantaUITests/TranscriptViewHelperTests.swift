import SwiftUI
import XCTest
@testable import MantaUI

// The SwiftUI-side helpers of the transcript changes (Mac only: SwiftUI / Combine).

@MainActor
final class TranscriptViewHelperTests: XCTestCase {

    func testAttributedTextLinksOnlyTheUrlAndKeepsEverythingElse() throws {
        let attributed = TranscriptLinkify.attributed("see https://a.com/x. ok", linkColor: .blue)
        XCTAssertEqual(String(attributed.characters), "see https://a.com/x. ok")
        let linked = attributed.runs.compactMap { run in run.link.map { (String(attributed[run.range].characters), $0) } }
        XCTAssertEqual(linked.count, 1)
        XCTAssertEqual(linked.first?.0, "https://a.com/x")
        XCTAssertEqual(linked.first?.1.absoluteString, "https://a.com/x")
    }

    func testLinkFreeTextHasNoLinkRuns() {
        let attributed = TranscriptLinkify.attributed("nothing to see", linkColor: .blue)
        XCTAssertTrue(attributed.runs.allSatisfy { $0.link == nil })
        XCTAssertEqual(String(attributed.characters), "nothing to see")
    }

    // MARK: - Expanded user prompts

    func testExpansionIsKeyedByRowIdAndSurvivesAFreshCell() {
        let store = TranscriptExpansionStore()
        let row = TranscriptBlock.user("a long prompt", at: Date(timeIntervalSince1970: 100)).stableScrollID
        let other = TranscriptBlock.user("another", at: Date(timeIntervalSince1970: 100)).stableScrollID
        XCTAssertFalse(store.isExpanded(row))
        store.toggle(row)
        XCTAssertTrue(store.isExpanded(row))
        XCTAssertFalse(store.isExpanded(other))
        // The same block re-derives the same id after a refetch, so the choice holds.
        let again = TranscriptBlock.user("a long prompt", at: Date(timeIntervalSince1970: 100)).stableScrollID
        XCTAssertTrue(store.isExpanded(again))
        store.toggle(row)
        XCTAssertFalse(store.isExpanded(row))
    }
}
