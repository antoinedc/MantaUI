import XCTest
@testable import MantaUI

// ===========================================================================
// BET-752 (audit §4.4) — animation & streaming polish. Pure, no HTTP / view /
// AVAudioRecorder. The view-level seams that can't render a SwiftUI hierarchy
// (loading view choice, Reduce-Motion guard, caret insertion) are pinned here.
// ===========================================================================

final class PolishTests: XCTestCase {

    // MARK: - Task 3 — the loading state is the skeleton, not MantaLoader

    func testLoadingStateUsesSkeleton() {
        XCTAssertEqual(chatLoadingMode(isLoading: true), .skeleton)
        XCTAssertEqual(chatLoadingMode(isLoading: false), .content)
    }

    // MARK: - Task 4 — Reduce Motion

    func testLoaderAnimatesOnlyWhenReduceMotionOff() {
        XCTAssertTrue(MantaLoader.shouldAnimate(reduceMotion: false))
        XCTAssertFalse(MantaLoader.shouldAnimate(reduceMotion: true))
    }

    // MARK: - Task 6 — dictation inserts at the caret

    func testDictationInsertsAtCaretPosition() {
        let current = "hello world"
        // Caret right after "hello" (location 5, zero length).
        let result = ComposerView.inserting(" there", into: current, at: NSRange(location: 5, length: 0))
        XCTAssertEqual(result.newText, "hello there world")
        XCTAssertEqual(result.cursorLocation, 11, "the caret must land after the inserted text")
    }

    func testDictationReplacesSelection() {
        // "world" is selected (location 6, length 5) — dictation replaces it.
        let result = ComposerView.inserting("there", into: "hello world", at: NSRange(location: 6, length: 5))
        XCTAssertEqual(result.newText, "hello there")
        XCTAssertEqual(result.cursorLocation, 11)
    }

    // MARK: - Task 6 — liveText joins chunks with a paragraph break (text pop)

    func testLiveTextJoinsChunksWithParagraphBreak() {
        var state = MantaSessionStreamState(sessionId: "ses")
        state.chunks = [
            StreamTextChunk(partID: "a", messageID: "m1", field: "text", text: "para one"),
            StreamTextChunk(partID: "b", messageID: "m2", field: "text", text: "para two"),
        ]
        XCTAssertEqual(state.liveText, "para one\n\npara two")
    }
}
