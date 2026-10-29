import Foundation
@testable import MantaUI

// TEST FIXTURE ONLY. The box decides a transcript's turn footers and truncations (`message.view`, WS11 D8; rules in
// src/server/transcriptView.mjs, pinned by transcriptView.test.mjs). The phone no longer derives them, so a mapper test
// that wants a footer has to hand the mapper messages the way the box would send them. This stamps `view` onto raw
// fixtures with the box's rules (same cases, same words) so those tests keep their shape; it is never built into the
// app, and the rules' truth is the node test.
enum BoxViewFixture {
    static func stamp(_ messages: [OpencodeMessage], running: Bool = false) -> [OpencodeMessage] {
        let turns = turnViews(messages, running: running)
        return messages.map { m in
            var copy = m
            copy.view = TranscriptMessageView(turn: turns[m.info.id], truncation: truncation(of: m))
            if copy.view?.turn == nil, copy.view?.truncation == nil { copy.view = nil }
            return copy
        }
    }

    static func turnViews(_ messages: [OpencodeMessage], running: Bool) -> [String: TranscriptTurnView] {
        var out: [String: TranscriptTurnView] = [:]
        let lastID = messages.last?.info.id
        var i = 0
        while i < messages.count {
            let head = messages[i]
            guard head.info.role.rawValue == "user" || TranscriptTurns.isBackgroundResult(head) else {
                i += 1
                continue
            }
            var j = i + 1
            var firstStart: Double?
            var lastEnd: Double?
            var tokens = 0.0
            var last: OpencodeMessage?
            var seed: String?
            while j < messages.count, messages[j].info.role.rawValue == "assistant", !TranscriptTurns.isBackgroundResult(messages[j]) {
                let m = messages[j]
                if firstStart == nil, let created = m.info.time?.created { firstStart = created }
                if let completed = m.info.time?.completed { lastEnd = completed }
                if let usage = m.info.tokens { tokens += (usage.output ?? 0) + (usage.reasoning ?? 0) }
                if seed == nil { seed = m.info.id }
                last = m
                j += 1
            }
            if let last, let seed, !(running && last.info.id == lastID), last.info.time?.completed != nil {
                var duration: Double?
                if let firstStart, let lastEnd, lastEnd > firstStart { duration = lastEnd - firstStart }
                out[last.info.id] = TranscriptTurnView(durationMs: duration, tokens: tokens > 0 ? tokens : nil, verbSeedId: seed)
            }
            i = j
        }
        return out
    }

    static func truncation(of message: OpencodeMessage) -> TranscriptTruncationView? {
        guard message.info.role.rawValue == "assistant" else { return nil }
        let stepReason = message.parts.last(where: { p in
            p.type == "step-finish" && !(ChatJSON.string(p.extra["reason"]) ?? "").isEmpty
        }).flatMap { ChatJSON.string($0.extra["reason"]) }
        guard let finish = stepReason ?? message.info.finish, !finish.isEmpty else { return nil }
        let f = finish.lowercased()
        let toolUse = message.info.finish == "tool-calls"
        if f == "model_context_window_exceeded" {
            return TranscriptTruncationView(kind: "context-wall", label: "truncated (context full)",
                hint: "Response hit the model's context window mid-generation. Run /compact to free space, or start a new session.")
        }
        if f == "max_tokens" || f == "length" {
            return toolUse
                ? TranscriptTruncationView(kind: "tool-cutoff", label: "tool call cut off \u{2014} retry needed",
                    hint: "The model was emitting a tool call when it hit the output limit, so the call is incomplete and won't execute. Retry the turn (optionally with a higher max output).")
                : TranscriptTruncationView(kind: "output-cap", label: "truncated (output limit)",
                    hint: "Response hit the per-turn output cap. Ask the model to continue, or raise the max output budget for this provider.")
        }
        return nil
    }
}
