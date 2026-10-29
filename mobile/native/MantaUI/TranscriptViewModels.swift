import Foundation

// ===========================================================================
// WS11 D8–D11 — what the BOX says a transcript means.
//
// `opencode:messages` / `opencode:message` called with `view: true` carry
// `message.view` (and, from D9/D11, `part.view`): the finished turn's footer, a
// truncation warning, canonical media entries, tool-run wording. The phone no
// longer derives any of it; it decodes and shows it.
//
// FOUNDATION-ONLY ON PURPOSE (D19): compiled by the Linux `swift test` view.
//
// Decoding is LENIENT by construction: a malformed or newer-than-us `view` must
// never fail the message it rides on (the message is the transcript; the view is
// decoration), so every field is `try?` and a non-object decodes to "empty".
// ===========================================================================

/// The kinds of truncation the box words (`kind` on the wire). Used only to decide whether a LIVE frame names a kind
/// worth a badge — the words themselves are the box's.
enum TranscriptTruncationKind: String, Equatable, Sendable {
    case outputCap = "output-cap"
    case contextWall = "context-wall"
    case toolCutoff = "tool-cutoff"
}

/// A finished turn, as the box decided it (`view.turn`): duration (nil when it has none), output+reasoning tokens
/// (nil when zero) and the id the footer verb is seeded from.
struct TranscriptTurnView: Codable, Equatable, Sendable {
    var durationMs: Double?
    var tokens: Double?
    var verbSeedId: String

    init(durationMs: Double? = nil, tokens: Double? = nil, verbSeedId: String) {
        self.durationMs = durationMs
        self.tokens = tokens
        self.verbSeedId = verbSeedId
    }

    private enum CodingKeys: String, CodingKey { case durationMs, tokens, verbSeedId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        durationMs = (try? c.decodeIfPresent(Double.self, forKey: .durationMs)) ?? nil
        tokens = (try? c.decodeIfPresent(Double.self, forKey: .tokens)) ?? nil
        verbSeedId = try c.decode(String.self, forKey: .verbSeedId)
    }
}

/// A truncation as the box words it: the pill text is `label`; the explanation (`hint`) exists only when the box sent
/// one (an older box's live frame carries none — the pill then has no explain action).
struct TranscriptTruncationView: Codable, Equatable, Sendable {
    var kind: String
    var label: String
    var hint: String?

    init(kind: String, label: String, hint: String? = nil) {
        self.kind = kind
        self.label = label
        self.hint = (hint?.isEmpty == false) ? hint : nil
    }

    private enum CodingKeys: String, CodingKey { case kind, label, hint }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(String.self, forKey: .kind)
        label = try c.decode(String.self, forKey: .label)
        let raw = (try? c.decodeIfPresent(String.self, forKey: .hint)) ?? nil
        hint = (raw?.isEmpty == false) ? raw : nil
    }
}

/// One canonical inline-media entry the box reconstructed (`view.media`, D9). `id` is the identity rule
/// (`media:h:<handle>` / `media:s:<messageId>:<path>`); `aspectRatio` / `count` are the begin's reserved box.
struct TranscriptMediaView: Codable, Equatable, Sendable {
    var id: String
    var kind: String
    var path: String?
    var mime: String?
    var width: Double?
    var height: Double?
    var aspectRatio: Double?
    var count: Int?
    var size: Int64?
    var title: String?
    var handle: String?

    private enum CodingKeys: String, CodingKey { case id, kind, path, mime, width, height, aspectRatio, count, size, title, handle }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "image"
        path = (try? c.decodeIfPresent(String.self, forKey: .path)) ?? nil
        mime = (try? c.decodeIfPresent(String.self, forKey: .mime)) ?? nil
        width = (try? c.decodeIfPresent(Double.self, forKey: .width)) ?? nil
        height = (try? c.decodeIfPresent(Double.self, forKey: .height)) ?? nil
        aspectRatio = (try? c.decodeIfPresent(Double.self, forKey: .aspectRatio)) ?? nil
        count = (try? c.decodeIfPresent(Int.self, forKey: .count)) ?? nil
        size = (try? c.decodeIfPresent(Int64.self, forKey: .size)) ?? nil
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? nil
        handle = (try? c.decodeIfPresent(String.self, forKey: .handle)) ?? nil
    }

    init(id: String, kind: String = "image", path: String? = nil, mime: String? = nil, width: Double? = nil,
         height: Double? = nil, aspectRatio: Double? = nil, count: Int? = nil, size: Int64? = nil,
         title: String? = nil, handle: String? = nil) {
        self.id = id
        self.kind = kind
        self.path = path
        self.mime = mime
        self.width = width
        self.height = height
        self.aspectRatio = aspectRatio
        self.count = count
        self.size = size
        self.title = title
        self.handle = handle
    }
}

/// `message.view`.
struct TranscriptMessageView: Codable, Equatable, Sendable {
    var turn: TranscriptTurnView?
    var truncation: TranscriptTruncationView?
    /// Ready media this message OWNS, in first-sight order. A malformed entry is skipped, never the whole list.
    var media: [TranscriptMediaView]

    init(turn: TranscriptTurnView? = nil, truncation: TranscriptTruncationView? = nil, media: [TranscriptMediaView] = []) {
        self.turn = turn
        self.truncation = truncation
        self.media = media
    }

    private enum CodingKeys: String, CodingKey { case turn, truncation, media }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else {
            turn = nil
            truncation = nil
            media = []
            return
        }
        turn = (try? c.decodeIfPresent(TranscriptTurnView.self, forKey: .turn)) ?? nil
        truncation = (try? c.decodeIfPresent(TranscriptTruncationView.self, forKey: .truncation)) ?? nil
        media = ((try? c.decodeIfPresent(LossyList<TranscriptMediaView>.self, forKey: .media)) ?? nil)?.items ?? []
    }
}

/// A list that drops the elements it cannot decode instead of failing as a whole.
struct LossyList<Element: Decodable>: Decodable {
    var items: [Element]

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var out: [Element] = []
        while !container.isAtEnd {
            if let element = try? container.decode(Element.self) {
                out.append(element)
            } else {
                _ = try? container.decode(DiscardedValue.self)
            }
        }
        items = out
    }

    private struct DiscardedValue: Decodable {}
}

// MARK: - Canonical media → entries (D9)

enum TranscriptViewMedia {
    /// Every message's `view.media`, as the entries the media card draws: ready, owned by that message, `seq` = the
    /// index in transcript order (the box already ordered them by first sight). Replaces the phone's own parsing of
    /// `media_begin` / `media_show` tool output.
    static func entries(_ messages: [OpencodeMessage]) -> [TranscriptMediaEntry] {
        var out: [TranscriptMediaEntry] = []
        for message in messages {
            for view in message.view?.media ?? [] {
                out.append(TranscriptMediaEntry(
                    id: view.id,
                    ownerMessageID: message.info.id,
                    seq: out.count,
                    state: .ready,
                    kind: view.kind == "video" ? .video : .image,
                    reserved: TranscriptMediaGeometryInput(
                        width: positive(view.width), height: positive(view.height), aspectRatio: positive(view.aspectRatio)
                    ),
                    count: view.count,
                    title: (view.title?.isEmpty == false) ? view.title : nil,
                    path: view.path,
                    mime: view.mime,
                    size: view.size,
                    beganAt: nil,
                    handle: (view.handle?.isEmpty == false) ? view.handle : nil
                ))
            }
        }
        return out
    }

    private static func positive(_ n: Double?) -> Double? {
        guard let n, n.isFinite, n > 0 else { return nil }
        return n
    }
}


// MARK: - Plan question (D10)

/// The plan card's data for a plan_exit question, decided on the box (`question.plan`).
struct PlanQuestionView: Codable, Equatable, Sendable {
    var title: String
    var text: String
    var steps: Int
    var files: Int
    /// The `.opencode/plans/*.md` file, nil when none was found.
    var path: String?
    /// The shareable plan page, nil when the box has no public base URL.
    var pageUrl: String?

    init(title: String, text: String, steps: Int = 0, files: Int = 0, path: String? = nil, pageUrl: String? = nil) {
        self.title = title
        self.text = text
        self.steps = steps
        self.files = files
        self.path = path
        self.pageUrl = pageUrl
    }

    private enum CodingKeys: String, CodingKey { case title, text, steps, files, path, pageUrl }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decode(String.self, forKey: .title)
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        steps = ((try? c.decodeIfPresent(Int.self, forKey: .steps)) ?? nil) ?? 0
        files = ((try? c.decodeIfPresent(Int.self, forKey: .files)) ?? nil) ?? 0
        path = (try? c.decodeIfPresent(String.self, forKey: .path)) ?? nil
        pageUrl = (try? c.decodeIfPresent(String.self, forKey: .pageUrl)) ?? nil
    }
}
