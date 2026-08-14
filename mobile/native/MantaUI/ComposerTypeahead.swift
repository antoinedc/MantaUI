import Foundation

// ===========================================================================
// @-file typeahead + / slash palette — pure logic (BET-749 gap #10).
//
// The native composer has no server-side command registry and its file
// mentions already serialize onto sends via the `Mention` DTO, so all the
// custom logic here is pure and unit-testable — no view, no HTTP.
//
//  * `detectMention` / `applyMention` — mirror the desktop's `useTypeahead`
//    @-token detection (anchored at line start or after whitespace, caret
//    inside the token) and substitution. Offsets are UTF-16 code units so they
//    line up with `NSString` ranges and the `Mention.source` start/end the
//    box expects.
//  * `slashCommands` / `filterSlashCommands` — the compact `/` palette, listing
//    exactly the actions the composer/store already implement and the overflow
//    sheet. Nothing new is invented here; a typed token that matches nothing is
//    honestly absent from the palette.
// ===========================================================================

enum ComposerTypeahead {

    // MARK: - @-file mention

    /// An active `@` token in the draft: `start..<end` is the whole token in
    /// UTF-16 code units, `query` is what was typed after the `@`.
    struct MentionAnchor: Equatable {
        let start: Int
        let end: Int
        let query: String
    }

    /// The outcome of selecting a file: the rewritten draft plus the `Mention`
    /// that must serialize onto the next send.
    struct MentionInsertion: Equatable {
        let newText: String
        let mention: SendPromptInput.Mention
    }

    /// Detect an active `@`-file token the cursor is inside. Mirrors the
    /// desktop: `@` at the start of the line or after whitespace, with the
    /// caret inside the token that follows it.
    static func detectMention(in text: String, caret: Int) -> MentionAnchor? {
        let ns = text as NSString
        guard caret >= 0, caret <= ns.length else { return nil }

        // Walk backwards from the caret to find the `@` that owns the token.
        var atIndex: Int?
        var i = caret - 1
        while i >= 0 {
            let ch = ns.character(at: i)
            if ch == 0x40 { atIndex = i; break }                 // "@"
            if ch == 0x20 || ch == 0x0A || ch == 0x09 { break }  // space / newline / tab
            i -= 1
        }
        guard let at = atIndex else { return nil }

        // The `@` must sit after whitespace (or at the very start).
        if at > 0 {
            let prev = ns.character(at: at - 1)
            if !(prev == 0x20 || prev == 0x0A || prev == 0x09) { return nil }
        }

        // The token runs forward until whitespace / end of text.
        var end = at + 1
        while end < ns.length {
            let ch = ns.character(at: end)
            if ch == 0x20 || ch == 0x0A || ch == 0x09 { break }
            end += 1
        }
        // The caret must still be inside the token (not past its end).
        guard caret <= end else { return nil }

        let query = ns.substring(with: NSRange(location: at + 1, length: min(end, caret) - (at + 1)))
        return MentionAnchor(start: at, end: end, query: query)
    }

    /// Substitute a chosen file into the draft at the anchor and build the
    /// `Mention` whose `source` references the substituted `@<file>` range.
    static func applyMention(_ file: String, to text: String, anchor: MentionAnchor) -> MentionInsertion {
        let token = "@" + file
        let ns = text as NSString
        let newText = ns.replacingCharacters(
            in: NSRange(location: anchor.start, length: anchor.end - anchor.start),
            with: token + " "
        )
        let mention = SendPromptInput.Mention(
            name: file,
            source: SendPromptInput.MentionSource(
                value: token,
                start: anchor.start,
                end: anchor.start + (token as NSString).length
            )
        )
        return MentionInsertion(newText: newText, mention: mention)
    }

    // MARK: - / slash palette

    enum SlashAction: Equatable {
        case submit
        case compact
        case clear
        case fork
        case abort
    }

    struct SlashCommand: Identifiable, Equatable {
        let id: String
        let title: String
        let subtitle: String
        let kind: SlashAction
    }

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

    /// The actions the composer/store already implement and the overflow sheet,
    /// nothing more. Abort appears only while a turn is running (that is the
    /// only time it is meaningful).
    static func slashCommands(running: Bool) -> [SlashCommand] {
        var commands = [
            SlashCommand(id: "submit", title: "Submit", subtitle: "Send this message", kind: .submit),
            SlashCommand(id: "compact", title: "Compact", subtitle: "Summarise the conversation to free context", kind: .compact),
            SlashCommand(id: "clear", title: "Clear", subtitle: "Start a fresh session in this window", kind: .clear),
            SlashCommand(id: "fork", title: "Fork", subtitle: "Fork this session into a new window", kind: .fork),
        ]
        if running {
            commands.append(SlashCommand(id: "abort", title: "Abort", subtitle: "Stop the running turn", kind: .abort))
        }
        return commands
    }

    /// Keep only commands whose token/title match what was typed after `/`. A
    /// typed token that matches nothing yields an empty list — the box has no
    /// further commands to offer honestly (nothing is fabricated here).
    static func filterSlashCommands(_ commands: [SlashCommand], query: String) -> [SlashCommand] {
        guard !query.isEmpty else { return commands }
        let q = query.lowercased()
        return commands.filter { $0.id.lowercased().contains(q) || $0.title.lowercased().contains(q) }
    }
}
