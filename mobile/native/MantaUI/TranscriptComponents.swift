import Foundation
import SwiftUI

// Shared helper: map a generated font-weight metric (500 / 600 from
// --weight-medium / --weight-semibold) onto the nearest Font.Weight. The
// mapping is a renderer concern — the VALUE always comes from the generated
// token, never a hardcoded literal.
@MainActor
func mantaFontWeight(_ weight: CGFloat) -> Font.Weight {
    switch weight {
    case Metrics.type.semibold: return .semibold
    case Metrics.type.medium: return .medium
    default: return .regular
    }
}

// MARK: - User band (the full-bleed user turn)
//
// DECISIONS.md §8 (and transcript-mockup.html `.user`): a full-bleed band —
// edge to edge past the transcript's own padding, background `fill`, a 2px
// `accent` left edge, radius 0 on the leading side and `--r-md` on the
// trailing side, 15px/1.5 weight 500 `tx1`, padding `--sp-3`. No role caption.
struct UserBand: View {
    let text: String
    let tokens: Tokens

    var body: some View {
        Text(text)
            .font(.system(size: Metrics.type.body, weight: mantaFontWeight(Metrics.type.medium)))
            .foregroundColor(tokens.tx1)
            .lineSpacing(pointsFor(multiplier: 1.5, size: Metrics.type.body))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Metrics.spacing.sp3)
            .background(tokens.fill, in: bandShape)
            .overlay(alignment: .leading) {
                tokens.accent
                    .frame(width: Metrics.spacing.spPx * 2)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("user-band")
    }

    private var bandShape: some Shape {
        UnevenRoundedRectangle(
            topLeadingRadius: 0,
            bottomLeadingRadius: 0,
            bottomTrailingRadius: Metrics.radius.md,
            topTrailingRadius: Metrics.radius.md
        )
    }
}


// MARK: - Inline markdown
//
// The native transcript has no markdown renderer (the spike explicitly did not
// build one), so assistant turns showed their source: `**bold**`, backticked
// code and link syntax appeared verbatim. This covers the INLINE subset that
// SwiftUI can parse natively — emphasis, strong, inline code, links —
// preserving newlines so paragraph structure survives.
//
// BLOCK-level markdown is handled by `MantaMarkdownParser` below, which splits
// a turn into blocks and hands each block's TEXT back through this renderer for
// its inline spans.
enum MantaInlineMarkdown {
    static func render(_ raw: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: raw, options: options)) ?? AttributedString(raw)
    }
}

// MARK: - Block markdown
//
// `AttributedString(markdown:)` with `.inlineOnlyPreservingWhitespace` parses
// ONLY inline spans, and passes every block construct through as literal text.
// So a turn that opened with `## How it compares` and laid its answer out as a
// GFM table rendered as its own source: a heading line with two hashes, then
// `| Latency | record → upload |` and a `|---|---|---|` rule, verbatim.
//
// This is the block layer. It is deliberately a small, total, PURE function —
// no library, no dependency, and no throwing path: anything it does not
// recognise stays a paragraph and still gets inline rendering, so an
// unsupported construct degrades to exactly today's behaviour rather than
// disappearing.
enum MantaMarkdownBlock: Equatable {
    case paragraph(String)
    case heading(level: Int, text: String)
    /// One list item. `ordered` drives the marker; `depth` its indent.
    case listItem(depth: Int, marker: String, text: String)
    case code(language: String?, text: String)
    case quote(String)
    case rule
    case table(MantaMarkdownTable)
}

enum MantaTableAlignment: Equatable {
    case leading, center, trailing
}

struct MantaMarkdownTable: Equatable {
    var header: [String]
    var alignments: [MantaTableAlignment]
    var rows: [[String]]

    /// Header + body, padded/truncated to the header's column count so the grid
    /// is always rectangular (a ragged row is legal GFM and must not crash or
    /// misalign the columns).
    var normalizedRows: [[String]] {
        rows.map { row in
            (0..<header.count).map { i in i < row.count ? row[i] : "" }
        }
    }

    func alignment(_ column: Int) -> MantaTableAlignment {
        column < alignments.count ? alignments[column] : .leading
    }
}

enum MantaMarkdownParser {

    /// Split a turn's text into blocks. Total: never throws, never drops input.
    static func blocks(_ raw: String) -> [MantaMarkdownBlock] {
        let lines = raw.components(separatedBy: "\n")
        var out: [MantaMarkdownBlock] = []
        var paragraph: [String] = []
        var i = 0

        func flushParagraph() {
            let text = paragraph.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            paragraph.removeAll()
            if !text.isEmpty { out.append(.paragraph(text)) }
        }

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Fenced code. Consumes to the closing fence, or to the end of the
            // input when the fence never closes (the streaming case — a half
            // written block must still render as code, not as loose prose).
            if let fence = fenceToken(trimmed) {
                flushParagraph()
                let language = String(trimmed.dropFirst(fence.count)).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                i += 1
                while i < lines.count {
                    let candidate = lines[i].trimmingCharacters(in: .whitespaces)
                    if candidate.hasPrefix(fence) { i += 1; break }
                    body.append(lines[i])
                    i += 1
                }
                out.append(.code(language: language.isEmpty ? nil : language,
                                 text: body.joined(separator: "\n")))
                continue
            }

            if trimmed.isEmpty {
                flushParagraph()
                i += 1
                continue
            }

            if isThematicBreak(trimmed) {
                flushParagraph()
                out.append(.rule)
                i += 1
                continue
            }

            if let heading = parseHeading(trimmed) {
                flushParagraph()
                out.append(heading)
                i += 1
                continue
            }

            // GFM table: a header row plus a delimiter row. Checked BEFORE the
            // paragraph fallback and before list parsing, because both would
            // otherwise swallow the pipes as ordinary text.
            if let parsed = parseTable(lines, from: i) {
                flushParagraph()
                out.append(.table(parsed.table))
                i = parsed.next
                continue
            }

            if let item = parseListItem(line) {
                flushParagraph()
                out.append(item)
                i += 1
                continue
            }

            if trimmed.hasPrefix(">") {
                flushParagraph()
                var body: [String] = []
                while i < lines.count {
                    let candidate = lines[i].trimmingCharacters(in: .whitespaces)
                    guard candidate.hasPrefix(">") else { break }
                    body.append(String(candidate.dropFirst()).trimmingCharacters(in: .whitespaces))
                    i += 1
                }
                out.append(.quote(body.joined(separator: "\n")))
                continue
            }

            paragraph.append(line)
            i += 1
        }

        flushParagraph()
        return out
    }

    // MARK: - Line classifiers (each pure + individually testable)

    /// The ``` / ~~~ opener, or nil.
    static func fenceToken(_ trimmed: String) -> String? {
        for token in ["```", "~~~"] where trimmed.hasPrefix(token) {
            return token
        }
        return nil
    }

    static func isThematicBreak(_ trimmed: String) -> Bool {
        for ch in ["-", "*", "_"] {
            let stripped = trimmed.replacingOccurrences(of: " ", with: "")
            if stripped.count >= 3, stripped.allSatisfy({ String($0) == ch }) { return true }
        }
        return false
    }

    static func parseHeading(_ trimmed: String) -> MantaMarkdownBlock? {
        guard trimmed.hasPrefix("#") else { return nil }
        let hashes = trimmed.prefix(while: { $0 == "#" })
        guard hashes.count <= 6 else { return nil }
        let rest = trimmed.dropFirst(hashes.count)
        // `#hashtag` is not a heading — ATX requires a space after the run.
        guard rest.first == " " || rest.isEmpty else { return nil }
        let text = rest.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        return .heading(level: hashes.count, text: text)
    }

    static func parseListItem(_ line: String) -> MantaMarkdownBlock? {
        let indent = line.prefix(while: { $0 == " " || $0 == "\t" }).count
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let depth = min(indent / 2, 3)

        for bullet in ["- ", "* ", "+ "] where trimmed.hasPrefix(bullet) {
            let text = String(trimmed.dropFirst(bullet.count)).trimmingCharacters(in: .whitespaces)
            guard !text.isEmpty else { return nil }
            return .listItem(depth: depth, marker: "•", text: text)
        }

        // `12. text` / `12) text`
        let digits = trimmed.prefix(while: { $0.isNumber })
        if !digits.isEmpty, digits.count <= 9 {
            let rest = trimmed.dropFirst(digits.count)
            if let sep = rest.first, sep == "." || sep == ")" {
                let text = String(rest.dropFirst()).trimmingCharacters(in: .whitespaces)
                guard !text.isEmpty else { return nil }
                return .listItem(depth: depth, marker: "\(digits).", text: text)
            }
        }
        return nil
    }

    // MARK: - Table

    /// Parse a GFM table starting at `start`, returning it plus the index of
    /// the first line AFTER it. nil when the two-line header+delimiter shape
    /// isn't there — which is what keeps a lone pipe-bearing prose line prose.
    static func parseTable(_ lines: [String], from start: Int) -> (table: MantaMarkdownTable, next: Int)? {
        guard start + 1 < lines.count else { return nil }
        let headerLine = lines[start].trimmingCharacters(in: .whitespaces)
        guard headerLine.contains("|") else { return nil }
        let delimiterLine = lines[start + 1].trimmingCharacters(in: .whitespaces)
        guard let alignments = parseDelimiterRow(delimiterLine) else { return nil }

        let header = splitRow(headerLine)
        guard header.count == alignments.count else { return nil }

        var rows: [[String]] = []
        var cursor = start + 2
        while cursor < lines.count {
            let candidate = lines[cursor].trimmingCharacters(in: .whitespaces)
            guard !candidate.isEmpty, candidate.contains("|") else { break }
            rows.append(splitRow(candidate))
            cursor += 1
        }
        return (MantaMarkdownTable(header: header, alignments: alignments, rows: rows), cursor)
    }

    /// `|---|:--:|---:|` -> per-column alignment, or nil when the line is not a
    /// delimiter row (which is what makes a lone pipe-bearing prose line stay
    /// prose).
    static func parseDelimiterRow(_ line: String) -> [MantaTableAlignment]? {
        guard line.contains("|"), line.contains("-") else { return nil }
        let cells = splitRow(line)
        guard !cells.isEmpty else { return nil }
        var out: [MantaTableAlignment] = []
        for cell in cells {
            let c = cell.trimmingCharacters(in: .whitespaces)
            guard !c.isEmpty else { return nil }
            let left = c.hasPrefix(":")
            let right = c.hasSuffix(":")
            let dashes = c.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            guard !dashes.isEmpty, dashes.allSatisfy({ $0 == "-" }) else { return nil }
            if left && right { out.append(.center) }
            else if right { out.append(.trailing) }
            else { out.append(.leading) }
        }
        return out
    }

    /// Split one table row into cells, honouring `\|` escapes and dropping the
    /// optional leading/trailing pipe. An EMPTY first header cell is legal and
    /// common (a corner cell), so we must not trim empties away wholesale —
    /// only the delimiters the row shape contributes.
    static func splitRow(_ line: String) -> [String] {
        var body = line
        if body.hasPrefix("|") { body.removeFirst() }
        if body.hasSuffix("|") && !body.hasSuffix("\\|") { body.removeLast() }

        var cells: [String] = []
        var current = ""
        var escaped = false
        for ch in body {
            if escaped {
                current.append(ch == "|" ? "|" : ch)
                escaped = false
                continue
            }
            if ch == "\\" { escaped = true; continue }
            if ch == "|" {
                cells.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
                continue
            }
            current.append(ch)
        }
        if escaped { current.append("\\") }
        cells.append(current.trimmingCharacters(in: .whitespaces))
        return cells
    }
}

// MARK: - Assistant prose
//
// §8: full width, `tx1`, 15px/`--prose-lh`, margin-bottom `--sp-3`.
struct AssistantProse: View {
    let text: String
    let tokens: Tokens

    private var blocks: [MantaMarkdownBlock] { MantaMarkdownParser.blocks(text) }

    var body: some View {
        // Spacing 0 + a per-block bottom gap: a uniform VStack spacing would
        // set consecutive list items as far apart as two paragraphs, which
        // stops a list reading as one list.
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { pair in
                blockView(pair.element)
                    .padding(.bottom, gapBelow(pair.element))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.bottom, Metrics.spacing.sp3)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("assistant-prose")
    }

    @ViewBuilder
    private func blockView(_ block: MantaMarkdownBlock) -> some View {
        switch block {
        case .paragraph(let content):
            proseText(content)
        case .heading(let level, let content):
            Text(MantaInlineMarkdown.render(content))
                .font(.system(size: headingSize(level), weight: .semibold))
                .kerning(Metrics.type.headingTracking * headingSize(level))
                .foregroundColor(tokens.tx1)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, Metrics.spacing.sp2)
        case .listItem(let depth, let marker, let content):
            HStack(alignment: .firstTextBaseline, spacing: Metrics.spacing.sp2) {
                Text(marker)
                    .font(.system(size: Metrics.type.body))
                    .foregroundColor(tokens.tx4)
                    .monospacedDigit()
                proseText(content)
            }
            .padding(.leading, CGFloat(depth) * Metrics.spacing.sp4)
        case .code(let language, let content):
            MarkdownCodeBlock(language: language, text: content, tokens: tokens)
        case .quote(let content):
            proseText(content)
                .foregroundColor(tokens.tx2)
                .padding(.leading, Metrics.spacing.sp3)
                .overlay(alignment: .leading) {
                    tokens.borderSubtle.frame(width: Metrics.spacing.spPx * 2)
                }
        case .rule:
            tokens.borderSubtle
                .frame(height: Metrics.spacing.spPx)
                .padding(.vertical, Metrics.spacing.sp1)
        case .table(let table):
            MarkdownTableView(table: table, tokens: tokens)
        }
    }

    // `fixedSize(horizontal: false, …)` is what keeps a long unbreakable token
    // (a shell command, a URL, a path) INSIDE the screen. Without it such a
    // token makes the text demand its full unwrapped width, the scroll view
    // adopts that width, and every sibling — including the composer, which
    // shares the same layout — is laid out wider than the display: text stops
    // appearing to wrap, the send button sits off screen, and each keystroke
    // re-lays out an oversized view, which is what made typing crawl.
    private func proseText(_ content: String) -> some View {
        Text(MantaInlineMarkdown.render(content))
            .font(.system(size: Metrics.type.body))
            .foregroundColor(tokens.tx1)
            .lineSpacing(pointsFor(multiplier: Metrics.type.proseLineHeight, size: Metrics.type.body))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func gapBelow(_ block: MantaMarkdownBlock) -> CGFloat {
        switch block {
        case .listItem, .heading, .rule: return Metrics.spacing.sp1
        case .paragraph, .code, .quote, .table: return Metrics.spacing.sp2
        }
    }

    /// `#` is the turn's own top level, so it is only slightly larger than
    /// body; deeper levels converge on body size. A transcript turn is not a
    /// document — an `h1` set at display size would shout over the user band.
    private func headingSize(_ level: Int) -> CGFloat {
        switch level {
        case 1: return Metrics.type.body + 4
        case 2: return Metrics.type.body + 2
        case 3: return Metrics.type.body + 1
        default: return Metrics.type.body
        }
    }
}

// MARK: - Fenced code
//
// Horizontal scroll rather than wrapping: a wrapped command line is a command
// line you cannot read, and (per the note in `proseText`) letting an
// unwrappable token dictate the width blows out the whole transcript layout.
// A horizontal ScrollView takes the width it is GIVEN, so it bounds itself.
struct MarkdownCodeBlock: View {
    let language: String?
    let text: String
    let tokens: Tokens

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let language, !language.isEmpty {
                Text(language)
                    .font(.system(size: Metrics.type.twoXS, weight: .medium))
                    .foregroundColor(tokens.tx4)
                    .padding(.horizontal, Metrics.spacing.sp2)
                    .padding(.top, Metrics.spacing.sp2)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.system(size: Metrics.type.xs, design: .monospaced))
                    .foregroundColor(tokens.tx1)
                    .textSelection(.enabled)
                    .padding(Metrics.spacing.sp2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .overlay {
            RoundedRectangle(cornerRadius: Metrics.radius.md)
                .stroke(tokens.borderSubtle, lineWidth: Metrics.spacing.spPx)
        }
        .accessibilityIdentifier("markdown-code")
    }
}

// MARK: - GFM table
//
// Rows are HStacks of equal-share (`maxWidth: .infinity`) cells, NOT a `Grid`.
// A Grid sizes each column to its widest cell's IDEAL width, and a prose cell's
// ideal width is its UNWRAPPED width — the exact layout blow-out the note in
// `proseText` describes, where one long cell widens the scroll view and drags
// the composer off screen with it. Equal shares of the width we are actually
// given can't overflow, and every cell wraps inside its share.
//
// Column rules are deliberately omitted: keeping vertical hairlines aligned
// needs equal-height cells, which needs a height the transcript can't propose.
// Row hairlines plus a filled header row carry the structure on a phone.
struct MarkdownTableView: View {
    let table: MantaMarkdownTable
    let tokens: Tokens

    var body: some View {
        VStack(spacing: 0) {
            row(table.header, header: true)
            ForEach(Array(table.normalizedRows.enumerated()), id: \.offset) { pair in
                Divider().overlay(tokens.borderSubtle)
                row(pair.element, header: false)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tokens.card)
        // Clip BEFORE the stroke: the header row's own fill is a plain
        // rectangle and would otherwise square off the container's top corners.
        .clipShape(RoundedRectangle(cornerRadius: Metrics.radius.md))
        .overlay {
            RoundedRectangle(cornerRadius: Metrics.radius.md)
                .stroke(tokens.borderSubtle, lineWidth: Metrics.spacing.spPx)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("markdown-table")
    }

    private func row(_ cells: [String], header: Bool) -> some View {
        HStack(alignment: .top, spacing: Metrics.spacing.sp2) {
            ForEach(Array(cells.enumerated()), id: \.offset) { pair in
                Text(MantaInlineMarkdown.render(pair.element))
                    .font(.system(size: Metrics.type.xs, weight: header ? .semibold : .regular))
                    .foregroundColor(header ? tokens.tx1 : tokens.tx2)
                    .multilineTextAlignment(textAlignment(pair.offset))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: frameAlignment(pair.offset))
            }
        }
        .padding(.horizontal, Metrics.spacing.sp2)
        .padding(.vertical, Metrics.spacing.sp2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(header ? tokens.panel : Color.clear)
    }

    private func textAlignment(_ column: Int) -> TextAlignment {
        switch table.alignment(column) {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }

    private func frameAlignment(_ column: Int) -> Alignment {
        switch table.alignment(column) {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }
}

// MARK: - Step rows
//
// §8 step row: one line per tool call inside a grouped container —
// `[status dot] [verb] [target, mono, ellipsised] [duration]`, 13px,
// background `panel`, hairline `border-subtle` between rows, radius `--r-md`.
// Verb is 600 weight `tx2`; target is 12px mono `tx4`. Output is collapsed by
// default, revealed inline on `inset` in 12px mono when the row is tapped.

enum StepStatus: Hashable {
    case running
    case done
}

struct ToolStep: Identifiable, Hashable {
    let id = UUID()
    let verb: String
    let target: String
    let duration: String
    let status: StepStatus
    let output: String?
}

struct StepRowView: View {
    let step: ToolStep
    let tokens: Tokens
    @State private var revealed = false

    var body: some View {
        VStack(spacing: 0) {
            Button(action: { revealed.toggle() }) {
                HStack(spacing: Metrics.spacing.sp2) {
                    Circle()
                        .fill(dotColor)
                        .frame(width: Metrics.type.stepDot, height: Metrics.type.stepDot)
                    // §8: a step row is ONE line. The verb is normally a word
                    // ("Ran", "Read"), but a tool name can be long enough to
                    // wrap, which broke the row's fixed height and made the
                    // group read as ragged. It truncates rather than wraps, and
                    // never shrinks below its share of the row.
                    Text(step.verb)
                        .font(.system(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.semibold)))
                        .foregroundColor(tokens.tx2)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .layoutPriority(1)
                    Text(step.target)
                        .font(.system(size: Metrics.type.xs, design: .monospaced))
                        .foregroundColor(tokens.tx4)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 0)
                    Text(step.duration)
                        .font(.system(size: Metrics.type.twoXS))
                        .foregroundColor(tokens.tx4)
                }
                .padding(.vertical, Metrics.type.stepRowY)
                .padding(.horizontal, Metrics.spacing.sp3)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if revealed, let output = step.output {
                Text(output)
                    .font(.system(size: Metrics.type.xs, design: .monospaced))
                    .foregroundColor(tokens.tx3)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, Metrics.spacing.sp2)
                    .padding(.horizontal, Metrics.spacing.sp3)
                    .background(tokens.inset)
                    .accessibilityIdentifier("step-output")
            }
        }
    }

    private var dotColor: Color {
        switch step.status {
        case .running: return tokens.accent
        case .done: return tokens.ok
        }
    }
}

// A row inside a grouped container is either a one-action tool call or an
// agent session. §8a: "A subagent is not a tool call, and must not be styled
// as one" — it is a session, so it lives in the same grouped container as the
// step rows (so a turn reads as one sequence) but is rendered as a
// navigation row, not a step.
enum StepGroupRow: Identifiable {
    case step(ToolStep)
    case subagent(SubagentSession)

    var id: String {
        switch self {
        case .step(let step): return step.id.uuidString
        case .subagent(let agent): return agent.id
        }
    }
}

enum StepGroupContent {
    case rows([StepGroupRow])
    case rollup(summary: String, rows: [StepGroupRow])
}

struct StepGroupView: View {
    let content: StepGroupContent
    let tokens: Tokens
    @State private var rollupExpanded = false

    var body: some View {
        Group {
            switch content {
            case .rows(let rows):
                rowsView(rows)
            case .rollup(let summary, let rows):
                VStack(spacing: 0) {
                    Button(action: { rollupExpanded.toggle() }) {
                        // The roll-up chevron is the leading `▸` already in the
                        // summary string (mockup `.group`), rendered at 12px
                        // mono — no separate glyph, no extra size literal.
                        Text(summary)
                            .lineLimit(1)
                            .font(.system(size: Metrics.type.xs, design: .monospaced))
                            .foregroundColor(tokens.tx4)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, Metrics.type.stepRowY)
                            .padding(.horizontal, Metrics.spacing.sp3)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if rollupExpanded {
                        rowsView(rows)
                    }
                }
            }
        }
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.radius.md)
                .stroke(tokens.borderSubtle, lineWidth: Metrics.spacing.spPx)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("step-rows")
    }

    @ViewBuilder
    private func rowsView(_ rows: [StepGroupRow]) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                rowView(row)
                if index < rows.count - 1 {
                    tokens.borderSubtle.frame(height: Metrics.spacing.spPx)
                }
            }
        }
    }

    @ViewBuilder
    private func rowView(_ row: StepGroupRow) -> some View {
        switch row {
        case .step(let step):
            StepRowView(step: step, tokens: tokens)
        case .subagent(let agent):
            SubagentRowView(agent: agent, tokens: tokens)
        }
    }
}

// MARK: - Subagents (§8a) — a drill-in screen, not an inline expansion
//
// A subagent is a session, not a tool call: it streams, owns its own steps and
// tokens, and can still be running after the parent has moved on. §8a's row is
// `[agent glyph] [name] [live status] [chevron]` inside the same grouped
// container as the step rows; tapping PUSHES a screen (its own header + its own
// transcript, rendered with exactly the parent's components), never an inline
// expansion or a sheet. The child screen is read-only in v1.

enum SubagentStatus: Hashable {
    case running
    case done
}

struct SubagentSession: Identifiable, Hashable {
    /// STABLE across rebuilds — the child opencode session id when there is
    /// one. It used to be a fresh `UUID()` minted in `init`, and the transcript
    /// is re-derived from scratch on every streamed event, so the value pushed
    /// onto the NavigationStack stopped matching anything in the current
    /// transcript within milliseconds. That is what made a tap on a subagent
    /// row land on the wrong screen and reveal the right one only after going
    /// back: navigation identity has to outlive a re-render.
    let id: String
    let taskName: String
    let status: SubagentStatus
    // Live duration (e.g. "1m12s") while running; nil when done.
    let duration: String?
    let transcript: [TranscriptBlock]
    /// The opencode child session this agent runs in, when known (S4). The
    /// chat screen pushes a LIVE child screen bound to this session id
    /// (BET-576); the S4b fixture leaves it nil (there is no child session).
    let childSessionId: String?

    init(taskName: String, status: SubagentStatus, duration: String?, transcript: [TranscriptBlock], childSessionId: String? = nil) {
        // Fixtures carry no child session, so they fall back to the task name.
        self.id = childSessionId ?? "task:\(taskName)"
        self.taskName = taskName
        self.status = status
        self.duration = duration
        self.transcript = transcript
        self.childSessionId = childSessionId
    }

    // Navigation values are compared by identity, never by deep transcript
    // equality (which would also recurse). The transcript is content the
    // destination view reads, not something that defines the route.
    static func == (lhs: SubagentSession, rhs: SubagentSession) -> Bool {
        lhs.id == rhs.id
    }
    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }

    /// The row's status text: a live duration while running, `done` otherwise.
    var statusText: String {
        switch status {
        case .running: return duration ?? ""
        case .done: return "done"
        }
    }

    /// The child header's subtitle (§8a): `subagent · running 1m12s` or
    /// `subagent · done`. Pure content, not a design literal.
    var subtitle: String {
        switch status {
        case .running: return "subagent · running \(duration ?? "")"
        case .done: return "subagent · done"
        }
    }
}

// The single transcript renderer shared by the parent and every child screen.
// A subagent's transcript renders through EXACTLY the same components as the
// parent (§8a) — the whole point of the drill-in is that a child is a session,
// not a different kind of thing. There is deliberately no second renderer.
struct TranscriptView: View {
    let blocks: [TranscriptBlock]
    let tokens: Tokens

    var body: some View {
        VStack(spacing: 0) {
            // Iterate over the ELEMENTS, never over indices. `ForEach(blocks
            // .indices, id: \.self)` re-subscripts the array inside the row
            // builder, and SwiftUI evaluates that builder against indices it
            // captured on a previous pass — so the moment the transcript SHRINKS
            // (which it does on every turn boundary, when the streamed prose
            // tail is absorbed into the refetched canonical transcript) a stale
            // index traps "Index out of range" and the app dies. That is the
            // crash on opening a session: the first refetch lands while the
            // first render is still in flight.
            ForEach(Array(blocks.enumerated()), id: \.offset) { pair in
                blockView(pair.element)
            }
        }
    }

    @ViewBuilder
    private func blockView(_ block: TranscriptBlock) -> some View {
        switch block {
        case .user(let text):
            UserBand(text: text, tokens: tokens)
                .padding(.bottom, Metrics.spacing.sp4)
        case .prose(let text):
            AssistantProse(text: text, tokens: tokens)
        case .steps(let content):
            // Machinery is inset to the same margin as prose. Only the USER
            // band is full-bleed (§8) — that edge-to-edge treatment is what
            // marks a turn boundary, so letting tool cards share it made every
            // step group read as a message.
            StepGroupView(content: content, tokens: tokens)
                .padding(.horizontal, Metrics.spacing.sp3)
                .padding(.bottom, Metrics.spacing.sp3)
        }
    }
}

enum TranscriptBlock {
    case user(String)
    case prose(String)
    case steps(StepGroupContent)
}

// MARK: - "Load earlier messages"
//
// A session opens on a WINDOW of its most recent messages, not the whole
// history — pulling every message of a long session was most of the wait to
// open one, and nearly all of it lands far out of view. This row is how the
// user reaches back past the window; it appears only when the box says there
// is more (a full page came back).
struct LoadEarlierRow: View {
    let loading: Bool
    let tokens: Tokens
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if loading {
                    ProgressView()
                } else {
                    Text("Load earlier messages")
                        .font(.system(size: Metrics.type.small))
                        .foregroundColor(tokens.tx3)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Metrics.spacing.sp3)
        }
        .buttonStyle(.plain)
        .disabled(loading)
        .accessibilityIdentifier("load-earlier")
    }
}

// §8a agent-row treatment: `[agent glyph] [name] [live status] [chevron]`.
// The glyph is a 16px `accent-soft` tile; the name is 600 weight `tx1` — a task
// name, never a command; the status is a live duration while running; the
// chevron means "there is more here", not "expand this output". A tap pushes
// the child screen rather than expanding inline.
struct SubagentRowView: View {
    let agent: SubagentSession
    let tokens: Tokens

    var body: some View {
        NavigationLink(value: agent) {
            HStack(spacing: Metrics.spacing.sp2) {
                RoundedRectangle(cornerRadius: Metrics.radius.xs)
                    .fill(tokens.accentSoft)
                    .frame(width: Metrics.spacing.sp4, height: Metrics.spacing.sp4)
                Text(agent.taskName)
                    .font(.system(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.semibold)))
                    .foregroundColor(tokens.tx1)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(agent.statusText)
                    .font(.system(size: Metrics.type.twoXS))
                    .foregroundColor(tokens.tx4)
                Text("›")
                    .font(.system(size: Metrics.type.small))
                    .foregroundColor(tokens.tx4)
            }
            .padding(.vertical, Metrics.type.stepRowY)
            .padding(.horizontal, Metrics.spacing.sp3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("agent-row")
    }
}

// The child drill-in screen (§8a). Its own header (task name + the
// `subagent · running 1m12s` / `subagent · done` subtitle) above its OWN
// transcript, rendered with the parent's components via TranscriptView.
// Read-only in v1: no composer, no prompt entry, no write affordance. Pushing
// it (not an inline expansion or a sheet) leaves the parent's scroll position
// untouched and keeps the child alive in the stack. NOTE: the transcript is a
// frozen `agent.transcript` value this fixture stage — live streaming while
// open is deferred until a real observable subagent store exists; this view's
// transcript input is the single seam to rewire to that source then (see
// mobile/native/FINDINGS.md).
struct SubagentScreen: View {
    let agent: SubagentSession
    let tokens: Tokens
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            SubagentHeader(
                title: agent.taskName,
                subtitle: agent.subtitle,
                onBack: { dismiss() },
                tokens: tokens
            )
            ScrollView {
                TranscriptView(blocks: agent.transcript, tokens: tokens)
            }
        }
        .background(tokens.canvas.ignoresSafeArea())
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("subagent-scene")
    }
}

// The child's two-line centred header (§8): task name (600 `tx1`, ellipsised)
// with the `subagent · …` status as a 500 `tx4` subtitle beneath, and a back
// chevron on the leading edge. No trailing affordance — the child is read-only.
struct SubagentHeader: View {
    let title: String
    let subtitle: String
    let onBack: () -> Void
    let tokens: Tokens

    var body: some View {
        HStack(spacing: Metrics.spacing.sp2) {
            Button(action: onBack) {
                Text("‹")
                    .font(.system(size: Metrics.type.body))
                    .foregroundColor(tokens.accent)
                    .padding(Metrics.spacing.sp2)
                    .contentShape(Rectangle())
                    .accessibilityIdentifier("subagent-back")
            }
            .buttonStyle(.plain)

            Spacer(minLength: 0)

            VStack(spacing: Metrics.spacing.spPx) {
                Text(title)
                    .font(.system(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.semibold)))
                    .foregroundColor(tokens.tx1)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(subtitle)
                    .font(.system(size: Metrics.type.twoXS, weight: mantaFontWeight(Metrics.type.medium)))
                    .foregroundColor(tokens.tx4)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("subagent-header")
    }
}

// `line-height` in CSS is a multiplier over font size; SwiftUI's lineSpacing is
// additional points between lines. Approximate the multiplier by adding
// (multiplier - 1) * size points. Single-line text is unaffected (no extra
// line), which keeps the capture fixture's row heights deterministic.
@MainActor
private func pointsFor(multiplier: CGFloat, size: CGFloat) -> CGFloat {
    max(0, (multiplier - 1) * size)
}

// MARK: - Shimmer

/// A slow highlight sweeping across a placeholder, so a loading skeleton reads
/// as "content is coming" rather than as empty grey boxes that might be the
/// real, broken UI. Purely decorative: it carries no state and is skipped
/// entirely when `active` is false.
private struct Shimmer: ViewModifier {
    let active: Bool
    let tokens: Tokens
    @State private var phase: CGFloat = -1

    func body(content: Content) -> some View {
        if !active {
            content
        } else {
            content
                .overlay {
                    GeometryReader { geo in
                        LinearGradient(
                            colors: [.clear, tokens.canvas.opacity(0.65), .clear],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(width: geo.size.width * 0.6)
                        .offset(x: phase * geo.size.width * 1.6)
                    }
                }
                .clipped()
                .onAppear {
                    withAnimation(.linear(duration: 1.3).repeatForever(autoreverses: false)) {
                        phase = 1
                    }
                }
        }
    }
}

extension View {
    func shimmer(active: Bool, tokens: Tokens) -> some View {
        modifier(Shimmer(active: active, tokens: tokens))
    }
}
