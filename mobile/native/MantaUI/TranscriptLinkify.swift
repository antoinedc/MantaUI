import Foundation

// ===========================================================================
// Transcript autolinking — the iOS half of the desktop's linkify
// (src/renderer/linkify.ts, docs/superpowers/specs/2026-10-29-transcript-autolink.md).
//
// It MATCHES the desktop: the detection is linkify-it's own matcher (ported in
// TranscriptLinkifyEngine.swift) with the transcript's rules from linkify.ts on top,
// which is what this file holds:
//  - `http://` and `https://` URLs, and `www.` hosts on any TLD (href = `https://` + text);
//  - schemeless hosts only for the TLD allowlist `com net org io dev app ai co me so gg
//    xyz info biz edu gov tech cloud site page run eu uk de fr ca us`; `app` / `ai`
//    only when a `/` path follows; never after `/ \ . @ ~ - _ $ :` or a word character;
//  - `<`, `{` or `$` right after a link (or `:` then one of them) makes it a template
//    placeholder, not a link (`http://localhost:<port>`);
//  - backticks, and `= * ^ + | ~` directly before a scheme / `www.`, do not hide a URL;
//    trailing `` ` * | ^ `` are trimmed; linkify-it's trailing-punctuation and
//    balanced-parenthesis handling applies;
//  - no e-mail, no IPs, and NO `mailto:` / `ftp:` / `//` — linkify-it matches those and
//    the transcript drops them. Only http(s) hrefs ever open.
// Why not Foundation's `NSDataDetector`: it links file names that are also TLDs
// (`install.sh`, `main.py`) and cannot be pinned down without running it.
// ===========================================================================

/// One detected link. `href` is what opens: the text itself for `http(s)://`,
/// `https://` + the text for `www.` and schemeless hosts.
struct TranscriptLink: Equatable, Sendable {
    let range: Range<String.Index>
    /// The link as written in the text.
    let text: String
    let href: String
    let url: URL
}

/// linkify.ts's `schemeless` option.
enum LinkifySchemeless: Sendable {
    /// Schemeless hosts link too (the default: prose, the user's prompt, tool output,
    /// reasoning, command text).
    case yes
    /// Only `http(s)://` and `www.`.
    case no
    /// A schemeless host links only when the whole trimmed text is that one link
    /// (inline code: `mantaui.com` is a link, `curl mantaui.com` is a command).
    case whole
}

enum TranscriptLinkify {

    /// linkify.ts's `MAYBE_LINK`: no scheme and no `x.y` shape means no link at all.
    static func mayContainLink(_ text: String) -> Bool {
        LinkifyDetector.maybeLink?.firstMatch(in: text, range: NSRange(location: 0, length: text.utf16.count)) != nil
    }

    static func findLinks(in text: String, schemeless: LinkifySchemeless = .yes) -> [TranscriptLink] {
        LinkifyDetector.findLinks(in: text, schemeless: schemeless, following: "")
    }

    /// `findLinks` for a span cut out of a longer text: `following` is the text right
    /// after the span, used only for the template-placeholder rule.
    static func findLinks(in text: String, schemeless: LinkifySchemeless, following: String) -> [TranscriptLink] {
        LinkifyDetector.findLinks(in: text, schemeless: schemeless, following: following)
    }

    /// The URL a link opens, or nil when it is not an http(s) URL Foundation can parse.
    static func openableURL(_ href: String) -> URL? {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~!#$&'()*+,/:;=?@[]%"))
        let url = URL(string: href) ?? href.addingPercentEncoding(withAllowedCharacters: allowed).flatMap { URL(string: $0) }
        guard let url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        return url
    }
}

// MARK: - linkify.ts

private enum LinkifyDetector {
    static let schemelessTLDs: Set<String> = Set(LinkifyPatterns.schemelessTLDs)
    /// Double as file extensions (MantaUI.app, logo.ai): link only with a path.
    static let needsPathTLDs: Set<String> = ["app", "ai"]
    static let rejectBefore: Set<UInt16> = Set("/\\.@~-_$:".utf16)
    static let placeholderAfter: Set<UInt16> = Set("<{$".utf16)
    static let trailingWrappers: Set<UInt16> = Set("`*|^".utf16)

    static let maybeLink = try? NSRegularExpression(pattern: #"https?://|[\p{L}\p{N}]\.\p{L}"#, options: [.caseInsensitive])
    static let wordChar = try? NSRegularExpression(pattern: #"\A[\p{L}\p{N}_]\z"#)

    struct Found {
        let start: Int
        let end: Int
        let text: String
        let href: String
    }

    static func findLinks(in text: String, schemeless: LinkifySchemeless, following: String) -> [TranscriptLink] {
        guard !text.isEmpty, TranscriptLinkify.mayContainLink(text), let engine = LinkifyEngine.shared else { return [] }
        let original = Array(text.utf16)
        let tail = Array(following.utf16)
        // Same length as `text`, so match offsets apply to the original.
        let scan = scanText(original)

        // One line at a time: a newline separates everything anyway, and it bounds the regex work.
        var raw: [LinkifyMatch] = []
        var lineStart = 0
        while lineStart <= scan.count {
            var lineEnd = lineStart
            while lineEnd < scan.count, scan[lineEnd] != 0x0A { lineEnd += 1 }
            if lineEnd > lineStart {
                let line = String(decoding: scan[lineStart..<lineEnd], as: UTF16.self)
                for match in engine.match(line) {
                    raw.append(LinkifyMatch(schema: match.schema, index: match.index + lineStart, lastIndex: match.lastIndex + lineStart))
                }
            }
            lineStart = lineEnd + 1
        }

        func unit(at i: Int) -> UInt16? {
            if i < original.count { return original[i] }
            let k = i - original.count
            return k < tail.count ? tail[k] : nil
        }

        var found: [Found] = []
        for m in raw {
            let rawText = String(decoding: scan[m.index..<m.lastIndex], as: UTF16.self)
            let isScheme = m.schema == "http:" || m.schema == "https:"
            let isWww = m.schema.isEmpty && rawText.lowercased().hasPrefix("www.")
            if !isScheme, !isWww, !m.schema.isEmpty { continue }
            if let next = unit(at: m.lastIndex) {
                if placeholderAfter.contains(next) { continue }
                if next == 0x3A, let afterNext = unit(at: m.lastIndex + 1), placeholderAfter.contains(afterNext) { continue }
            }
            if !isScheme, !isWww {
                if schemeless == .no || !schemelessAllowed(original, start: m.index, matchText: rawText) { continue }
            }
            var end = m.lastIndex
            while end > m.index, trailingWrappers.contains(original[end - 1]) { end -= 1 }
            let slice = String(decoding: original[m.index..<end], as: UTF16.self)
            found.append(Found(start: m.index, end: end, text: slice, href: isScheme ? slice : "https://\(slice)"))
        }

        if schemeless == .whole { found = keepWholeSpanSchemeless(original, found) }

        var out: [TranscriptLink] = []
        for f in found {
            guard let url = TranscriptLinkify.openableURL(f.href) else { continue }
            let lower = String.Index(utf16Offset: f.start, in: text)
            let upper = String.Index(utf16Offset: f.end, in: text)
            out.append(TranscriptLink(range: lower..<upper, text: f.text, href: f.href, url: url))
        }
        return out
    }

    /// `text` with backticks and the wrapper characters directly before a scheme /
    /// `www.` blanked (what linkify-it is shown).
    private static func scanText(_ u: [UInt16]) -> [UInt16] {
        var s = u.map { $0 == 0x60 ? UInt16(0x20) : $0 }
        let wrappers: Set<UInt16> = Set("=*^+|~".utf16)
        for i in 0..<s.count where wrappers.contains(s[i]) && urlStarts(s, at: i + 1) { s[i] = 0x20 }
        return s
    }

    private static func urlStarts(_ s: [UInt16], at i: Int) -> Bool {
        func has(_ prefix: String) -> Bool {
            let p = Array(prefix.utf16)
            guard i + p.count <= s.count else { return false }
            for k in 0..<p.count where lowerASCII(s[i + k]) != p[k] { return false }
            return true
        }
        return has("https://") || has("http://") || has("www.")
    }

    private static func lowerASCII(_ c: UInt16) -> UInt16 { c >= 0x41 && c <= 0x5A ? c + 0x20 : c }

    private static func schemelessAllowed(_ text: [UInt16], start: Int, matchText: String) -> Bool {
        if start > 0 {
            let tail = Array(text[max(0, start - 2)..<start])
            let isLow = { (c: UInt16) in c >= 0xDC00 && c <= 0xDFFF }
            let prev = tail.count >= 2 && isLow(tail[tail.count - 1]) ? Array(tail.suffix(2)) : Array(tail.suffix(1))
            let prevString = String(decoding: prev, as: UTF16.self)
            if prev.count == 1, rejectBefore.contains(prev[0]) { return false }
            if let wordChar, wordChar.firstMatch(in: prevString, range: NSRange(location: 0, length: prevString.utf16.count)) != nil { return false }
        }
        let units = Array(matchText.utf16)
        let hostEnd = units.firstIndex { $0 == 0x2F || $0 == 0x3F || $0 == 0x23 }
        let host = hostEnd.map { String(decoding: units[0..<$0], as: UTF16.self) } ?? matchText
        let tld = host.split(separator: ".", omittingEmptySubsequences: false).last.map { $0.lowercased() } ?? ""
        guard schemelessTLDs.contains(tld) else { return false }
        if needsPathTLDs.contains(tld) { return hostEnd.map { units[$0] == 0x2F } ?? false }
        return true
    }

    /// JS `String.prototype.trim` whitespace.
    private static func isJSSpace(_ c: UInt16) -> Bool {
        switch c {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
        default: return false
        }
    }

    private static func keepWholeSpanSchemeless(_ text: [UInt16], _ links: [Found]) -> [Found] {
        func isFuzzy(_ l: Found) -> Bool {
            let t = l.text.lowercased()
            return !(t.hasPrefix("http://") || t.hasPrefix("https://") || t.hasPrefix("www."))
        }
        guard links.contains(where: isFuzzy) else { return links }
        var lead = 0
        while lead < text.count, isJSSpace(text[lead]) { lead += 1 }
        var stop = text.count
        while stop > 0, isJSSpace(text[stop - 1]) { stop -= 1 }
        if links.count == 1, links[0].start == lead, links[0].end == stop { return links }
        return links.filter { !isFuzzy($0) }
    }
}

// MARK: - Markdown source

/// The assistant's markdown with every link the desktop would make made one — because
/// the markdown renderer (swift-markdown, no GFM autolink extension) shows a bare URL
/// as plain text, and an inline-code span as a code chip whatever it holds.
///
///  - in prose (desktop: remark-gfm + `findLinks` on text nodes, schemeless on), a
///    link becomes `<url>` when its text is its href, else `[text](<href>)` — trailing
///    punctuation stays outside;
///  - in an inline-code span (desktop: `schemeless: "whole"`) only the URL becomes a
///    link whose label is code (`` `curl https://x.com -o f` `` → code `curl `, then the
///    URL as a linked code chip, then code ` -o f`); a span that is one schemeless host
///    (`` `mantaui.com` ``) is a link as a whole.
///
/// Left alone: fenced code blocks, text already in `[label](dest)` (label and
/// destination), `<autolinks>` and raw HTML, reference definitions, and a code span
/// that is itself a link label. Prose is scanned one run at a time — a run ends at a
/// code span, a bracket or an HTML tag, as a text node does on the desktop. Indented
/// code blocks are NOT recognised (they are indistinguishable from list continuation
/// here); a backtick span inside one that holds a URL would be rewritten — AI output
/// does not use them.
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
        if afterBracket.hasPrefix("http://") || afterBracket.hasPrefix("https://") { return false }
        return second.isLetter || second == "/" || second == "!" || second == "?"
    }

    // MARK: One line

    /// Whether the `<` at `i` opens an HTML tag / autolink that closes on this line.
    private static func tagEnd(_ c: [Character], at i: Int) -> Int? {
        guard i + 1 < c.count, c[i + 1].isLetter || c[i + 1] == "/" || c[i + 1] == "!" || c[i + 1] == "?",
              let close = c[i...].firstIndex(of: ">") else { return nil }
        return close
    }

    private static func rewrite(_ line: String) -> String {
        let c = Array(line)
        var out = ""
        var plain = ""
        var i = 0
        var labelDepth = 0

        func flush(at index: Int) {
            guard !plain.isEmpty else { return }
            out += labelDepth > 0 ? plain : prose(plain, following: String(c[index...].prefix(2)))
            plain = ""
        }

        while i < c.count {
            let ch = c[i]
            switch ch {
            case "\\":
                plain.append(ch)
                if i + 1 < c.count { plain.append(c[i + 1]) }
                i += 2
            case "`":
                flush(at: i)
                i = codeSpan(c, at: i, insideLabel: labelDepth > 0, into: &out)
            case "[":
                flush(at: i)
                if c[(i + 1)...].contains("]") { labelDepth += 1 }
                out.append(ch)
                i += 1
            case "]":
                flush(at: i)
                labelDepth = max(0, labelDepth - 1)
                out.append(ch)
                i += 1
                if i < c.count, c[i] == "(" { i = destination(c, at: i, into: &out) }
            case "<":
                if let close = tagEnd(c, at: i) {
                    flush(at: i)
                    out += String(c[i...close])
                    i = close + 1
                } else {
                    plain.append(ch)
                    i += 1
                }
            default:
                plain.append(ch)
                i += 1
            }
        }
        flush(at: c.count)
        return out
    }

    /// A run of prose with its links made markdown links.
    private static func prose(_ text: String, following: String) -> String {
        let links = TranscriptLinkify.findLinks(in: text, schemeless: .yes, following: following)
        guard !links.isEmpty else { return text }
        var out = ""
        var cursor = text.startIndex
        for link in links {
            if cursor < link.range.lowerBound { out += text[cursor..<link.range.lowerBound] }
            out += link.href == link.text ? "<\(link.text)>" : "[\(escapedLabel(link.text))](<\(escapedDestination(link.href))>)"
            cursor = link.range.upperBound
        }
        if cursor < text.endIndex { out += text[cursor...] }
        return out
    }

    /// Markdown-significant characters backslash-escaped, so the label is literal text.
    private static func escapedLabel(_ s: String) -> String {
        var out = ""
        for ch in s {
            if "\\`*_[]<>&~|!".contains(ch) { out.append("\\") }
            out.append(ch)
        }
        return out
    }

    /// For `<…>` link destinations: a backslash would start an escape and `&` an entity.
    private static func escapedDestination(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "%5C").replacingOccurrences(of: "&", with: "&amp;")
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
        let links = TranscriptLinkify.findLinks(in: code, schemeless: .whole)
        guard !links.isEmpty else { return nil }
        let ticks = String(repeating: "`", count: fence)
        func piece(_ s: Substring) -> String {
            s.allSatisfy { $0 == " " } ? String(s) : "\(ticks) \(s) \(ticks)"
        }
        var out = ""
        var cursor = code.startIndex
        for link in links {
            if cursor < link.range.lowerBound { out += piece(code[cursor..<link.range.lowerBound]) }
            out += "[`\(link.text)`](<\(escapedDestination(link.href))>)"
            cursor = link.range.upperBound
        }
        if cursor < code.endIndex { out += piece(code[cursor...]) }
        return out
    }
}
