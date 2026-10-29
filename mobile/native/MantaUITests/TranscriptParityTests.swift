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

    private func usage(output: Double, reasoning: Double = 0) -> OpencodeTokenUsage {
        OpencodeTokenUsage(input: 100, output: output, reasoning: reasoning, cache: nil)
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

    // MARK: - Canonical media (the box's `view.media`; the parsing is pinned in transcriptView.test.mjs)

    private func mediaMessage(_ id: String, _ media: [TranscriptMediaView]) -> OpencodeMessage {
        var m = message(id, role: "assistant", completed: 2)
        m.view = TranscriptMessageView(media: media)
        return m
    }

    func testViewMediaGivesReadyEntriesOwnedByTheMessageItRidesOnInTranscriptOrder() {
        let a = mediaMessage("A", [
            TranscriptMediaView(id: "media:h:a1b2", path: "/home/u/cat.png", mime: "image/png", aspectRatio: 16.0 / 9.0, size: 1234, title: "Cat", handle: "a1b2"),
        ])
        let b = mediaMessage("B", [
            TranscriptMediaView(id: "media:s:B:/home/u/x.png", path: "/home/u/x.png", mime: "image/png", width: 30, height: 20, size: 5),
            TranscriptMediaView(id: "media:s:B:/home/u/v.mp4", kind: "video", path: "/home/u/v.mp4", mime: "video/mp4", size: 9),
        ])
        let entries = TranscriptViewMedia.entries([a, message("u", role: "user"), b])
        XCTAssertEqual(entries.map(\.id), ["media:h:a1b2", "media:s:B:/home/u/x.png", "media:s:B:/home/u/v.mp4"])
        XCTAssertEqual(entries.map(\.ownerMessageID), ["A", "B", "B"])
        XCTAssertEqual(entries.map(\.seq), [0, 1, 2])
        XCTAssertTrue(entries.allSatisfy { $0.state == .ready })
        XCTAssertEqual(entries[0].reserved, TranscriptMediaGeometryInput(aspectRatio: 16.0 / 9.0), "the begin's reserved box")
        XCTAssertEqual(entries[0].title, "Cat")
        XCTAssertEqual(entries[1].reserved, TranscriptMediaGeometryInput(width: 30, height: 20))
        XCTAssertEqual(entries[2].kind, .video)
    }

    func testAMessageWithNoViewHasNoCanonicalMedia() {
        XCTAssertTrue(TranscriptViewMedia.entries([message("A", role: "assistant", completed: 2)]).isEmpty, "an older box: nothing reconstructed on the phone")
    }

    func testViewMediaEntriesAreDeterministic() {
        let a = mediaMessage("A", [TranscriptMediaView(id: "media:h:z", path: "/a.png")])
        XCTAssertEqual(TranscriptViewMedia.entries([a]), TranscriptViewMedia.entries([a]))
    }

    func testMimeKindMapsImageAndVideoOnly() {
        XCTAssertEqual(TranscriptMediaMime.kind(of: "Image/PNG"), .image)
        XCTAssertEqual(TranscriptMediaMime.kind(of: "video/mp4"), .video)
        XCTAssertNil(TranscriptMediaMime.kind(of: "text/csv"))
        XCTAssertNil(TranscriptMediaMime.kind(of: nil))
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

    // MARK: - Truncation (the box's — pinned in transcriptView.test.mjs; the phone decodes and adapts the live frame)

    func testLiveTruncationFromPayloadRejectsAnEmptyMessageAndAnUnknownKind() {
        func payload(_ kind: String, _ id: String?, hint: String? = nil) -> StreamTruncationPayload {
            StreamTruncationPayload(kind: kind, label: "L", hint: hint, messageID: id)
        }
        XCTAssertNil(TranscriptLiveTruncation.from(payload: payload("output-cap", nil)))
        XCTAssertNil(TranscriptLiveTruncation.from(payload: payload("output-cap", "")))
        XCTAssertNil(TranscriptLiveTruncation.from(payload: payload("mystery", "m")))
        XCTAssertEqual(
            TranscriptLiveTruncation.from(payload: payload("context-wall", "m", hint: "H")),
            TranscriptLiveTruncation(messageID: "m", view: TranscriptTruncationView(kind: "context-wall", label: "L", hint: "H"))
        )
    }

    func testAnOlderBoxsLiveFrameHasNoHint() {
        let live = TranscriptLiveTruncation.from(payload: StreamTruncationPayload(kind: "output-cap", label: "truncated (output limit)", messageID: "m"))
        XCTAssertEqual(live?.view.label, "truncated (output limit)")
        XCTAssertNil(live?.view.hint, "no explain action, no client copy of the words")
    }

    func testFooterRuleCoversTheFourCombinations() {
        let t = TranscriptTruncationView(kind: "output-cap", label: "x")
        XCTAssertTrue(TranscriptFooterRule.shouldEmit(finishedTurn: true, effectiveTruncation: nil))
        XCTAssertTrue(TranscriptFooterRule.shouldEmit(finishedTurn: true, effectiveTruncation: t))
        XCTAssertTrue(TranscriptFooterRule.shouldEmit(finishedTurn: false, effectiveTruncation: t))
        XCTAssertFalse(TranscriptFooterRule.shouldEmit(finishedTurn: false, effectiveTruncation: nil))
    }

    // MARK: - Turn wording (which turn ends where is the box's)

    func testIsBackgroundResultReadsTheBackgroundResultPart() {
        let bg = OpencodePart(type: "background-result", id: "bg", messageID: "bgm", text: nil, extra: [:])
        XCTAssertTrue(TranscriptTurns.isBackgroundResult(message("bgm", role: "assistant", parts: [bg])))
        XCTAssertFalse(TranscriptTurns.isBackgroundResult(message("a1", role: "assistant")))
    }

    func testSummaryReadsVerbDurationAndTokens() {
        let turn = TranscriptTurnView(durationMs: 104_000, tokens: 12_400, verbSeedId: "msg_01")
        XCTAssertEqual(TranscriptTurns.summary(turn), "Ruminated for 1m44s · 12.4k tokens")
        XCTAssertEqual(TranscriptTurns.summary(TranscriptTurnView(durationMs: 2_000, tokens: nil, verbSeedId: "msg_01")), "Ruminated for 2s")
        XCTAssertNil(TranscriptTurns.summary(TranscriptTurnView(durationMs: nil, tokens: 5, verbSeedId: "msg_01")), "no duration, no summary")
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
        posted.assertForOverFulfill = false  // the later setShowDetails(false) posts again
        let token = NotificationCenter.default.addObserver(forName: TranscriptDisplayOptions.didChange, object: nil, queue: nil) { _ in
            posted.fulfill()
        }
        defer { NotificationCenter.default.removeObserver(token) }
        TranscriptDisplayOptions.setShowDetails(true)
        wait(for: [posted], timeout: 2)
        XCTAssertTrue(TranscriptDisplayOptions.showDetails)
        XCTAssertFalse(TranscriptDisplayOptions.fetchSlim, "a fetch is slim only while the switch is off: on → full")
        TranscriptDisplayOptions.setShowDetails(false)
        XCTAssertFalse(TranscriptDisplayOptions.showDetails)
        XCTAssertTrue(TranscriptDisplayOptions.fetchSlim)
    }

    func testSetShowDetailsToTheCurrentValuePostsNothing() {
        let key = TranscriptDisplayOptions.defaultsKey
        let saved = UserDefaults.standard.object(forKey: key)
        defer {
            if let saved { UserDefaults.standard.set(saved, forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) }
        }
        UserDefaults.standard.set(false, forKey: key)
        let quiet = expectation(description: "no notification")
        quiet.isInverted = true
        let token = NotificationCenter.default.addObserver(forName: TranscriptDisplayOptions.didChange, object: nil, queue: nil) { _ in
            quiet.fulfill()
        }
        defer { NotificationCenter.default.removeObserver(token) }
        TranscriptDisplayOptions.setShowDetails(false)
        wait(for: [quiet], timeout: 0.3)
    }
}
