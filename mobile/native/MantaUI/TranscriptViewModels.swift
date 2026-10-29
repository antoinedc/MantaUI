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

/// `message.view`.
struct TranscriptMessageView: Codable, Equatable, Sendable {
    var turn: TranscriptTurnView?
    var truncation: TranscriptTruncationView?

    init(turn: TranscriptTurnView? = nil, truncation: TranscriptTruncationView? = nil) {
        self.turn = turn
        self.truncation = truncation
    }

    private enum CodingKeys: String, CodingKey { case turn, truncation }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else {
            turn = nil
            truncation = nil
            return
        }
        turn = (try? c.decodeIfPresent(TranscriptTurnView.self, forKey: .turn)) ?? nil
        truncation = (try? c.decodeIfPresent(TranscriptTruncationView.self, forKey: .truncation)) ?? nil
    }
}
