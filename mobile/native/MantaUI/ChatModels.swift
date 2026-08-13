import Foundation

// ===========================================================================
// S4 — chat transcript mapping (BET-596).
//
// The chat screen binds to a LIVE store fed by S1b (the /events stream,
// already interpreted by the box per §17) plus the canonical `opencode:messages`
// transcript. The components in TranscriptComponents.swift render the block
// types; this file owns the PURE mapping that turns the box's wire shapes
// into those blocks, and the small formatting/presentation decisions on top.
// Everything here is unit-testable with ordinary `OpencodeMessage` values.
//
// §17 boundary: the device never interprets raw events. The box publishes
// interpreted `stream.*` frames; the only device-side work is PRESENTATION
// (verb/target/duration wording), exactly the desktop renderer's role.
// ===========================================================================

// MARK: - JSON accessors (read-only safe helpers over JSONValue)

enum ChatJSON {
    static func string(_ v: JSONValue?) -> String? {
        if case .string(let s)? = v { return s }
        return nil
    }
    static func number(_ v: JSONValue?) -> Double? {
        if case .number(let n)? = v { return n }
        return nil
    }
    static func object(_ v: JSONValue?) -> [String: JSONValue]? {
        if case .object(let o)? = v { return o }
        return nil
    }
    static func array(_ v: JSONValue?) -> [JSONValue]? {
        if case .array(let a)? = v { return a }
        return nil
    }
}

// MARK: - Step-row presentation (§8)

/// The §8 step-row verb. opencode names a tool by its id; the design shows a
/// short verb (Ran / Read / Edit / Search). Unknown tools fall back to the
/// tool id itself — honest, never invented.
enum StepVerb {
    static func text(for tool: String) -> String {
        switch tool.lowercased() {
        case "bash", "exec", "powershell", "deno", "bun": return "Ran"
        case "read", "glance", "write_file": return "Read"
        case "write", "edit", "str_replace_editor", "patch": return "Edit"
        case "grep", "directory_search", "web_search", "search": return "Search"
        case "list": return "List"
        case "webfetch", "fetch", "browse": return "Fetched"
        default: return tool
        }
    }
}

/// The §8 step-row target: the mono string the tool acted on. Drawn from the
/// tool's `input` (command / filePath / pattern); falls back to the tool id.
enum ToolTarget {
    static func text(tool: String, input: JSONValue?) -> String? {
        guard let inputObject = ChatJSON.object(input) else { return nil }
        for key in ["command", "filePath", "file_path", "pattern", "url", "path"] {
            if let s = ChatJSON.string(inputObject[key]), !s.isEmpty {
                return singleLine(s)
            }
        }
        // A string-literal input ("grep foo" style) is a target on its own.
        if case .string(let s) = input, !s.isEmpty {
            return singleLine(s)
        }
        return nil
    }

    private static func singleLine(_ s: String) -> String {
        s.components(separatedBy: .newlines).first?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? s
    }
}

/// The §8 step-row duration ("0.4s", "1m12s"). nil when timeless.
enum ChatDuration {
    static func text(seconds: Double?) -> String? {
        guard let seconds, seconds >= 0 else { return nil }
        if seconds < 60 {
            return String(format: "%0.1fs", seconds)
        }
        let m = Int(seconds) / 60
        let s = Int(seconds) % 60
        return "\(m)m\(s)s"
    }
}

/// Wall-clock time for the swipe-to-reveal timestamp gutter (§8).
///
/// opencode stamps `time.created` / `time.completed` in epoch MILLISECONDS —
/// the same values the desktop's `formatClockTime` reads — so the conversion
/// lives here once rather than at each call site.
enum ChatClock {
    /// Locale-aware hour:minute ("20:06" in a 24-hour locale, "8:06 PM" in a
    /// 12-hour one). The gutter is a fixed-width strip, so the format has to be
    /// the shortest one that still reads as a time.
    private static let hourMinute: DateFormatter = {
        let f = DateFormatter()
        f.locale = .current
        f.setLocalizedDateFormatFromTemplate("j:mm")
        return f
    }()

    static func date(epochMs: Double?) -> Date? {
        guard let epochMs, epochMs > 0, epochMs.isFinite else { return nil }
        return Date(timeIntervalSince1970: epochMs / 1000)
    }

    /// "" for a missing date so a caller can render nothing without a guard.
    static func time(_ date: Date?) -> String {
        guard let date else { return "" }
        return hourMinute.string(from: date)
    }
}

/// Map a tool part's `state.status` string onto the StepStatus dot.
enum StepStatusFromTool {
    static func status(_ raw: String?) -> StepStatus {
        // Only an explicit terminal "completed" is `done`; everything else
        // (pending / running / error) is a live `running` row.
        raw?.lowercased() == "completed" ? .done : .running
    }
}

/// The §8a subagent row: extract the task-tool part into a SubagentSession.
/// The task tool part (opencode contract, see AGENTS.md "Subagent rendering")
/// carries `state.{status,title,metadata.sessionId,time}`.
enum ChatSubagentMapper {
    static func session(from part: OpencodePart) -> SubagentSession? {
        guard let state = ChatJSON.object(part.extra["state"]) else { return nil }
        let metadata = ChatJSON.object(state["metadata"])
        let childSessionId = ChatJSON.string(metadata?["sessionId"])
        let statusRaw = ChatJSON.string(state["status"])
        let title = ChatJSON.string(state["title"])
        let taskName = title ?? "subagent"

        let status: SubagentStatus = statusRaw?.lowercased() == "completed" ? .done : .running
        let time = ChatJSON.object(state["time"])
        let duration: String?
        if let start = ChatJSON.number(time?["start"]),
           let end = ChatJSON.number(time?["end"]) {
            duration = ChatDuration.text(seconds: end - start)
        } else {
            duration = nil
        }

        return SubagentSession(
            taskName: taskName,
            status: status,
            duration: duration,
            transcript: [],
            childSessionId: childSessionId
        )
    }
}

// MARK: - Transcript rollup (§8 "consecutive steps roll up")

/// Decide whether a run of consecutive step rows should collapse to a single
/// summary line. §8: three or more = roll up. Groups containing an agent row
/// are never rolled (a subagent is a session, not a step, §8a).
enum ChatRollup {
    static func shouldRoll(rows: [StepGroupRow]) -> Bool {
        rows.count >= 3 && rows.allSatisfy { if case .step = $0 { return true } else { return false } }
    }

    /// "▸ 4 steps · Ran 3, Search 1" — verb counts, in first-seen order.
    static func summary(rows: [StepGroupRow]) -> String {
        var counts: [(verb: String, n: Int)] = []
        var order: [String] = []
        for row in rows {
            guard case .step(let step) = row else { continue }
            let verb = step.verb
            if order.contains(verb) {
                if let i = order.firstIndex(of: verb) { counts[i].n += 1 }
            } else {
                order.append(verb)
                counts.append((verb, 1))
            }
        }
        let parts = counts.map { "\($0.verb) \($0.n)" }
        return "▸ \(rows.count) steps · " + parts.joined(separator: ", ")
    }
}

// MARK: - The mapper: `opencode:messages` → `[TranscriptBlock]`

/// Maps the canonical transcript (and a live stream "in progress" payload)
/// onto the existing block types.
///
/// Block-type provenance (the S4 mapping — see FINDINGS):
///   - `.user`      — from canonical user text parts. No stream event produces
///                    one; it comes from the transcript fetch.
///   - `.prose`     — from canonical assistant text parts AND, live, from the
///                    box's `stream:flush` (the running assistant turn).
///   - `.steps`     — from canonical assistant tool parts (step rows) and
///                    `stream:subagent` / task-tool parts (agent rows).
///
/// The stream alone cannot produce `.user` or completed `.steps`/`.prose`;
/// those are canonical-transcript material. This is a finding, not an
/// invented event — the box interprets, the transcript persists, the stream
/// augments. See mobile/native/FINDINGS.md.
enum ChatTranscriptMapper {

    static func blocks(from messages: [OpencodeMessage]) -> [TranscriptBlock] {
        var blocks: [TranscriptBlock] = []
        var pending: [StepGroupRow] = []

        for msg in messages {
            switch msg.info.role.rawValue {
            case "user":
                let text = textParts(of: msg)
                if !text.isEmpty {
                    flush(&pending, into: &blocks)
                    // A prompt is timestamped when it was WRITTEN; a reply when
                    // it finished. Both are what the reader means by "when did
                    // this happen".
                    blocks.append(.user(text, at: ChatClock.date(epochMs: msg.info.time?.created)))
                }
            case "assistant":
                // An assistant message still streaming (time.completed == nil)
                // is skipped whole: its text arrives live via `stream.flush`
                // and its still-moving steps come in on the turn-boundary
                // refetch. Emitting it now would duplicate the in-progress
                // text. The box itself keys turn completion on time.completed.
                guard msg.info.time?.completed != nil else { continue }
                let at = ChatClock.date(epochMs: msg.info.time?.completed)
                for (index, part) in msg.parts.enumerated() {
                    process(part, index: index, at: at, pending: &pending, blocks: &blocks)
                }
                flush(&pending, into: &blocks)
            default:
                break
            }
        }
        flush(&pending, into: &blocks)
        return blocks
    }

    private static func flush(_ pending: inout [StepGroupRow], into blocks: inout [TranscriptBlock]) {
        guard !pending.isEmpty else { return }
        if ChatRollup.shouldRoll(rows: pending) {
            blocks.append(.steps(.rollup(summary: ChatRollup.summary(rows: pending), rows: pending)))
        } else {
            blocks.append(.steps(.rows(pending)))
        }
        pending = []
    }

    private static func process(_ part: OpencodePart, index: Int, at: Date?, pending: inout [StepGroupRow], blocks: inout [TranscriptBlock]) {
        if part.ignored == true || part.synthetic == true { return }
        switch part.type {
        case "text":
            // Prose does not collapse, but a blank/whitespace-only text part is
            // paragraph noise — opencode routinely emits a newline-only text
            // part after a tool run. Rendering it as a prose block would stack
            // another `--sp-3` (+ line box) and inflate the step-group gap above
            // the next block (BET-632). Same rule as `textParts(of:)`.
            if let t = part.text, !ChatTranscriptMapper.isBlank(t) {
                flush(&pending, into: &blocks)
                blocks.append(.prose(t, at: at))
            }
        case "tool":
            let tool = ChatJSON.string(part.extra["tool"]) ?? ""
            if tool.lowercased() == "task" {
                if let agent = ChatSubagentMapper.session(from: part) {
                    pending.append(.subagent(agent))
                }
            } else {
                pending.append(.step(step(from: part, tool: tool, indexWithinMessage: index)))
            }
        default:
            // reasoning / file / etc. — no §8 block type renders it; skip.
            break
        }
    }

    private static func textParts(of msg: OpencodeMessage) -> String {
        msg.parts.compactMap { part -> String? in
            guard part.type == "text",
                  part.ignored != true,
                  part.synthetic != true,
                  let t = part.text, !isBlank(t) else { return nil }
            return t
        }.joined(separator: "\n")
    }

    /// A text part is "blank" when it contains no visible content — empty, or
    /// only whitespace/newlines. Such parts are paragraph noise (BET-632): they
    /// must never become a `.prose` block, which would stack gap spacing.
    private static func isBlank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func step(from part: OpencodePart, tool: String, indexWithinMessage: Int) -> ToolStep {
        let id = stepIdentity(part: part, indexWithinMessage: indexWithinMessage)
        let state = ChatJSON.object(part.extra["state"])
        let statusRaw = ChatJSON.string(state?["status"])
        let status = StepStatusFromTool.status(statusRaw)
        let verb = StepVerb.text(for: tool)
        let target = ToolTarget.text(tool: tool, input: state?["input"])
            ?? ToolTarget.text(tool: tool, input: part.extra["input"])
            ?? tool
        let time = ChatJSON.object(state?["time"])
        let duration: String
        if let t = ChatDuration.text(seconds: durationSeconds(state: state, time: time)) {
            duration = t
        } else {
            duration = ""
        }
        let output = ChatJSON.string(state?["output"])
        return ToolStep(id: id, verb: verb, target: target, duration: duration, status: status, output: output)
    }

    /// Deterministic step identity derived from the wire data so a step's id
    /// survives a canonical refetch (the turn-boundary flash fix, BET-666).
    /// Priority: the tool part's `callID` when present → the part's own id →
    /// `\(messageID)-step-\(indexWithinMessage)` as a last resort. No freshly
    /// minted random id anywhere on this mapping path.
    private static func stepIdentity(part: OpencodePart, indexWithinMessage: Int) -> String {
        if let callID = ChatJSON.string(part.extra["callID"]), !callID.isEmpty {
            return callID
        }
        if !part.id.isEmpty {
            return part.id
        }
        return "\(part.messageID)-step-\(indexWithinMessage)"
    }

    private static func durationSeconds(state: [String: JSONValue]?, time: [String: JSONValue]?) -> Double? {
        if let start = ChatJSON.number(time?["start"]),
           let end = ChatJSON.number(time?["end"]) {
            return end - start
        }
        return nil
    }
}

// MARK: - Question answers (§7.5, answerable from the phone)

/// Per-question answer assembly + submit gating, ported from the desktop's
/// pure `buildQuestionAnswers` / `canSubmitQuestion` (src/renderer/chatUtils.ts).
/// `selected` maps a question's position to the set of its selected option
/// indices — the free text is ALWAYS available and, when non-empty, is appended
/// to every question's answer (matching the desktop).
enum ChatQuestionAnswers {
    static func answers(questions: [QuestionInfo], selected: [Int: Set<Int>], customText: String) -> [[String]] {
        let typed = customText.trimmingCharacters(in: .whitespacesAndNewlines)
        return questions.enumerated().map { index, q in
            var picked = q.options.enumerated().compactMap { i, o in
                selected[index, default: []].contains(i) ? o.label : nil
            }
            if !typed.isEmpty { picked.append(typed) }
            return picked
        }
    }

    /// Submit is enabled only when every question has a selection OR the shared
    /// free text is non-empty (which counts for all).
    static func canSubmit(questions: [QuestionInfo], selected: [Int: Set<Int>], customText: String) -> Bool {
        guard !questions.isEmpty else { return false }
        let typed = customText.trimmingCharacters(in: .whitespacesAndNewlines)
        for index in questions.indices {
            if selected[index, default: []].isEmpty && typed.isEmpty {
                return false
            }
        }
        return true
    }
}

