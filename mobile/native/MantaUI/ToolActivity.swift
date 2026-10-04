import Foundation

// ===========================================================================
// Tool activity: wording, run grouping, task status, todo card logic.
//
// Swift port of the desktop's `src/renderer/toolActivity.ts` (PR #1555/#1556)
// plus the iOS-only decisions the spec adds (docs/superpowers/specs/
// 2026-10-04-ios-activity-parity-design.md: §1 activity rows, §5 task status,
// §6 todo card).
//
// FOUNDATION-ONLY ON PURPOSE. Nothing here may import SwiftUI/UIKit/Combine or
// touch a type that does (TranscriptBlock, LiveTool, DelegateJob, ...): this
// file is what the Linux `swift test` view of the app can compile, and what the
// shared parity fixture (src/shared/fixtures/tool-activity-cases.json) is
// asserted against. The block-level glue that needs the SwiftUI types lives in
// ChatModels.swift (`ChatTranscriptMapper`).
//
// PARITY CONTRACT. The wording (`describe`, `summarize`) and the grouping
// (`layout`) must produce exactly what desktop produces. The fixture file is the
// referee: a vitest test asserts it against toolActivity.ts and
// ToolActivityTests asserts it against this port. If you change a string here,
// change toolActivity.ts and the fixture in the same commit.
//
// Known, deliberate differences from the desktop (each one is pinned by a test):
//   - A whitespace-only text part is TRANSPARENT to a run (it neither joins nor
//     ends it). Desktop would end the run, but iOS draws nothing for such a part
//     (BET-632), so ending the run would split one visible run in two.
//   - A user message "renders" iff it has non-blank text (what the user band
//     draws), not "or has a file part".
//   - `clip` counts UTF-16 units like JS `String.length`, so truncation agrees.
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

// MARK: - Wording

enum ActivityKind: String, Equatable, Sendable {
    case read, edit, write, bash, search, list, fetch, websearch, task, skill, question, other, patch

    /// Run-summary phrase for `n` calls of this kind ("edited 3 files").
    func plural(_ n: Int) -> String {
        func pick(_ one: String, _ many: String) -> String {
            n == 1 ? one : many.replacingOccurrences(of: "{n}", with: String(n))
        }
        switch self {
        case .read: return pick("read a file", "read {n} files")
        case .edit: return pick("edited a file", "edited {n} files")
        case .write: return pick("wrote a file", "wrote {n} files")
        case .bash: return pick("ran a command", "ran {n} commands")
        case .search: return pick("searched code", "ran {n} searches")
        case .list: return pick("listed a directory", "listed {n} directories")
        case .fetch: return pick("fetched a page", "fetched {n} pages")
        case .websearch: return n == 1 ? "searched the web" : "searched the web \(n) times"
        case .task: return pick("ran an agent", "ran {n} agents")
        case .skill: return pick("loaded a skill", "loaded {n} skills")
        case .question: return pick("asked a question", "asked {n} questions")
        case .other: return pick("used a tool", "used {n} tools")
        case .patch: return n == 1 ? "saved a change" : "saved \(n) changes"
        }
    }
}

enum ActivityStatus: String, Equatable, Sendable {
    case pending, running, completed, error

    /// opencode's `state.status` onto the four states the activity wording uses.
    /// Anything unrecognised is `pending`, exactly like desktop's
    /// `normalizeToolStatus`.
    static func normalize(_ raw: String?) -> ActivityStatus {
        switch raw {
        case "completed": return .completed
        case "error": return .error
        case "running": return .running
        default: return .pending
        }
    }
}

struct Activity: Equatable, Sendable {
    /// Category the run summary tallies by (grep/glob/codesearch share one).
    var kind: ActivityKind
    var status: ActivityStatus
    /// Present-tense label ("Editing Transcript.tsx").
    var running: String
    /// Past-tense label ("Edited Transcript.tsx").
    var done: String
    /// Failure label ("Failed to edit Transcript.tsx").
    var failed: String
    /// False for patch parts: they join a run but are not a "tool".
    var counted: Bool

    /// The label for the part's CURRENT status.
    var label: String {
        switch status {
        case .completed: return done
        case .error: return failed
        case .pending, .running: return running
        }
    }
}

enum GroupTone: Equatable, Sendable {
    case ok, warn, running
}

struct GroupSummary: Equatable, Sendable {
    /// One-line summary of the run, e.g. "Read 3 files, ran a command".
    var label: String
    /// The latest tool that has not finished (running OR pending), if any.
    var live: Activity?
    /// Tool calls in the run — patch parts are not counted.
    var calls: Int
    /// Tool calls that errored.
    var failed: Int
    /// True while any tool call is unfinished.
    var running: Bool

    /// Dot tone for a run: running while unfinished, warn if any failed, else ok.
    var tone: GroupTone {
        running ? .running : (failed > 0 ? .warn : .ok)
    }
}

enum ToolActivity {

    static let bashDetailMax = 60
    static let maxSummaryCategories = 3

    // MARK: JSON helpers (the JS `asRecord` / `str`)

    private static func record(_ v: JSONValue?) -> [String: JSONValue] {
        ChatJSON.object(v) ?? [:]
    }

    /// A trimmed string, "" for anything that is not a string.
    private static func str(_ v: JSONValue?) -> String {
        (ChatJSON.string(v) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func basename(_ p: String) -> String {
        var trimmed = p
        while let last = trimmed.last, last == "/" || last == "\\" { trimmed.removeLast() }
        if let i = trimmed.lastIndex(where: { $0 == "/" || $0 == "\\" }) {
            return String(trimmed[trimmed.index(after: i)...])
        }
        return trimmed
    }

    /// JS `new URL(url).host || url`: host with a non-default port, lowercased;
    /// the input unchanged when it is not an absolute URL.
    static func hostOf(_ url: String) -> String {
        guard let comps = URLComponents(string: url),
              let scheme = comps.scheme?.lowercased(),
              let host = comps.host, !host.isEmpty else { return url }
        let defaults: [String: Int] = ["http": 80, "https": 443, "ftp": 21, "ws": 80, "wss": 443]
        var result = host.lowercased()
        if let port = comps.port, defaults[scheme] != port {
            result += ":\(port)"
        }
        return result
    }

    /// JS `s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s`, counting
    /// UTF-16 units like JS does.
    static func clip(_ s: String, _ max: Int) -> String {
        let units = Array(s.utf16)
        guard units.count > max else { return s }
        var head = String(decoding: units.prefix(max - 1), as: UTF16.self)
        while let last = head.last, last.isWhitespace { head.removeLast() }
        return head + "…"
    }

    /// "mcp_Axiom_queryApl" → "Axiom queryApl".
    static func humanizeToolName(_ tool: String) -> String {
        let name = tool.replacingOccurrences(of: "^mcp[_-]", with: "", options: [.regularExpression, .caseInsensitive])
        let words = name.components(separatedBy: CharacterSet(charactersIn: "_-")).filter { !$0.isEmpty }
        return words.isEmpty ? tool : words.joined(separator: " ")
    }

    private static func filePath(_ input: [String: JSONValue]) -> String {
        for key in ["filePath", "file_path", "path"] {
            let s = str(input[key])
            if !s.isEmpty { return s }
        }
        return ""
    }

    private static func first(_ candidates: String...) -> String {
        candidates.first(where: { !$0.isEmpty }) ?? ""
    }

    private static func withDetail(_ verb: String, _ detail: String) -> String {
        detail.isEmpty ? verb : "\(verb) \(detail)"
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

    // MARK: Describe

    /// Labels for one tool or patch part.
    static func describe(_ part: OpencodePart) -> Activity {
        part.type == "patch" ? describePatch(part) : describeTool(part)
    }

    private static func describeTool(_ part: OpencodePart) -> Activity {
        let rawTool = toolName(of: part)
        let tool = rawTool.lowercased()
        let st = state(of: part)
        let input = record(st["input"])
        let status = ActivityStatus.normalize(ChatJSON.string(st["status"]))
        let title = str(st["title"])

        func make(_ kind: ActivityKind, _ running: String, _ done: String, _ failed: String) -> Activity {
            Activity(kind: kind, status: status, running: running, done: done, failed: failed, counted: true)
        }
        func verbs(_ kind: ActivityKind, _ run: String, _ done: String, _ fail: String, _ detail: String) -> Activity {
            make(kind, withDetail(run, detail), withDetail(done, detail), withDetail(fail, detail))
        }

        switch tool {
        case "read":
            return verbs(.read, "Reading", "Read", "Failed to read", first(basename(filePath(input)), title))
        case "edit", "multiedit", "apply_patch", "patch":
            return verbs(.edit, "Editing", "Edited", "Failed to edit", first(basename(filePath(input)), title))
        case "write":
            return verbs(.write, "Writing", "Wrote", "Failed to write", first(basename(filePath(input)), title))
        case "bash":
            let command = str(input["command"]).components(separatedBy: "\n").first?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let detail = clip(first(str(input["description"]), command, title), bashDetailMax)
            // A shell call's own description IS the label ("Run the tests"). With
            // no description, command or title at all (a pending part), fall back
            // to a generic phrase rather than an empty line.
            if detail.isEmpty {
                return make(.bash, "Running a command", "Ran a command", "Failed to run a command")
            }
            return make(.bash, detail, detail, "Failed: \(detail)")
        case "grep", "glob", "codesearch":
            return verbs(.search, "Searching", "Searched", "Failed to search",
                         first(str(input["pattern"]), str(input["query"]), title))
        case "list", "ls":
            return verbs(.list, "Listing", "Listed", "Failed to list", first(basename(str(input["path"])), title))
        case "webfetch", "web_fetch":
            return verbs(.fetch, "Fetching", "Fetched", "Failed to fetch", first(hostOf(str(input["url"])), title))
        case "websearch", "web_search":
            let q = first(str(input["query"]), title)
            // "…the web for" reads wrong with nothing after it.
            if q.isEmpty {
                return make(.websearch, "Searching the web", "Searched the web", "Failed to search the web")
            }
            return verbs(.websearch, "Searching the web for", "Searched the web for", "Failed to search the web for", q)
        case "task":
            let detail = first(str(input["description"]), title)
            return make(.task,
                        withDetail("Running agent", detail),
                        withDetail("Ran agent", detail),
                        withDetail("Agent failed:", detail))
        case "skill":
            return verbs(.skill, "Loading skill", "Loaded skill", "Failed to load skill", first(str(input["name"]), title))
        case "question":
            return make(.question, "Asking", "Asked", "Failed to ask")
        default:
            let name = humanizeToolName(ChatJSON.string(part.extra["tool"]) ?? "tool")
            return make(.other, "Using \(name)", "Used \(name)", "Failed: \(name)")
        }
    }

    private static func describePatch(_ part: OpencodePart) -> Activity {
        let files = (ChatJSON.array(part.extra["files"]) ?? [])
        let detail: String
        if files.count == 1 {
            detail = basename(ChatJSON.string(files[0]) ?? "")
        } else if files.count > 1 {
            detail = "\(files.count) files"
        } else {
            detail = ""
        }
        let done = detail.isEmpty ? "Saved changes" : "Saved changes to \(detail)"
        // A checkpoint cannot fail; `failed` is kept equal to `done` so callers
        // never branch.
        return Activity(kind: .patch, status: .completed, running: withDetail("Saving", detail),
                        done: done, failed: done, counted: false)
    }

    // MARK: Summary

    static func summarize(_ parts: [OpencodePart]) -> GroupSummary {
        let activities = parts.map(describe)
        let tools = activities.filter(\.counted)
        // Patches are file-save checkpoints that trail an edit, not separate
        // activities: once the run has any tool call they stay out of the wording
        // AND out of the one-vs-many decision ("Edited X", not "Edited a file,
        // saved a change"). A run made only of patches is the one place they
        // speak.
        let described = tools.isEmpty ? activities : tools
        let failed = tools.filter { $0.status == .error }.count
        let unfinished = tools.filter { $0.status != .completed && $0.status != .error }
        let live = unfinished.last

        let label: String
        if described.count == 1 {
            let only = described[0]
            label = only.status == .error ? only.failed : only.done
        } else {
            var order: [ActivityKind] = []
            var counts: [ActivityKind: Int] = [:]
            for a in described {
                if counts[a.kind] != nil {
                    counts[a.kind, default: 0] += 1
                } else {
                    order.append(a.kind)
                    counts[a.kind] = 1
                }
            }
            if order.count > maxSummaryCategories {
                label = "Used \(tools.count) tools"
            } else {
                let text = order.map { $0.plural(counts[$0] ?? 0) }.joined(separator: ", ")
                label = text.prefix(1).uppercased() + text.dropFirst()
            }
        }
        return GroupSummary(label: label, live: live, calls: tools.count, failed: failed, running: live != nil)
    }

    // MARK: Per-call presentation (the Activity sheet)

    /// The mono string a call acted on: the full path / command / pattern / url,
    /// "" when the part carries none.
    static func target(of part: OpencodePart) -> String {
        if part.type == "patch" {
            let files = (ChatJSON.array(part.extra["files"]) ?? []).compactMap { ChatJSON.string($0) }
            return files.joined(separator: ", ")
        }
        let tool = toolName(of: part).lowercased()
        let st = state(of: part)
        let input = record(st["input"])
        let title = str(st["title"])
        switch tool {
        case "bash":
            let command = str(input["command"]).components(separatedBy: "\n").first?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return first(command, title)
        case "read", "edit", "multiedit", "apply_patch", "patch", "write":
            return first(filePath(input), title)
        case "grep", "glob", "codesearch":
            return first(str(input["pattern"]), str(input["query"]), title)
        case "list", "ls":
            return first(str(input["path"]), title)
        case "webfetch", "web_fetch":
            return first(str(input["url"]), title)
        case "websearch", "web_search":
            return first(str(input["query"]), title)
        case "task":
            return first(str(input["description"]), title)
        case "skill":
            return first(str(input["name"]), title)
        default:
            return title
        }
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
            return trimmed.isEmpty ? nil : "\(key): \(clip(trimmed, 160))"
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

extension GroupSummary {
    /// The emphasised part of the working line: the running tool's label while a
    /// tool is executing, otherwise the turn's rotating verb. Always ends in "…".
    func workingLineHeadline(verb: String) -> String {
        "\(live?.running ?? verb)…"
    }

    /// The faint text after the headline:
    ///  - a tool is running → "· N tools · elapsed" (the count only past one call)
    ///  - between tools     → "· <run summary> · elapsed"
    /// `elapsed` is nil when the turn's start is unknown. "" when there is
    /// nothing to say.
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

/// A run: consecutive tool calls and file-save patches, possibly spanning
/// several assistant messages. `id` is the id of the FIRST part, so it stays
/// stable while the run grows (and is what the Activity sheet is keyed by).
struct ToolRun: Equatable, Sendable, Identifiable {
    var id: String
    var parts: [OpencodePart]

    init(id: String, parts: [OpencodePart]) {
        self.id = id
        self.parts = parts
    }

    init?(parts: [OpencodePart]) {
        guard let first = parts.first else { return nil }
        self.init(id: first.id, parts: parts)
    }

    var summary: GroupSummary { ToolActivity.summarize(parts) }

    /// Wall-clock span of the finished calls (first start → last end), seconds.
    var totalDurationSeconds: Double? {
        let starts = parts.compactMap { ToolActivity.startMs(of: $0) }
        let ends = parts.compactMap { part -> Double? in
            ChatJSON.number(ChatJSON.object(ToolActivity.state(of: part)["time"])?["end"])
        }
        guard let start = starts.min(), let end = ends.max(), end >= start else { return nil }
        return (end - start) / 1000
    }

    /// This run with `extra` parts appended, skipping any part the run already
    /// owns: same part id, same call id (a live row and its canonical sibling),
    /// or — for a task — the same child session.
    func appending(_ extra: [OpencodePart]) -> ToolRun {
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
        return ToolRun(id: id, parts: merged)
    }
}

enum ToolLayoutBlock: Equatable, Sendable {
    case part(OpencodePart)
    case tools(ToolRun)
}

struct ToolLayout: Equatable, Sendable {
    /// Blocks each assistant message draws. Absorbed messages map to [].
    var blocksByMessage: [String: [ToolLayoutBlock]]
    /// The run at the very tail while a turn runs (drawn by the working line).
    var trailing: ToolRun?
}

extension ToolActivity {

    /// Parts a message can draw (desktop's `visibleAssistantParts`): synthetic /
    /// ignored / empty text, step markers and todo-list writes are dropped.
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

    /// Whether a user message draws a band (and therefore ends a run).
    static func userMessageDraws(_ msg: OpencodeMessage) -> Bool {
        msg.parts.contains { p in
            p.type == "text" && p.synthetic != true && p.ignored != true && !isBlank(p.text ?? "")
        }
    }

    /// Lay the transcript out as blocks (desktop's `layoutTranscript`).
    ///
    /// - A run is consecutive tool + patch parts; it SPANS assistant messages
    ///   (opencode writes one message per model step) and belongs to the message
    ///   where it starts — later messages it absorbed draw nothing.
    /// - Anything else that draws (text, shown reasoning, media/file, unknown
    ///   parts) ends the run. Hidden reasoning draws nothing, so it is
    ///   transparent.
    /// - A user message that draws ends the run.
    /// - While `running`, a run that nothing follows is withheld as `trailing`.
    static func layout(messages: [OpencodeMessage], running: Bool, showThinking: Bool) -> ToolLayout {
        var blocksByMessage: [String: [ToolLayoutBlock]] = [:]
        // The open run: the message that owns it, its placeholder's index in that
        // message's blocks, and its accumulated value. The placeholder is
        // written back when the run ends.
        var run: (owner: String, index: Int, value: ToolRun)?

        func closeRun() {
            if let r = run {
                blocksByMessage[r.owner]?[r.index] = .tools(r.value)
            }
            run = nil
        }

        for msg in messages {
            if msg.info.role.rawValue == "user" {
                if userMessageDraws(msg) { closeRun() }
                continue
            }
            let id = msg.info.id
            blocksByMessage[id] = blocksByMessage[id] ?? []
            for part in visibleAssistantParts(msg) {
                if part.type == "tool" || part.type == "patch" {
                    if run != nil {
                        run?.value.parts.append(part)
                    } else {
                        let value = ToolRun(id: part.id, parts: [part])
                        blocksByMessage[id, default: []].append(.tools(value))
                        run = (id, blocksByMessage[id, default: []].count - 1, value)
                    }
                    continue
                }
                if part.type == "text", isBlank(part.text ?? "") { continue }
                if part.type == "reasoning" {
                    // Empty reasoning never draws; hidden reasoning is transparent.
                    if !showThinking || isBlank(part.text ?? "") { continue }
                }
                closeRun()
                blocksByMessage[id, default: []].append(.part(part))
            }
        }

        var trailing: ToolRun?
        if running, let r = run {
            trailing = r.value
            blocksByMessage[r.owner]?.remove(at: r.index)
            run = nil
        }
        closeRun()
        return ToolLayout(blocksByMessage: blocksByMessage, trailing: trailing)
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

    init(childRunning: [String: Bool] = [:], jobStatus: [String: String] = [:]) {
        self.childRunning = childRunning
        self.jobStatus = jobStatus
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
    /// consumer (wording, tone, the working line, the sheet) agrees. Non-task
    /// parts, and task parts whose status already matches, come back unchanged.
    static func applying(_ context: TaskStatusContext, to part: OpencodePart) -> OpencodePart {
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
}

extension ToolRun {
    /// The run with its task parts' statuses resolved (spec §5). Returns `self`
    /// untouched when it has no task part, which is the common case.
    func resolvingTasks(_ context: TaskStatusContext) -> ToolRun {
        var changed = false
        let next = parts.map { part -> OpencodePart in
            let updated = TaskStatusResolver.applying(context, to: part)
            if updated != part { changed = true }
            return updated
        }
        return changed ? ToolRun(id: id, parts: next) : self
    }
}

// MARK: - Activity sheet disclosure

enum ActivityDisclosure {
    /// Whether a call row starts expanded. A run with exactly ONE call opens
    /// with that call expanded (desktop's `defaultExpanded`); a failed call
    /// always starts open so its error is visible. The user's own toggle wins.
    static func expanded(callCount: Int, status: ActivityStatus, isTool: Bool, userToggled: Bool?) -> Bool {
        if let userToggled { return userToggled }
        if status == .error { return true }
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
