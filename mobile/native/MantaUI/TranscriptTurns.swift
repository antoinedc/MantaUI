import Foundation

// ===========================================================================
// WS01 — pure turn / footer / command / selection logic.
//
// FOUNDATION-ONLY ON PURPOSE (D19): this file is compiled by the Linux
// `swift test` view of the app. It depends only on MantaModels.swift and
// ChatJSON.swift. Everything here is a port of a desktop pure function
// (`computeTurnInfo`, `classifyFinish`, `describeTruncation`, `formatDuration`,
// `formatTokens`, `pastVerbFor`, `buildQuoteBlock`'s caller) so the two clients
// agree on what a finished turn's footer says.
// ===========================================================================

// MARK: - Truncation (F4)
//
// The classification and the words are the BOX's (`view.truncation` canonically, the `truncation` frame live —
// `{kind, label, hint}` either way; WS11 D8). The phone keeps only the live adapter below.

/// The single live `truncation` (the latest warning), converted to a value the mapper can compare against a message
/// id (F4).
struct TranscriptLiveTruncation: Equatable, Sendable {
    let messageID: String
    let view: TranscriptTruncationView

    /// nil when `messageID` is nil/empty or `kind` is not one of the three the box words (an unknown kind gives no
    /// badge). `hint` is nil on an older box.
    static func from(payload: StreamTruncationPayload) -> TranscriptLiveTruncation? {
        guard let messageID = payload.messageID, !messageID.isEmpty,
              TranscriptTruncationKind(rawValue: payload.kind) != nil else { return nil }
        return TranscriptLiveTruncation(
            messageID: messageID,
            view: TranscriptTruncationView(kind: payload.kind, label: payload.label, hint: payload.hint)
        )
    }
}

// MARK: - Turn info (F4)
//
// Which message ends a finished turn, its duration and tokens are the BOX's (`view.turn`); this keeps the wording.

enum TranscriptTurns {
    /// A finished background run starts a turn exactly like a user message does: it carries a `background-result`
    /// part. Still read by the mapper for the reply menu's turn text (what is "this turn's prose").
    static func isBackgroundResult(_ message: OpencodeMessage) -> Bool {
        message.parts.contains { $0.type == "background-result" }
    }

    /// "Pondered for 1m44s · 12.4k tokens", or nil when the turn has no duration.
    static func summary(_ turn: TranscriptTurnView) -> String? {
        guard let ms = turn.durationMs else { return nil }
        var text = "\(TranscriptTurnVerb.past[TranscriptTurnVerb.index(for: turn.verbSeedId)]) for \(TranscriptTurnFormat.duration(ms: ms))"
        if let tokens = turn.tokens, tokens > 0 {
            text += " \u{00B7} \(TranscriptTurnFormat.tokens(tokens))"
        }
        return text
    }
}

enum TranscriptTurnFormat {
    /// Port of `formatDuration`: "<1s", "59s", "1m44s", "2h3m4s" (no spaces).
    static func duration(ms: Double) -> String {
        if !ms.isFinite || ms < 1000 { return "<1s" }
        let totalSec = Int((ms / 1000).rounded())
        let h = totalSec / 3600
        let m = (totalSec % 3600) / 60
        let s = totalSec % 60
        if h > 0 { return "\(h)h\(m)m\(s)s" }
        if m > 0 { return "\(m)m\(s)s" }
        return "\(s)s"
    }

    /// Port of `formatTokens`: "512 tokens", "12.4k tokens" (one decimal, a
    /// trailing ".0" dropped) under 100k, "148k tokens" above.
    static func tokens(_ n: Double) -> String {
        guard n.isFinite else { return "0 tokens" }
        if n < 1000 { return "\(wholeOrDecimal(n)) tokens" }
        if n < 100_000 {
            var text = oneDecimal(n / 1000, exactTie: n.rounded() == n && Int64(n) % 500 == 250)
            if text.hasSuffix(".0") { text.removeLast(2) }
            return "\(text)k tokens"
        }
        return "\(Int((n / 1000).rounded()))k tokens"
    }

    private static func wholeOrDecimal(_ n: Double) -> String {
        n.rounded() == n ? String(Int64(n)) : String(n)
    }

    /// JS `toFixed(1)`. `String(format:)` breaks an EXACT tie to even while
    /// `toFixed` takes the larger value (1.25 → "1.3"). For whole-number token
    /// counts a tie happens only when the count is 250 mod 500 (x.25 / x.75),
    /// which the caller flags with `exactTie`.
    private static func oneDecimal(_ x: Double, exactTie: Bool) -> String {
        if exactTie {
            return String(format: "%.1f", x + 0.0001)
        }
        return String(format: "%.1f", x)
    }
}

enum TranscriptTurnVerb {
    static let past = ["Cogitated", "Ruminated", "Pondered", "Reflected", "Considered", "Deliberated",
                       "Mused", "Contemplated", "Generated", "Forged", "Brewed", "Crafted"]
    static let present = ["Cogitating", "Ruminating", "Pondering", "Reflecting", "Considering", "Deliberating",
                          "Musing", "Contemplating", "Generating", "Forging", "Brewing", "Crafting"]

    /// Port of `verbIndexFor`: `h = (h*31 + charCode) | 0` over UTF-16 code units
    /// (Int32 wrapping), then `abs(h) % 12`. The magnitude goes through Int64 so
    /// `Int32.min` cannot trap.
    static func index(for id: String) -> Int {
        var h: Int32 = 0
        for unit in id.utf16 {
            h = h &* 31 &+ Int32(unit)
        }
        return Int(abs(Int64(h)) % Int64(past.count))
    }
}

// MARK: - Footer model (F4)

struct TranscriptTurnFooter: Equatable, Sendable {
    /// The message the footer follows.
    let messageID: String
    /// "Pondered for 1m44s · 12.4k tokens"; nil when there is no duration.
    let summary: String?
    /// The EFFECTIVE truncation: the box's canonical view first, the live frame as fallback.
    let truncation: TranscriptTruncationView?
    /// True only for the last assistant message of a FINISHED turn.
    let isTurnEnd: Bool
    /// The turn's prose joined with a blank line — feeds the reply menu (F6).
    /// "" when `!isTurnEnd`.
    let turnText: String
}

enum TranscriptFooterRule {
    /// A footer is emitted for a finished turn, or — alone — for any message that
    /// carries a truncation warning.
    static func shouldEmit(finishedTurn: Bool, effectiveTruncation: TranscriptTruncationView?) -> Bool {
        finishedTurn || effectiveTruncation != nil
    }
}

// MARK: - Command turns (F3)

enum TranscriptCommandOrigin {
    /// A live `commandExecuted` frame as the durable record's shape. The frame's
    /// `arguments` is always a string ("" when absent), so "" becomes nil.
    static func fromLive(name: String, arguments: String) -> OpencodeCommandOrigin {
        OpencodeCommandOrigin(name: name, arguments: arguments.isEmpty ? nil : arguments)
    }

    /// The durable `info.command` wins; the live frame only fills a message that
    /// has no durable origin.
    static func resolve(durable: OpencodeCommandOrigin?, live: OpencodeCommandOrigin?) -> OpencodeCommandOrigin? {
        durable ?? live
    }
}

// MARK: - Selection + reply menu (F6)

enum TranscriptSelection {
    /// The selected substring of `text` for an `NSRange` (UTF-16 offsets, as
    /// UIKit reports them). Out-of-bounds ranges are clamped; an empty result is
    /// nil. Converting through `Range(_:in:)` keeps a character from ever being
    /// split.
    static func text(in text: String, range: NSRange) -> String? {
        let total = text.utf16.count
        guard range.location != NSNotFound, range.length > 0 else { return nil }
        let start = max(0, min(range.location, total))
        let end = min(total, range.location + range.length)
        guard end > start,
              let swiftRange = Range(NSRange(location: start, length: end - start), in: text) else { return nil }
        let slice = String(text[swiftRange])
        return slice.isEmpty ? nil : slice
    }
}

enum TranscriptReplyMenuModel {
    enum Item: Hashable, Sendable {
        case quote
        case quoteNewSession
        case selectText
    }

    /// The reply menu's items. No text → no menu. A surface that cannot quote
    /// (subagent drill-in) still offers Select text, since copying is read-only.
    static func items(canQuote: Bool, turnText: String) -> [Item] {
        guard !turnText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        return canQuote ? [.quote, .quoteNewSession, .selectText] : [.selectText]
    }
}
