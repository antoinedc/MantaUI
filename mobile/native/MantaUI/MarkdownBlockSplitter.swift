import Foundation

// ===========================================================================
// MARK: - Transcript block splitter (block-level quoting)
//
// The MarkdownView library renders block quotes, fenced code blocks and GFM
// tables as EMBEDDED SwiftUI views — to the underlying text system each is ONE
// opaque character, so the user can never select (and therefore quote) text
// inside them the way they can a paragraph. That is by design in the library
// and no configuration changes it.
//
// To give those atomic blocks their own long-press menu, `MantaProse` splits
// each assistant message into top-level blocks and renders each in a container
// it owns. This file is the PURE splitter: given the raw markdown source it
// returns an ordered list of blocks, each carrying its EXACT source substring
// (never re-serialized) so concatenating every block's source reconstructs the
// input exactly (asserted in the unit tests).
//
// LIMITATION (deliberate): indented (4-space) code blocks are treated as
// `.prose`, not atomic. Detecting them reliably requires paragraph-continuation
// state (blank-line tracking) that a line-classifier would have to thread
// through every branch; the normal transcript never emits them, and folding
// them into prose keeps them selectable, which is the safer fallback.
// ===========================================================================

/// The atomic (non-selectable) block kinds. Each renders as ONE opaque
/// character inside the library's text view, so `MantaProse` wraps them in a
/// container it owns to give them a context menu.
enum MarkdownBlockKind: Equatable {
    case blockQuote
    case codeBlock
    case table
}

/// One top-level block of an assistant message's markdown.
struct MarkdownProseBlock: Equatable {
    enum Kind: Equatable {
        /// Ordinary runnable prose (paragraphs, headings, lists, thematic
        /// breaks, images, HTML, indented code). Consecutive prose blocks are
        /// always coalesced into a single run so normal text reads and renders
        /// as one continuous passage.
        case prose
        /// An atomic block that gets its own long-press menu.
        case atomic(MarkdownBlockKind)
    }

    let kind: Kind
    /// The EXACT source substring this block covers, straight from the original
    /// string. Blocks are never re-serialized; concatenating every block's
    /// source in order reconstructs the input exactly.
    let source: String
}

/// Pure, dependency-free markdown block splitter.
enum MarkdownBlockSplitter {
    private enum Label: Equatable {
        case prose
        case quote
        case code
        case table
    }

    /// Split an assistant message's markdown source into top-level blocks.
    static func split(_ markdown: String) -> [MarkdownProseBlock] {
        guard !markdown.isEmpty else { return [] }

        let lines = splitIntoLines(markdown)
        let labels = classify(lines)

        var blocks: [MarkdownProseBlock] = []
        var i = 0
        while i < lines.count {
            let start = i
            let label = labels[i]
            // Consecutive equal labels coalesce into ONE block: prose runs stay
            // one continuous run; a run of quote lines is one quote block, etc.
            while i < lines.count && labels[i] == label { i += 1 }
            blocks.append(MarkdownProseBlock(kind: kind(for: label), source: lines[start..<i].joined()))
        }
        return blocks
    }

    // MARK: - Line splitting (exact round-trip)

    /// Split `text` into lines, each INCLUDING its trailing newline, so the
    /// concatenation of every element reconstructs `text` exactly. Line
    /// boundaries are detected on `\n` only, so a CRLF line splits with its
    /// `\r` still on the line (before its `\n`) and survives verbatim.
    private static func splitIntoLines(_ text: String) -> [String] {
        var result: [String] = []
        var runStart = text.startIndex
        var i = text.startIndex
        while i < text.endIndex {
            if text[i] == "\n" {
                let after = text.index(after: i)
                result.append(String(text[runStart..<after]))
                runStart = after
                i = after
            } else {
                i = text.index(after: i)
            }
        }
        if runStart < text.endIndex {
            result.append(String(text[runStart..<text.endIndex]))
        }
        return result
    }

    private static func kind(for label: Label) -> MarkdownProseBlock.Kind {
        switch label {
        case .prose: return .prose
        case .quote: return .atomic(.blockQuote)
        case .code: return .atomic(.codeBlock)
        case .table: return .atomic(.table)
        }
    }

    // MARK: - Classification

    /// Classify every line. Fence state WINS: a `>` or `|` line inside an open
    /// fenced code block is CODE, never a quote or a table.
    private static func classify(_ lines: [String]) -> [Label] {
        var labels = Array(repeating: Label.prose, count: lines.count)
        var i = 0
        while i < lines.count {
            let content = lineContent(lines[i])

            // Opening code fence (``` or ~~~).
            if let open = openingFence(content) {
                labels[i] = .code
                var j = i + 1
                while j < lines.count {
                    labels[j] = .code
                    // A fence closes only on a matching-or-longer fence of the
                    // SAME character; if never closed the block runs to the end.
                    if isClosingFence(lineContent(lines[j]), char: open.char, len: open.len) {
                        j += 1
                        break
                    }
                    j += 1
                }
                i = j
                continue
            }

            // Block quote: up to 3 leading spaces then `>`.
            if isQuoteLine(content) {
                labels[i] = .quote
                i += 1
                continue
            }

            // GFM table: a header line containing `|` immediately followed by a
            // delimiter row; body rows are subsequent lines containing `|`.
            if i + 1 < lines.count, isTableHeader(content),
               isTableDelimiter(lineContent(lines[i + 1])) {
                labels[i] = .table
                labels[i + 1] = .table
                var j = i + 2
                while j < lines.count, isTableBody(lineContent(lines[j])) {
                    labels[j] = .table
                    j += 1
                }
                i = j
                continue
            }

            labels[i] = .prose
            i += 1
        }
        return labels
    }

    /// A line's content without its trailing newline (or `\r`).
    private static func lineContent(_ line: String) -> String {
        var s = line
        while s.last == "\n" || s.last == "\r" { s.removeLast() }
        return s
    }

    /// Info for an opening code fence, or nil. Up to 3 leading spaces then a
    /// run of >= 3 backticks or tildes. An info string (anything after the
    /// fence run) is allowed on the opening line.
    private static func openingFence(_ content: String) -> (char: Character, len: Int)? {
        let chars = Array(content)
        var i = 0
        while i < chars.count && chars[i] == " " { i += 1 }
        if i > 3 { return nil }
        guard i < chars.count, chars[i] == "`" || chars[i] == "~" else { return nil }
        let ch = chars[i]
        var len = 0
        while i < chars.count && chars[i] == ch { len += 1; i += 1 }
        guard len >= 3 else { return nil }
        return (ch, len)
    }

    /// True when `content` closes an open fence: up to 3 leading spaces, a run
    /// of the SAME fence character with length >= the opening length, then only
    /// whitespace.
    private static func isClosingFence(_ content: String, char: Character, len: Int) -> Bool {
        let chars = Array(content)
        var i = 0
        while i < chars.count && chars[i] == " " { i += 1 }
        if i > 3 { return false }
        guard i < chars.count && chars[i] == char else { return false }
        var run = 0
        while i < chars.count && chars[i] == char { run += 1; i += 1 }
        guard run >= len else { return false }
        while i < chars.count {
            if !chars[i].isWhitespace { return false }
            i += 1
        }
        return true
    }

    /// A block quote line: up to 3 leading spaces then `>`.
    private static func isQuoteLine(_ content: String) -> Bool {
        let chars = Array(content)
        var i = 0
        while i < chars.count && chars[i] == " " { i += 1 }
        return i <= 3 && i < chars.count && chars[i] == ">"
    }

    /// Potential GFM table header: the trimmed line contains a pipe. It only
    /// becomes a table when the FOLLOWING line is a delimiter (checked by the
    /// caller), so a lone `|` paragraph stays prose.
    private static func isTableHeader(_ content: String) -> Bool {
        content.contains("|")
    }

    /// A GFM delimiter row: the trimmed line contains a pipe and every
    /// pipe-separated cell is empty or `-` with optional leading/trailing `:`.
    private static func isTableDelimiter(_ content: String) -> Bool {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.contains("|") else { return false }
        let cells = trimmed.split(separator: "|", omittingEmptySubsequences: false)
        for cell in cells {
            let c = cell.trimmingCharacters(in: .whitespaces)
            if c.isEmpty { continue }
            var sawDash = false
            for ch in c {
                if ch == "-" { sawDash = true; continue }
                if ch == ":" { continue }
                return false
            }
            if !sawDash { return false }
        }
        return true
    }

    /// A GFM table body row: the trimmed line contains a pipe. A blank line
    /// (no pipe) ends the table.
    private static func isTableBody(_ content: String) -> Bool {
        content.trimmingCharacters(in: .whitespacesAndNewlines).contains("|")
    }
}
