import Foundation

// ===========================================================================
// Transcript autolinking — the iOS half of the desktop's linkify
// (docs/superpowers/specs/2026-10-29-transcript-autolink.md, src/renderer/linkify.ts).
//
// What counts as a link: `http://`, `https://` and `mailto:` — nothing else. No
// schemeless hosts (`install.sh`, `main.py`, `mantaui.com`), no `www.`, no bare
// e-mail addresses, no other schemes. Why not Foundation's `NSDataDetector`: it
// links exactly those schemeless names (every file extension that is also a TLD),
// and what it does with `http://localhost:<port>` or a trailing `)` cannot be
// pinned down without running it — and this code is compiled on a box that has no
// Swift toolchain. A small scanner with the desktop's rules is deterministic.
//
// Rules (the desktop's, minus its schemeless/www half):
//  - the URL ends at whitespace, a control character, `<` `>` `"` `` ` `` `{` `$` `\`
//    or non-ASCII punctuation;
//  - a URL that stops at `<` `{` or `$` is a template placeholder, not a link
//    (`http://localhost:<port>`, `http://localhost:$PORT/x`), and the host must
//    start with a letter or digit (`https://{host}/x` is not one);
//  - trailing `. , ; : ! ? ' * ^ |` is not part of the URL, nor is a closing `)` or
//    `]` that has no opener inside it (`(see https://a.com/x)`, but
//    `https://a.com/a_(b)` keeps its parentheses);
//  - a URL directly after a letter, a digit or one of `. : / - _ @ \` is part of
//    something else (a path, an identifier, an address) and is not linked.
// ===========================================================================

struct TranscriptLink: Equatable, Sendable {
    let range: Range<String.Index>
    /// The URL as written in the text.
    let text: String
    let url: URL
}

enum TranscriptLinkify {

    /// Cheap guard: no `://` and no `mailto:` means no link, without a scan.
    static func mayContainLink(_ text: String) -> Bool {
        text.range(of: "://") != nil || text.range(of: "mailto:", options: .caseInsensitive) != nil
    }

    static func findLinks(in text: String) -> [TranscriptLink] {
        guard mayContainLink(text) else { return [] }
        let chars = Array(text)
        var indices = Array(text.indices)
        indices.append(text.endIndex)
        var out: [TranscriptLink] = []
        var i = 0
        while i < chars.count {
            if let end = URLScan.match(chars, at: i), let url = URL(string: String(chars[i..<end])) {
                let range = indices[i]..<indices[end]
                out.append(TranscriptLink(range: range, text: String(text[range]), url: url))
                i = max(end, i + 1)
            } else {
                i += 1
            }
        }
        return out
    }
}

// MARK: - The scanner

private enum URLScan {
    private static let trailing: Set<Character> = [".", ",", ";", ":", "!", "?", "'", "*", "^", "|"]
    private static let openerOf: [Character: Character] = [")": "(", "]": "["]

    /// If an `http(s)://` or `mailto:` URL starts at `i`, the (exclusive) index
    /// where it ends once trailing punctuation is dropped.
    static func match(_ c: [Character], at i: Int) -> Int? {
        guard let first = c[i].asciiValue, first | 0x20 == UInt8(ascii: "h") || first | 0x20 == UInt8(ascii: "m") else { return nil }
        if i > 0 {
            let previous = c[i - 1]
            if previous.isLetter || previous.isNumber || ".:/-_@\\".contains(previous) { return nil }
        }
        if let length = prefixLength(c, i, ["https://", "http://"]) { return http(c, i, schemeLength: length) }
        if let length = prefixLength(c, i, ["mailto:"]) { return mailto(c, i, schemeLength: length) }
        return nil
    }

    private static func prefixLength(_ c: [Character], _ i: Int, _ options: [String]) -> Int? {
        for option in options {
            let expected = Array(option)
            guard i + expected.count <= c.count else { continue }
            var matches = true
            for (offset, character) in expected.enumerated() where c[i + offset].lowercased() != String(character) {
                matches = false
                break
            }
            if matches { return expected.count }
        }
        return nil
    }

    private static func http(_ c: [Character], _ i: Int, schemeLength: Int) -> Int? {
        let hostStart = i + schemeLength
        guard hostStart < c.count, c[hostStart].isLetter || c[hostStart].isNumber else { return nil }
        var k = hostStart
        while k < c.count, !isStop(c[k]) { k += 1 }
        if k < c.count, "<{$".contains(c[k]) { return nil }
        var end = k
        while end > hostStart {
            let last = c[end - 1]
            if trailing.contains(last) {
                end -= 1
                continue
            }
            if let opener = openerOf[last] {
                let slice = c[i..<end]
                if slice.filter({ $0 == last }).count > slice.filter({ $0 == opener }).count {
                    end -= 1
                    continue
                }
            }
            break
        }
        return end
    }

    private static func mailto(_ c: [Character], _ i: Int, schemeLength: Int) -> Int? {
        func isLocal(_ ch: Character) -> Bool { ch.isASCII && (ch.isLetter || ch.isNumber || "._%+-".contains(ch)) }
        func isDomain(_ ch: Character) -> Bool { ch.isASCII && (ch.isLetter || ch.isNumber || ch == "." || ch == "-") }
        var k = i + schemeLength
        let localStart = k
        while k < c.count, isLocal(c[k]) { k += 1 }
        guard k > localStart, k < c.count, c[k] == "@" else { return nil }
        k += 1
        let domainStart = k
        while k < c.count, isDomain(c[k]) { k += 1 }
        var end = k
        while end > domainStart, c[end - 1] == "." || c[end - 1] == "-" { end -= 1 }
        guard end > domainStart, c[domainStart..<end].contains(".") else { return nil }
        return end
    }

    private static func isStop(_ ch: Character) -> Bool {
        if ch.isWhitespace || ch.isNewline { return true }
        if let ascii = ch.asciiValue {
            return ascii < 0x20 || ascii == 0x7F || "<>\"`{$\\".contains(ch)
        }
        return ch.isPunctuation
    }
}

// MARK: - Markdown source

/// The assistant's markdown with every http(s)/mailto URL that is not already a
/// link made one — because the markdown renderer (swift-markdown, no GFM
/// autolink extension) shows a bare URL as plain text, and an inline-code span as
/// a code chip whatever it holds.
///
///  - a bare URL in prose becomes `<url>` (a CommonMark autolink; trailing
///    punctuation stays outside it);
///  - a URL inside an inline-code span becomes a link whose label is code
///    (`` `curl https://x.com -o f` `` → code `curl `, then the URL as a linked code
///    chip, then code ` -o f`): only the URL is a link, the span keeps its look.
///
/// Left alone: fenced code blocks, text already in `[label](dest)` (label and
/// destination), `<autolinks>` and raw HTML, reference definitions, and a code span
/// that is itself a link label. Indented code blocks are NOT recognised (they are
/// indistinguishable from list continuation here); a backtick span inside one that
/// holds a URL would be rewritten — AI output does not use them.
enum TranscriptMarkdownLinks {

    static func autolinked(_ markdown: String) -> String {
        guard TranscriptLinkify.mayContainLink(markdown) else { return markdown }
        var fence: (marker: Character, length: Int)?
        var out: [String] = []
        for part in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(part)
            if let open = fence {
                if closesFence(line, open) { fence = nil }
                out.append(line)
            } else if let opened = opensFence(line) {
                fence = opened
                out.append(line)
            } else if isDefinitionOrHTML(line) {
                out.append(line)
            } else {
                out.append(rewrite(line))
            }
        }
        return out.joined(separator: "\n")
    }

    // MARK: Lines

    private static func indent(_ line: String) -> Int {
        var n = 0
        for ch in line {
            if ch == " " { n += 1 } else { break }
        }
        return n
    }

    private static func opensFence(_ line: String) -> (marker: Character, length: Int)? {
        let spaces = indent(line)
        guard spaces <= 3 else { return nil }
        let rest = Array(line.dropFirst(spaces))
        guard let marker = rest.first, marker == "`" || marker == "~" else { return nil }
        let run = rest.prefix(while: { $0 == marker }).count
        guard run >= 3 else { return nil }
        if marker == "`", rest.dropFirst(run).contains("`") { return nil }
        return (marker, run)
    }

    private static func closesFence(_ line: String, _ open: (marker: Character, length: Int)) -> Bool {
        let spaces = indent(line)
        guard spaces <= 3 else { return false }
        let rest = Array(line.dropFirst(spaces))
        let run = rest.prefix(while: { $0 == open.marker }).count
        guard run >= open.length else { return false }
        return rest.dropFirst(run).allSatisfy { $0 == " " || $0 == "\t" }
    }

    private static func isDefinitionOrHTML(_ line: String) -> Bool {
        let spaces = indent(line)
        guard spaces <= 3 else { return false }
        let rest = line.dropFirst(spaces)
        if rest.hasPrefix("["), rest.contains("]:") { return true }
        guard rest.hasPrefix("<"), let second = rest.dropFirst().first else { return false }
        let afterBracket = rest.dropFirst().lowercased()
        if afterBracket.hasPrefix("http://") || afterBracket.hasPrefix("https://") || afterBracket.hasPrefix("mailto:") { return false }
        return second.isLetter || second == "/" || second == "!" || second == "?"
    }

    // MARK: One line

    private static func rewrite(_ line: String) -> String {
        let c = Array(line)
        var out = ""
        var i = 0
        var labelDepth = 0
        while i < c.count {
            let ch = c[i]
            switch ch {
            case "\\":
                out.append(ch)
                if i + 1 < c.count { out.append(c[i + 1]) }
                i += 2
            case "`":
                i = codeSpan(c, at: i, insideLabel: labelDepth > 0, into: &out)
            case "[":
                labelDepth += 1
                out.append(ch)
                i += 1
            case "]":
                labelDepth = max(0, labelDepth - 1)
                out.append(ch)
                i += 1
                if i < c.count, c[i] == "(" { i = destination(c, at: i, into: &out) }
            case "<":
                if let close = c[i...].firstIndex(of: ">") {
                    out += String(c[i...close])
                    i = close + 1
                } else {
                    out.append(ch)
                    i += 1
                }
            default:
                if labelDepth == 0, let end = URLScan.match(c, at: i), URL(string: String(c[i..<end])) != nil {
                    out += "<" + String(c[i..<end]) + ">"
                    i = end
                } else {
                    out.append(ch)
                    i += 1
                }
            }
        }
        return out
    }

    /// `(…)` after a link label: copied whole, never rewritten. Returns the index after it.
    private static func destination(_ c: [Character], at i: Int, into out: inout String) -> Int {
        var depth = 0
        var j = i
        while j < c.count {
            if c[j] == "(" {
                depth += 1
            } else if c[j] == ")" {
                depth -= 1
                if depth == 0 {
                    out += String(c[i...j])
                    return j + 1
                }
            }
            j += 1
        }
        out.append("(")
        return i + 1
    }

    /// A backtick run at `i`. Returns the index after the span (or after a literal run
    /// that never closes on this line).
    private static func codeSpan(_ c: [Character], at i: Int, insideLabel: Bool, into out: inout String) -> Int {
        var runEnd = i
        while runEnd < c.count, c[runEnd] == "`" { runEnd += 1 }
        let fence = runEnd - i
        var close: (start: Int, end: Int)?
        var j = runEnd
        while j < c.count {
            if c[j] == "`" {
                var e = j
                while e < c.count, c[e] == "`" { e += 1 }
                if e - j == fence {
                    close = (j, e)
                    break
                }
                j = e
            } else {
                j += 1
            }
        }
        guard let close else {
            out += String(c[i..<runEnd])
            return runEnd
        }
        let original = String(c[i..<close.end])
        if insideLabel {
            out += original
        } else {
            out += linkedSpan(content: String(c[runEnd..<close.start]), fence: fence) ?? original
        }
        return close.end
    }

    /// The span rewritten so its URLs are links, or nil when it holds none.
    static func linkedSpan(content: String, fence: Int) -> String? {
        var code = content
        // CommonMark: one space at each end is padding when both are present and the span is not only spaces.
        if code.count >= 2, code.first == " ", code.last == " ", code.contains(where: { $0 != " " }) {
            code = String(code.dropFirst().dropLast())
        }
        let links = TranscriptLinkify.findLinks(in: code)
        guard !links.isEmpty else { return nil }
        let ticks = String(repeating: "`", count: fence)
        func piece(_ s: Substring) -> String {
            s.allSatisfy { $0 == " " } ? String(s) : "\(ticks) \(s) \(ticks)"
        }
        var out = ""
        var cursor = code.startIndex
        for link in links {
            if cursor < link.range.lowerBound { out += piece(code[cursor..<link.range.lowerBound]) }
            out += "[`\(link.text)`](<\(link.text)>)"
            cursor = link.range.upperBound
        }
        if cursor < code.endIndex { out += piece(code[cursor...]) }
        return out
    }
}
