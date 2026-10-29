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

/// The result of laying the live turn (the box's ordered ledger) over the canonical blocks.
struct LiveTailResult: Equatable {
    /// The canonical blocks, with any live calls UPSERTED into a canonical run row they belong to (same row id, same
    /// position — never a second row), and the trailing run withheld when it is the very last canonical block.
    var canonical: [TranscriptBlock]
    /// The live blocks to render after `canonical`, in the turn's real order (tool, prose, tool…).
    var blocks: [TranscriptBlock]
    /// The run at the very tail while a turn runs. It is drawn by the working line instead of inline (spec §1.1), so it is
    /// NOT in `canonical` / `blocks`.
    var trailing: ToolRun?
}

/// Everything the mapper needs besides the canonical messages. Every field
/// defaults to "nothing", so a caller that has none of it gets the
/// canonical-only result and the live-only features simply wait for the
/// transcript to settle.
struct TranscriptMapOptions: Equatable, Sendable {
    /// Draw reasoning parts (the "Show reasoning & full output" switch).
    var showReasoning: Bool = false
    /// The session is running a turn: no footer on the transcript's last message.
    var running: Bool = false
    /// user message id → the `/command` that produced it (live `commandExecuted`
    /// frames). A durable `info.command` wins over these.
    var liveCommands: [String: OpencodeCommandOrigin] = [:]
    /// The latest live truncation warning, used only for a message the transcript
    /// itself has no finish record for.
    var liveTruncation: TranscriptLiveTruncation? = nil
    /// This session's live media entries (session-wide, never keyed by message).
    var liveMedia: [TranscriptMediaEntry] = []
    /// The newest value of each run (revision-merged, WS11 D11): the run lines draw these summaries. Empty before the
    /// connection's epoch is known; a run it lacks falls back to the full view its message carries.
    var runStore: TranscriptRunStore = TranscriptRunStore()

    /// The options every legacy overload forwards: the persisted reasoning switch
    /// and nothing live.
    static var current: TranscriptMapOptions {
        TranscriptMapOptions(showReasoning: TranscriptDisplayOptions.showDetails)
    }
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
    /// Tool calls are grouped by the box's run ids (`ToolActivity.layout`). A run
    /// belongs to the message it STARTS in; the assistant messages it absorbs draw
    /// no block of their own.
    static func blocks(from messages: [OpencodeMessage], voiceNotes: [VoiceNote], widgets: [WidgetRef]) -> [TranscriptBlock] {
        blocks(from: messages, voiceNotes: voiceNotes, widgets: widgets, options: .current)
    }

    /// The full mapper. `options` carries everything that is not in the
    /// canonical transcript itself: the reasoning switch, the running gate, and
    /// the live-only data (media placeholders, `/command` frames, the latest
    /// truncation warning). Every default is empty, so a caller that passes none
    /// of them gets the canonical-only result.
    ///
    /// Block order for one turn: user files, the `.user` / `.command` band, its
    /// voice note, its widgets, then for each settled assistant message its
    /// owned media, its layout blocks (runs, prose, reasoning, handoff), its
    /// widgets and its footer.
    static func blocks(
        from messages: [OpencodeMessage],
        voiceNotes: [VoiceNote],
        widgets: [WidgetRef],
        options: TranscriptMapOptions
    ) -> [TranscriptBlock] {
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
        let layout = ToolActivity.layout(
            messages: settled, showThinking: options.showReasoning, runs: options.runStore.runs, minGen: options.runStore.minGen)

        // Media: canonical (session-wide) plus live-only entries, grouped under
        // the settled assistant message that owns them. Entries whose owner is
        // not settled belong to `liveMediaTail`.
        let canonicalMedia = TranscriptViewMedia.entries(messages)
        let liveMedia = TranscriptMediaReconcile.liveOnly(live: options.liveMedia, canonical: canonicalMedia)
        let owners = mediaOwnerIDs(of: messages)
        var mediaByOwner: [String: [TranscriptMediaEntry]] = [:]
        for entry in canonicalMedia + liveMedia where owners.contains(entry.ownerMessageID) {
            mediaByOwner[entry.ownerMessageID, default: []].append(entry)
        }

        var blocks: [TranscriptBlock] = []
        // The prose of the turn in progress, for the reply menu. A user message
        // or a background result starts a new turn.
        var turnProse: [String] = []

        for msg in settled {
            switch msg.info.role.rawValue {
            case "user":
                turnProse = []
                let text = textParts(of: msg)
                // Files attached to the prompt draw above it — even when the
                // message is ONLY an attachment.
                let refs = TranscriptFileParse.refs(of: msg)
                if !refs.isEmpty {
                    let files = TranscriptUserFiles(messageID: msg.info.id, refs: refs)
                    blocks.append(.file(TranscriptAttachment(kind: .userFiles(files))))
                }
                if !text.isEmpty {
                    // A prompt is timestamped when it was WRITTEN; a reply when
                    // it finished. Both are what the reader means by "when did
                    // this happen".
                    let at = ChatClock.date(epochMs: msg.info.time?.created)
                    let origin = TranscriptCommandOrigin.resolve(durable: msg.info.command, live: options.liveCommands[msg.info.id])
                    if let origin, !origin.name.isEmpty {
                        blocks.append(.command(TranscriptCommandTurn(
                            messageID: msg.info.id,
                            name: origin.name,
                            arguments: origin.arguments ?? "",
                            expandedText: text,
                            at: at
                        )))
                    } else {
                        blocks.append(.user(text, at: at))
                    }
                    // The voice-note player renders directly under the user band
                    // that dictated it, claimed by transcript-text match.
                    if let note = voiceMap[msg.info.id] {
                        blocks.append(.file(TranscriptAttachment(kind: .voiceNote(note))))
                    }
                    appendWidgets(widgetMap[msg.info.id], into: &blocks)
                }
            case "assistant":
                if TranscriptTurns.isBackgroundResult(msg) { turnProse = [] }
                let at = ChatClock.date(epochMs: msg.info.time?.completed)
                // Media this message owns draws first, then its own blocks.
                for entry in mediaByOwner[msg.info.id] ?? [] {
                    blocks.append(.file(TranscriptAttachment(kind: .media(entry))))
                }
                let blocksStart = blocks.count
                for block in layout.blocksByMessage[msg.info.id] ?? [] {
                    switch block {
                    case .tools(let run):
                        blocks.append(.activity(run))
                    case .part(let part):
                        process(part, at: at, into: &blocks)
                    }
                }
                // A background result is the HEAD of a turn, not part of the
                // reply: its own text never joins the reply menu's turn text.
                if !TranscriptTurns.isBackgroundResult(msg) {
                    for case .prose(let text, _, _) in blocks[blocksStart...] {
                        turnProse.append(text)
                    }
                }
                // A turn's widgets follow its tools/prose: the model rendered
                // them as part of that assistant message.
                appendWidgets(widgetMap[msg.info.id], into: &blocks)
                appendFooter(
                    for: msg,
                    turnProse: turnProse,
                    options: options,
                    into: &blocks
                )
            default:
                break
            }
        }
        return blocks
    }

    /// The turn footer: duration · tokens for a finished turn, and/or a truncation warning — both decided by the BOX
    /// (`message.view`, WS11 D8; its running gate already withheld the in-flight turn's footer). The truncation is
    /// the box's canonical record when it has one (survives a reload), else the latest live warning for this message.
    private static func appendFooter(
        for msg: OpencodeMessage,
        turnProse: [String],
        options: TranscriptMapOptions,
        into blocks: inout [TranscriptBlock]
    ) {
        let live = options.liveTruncation?.messageID == msg.info.id ? options.liveTruncation?.view : nil
        let effective = msg.view?.truncation ?? live
        let info = msg.view?.turn
        guard TranscriptFooterRule.shouldEmit(finishedTurn: info != nil, effectiveTruncation: effective) else { return }
        blocks.append(.turnFooter(TranscriptTurnFooter(
            messageID: msg.info.id,
            summary: info.flatMap { TranscriptTurns.summary($0) },
            truncation: effective,
            isTurnEnd: info != nil,
            turnText: info != nil ? turnProse.joined(separator: "\n\n") : ""
        )))
    }

    /// The ids of the messages whose media the MAPPER draws: settled assistant
    /// messages. `liveMediaTail` draws the rest, so the two never overlap.
    private static func mediaOwnerIDs(of messages: [OpencodeMessage]) -> Set<String> {
        Set(messages.compactMap { msg in
            msg.info.role.rawValue == "assistant" && msg.info.time?.completed != nil ? msg.info.id : nil
        })
    }

    /// Media that belongs at the live tail instead of under a settled message:
    /// (a) an entry whose owner is in `messages` but not settled, and (b) — only
    /// when `isLiveWindow` — a live-only entry of the CURRENT turn whose owner is
    /// absent from `messages` (the running step, which the transcript does not
    /// carry until it settles). An entry of an earlier turn whose owner is outside
    /// the window renders nowhere.
    ///
    /// Pass the SAME `messages` array as the `blocks(from:…options:)` call: the
    /// mapper emits settled owners and this emits the others, so an owner can
    /// never appear in both segments.
    static func liveMediaTail(
        messages: [OpencodeMessage],
        live: [TranscriptMediaEntry],
        isLiveWindow: Bool
    ) -> [TranscriptBlock] {
        let canonical = TranscriptViewMedia.entries(messages)
        let liveOnly = TranscriptMediaReconcile.liveOnly(live: live, canonical: canonical)
        let drawnByMapper = mediaOwnerIDs(of: messages)
        let present = Set(messages.map(\.info.id))
        var tail: [TranscriptMediaEntry] = []
        for entry in canonical + liveOnly {
            let owner = entry.ownerMessageID
            if drawnByMapper.contains(owner) { continue }
            if present.contains(owner) {
                tail.append(entry)
            } else if isLiveWindow && entry.inCurrentTurn {
                tail.append(entry)
            }
        }
        return tail
            .sorted { ($0.seq, $0.id) < ($1.seq, $1.id) }
            .map { .file(TranscriptAttachment(kind: .media($0))) }
    }

    /// The message ids whose footer carries a truncation warning — the warnings
    /// actually on screen. WS02's tail notice is skipped only for these, so a
    /// warning is never both duplicated and never lost.
    static func footerTruncationMessageIDs(_ blocks: [TranscriptBlock]) -> Set<String> {
        var ids = Set<String>()
        for case .turnFooter(let footer) in blocks where footer.truncation != nil {
            ids.insert(footer.messageID)
        }
        return ids
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

    // MARK: Live tail (the box's ordered ledger)

    /// A tool call of the live turn as a tool part. The box's ledger frame carries the call's wording (`activity`), the run
    /// it belongs to and its status — never its output; the stdout tail of a running call comes from the live tool frames
    /// (`tails`, joined by part id). A task's description rides in from its `subagent` frame.
    static func livePart(from entry: LiveRunPart, tail: String?, subagent: StreamSubagentPayload?, gen: Int?) -> OpencodePart {
        var input: [String: JSONValue] = [:]
        var metadata: [String: JSONValue] = [:]
        if let tail, !tail.isEmpty { metadata["output"] = .string(tail) }
        if let childID = entry.childSessionId ?? subagent?.childSessionId, !childID.isEmpty {
            metadata["sessionId"] = .string(childID)
        }
        if let d = subagent?.description, !d.isEmpty { input["description"] = .string(d) }
        if let a = subagent?.agent, !a.isEmpty { input["subagent_type"] = .string(a) }
        var part = ToolActivity.makeToolPart(
            id: entry.id,
            messageID: entry.messageID,
            callID: entry.callID.isEmpty ? nil : entry.callID,
            tool: entry.tool.isEmpty ? "tool" : entry.tool,
            status: entry.status,
            title: subagent?.title,
            input: input,
            metadata: metadata,
            output: subagent?.output
        )
        part.extra["view"] = TranscriptPartView.extra(
            activity: entry.activity, runId: entry.runId, segmentId: entry.segmentId, gen: gen
        )
        return part
    }

    /// Lay the LIVE turn — the box's ordered ledger — over the canonical blocks.
    ///
    /// `layout` is the turn's draw order as it happened (runs, text parts, reasoning parts); `TranscriptLiveTailPlan`
    /// applies the one placement rule both clients use (reasoning shown: a block per segment, reasoning between them;
    /// hidden: consecutive blocks of one run collapse into one at the first). Per block:
    ///  - a run / segment block whose row id is NOT canonical → appended as a live `.activity` row;
    ///  - a run / segment block whose row id IS canonical (a partly or wholly settled run: tool A settled, a transparent
    ///    background completion, tool B streaming in a later execution) → UPSERTED into that canonical row in place — the
    ///    ledger only adds the parts it lacks, and the summary is the rev-merged one;
    ///  - a text block → prose keyed by its part id, unless the canonical transcript already has that part;
    ///  - a reasoning block (only when reasoning is shown) likewise.
    /// Streamed text the ledger does not name (an older box has no ledger at all) still shows, after the planned blocks,
    /// keyed by its part id — so prose never disappears.
    ///
    /// `trailing` = the last drawn block iff it is a run / segment whose run has not closed and a turn runs; it is drawn by
    /// the working line, so it is withheld from the rows (including an upserted canonical row at the very end).
    static func liveTail(
        layout: [LiveBlock],
        runs: [String: TranscriptRunView],
        parts: [LiveRunPart],
        closed: Set<String>,
        chunks: [StreamTextChunk],
        tails: [String: String],
        subagents: [StreamSubagentPayload],
        taskContext: TaskStatusContext,
        showReasoning: Bool,
        canonical: [TranscriptBlock],
        running: Bool,
        gen: Int? = nil
    ) -> LiveTailResult {
        let plan = TranscriptLiveTailPlan.items(layout: layout, showReasoning: showReasoning)

        var text: [String: String] = [:]
        var reasoning: [String: String] = [:]
        var textOrder: [String] = []
        for chunk in chunks where !chunk.text.isEmpty {
            if chunk.field == "reasoning" {
                reasoning[chunk.partID] = chunk.text
            } else {
                if text[chunk.partID] == nil { textOrder.append(chunk.partID) }
                text[chunk.partID] = chunk.text
            }
        }

        // The ids of what the canonical transcript already draws.
        var canonicalRun: [String: Int] = [:]
        var canonicalIDs = Set<String>()
        for (index, block) in canonical.enumerated() {
            canonicalIDs.insert(block.stableScrollID)
            if case .activity(let run) = block { canonicalRun["run-" + run.id] = index }
        }

        let subagentByChild = Dictionary(subagents.map { ($0.childSessionId, $0) }, uniquingKeysWith: { _, latest in latest })
        func makePart(_ entry: LiveRunPart) -> OpencodePart {
            let part = livePart(from: entry, tail: tails[entry.id], subagent: entry.childSessionId.flatMap { subagentByChild[$0] }, gen: gen)
            return TaskStatusResolver.applying(taskContext, to: part)
        }

        var canonicalOut = canonical
        var blocks: [TranscriptBlock] = []
        // The last DRAWN live block: where it lives (canonical index or live index) and which run it is.
        var last: (inCanonical: Bool, index: Int, run: ToolRun)?
        var plannedText = Set<String>()

        for item in plan {
            switch item {
            case .run(let rowID, let runID, let segmentID):
                let members = parts.filter { part in
                    guard part.runId == runID else { return false }
                    guard let segmentID else { return true }
                    return (part.segmentId ?? runID) == segmentID
                }
                guard !members.isEmpty else { continue }
                let rowParts = members.map(makePart)
                let summary = runs[runID]?.summary(forSegment: segmentID)
                    ?? ToolActivity.fallbackSummary(calls: members.count)
                let toolRunID = String(rowID.dropFirst(4))
                if let at = canonicalRun[rowID], case .activity(let existing) = canonicalOut[at] {
                    var merged = existing.upserting(rowParts)
                    merged.view = summary
                    canonicalOut[at] = .activity(merged)
                    last = (true, at, merged)
                } else {
                    let run = ToolRun(id: toolRunID, parts: rowParts, view: summary, runID: runID, segmentID: segmentID)
                    blocks.append(.activity(run))
                    last = (false, blocks.count - 1, run)
                }
            case .text(let partID):
                plannedText.insert(partID)
                if canonicalIDs.contains("p" + partID) { continue }
                guard let body = text[partID] else { continue }
                blocks.append(.prose(body, at: nil, partID: partID))
                last = nil
            case .reasoning(let partID):
                if canonicalIDs.contains("r" + partID) { continue }
                guard let body = reasoning[partID] else { continue }
                blocks.append(.reasoning(TranscriptReasoning(id: partID, text: body.trimmingCharacters(in: .newlines))))
                last = nil
            }
        }

        // Streamed text no planned block names (an older box has no ledger): still shown, keyed by its part id.
        for partID in textOrder where !plannedText.contains(partID) && !canonicalIDs.contains("p" + partID) {
            if let body = text[partID] {
                blocks.append(.prose(body, at: nil, partID: partID))
                last = nil
            }
        }

        var trailing: ToolRun?
        if running, let tail = last, !closed.contains(tail.run.runID) {
            if !tail.inCanonical {
                blocks.remove(at: tail.index)
                trailing = tail.run
            } else if tail.index == canonicalOut.count - 1 && blocks.isEmpty {
                canonicalOut.removeLast()
                trailing = tail.run
            }
        }
        return LiveTailResult(canonical: canonicalOut, blocks: blocks, trailing: trailing)
    }

    /// Whether the canonical blocks already draw every block of the live layout (every run row, text part and reasoning part):
    /// the turn is over and the ledger can be forgotten.
    static func coversLayout(canonical: [TranscriptBlock], layout: [LiveBlock], showReasoning: Bool) -> Bool {
        let ids = Set(canonical.map(\.stableScrollID))
        for item in TranscriptLiveTailPlan.items(layout: layout, showReasoning: showReasoning) {
            switch item {
            case .run(let rowID, _, _): if !ids.contains(rowID) { return false }
            case .text(let partID): if !ids.contains("p" + partID) { return false }
            case .reasoning(let partID): if !ids.contains("r" + partID) { return false }
            }
        }
        return true
    }

    /// The canonical run rows with their summaries refreshed from the revision-merged run values: a run's line can only
    /// move FORWARD while a turn streams (a lower revision never replaces a higher one), without re-mapping the transcript.
    static func applyingRunViews(_ blocks: [TranscriptBlock], runs: [String: TranscriptRunView], showReasoning: Bool) -> [TranscriptBlock] {
        guard !runs.isEmpty else { return blocks }
        return blocks.map { block in
            guard case .activity(var run) = block, !run.isFallback, let value = runs[run.runID] else { return block }
            let summary = value.summary(forSegment: showReasoning ? run.segmentID : nil)
            if summary == run.view { return block }
            run.view = summary
            return .activity(run)
        }
    }

    /// A non-blank text part becomes prose, and a non-blank reasoning part becomes a
    /// reasoning row (the layout only hands reasoning over while the "show
    /// reasoning" switch is on). Everything else draws nothing here: tool/patch
    /// parts are claimed by the layout as runs, and file parts are drawn at the
    /// message level (user files, media), never as a catch-all.
    private static func process(_ part: OpencodePart, at: Date?, into blocks: inout [TranscriptBlock]) {
        if part.ignored == true || part.synthetic == true { return }
        // A `handoff` tool call draws its card from the record the tool's marker
        // names. The row id is the PART id: deterministic across a refetch.
        if let handoff = HandoffToolRef.from(part: part) {
            blocks.append(.handoff(handoff))
            return
        }
        // A blank/whitespace-only text part is paragraph noise — opencode
        // routinely emits a newline-only text part after a tool run. Rendering
        // it as a prose block would stack another `--sp-3` (+ line box) and
        // inflate the gap above the next block (BET-632). Same rule as
        // `textParts(of:)`.
        if part.type == "text", let t = part.text, !isBlank(t) {
            blocks.append(.prose(t, at: at, partID: part.id))
            return
        }
        if part.type == "reasoning", let t = part.text, !isBlank(t) {
            // Leading and trailing newlines are trimmed (desktop parity). The row
            // id is the PART id: deterministic across a refetch.
            blocks.append(.reasoning(TranscriptReasoning(id: part.id, text: t.trimmingCharacters(in: .newlines))))
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
    /// The "show full output" view is bounded too: canonical `state.output` has no
    /// box-side cap (the 20,000-character cap is only on live streamed chunks), so
    /// even verbose shows the LAST 2,000 lines, hard-capped to the last 100,000
    /// characters. Copy always gets the full text.
    static let verboseMaxLines = 2_000
    static let verboseMaxCharacters = 100_000

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

    /// The bounded FULL view: the last `verboseMaxLines` lines, hard-capped to the
    /// last `verboseMaxCharacters` characters, with the same "… \n" prefix when
    /// trimmed. `trimmed` is true whenever either bound bit.
    static func verboseTail(_ output: String) -> (text: String, trimmed: Bool) {
        if output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return (output, false)
        }
        var result = output
        var trimmed = false
        let lines = output.components(separatedBy: "\n")
        if lines.count > verboseMaxLines {
            result = lines.suffix(verboseMaxLines).joined(separator: "\n")
            trimmed = true
        }
        if result.count > verboseMaxCharacters {
            result = String(result.suffix(verboseMaxCharacters))
            trimmed = true
        }
        return (trimmed ? "… \n" + result : result, trimmed)
    }
}

