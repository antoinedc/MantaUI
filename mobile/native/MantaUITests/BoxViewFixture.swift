import Foundation
@testable import MantaUI

// TEST FIXTURE ONLY. The box decides a transcript's turn footers and truncations (`message.view`, WS11 D8) and which tool
// calls form a run (`part.view.runId`, `message.view.runs`, D11); rules in src/server/transcriptView.mjs and
// transcriptRuns.mjs, pinned by transcriptView.test.mjs, and tied to the stamper below by BoxViewFixtureParityTests through
// the shared golden file. The phone no longer derives them, so a mapper test
// that wants a footer has to hand the mapper messages the way the box would send them. This stamps `view` onto raw
// fixtures with the box's rules (same cases, same words) so those tests keep their shape; it is never built into the
// app, and the rules' truth is the node test.
enum BoxViewFixture {
    static func stamp(_ messages: [OpencodeMessage], running: Bool = false) -> [OpencodeMessage] {
        let turns = turnViews(messages, running: running)
        return messages.map { m in
            var copy = m
            // Keep what a fixture already carries (e.g. hand-made `media`); add the box's turn + truncation.
            var view = m.view ?? TranscriptMessageView()
            view.turn = turns[m.info.id] ?? view.turn
            view.truncation = truncation(of: m) ?? view.truncation
            copy.view = (view.turn == nil && view.truncation == nil && view.media.isEmpty) ? nil : view
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

    // MARK: Runs (WS11 D11) — membership only; the wording is the box's and is a stub here

    /// Stamps `part.view.{activity,runId,segmentId,gen}` and `message.view.runs` onto raw fixtures the way the box would
    /// (the same membership rules: a drawing user message / non-blank text / a handoff / any other drawing part ends the run;
    /// whitespace text and todo writes are transparent; non-blank reasoning starts a segment). Turn footers are NOT added
    /// (use `stamp`), so a test that counts blocks is not disturbed. The run summary is a stub (`"N calls"`): the real
    /// wording is the box's.
    static func stampRuns(_ messages: [OpencodeMessage], epoch: String = "E1") -> [OpencodeMessage] {
        struct Run {
            var id: String
            var owner: String
            var partIDs: [String] = []
            var partStatus: [String: String] = [:]
            var segments: [String]
            var segmentOf: [String: String] = [:]
        }
        var runs: [String: Run] = [:]
        var order: [String] = []
        var open: String?
        var segBreak = false

        func blank(_ s: String?) -> Bool { (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        func visible(_ m: OpencodeMessage) -> [OpencodePart] {
            m.parts.filter { p in
                switch p.type {
                case "text": return p.synthetic != true && p.ignored != true && !(p.text ?? "").isEmpty
                case "step-start", "step-finish": return false
                case "tool":
                    let t = ChatJSON.string(p.extra["tool"]) ?? ""
                    return t != "todowrite" && t != "todo_write"
                default: return true
                }
            }
        }
        func status(_ p: OpencodePart) -> String {
            p.type == "patch" ? "completed" : (ChatJSON.string(ChatJSON.object(p.extra["state"])?["status"]) ?? "pending")
        }
        func userDraws(_ m: OpencodeMessage) -> Bool {
            let text = m.parts.filter { $0.type == "text" && $0.synthetic != true && $0.ignored != true }
                .map { $0.text ?? "" }.joined(separator: "\n")
            if text.trimmingCharacters(in: .whitespaces).hasPrefix("[background job \"") { return false }
            return !blank(text) || m.parts.contains { $0.type == "file" }
        }

        for m in messages {
            if m.info.role.rawValue == "user" {
                if userDraws(m) { open = nil; segBreak = false }
                continue
            }
            for p in visible(m) {
                if p.type == "tool", (ChatJSON.string(p.extra["tool"]) ?? "").lowercased() == "handoff" {
                    open = nil; segBreak = false
                    continue
                }
                if p.type == "tool" || p.type == "patch" {
                    if open == nil {
                        runs[p.id] = Run(id: p.id, owner: m.info.id, segments: [p.id])
                        order.append(p.id)
                        open = p.id
                        segBreak = false
                    } else if segBreak, let current = open, var run = runs[current] {
                        run.segments.append(p.id)
                        runs[current] = run
                        segBreak = false
                    }
                    if let current = open, var run = runs[current] {
                        run.partIDs.append(p.id)
                        run.partStatus[p.id] = status(p)
                        run.segmentOf[p.id] = run.segments.last
                        runs[current] = run
                    }
                    continue
                }
                if p.type == "text", blank(p.text) { continue }
                if p.type == "reasoning" {
                    if !blank(p.text), open != nil { segBreak = true }
                    continue
                }
                open = nil
                segBreak = false
            }
        }

        func summary(_ ids: [String], _ run: Run) -> TranscriptRunSummary {
            let unfinished = ids.filter { let s = run.partStatus[$0] ?? ""; return s != "completed" && s != "error" }
            let failed = ids.filter { run.partStatus[$0] == "error" }.count
            let tone: GroupTone = !unfinished.isEmpty ? .running : (failed > 0 ? .warn : .ok)
            return TranscriptRunSummary(label: "\(ids.count) calls", calls: ids.count, failed: failed, tone: tone,
                                        live: unfinished.isEmpty ? nil : TranscriptLiveActivity(kind: .other, label: "Running"))
        }
        func view(_ run: Run) -> TranscriptRunView {
            let segments = run.segments.count > 1
                ? run.segments.map { seg in TranscriptRunSegment(id: seg, summary: summary(run.partIDs.filter { run.segmentOf[$0] == seg }, run)) }
                : []
            return TranscriptRunView(id: run.id, ownerMessageId: run.owner, rev: TranscriptRunRev(epoch: epoch, gen: 1, seq: 0),
                                     summary: summary(run.partIDs, run), segments: segments)
        }

        var placed = Set<String>()
        return messages.map { m in
            var copy = m
            var touched: [String] = []
            copy.parts = m.parts.map { p in
                guard let runID = order.first(where: { runs[$0]?.partIDs.contains(p.id) == true }), let run = runs[runID] else { return p }
                if !touched.contains(runID) { touched.append(runID) }
                var out = p
                let neutral = TranscriptActivityView(kind: .other, status: ActivityStatus.normalize(run.partStatus[p.id]),
                                                     label: ChatJSON.string(p.extra["tool"]) ?? "tool", target: "", counted: p.type == "tool")
                out.extra["view"] = TranscriptPartView.extra(
                    activity: neutral, runId: runID, segmentId: run.segments.count > 1 ? run.segmentOf[p.id] : nil, gen: 1)
                return out
            }
            guard !touched.isEmpty else { return copy }
            var v = copy.view ?? TranscriptMessageView()
            v.runs = touched.compactMap { id -> TranscriptRunEntry? in
                guard let run = runs[id] else { return nil }
                if placed.insert(id).inserted { return .view(view(run)) }
                return .ref(TranscriptRunRef(id: id, rev: TranscriptRunRev(epoch: epoch, gen: 1, seq: 0)))
            }
            copy.view = v
            return copy
        }
    }
}
