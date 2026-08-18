import Foundation

// ===========================================================================
// BET-1026 — pure plan-card derivation, ported from the desktop's
// src/renderer/chatUtils.ts (isPlanExitQuestion / extractPlanData /
// planRefsFromPart, lines 2140-2307) plus the deterministic plan-page URL rule
// from src/shared/planMode.mjs, so the two surfaces cannot drift.
//
// The plan_exit question is upgraded into a dedicated plan card. Detection is
// EXACT, never heuristic: the question's `tool.callID` links back to a
// `plan_exit` tool part in the transcript — match on that, never on the
// question text.
//
// No `import SwiftUI`: this file is pure, so the card stays a thin renderer
// and every rule here is unit-testable.
// ===========================================================================

/// Everything the plan card renders, derived once per question.
struct PlanData: Equatable, Sendable {
    /// The plan's title (first markdown heading of the plan text, falling back
    /// to the question's header, then "Plan complete").
    let title: String
    /// The FULL plan text — what "Build here" resubmits as the next prompt
    /// with the build model. Empty when the plan_exit part carries none.
    let text: String
    /// The recovered `.opencode/plans/*.md` path, when one can be discovered
    /// from the transcript (nil when nothing is found — never a crash).
    let path: String?
}

enum PlanDerivation {

    /// Tools that AUTHOR the plan file (or confirm it at plan_exit). A `read`
    /// tool pointed at a plan path is a reference, not an authoring signal,
    /// and must not resolve as the plan — the write/plan tool (or a prose
    /// mention) already does. Mirrors the desktop's PLAN_AUTHORING_TOOLS.
    private static let authoringTools: Set<String> = ["write", "edit", "multiEdit", "patch", "plan", "plan_exit"]

    /// Every `.opencode/plans/*.md` reference. Mirrors the desktop's PLAN_REF_RE.
    // The pattern is a compile-time literal: this can only throw if the literal
    // itself is malformed, which any test run catches immediately.
    // swiftlint:disable:next force_try
    private static let planRefRegex: NSRegularExpression = try! NSRegularExpression(
        pattern: #"\.opencode/plans/[\w.-]+\.md"#)

    /// A tool part's name, surfaced either directly (`part.extra["tool"]`) or
    /// nested under `state.input.tool` (the reconciled transcript shape).
    /// Mirrors the desktop's `toolPartName` exactly.
    static func toolPartName(_ part: OpencodePart) -> String {
        if let direct = ChatJSON.string(part.extra["tool"]), !direct.isEmpty {
            return direct
        }
        if let state = ChatJSON.object(part.extra["state"]),
           let input = ChatJSON.object(state["input"]),
           let nested = ChatJSON.string(input["tool"]), !nested.isEmpty {
            return nested
        }
        return ""
    }

    /// Is `question` the plan_exit ask? True iff a transcript tool part named
    /// `plan_exit` carries the SAME `callID` as `question.tool.callID`. A
    /// callID is required (an orphaned question without one can never be
    /// matched) and the match must be exact — the question text is never
    /// consulted.
    static func isPlanExitQuestion(_ question: QuestionRequest, in messages: [OpencodeMessage]) -> Bool {
        guard let callID = question.tool?.callID, !callID.isEmpty else { return false }
        for message in messages {
            for part in message.parts where part.type == "tool" {
                guard partCallID(part) == callID else { continue }
                if toolPartName(part) == "plan_exit" { return true }
            }
        }
        return false
    }

    /// Every distinct `.opencode/plans/*.md` reference a single part carries.
    /// Mirrors the desktop's `planRefsFromPart`: the part's text, the
    /// authoring tool's input filePath/path/planPath, and the patch `files`
    /// list are all scanned; a `read` reference is not an authoring signal and
    /// identical refs are deduped.
    static func planRefsFromPart(_ part: OpencodePart) -> [String] {
        var candidates: [String] = []
        if let text = part.text { candidates.append(text) }
        if part.type == "tool", authoringTools.contains(toolPartName(part)) {
            let state = ChatJSON.object(part.extra["state"])
            let input = (state.flatMap { ChatJSON.object($0["input"]) }) ?? ChatJSON.object(part.extra["input"])
            if let input {
                for key in ["filePath", "path", "planPath"] {
                    if let v = ChatJSON.string(input[key]) { candidates.append(v) }
                }
            }
        }
        if let files = ChatJSON.array(part.extra["files"]) {
            candidates.append(contentsOf: files.compactMap(ChatJSON.string))
        }
        var out: [String] = []
        for candidate in candidates {
            for match in planRefs(in: candidate) where !out.contains(match) {
                out.append(match)
            }
        }
        return out
    }

    /// Every distinct `.opencode/plans/*.md` reference across the whole
    /// transcript (each part scanned once) — the tolerant path recovery for a
    /// plan whose `plan_exit` part carries no path.
    static func planPathsFromMessages(_ messages: [OpencodeMessage]) -> [String] {
        var out: [String] = []
        for message in messages {
            for part in message.parts {
                for ref in planRefsFromPart(part) where !out.contains(ref) {
                    out.append(ref)
                }
            }
        }
        return out
    }

    /// The plan card's display data. Tolerant: when the plan_exit part carries
    /// no plan text the card still renders, with the question's header as the
    /// title. The path is recovered across the transcript when the part
    /// carries none (`df991f8`-style discovery) and is nil when nothing is
    /// found — never crashes.
    static func extractPlanData(_ question: QuestionRequest, in messages: [OpencodeMessage]) -> PlanData {
        var text = ""
        var partPath: String?
        outer: for message in messages {
            for part in message.parts where part.type == "tool" {
                guard partCallID(part) == question.tool?.callID else { continue }
                guard toolPartName(part) == "plan_exit" else { continue }
                let state = ChatJSON.object(part.extra["state"])
                let input = (state.flatMap { ChatJSON.object($0["input"]) }) ?? ChatJSON.object(part.extra["input"])
                if let t = input.flatMap({ ChatJSON.string($0["plan"]) ?? ChatJSON.string($0["content"]) ?? ChatJSON.string($0["text"]) }), !t.isEmpty {
                    text = t
                }
                partPath = planRefsFromPart(part).first
                break outer
            }
        }

        let title: String
        if let h = firstMarkdownHeading(in: text), !h.isEmpty {
            title = h
        } else if let fl = firstNonEmptyLine(text) {
            title = fl
        } else if let header = question.questions.first?.header, !header.isEmpty {
            title = header
        } else {
            title = "Plan complete"
        }

        return PlanData(title: title, text: text, path: partPath ?? planPathsFromMessages(messages).first)
    }

    /// Count of steps and files in a plan body, for the card's metrics line
    /// ("N steps · N files · <path>"). There is no desktop counterpart — this
    /// is the iOS definition, pinned by unit tests. A step is a markdown
    /// heading whose text begins with "Step"; a file is a bullet item that
    /// names a path-like code span. Empty input yields (0, 0).
    static func planMetrics(_ text: String) -> (steps: Int, files: Int) {
        guard !text.isEmpty else { return (0, 0) }
        var steps = 0
        var files = 0
        for line in text.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let heading = headingText(trimmed), heading.lowercased().hasPrefix("step") {
                steps += 1
            } else if isFileBullet(trimmed) {
                files += 1
            }
        }
        return (steps, files)
    }

    /// The stable subdomain for a session's plan page: `plan-<shortSessionId>`.
    /// Mirrors src/shared/planMode.mjs `planSubdomain` (lowercased, stripped of
    /// non-alphanumerics, truncated to 20 chars). Nil when the session id
    /// yields no usable slug (caller must refuse — the "never hand back a 404
    /// URL" rule).
    static func planSubdomain(_ sessionID: String) -> String? {
        guard !sessionID.isEmpty else { return nil }
        let slug = String(sessionID.lowercased().filter { $0.isLetter || $0.isNumber }.prefix(20))
        guard !slug.isEmpty else { return nil }
        return "plan-" + slug
    }

    /// The deterministic public URL of a session's plan page:
    /// `<baseUrl>/pages/plan-<short>` (a trailing slash on `baseUrl` is
    /// trimmed). Nil when no usable slug can be formed. Mirrors `planPageUrl`
    /// in src/shared/planMode.mjs.
    static func planPageURL(sessionID: String, baseURL: URL) -> String? {
        guard let slug = planSubdomain(sessionID) else { return nil }
        let base = baseURL.absoluteString.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        return base + "/pages/" + slug
    }

    // MARK: - Private

    private static func partCallID(_ part: OpencodePart) -> String {
        ChatJSON.string(part.extra["callID"]) ?? ""
    }

    private static func planRefs(in string: String) -> [String] {
        let ns = string as NSString
        let range = NSRange(location: 0, length: ns.length)
        return planRefRegex.matches(in: string, range: range).map { ns.substring(with: $0.range) }
    }

    /// The first markdown heading in the text, or nil. Mirrors the desktop's
    /// `/^#{1,6}[ \t]+(.+)$/m` (heading at the start of a line).
    private static func firstMarkdownHeading(in text: String) -> String? {
        for line in text.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let h = headingText(trimmed), !h.isEmpty { return h }
        }
        return nil
    }

    /// The text after a leading `#{1,6}[ \t]+` heading marker, or nil when the
    /// line is not a heading.
    private static func headingText(_ line: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: #"^#{1,6}[ \t]+(.+)$"#) else { return nil }
        let ns = line as NSString
        guard let match = regex.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return ns.substring(with: match.range(at: 1)).trimmingCharacters(in: .whitespaces)
    }

    /// The first non-empty line of the text, trimmed, or nil. Mirrors the
    /// desktop's `text.split("\n").find((l) => l.trim())?.trim()`.
    private static func firstNonEmptyLine(_ text: String) -> String? {
        for line in text.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
    }

    /// A bullet item (`- ` / `* `) whose content names a path-like code span
    /// (a backtick pair around a filename with an extension). Not every bullet
    /// is a file — a prose or action bullet is skipped.
    private static func isFileBullet(_ line: String) -> Bool {
        guard let regex = try? NSRegularExpression(
            pattern: #"^[-*][ \t]+[^`]*`[^`]*\.[A-Za-z0-9_-]+`"#
        ) else { return false }
        let ns = line as NSString
        return regex.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) != nil
    }
}
