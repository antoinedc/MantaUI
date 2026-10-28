import Foundation

// ===========================================================================
// `@` typeahead + `/` slash palette + typed-command planning — pure logic
// (BET-749 gap #10, extended by the iOS↔desktop parity WS03).
//
// Everything here is pure and unit-testable — no view, no HTTP.
//
//  * `detectMention` / `applyMentionToken` — mirror the desktop's `useTypeahead`
//    `@`-token detection (anchored at line start or after whitespace, caret
//    inside the token) and substitution; a `@@` token is an AGENT mention.
//    Offsets are UTF-16 code units so they line up with `NSString` ranges and
//    the `Mention.source` start/end the box expects.
//  * `mentionRows` / `agentRows` — the rows of the `@` popup (references and
//    files; agents). Files and references are inserted as plain `@text`; only an
//    agent selection becomes a wire `Mention` (`resolveAgentMentions`).
//  * `slashCommands` / `paletteRows` — the `/` palette: Manta's built-in
//    actions first, then the box's opencode commands and skills.
//  * `splitSlashText` / `planSlashSend` / `backgroundState` — what Send does
//    with a typed `/command args`.
// ===========================================================================

enum ComposerTypeahead {

    // MARK: - @ mention

    enum MentionKind: Equatable, Sendable {
        /// `@token` — a configured reference or a file.
        case file
        /// `@@token` — an agent.
        case agent
    }

    /// An active `@` token in the draft: `start..<end` is the whole token in
    /// UTF-16 code units, `query` is what was typed after the `@` (or `@@`).
    struct MentionAnchor: Equatable {
        let start: Int
        let end: Int
        let query: String
        let kind: MentionKind

        init(start: Int, end: Int, query: String, kind: MentionKind = .file) {
            self.start = start
            self.end = end
            self.query = query
            self.kind = kind
        }
    }

    private static func isSpace(_ ch: unichar) -> Bool {
        ch == 0x20 || ch == 0x0A || ch == 0x09
    }

    /// Detect an active `@` / `@@` token the cursor is inside: the
    /// whitespace-delimited token under the caret must START with `@` (at the
    /// start of the text or after whitespace). `@@` makes it an agent token with
    /// the query after the second `@`.
    static func detectMention(in text: String, caret: Int) -> MentionAnchor? {
        let ns = text as NSString
        guard caret >= 0, caret <= ns.length else { return nil }

        // Walk back to the start of the whitespace-delimited token.
        var start = caret
        while start > 0, !isSpace(ns.character(at: start - 1)) {
            start -= 1
        }
        guard start < caret, ns.character(at: start) == 0x40 else { return nil }  // "@"

        // The token runs forward until whitespace / end of text.
        var end = start + 1
        while end < ns.length, !isSpace(ns.character(at: end)) {
            end += 1
        }
        guard caret <= end else { return nil }

        let isAgent = start + 1 < caret && ns.character(at: start + 1) == 0x40
        let queryStart = isAgent ? start + 2 : start + 1
        let queryEnd = min(end, caret)
        let query = queryEnd > queryStart
            ? ns.substring(with: NSRange(location: queryStart, length: queryEnd - queryStart))
            : ""
        return MentionAnchor(start: start, end: end, query: query, kind: isAgent ? .agent : .file)
    }

    /// Replace the anchor with `token` (the full text including its `@`, e.g.
    /// `"@docs"`) plus one space. Returns the new draft and the UTF-16 caret just
    /// after that space. Records nothing: files and references travel as plain
    /// text; an agent selection is tracked by the caller.
    static func applyMentionToken(_ token: String, to text: String, anchor: MentionAnchor) -> (text: String, caret: Int) {
        let ns = text as NSString
        let start = min(max(anchor.start, 0), ns.length)
        let end = min(max(anchor.end, start), ns.length)
        let inserted = token + " "
        let newText = ns.replacingCharacters(in: NSRange(location: start, length: end - start), with: inserted)
        return (newText, start + (inserted as NSString).length)
    }

    private static func isWordChar(_ ch: unichar?) -> Bool {
        guard let ch else { return false }
        return (ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x5A) || (ch >= 0x61 && ch <= 0x7A) || ch == 0x5F
    }

    /// Resolve the chosen agent names against the text ACTUALLY being sent (port
    /// of the desktop's `resolveAgentMentions`). Offsets are recomputed here —
    /// never trusted from insertion time — by finding the first `@name` on word
    /// boundaries (so `@build` is not found inside `@builder`). A name whose token
    /// is gone from the text is dropped. A name chosen twice yields one mention.
    static func resolveAgentMentions(text: String, names: [String]) -> [SendPromptInput.Mention] {
        let ns = text as NSString
        var seen = Set<String>()
        var resolved: [SendPromptInput.Mention] = []
        for name in names where !name.isEmpty && seen.insert(name).inserted {
            let token = "@" + name
            let tokenLength = (token as NSString).length
            var pos = 0
            while pos < ns.length {
                let found = ns.range(of: token, options: [.literal], range: NSRange(location: pos, length: ns.length - pos))
                if found.location == NSNotFound { break }
                let prev: unichar? = found.location > 0 ? ns.character(at: found.location - 1) : nil
                let nextIndex = found.location + tokenLength
                let next: unichar? = nextIndex < ns.length ? ns.character(at: nextIndex) : nil
                if !isWordChar(prev) && !isWordChar(next) {
                    resolved.append(SendPromptInput.Mention(
                        name: name,
                        source: SendPromptInput.MentionSource(value: token, start: found.location, end: nextIndex)
                    ))
                    break
                }
                pos = nextIndex
            }
        }
        return resolved
    }

    private static func contains(_ haystack: String, _ query: String) -> Bool {
        query.isEmpty || haystack.lowercased().contains(query.lowercased())
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    /// The `@` popup's selectable rows: non-hidden references whose name contains
    /// the query (case-insensitive) first, then the matching files; capped at `limit`.
    static func mentionRows(
        query: String,
        references: [OpencodeReferenceInfo],
        files: [String],
        limit: Int = 20
    ) -> [MentionRow] {
        var rows: [MentionRow] = []
        for reference in references where reference.hidden != true && contains(reference.name, query) {
            let icon: String
            if nonEmpty(reference.repository) != nil {
                icon = "link"
            } else if nonEmpty(reference.path) != nil {
                icon = "folder"
            } else {
                icon = "at"
            }
            rows.append(MentionRow(
                id: "reference:\(reference.name)",
                kind: .reference,
                insertText: reference.name,
                title: "@\(reference.name)",
                subtitle: nonEmpty(reference.description) ?? nonEmpty(reference.repository) ?? nonEmpty(reference.path) ?? "",
                systemImage: icon
            ))
        }
        for file in files {
            rows.append(MentionRow(
                id: "file:\(file)",
                kind: .file,
                insertText: file,
                title: "@\(file)",
                subtitle: "",
                systemImage: "doc"
            ))
        }
        return Array(rows.prefix(limit))
    }

    /// The single status line of the file/reference popup when it has no rows.
    static func fileStatusRow(searching: Bool) -> MentionRow {
        MentionRow(
            id: searching ? "status:searching" : "status:no-files",
            kind: .status(tappable: false),
            insertText: "",
            title: searching ? "Searching…" : "No matching files",
            subtitle: "",
            systemImage: "magnifyingglass"
        )
    }

    /// The `@@` popup's rows. `agents == nil` means "not loaded": a load error
    /// gives a tappable retry line, otherwise a loading line. A loaded catalog
    /// yields the agents whose name contains the query (capped at `limit`), or
    /// "No matching agents".
    static func agentRows(
        agents: [OpencodeAgent]?,
        loadError: String?,
        query: String,
        limit: Int = 12
    ) -> [MentionRow] {
        guard let agents else {
            if loadError != nil {
                return [MentionRow(
                    id: "status:agents-retry",
                    kind: .status(tappable: true),
                    insertText: "",
                    title: "Couldn't load agents — tap to retry",
                    subtitle: "",
                    systemImage: "arrow.clockwise"
                )]
            }
            return [MentionRow(
                id: "status:agents-loading",
                kind: .status(tappable: false),
                insertText: "",
                title: "Loading agents…",
                subtitle: "",
                systemImage: "person.crop.circle"
            )]
        }
        let rows = agents
            .filter { contains($0.name, query) }
            .prefix(limit)
            .map { agent in
                MentionRow(
                    id: "agent:\(agent.name)",
                    kind: .agent,
                    insertText: agent.name,
                    title: "@\(agent.name)",
                    subtitle: agent.description ?? "",
                    systemImage: "person.crop.circle"
                )
            }
        if rows.isEmpty {
            return [MentionRow(
                id: "status:agents-none",
                kind: .status(tappable: false),
                insertText: "",
                title: "No matching agents",
                subtitle: "",
                systemImage: "person.crop.circle"
            )]
        }
        return Array(rows)
    }

    // MARK: - / slash palette

    enum SlashAction: Equatable {
        case submit
        case compact
        case clear
        case fork
        case handoff
        case abort
        /// An opencode command or skill: choosing it INSERTS `/name ` — nothing runs.
        case insert(name: String)
    }

    struct SlashCommand: Identifiable, Equatable {
        let id: String
        let title: String
        let subtitle: String
        let kind: SlashAction
        let isSkill: Bool

        init(id: String, title: String, subtitle: String, kind: SlashAction, isSkill: Bool = false) {
            self.id = id
            self.title = title
            self.subtitle = subtitle
            self.kind = kind
            self.isSkill = isSkill
        }
    }

    /// Manta's own palette entries. A remote command with one of these names is
    /// hidden, so a name never appears twice.
    static let builtinIDs: Set<String> = ["submit", "compact", "clear", "fork", "handoff", "abort"]

    /// An active `/` palette anchor: only the LEADING line of the composer
    /// triggers it (mirrors the desktop, whose command typeahead fires when
    /// "/" is the very first character), and only while the caret is inside
    /// that first word.
    struct SlashAnchor: Equatable {
        let query: String
    }

    static func detectSlash(in text: String, caret: Int) -> SlashAnchor? {
        let ns = text as NSString
        guard ns.length > 0, ns.character(at: 0) == 0x2F else { return nil }  // "/"
        var end = 0
        while end < ns.length {
            let ch = ns.character(at: end)
            if ch == 0x20 || ch == 0x0A || ch == 0x09 { break }
            end += 1
        }
        guard caret <= end else { return nil }
        let queryLen = min(end, caret) - 1
        let query = queryLen > 0 ? ns.substring(with: NSRange(location: 1, length: queryLen)) : ""
        return SlashAnchor(query: query)
    }

    /// The actions the composer/store already implement and the overflow sheet.
    /// Abort appears only while a turn is running (that is the only time it is
    /// meaningful).
    static func slashCommands(running: Bool) -> [SlashCommand] {
        var commands = [
            SlashCommand(id: "submit", title: "Submit", subtitle: "Send this message", kind: .submit),
            SlashCommand(id: "compact", title: "Compact", subtitle: "Summarise the conversation to free context", kind: .compact),
            SlashCommand(id: "clear", title: "Clear", subtitle: "Start a fresh session in this window", kind: .clear),
            SlashCommand(id: "fork", title: "Fork", subtitle: "Fork this session into a new window", kind: .fork),
            SlashCommand(id: "handoff", title: "Handoff", subtitle: "Write a handoff prompt for a fresh session", kind: .handoff),
        ]
        if running {
            commands.append(SlashCommand(id: "abort", title: "Abort", subtitle: "Stop the running turn", kind: .abort))
        }
        return commands
    }

    /// The optional goal typed after a leading slash command: `/handoff fix the
    /// flaky test` → "fix the flaky test". nil when nothing follows the first
    /// word. The palette closes once the caret leaves that first word, so this
    /// is what lets a goal reach `handoff:create` at all.
    static func goalAfterCommand(in text: String) -> String? {
        guard text.hasPrefix("/") else { return nil }
        guard let space = text.firstIndex(where: { $0 == " " || $0 == "\n" || $0 == "\t" }) else { return nil }
        let rest = text[text.index(after: space)...].trimmingCharacters(in: .whitespacesAndNewlines)
        return rest.isEmpty ? nil : rest
    }

    /// True when `text` is the typed `/handoff` command (alone or followed by a
    /// goal), so a Send of it runs the handoff instead of posting it as a prompt.
    static func isHandoffCommand(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else { return false }
        let first = trimmed.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" }).first ?? ""
        return first.lowercased() == "/handoff"
    }

    /// Keep only commands whose token/title match what was typed after `/`.
    static func filterSlashCommands(_ commands: [SlashCommand], query: String) -> [SlashCommand] {
        guard !query.isEmpty else { return commands }
        let q = query.lowercased()
        return commands.filter { $0.id.lowercased().contains(q) || $0.title.lowercased().contains(q) }
    }

    /// The palette's rows: the filtered built-ins first, then the box's opencode
    /// commands and skills (minus the built-in names) whose name contains the
    /// query, capped at `limit`.
    static func paletteRows(
        builtins: [SlashCommand],
        remote: [OpencodeCommandInfo],
        query: String,
        limit: Int = 12
    ) -> [SlashCommand] {
        var rows = filterSlashCommands(builtins, query: query)
        for command in remote where !builtinIDs.contains(command.name) && contains(command.name, query) {
            rows.append(SlashCommand(
                id: command.name,
                title: command.name,
                subtitle: command.description ?? "",
                kind: .insert(name: command.name),
                isSkill: command.isSkill
            ))
        }
        return Array(rows.prefix(limit))
    }

    /// The draft after choosing a remote command: its leading `/token` becomes
    /// `/name`, followed by a single space when nothing followed the token.
    /// `"/re"` → `"/review "`, `"/re some args"` → `"/review some args"`.
    static func applySlashInsertion(name: String, to text: String) -> String {
        let head = "/" + name
        guard let whitespace = text.firstIndex(where: { $0 == " " || $0 == "\n" || $0 == "\t" }) else {
            return head + " "
        }
        return head + String(text[whitespace...])
    }

    // MARK: - Typed `/command args`

    /// `/name args` → (`name`, `args`), or nil when the text isn't a slash
    /// command. Port of the desktop's `^/(\S+)(?:\s+([\s\S]*))?$`.
    static func splitSlashText(_ text: String) -> (name: String, args: String)? {
        guard text.hasPrefix("/") else { return nil }
        let body = text.dropFirst()
        guard let boundary = body.firstIndex(where: { $0.isWhitespace }) else {
            return body.isEmpty ? nil : (String(body), "")
        }
        let name = String(body[body.startIndex..<boundary])
        guard !name.isEmpty else { return nil }
        let args = body[boundary...].drop(while: { $0.isWhitespace })
        return (name, String(args))
    }

    /// What Send does with a draft that starts with `/`.
    enum SlashSendPlan: Equatable {
        /// An ordinary message (not a known command).
        case prompt
        /// A Manta built-in run locally (`.compact` / `.clear` / `.fork`).
        case builtin(SlashAction)
        /// Refused with this message; the draft is untouched.
        case refuse(String)
        /// An opencode command or skill.
        case command(name: String, args: String, alwaysBackground: Bool)
    }

    /// `remote == nil` means the command list is unknown (still loading or
    /// failed): only the built-ins are recognised and everything else is a
    /// message — the same answer the desktop gives before its list arrives.
    static func planSlashSend(text: String, running: Bool, remote: [OpencodeCommandInfo]?) -> SlashSendPlan {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = splitSlashText(trimmed) else { return .prompt }
        let builtin: SlashAction?
        switch parts.name.lowercased() {
        case "compact": builtin = .compact
        case "clear": builtin = .clear
        case "fork": builtin = .fork
        default: builtin = nil
        }
        if let builtin {
            if running {
                return .refuse("Stop the agent or wait for it to finish before /\(parts.name.lowercased())")
            }
            return .builtin(builtin)
        }
        guard let remote, let info = remote.first(where: { $0.name == parts.name }) else { return .prompt }
        return .command(name: info.name, args: parts.args, alwaysBackground: info.background == true)
    }

    /// The "Run in background" toggle for a draft: present only when the first
    /// token is a known opencode command/skill (never a built-in).
    static func backgroundState(text: String, remote: [OpencodeCommandInfo]?) -> BackgroundToggleState? {
        guard let remote else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = splitSlashText(trimmed),
              !builtinIDs.contains(parts.name.lowercased()),
              let info = remote.first(where: { $0.name == parts.name }) else { return nil }
        return BackgroundToggleState(name: info.name, locked: info.background == true)
    }
}
