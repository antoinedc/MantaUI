import Foundation

// ===========================================================================
// WS01 F1 — pure model for inline files and media.
//
// FOUNDATION-ONLY ON PURPOSE (D19): compiled by the Linux `swift test` view of
// the app. Depends only on MantaModels.swift and ChatJSON.swift. No
// `URLRequest`, no `URLSession`, no hashing — those live in the app-only
// `MantaAPIClient+Transcript.swift` / `TranscriptFileStager.swift`.
//
// ROW IDENTITY (mobile/native/AGENTS.md §6): every id here is derived from the
// data itself (media handle, or the show call's message id + resolved path;
// message id + part order for user files) — never an index, a UUID or a
// render-time value. A refetch re-derives the same id, so TiledView updates the
// row in place instead of inserting a duplicate.
// ===========================================================================

// MARK: - Entry

enum TranscriptMediaKind: String, Equatable, Sendable {
    case image
    case video
}

enum TranscriptMediaState: Equatable, Sendable {
    case pending
    case ready
    case failed
}

struct TranscriptMediaGeometryInput: Equatable, Sendable {
    var width: Double?
    var height: Double?
    var aspectRatio: Double?

    init(width: Double? = nil, height: Double? = nil, aspectRatio: Double? = nil) {
        self.width = width
        self.height = height
        self.aspectRatio = aspectRatio
    }
}

struct TranscriptMediaEntry: Equatable, Sendable {
    /// `TranscriptMediaIdentity.id(...)`.
    let id: String
    /// The message the card renders under. Set once, on first sight.
    var ownerMessageID: String
    /// First-sight order, for deterministic ordering.
    var seq: Int
    var state: TranscriptMediaState
    var kind: TranscriptMediaKind
    /// IMMUTABLE once set by a begin (see "Geometry").
    var reserved: TranscriptMediaGeometryInput
    var count: Int?
    var title: String?
    /// Box path for /api/peek (ready only).
    var path: String?
    var mime: String?
    /// Bytes, when known.
    var size: Int64?
    var beganAt: Date?
    var handle: String?
    /// Live only: the session turn number at FIRST sight; never rewritten.
    /// Canonical entries: 0.
    var turn: Int = 0
    /// Set ONLY by `TranscriptMediaSessionState.vended()`; canonical entries: false.
    var inCurrentTurn: Bool = false
}

/// The `media` bus frame payload (`MediaEventPayload`, src/shared/types.ts).
/// Routing fields use an uppercase `ID` (BET-1328).
struct TranscriptMediaFrame: Codable, Equatable, Sendable {
    var action: String
    var handle: String?
    var sessionID: String?
    var messageID: String?
    var kind: String?
    var width: Double?
    var height: Double?
    var aspectRatio: Double?
    var count: Int?
    var title: String?
    var path: String?
    var mime: String?
    var size: Int64?

    init(action: String, handle: String? = nil, sessionID: String? = nil, messageID: String? = nil,
         kind: String? = nil, width: Double? = nil, height: Double? = nil, aspectRatio: Double? = nil,
         count: Int? = nil, title: String? = nil, path: String? = nil, mime: String? = nil, size: Int64? = nil) {
        self.action = action
        self.handle = handle
        self.sessionID = sessionID
        self.messageID = messageID
        self.kind = kind
        self.width = width
        self.height = height
        self.aspectRatio = aspectRatio
        self.count = count
        self.title = title
        self.path = path
        self.mime = mime
        self.size = size
    }
}

enum TranscriptMediaIdentity {
    /// A handle gives `media:h:<handle>`; without one the id is the show call's
    /// message plus the resolved path, `media:s:<messageID>:<path>`. The box
    /// reports the same resolved path in the live frame and in the persisted
    /// tool output, so live and canonical data agree.
    static func id(handle: String?, showMessageID: String, path: String) -> String {
        if let handle, !handle.isEmpty { return "media:h:\(handle)" }
        return "media:s:\(showMessageID):\(path)"
    }
}

// MARK: - Live session state (the reducer)

/// Session-wide live reducer state: entries keyed by id, a seq counter, and the
/// session's TURN counter (current-turn eligibility, see "Live tail").
struct TranscriptMediaSessionState: Equatable, Sendable {
    var byID: [String: TranscriptMediaEntry] = [:]
    var nextSeq = 0
    /// 0 = no turn observed yet.
    var currentTurn = 0
    /// True between a turn's start and the session going idle.
    var turnOpen = false
    static let maxEntries = 100

    /// Running observation from the event store. `true` while no turn is open
    /// starts a new one; `false` closes it; repeated equal values are no-ops.
    mutating func observeRunning(_ running: Bool) {
        if running {
            openTurnIfNeeded()
        } else {
            turnOpen = false
        }
    }

    private mutating func openTurnIfNeeded() {
        if !turnOpen {
            currentTurn += 1
            turnOpen = true
        }
    }

    /// Apply one `media` frame. An unknown action, or a frame that cannot be
    /// identified, changes nothing (and opens no turn). A frame that arrives
    /// before the running edge opens the turn itself.
    mutating func apply(_ frame: TranscriptMediaFrame, now: Date) {
        switch frame.action {
        case "begin": applyBegin(frame, now: now)
        case "show": applyShow(frame)
        case "fail": applyFail(frame)
        default: return
        }
    }

    private mutating func applyBegin(_ frame: TranscriptMediaFrame, now: Date) {
        guard let handle = Self.nonEmpty(frame.handle) else { return }
        let id = TranscriptMediaIdentity.id(handle: handle, showMessageID: "", path: "")
        guard byID[id] == nil else { return }
        openTurnIfNeeded()
        let entry = TranscriptMediaEntry(
            id: id,
            ownerMessageID: frame.messageID ?? "",
            seq: takeSeq(),
            state: .pending,
            kind: frame.kind == "video" ? .video : .image,
            reserved: TranscriptMediaGeometryInput(
                width: Self.positive(frame.width),
                height: Self.positive(frame.height),
                aspectRatio: Self.positive(frame.aspectRatio)
            ),
            count: frame.count,
            title: Self.nonEmpty(frame.title),
            path: nil,
            mime: nil,
            size: nil,
            beganAt: now,
            handle: handle,
            turn: currentTurn
        )
        byID[id] = entry
        evict()
    }

    private mutating func applyShow(_ frame: TranscriptMediaFrame) {
        guard let path = Self.nonEmpty(frame.path) else { return }
        let handle = Self.nonEmpty(frame.handle)
        let id = TranscriptMediaIdentity.id(handle: handle, showMessageID: frame.messageID ?? "", path: path)
        let shownKind = TranscriptMediaMime.kind(of: frame.mime)
        if var existing = byID[id] {
            // The begin's reserved box is final; a show only fills the file.
            existing.state = .ready
            existing.path = path
            existing.mime = frame.mime ?? existing.mime
            existing.size = frame.size ?? existing.size
            existing.kind = shownKind ?? existing.kind
            existing.title = Self.nonEmpty(frame.title) ?? existing.title
            byID[id] = existing
            return
        }
        openTurnIfNeeded()
        byID[id] = TranscriptMediaEntry(
            id: id,
            ownerMessageID: frame.messageID ?? "",
            seq: takeSeq(),
            state: .ready,
            kind: shownKind ?? .image,
            reserved: TranscriptMediaGeometryInput(
                width: Self.positive(frame.width),
                height: Self.positive(frame.height)
            ),
            count: nil,
            title: Self.nonEmpty(frame.title),
            path: path,
            mime: frame.mime,
            size: frame.size,
            beganAt: nil,
            handle: handle,
            turn: currentTurn
        )
        evict()
    }

    private mutating func applyFail(_ frame: TranscriptMediaFrame) {
        guard let handle = Self.nonEmpty(frame.handle) else { return }
        let id = TranscriptMediaIdentity.id(handle: handle, showMessageID: "", path: "")
        if var existing = byID[id] {
            // A show already delivered the file; a late fail must not undo it.
            guard existing.state != .ready else { return }
            existing.state = .failed
            byID[id] = existing
            return
        }
        openTurnIfNeeded()
        byID[id] = TranscriptMediaEntry(
            id: id,
            ownerMessageID: frame.messageID ?? "",
            seq: takeSeq(),
            state: .failed,
            kind: frame.kind == "video" ? .video : .image,
            reserved: TranscriptMediaGeometryInput(),
            count: nil,
            title: nil,
            path: nil,
            mime: nil,
            size: nil,
            beganAt: nil,
            handle: handle,
            turn: currentTurn
        )
        evict()
    }

    private mutating func takeSeq() -> Int {
        defer { nextSeq += 1 }
        return nextSeq
    }

    /// Bound the store: evict the oldest (by seq, then id) entry, but only among
    /// entries of EARLIER turns — a current-turn entry is never evicted.
    private mutating func evict() {
        while byID.count > Self.maxEntries {
            let candidates = byID.values.filter { $0.turn < currentTurn }
            guard let oldest = candidates.min(by: { ($0.seq, $0.id) < ($1.seq, $1.id) }) else { return }
            byID.removeValue(forKey: oldest.id)
        }
    }

    /// Entries in (seq, id) order with `inCurrentTurn` stamped. This is what the
    /// store vends.
    func vended() -> [TranscriptMediaEntry] {
        byID.values
            .sorted { ($0.seq, $0.id) < ($1.seq, $1.id) }
            .map { entry in
                var copy = entry
                copy.inCurrentTurn = entry.turn == currentTurn
                return copy
            }
    }

    private static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }

    private static func positive(_ n: Double?) -> Double? {
        guard let n, n.isFinite, n > 0 else { return nil }
        return n
    }
}

// MARK: - Mime helpers

enum TranscriptMediaMime {
    static func kind(of mime: String?) -> TranscriptMediaKind? {
        guard let mime = mime?.lowercased() else { return nil }
        if mime.hasPrefix("image/") { return .image }
        if mime.hasPrefix("video/") { return .video }
        return nil
    }
}

enum TranscriptMediaReconcile {
    /// Live entries the canonical list (the box's `view.media`) does not cover (by id), in (seq, id)
    /// order. This is the ONLY retirement rule: a live entry stops rendering
    /// exactly when a canonical entry with the same media identity replaces it.
    static func liveOnly(live: [TranscriptMediaEntry], canonical: [TranscriptMediaEntry]) -> [TranscriptMediaEntry] {
        let known = Set(canonical.map(\.id))
        return live
            .filter { !known.contains($0.id) }
            .sorted { ($0.seq, $0.id) < ($1.seq, $1.id) }
    }
}

// MARK: - Geometry

enum TranscriptMediaGeometry {
    static let defaultAspect = 16.0 / 9.0
    /// iOS-only: a phone column cannot fit a 1:3 image.
    static let maxHeight = 480.0
    /// = `Metrics.type.inlineMaxW` (a pure copy; a Mac test pins the equality).
    static let inlineMaxWidth = 520.0
    /// `MAX_PREVIEW_BYTES` (chatUtils.ts).
    static let maxPreviewBytes: Int64 = 25 * 1024 * 1024

    /// `resolveMediaAspect`: explicit dimensions win, then the declared aspect
    /// ratio, then 16:9.
    static func aspect(_ g: TranscriptMediaGeometryInput) -> Double {
        if let w = g.width, let h = g.height, w > 0, h > 0 { return w / h }
        if let ratio = g.aspectRatio, ratio > 0 { return ratio }
        return defaultAspect
    }

    /// The widest the box may be: the inline cap, and narrow enough that its
    /// height never exceeds `maxHeight`. The card draws with this as a max width
    /// over an aspect-ratio box, so it needs no measured width.
    static func maxWidth(_ g: TranscriptMediaGeometryInput) -> Double {
        min(inlineMaxWidth, maxHeight * aspect(g))
    }

    /// The reserved box for `availableWidth`.
    static func box(_ g: TranscriptMediaGeometryInput, availableWidth: Double) -> (width: Double, height: Double) {
        let ratio = aspect(g)
        let w = min(max(availableWidth, 0), maxWidth(g))
        return (w, w / ratio)
    }

    /// `mediaGrid`: at most 4 numbered tiles in 2 columns; the rest collapse
    /// behind "+N more".
    static func grid(count: Int?) -> (tiles: Int, more: Int) {
        let c = max(count ?? 0, 0)
        if c <= 1 { return (1, 0) }
        return (min(c, 4), max(0, c - 4))
    }
}

// MARK: - Files attached to a user message

struct TranscriptFileRef: Equatable, Sendable {
    enum Source: Equatable, Sendable {
        case boxPath(String)
        case dataURL(mime: String?, base64: String)
        case none
    }

    let partID: String
    let filename: String
    let mime: String?
    let source: Source
}

enum TranscriptStagingKey {
    /// The canonical, collision-free key INPUT (hashing happens app-side with
    /// CryptoKit). The ENTIRE base64 payload is part of a data source's tag: a
    /// truncated prefix would let two different equal-length attachments collide.
    static func input(boxID: String?, serverURL: String?, source: TranscriptFileRef.Source) -> String {
        let tag: String
        switch source {
        case .boxPath(let path): tag = "path:" + path
        case .dataURL(let mime, let base64): tag = "data:" + (mime ?? "") + ":" + base64
        case .none: tag = "none"
        }
        return (boxID ?? "") + "\n" + (serverURL ?? "") + "\n" + tag
    }
}

enum TranscriptPeekRequest {
    /// `<serverURL>/api/peek?path=<encoded>`, built with URLComponents. The query
    /// is encoded to RFC 3986 unreserved characters only, so `&`, `#`, `+` and
    /// spaces in a path survive. nil if the server URL is unusable.
    static func url(serverURL: URL, path: String) -> URL? {
        guard var comps = URLComponents(url: serverURL, resolvingAgainstBaseURL: false) else { return nil }
        var base = comps.path
        while base.hasSuffix("/") { base.removeLast() }
        comps.path = base + "/api/peek"
        let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        guard let encoded = path.addingPercentEncoding(withAllowedCharacters: unreserved) else { return nil }
        comps.percentEncodedQuery = "path=" + encoded
        return comps.url
    }
}

enum TranscriptFileParse {
    /// The `file` parts of a message, in wire order. `url` is either the file's
    /// `file://<abs path>` source URI (the box builds it raw, so only the scheme is
    /// stripped) or a `data:<mime>;base64,<…>` URL for inline data.
    static func refs(of message: OpencodeMessage) -> [TranscriptFileRef] {
        message.parts.compactMap { part -> TranscriptFileRef? in
            guard part.type == "file" else { return nil }
            let url = ChatJSON.string(part.extra["url"]) ?? ""
            let mime = ChatJSON.string(part.extra["mime"])
            let named = ChatJSON.string(part.extra["filename"]) ?? ""
            let source = source(of: url)
            var filename = named
            if filename.isEmpty, case .boxPath(let path) = source {
                filename = lastSegment(path)
            }
            if filename.isEmpty { filename = "file" }
            return TranscriptFileRef(partID: part.id, filename: filename, mime: mime, source: source)
        }
    }

    static func source(of url: String) -> TranscriptFileRef.Source {
        if url.hasPrefix("file://") {
            let path = String(url.dropFirst("file://".count))
            return path.isEmpty ? .none : .boxPath(path)
        }
        if url.hasPrefix("data:"), let comma = url.firstIndex(of: ",") {
            let header = url[url.index(url.startIndex, offsetBy: 5)..<comma]
            let parts = header.split(separator: ";", omittingEmptySubsequences: false)
            guard parts.contains(where: { $0 == "base64" }) else { return .none }
            let mime = parts.first.map { String($0) }.flatMap { $0.isEmpty ? nil : $0 }
            let payload = String(url[url.index(after: comma)...])
            return payload.isEmpty ? .none : .dataURL(mime: mime, base64: payload)
        }
        return .none
    }

    /// Decoded byte count of a base64 payload without decoding it:
    /// `len * 3 / 4 − padding`.
    static func decodedSize(base64: String) -> Int64 {
        let length = Int64(base64.utf8.count)
        var padding: Int64 = 0
        for byte in base64.utf8.reversed() {
            if byte == UInt8(ascii: "="), padding < 2 { padding += 1 } else { break }
        }
        return max(0, length * 3 / 4 - padding)
    }

    private static func lastSegment(_ path: String) -> String {
        var trimmed = path
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        if let slash = trimmed.lastIndex(of: "/") {
            return String(trimmed[trimmed.index(after: slash)...])
        }
        return trimmed
    }
}
