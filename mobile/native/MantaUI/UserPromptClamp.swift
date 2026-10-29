import Foundation

// ===========================================================================
// A long user prompt shows its first four lines and a "Show more" toggle
// (desktop: ClampedMarkdown.tsx). The decisions are pure and live here; the view
// (`UserBand`) measures the text and draws.
// ===========================================================================

enum UserPromptClamp {
    /// How many lines a collapsed prompt shows.
    static let lineLimit = 4

    /// Whether a prompt could possibly need more than `lineLimit` lines — a cheap
    /// gate so a one-line "ok" is never measured twice. Only text with a line
    /// break or more than a couple of dozen characters is measured (even at the
    /// largest accessibility text size that is two or three lines).
    static func mayOverflow(_ text: String) -> Bool {
        text.count > 24 || text.contains("\n")
    }

    /// The measured height of the whole text exceeds what the clamp shows. One
    /// point of slack so rounding never offers a toggle that reveals nothing.
    static func overflows(fullHeight: CGFloat, visibleHeight: CGFloat) -> Bool {
        visibleHeight > 0 && fullHeight > visibleHeight + 1
    }

    /// Short prompts show no toggle; an expanded one always does ("Show less").
    static func showsToggle(expanded: Bool, overflows: Bool) -> Bool {
        expanded || overflows
    }

    static func toggleLabel(expanded: Bool) -> String {
        expanded ? "Show less" : "Show more"
    }
}
