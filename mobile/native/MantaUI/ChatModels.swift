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

// MARK: - JSON accessors — see ChatJSON.swift

// MARK: - Step-row presentation (§8)

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

/// Map a tool part's `state.status` string onto the StepStatus taxonomy.
enum StepStatusFromTool {
    static func status(_ raw: String?) -> StepStatus {
        switch (raw ?? "").lowercased() {
        case "completed": return .completed
        case "error": return .error
        case "denied": return .denied
        case "awaitingapproval", "awaiting_approval": return .awaitingApproval
        case "pending": return .pending
        default: return .running
        }
    }
}

/// Whether a step row renders expanded, given its state and the user's manual
/// override. Pure so it is unit-testable with no view dependencies (mirrors the
/// `BranchFreshnessPolicy` shape in ChatScreen.swift).
enum StepDisclosure {
    /// User intent always wins: a row someone opened must never close under
    /// them, and a row they closed must stay closed. Only when the user has
    /// not touched the row does the state-driven default apply.
    static func expanded(status: StepStatus, userToggled: Bool?) -> Bool {
        if let userToggled { return userToggled }
        switch status {
        case .running, .awaitingApproval, .error, .denied:
            // Live output tails; a failure must never auto-collapse.
            return true
        case .completed, .pending:
            // Keeps a many-step turn readable by default.
            return false
        }
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
        // opencode titles a task part from its description; a live frame may carry
        // only the description, so fall back to it before the generic name.
        let description = ChatJSON.string(ChatJSON.object(state["input"])?["description"])
        let taskName = [title, description].compactMap { $0 }.first { !$0.isEmpty } ?? "subagent"

        // The part's wire status (already resolved by `resolvingTaskStatuses`
        // when it came out of the store): an error is FAILED — it used to read
        // as "running" (spec §5).
        let status = SubagentStatus.fromWire(statusRaw)
        let time = ChatJSON.object(state["time"])
        let duration: String?
        if let start = ChatJSON.number(time?["start"]),
           let end = ChatJSON.number(time?["end"]) {
            // `state.time.start/end` are MILLISECONDS on the wire (opencode
            // stamps tool time in ms — see `ChatDuration.text`); divide by 1000
            // before the seconds-format helper, mirroring the live path — a
            // task that ran 1.2s must not render as "20m0s".
            duration = ChatDuration.text(seconds: (end - start) / 1000)
        } else {
            duration = nil
        }

        // The row's id must be unique per task part and stable across rebuilds:
        // the child opencode session id when known, otherwise the tool's callID
        // (never the task name — two subagents run under the same title would
        // collide). See SubagentSession.init.
        let callID = ChatJSON.string(part.extra["callID"])

        return SubagentSession(
            taskName: taskName,
            status: status,
            duration: duration,
            transcript: [],
            childSessionId: childSessionId,
            fallbackId: (callID?.isEmpty == false) ? callID : nil
        )
    }
}

// MARK: - The mapper: `opencode:messages` → `[TranscriptBlock]`

/// The result of folding the stream's live state into the canonical blocks.
struct LiveActivityMerge: Equatable {
    /// The blocks to render as rows.
    var blocks: [TranscriptBlock]
    /// The run at the very tail while a turn runs. It is drawn by the working
    /// line instead of inline (spec §1.1), so it is NOT in `blocks`.
    var trailing: ToolRun?
}

/// Maps the canonical transcript (and the live stream state) onto the block
/// types.
///
/// Block-type provenance (the S4 mapping — see FINDINGS):
///   - `.user`      — from canonical user text parts. No stream event produces
///                    one; it comes from the transcript fetch.
///   - `.prose`     — from canonical assistant text parts AND, live, from the
///                    box's `stream:flush` (the running assistant turn).
///   - `.activity`  — from canonical tool/patch parts (a RUN of them, which can
///                    span assistant messages) and the live tool / subagent
///                    frames.
///
/// The stream alone cannot produce `.user` or completed `.activity`/`.prose`;
/// those are canonical-transcript material. This is a finding, not an
/// invented event — the box interprets, the transcript persists, the stream
/// augments. See mobile/native/FINDINGS.md.
enum ChatTranscriptMapper {

    static func blocks(from messages: [OpencodeMessage]) -> [TranscriptBlock] {
        blocks(from: messages, voiceNotes: [])
    }

    static func blocks(from messages: [OpencodeMessage], voiceNotes: [VoiceNote]) -> [TranscriptBlock] {
        blocks(from: messages, voiceNotes: voiceNotes, widgets: [])
    }

    /// Map the canonical transcript onto blocks, then merge the two
    /// side-channel collections the box announces on the bus — voice notes
    /// (BET-1029) and widgets (BET-1326). Both arrive out-of-band and are
    /// claimed onto the message that produced them, so a widget renders as a
    /// `.file` attachment right where its turn landed without inventing any
    /// new row identity.
    ///
    /// Tool calls are grouped by `ToolActivity.layout` — the same rules as the
    /// desktop. A run belongs to the message it STARTS in; the assistant
    /// messages it absorbs draw no block of their own.
    static func blocks(from messages: [OpencodeMessage], voiceNotes: [VoiceNote], widgets: [WidgetRef]) -> [TranscriptBlock] {
        let voiceMap = buildVoiceNoteMap(messages: messages, notes: voiceNotes)
        let widgetMap = buildWidgetMap(widgets)
        // An assistant message still streaming (time.completed == nil) is
        // skipped whole: its text arrives live via `stream.flush` and its
        // still-moving tool calls via the live frames. Emitting it now would
        // duplicate the in-progress text. The box itself keys turn completion on
        // time.completed. It is left out of the layout too, so a run never
        // "continues" into a message that is not drawn.
        let settled = messages.filter {
            $0.info.role.rawValue != "assistant" || $0.info.time?.completed != nil
        }
        let layout = ToolActivity.layout(messages: settled, running: false, showThinking: false)
        var blocks: [TranscriptBlock] = []

        for msg in settled {
            switch msg.info.role.rawValue {
            case "user":
                let text = textParts(of: msg)
                if !text.isEmpty {
                    // A prompt is timestamped when it was WRITTEN; a reply when
                    // it finished. Both are what the reader means by "when did
                    // this happen".
                    blocks.append(.user(text, at: ChatClock.date(epochMs: msg.info.time?.created)))
                    // The voice-note player renders directly under the user band
                    // that dictated it, claimed by transcript-text match.
                    if let note = voiceMap[msg.info.id] {
                        blocks.append(.file(TranscriptAttachment(kind: .voiceNote(note))))
                    }
                    appendWidgets(widgetMap[msg.info.id], into: &blocks)
                }
            case "assistant":
                let at = ChatClock.date(epochMs: msg.info.time?.completed)
                for block in layout.blocksByMessage[msg.info.id] ?? [] {
                    switch block {
                    case .tools(let run):
                        blocks.append(.activity(run))
                    case .part(let part):
                        process(part, at: at, into: &blocks)
                    }
                }
                // A turn's widgets follow its tools/prose: the model rendered
                // them as part of that assistant message.
                appendWidgets(widgetMap[msg.info.id], into: &blocks)
            default:
                break
            }
        }
        return blocks
    }

    /// messageId → widgets claimed onto that message. A widget whose message is
    /// outside the loaded window (or missing) is dropped, exactly like a voice
    /// note that matches nothing — it carries no id-based claim of its own.
    static func buildWidgetMap(_ widgets: [WidgetRef]) -> [String: [WidgetRef]] {
        var map: [String: [WidgetRef]] = [:]
        for w in widgets {
            if let mid = w.messageId, !mid.isEmpty {
                map[mid, default: []].append(w)
            }
        }
        return map
    }

    private static func appendWidgets(_ widgets: [WidgetRef]?, into blocks: inout [TranscriptBlock]) {
        guard let widgets, !widgets.isEmpty else { return }
        for w in widgets {
            blocks.append(.file(TranscriptAttachment(kind: .widget(w))))
        }
    }

    // MARK: Task status (spec §5)

    /// Resolve every task call's status against what the event store and the
    /// job list know right now. Runs without a task come back untouched.
    static func resolvingTaskStatuses(_ blocks: [TranscriptBlock], context: TaskStatusContext) -> [TranscriptBlock] {
        blocks.map { block in
            guard case .activity(let run) = block else { return block }
            return .activity(run.resolvingTasks(context))
        }
    }

    // MARK: Live merge

    /// A live tool frame as a tool part. The frame carries only a name, opencode's
    /// title for the part (the "hint") and a stdout tail, so that is all the part
    /// has: the title stands in for the input the label would otherwise be
    /// built from. A tool whose `toolEnded` has landed reads completed (failed
    /// when the frame says it did not succeed); the tail then holds its final
    /// output, which is where a `delegate` call's job id comes from.
    static func livePart(from tool: LiveTool) -> OpencodePart {
        let status: String
        if tool.ended {
            status = tool.ok ? "completed" : "error"
        } else {
            status = (tool.status ?? "running").lowercased() == "pending" ? "pending" : "running"
        }
        var metadata: [String: JSONValue] = [:]
        if !tool.tail.isEmpty { metadata["output"] = .string(tool.tail) }
        return ToolActivity.makeToolPart(
            id: tool.idx,
            callID: tool.callID.isEmpty ? nil : tool.callID,
            tool: tool.name ?? "tool",
            status: status,
            title: tool.presentationHint,
            metadata: metadata
        )
    }

    /// A live subagent frame as a task part, carrying the status it resolved to.
    /// The id is derived from the child session (the frame carries no part id);
    /// the canonical part takes over — and this one is dropped — once the
    /// transcript names the same child.
    static func livePart(from subagent: StreamSubagentPayload, status: TaskRunStatus = .running) -> OpencodePart {
        var input: [String: JSONValue] = [:]
        if let d = subagent.description, !d.isEmpty { input["description"] = .string(d) }
        if let a = subagent.agent, !a.isEmpty { input["subagent_type"] = .string(a) }
        return ToolActivity.makeToolPart(
            id: "live-task-\(subagent.childSessionId)",
            tool: "task",
            status: status.wireStatus,
            title: subagent.title,
            input: input,
            metadata: ["sessionId": .string(subagent.childSessionId)]
        )
    }

    /// Fold the LIVE tools and live subagents of this turn into the transcript
    /// as part of the run they belong to.
    ///
    /// - Live tools (`toolStarted`..`toolEnded`) and live subagents extend the run
    ///   at the very end of the transcript, or open a new one. While a turn
    ///   runs that run is the `trailing` one, drawn by the working line;
    ///   otherwise it is an ordinary row.
    /// - `tools` is EVERY call of the turn, ended ones included. The canonical
    ///   transcript is not refetched mid-turn and skips the in-progress step
    ///   message, so the stream is the only source of the turn's finished calls:
    ///   dropping a call when it ends made the run lose it (and its id, which is
    ///   its first part's). An ended call reads completed, or failed.
    /// - When live prose follows the transcript's last run, that run is not at
    ///   the tail any more: it stays an inline row and the live calls open a new
    ///   run after the prose.
    /// - A live call the transcript already owns (same part id, same call id, or
    ///   — for a task — same child session) is skipped: the canonical one has
    ///   taken over, so appending again would duplicate it.
    /// - A live subagent is kept whatever it resolves to (spec §5), a finished
    ///   one reading done/failed, until the canonical transcript names its child.
    ///   That includes a task whose tool call already reads "completed" because
    ///   the work was started in the background — such a row used to be dropped,
    ///   so the card vanished mid-turn. `thisTurnChildren` narrows that for the
    ///   store: when non-nil, a FINISHED subagent is kept only if it is in the
    ///   set (frames of earlier turns whose task part has scrolled out of the
    ///   loaded window must not resurface); a running one is always kept.
    /// - A `delegate` call whose job is still running reads as running.
    ///
    /// `hasTailContent` is true when something draws after the transcript's last
    /// run (live prose, or a prompt being sent), which keeps that run inline.
    static func mergingLive(
        tools: [LiveTool],
        subagents: [StreamSubagentPayload],
        context: TaskStatusContext,
        running: Bool,
        hasTailContent: Bool,
        thisTurnChildren: Set<String>? = nil,
        to blocks: [TranscriptBlock]
    ) -> LiveActivityMerge {
        // A task part streams as an ordinary tool AND as the richer `subagent`
        // frame (src/server/streamInterp.mjs documents the tool triple as
        // redundant). The subagent frame is the only source. A todo-list write is
        // not a call the transcript draws either (`visibleAssistantParts`), so it
        // must not appear live only to vanish when the canonical turn lands.
        var live: [OpencodePart] = tools.compactMap { tool in
            let name = tool.name?.lowercased()
            if name == "task" || name == "todowrite" || name == "todo_write" { return nil }
            return TaskStatusResolver.applying(context, to: livePart(from: tool))
        }
        live += subagents.compactMap { payload in
            let status = TaskStatusResolver.resolve(
                toolStatus: payload.status,
                childSessionID: payload.childSessionId,
                output: payload.output,
                context: context
            )
            if !status.isRunning, let thisTurnChildren, !thisTurnChildren.contains(payload.childSessionId) {
                return nil
            }
            return livePart(from: payload, status: status)
        }

        // Drop what the canonical transcript already owns.
        var ids = Set<String>()
        var calls = Set<String>()
        var children = Set<String>()
        for block in blocks {
            guard case .activity(let run) = block else { continue }
            for part in run.parts {
                ids.insert(part.id)
                if let c = ChatJSON.string(part.extra["callID"]), !c.isEmpty { calls.insert(c) }
                if let child = TaskStatusResolver.childSessionID(of: part) { children.insert(child) }
            }
        }
        live = live.filter { part in
            if ids.contains(part.id) { return false }
            if let c = ChatJSON.string(part.extra["callID"]), calls.contains(c) { return false }
            if let child = TaskStatusResolver.childSessionID(of: part), children.contains(child) { return false }
            return true
        }

        var result = blocks
        var lastRun: ToolRun? {
            if case .activity(let run)? = result.last { return run }
            return nil
        }

        if live.isEmpty {
            // Nothing live: while a turn runs, the run at the very end of the
            // transcript is shown by the working line.
            if running, !hasTailContent, let run = lastRun {
                result.removeLast()
                return LiveActivityMerge(blocks: result, trailing: run)
            }
            return LiveActivityMerge(blocks: result, trailing: nil)
        }

        var base: ToolRun?
        if !hasTailContent, let run = lastRun {
            base = run
            result.removeLast()
        }
        let merged = base.map { $0.appending(live) } ?? ToolRun(id: live[0].id, parts: live)
        if running {
            return LiveActivityMerge(blocks: result, trailing: merged)
        }
        result.append(.activity(merged))
        return LiveActivityMerge(blocks: result, trailing: nil)
    }

    /// A non-blank text part becomes prose. Everything else draws nothing here:
    /// tool/patch parts are claimed by the layout as runs, reasoning is not
    /// shown on iOS, and a file part that is not a voice note renders nothing
    /// (voice notes attach at the USER-message level — `buildVoiceNoteMap` — and
    /// image / generic-file rendering is deliberately not implemented yet,
    /// BET-1029, so do not fold `file` into a catch-all).
    private static func process(_ part: OpencodePart, at: Date?, into blocks: inout [TranscriptBlock]) {
        if part.ignored == true || part.synthetic == true { return }
        // A blank/whitespace-only text part is paragraph noise — opencode
        // routinely emits a newline-only text part after a tool run. Rendering
        // it as a prose block would stack another `--sp-3` (+ line box) and
        // inflate the gap above the next block (BET-632). Same rule as
        // `textParts(of:)`.
        if part.type == "text", let t = part.text, !isBlank(t) {
            blocks.append(.prose(t, at: at))
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

    /// A user-message-id → voice-note map, forged by claiming each note against
    /// the first unclaimed user message whose concatenated text equals the
    /// note's transcript. Port of `buildVoiceNoteMap`
    /// (src/renderer/chatUtils.ts:3666-3687) — SAME association rule so both
    /// clients agree which bubble owns which clip; there is no id on the wire.
    ///
    /// Walk user messages OLDEST → NEWEST and notes OLDEST → NEWEST; claim the
    /// FIRST unclaimed user message whose text equals the note's trimmed
    /// transcript. Each note and each message is claimed at most once; a note
    /// matching nothing is dropped. Do NOT invent an id-based scheme.
    static func buildVoiceNoteMap(messages: [OpencodeMessage], notes: [VoiceNote]) -> [String: VoiceNote] {
        var map: [String: VoiceNote] = [:]
        guard !notes.isEmpty else { return map }
        let users = messages.filter { $0.info.role.rawValue == "user" }
        var claimed = Set<String>()
        for note in notes {
            let transcript = note.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !transcript.isEmpty else { continue }
            for msg in users {
                guard !claimed.contains(msg.info.id) else { continue }
                if concatUserMessageText(msg) == transcript {
                    map[msg.info.id] = note
                    claimed.insert(msg.info.id)
                    break
                }
            }
        }
        return map
    }

    /// The user-turn text a note's transcript is matched against — the
    /// concatenated (newline-joined) non-synthetic, non-ignored text parts with
    /// trailing whitespace stripped. Mirrors `concatUserMessageText` in the
    /// desktop, so the claim can never diverge from what the row displays.
    static func concatUserMessageText(_ msg: OpencodeMessage) -> String {
        let joined = msg.parts.compactMap { part -> String? in
            guard part.type == "text",
                  part.synthetic != true,
                  part.ignored != true,
                  let t = part.text else { return nil }
            return t
        }.joined(separator: "\n")
        return joined.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
    }

    /// The chronological user-turn texts for composer history recall
    /// (BET-1305): filter role == "user", map `concatUserMessageText`, trim
    /// whitespace+newlines, skip empties. Order preserved (chronological).
    /// Desktop parity for `useInputHistory`'s transcript derivation — no
    /// duplicated part-filtering logic anywhere else.
    static func userTurnTexts(from messages: [OpencodeMessage]) -> [String] {
        messages
            .filter { $0.info.role.rawValue == "user" }
            .map { concatUserMessageText($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    /// A text part is "blank" when it contains no visible content — empty, or
    /// only whitespace/newlines. Such parts are paragraph noise (BET-632): they
    /// must never become a `.prose` block, which would stack gap spacing.
    private static func isBlank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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

// MARK: - Bounded tool-output preview

/// The bounded preview of a tool's output shown inline in the transcript.
///
/// The box streams up to 20,000 characters per tool and flushes a tool's ENTIRE
/// final output one frame before it marks the tool ended, so an inline view with
/// no bound briefly renders thousands of points of text inside a self-sizing
/// cell — which is what pushed the composer off screen. The full text is always
/// one tap away (a subagent's on its drill-in screen; a command's in the
/// terminal), so the inline copy is a peek, not the record.
enum ToolOutputPreview {
    static let maxLines = 12
    static let maxCharacters = 2_000

    /// Keep the LAST `maxLines` lines (output is a tail — the newest lines are
    /// the interesting ones), then hard-cap the result to the last
    /// `maxCharacters` characters so a single enormous line cannot escape the
    /// line bound.
    static func tail(_ output: String) -> String {
        // An empty or whitespace-only input returns the input unchanged.
        if output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return output
        }

        let lines = output.components(separatedBy: "\n")
        var result = output
        var trimmed = false
        if lines.count > maxLines {
            result = lines.suffix(maxLines).joined(separator: "\n")
            trimmed = true
        }
        if result.count > maxCharacters {
            result = String(result.suffix(maxCharacters))
            trimmed = true
        }
        // One prefix, whichever bound bit — so the reader can see it is a tail.
        return trimmed ? "… \n" + result : result
    }
}

