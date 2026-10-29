import Foundation

// ===========================================================================
// Tool activity: the parts of a tool call the phone still owns — detail disclosure, copy text, duration, task / delegate
// STATUS, run placement, todo card logic.
//
// WS11 D11: what a call SAYS ("Edited Transcript.tsx"), what a run says ("Read 3 files, ran a command"), where a run begins
// and ends, and the run's revision are the BOX's (src/server/transcriptRuns.mjs). The phone decodes them
// (TranscriptViewModels.swift: `part.view`, `message.view.runs`, the live `toolRuns` frame) and lays the blocks out by
// run id. No wording, no summary and no run membership is computed here.
//
// FOUNDATION-ONLY ON PURPOSE. Nothing here may import SwiftUI/UIKit/Combine or touch a type that does (TranscriptBlock,
// LiveTool, DelegateJob, ...): this file is what the Linux `swift test` view of the app can compile. The block-level glue
// that needs the SwiftUI types lives in ChatModels.swift (`ChatTranscriptMapper`).
// ===========================================================================

// MARK: - Duration formatting

/// The step-row duration ("0.4s", "1m12s"). nil when timeless. (Moved here from
/// ChatModels.swift so the pure activity code can use it on Linux.)
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

enum ToolActivity {

    // MARK: JSON helpers (the JS `asRecord` / `str`)

    private static func record(_ v: JSONValue?) -> [String: JSONValue] {
        ChatJSON.object(v) ?? [:]
    }

    /// A trimmed string, "" for anything that is not a string.
    private static func str(_ v: JSONValue?) -> String {
        (ChatJSON.string(v) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func filePath(_ input: [String: JSONValue]) -> String {
        for key in ["filePath", "file_path", "path"] {
            let s = str(input[key])
            if !s.isEmpty { return s }
        }
        return ""
    }

    // MARK: Part accessors

    /// The tool id as the wire spells it ("" when absent).
    static func toolName(of part: OpencodePart) -> String {
        ChatJSON.string(part.extra["tool"]) ?? ""
    }

    static func state(of part: OpencodePart) -> [String: JSONValue] {
        record(part.extra["state"])
    }

    static func status(of part: OpencodePart) -> ActivityStatus {
        part.type == "patch" ? .completed : ActivityStatus.normalize(ChatJSON.string(state(of: part)["status"]))
    }

    /// `state.time.end - start` in seconds (opencode stamps tool time in ms).
    static func durationSeconds(of part: OpencodePart) -> Double? {
        let time = record(state(of: part)["time"])
        guard let start = ChatJSON.number(time["start"]), let end = ChatJSON.number(time["end"]),
              end >= start else { return nil }
        return (end - start) / 1000
    }

    /// `state.time.start` as epoch ms, for the live elapsed of a running call.
    static func startMs(of part: OpencodePart) -> Double? {
        ChatJSON.number(record(state(of: part)["time"])["start"])
    }

    /// What tapping a call row reveals in the sheet.
    struct Detail: Equatable, Sendable {
        /// The full command (bash).
        var command: String?
        /// The file path (edit / write / read / patch).
        var path: String?
        /// Other arguments, `key: value` per line (read / grep / fetch / ...).
        var arguments: String?
        /// A unified diff, when the tool recorded one.
        var diff: String?
        /// The tool's output (the view shows a tail).
        var output: String?
        /// The error text of a failed call.
        var error: String?

        var isEmpty: Bool {
            command == nil && path == nil && arguments == nil && diff == nil && output == nil && error == nil
        }
    }

    static func detail(of part: OpencodePart) -> Detail {
        var d = Detail()
        if part.type == "patch" {
            let files = (ChatJSON.array(part.extra["files"]) ?? []).compactMap { ChatJSON.string($0) }
            if !files.isEmpty { d.path = files.joined(separator: "\n") }
            return d
        }
        let tool = toolName(of: part).lowercased()
        let st = state(of: part)
        let input = record(st["input"])
        let metadata = record(st["metadata"])

        let output = resolvedOutput(st)
        if !output.isEmpty { d.output = output }
        if ActivityStatus.normalize(ChatJSON.string(st["status"])) == .error {
            let e = str(st["error"])
            if !e.isEmpty { d.error = e }
        }

        switch tool {
        case "bash":
            let command = str(input["command"])
            if !command.isEmpty { d.command = command }
        case "edit", "multiedit", "apply_patch", "patch", "write":
            let path = filePath(input)
            if !path.isEmpty { d.path = path }
            if let diff = ChatJSON.string(metadata["diff"]), !diff.isEmpty {
                d.diff = diff
            } else if let patch = ChatJSON.string(record(metadata["filediff"])["patch"]), !patch.isEmpty {
                d.diff = patch
            }
            // A write has no diff to show and its content is the file itself:
            // the output well would only echo "Wrote file successfully."
        default:
            let path = filePath(input)
            if tool == "read", !path.isEmpty { d.path = path }
            let args = argumentLines(input, skipping: tool == "read" ? ["filePath", "file_path", "path"] : [])
            if !args.isEmpty { d.arguments = args }
        }
        return d
    }

    /// `state.output`, else the live `state.metadata.output` a running tool
    /// streams into (desktop's `resolveToolOutput`).
    static func resolvedOutput(_ state: [String: JSONValue]) -> String {
        if let o = ChatJSON.string(state["output"]), !o.isEmpty { return o }
        return ChatJSON.string(record(state["metadata"])["output"]) ?? ""
    }

    /// What a call reads as when the box did not describe it (an older box, a part it did not stamp): the raw tool id and
    /// the call's own status — no wording of the phone's own.
    static func neutralActivity(of part: OpencodePart) -> TranscriptActivityView {
        let name = toolName(of: part)
        return TranscriptActivityView(
            kind: isTask(part) ? .task : .other,
            status: status(of: part),
            label: name.isEmpty ? "Tool" : name,
            target: "",
            counted: part.type == "tool"
        )
    }

    /// Whether a call is a `task` (a session, not a tool call): the box's `view.activity.kind`, else the tool id.
    static func isTask(_ part: OpencodePart) -> Bool {
        if let kind = TranscriptPartView.of(part)?.activity?.kind { return kind == .task }
        return toolName(of: part).lowercased() == "task"
    }

    /// What the Copy button puts on the clipboard for a call — the FULL text, never
    /// the tailed preview: a patch copies its file list; a `task` (a session, not
    /// a tool call) copies nothing; otherwise the diff, else the output. nil when
    /// there is nothing to copy.
    static func copyText(of part: OpencodePart) -> String? {
        if part.type == "patch" {
            let files = (ChatJSON.array(part.extra["files"]) ?? []).compactMap { ChatJSON.string($0) }
            return files.isEmpty ? nil : files.joined(separator: "\n")
        }
        if isTask(part) { return nil }
        let d = detail(of: part)
        guard let text = d.diff ?? d.output, !text.isEmpty else { return nil }
        return text
    }

    /// The output text a call row shows. Not verbose: the tailed preview. Verbose
    /// ("Show reasoning & full output"): the last 2,000 lines, hard-capped to the
    /// last 100,000 characters — canonical output has no box-side cap, so even the
    /// full view is bounded. `trimmed` tells the row to add a "showing the last
    /// 2,000 lines" note.
    static func outputForDisplay(_ output: String, verbose: Bool) -> (text: String, trimmed: Bool) {
        if verbose { return ToolOutputPreview.verboseTail(output) }
        let tail = ToolOutputPreview.tail(output)
        return (tail, tail != output)
    }

    /// A one-line display clip counting UTF-16 units (a detail-well limit, not wording).
    private static func truncatedLine(_ s: String, _ max: Int) -> String {
        let units = Array(s.utf16)
        guard units.count > max else { return s }
        var head = String(decoding: units.prefix(max - 1), as: UTF16.self)
        while let last = head.last, last.isWhitespace { head.removeLast() }
        return head + "…"
    }

    /// `key: value` lines for an input object, sorted by key so the text is
    /// deterministic, long values clipped to one line.
    private static func argumentLines(_ input: [String: JSONValue], skipping: Set<String>) -> String {
        input.keys.sorted().compactMap { key -> String? in
            guard !skipping.contains(key) else { return nil }
            let text: String
            switch input[key] {
            case .string(let s)?: text = s
            case .number(let n)?: text = n.rounded() == n && abs(n) < 1e15 ? String(Int(n)) : String(n)
            case .bool(let b)?: text = b ? "true" : "false"
            default: return nil
            }
            let line = text.components(separatedBy: .newlines).first ?? text
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            return trimmed.isEmpty ? nil : "\(key): \(truncatedLine(trimmed, 160))"
        }.joined(separator: "\n")
    }

    // MARK: Synthetic parts (live frames, tests)

    /// A tool part built from pieces. Used for the box's live tool frames (which
    /// carry only a name, a title and a stdout tail) and the live subagent frame,
    /// and by tests.
    static func makeToolPart(
        id: String,
        messageID: String = "",
        callID: String? = nil,
        tool: String,
        status: String,
        title: String? = nil,
        input: [String: JSONValue] = [:],
        metadata: [String: JSONValue] = [:],
        output: String? = nil,
        startMs: Double? = nil,
        endMs: Double? = nil
    ) -> OpencodePart {
        var state: [String: JSONValue] = ["status": .string(status), "input": .object(input)]
        if let title, !title.isEmpty { state["title"] = .string(title) }
        if !metadata.isEmpty { state["metadata"] = .object(metadata) }
        if let output { state["output"] = .string(output) }
        if let startMs {
            var time: [String: JSONValue] = ["start": .number(startMs)]
            if let endMs { time["end"] = .number(endMs) }
            state["time"] = .object(time)
        }
        var extra: [String: JSONValue] = ["tool": .string(tool), "state": .object(state)]
        if let callID, !callID.isEmpty { extra["callID"] = .string(callID) }
        return OpencodePart(type: "tool", id: id, messageID: messageID, extra: extra)
    }
}

// MARK: - Working line wording (spec §1.4)

extension TranscriptRunSummary {
    /// The emphasised part of the working line: the running tool's label while a tool is executing, otherwise the turn's
    /// rotating verb. Always ends in "…". The label is the box's (`live`).
    func workingLineHeadline(verb: String) -> String {
        "\(live?.label ?? verb)…"
    }

    /// The faint text after the headline:
    ///  - a tool is running → "· N tools · elapsed" (the count only past one call)
    ///  - between tools     → "· <run summary> · elapsed"
    /// `elapsed` is nil when the turn's start is unknown. "" when there is nothing to say.
    func workingLineMeta(elapsed: String?) -> String {
        var parts: [String] = []
        if live != nil {
            if calls > 1 { parts.append("\(calls) tools") }
        } else {
            parts.append(label)
        }
        if let elapsed { parts.append(elapsed) }
        return parts.isEmpty ? "" : "· " + parts.joined(separator: " · ")
    }
}

// MARK: - Runs and layout

/// A run (or, with reasoning shown, one SEGMENT of a run): consecutive tool calls and file-save patches, possibly spanning
/// several assistant messages. `id` is the id of the FIRST part of the run (or of the segment; the first segment's id IS
/// the run id), so it is stable while the run grows and is what the Activity sheet is keyed by. `view` is the BOX's
/// summary of it — decoded, never recomputed.
struct ToolRun: Equatable, Sendable, Identifiable {
    var id: String
    var parts: [OpencodePart]
    var view: TranscriptRunSummary
    /// The run this block belongs to (`id` for an unsplit run; the run's id when `id` is a segment's).
    var runID: String
    /// The segment this block draws, when reasoning is shown and the run split.
    var segmentID: String?
    /// True for the stand-in line of a box without `transcript-runs-1`: raw calls, a neutral label.
    var isFallback: Bool

    init(id: String, parts: [OpencodePart], view: TranscriptRunSummary, runID: String? = nil, segmentID: String? = nil,
         isFallback: Bool = false) {
        self.id = id
        self.parts = parts
        self.view = view
        self.runID = runID ?? id
        self.segmentID = segmentID
        self.isFallback = isFallback
    }

    /// Wall-clock span of the finished calls (first start → last end), seconds.
    var totalDurationSeconds: Double? {
        let starts = parts.compactMap { ToolActivity.startMs(of: $0) }
        let ends = parts.compactMap { part -> Double? in
            ChatJSON.number(ChatJSON.object(ToolActivity.state(of: part)["time"])?["end"])
        }
        guard let start = starts.min(), let end = ends.max(), end >= start else { return nil }
        return (end - start) / 1000
    }

    /// This run with `extra` parts added: a part the run already owns (same part id, same call id — a live row and its
    /// canonical sibling —, or, for a task, the same child session) is NOT added again, and the run keeps the part it has
    /// (the canonical one wins for its content; the ledger only adds what is missing).
    func upserting(_ extra: [OpencodePart]) -> ToolRun {
        var ids = Set(parts.map(\.id))
        var calls = Set(parts.compactMap { ChatJSON.string($0.extra["callID"]) }.filter { !$0.isEmpty })
        var children = Set(parts.compactMap { TaskStatusResolver.childSessionID(of: $0) })
        var merged = parts
        for p in extra {
            if ids.contains(p.id) { continue }
            if let c = ChatJSON.string(p.extra["callID"]), !c.isEmpty, calls.contains(c) { continue }
            if let child = TaskStatusResolver.childSessionID(of: p), children.contains(child) { continue }
            merged.append(p)
            ids.insert(p.id)
            if let c = ChatJSON.string(p.extra["callID"]), !c.isEmpty { calls.insert(c) }
            if let child = TaskStatusResolver.childSessionID(of: p) { children.insert(child) }
        }
        var copy = self
        copy.parts = merged
        return copy
    }
}

enum ToolLayoutBlock: Equatable, Sendable {
    case part(OpencodePart)
    case tools(ToolRun)
}

struct ToolLayout: Equatable, Sendable {
    /// Blocks each assistant message draws. Absorbed messages map to [].
    var blocksByMessage: [String: [ToolLayoutBlock]]
}

extension ToolActivity {

    /// Parts a message can draw: synthetic / ignored / empty text, step markers and todo-list writes are dropped.
    static func visibleAssistantParts(_ msg: OpencodeMessage) -> [OpencodePart] {
        msg.parts.filter { p in
            switch p.type {
            case "text":
                return p.synthetic != true && p.ignored != true && !(p.text ?? "").isEmpty
            case "step-start", "step-finish":
                return false
            case "tool":
                let tool = toolName(of: p)
                return tool != "todowrite" && tool != "todo_write"
            default:
                return true
            }
        }
    }

    private static func isBlank(_ s: String) -> Bool {
        s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The neutral summary of a message's calls when the box did not group them (an older box, or a part the box did not
    /// stamp): one static line, no wording of the phone's own.
    static func fallbackSummary(calls: Int) -> TranscriptRunSummary {
        TranscriptRunSummary(label: "Tool activity", calls: calls, failed: 0, tone: .ok, live: nil)
    }

    /// Lay the transcript out as blocks, by the box's run ids.
    ///
    /// - A tool/patch part draws in the block of its `view.runId`; the block sits where the run's FIRST in-window part is
    ///   (later messages that add to it draw nothing). With reasoning shown a run that reasoning split draws one block per
    ///   SEGMENT; hidden, the segments collapse into ONE block at the first.
    /// - Anything else that draws (non-blank text, shown reasoning, a handoff card, unknown parts) is its own block. A
    ///   whitespace-only text part is paragraph noise and draws nothing.
    /// - A call with no run id (an older box, or a membership a rebuild retired) joins ONE neutral line per message — it is
    ///   never dropped.
    /// - `runs` is the newest value of each run (revision-merged); a run it lacks falls back to the full view a message
    ///   carries. `minGen`: parts with `view.gen` below it are a retired membership.
    static func layout(
        messages: [OpencodeMessage],
        showThinking: Bool,
        runs: [String: TranscriptRunView] = [:],
        minGen: Int = 0
    ) -> ToolLayout {
        var carried: [String: TranscriptRunView] = [:]
        for message in messages {
            for case .view(let v) in message.view?.runs ?? [] where carried[v.id] == nil { carried[v.id] = v }
        }

        var blocksByMessage: [String: [ToolLayoutBlock]] = [:]
        // Each run/segment block's placeholder: the message that draws it, its index in that message's blocks.
        var placed: [String: (owner: String, index: Int)] = [:]
        var order: [String] = []
        var groupParts: [String: [OpencodePart]] = [:]
        var groupRun: [String: (runID: String, segmentID: String?)] = [:]
        // A message's neutral line (one per message) has the key `tools:<messageID>`.

        for msg in messages {
            if msg.info.role.rawValue == "user" { continue }
            let id = msg.info.id
            blocksByMessage[id] = blocksByMessage[id] ?? []
            for part in visibleAssistantParts(msg) {
                // A `handoff` call is a card of its own, not a line inside a run.
                if HandoffToolRef.isHandoffTool(part) {
                    blocksByMessage[id, default: []].append(.part(part))
                    continue
                }
                if part.type == "tool" || part.type == "patch" {
                    let view = TranscriptPartView.of(part)
                    guard let runID = view?.runId, (view?.gen ?? minGen) >= minGen else {
                        let key = "tools:\(id)"
                        if groupParts[key] != nil {
                            groupParts[key]?.append(part)
                        } else {
                            placed[key] = (id, blocksByMessage[id, default: []].count)
                            order.append(key)
                            groupParts[key] = [part]
                            groupRun[key] = (key, nil)
                            blocksByMessage[id, default: []].append(.part(part)) // placeholder, replaced below
                        }
                        continue
                    }
                    let segment = showThinking ? view?.segmentId : nil
                    let key = segment ?? runID
                    if groupParts[key] != nil {
                        groupParts[key]?.append(part)
                    } else {
                        placed[key] = (id, blocksByMessage[id, default: []].count)
                        order.append(key)
                        groupParts[key] = [part]
                        groupRun[key] = (runID, segment)
                        blocksByMessage[id, default: []].append(.part(part)) // placeholder, replaced below
                    }
                    continue
                }
                if part.type == "text", isBlank(part.text ?? "") { continue }
                if part.type == "reasoning" {
                    // Empty reasoning never draws; hidden reasoning is transparent.
                    if !showThinking || isBlank(part.text ?? "") { continue }
                }
                blocksByMessage[id, default: []].append(.part(part))
            }
        }

        for key in order {
            guard let at = placed[key], let parts = groupParts[key], let ref = groupRun[key] else { continue }
            let isFallback = key.hasPrefix("tools:") && ref.runID == key
            let summary: TranscriptRunSummary
            if isFallback {
                summary = fallbackSummary(calls: parts.filter { $0.type == "tool" }.count)
            } else if let run = runs[ref.runID] ?? carried[ref.runID] {
                summary = run.summary(forSegment: showThinking ? ref.segmentID : nil)
            } else {
                summary = fallbackSummary(calls: parts.filter { $0.type == "tool" }.count)
            }
            blocksByMessage[at.owner]?[at.index] = .tools(
                ToolRun(id: key, parts: parts, view: summary, runID: ref.runID, segmentID: ref.segmentID, isFallback: isFallback)
            )
        }
        return ToolLayout(blocksByMessage: blocksByMessage)
    }
}

// MARK: - Task (subagent) status — spec §5

/// The resolved state of a task row.
enum TaskRunStatus: Equatable, Sendable {
    case running
    /// The tool call is "completed" but the work it started is still going.
    case backgroundRunning
    case done
    case failed

    var isRunning: Bool { self == .running || self == .backgroundRunning }

    /// The `state.status` a part should carry to read as this status.
    var wireStatus: String {
        switch self {
        case .running, .backgroundRunning: return "running"
        case .done: return "completed"
        case .failed: return "error"
        }
    }
}

/// What the resolver may know beyond the tool call itself.
struct TaskStatusContext: Equatable, Sendable {
    /// Child session id → whether the event store reports the child busy. A
    /// missing key means "no state for that session": unknown, not idle.
    var childRunning: [String: Bool]
    /// Child session id → the background-job record's status
    /// ("running", "paused", "done", "failed", "stopped", ...).
    var jobStatus: [String: String]
    /// Background-job id → status. A `delegate` call links to its job by the id
    /// printed in its output, not by a child session.
    var jobStatusByID: [String: String]

    init(
        childRunning: [String: Bool] = [:],
        jobStatus: [String: String] = [:],
        jobStatusByID: [String: String] = [:]
    ) {
        self.childRunning = childRunning
        self.jobStatus = jobStatus
        self.jobStatusByID = jobStatusByID
    }

    static let empty = TaskStatusContext()
}

enum TaskStatusResolver {

    /// `state.metadata.sessionId` of a task part.
    static func childSessionID(of part: OpencodePart) -> String? {
        guard part.type == "tool", ToolActivity.toolName(of: part).lowercased() == "task" else { return nil }
        let metadata = ChatJSON.object(ToolActivity.state(of: part)["metadata"])
        guard let id = ChatJSON.string(metadata?["sessionId"]), !id.isEmpty else { return nil }
        return id
    }

    /// Every child session id a transcript's task parts name.
    static func childSessionIDs(in messages: [OpencodeMessage]) -> Set<String> {
        var out = Set<String>()
        for m in messages {
            for p in m.parts {
                if let id = childSessionID(of: p) { out.insert(id) }
            }
        }
        return out
    }

    /// A background task's tool call is marked completed as soon as the job
    /// starts; its output then reads `<task … state="running">`.
    static func isBackgroundTaskOutput(_ output: String?) -> Bool {
        guard let output else { return false }
        let t = output.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.hasPrefix("<task") && t.contains("state=\"running\"")
    }

    /// The first rule that applies wins:
    ///  1. tool call errored → failed
    ///  2. child session is busy → running
    ///  3. a job record for the child is running or paused → running
    ///  4. tool call pending/running → running
    ///  5. tool call completed but it is a background task and neither the
    ///     child (idle) nor its job record (finished) says otherwise → running
    ///     ("started in background")
    ///  6. otherwise → done
    static func resolve(
        toolStatus: String?,
        childSessionID child: String?,
        output: String?,
        context: TaskStatusContext
    ) -> TaskRunStatus {
        let status = ActivityStatus.normalize(toolStatus)
        if status == .error { return .failed }
        let childState = child.flatMap { context.childRunning[$0] }
        if childState == true { return .running }
        let job = child.flatMap { context.jobStatus[$0] }?.lowercased()
        if job == "running" || job == "paused" { return .running }
        if status == .pending || status == .running { return .running }
        if isBackgroundTaskOutput(output), childState != false, job == nil {
            return .backgroundRunning
        }
        return .done
    }

    static func resolve(_ part: OpencodePart, context: TaskStatusContext) -> TaskRunStatus {
        let state = ToolActivity.state(of: part)
        return resolve(
            toolStatus: ChatJSON.string(state["status"]),
            childSessionID: childSessionID(of: part),
            output: ChatJSON.string(state["output"]),
            context: context
        )
    }

    /// The part with `state.status` rewritten to the resolved status, so every
    /// consumer (wording, tone, the working line, the sheet) agrees. Parts that
    /// are neither a task nor a `delegate` call, and parts whose status already
    /// matches, come back unchanged.
    static func applying(_ context: TaskStatusContext, to part: OpencodePart) -> OpencodePart {
        if isDelegateTool(part) { return applyingDelegate(context, to: part) }
        guard childTaskLike(part) else { return part }
        let resolved = resolve(part, context: context)
        var state = ToolActivity.state(of: part)
        let current = ActivityStatus.normalize(ChatJSON.string(state["status"]))
        // pending and running read the same (both are "unfinished"), so only a
        // real change rewrites the part.
        switch resolved {
        case .running, .backgroundRunning:
            if current == .pending || current == .running { return part }
        case .done:
            if current == .completed { return part }
        case .failed:
            if current == .error { return part }
        }
        state["status"] = .string(resolved.wireStatus)
        var copy = part
        copy.extra["state"] = .object(state)
        return copy
    }

    private static func childTaskLike(_ part: OpencodePart) -> Bool {
        part.type == "tool" && ToolActivity.toolName(of: part).lowercased() == "task"
    }

    // MARK: Delegate calls (iOS-only)
    //
    // The `delegate` tool completes the instant the job is queued, so its call
    // always reads done while the job it started may run for many minutes. The
    // output names the job (`… (id 198262c2). …`); the job record says whether
    // it is still going.

    /// `delegate` as the model sees it: the tool id arrives MCP-prefixed
    /// (`delegate_delegate`), plain `delegate` is accepted too. `delegate_list`
    /// / `delegate_stop` are different tools and do not match. `lowercased` is
    /// the tool id already lowercased.
    static func isDelegateToolName(_ lowercased: String) -> Bool {
        let name = lowercased.replacingOccurrences(of: "^mcp[_-]", with: "", options: .regularExpression)
        return name == "delegate" || name == "delegate_delegate"
    }

    static func isDelegateTool(_ part: OpencodePart) -> Bool {
        part.type == "tool" && isDelegateToolName(ToolActivity.toolName(of: part).lowercased())
    }

    /// The job id in a delegate call's output — `(id <lowercase hex>)`, exactly.
    /// nil for anything else (no output yet, an error message, a changed wording).
    static func delegateJobID(fromOutput output: String?) -> String? {
        guard let output else { return nil }
        return firstCapture(#"\(id ([0-9a-f]+)\)"#, in: output)
    }

    /// A finished delegate call whose job is still running or paused reads as
    /// running. Nothing else changes it: a call that errored stays failed, a job
    /// that itself FAILED is not a failed tool call (the Background jobs sheet
    /// carries the job's own status), and a job the list does not know yet (or a
    /// call with no output to link by) is left as it is.
    static func applyingDelegate(_ context: TaskStatusContext, to part: OpencodePart) -> OpencodePart {
        var state = ToolActivity.state(of: part)
        guard ActivityStatus.normalize(ChatJSON.string(state["status"])) == .completed,
              let jobID = delegateJobID(fromOutput: ToolActivity.resolvedOutput(state)),
              let job = context.jobStatusByID[jobID]?.lowercased(),
              job == "running" || job == "paused" else { return part }
        state["status"] = .string(TaskRunStatus.running.wireStatus)
        var copy = part
        copy.extra["state"] = .object(state)
        return copy
    }

    private static func firstCapture(_ pattern: String, in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, range: range), match.numberOfRanges > 1,
              let r = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[r])
    }
}

extension ToolRun {
    /// The run with its task parts' (and `delegate` calls') statuses resolved
    /// (spec §5). Returns `self` untouched when it has none, the common case.
    func resolvingTasks(_ context: TaskStatusContext) -> ToolRun {
        var changed = false
        let next = parts.map { part -> OpencodePart in
            let updated = TaskStatusResolver.applying(context, to: part)
            if updated != part { changed = true }
            return updated
        }
        guard changed else { return self }
        var copy = self
        copy.parts = next
        return copy
    }
}

// MARK: - Activity sheet disclosure

enum ActivityDisclosure {
    /// Whether a call row starts expanded. A run with exactly ONE call opens
    /// with that call expanded (desktop's `defaultExpanded`); a failed call
    /// always starts open so its error is visible. The user's own toggle wins.
    ///
    /// With "Show reasoning & full output" on (`verbose`), a completed `read`
    /// call also starts open: the full content is the point of the switch.
    static func expanded(
        callCount: Int,
        status: ActivityStatus,
        isTool: Bool,
        userToggled: Bool?,
        kind: ActivityKind = .other,
        verbose: Bool = false
    ) -> Bool {
        if let userToggled { return userToggled }
        if status == .error { return true }
        if verbose, kind == .read, status == .completed { return true }
        return callCount == 1 && isTool
    }
}

// MARK: - Todo card — spec §6

struct TodoProgress: Equatable, Sendable {
    var total: Int
    var settled: Int
    var inProgress: Int
    var settledPct: Double
    var activePct: Double
    /// "3/7".
    var label: String
    var allSettled: Bool
}

/// What the transcript's todo row renders.
struct TodoCardContent: Equatable, Sendable {
    var items: [StreamTodoItem]
    var expanded: Bool
}

enum TodoCardLogic {

    static func status(_ item: StreamTodoItem) -> String {
        (item.status ?? "").lowercased()
    }

    static func isTerminal(_ item: StreamTodoItem) -> Bool {
        let s = status(item)
        return s == "completed" || s == "cancelled"
    }

    /// True when the list is non-empty and every item is terminal — the trigger
    /// for dismissing the card when the user sends their next prompt.
    static func allTerminal(_ items: [StreamTodoItem]) -> Bool {
        !items.isEmpty && items.allSatisfy(isTerminal)
    }

    /// Progress over the WHOLE list. Cancelled counts as settled.
    static func progress(_ items: [StreamTodoItem]) -> TodoProgress {
        var settled = 0
        var inProgress = 0
        for item in items {
            let s = status(item)
            if s == "completed" || s == "cancelled" { settled += 1 }
            else if s == "in_progress" { inProgress += 1 }
        }
        let total = items.count
        func pct(_ n: Int) -> Double { total > 0 ? Double(n) / Double(total) * 100 : 0 }
        return TodoProgress(
            total: total, settled: settled, inProgress: inProgress,
            settledPct: pct(settled), activePct: pct(inProgress),
            label: "\(settled)/\(total)", allSettled: total > 0 && settled == total
        )
    }

    /// The one line shown under the collapsed header: the current in-progress
    /// item, else the next one still to do. nil when everything is settled.
    static func headline(_ items: [StreamTodoItem]) -> StreamTodoItem? {
        if let current = items.first(where: { status($0) == "in_progress" }) { return current }
        return items.first(where: { !isTerminal($0) })
    }

    /// The most recent non-empty `todowrite` input in a transcript — the
    /// fallback when no live todo frame has arrived (a reopened session).
    static func fromTranscript(_ messages: [OpencodeMessage]) -> [StreamTodoItem]? {
        for message in messages.reversed() {
            for part in message.parts.reversed() {
                guard part.type == "tool" else { continue }
                let tool = ToolActivity.toolName(of: part)
                guard tool == "todowrite" || tool == "todo_write" else { continue }
                let input = ChatJSON.object(ToolActivity.state(of: part)["input"])
                guard let raw = ChatJSON.array(input?["todos"]), !raw.isEmpty else { continue }
                let items = raw.compactMap { value -> StreamTodoItem? in
                    guard let obj = ChatJSON.object(value) else { return nil }
                    return StreamTodoItem(
                        id: ChatJSON.string(obj["id"]),
                        content: ChatJSON.string(obj["content"]),
                        status: ChatJSON.string(obj["status"])
                    )
                }
                if !items.isEmpty { return items }
            }
        }
        return nil
    }

    /// Which list the card renders, or nil to hide it (desktop's
    /// `selectActiveTodos`):
    ///  1. A live frame is authoritative WHEN PRESENT. opencode fires
    ///     `todo.updated` with the full list every time TodoWrite runs —
    ///     including an empty one when the model clears it — so a present frame
    ///     with no items means "explicitly cleared", not "no data".
    ///  2. With no live frame, the transcript's last todo write.
    ///  3. A list the user dismissed (by sending a prompt while it was all
    ///     terminal) stays hidden until the list CHANGES.
    static func select(
        live: StreamTodosPayload?,
        transcript: [StreamTodoItem]?,
        dismissed: [StreamTodoItem]?
    ) -> [StreamTodoItem]? {
        let items: [StreamTodoItem]?
        if let live {
            let all = live.active ?? []
            items = all.isEmpty ? nil : all
        } else if let transcript, !transcript.isEmpty {
            items = transcript
        } else {
            items = nil
        }
        guard let items else { return nil }
        if let dismissed, dismissed == items { return nil }
        return items
    }
}
