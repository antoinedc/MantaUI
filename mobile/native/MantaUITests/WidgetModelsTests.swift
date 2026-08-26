import XCTest
@testable import MantaUI

// BET-1326 — the pure widget logic: the live-window eviction decision, the
// reserved-box sizing, and the side-channel merge of widget refs into the
// transcript. Pure/derivable logic only, per the repo convention (no UI, no
// webview here — those live in MantaUI but are not unit-tested through).

final class WidgetLiveWindowTests: XCTestCase {

    // MARK: - Rule 1: cap at 2 (absolute, incl. tap-activated)

    func testCapAtTwoWhenNothingOnScreen() {
        var live = WidgetLiveWindow.resolve(existing: [], arriving: "a", onScreen: [])
        XCTAssertEqual(live, ["a"])
        live = WidgetLiveWindow.resolve(existing: live, arriving: "b", onScreen: [])
        XCTAssertEqual(live, ["a", "b"])
        // A third arrival evicts the OLDEST (a), keeping only the newest-2.
        live = WidgetLiveWindow.resolve(existing: live, arriving: "c", onScreen: [])
        XCTAssertEqual(live, ["b", "c"])
        XCTAssertEqual(live.count, WidgetLiveWindow.maxLive)
    }

    /// A tap-activated widget counts against the cap exactly like an arrival.
    func testTapActivationCountsAgainstCap() {
        // Two live already (nothing on screen). Tapping a third promotes it and
        // evicts the oldest.
        let live = WidgetLiveWindow.resolve(existing: ["a", "b"], arriving: "c", onScreen: [])
        XCTAssertEqual(live, ["b", "c"])
    }

    // MARK: - Rule 2: grant, don't recompute — nothing goes dead on screen

    /// An on-screen widget that is out of the newest-2 STAYS live; only when it
    /// also scrolls off-screen is it evicted.
    func testOnScreenWidgetOutOfNewestTwoStaysLive() {
        // Three were live at some point (a matured out of newest-2 but a third
        // came in), yet `a` is still on screen → keep it.
        let live = WidgetLiveWindow.resolve(existing: ["a", "b", "c"], arriving: nil, onScreen: ["a"])
        XCTAssertEqual(live, ["a", "b", "c"])
    }

    /// The very moment the on-screen widget ALSO scrolls off, it is (finally)
    /// evicted: eviction requires BOTH off-screen AND out of the newest-2.
    func testOffScreenOutOfNewestTwoIsEvicted() {
        let live = WidgetLiveWindow.resolve(existing: ["a", "b", "c"], arriving: nil, onScreen: [])
        XCTAssertEqual(live, ["b", "c"])
        XCTAssertFalse(live.contains("a"))
    }

    /// Re-resolving with the same inputs is a no-op — the window never flaps a
    /// live widget in and out on a scroll by itself.
    func testResolveIsStableUnderRepeatedCalls() {
        let a = WidgetLiveWindow.resolve(existing: ["a", "b"], arriving: nil, onScreen: ["a"])
        let b = WidgetLiveWindow.resolve(existing: ["a", "b"], arriving: nil, onScreen: ["a"])
        XCTAssertEqual(a, b)
    }

    /// The screen-protection rule is the ONLY thing that may hold the set above
    /// the cap (three widgets genuinely on screen: all three stay live, nothing
    /// is torn out from under the finger).
    func testScreenProtectionMayHoldAboveCap() {
        let live = WidgetLiveWindow.resolve(existing: ["a", "b", "c"], arriving: nil, onScreen: ["a", "b", "c"])
        XCTAssertEqual(live, ["a", "b", "c"])
    }

    // MARK: - Rule 3: session open activates only the newest

    /// Opening a session with several dormant (on-screen, not live) widgets
    /// activates ONLY the single arriving (newest) widget — one web content
    /// process on open, not everything in the viewport.
    func testSessionOpenActivatesOnlyNewest() {
        let live = WidgetLiveWindow.resolve(existing: [], arriving: "newest", onScreen: ["old1", "old2"])
        XCTAssertEqual(live, ["newest"])
    }

    // MARK: - Re-arrival / dedup / guards

    func testReannouncingAlreadyLiveWidgetIsNoOp() {
        let live = WidgetLiveWindow.resolve(existing: ["a"], arriving: "a", onScreen: [])
        XCTAssertEqual(live, ["a"])
    }

    func testEmptyArrivingIsIgnored() {
        let live = WidgetLiveWindow.resolve(existing: ["a"], arriving: "", onScreen: [])
        XCTAssertEqual(live, ["a"])
    }
}

final class WidgetMetricsTests: XCTestCase {

    private func ref(height: Double? = nil, width: Double? = nil, ratio: Double? = nil) -> WidgetRef {
        WidgetRef(id: "w", url: nil, title: nil, width: width, height: height,
                  aspectRatio: ratio, sessionId: "s", messageId: "m")
    }

    func testDeclaredHeightWins() {
        XCTAssertEqual(WidgetMetrics.height(ref: ref(height: 196, width: 300, ratio: 2), availableWidth: 320, maxWidth: 520), 196)
    }

    func testAspectRatioDerivesHeightFromWidth() {
        XCTAssertEqual(WidgetMetrics.height(ref: ref(ratio: 2), availableWidth: 400, maxWidth: 520), 200)
    }

    func testWidthCappedBeforeAspectDerivation() {
        XCTAssertEqual(WidgetMetrics.height(ref: ref(ratio: 2), availableWidth: 800, maxWidth: 520), 260)
    }

    func testDeclaredWidthFallsBackToSquare() {
        XCTAssertEqual(WidgetMetrics.height(ref: ref(width: 300), availableWidth: 320, maxWidth: 520), 300)
    }

    func testNoDimensionsFallsBackToDefault() {
        XCTAssertEqual(WidgetMetrics.height(ref: ref(), availableWidth: 320, maxWidth: 520), WidgetMetrics.defaultHeight)
    }

    func testNegativeAvailableWidthClamps() {
        XCTAssertEqual(WidgetMetrics.height(ref: ref(ratio: 2), availableWidth: -10, maxWidth: 520), 0)
    }
}

// MARK: - Side-channel merge into the transcript

final class WidgetMapperMergeTests: XCTestCase {

    private func textPart(_ id: String, _ messageID: String, _ text: String) -> OpencodePart {
        OpencodePart(type: "text", id: id, messageID: messageID, text: text)
    }

    private func message(id: String, role: String, parts: [OpencodePart], completed: Bool = true) -> OpencodeMessage {
        OpencodeMessage(
            info: OpencodeMessageInfo(
                id: id,
                sessionID: "ses",
                role: OpencodeRole(rawValue: role),
                time: OpencodeTime(created: 0, completed: completed ? 1 : nil),
                modelID: nil,
                providerID: nil
            ),
            parts: parts
        )
    }

    private func widget(id: String, messageId: String) -> WidgetRef {
        WidgetRef(id: id, url: nil, title: "Revenue by quarter", width: 520, height: 196,
                  aspectRatio: nil, sessionId: "ses", messageId: messageId)
    }

    /// A widget claimed onto its assistant message renders as a `.file(.widget)`
    /// block right after that message's prose.
    func testWidgetAttachesToItsAssistantMessage() {
        let msgs = [message(id: "m1", role: "assistant", parts: [textPart("p1", "m1", "Here's the chart.")])]
        let blocks = ChatTranscriptMapper.blocks(from: msgs, voiceNotes: [], widgets: [widget(id: "w1", messageId: "m1")])
        XCTAssertEqual(blocks.count, 2)
        guard case .file(let attachment) = blocks[1], case .widget(let ref) = attachment.kind else {
            return XCTFail("expected a .widget attachment block, got \(blocks[1])")
        }
        XCTAssertEqual(ref.id, "w1")
    }

    /// A widget whose message is outside the loaded window is dropped (it has
    /// no claim of its own) — matching the voice-note behaviour.
    func testWidgetForOutsideWindowIsDropped() {
        let msgs = [message(id: "m1", role: "assistant", parts: [textPart("p1", "m1", "Hello")])]
        let blocks = ChatTranscriptMapper.blocks(from: msgs, voiceNotes: [], widgets: [widget(id: "w9", messageId: "absent-msg")])
        XCTAssertEqual(blocks.count, 1) // only the prose
    }

    /// The no-side-channel call keeps working unchanged.
    func testNoWidgetsIsSameAsEmptyCollection() {
        let msgs = [message(id: "m1", role: "assistant", parts: [textPart("p1", "m1", "Hello")])]
        XCTAssertEqual(
            ChatTranscriptMapper.blocks(from: msgs),
            ChatTranscriptMapper.blocks(from: msgs, voiceNotes: [], widgets: [])
        )
    }

    /// buildWidgetMap groups widgets by message id.
    func testBuildWidgetMapGroupsByMessageId() {
        let map = ChatTranscriptMapper.buildWidgetMap([
            widget(id: "w1", messageId: "m1"),
            widget(id: "w2", messageId: "m1"),
            widget(id: "w3", messageId: "m2"),
        ])
        XCTAssertEqual(map["m1"]?.count, 2)
        XCTAssertEqual(map["m2"]?.count, 1)
        XCTAssertEqual(map["absent"], nil)
    }
}
