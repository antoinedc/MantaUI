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

enum TranscriptTruncationKind: String, Equatable, Sendable {
    case outputCap = "output-cap"
    case contextWall = "context-wall"
    case toolCutoff = "tool-cutoff"
}

enum TranscriptTruncation {
    /// Port of `classifyFinish` (src/shared/streamInterpretation.mjs): nil for a
    /// benign finish. `lastPartIsToolUse` promotes an output cap to a cut-off tool
    /// call.
    static func classify(_ finish: String?, lastPartIsToolUse: Bool) -> TranscriptTruncationKind? {
        guard let finish, !finish.isEmpty else { return nil }
        let f = finish.lowercased()
        if f == "model_context_window_exceeded" { return .contextWall }
        if f == "max_tokens" || f == "length" {
            return lastPartIsToolUse ? .toolCutoff : .outputCap
        }
        return nil
    }

    /// Port of `describeTruncation`. The strings are verbatim copies.
    static func describe(_ kind: TranscriptTruncationKind) -> (label: String, hint: String) {
        switch kind {
        case .outputCap:
            return (
                "truncated (output limit)",
                "Response hit the per-turn output cap. Ask the model to continue, or raise the max output budget for this provider."
            )
        case .contextWall:
            return (
                "truncated (context full)",
                "Response hit the model's context window mid-generation. Run /compact to free space, or start a new session."
            )
        case .toolCutoff:
            return (
                "tool call cut off \u{2014} retry needed",
                "The model was emitting a tool call when it hit the output limit, so the call is incomplete and won't execute. Retry the turn (optionally with a higher max output)."
            )
        }
    }

    /// The truncation the TRANSCRIPT itself records for an assistant message: the
    /// `step-finish` part's `reason` (the raw provider finish), falling back to
    /// `info.finish`. Mirrors the box's own classification
    /// (`streamInterp.mjs`: `classifyFinish(rawFinish ?? finish, {lastPartIsToolUse:
    /// finish === "tool-calls"})`).
    static func kind(of message: OpencodeMessage) -> TranscriptTruncationKind? {
        let stepFinish = message.parts.last(where: { part in
            guard part.type == "step-finish" else { return false }
            return !(ChatJSON.string(part.extra["reason"]) ?? "").isEmpty
        })
        let stepReason = stepFinish.flatMap { ChatJSON.string($0.extra["reason"]) }
        let finish = stepReason ?? message.info.finish
        return classify(finish, lastPartIsToolUse: message.info.finish == "tool-calls")
    }
}

/// WS02's existing single live `truncation` (the latest warning), converted to a
/// value the mapper can compare against a message id (F4).
struct TranscriptLiveTruncation: Equatable, Sendable {
    let messageID: String
    let kind: TranscriptTruncationKind

    /// nil when `messageID` is nil/empty or `kind` is not one of the three raw
    /// values (an unknown kind gives no badge).
    static func from(kind: String, messageID: String?) -> TranscriptLiveTruncation? {
        guard let messageID, !messageID.isEmpty,
              let parsed = TranscriptTruncationKind(rawValue: kind) else { return nil }
        return TranscriptLiveTruncation(messageID: messageID, kind: parsed)
    }
}

// MARK: - Turn info (F4)

struct TranscriptTurnInfo: Equatable, Sendable {
    let durationMs: Double?
    let tokens: Double?
    let verbSeedID: String
}

enum TranscriptTurns {
    /// A finished background run starts a turn exactly like a user message does
    /// (desktop `isBackgroundResultMessage`): it carries a `background-result`
    /// part. (The wire's `info.background` flag always accompanies that part.)
    static func isBackgroundResult(_ message: OpencodeMessage) -> Bool {
        message.parts.contains { $0.type == "background-result" }
    }

    /// Port of `computeTurnInfo` over the FULL message list (settled + in-flight),
    /// keyed by the turn's LAST assistant message id. A turn gets no entry when its
    /// last assistant message has no `time.completed`, or — while `running` — when
    /// that message is the transcript's last.
    static func info(_ messages: [OpencodeMessage], running: Bool) -> [String: TranscriptTurnInfo] {
        var out: [String: TranscriptTurnInfo] = [:]
        let lastID = messages.last?.info.id
        var i = 0
        while i < messages.count {
            let head = messages[i]
            guard head.info.role.rawValue == "user" || isBackgroundResult(head) else {
                i += 1
                continue
            }
            var j = i + 1
            var firstStart: Double?
            var lastEnd: Double?
            var tokens = 0.0
            var lastAssistant: OpencodeMessage?
            var seed: String?
            while j < messages.count,
                  messages[j].info.role.rawValue == "assistant",
                  !isBackgroundResult(messages[j]) {
                let m = messages[j]
                if firstStart == nil, let created = m.info.time?.created { firstStart = created }
                if let completed = m.info.time?.completed { lastEnd = completed }
                if let usage = m.info.tokens { tokens += (usage.output ?? 0) + (usage.reasoning ?? 0) }
                if seed == nil { seed = m.info.id }
                lastAssistant = m
                j += 1
            }
            if let last = lastAssistant, let seed,
               !(running && last.info.id == lastID),
               last.info.time?.completed != nil {
                var duration: Double?
                if let firstStart, let lastEnd, lastEnd > firstStart { duration = lastEnd - firstStart }
                out[last.info.id] = TranscriptTurnInfo(
                    durationMs: duration,
                    tokens: tokens > 0 ? tokens : nil,
                    verbSeedID: seed
                )
            }
            i = j
        }
        return out
    }

    /// "Pondered for 1m44s · 12.4k tokens", or nil when the turn has no duration.
    static func summary(_ info: TranscriptTurnInfo) -> String? {
        guard let ms = info.durationMs else { return nil }
        var text = "\(TranscriptTurnVerb.past[TranscriptTurnVerb.index(for: info.verbSeedID)]) for \(TranscriptTurnFormat.duration(ms: ms))"
        if let tokens = info.tokens, tokens > 0 {
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
    /// The EFFECTIVE truncation: canonical (transcript) first, live as fallback.
    let truncation: TranscriptTruncationKind?
    /// True only for the last assistant message of a FINISHED turn.
    let isTurnEnd: Bool
    /// The turn's prose joined with a blank line — feeds the reply menu (F6).
    /// "" when `!isTurnEnd`.
    let turnText: String
}

enum TranscriptFooterRule {
    /// A footer is emitted for a finished turn, or — alone — for any message that
    /// carries a truncation warning.
    static func shouldEmit(finishedTurn: Bool, effectiveTruncation: TranscriptTruncationKind?) -> Bool {
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
