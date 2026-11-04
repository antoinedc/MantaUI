import XCTest
@testable import MantaUI

// A long user prompt is clamped to four lines with a Show more / Show less toggle.
// The decisions are pure (UserPromptClamp). Where "expanded" lives (a store keyed by the
// row's stable id, so a recycled cell does not forget it) is in TranscriptViewHelperTests.

final class UserPromptClampTests: XCTestCase {

    func testTheClampIsFourLines() {
        XCTAssertEqual(UserPromptClamp.lineLimit, 4)
    }

    func testOnlyTextThatCouldRunPastFourLinesIsMeasured() {
        XCTAssertFalse(UserPromptClamp.mayOverflow("ok"))
        XCTAssertFalse(UserPromptClamp.mayOverflow("run the tests please"))
        XCTAssertTrue(UserPromptClamp.mayOverflow("a\nb"))
        XCTAssertTrue(UserPromptClamp.mayOverflow(String(repeating: "word ", count: 20)))
    }

    func testOverflowIsTheWholeTextBeingTallerThanWhatIsShown() {
        XCTAssertTrue(UserPromptClamp.overflows(fullHeight: 160, visibleHeight: 90))
        // Four lines or fewer: the two measure the same, within a point of rounding.
        XCTAssertFalse(UserPromptClamp.overflows(fullHeight: 90, visibleHeight: 90))
        XCTAssertFalse(UserPromptClamp.overflows(fullHeight: 90.8, visibleHeight: 90))
        // Nothing is measured yet: no toggle rather than a flash of one.
        XCTAssertFalse(UserPromptClamp.overflows(fullHeight: 160, visibleHeight: 0))
        XCTAssertFalse(UserPromptClamp.overflows(fullHeight: 0, visibleHeight: 0))
    }

    func testShortPromptsShowNoToggleAndAnExpandedOneAlwaysDoes() {
        XCTAssertFalse(UserPromptClamp.showsToggle(expanded: false, overflows: false))
        XCTAssertTrue(UserPromptClamp.showsToggle(expanded: false, overflows: true))
        XCTAssertTrue(UserPromptClamp.showsToggle(expanded: true, overflows: false))
        XCTAssertTrue(UserPromptClamp.showsToggle(expanded: true, overflows: true))
    }

    func testToggleLabels() {
        XCTAssertEqual(UserPromptClamp.toggleLabel(expanded: false), "Show more")
        XCTAssertEqual(UserPromptClamp.toggleLabel(expanded: true), "Show less")
    }
}
