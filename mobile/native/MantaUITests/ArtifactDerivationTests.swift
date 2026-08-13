import XCTest
@testable import MantaUI

// ===========================================================================
// BET-822 — the Swift port of src/renderer/artifacts.ts `deriveArtifacts`.
//
// These tests are the oracle that keeps the iOS card in sync with the desktop
// panel: changing a derivation rule here must fail a test, not just drift the
// two surfaces apart. Expected values are taken from the desktop unit tests
// (src/renderer/artifacts.test.ts) so both sides agree on a source of truth.
// ===========================================================================

final class ArtifactDerivationTests: XCTestCase {

    private func message(role: String, id: String, created: Double? = 1750000000000,
                         parts: [OpencodePart] = []) -> OpencodeMessage {
        OpencodeMessage(
            info: OpencodeMessageInfo(
                id: id, sessionID: "ses_1", role: OpencodeRole(rawValue: role),
                time: OpencodeTime(created: created)),
            parts: parts)
    }

    private func textPart(id: String, text: String) -> OpencodePart {
        OpencodePart(type: "text", id: id, messageID: "m1", text: text)
    }

    private func filePart(id: String, url: String, mime: String? = nil,
                          filename: String? = nil, size: Double? = nil) -> OpencodePart {
        var extra: [String: JSONValue] = [:]
        extra["url"] = .string(url)
        if let mime { extra["mime"] = .string(mime) }
        if let filename { extra["filename"] = .string(filename) }
        if let size { extra["size"] = .number(size) }
        return OpencodePart(type: "file", id: id, messageID: "m1", extra: extra)
    }

    private func page(_ subdomain: String, session: String? = "ses_1",
                      created: Double = 1750000000000, expiresAt: Double? = nil,
                      url: String? = nil) -> ServedPageMeta {
        ServedPageMeta(
            subdomain: subdomain,
            url: url ?? "https://\(subdomain).pages.mantaui.com",
            expiresAt: expiresAt,
            createdAt: created,
            sessionID: session)
    }

    private func outbox(path: String, name: String, size: Int,
                        session: String? = "ses_1", mtime: Double? = 1750000000000,
                        expiresAt: Double? = nil) -> OutboxFile {
        OutboxFile(path: path, name: name, size: size,
                   sessionID: session, mtime: mtime, expiresAt: expiresAt)
    }

    // MARK: - Required cases

    /// A file the user attaches (a `file` part in a user message) surfaces as
    /// `.file` with `userAttached` provenance and its box path as `href`.
    func testUserAttachmentSurfacesAsFile() {
        let m = message(role: "user", id: "m1",
                        parts: [filePart(id: "p1", url: "file:///home/u/upload/notes.txt",
                                         mime: "text/plain", filename: "notes.txt", size: 42)])
        let out = ArtifactDerivation.derive(messages: [m], pages: [], sessionId: "ses_1", outbox: [])
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].kind, .file)
        XCTAssertEqual(out[0].origin, .userAttached)
        XCTAssertEqual(out[0].id, "p1")
        XCTAssertEqual(out[0].href, "/home/u/upload/notes.txt")
        XCTAssertEqual(out[0].label, "notes.txt")
        XCTAssertEqual(out[0].bytes, 42)
    }

    /// An image mime classifies the same `file` part as `.image` (segmented
    /// control's Images tab), keeping the file in the image feed.
    func testImageMimeClassifiesAsImage() {
        let m = message(role: "user", id: "m1",
                        parts: [filePart(id: "p1", url: "file:///home/u/upload/shot.png",
                                         mime: "image/png", filename: "shot.png")])
        let out = ArtifactDerivation.derive(messages: [m], pages: [], sessionId: "ses_1", outbox: [])
        XCTAssertEqual(out[0].kind, .image)
    }

    /// An agent-pushed outbox row (send_file) surfaces as `.file` with
    /// `agentPushed` provenance.
    func testAgentOutboxPushAsFile() {
        let row = outbox(path: "/home/u/.manta-outbox/ses_1/report.pdf",
                         name: "report.pdf", size: 1234)
        let out = ArtifactDerivation.derive(messages: [], pages: [], sessionId: "ses_1", outbox: [row])
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].kind, .file)
        XCTAssertEqual(out[0].origin, .agentPushed)
        XCTAssertEqual(out[0].id, "outbox:/home/u/.manta-outbox/ses_1/report.pdf")
        XCTAssertEqual(out[0].bytes, 1234)
    }

    /// A URL pasted in a user message becomes a `.link` with the `host+path`
    /// label (trailing slash stripped).
    func testLinkInUserMessage() {
        let m = message(role: "user", id: "m1",
                        parts: [textPart(id: "p1", text: "see https://github.com/antoinedc/MantaUI/")])
        let out = ArtifactDerivation.derive(messages: [m], pages: [], sessionId: "ses_1", outbox: [])
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].kind, .link)
        XCTAssertEqual(out[0].origin, .link)
        XCTAssertEqual(out[0].id, "p1")
        XCTAssertEqual(out[0].label, "github.com/antoinedc/MantaUI")
    }

    /// A link in an ASSISTANT message must NOT appear — only user text parts
    /// contribute links.
    func testLinkInAssistantMessageDoesNotAppear() {
        let m = message(role: "assistant", id: "m1",
                        parts: [textPart(id: "p1", text: "here: https://example.com")])
        let out = ArtifactDerivation.derive(messages: [m], pages: [], sessionId: "ses_1", outbox: [])
        XCTAssertTrue(out.isEmpty)
    }

    /// Two URLs in ONE text part get distinct, deterministic ids (`part.id.0`
    /// / `part.id.1`) so they never collide as list keys, and the ids survive
    /// re-derivation.
    func testTwoUrlsInOnePartGetDistinctStableIds() {
        let m = message(role: "user", id: "m1",
                        parts: [textPart(id: "p1", text: "a https://a.com b https://b.com")])
        let out = ArtifactDerivation.derive(messages: [m], pages: [], sessionId: "ses_1", outbox: [])
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(Set(out.map(\.id)), ["p1.0", "p1.1"])

        let again = ArtifactDerivation.derive(messages: [m], pages: [], sessionId: "ses_1", outbox: [])
        XCTAssertEqual(Set(again.map(\.id)), Set(out.map(\.id)))
    }

    /// A page published from another session is workspace-linked OUT — it must
    /// never show in this conversation's list. The same page from THIS session
    /// does appear, as a `.link` with `publishedPage` provenance.
    func testPageFromAnotherSessionExcluded() {
        let other = page("other", session: "ses_OTHER")
        XCTAssertTrue(ArtifactDerivation.derive(messages: [], pages: [other], sessionId: "ses_1", outbox: []).isEmpty)

        let mine = page("preview", session: "ses_1")
        let out = ArtifactDerivation.derive(messages: [], pages: [mine], sessionId: "ses_1", outbox: [])
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].kind, .link)
        XCTAssertEqual(out[0].origin, .publishedPage)
        XCTAssertEqual(out[0].id, "page:preview")
        XCTAssertEqual(out[0].label, "preview")
        XCTAssertEqual(out[0].href, "https://preview.pages.mantaui.com")
    }

    /// An outbox row from another session is workspace-linked OUT too.
    func testOutboxFromAnotherSessionExcluded() {
        let row = outbox(path: "/home/u/.manta-outbox/ses_OTHER/x.txt", name: "x.txt",
                         size: 12, session: "ses_OTHER")
        XCTAssertTrue(ArtifactDerivation.derive(messages: [], pages: [], sessionId: "ses_1", outbox: [row]).isEmpty)
    }

    /// Empty everything yields an empty list — the card's honest empty state.
    func testEmptyInputYieldsEmptyOutput() {
        XCTAssertTrue(ArtifactDerivation.derive(messages: [], pages: [], sessionId: "ses_1", outbox: []).isEmpty)
    }

    // MARK: - Extra invariants

    /// A synthetic or ignored user text part never contributes links.
    func testSyntheticAndIgnoredPartsAreExcluded() {
        let synthetic = OpencodePart(type: "text", id: "s", messageID: "m1",
                                     text: "https://example.com", synthetic: true)
        let ignored = OpencodePart(type: "text", id: "i", messageID: "m1",
                                   text: "https://example.org", ignored: true)
        let m = message(role: "user", id: "m1", parts: [synthetic, ignored])
        XCTAssertTrue(ArtifactDerivation.derive(messages: [m], pages: [], sessionId: "ses_1", outbox: []).isEmpty)
    }

    /// Results come back newest-first (desktop ordering).
    func testNewestFirstOrdering() {
        let older = message(role: "user", id: "older", created: 1500000000000,
                            parts: [filePart(id: "old", url: "file:///home/u/old.txt",
                                             mime: "text/plain", filename: "old.txt")])
        let newer = message(role: "user", id: "newer", created: 1750000000000,
                            parts: [filePart(id: "new", url: "file:///home/u/new.txt",
                                             mime: "text/plain", filename: "new.txt")])
        let out = ArtifactDerivation.derive(messages: [older, newer], pages: [], sessionId: "ses_1", outbox: [])
        XCTAssertEqual(out.map(\.id), ["new", "old"])
    }
}
