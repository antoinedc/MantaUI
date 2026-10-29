import Foundation

// ===========================================================================
// linkify-it's matcher, ported to NSRegularExpression (ICU).
//
// The desktop's transcript autolinking (src/renderer/linkify.ts) is built on ONE
// configured linkify-it 6.1 instance (`fuzzyLink` on, `fuzzyEmail` / `fuzzyIP` off, the
// TLD list replaced by the desktop's allowlist plus every two-letter code). This
// file reproduces that instance: the same regular expressions (assembled the way
// linkify-it's REBuilder assembles them, from the same pieces) and the same
// candidate-picking loop in `match`. `TranscriptLinkify.findLinks` layers the
// transcript's own rules (linkify.ts) on top.
//
// Translation notes (JS regex → ICU), none of which changes what matches:
//  - `uc.micro`'s Z / P / Cc classes are spelled as explicit code-point ranges. The P
//    table was generated from the JS `P` regex itself (every code point tested), so it is
//    exactly the desktop's Unicode version.
//  - `Any` is every code point (a Swift string has no lone surrogates), so the
//    "pseudo letter" `(?!separators|Z|P|Cc)Any` is one negated class.
//  - JS `$` / `^` are `\z` / `\A`; `\d` is `[0-9]`; one-character classes such as
//    `[:]` and `[.]` are written as escapes (ICU reads `[:` as a POSIX-class opener).
//  - JS sticky (`y`) is `.anchored`; JS `lastIndex` is the start of the search range.
//  - Offsets are UTF-16 code units, as in JS.
// ===========================================================================

struct LinkifyMatch: Equatable, Sendable {
    /// Lower-cased scheme prefix (`http:`, `https:`, `//`, `mailto:`, `ftp:`), empty for a fuzzy link.
    let schema: String
    /// First UTF-16 offset of the match.
    let index: Int
    /// UTF-16 offset just after the match.
    let lastIndex: Int
}

enum LinkifyPatterns {
    /// The desktop's `SCHEMELESS_TLDS`.
    static let schemelessTLDs: [String] =
        "com net org io dev app ai co me so gg xyz info biz edu gov tech cloud site page run eu uk de fr ca us"
        .split(separator: " ").map(String.init)

    /// `uc.micro` P (Unicode punctuation), as ICU class members.
    static let punctuation: String =
        #"\x{21}-\x{23}\x{25}-\x{2A}\x{2C}-\x{2F}\x{3A}-\x{3B}\x{3F}-\x{40}\x{5B}-\x{5D}\x{5F}\x{7B}\x{7D}\x{A1}\x{A7}"# +
        #"\x{AB}\x{B6}-\x{B7}\x{BB}\x{BF}\x{37E}\x{387}\x{55A}-\x{55F}\x{589}-\x{58A}\x{5BE}\x{5C0}\x{5C3}\x{5C6}"# +
        #"\x{5F3}-\x{5F4}\x{609}-\x{60A}\x{60C}-\x{60D}\x{61B}\x{61D}-\x{61F}\x{66A}-\x{66D}\x{6D4}\x{700}-\x{70D}"# +
        #"\x{7F7}-\x{7F9}\x{830}-\x{83E}\x{85E}\x{964}-\x{965}\x{970}\x{9FD}\x{A76}\x{AF0}\x{C77}\x{C84}\x{DF4}\x{E4F}"# +
        #"\x{E5A}-\x{E5B}\x{F04}-\x{F12}\x{F14}\x{F3A}-\x{F3D}\x{F85}\x{FD0}-\x{FD4}\x{FD9}-\x{FDA}\x{104A}-\x{104F}"# +
        #"\x{10FB}\x{1360}-\x{1368}\x{1400}\x{166E}\x{169B}-\x{169C}\x{16EB}-\x{16ED}\x{1735}-\x{1736}\x{17D4}-\x{17D6}"# +
        #"\x{17D8}-\x{17DA}\x{1800}-\x{180A}\x{1944}-\x{1945}\x{1A1E}-\x{1A1F}\x{1AA0}-\x{1AA6}\x{1AA8}-\x{1AAD}"# +
        #"\x{1B4E}-\x{1B4F}\x{1B5A}-\x{1B60}\x{1B7D}-\x{1B7F}\x{1BFC}-\x{1BFF}\x{1C3B}-\x{1C3F}\x{1C7E}-\x{1C7F}"# +
        #"\x{1CC0}-\x{1CC7}\x{1CD3}\x{2010}-\x{2027}\x{2030}-\x{2043}\x{2045}-\x{2051}\x{2053}-\x{205E}\x{207D}-\x{207E}"# +
        #"\x{208D}-\x{208E}\x{2308}-\x{230B}\x{2329}-\x{232A}\x{2768}-\x{2775}\x{27C5}-\x{27C6}\x{27E6}-\x{27EF}"# +
        #"\x{2983}-\x{2998}\x{29D8}-\x{29DB}\x{29FC}-\x{29FD}\x{2CF9}-\x{2CFC}\x{2CFE}-\x{2CFF}\x{2D70}\x{2E00}-\x{2E2E}"# +
        #"\x{2E30}-\x{2E4F}\x{2E52}-\x{2E5D}\x{3001}-\x{3003}\x{3008}-\x{3011}\x{3014}-\x{301F}\x{3030}\x{303D}\x{30A0}"# +
        #"\x{30FB}\x{A4FE}-\x{A4FF}\x{A60D}-\x{A60F}\x{A673}\x{A67E}\x{A6F2}-\x{A6F7}\x{A874}-\x{A877}\x{A8CE}-\x{A8CF}"# +
        #"\x{A8F8}-\x{A8FA}\x{A8FC}\x{A92E}-\x{A92F}\x{A95F}\x{A9C1}-\x{A9CD}\x{A9DE}-\x{A9DF}\x{AA5C}-\x{AA5F}"# +
        #"\x{AADE}-\x{AADF}\x{AAF0}-\x{AAF1}\x{ABEB}\x{FD3E}-\x{FD3F}\x{FE10}-\x{FE19}\x{FE30}-\x{FE52}\x{FE54}-\x{FE61}"# +
        #"\x{FE63}\x{FE68}\x{FE6A}-\x{FE6B}\x{FF01}-\x{FF03}\x{FF05}-\x{FF0A}\x{FF0C}-\x{FF0F}\x{FF1A}-\x{FF1B}"# +
        #"\x{FF1F}-\x{FF20}\x{FF3B}-\x{FF3D}\x{FF3F}\x{FF5B}\x{FF5D}\x{FF5F}-\x{FF65}\x{10100}-\x{10102}\x{1039F}"# +
        #"\x{103D0}\x{1056F}\x{10857}\x{1091F}\x{1093F}\x{10A50}-\x{10A58}\x{10A7F}\x{10AF0}-\x{10AF6}"# +
        #"\x{10B39}-\x{10B3F}\x{10B99}-\x{10B9C}\x{10D6E}\x{10EAD}\x{10ED0}\x{10F55}-\x{10F59}\x{10F86}-\x{10F89}"# +
        #"\x{11047}-\x{1104D}\x{110BB}-\x{110BC}\x{110BE}-\x{110C1}\x{11140}-\x{11143}\x{11174}-\x{11175}"# +
        #"\x{111C5}-\x{111C8}\x{111CD}\x{111DB}\x{111DD}-\x{111DF}\x{11238}-\x{1123D}\x{112A9}\x{113D4}-\x{113D5}"# +
        #"\x{113D7}-\x{113D8}\x{1144B}-\x{1144F}\x{1145A}-\x{1145B}\x{1145D}\x{114C6}\x{115C1}-\x{115D7}"# +
        #"\x{11641}-\x{11643}\x{11660}-\x{1166C}\x{116B9}\x{1173C}-\x{1173E}\x{1183B}\x{11944}-\x{11946}\x{119E2}"# +
        #"\x{11A3F}-\x{11A46}\x{11A9A}-\x{11A9C}\x{11A9E}-\x{11AA2}\x{11B00}-\x{11B09}\x{11BE1}\x{11C41}-\x{11C45}"# +
        #"\x{11C70}-\x{11C71}\x{11EF7}-\x{11EF8}\x{11F43}-\x{11F4F}\x{11FFF}\x{12470}-\x{12474}\x{12FF1}-\x{12FF2}"# +
        #"\x{16A6E}-\x{16A6F}\x{16AF5}\x{16B37}-\x{16B3B}\x{16B44}\x{16D6D}-\x{16D6F}\x{16E97}-\x{16E9A}\x{16FE2}"# +
        #"\x{1BC9F}\x{1DA87}-\x{1DA8B}\x{1E5FF}\x{1E95E}-\x{1E95F}"#

    private static let z = #"\x{20}\x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}"#
    private static let cc = #"\x{0}-\x{1F}\x{7F}-\x{9F}"#
    /// linkify-it's `text_separators`, as class members.
    private static let separatorMembers = #"><\x{FF5C}"#

    private static let separators = "[\(separatorMembers)]"
    private static let zpcc = "[\(z)\(punctuation)\(cc)]"
    private static let zcc = "[\(z)\(cc)]"
    private static let pathTerminator = "[\(z)\(punctuation)\(cc)\(separatorMembers)]"
    /// `(?!separators|Z|P|Cc)Any`.
    private static let pseudoLetter = "[^\(separatorMembers)\(z)\(punctuation)\(cc)]"

    private static let xn = #"xn--[a-z0-9\-]{1,59}"#
    private static let ipv4 =
        #"(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])"#
    private static let ipv6: String = {
        let h = "[0-9A-Fa-f]{1,4}"
        let ls32 = "(?:(?:\(h):\(h))|\(ipv4))"
        let alts = [
            "(?:\(h):){6}\(ls32)",
            "::(?:\(h):){5}\(ls32)",
            "(?:\(h))?::(?:\(h):){4}\(ls32)",
            "(?:(?:\(h):){0,1}\(h))?::(?:\(h):){3}\(ls32)",
            "(?:(?:\(h):){0,2}\(h))?::(?:\(h):){2}\(ls32)",
            "(?:(?:\(h):){0,3}\(h))?::\(h):\(ls32)",
            "(?:(?:\(h):){0,4}\(h))?::\(ls32)",
            "(?:(?:\(h):){0,5}\(h))?::\(h)",
            "(?:(?:\(h):){0,6}\(h))?::",
        ]
        return "(?:\(alts.joined(separator: "|")))"
    }()
    private static let ipv6UrlHost = #"\["# + ipv6 + #"\]"#
    private static let ipv6MailHost = #"\[IPv6:"# + ipv6 + #"\]"#
    private static let port =
        #"(?::(?:6(?:[0-4][0-9]{3}|5(?:[0-4][0-9]{2}|5(?:[0-2][0-9]|3[0-5])))|[1-5]?[0-9]{1,4}))?"#
    private static let hostTerminator = #"(?=\z|\#(separators)|\#(zpcc))(?!\-|_|:[0-9]|\.\-|\.(?!\z|\#(zpcc)))"#

    private static func nestedPair(_ open: String, _ close: String) -> String {
        let atom = "(?:(?!\(zcc)|\(open)|\(close)).)"
        var pair = "\(open)\(atom){0,1000}\(close)"
        for _ in 2...4 { pair = "\(open)(?:\(atom)|\(pair)){0,1000}\(close)" }
        return pair
    }

    private static let path: String = {
        let alternatives = [
            nestedPair(#"\["#, #"\]"#),
            nestedPair(#"\("#, #"\)"#),
            nestedPair(#"\{"#, #"\}"#),
            #"\x{22}(?:(?!\#(zcc)|\x{22}).){1,100}\x{22}"#,
            #"\x{27}(?:(?!\#(zcc)|\x{27}).){1,100}\x{27}"#,
            #"\x{27}(?=\#(pseudoLetter)|\-)"#,
            #"\.{2,20}:?[a-zA-Z0-9%/&]"#,
            #"\.(?!\#(zcc)|\.|\z)"#,
            #"\-{1,20}"#,
            #",(?!\#(zcc)|\z)"#,
            #";(?!\#(zcc)|\z)"#,
            #"\!{1,20}(?!\#(zcc)|\!|\z)"#,
            #"\?(?!\#(zcc)|\?|\z)"#,
            #"[\\/:%@#&=_~*]"#,
            "(?!\(pathTerminator)).",
        ]
        return "(?:[/?#](?:\(alternatives.joined(separator: "|"))){1,\(LinkifyEngine.maxLength)}|/)?"
    }()

    private static let domain = "(?:\(xn)|(?:\(pseudoLetter))|(?:\(pseudoLetter)(?:-|\(pseudoLetter)){0,61}\(pseudoLetter)))"
    private static let domainRoot = "(?:\(xn)|\(pseudoLetter){1,63})"

    private static let tld: String = {
        let all = Set(schemelessTLDs + twoLetterCodes)
        return all.sorted().reversed().joined(separator: "|") + "|" + xn
    }()

    private static let twoLetterCodes: [String] = {
        let letters = Array("abcdefghijklmnopqrstuvwxyz")
        return letters.flatMap { a in letters.map { String([a, $0]) } }
    }()

    private static let urlHostPort =
        "(?:\(ipv6UrlHost)|(?:(?:(?:\(domain))\\.){0,10}\(domain)))\(port)\(hostTerminator)"
    private static let fuzzyUrlHostPort = "(?:(?:(?:\(domain))\\.){1,10}(?:\(tld)))\(hostTerminator)"

    private static let mailNameMembers = #"\-!#$%&'*+/=?^_`\{\|\}~a-zA-Z0-9"#
    private static let mailName = "[\(mailNameMembers)](?:[\(mailNameMembers)]|\\.(?=[\(mailNameMembers)])){0,63}"
    private static let mailHost = "(?:\(ipv6MailHost)|(?:(?:(?:\(domain))\\.){0,4}\(domain)))\(hostTerminator)"

    static let fuzzyLinkSearch =
        #"(\A|(?![.:/\-_@])(?:[$+<=>^`\|\x{FF5C}]|\#(zpcc)))(?:(?![$+<=>^`\|\x{FF5C}])\#(fuzzyUrlHostPort)\#(path))"#
    static let schemaSearch = #"(\A|(?!_)(?:[><\x{FF5C}]|\#(zpcc)))(http:|https:|ftp:|//|mailto:)"#
    static let httpValidator = "//\(urlHostPort)\(path)"
    static let relativeProtoValidator =
        "(?:localhost|\(ipv6UrlHost)|(?:(?:\(domain))\\.){1,10}\(domainRoot))\(port)\(hostTerminator)\(path)"
    static let mailtoValidator = "\(mailName)@\(mailHost)"
}

// MARK: - The matcher

/// linkify-it's `match()` for this configuration (fuzzy links on, fuzzy e-mail and IP
/// off): scheme matches (`http:`, `https:`, `ftp:`, `//`, `mailto:`) and fuzzy
/// (schemeless) links, merged left to right.
final class LinkifyEngine: Sendable {
    /// linkify-it's `maxLength` option.
    static let maxLength = 10_000

    /// nil only if ICU rejected one of the patterns — the caller then finds no links.
    static let shared: LinkifyEngine? = try? LinkifyEngine()

    private let schemaRe: NSRegularExpression
    private let fuzzyRe: NSRegularExpression
    private let httpRe: NSRegularExpression
    private let relativeRe: NSRegularExpression
    private let mailtoRe: NSRegularExpression

    init() throws {
        func compile(_ pattern: String) throws -> NSRegularExpression {
            try NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
        }
        schemaRe = try compile(LinkifyPatterns.schemaSearch)
        fuzzyRe = try compile(LinkifyPatterns.fuzzyLinkSearch)
        httpRe = try compile(LinkifyPatterns.httpValidator)
        relativeRe = try compile(LinkifyPatterns.relativeProtoValidator)
        mailtoRe = try compile(LinkifyPatterns.mailtoValidator)
    }

    private struct Candidate {
        var schema: String
        var index: Int
        var lastIndex: Int
    }

    /// A global-regex `exec` from `from`: the leftmost match starting at or after it.
    private func exec(_ re: NSRegularExpression, _ text: String, from: Int, count n: Int) -> (candidate: Candidate, groupTwo: NSRange)? {
        guard from < n,
              let m = re.firstMatch(in: text, options: [.withoutAnchoringBounds], range: NSRange(location: from, length: n - from))
        else { return nil }
        let delimiter = m.range(at: 1)
        let prefixLength = delimiter.location == NSNotFound ? 0 : delimiter.length
        let groupTwo = m.numberOfRanges > 2 ? m.range(at: 2) : NSRange(location: NSNotFound, length: 0)
        return (Candidate(schema: "", index: m.range.location + prefixLength, lastIndex: m.range.location + m.range.length), groupTwo)
    }

    private func testSchemaAt(_ text: String, _ units: [UInt16], schema: String, at pos: Int) -> Int {
        let re: NSRegularExpression
        switch schema {
        case "http:", "https:", "ftp:": re = httpRe
        case "//": re = relativeRe
        case "mailto:": re = mailtoRe
        default: return 0
        }
        let end = min(units.count, pos + Self.maxLength)
        guard pos <= end,
              let m = re.firstMatch(in: text, options: [.anchored], range: NSRange(location: pos, length: end - pos))
        else { return 0 }
        if schema == "//", pos >= 3, units[pos - 3] == 0x3A || units[pos - 3] == 0x2F { return 0 }
        return m.range.length
    }

    func match(_ text: String) -> [LinkifyMatch] {
        let units = Array(text.utf16)
        let n = units.count
        guard n > 0 else { return [] }

        var result: [LinkifyMatch] = []
        var pos = 0
        var fuzzyLastIndex = 0
        var schemaLastIndex = 0
        var fuzzyCandidate: Candidate?
        var fuzzyDone = false
        var schemaDone = false
        var schemaPrefix: Candidate?

        while true {
            let scanFrom = max(pos - 1, 0)

            if !fuzzyDone, (fuzzyCandidate?.index ?? -1) < pos {
                if fuzzyLastIndex < scanFrom { fuzzyLastIndex = scanFrom }
                while true {
                    guard let found = exec(fuzzyRe, text, from: fuzzyLastIndex, count: n) else {
                        fuzzyDone = true
                        fuzzyCandidate = nil
                        break
                    }
                    fuzzyLastIndex = found.candidate.lastIndex
                    fuzzyCandidate = found.candidate
                    if found.candidate.index >= pos { break }
                    if fuzzyLastIndex < scanFrom { fuzzyLastIndex = scanFrom }
                }
            }

            var schemaCandidate: Candidate?
            if !schemaDone {
                while true {
                    if schemaPrefix == nil {
                        if schemaLastIndex < scanFrom { schemaLastIndex = scanFrom }
                        guard let found = exec(schemaRe, text, from: schemaLastIndex, count: n), found.groupTwo.location != NSNotFound else {
                            schemaDone = true
                            break
                        }
                        schemaLastIndex = found.candidate.lastIndex
                        let name = String(decoding: units[found.groupTwo.location..<(found.groupTwo.location + found.groupTwo.length)], as: UTF16.self)
                        schemaPrefix = Candidate(schema: name, index: found.candidate.index, lastIndex: found.candidate.lastIndex)
                    }
                    guard let prefix = schemaPrefix else { break }
                    if prefix.index < pos {
                        schemaPrefix = nil
                        continue
                    }
                    if let fuzzy = fuzzyCandidate, prefix.index > fuzzy.index { break }
                    schemaPrefix = nil
                    let schema = prefix.schema.lowercased()
                    let length = testSchemaAt(text, units, schema: schema, at: prefix.lastIndex)
                    if length > 0 {
                        schemaCandidate = Candidate(schema: schema, index: prefix.index, lastIndex: prefix.lastIndex + length)
                        break
                    }
                }
            }

            var chosen = schemaCandidate
            var chosenIsFuzzy = false
            if let fuzzy = fuzzyCandidate {
                if let current = chosen {
                    if fuzzy.index < current.index || (fuzzy.index == current.index && fuzzy.lastIndex > current.lastIndex) {
                        chosen = fuzzy
                        chosenIsFuzzy = true
                    }
                } else {
                    chosen = fuzzy
                    chosenIsFuzzy = true
                }
            }
            guard let candidate = chosen else { break }
            if chosenIsFuzzy { fuzzyCandidate = nil }
            result.append(LinkifyMatch(schema: candidate.schema, index: candidate.index, lastIndex: candidate.lastIndex))
            pos = candidate.lastIndex
        }
        return result
    }
}
