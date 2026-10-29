import SwiftUI

// The SwiftUI half of the transcript autolinking (the scanner is Foundation-only, in
// TranscriptLinkify.swift, so it can be unit-tested on Linux).

extension TranscriptLinkify {
    /// `text` with every link made tappable (link attribute + accent colour +
    /// underline). Link-free text returns the plain string untouched.
    static func attributed(_ text: String, linkColor: Color) -> AttributedString {
        let links = findLinks(in: text)
        guard !links.isEmpty else { return AttributedString(text) }
        var out = AttributedString()
        var cursor = text.startIndex
        for link in links {
            if cursor < link.range.lowerBound { out += AttributedString(String(text[cursor..<link.range.lowerBound])) }
            var run = AttributedString(link.text)
            run.link = link.url
            run.foregroundColor = linkColor
            run.underlineStyle = .single
            out += run
            cursor = link.range.upperBound
        }
        if cursor < text.endIndex { out += AttributedString(String(text[cursor...])) }
        return out
    }
}
