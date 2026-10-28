import XCTest
@testable import MantaUI

// WS01 — the pure transcript-parity logic. Foundation-only: this file runs
// under `mobile/native/verify.sh` on Linux as well as on the Mac. Everything
// that needs `TranscriptBlock` (SwiftUI) is in TranscriptMapperTests.swift.

final class TranscriptParityTests: XCTestCase {

    // MARK: - Fixtures

    private func message(
        _ id: String,
        role: String,
        created: Double? = nil,
        completed: Double? = nil,
        tokens: OpencodeTokenUsage? = nil,
        finish: String? = nil,
        parts: [OpencodePart] = []
    ) -> OpencodeMessage {
        OpencodeMessage(
            info: OpencodeMessageInfo(
                id: id,
                sessionID: "ses",
                role: OpencodeRole(rawValue: role),
                time: OpencodeTime(created: created, completed: completed),
                modelID: nil,
                providerID: nil,
                tokens: tokens,
                finish: finish
            ),
            parts: parts
        )
    }

    private func toolPart(_ id: String, _ messageID: String, tool: String, status: String = "completed",
                          input: [String: JSONValue] = [:], output: String? = nil) -> OpencodePart {
        var state: [String: JSONValue] = ["status": .string(status), "input": .object(input)]
        if let output { state["output"] = .string(output) }
        return OpencodePart(type: "tool", id: id, messageID: messageID, extra: [
            "tool": .string(tool),
            "state": .object(state),
        ])
    }

    private func beginPart(_ id: String, _ messageID: String, handle: String,
                           input: [String: JSONValue] = ["kind": .string("image"), "aspectRatio": .number(16.0 / 9.0), "title": .string("Cat")]) -> OpencodePart {
        toolPart(id, messageID, tool: "media_begin", input: input,
                 output: "Placeholder reserved. Handle: \(handle). Keep it and pass it to media_show once the media file exists.")
    }

    private func showPart(_ id: String, _ messageID: String, handle: String?, path: String,
                          dims: String = " 600x600", mime: String = "image/png", size: Int = 1234) -> OpencodePart {
        var input: [String: JSONValue] = ["path": .string(path)]
        if let handle { input["handle"] = .string(handle) }
        return toolPart(id, messageID, tool: "media_show", input: input,
                        output: "Displayed \(path) (\(mime)\(dims), \(size) bytes) in the transcript.")
    }

    private func filePart(_ id: String, _ messageID: String, url: String?, filename: String? = nil, mime: String? = "image/png") -> OpencodePart {
        var extra: [String: JSONValue] = [:]
        if let url { extra["url"] = .string(url) }
        if let filename { extra["filename"] = .string(filename) }
        if let mime { extra["mime"] = .string(mime) }
        return OpencodePart(type: "file", id: id, messageID: messageID, extra: extra)
    }

    private let t0 = Date(timeIntervalSince1970: 1_000)

    // MARK: - Live reducer

    func testBeginCreatesPendingEntryOwnedByTheBeginMessage() {
        var state = TranscriptMediaSessionState()
        state.apply(TranscriptMediaFrame(action: "begin", handle: "h1", sessionID: "s", messageID: "A", kind: "video",
                                         width: 1920, height: 1080, count: 3, title: "Clip"), now: t0)
        let e = try? XCTUnwrap(state.byID["media:h:h1"])
        XCTAssertEqual(e?.state, .pending)
        XCTAssertEqual(e?.ownerMessageID, "A")
        XCTAssertEqual(e?.kind, .video)
        XCTAssertEqual(e?.reserved, TranscriptMediaGeometryInput(width: 1920, height: 1080))
        XCTAssertEqual(e?.count, 3)
        XCTAssertEqual(e?.title, "Clip")
        XCTAssertEqual(e?.beganAt, t0)
        XCTAssertEqual(state.byID.count, 1)
    }

    func testBeginInAThenShowInBIsOneEntryWithTheBeginsOwnerAndReservedBox() {
        var state = TranscriptMediaSessionState()
        state.apply(TranscriptMediaFrame(action: "begin", handle: "h1", messageID: "A", kind: "image", aspectRatio: 16.0 / 9.0), now: t0)
        state.apply(TranscriptMediaFrame(action: "show", handle: "h1", messageID: "B", width: 600, height: 600,
                                         path: "/home/u/cat.png", mime: "image/png", size: 4096), now: t0)
        XCTAssertEqual(state.byID.count, 1, "begin and show for one handle is ONE card")
        guard let e = state.byID["media:h:h1"] else { return XCTFail("missing entry") }
        XCTAssertEqual(e.ownerMessageID, "A", "the placeholder never moves")
        XCTAssertEqual(e.state, .ready)
        XCTAssertEqual(e.path, "/home/u/cat.png")
        XCTAssertEqual(e.mime, "image/png")
        XCTAssertEqual(e.size, 4096)
        XCTAssertEqual(e.reserved, TranscriptMediaGeometryInput(aspectRatio: 16.0 / 9.0), "a show never rewrites the reserved box")
    }

    func testBeginThenFailKeepsTheReservedBox() {
        var state = TranscriptMediaSessionState()
        state.apply(TranscriptMediaFrame(action: "begin", handle: "h1", messageID: "A", width: 800, height: 400), now: t0)
        state.apply(TranscriptMediaFrame(action: "fail", handle: "h1", messageID: "A"), now: t0)
        XCTAssertEqual(state.byID["media:h:h1"]?.state, .failed)
        XCTAssertEqual(state.byID["media:h:h1"]?.reserved, TranscriptMediaGeometryInput(width: 800, height: 400))
    }

    func testLateFailDoesNotUndoAShow() {
        var state = TranscriptMediaSessionState()
        state.apply(TranscriptMediaFrame(action: "begin", handle: "h1", messageID: "A"), now: t0)
        state.apply(TranscriptMediaFrame(action: "show", handle: "h1", messageID: "B", path: "/p.png"), now: t0)
        state.apply(TranscriptMediaFrame(action: "fail", handle: "h1", messageID: "A"), now: t0)
        XCTAssertEqual(state.byID["media:h:h1"]?.state, .ready)
    }

    func testShowWithNoHandleAndNoPriorEntryIsReadyOwnedByTheShowMessage() {
        var state = TranscriptMediaSessionState()
        state.apply(TranscriptMediaFrame(action: "show", messageID: "B", width: 640, height: 480, path: "/home/u/a.png", mime: "image/png", size: 10), now: t0)
        guard let e = state.byID["media:s:B:/home/u/a.png"] else { return XCTFail("missing entry") }
        XCTAssertEqual(e.state, .ready)
        XCTAssertEqual(e.ownerMessageID, "B")
        XCTAssertEqual(e.reserved, TranscriptMediaGeometryInput(width: 640, height: 480))
    }

    func testVideoShowWithNullDimensionsReservesNothingSoTheBoxIsSixteenByNine() {
        var state = TranscriptMediaSessionState()
        state.apply(TranscriptMediaFrame(action: "show", messageID: "B", path: "/home/u/a.mp4", mime: "video/mp4"), now: t0)
        guard let e = state.byID["media:s:B:/home/u/a.mp4"] else { return XCTFail("missing entry") }
        XCTAssertEqual(e.kind, .video)
        XCTAssertEqual(e.reserved, TranscriptMediaGeometryInput())
        XCTAssertEqual(TranscriptMediaGeometry.aspect(e.reserved), 16.0 / 9.0, accuracy: 0.0001)
    }

    func testUnknownActionAndUnidentifiableFramesChangeNothing() {
        var state = TranscriptMediaSessionState()
        state.apply(TranscriptMediaFrame(action: "explode", handle: "h1"), now: t0)
        state.apply(TranscriptMediaFrame(action: "begin"), now: t0)          // no handle
        state.apply(TranscriptMediaFrame(action: "show", handle: "h1"), now: t0)  // no path
        state.apply(TranscriptMediaFrame(action: "fail"), now: t0)           // no handle
        XCTAssertEqual(state, TranscriptMediaSessionState())
        XCTAssertEqual(state.currentTurn, 0, "an ignored frame opens no turn")
    }

    func testSeqIncreasesByFirstSightAndASecondFrameKeepsIt() {
        var state = TranscriptMediaSessionState()
        state.apply(TranscriptMediaFrame(action: "begin", handle: "a", messageID: "A"), now: t0)
        state.apply(TranscriptMediaFrame(action: "begin", handle: "b", messageID: "A"), now: t0)
        state.apply(TranscriptMediaFrame(action: "show", handle: "a", messageID: "A", path: "/a.png"), now: t0)
        XCTAssertEqual(state.byID["media:h:a"]?.seq, 0)
        XCTAssertEqual(state.byID["media:h:b"]?.seq, 1)
        XCTAssertEqual(state.vended().map(\.id), ["media:h:a", "media:h:b"])
    }

    func testADuplicateBeginDoesNotRewriteOwnerOrGeometry() {
        var state = TranscriptMediaSessionState()
        state.apply(TranscriptMediaFrame(action: "begin", handle: "h", messageID: "A", width: 100, height: 100), now: t0)
        state.apply(TranscriptMediaFrame(action: "begin", handle: "h", messageID: "Z", width: 900, height: 100), now: t0)
        XCTAssertEqual(state.byID["media:h:h"]?.ownerMessageID, "A")
        XCTAssertEqual(state.byID["media:h:h"]?.reserved, TranscriptMediaGeometryInput(width: 100, height: 100))
    }

    // MARK: Turns

    func testObserveRunningOpensOneTurnPerRunningEdge() {
        var state = TranscriptMediaSessionState()
        state.observeRunning(true)
        state.observeRunning(true)
        XCTAssertEqual(state.currentTurn, 1)
        XCTAssertTrue(state.turnOpen)
        state.observeRunning(false)
        state.observeRunning(false)
        XCTAssertEqual(state.currentTurn, 1)
        XCTAssertFalse(state.turnOpen)
        state.observeRunning(true)
        XCTAssertEqual(state.currentTurn, 2)
    }

    func testAFrameBeforeTheRunningEdgeIsStillCurrentTurnWithNoDoubleIncrement() {
        var state = TranscriptMediaSessionState()
        state.apply(TranscriptMediaFrame(action: "begin", handle: "h", messageID: "A"), now: t0)
        state.observeRunning(true)
        XCTAssertEqual(state.currentTurn, 1)
        XCTAssertEqual(state.vended().first?.inCurrentTurn, true)
    }

    func testAnEntryIsNoLongerCurrentOnceTheNextTurnOpens() {
        var state = TranscriptMediaSessionState()
        state.observeRunning(true)
        state.apply(TranscriptMediaFrame(action: "begin", handle: "h", messageID: "A"), now: t0)
        state.observeRunning(false)
        XCTAssertEqual(state.vended().first?.inCurrentTurn, true, "an idle session's last turn is still the current one")
        state.observeRunning(true)
        XCTAssertEqual(state.vended().first?.inCurrentTurn, false)
        XCTAssertEqual(state.vended().first?.turn, 1, "turn is never rewritten")
    }

    func testEvictionTakesTheOldestEarlierTurnEntryAndNeverACurrentTurnOne() {
        var state = TranscriptMediaSessionState()
        state.observeRunning(true)
        state.apply(TranscriptMediaFrame(action: "begin", handle: "old", messageID: "A"), now: t0)
        state.observeRunning(false)
        state.observeRunning(true)
        for i in 0..<TranscriptMediaSessionState.maxEntries {
            state.apply(TranscriptMediaFrame(action: "begin", handle: "n\(i)", messageID: "B"), now: t0)
        }
        XCTAssertEqual(state.byID.count, TranscriptMediaSessionState.maxEntries)
        XCTAssertNil(state.byID["media:h:old"], "the earlier-turn entry is the one evicted")

        var allCurrent = TranscriptMediaSessionState()
        allCurrent.observeRunning(true)
        for i in 0...TranscriptMediaSessionState.maxEntries {
            allCurrent.apply(TranscriptMediaFrame(action: "begin", handle: "c\(i)", messageID: "B"), now: t0)
        }
        XCTAssertEqual(allCurrent.byID.count, TranscriptMediaSessionState.maxEntries + 1, "current-turn entries are never evicted")
    }

    // MARK: - Tool-output parsing

    func testShowOutputWithDimensions() {
        let r = TranscriptMediaParse.showOutput("Displayed /home/u/cat.png (image/png 600x400, 1234 bytes) in the transcript.")
        XCTAssertEqual(r?.path, "/home/u/cat.png")
        XCTAssertEqual(r?.mime, "image/png")
        XCTAssertEqual(r?.w, 600)
        XCTAssertEqual(r?.h, 400)
        XCTAssertEqual(r?.size, 1234)
    }

    func testShowOutputWithoutDimensions() {
        let r = TranscriptMediaParse.showOutput("Displayed /home/u/c.mp4 (video/mp4, 99 bytes) in the transcript.")
        XCTAssertEqual(r?.mime, "video/mp4")
        XCTAssertNil(r?.w)
        XCTAssertNil(r?.h)
        XCTAssertEqual(r?.size, 99)
    }

    func testShowOutputAnchorsOnTheLastOpenParenthesis() {
        let r = TranscriptMediaParse.showOutput("Displayed /home/u/my pics (copy) (1).png (image/png 10x20, 5 bytes) in the transcript.")
        XCTAssertEqual(r?.path, "/home/u/my pics (copy) (1).png")
        XCTAssertEqual(r?.mime, "image/png")
        XCTAssertEqual(r?.w, 10)
        XCTAssertEqual(r?.size, 5)
    }

    func testShowOutputJunkIsNil() {
        XCTAssertNil(TranscriptMediaParse.showOutput("nope"))
        XCTAssertNil(TranscriptMediaParse.showOutput("Displayed /x.png in the transcript."))
        XCTAssertNil(TranscriptMediaParse.showOutput("Displayed  (image/png, 5 bytes) in the transcript."))
    }

    func testBeginHandle() {
        XCTAssertEqual(TranscriptMediaParse.beginHandle("Placeholder reserved. Handle: 1a2b3c4d. Keep it."), "1a2b3c4d")
        XCTAssertNil(TranscriptMediaParse.beginHandle("Placeholder reserved."))
        XCTAssertNil(TranscriptMediaParse.beginHandle("Handle: zzz"))
    }

    func testMimeForPath() {
        XCTAssertEqual(TranscriptMediaMime.forPath("/a/B.PNG"), "image/png")
        XCTAssertEqual(TranscriptMediaMime.forPath("/a/b.mov"), "video/quicktime")
        XCTAssertNil(TranscriptMediaMime.forPath("/a/b.txt"))
        XCTAssertNil(TranscriptMediaMime.forPath("/a/noext"))
    }

    func testToolNameMatchingAcceptsAPrefixedSpelling() {
        XCTAssertTrue(TranscriptMediaParse.isTool("media_show", "media_show"))
        XCTAssertTrue(TranscriptMediaParse.isTool("manta_media_show", "media_show"))
        XCTAssertTrue(TranscriptMediaParse.isTool("manta.media_show", "media_show"))
        XCTAssertFalse(TranscriptMediaParse.isTool("media_showcase", "media_show"))
    }

    // MARK: - Canonical entries

    func testCanonicalBeginInAndShowInBGivesOneReadyEntryOwnedByAWithBeginGeometry() {
        let a = message("A", role: "assistant", completed: 2, parts: [beginPart("pa", "A", handle: "a1b2")])
        let b = message("B", role: "assistant", completed: 3, parts: [showPart("pb", "B", handle: "a1b2", path: "/home/u/cat.png")])
        let entries = TranscriptMediaParse.canonicalEntries([a, b])
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].id, "media:h:a1b2")
        XCTAssertEqual(entries[0].ownerMessageID, "A")
        XCTAssertEqual(entries[0].state, .ready)
        XCTAssertEqual(entries[0].path, "/home/u/cat.png")
        XCTAssertEqual(entries[0].reserved, TranscriptMediaGeometryInput(aspectRatio: 16.0 / 9.0))
        XCTAssertEqual(entries[0].title, "Cat")
    }

    func testCanonicalShowWithoutAHandleUsesTheMessageAndPathIdentity() {
        let b = message("B", role: "assistant", completed: 3, parts: [showPart("pb", "B", handle: nil, path: "/home/u/x.png", dims: " 30x20")])
        let entries = TranscriptMediaParse.canonicalEntries([b])
        XCTAssertEqual(entries.map(\.id), ["media:s:B:/home/u/x.png"])
        XCTAssertEqual(entries[0].reserved, TranscriptMediaGeometryInput(width: 30, height: 20))
    }

    func testCanonicalErrorShowAndUnshownBeginYieldNothing() {
        let a = message("A", role: "assistant", completed: 2, parts: [
            beginPart("pa", "A", handle: "a1b2"),
            toolPart("pe", "A", tool: "media_show", status: "error", input: ["path": .string("/x.png")], output: "boom"),
        ])
        XCTAssertTrue(TranscriptMediaParse.canonicalEntries([a]).isEmpty)
    }

    func testCanonicalEntriesAreDeterministic() {
        let a = message("A", role: "assistant", completed: 2, parts: [beginPart("pa", "A", handle: "a1b2")])
        let b = message("B", role: "assistant", completed: 3, parts: [
            showPart("pb", "B", handle: "a1b2", path: "/a.png"),
            showPart("pc", "B", handle: nil, path: "/b.png"),
        ])
        XCTAssertEqual(TranscriptMediaParse.canonicalEntries([a, b]), TranscriptMediaParse.canonicalEntries([a, b]))
    }

    func testLiveOnlyDropsEntriesTheCanonicalListCoversAndOrdersBySeqThenId() {
        func entry(_ id: String, seq: Int) -> TranscriptMediaEntry {
            TranscriptMediaEntry(id: id, ownerMessageID: "A", seq: seq, state: .pending, kind: .image,
                                 reserved: TranscriptMediaGeometryInput(), count: nil, title: nil, path: nil,
                                 mime: nil, size: nil, beganAt: nil, handle: nil)
        }
        let live = [entry("media:h:z", seq: 1), entry("media:h:b", seq: 1), entry("media:h:covered", seq: 0), entry("media:h:a", seq: 2)]
        let canonical = [entry("media:h:covered", seq: 0)]
        XCTAssertEqual(TranscriptMediaReconcile.liveOnly(live: live, canonical: canonical).map(\.id),
                       ["media:h:b", "media:h:z", "media:h:a"])
    }

    // MARK: - Geometry

    func testAspectExplicitDimensionsBeatAspectRatioBeatsDefault() {
        XCTAssertEqual(TranscriptMediaGeometry.aspect(.init(width: 200, height: 100, aspectRatio: 5)), 2, accuracy: 0.0001)
        XCTAssertEqual(TranscriptMediaGeometry.aspect(.init(aspectRatio: 1.5)), 1.5, accuracy: 0.0001)
        XCTAssertEqual(TranscriptMediaGeometry.aspect(.init()), 16.0 / 9.0, accuracy: 0.0001)
        XCTAssertEqual(TranscriptMediaGeometry.aspect(.init(width: 0, height: 100)), 16.0 / 9.0, accuracy: 0.0001)
    }

    func testBoxWidthIsCappedAtTheInlineMax() {
        let box = TranscriptMediaGeometry.box(.init(width: 400, height: 200), availableWidth: 900)
        XCTAssertEqual(box.width, 520, accuracy: 0.001)
        XCTAssertEqual(box.height, 260, accuracy: 0.001)
    }

    func testATallBoxIsCappedAtMaxHeightAndItsWidthShrinks() {
        let box = TranscriptMediaGeometry.box(.init(width: 100, height: 300), availableWidth: 400)
        XCTAssertEqual(box.height, 480, accuracy: 0.001)
        XCTAssertEqual(box.width, 160, accuracy: 0.001)
    }

    func testABoxNarrowerThanTheColumnUsesTheColumn() {
        let box = TranscriptMediaGeometry.box(.init(width: 160, height: 90), availableWidth: 300)
        XCTAssertEqual(box.width, 300, accuracy: 0.001)
        XCTAssertEqual(box.height, 168.75, accuracy: 0.001)
    }

    func testGrid() {
        XCTAssertEqual(TranscriptMediaGeometry.grid(count: nil).tiles, 1)
        XCTAssertEqual(TranscriptMediaGeometry.grid(count: 0).tiles, 1)
        XCTAssertEqual(TranscriptMediaGeometry.grid(count: 1).tiles, 1)
        let three = TranscriptMediaGeometry.grid(count: 3)
        XCTAssertEqual(three.tiles, 3)
        XCTAssertEqual(three.more, 0)
        let four = TranscriptMediaGeometry.grid(count: 4)
        XCTAssertEqual(four.tiles, 4)
        XCTAssertEqual(four.more, 0)
        let seven = TranscriptMediaGeometry.grid(count: 7)
        XCTAssertEqual(seven.tiles, 4)
        XCTAssertEqual(seven.more, 3)
    }

    // MARK: - User files

    func testFilePartWithAFileURLIsABoxPath() {
        let m = message("u", role: "user", parts: [filePart("f0", "u", url: "file:///home/u/shot.png", filename: "shot.png")])
        let refs = TranscriptFileParse.refs(of: m)
        XCTAssertEqual(refs.count, 1)
        XCTAssertEqual(refs[0].source, .boxPath("/home/u/shot.png"))
        XCTAssertEqual(refs[0].filename, "shot.png")
        XCTAssertEqual(refs[0].mime, "image/png")
        XCTAssertEqual(refs[0].partID, "f0")
    }

    func testFilePartWithADataURLIsInline() {
        let m = message("u", role: "user", parts: [filePart("f0", "u", url: "data:image/png;base64,AAAA", filename: nil)])
        XCTAssertEqual(TranscriptFileParse.refs(of: m)[0].source, .dataURL(mime: "image/png", base64: "AAAA"))
        XCTAssertEqual(TranscriptFileParse.refs(of: m)[0].filename, "file", "a data URL has no meaningful last segment")
    }

    func testFilenameFallsBackToTheLastPathSegmentThenToFile() {
        let a = message("u", role: "user", parts: [filePart("f0", "u", url: "file:///home/u/dir/report.pdf", filename: nil)])
        XCTAssertEqual(TranscriptFileParse.refs(of: a)[0].filename, "report.pdf")
        let b = message("u", role: "user", parts: [filePart("f0", "u", url: nil, filename: nil)])
        XCTAssertEqual(TranscriptFileParse.refs(of: b)[0].filename, "file")
        XCTAssertEqual(TranscriptFileParse.refs(of: b)[0].source, .none)
    }

    func testNonFilePartsAreIgnoredAndOrderIsWireOrder() {
        let m = message("u", role: "user", parts: [
            OpencodePart(type: "text", id: "t", messageID: "u", text: "hi"),
            filePart("f1", "u", url: "file:///b.png", filename: "b.png"),
            filePart("f0", "u", url: "file:///a.png", filename: "a.png"),
        ])
        XCTAssertEqual(TranscriptFileParse.refs(of: m).map(\.partID), ["f1", "f0"])
    }

    func testDecodedSizeCoversThePaddingCases() {
        XCTAssertEqual(TranscriptFileParse.decodedSize(base64: ""), 0)
        XCTAssertEqual(TranscriptFileParse.decodedSize(base64: "AAAA"), 3)
        XCTAssertEqual(TranscriptFileParse.decodedSize(base64: "AAA="), 2)
        XCTAssertEqual(TranscriptFileParse.decodedSize(base64: "AA=="), 1)
    }

    func testDecodedSizeOfAnOverCapPayload() {
        // 26,214,401 decoded bytes → 8,738,134 groups of 4 chars, last group has one '='.
        let payload = String(repeating: "A", count: 34_952_536 - 1) + "="
        XCTAssertEqual(TranscriptFileParse.decodedSize(base64: payload), 26_214_401)
        XCTAssertGreaterThan(TranscriptFileParse.decodedSize(base64: payload), TranscriptMediaGeometry.maxPreviewBytes)
    }

    // MARK: - Staging key + peek URL

    func testStagingKeySeparatesBoxesAndServers() {
        let path = TranscriptFileRef.Source.boxPath("/home/u/a.png")
        let a = TranscriptStagingKey.input(boxID: "boxA", serverURL: "https://a.example", source: path)
        XCTAssertNotEqual(a, TranscriptStagingKey.input(boxID: "boxB", serverURL: "https://a.example", source: path))
        XCTAssertEqual(a, TranscriptStagingKey.input(boxID: "boxA", serverURL: "https://a.example", source: path))
        XCTAssertNotEqual(a, TranscriptStagingKey.input(boxID: "boxA", serverURL: "https://b.example", source: path))
    }

    func testStagingKeyNeverCollidesAPathWithAData() {
        let p = TranscriptStagingKey.input(boxID: "b", serverURL: "s", source: .boxPath("image/png:AAAA"))
        let d = TranscriptStagingKey.input(boxID: "b", serverURL: "s", source: .dataURL(mime: "image/png", base64: "AAAA"))
        XCTAssertNotEqual(p, d)
    }

    func testStagingKeyUsesTheWholeDataPayload() {
        let prefix = String(repeating: "A", count: 64)
        let one = TranscriptStagingKey.input(boxID: "b", serverURL: "s", source: .dataURL(mime: "image/png", base64: prefix + "XXXX"))
        let two = TranscriptStagingKey.input(boxID: "b", serverURL: "s", source: .dataURL(mime: "image/png", base64: prefix + "YYYY"))
        XCTAssertNotEqual(one, two)
    }

    func testPeekURLEncodesAwkwardPaths() throws {
        let server = try XCTUnwrap(URL(string: "https://box.example"))
        let path = "/home/u/my pics/a#b&c+d.png"
        let url = try XCTUnwrap(TranscriptPeekRequest.url(serverURL: server, path: path))
        XCTAssertEqual(url.path, "/api/peek")
        let comps = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(comps.queryItems?.count, 1)
        XCTAssertEqual(comps.queryItems?.first?.name, "path")
        XCTAssertEqual(comps.queryItems?.first?.value, path)
        XCTAssertFalse((comps.percentEncodedQuery ?? "").contains("&c"), "an ampersand in the path must be percent-encoded")
    }

    func testPeekURLKeepsATrailingServerPathSegment() throws {
        let server = try XCTUnwrap(URL(string: "https://box.example/prefix/"))
        let url = try XCTUnwrap(TranscriptPeekRequest.url(serverURL: server, path: "/a.png"))
        XCTAssertEqual(url.path, "/prefix/api/peek")
    }

    // MARK: - Turn formatting

    func testDuration() {
        XCTAssertEqual(TranscriptTurnFormat.duration(ms: 0), "<1s")
        XCTAssertEqual(TranscriptTurnFormat.duration(ms: 999), "<1s")
        XCTAssertEqual(TranscriptTurnFormat.duration(ms: 1000), "1s")
        XCTAssertEqual(TranscriptTurnFormat.duration(ms: 59_499), "59s")
        XCTAssertEqual(TranscriptTurnFormat.duration(ms: 104_000), "1m44s")
        XCTAssertEqual(TranscriptTurnFormat.duration(ms: 7_384_000), "2h3m4s")
    }

    func testTokens() {
        // Expected strings were produced by running the desktop `formatTokens` under node.
        XCTAssertEqual(TranscriptTurnFormat.tokens(512), "512 tokens")
        XCTAssertEqual(TranscriptTurnFormat.tokens(999), "999 tokens")
        XCTAssertEqual(TranscriptTurnFormat.tokens(1000), "1k tokens")
        XCTAssertEqual(TranscriptTurnFormat.tokens(1050), "1.1k tokens")
        XCTAssertEqual(TranscriptTurnFormat.tokens(12_400), "12.4k tokens")
        XCTAssertEqual(TranscriptTurnFormat.tokens(99_960), "100k tokens")
        XCTAssertEqual(TranscriptTurnFormat.tokens(100_500), "101k tokens")
        XCTAssertEqual(TranscriptTurnFormat.tokens(148_000), "148k tokens")
    }

    func testTokensBreakExactTiesUpLikeToFixed() {
        XCTAssertEqual(TranscriptTurnFormat.tokens(1250), "1.3k tokens")
        XCTAssertEqual(TranscriptTurnFormat.tokens(2250), "2.3k tokens")
        XCTAssertEqual(TranscriptTurnFormat.tokens(2750), "2.8k tokens")
        XCTAssertEqual(TranscriptTurnFormat.tokens(50_750), "50.8k tokens")
    }

    func testVerbIndexMatchesTheDesktopHash() {
        // Computed with node: h = (h*31 + charCode) | 0; Math.abs(h) % 12.
        XCTAssertEqual(TranscriptTurnVerb.index(for: "msg_01"), 1)            // h is negative
        XCTAssertEqual(TranscriptTurnVerb.index(for: "msg_01HZX9K3A"), 5)     // h is negative
        XCTAssertEqual(TranscriptTurnVerb.index(for: "a"), 1)
        XCTAssertEqual(TranscriptTurnVerb.index(for: "ses_abc"), 0)
        XCTAssertEqual(TranscriptTurnVerb.index(for: "msg_deadbeefcafe0123456789"), 8)
        XCTAssertEqual(TranscriptTurnVerb.index(for: "zzzzzzzzzzzzzzzzzzzz"), 0)
        XCTAssertEqual(TranscriptTurnVerb.index(for: "Hello😀"), 7)            // surrogate pair, h negative
        XCTAssertEqual(TranscriptTurnVerb.index(for: ""), 0)
        XCTAssertEqual(TranscriptTurnVerb.past[TranscriptTurnVerb.index(for: "msg_01")], "Ruminated")
        XCTAssertEqual(TranscriptTurnVerb.present[TranscriptTurnVerb.index(for: "msg_01")], "Ruminating")
        XCTAssertEqual(TranscriptTurnVerb.past.count, TranscriptTurnVerb.present.count)
    }

    // MARK: - Truncation

    func testClassify() {
        XCTAssertEqual(TranscriptTruncation.classify("max_tokens", lastPartIsToolUse: false), .outputCap)
        XCTAssertEqual(TranscriptTruncation.classify("length", lastPartIsToolUse: false), .outputCap)
        XCTAssertEqual(TranscriptTruncation.classify("MAX_TOKENS", lastPartIsToolUse: true), .toolCutoff)
        XCTAssertEqual(TranscriptTruncation.classify("MODEL_CONTEXT_WINDOW_EXCEEDED", lastPartIsToolUse: false), .contextWall)
        XCTAssertNil(TranscriptTruncation.classify("end_turn", lastPartIsToolUse: false))
        XCTAssertNil(TranscriptTruncation.classify("stop", lastPartIsToolUse: false))
        XCTAssertNil(TranscriptTruncation.classify("tool-calls", lastPartIsToolUse: true))
        XCTAssertNil(TranscriptTruncation.classify(nil, lastPartIsToolUse: true))
        XCTAssertNil(TranscriptTruncation.classify("", lastPartIsToolUse: false))
    }

    func testDescribeStringsAreVerbatim() {
        XCTAssertEqual(TranscriptTruncation.describe(.outputCap).label, "truncated (output limit)")
        XCTAssertEqual(TranscriptTruncation.describe(.contextWall).label, "truncated (context full)")
        XCTAssertEqual(TranscriptTruncation.describe(.toolCutoff).label, "tool call cut off — retry needed")
        XCTAssertEqual(TranscriptTruncation.describe(.contextWall).hint,
                       "Response hit the model's context window mid-generation. Run /compact to free space, or start a new session.")
        XCTAssertTrue(TranscriptTruncation.describe(.outputCap).hint.hasPrefix("Response hit the per-turn output cap."))
        XCTAssertTrue(TranscriptTruncation.describe(.toolCutoff).hint.hasSuffix("(optionally with a higher max output)."))
    }

    func testKindOfMessagePrefersTheStepFinishReasonAndFallsBackToFinish() {
        let step = OpencodePart(type: "step-finish", id: "m:step-finish", messageID: "m", extra: ["reason": .string("max_tokens")])
        XCTAssertEqual(TranscriptTruncation.kind(of: message("m", role: "assistant", completed: 1, finish: "tool-calls", parts: [step])), .toolCutoff)
        XCTAssertEqual(TranscriptTruncation.kind(of: message("m", role: "assistant", completed: 1, finish: "length")), .outputCap)
        XCTAssertNil(TranscriptTruncation.kind(of: message("m", role: "assistant", completed: 1, finish: "stop")))
        let benign = OpencodePart(type: "step-finish", id: "m:step-finish", messageID: "m", extra: ["reason": .string("stop")])
        XCTAssertNil(TranscriptTruncation.kind(of: message("m", role: "assistant", completed: 1, finish: "length", parts: [benign])),
                     "the raw step-finish reason is the box's own signal and wins over info.finish")
    }

    func testLiveTruncationFromRejectsAnEmptyMessageAndAnUnknownKind() {
        XCTAssertNil(TranscriptLiveTruncation.from(kind: "output-cap", messageID: nil))
        XCTAssertNil(TranscriptLiveTruncation.from(kind: "output-cap", messageID: ""))
        XCTAssertNil(TranscriptLiveTruncation.from(kind: "mystery", messageID: "m"))
        XCTAssertEqual(TranscriptLiveTruncation.from(kind: "context-wall", messageID: "m"),
                       TranscriptLiveTruncation(messageID: "m", kind: .contextWall))
    }

    func testFooterRuleCoversTheFourCombinations() {
        XCTAssertTrue(TranscriptFooterRule.shouldEmit(finishedTurn: true, effectiveTruncation: nil))
        XCTAssertTrue(TranscriptFooterRule.shouldEmit(finishedTurn: true, effectiveTruncation: .outputCap))
        XCTAssertTrue(TranscriptFooterRule.shouldEmit(finishedTurn: false, effectiveTruncation: .outputCap))
        XCTAssertFalse(TranscriptFooterRule.shouldEmit(finishedTurn: false, effectiveTruncation: nil))
    }

    // MARK: - Turn info

    private func usage(output: Double, reasoning: Double = 0) -> OpencodeTokenUsage {
        OpencodeTokenUsage(input: 100, output: output, reasoning: reasoning, cache: nil)
    }

    func testTurnInfoSpansTheAssistantRunAfterEachUserMessage() {
        let msgs = [
            message("u1", role: "user", created: 100),
            message("a1", role: "assistant", created: 1_000, completed: 2_000, tokens: usage(output: 10, reasoning: 5)),
            message("a2", role: "assistant", created: 2_000, completed: 61_000, tokens: usage(output: 20)),
            message("u2", role: "user", created: 70_000),
            message("a3", role: "assistant", created: 71_000, completed: 72_500, tokens: usage(output: 7)),
        ]
        let info = TranscriptTurns.info(msgs, running: false)
        XCTAssertEqual(Set(info.keys), ["a2", "a3"])
        XCTAssertEqual(info["a2"]?.durationMs, 60_000, "first assistant created → last assistant completed")
        XCTAssertEqual(info["a2"]?.tokens, 35, "output + reasoning summed across the turn")
        XCTAssertEqual(info["a2"]?.verbSeedID, "a1", "the verb is seeded by the turn's FIRST assistant message")
        XCTAssertEqual(info["a3"]?.durationMs, 1_500)
        XCTAssertEqual(info["a3"]?.verbSeedID, "a3")
    }

    func testABackgroundResultStartsANewTurn() {
        let bg = OpencodePart(type: "background-result", id: "bg", messageID: "bgm", text: nil, extra: [:])
        let msgs = [
            message("u1", role: "user", created: 0),
            message("a1", role: "assistant", created: 10, completed: 20),
            message("bgm", role: "assistant", created: 100, completed: 100, parts: [bg]),
            message("a2", role: "assistant", created: 200, completed: 900),
        ]
        XCTAssertTrue(TranscriptTurns.isBackgroundResult(msgs[2]))
        XCTAssertFalse(TranscriptTurns.isBackgroundResult(msgs[1]))
        let info = TranscriptTurns.info(msgs, running: false)
        XCTAssertEqual(Set(info.keys), ["a1", "a2"], "the background result is the start of a turn, not a footer carrier")
        XCTAssertEqual(info["a1"]?.durationMs, 10)
        XCTAssertEqual(info["a2"]?.durationMs, 700)
    }

    func testRunningSuppressesTheFooterOnTheTranscriptsLastMessageOnly() {
        let msgs = [
            message("u1", role: "user"),
            message("a1", role: "assistant", created: 10, completed: 20),
            message("u2", role: "user"),
            message("a2", role: "assistant", created: 30, completed: 40),
        ]
        XCTAssertEqual(Set(TranscriptTurns.info(msgs, running: true).keys), ["a1"])
        XCTAssertEqual(Set(TranscriptTurns.info(msgs, running: false).keys), ["a1", "a2"])
    }

    func testAnInFlightLastAssistantGivesNoFooterForItsTurn() {
        let msgs = [
            message("u1", role: "user"),
            message("a1", role: "assistant", created: 10, completed: 20),
            message("a2", role: "assistant", created: 30, completed: nil),
        ]
        XCTAssertTrue(TranscriptTurns.info(msgs, running: false).isEmpty)
    }

    func testATurnWithoutADurationStillGetsAnEntry() {
        let msgs = [message("u1", role: "user"), message("a1", role: "assistant", created: nil, completed: 20)]
        let info = TranscriptTurns.info(msgs, running: false)
        XCTAssertNotNil(info["a1"])
        XCTAssertNil(info["a1"]?.durationMs)
        XCTAssertNil(TranscriptTurns.summary(info["a1"]!))
    }

    func testSummaryReadsVerbDurationAndTokens() {
        let info = TranscriptTurnInfo(durationMs: 104_000, tokens: 12_400, verbSeedID: "msg_01")
        XCTAssertEqual(TranscriptTurns.summary(info), "Ruminated for 1m44s · 12.4k tokens")
        XCTAssertEqual(TranscriptTurns.summary(TranscriptTurnInfo(durationMs: 2_000, tokens: nil, verbSeedID: "msg_01")),
                       "Ruminated for 2s")
    }

    // MARK: - Message info decoding

    private func decodeInfo(_ json: String) throws -> OpencodeMessageInfo {
        try JSONDecoder().decode(OpencodeMessageInfo.self, from: Data(json.utf8))
    }

    func testInfoDecodesTokensFinishAndCommand() throws {
        let info = try decodeInfo("""
        {"id":"m","sessionID":"s","role":"assistant","time":{"created":1,"completed":2},
         "tokens":{"input":5,"output":6,"reasoning":7,"cache":{"read":8,"write":9}},
         "finish":"stop","command":{"name":"review","arguments":"main"}}
        """)
        XCTAssertEqual(info.tokens, OpencodeTokenUsage(input: 5, output: 6, reasoning: 7, cache: .init(read: 8, write: 9)))
        XCTAssertEqual(info.finish, "stop")
        XCTAssertEqual(info.command, OpencodeCommandOrigin(name: "review", arguments: "main"))
    }

    func testInfoMissingKeysAreNil() throws {
        let info = try decodeInfo(#"{"id":"m","sessionID":"s","role":"user"}"#)
        XCTAssertNil(info.tokens)
        XCTAssertNil(info.finish)
        XCTAssertNil(info.command)
    }

    func testCommandWithoutArgumentsDecodes() throws {
        let info = try decodeInfo(#"{"id":"m","sessionID":"s","role":"user","command":{"name":"x"}}"#)
        XCTAssertEqual(info.command, OpencodeCommandOrigin(name: "x", arguments: nil))
    }

    func testMalformedNewKeysAreNilAndTheMessageStillDecodes() throws {
        let info = try decodeInfo(#"{"id":"m","sessionID":"s","role":"user","command":3,"tokens":"x","finish":{"a":1}}"#)
        XCTAssertEqual(info.id, "m")
        XCTAssertNil(info.command)
        XCTAssertNil(info.tokens)
        XCTAssertNil(info.finish)
    }

    func testMemberwiseInitIsStillAvailableWithoutTheNewFields() {
        let info = OpencodeMessageInfo(id: "m", sessionID: "s", role: .user, time: nil, modelID: nil, providerID: nil)
        XCTAssertNil(info.tokens)
        XCTAssertNil(info.command)
    }

    func testInfoRoundTrips() throws {
        let original = OpencodeMessageInfo(id: "m", sessionID: "s", role: .assistant,
                                           time: OpencodeTime(created: 1, completed: 2), modelID: "x", providerID: "y",
                                           tokens: usage(output: 3), finish: "stop",
                                           command: OpencodeCommandOrigin(name: "c", arguments: "a"))
        let data = try JSONEncoder().encode(original)
        XCTAssertEqual(try JSONDecoder().decode(OpencodeMessageInfo.self, from: data), original)
    }

    // MARK: - Command origin

    func testFromLiveMapsAnEmptyArgumentStringToNil() {
        XCTAssertNil(TranscriptCommandOrigin.fromLive(name: "x", arguments: "").arguments)
        XCTAssertEqual(TranscriptCommandOrigin.fromLive(name: "x", arguments: "a").arguments, "a")
        XCTAssertEqual(TranscriptCommandOrigin.fromLive(name: "x", arguments: "a").name, "x")
    }

    func testResolvePrefersTheDurableRecord() {
        let a = OpencodeCommandOrigin(name: "durable", arguments: nil)
        let b = OpencodeCommandOrigin(name: "live", arguments: nil)
        XCTAssertEqual(TranscriptCommandOrigin.resolve(durable: a, live: b), a)
        XCTAssertEqual(TranscriptCommandOrigin.resolve(durable: nil, live: b), b)
        XCTAssertNil(TranscriptCommandOrigin.resolve(durable: nil, live: nil))
    }

    // MARK: - Selection + reply menu

    func testSelectionReturnsTheSubstring() {
        XCTAssertEqual(TranscriptSelection.text(in: "hello world", range: NSRange(location: 6, length: 5)), "world")
    }

    func testSelectionOfZeroLengthOrNotFoundIsNil() {
        XCTAssertNil(TranscriptSelection.text(in: "hello", range: NSRange(location: 2, length: 0)))
        XCTAssertNil(TranscriptSelection.text(in: "hello", range: NSRange(location: NSNotFound, length: 3)))
    }

    func testSelectionIsClampedToTheText() {
        XCTAssertEqual(TranscriptSelection.text(in: "hello", range: NSRange(location: 3, length: 50)), "lo")
        XCTAssertNil(TranscriptSelection.text(in: "hello", range: NSRange(location: 9, length: 2)))
    }

    func testSelectionNeverSplitsAnEmoji() {
        let text = "a😀b"
        // The emoji is two UTF-16 units, at offsets 1..<3.
        XCTAssertEqual(TranscriptSelection.text(in: text, range: NSRange(location: 1, length: 2)), "😀")
        XCTAssertEqual(TranscriptSelection.text(in: text, range: NSRange(location: 0, length: 4)), "a😀b")
    }

    func testReplyMenuItems() {
        XCTAssertEqual(TranscriptReplyMenuModel.items(canQuote: false, turnText: "x"), [.selectText])
        XCTAssertEqual(TranscriptReplyMenuModel.items(canQuote: true, turnText: "x"), [.quote, .quoteNewSession, .selectText])
        XCTAssertEqual(TranscriptReplyMenuModel.items(canQuote: true, turnText: ""), [])
        XCTAssertEqual(TranscriptReplyMenuModel.items(canQuote: false, turnText: "  \n "), [])
    }

    // MARK: - Display options

    func testDisplayOptionsPersistAndNotify() {
        let key = TranscriptDisplayOptions.defaultsKey
        let saved = UserDefaults.standard.object(forKey: key)
        defer {
            if let saved { UserDefaults.standard.set(saved, forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) }
        }
        UserDefaults.standard.removeObject(forKey: key)
        XCTAssertFalse(TranscriptDisplayOptions.showDetails, "off by default")

        let posted = expectation(description: "didChange")
        let token = NotificationCenter.default.addObserver(forName: TranscriptDisplayOptions.didChange, object: nil, queue: nil) { _ in
            posted.fulfill()
        }
        defer { NotificationCenter.default.removeObserver(token) }
        TranscriptDisplayOptions.setShowDetails(true)
        wait(for: [posted], timeout: 2)
        XCTAssertTrue(TranscriptDisplayOptions.showDetails)
        TranscriptDisplayOptions.setShowDetails(false)
        XCTAssertFalse(TranscriptDisplayOptions.showDetails)
    }
}
