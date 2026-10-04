import SwiftUI

// ===========================================================================
// Tool activity UI (spec §1.3 and §1.5).
//
// A run of tool calls is ONE quiet line in the transcript (`ActivityRunRowView`):
// status dot · summary · "· N failed" · chevron. Tapping it — or the working
// line, while the run is still the tail of a running turn — opens the Activity
// sheet (`ActivitySheet`): one row per call, each expandable in place.
//
// All wording, grouping and detail extraction is the pure, Foundation-only
// ToolActivity.swift (shared parity fixture with the desktop). This file only
// draws it.
// ===========================================================================

/// Which run the Activity sheet is showing. The sheet is keyed by the run's id
/// (its first part's id), which stays stable while the run grows and when it
/// moves from the working line into the transcript — so the sheet survives the
/// transcript re-rendering underneath it.
struct ActivityTarget: Identifiable, Equatable {
    let runID: String
    var id: String { runID }
}

/// The row a transcript run draws. Fixed layout numbers, deliberately not design
/// tokens: 44pt is Apple's HIG tappable-target floor.
private enum ActivityLayout {
    static let minRowHeight: CGFloat = 44
}

// MARK: - Dot / glyph

/// The run's tone dot: accent + pulsing while running, warn when any call
/// failed, ok otherwise (desktop's `groupTone`).
struct ActivityStatusDot: View {
    let tone: GroupTone
    let tokens: Tokens

    var body: some View {
        switch tone {
        case .running:
            dot(tokens.accent).symbolEffect(.pulse)
        case .warn:
            dot(tokens.warn)
        case .ok:
            dot(tokens.ok)
        }
    }

    private func dot(_ color: Color) -> some View {
        Image(systemName: "circle.fill")
            .font(.system(size: Metrics.type.twoXS))
            .foregroundColor(color)
            .accessibilityHidden(true)
    }
}

/// One SF Symbol + one Tokens colour per call state.
private struct ActivityStatusGlyph: View {
    let status: ActivityStatus
    let tokens: Tokens

    var body: some View {
        Group {
            switch status {
            case .pending:
                glyph("circle.dotted", tokens.tx4)
            case .running:
                glyph("circle.fill", tokens.accent).symbolEffect(.pulse)
            case .completed:
                glyph("checkmark.circle.fill", tokens.ok)
            case .error:
                glyph("exclamationmark.circle.fill", tokens.danger)
            }
        }
        .frame(width: Metrics.type.stepDot, height: Metrics.type.stepDot)
        .accessibilityHidden(true)
    }

    private func glyph(_ name: String, _ color: Color) -> some View {
        Image(systemName: name)
            .font(.system(size: Metrics.type.stepDot))
            .foregroundColor(color)
    }
}

// MARK: - The collapsed run row

/// One run of tool calls as a single line. The whole line is the tap target —
/// when there is something to open it with. A surface that cannot present the
/// sheet passes `onOpen: nil` and gets a plain, inert line (never a button that
/// does nothing).
struct ActivityRunRowView: View {
    let run: ToolRun
    let tokens: Tokens
    let onOpen: (() -> Void)?

    var body: some View {
        let summary = run.summary
        Group {
            if let onOpen {
                Button(action: onOpen) { line(summary) }
                    .buttonStyle(.plain)
                    .accessibilityHint("Shows the tool calls")
            } else {
                line(summary)
            }
        }
        .accessibilityLabel(summary.failed > 0 ? "\(summary.label), \(summary.failed) failed" : summary.label)
        .accessibilityIdentifier("activity-run-row")
    }

    private func line(_ summary: GroupSummary) -> some View {
        HStack(spacing: Metrics.spacing.sp2) {
            ActivityStatusDot(tone: summary.tone, tokens: tokens)
            Text(summary.label)
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.tx3)
                .lineLimit(1)
                .truncationMode(.tail)
            if summary.failed > 0 {
                Text("· \(summary.failed) failed")
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.danger)
                    .lineLimit(1)
                    .fixedSize()
            }
            if onOpen != nil {
                Image(systemName: "chevron.right")
                    .font(.manta(size: Metrics.type.xs))
                    .foregroundColor(tokens.tx4)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .frame(minHeight: ActivityLayout.minRowHeight, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

// MARK: - The Activity sheet

/// The detail sheet for one run. Follows the live run: it reads the run from the
/// store on every render, so new calls append and running rows flip to done
/// without the sheet closing.
struct ActivitySheet: View {
    @ObservedObject var store: ChatSessionStore
    let runID: String
    let tokens: Tokens
    /// A task row was tapped. The CALLER dismisses this sheet and pushes the
    /// subagent screen full-screen — a subagent transcript is content
    /// navigation, which does not belong inside a sheet (spec §1.5).
    let onOpenSubagent: (SubagentSession) -> Void

    @Environment(\.dismiss) private var dismiss
    /// The user's own expand/collapse intent per call (part id). User intent
    /// always beats the state-driven default.
    @State private var userToggled: [String: Bool] = [:]

    var body: some View {
        let run = store.activityRun(id: runID)
        NavigationStack {
            Group {
                if let run {
                    callList(run)
                } else {
                    unavailable
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { titleBlock(run) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .accessibilityIdentifier("activity-sheet")
    }

    /// The run summary over "running" or the total duration.
    private func titleBlock(_ run: ToolRun?) -> some View {
        let summary = run?.summary
        let status: String
        if summary?.running == true {
            status = "running"
        } else {
            status = ChatDuration.text(seconds: run?.totalDurationSeconds) ?? ""
        }
        return VStack(spacing: 1) {
            Text(summary?.label ?? "Activity")
                .font(.headline)
                .lineLimit(1)
            if !status.isEmpty {
                Text(status)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func callList(_ run: ToolRun) -> some View {
        let calls = run.summary.calls
        return List {
            ForEach(run.parts, id: \.id) { part in
                ActivityCallRow(
                    part: part,
                    callCount: calls,
                    userToggled: userToggled[part.id],
                    tokens: tokens,
                    onToggle: { userToggled[part.id] = $0 },
                    onOpenSubagent: onOpenSubagent
                )
            }
        }
        .listStyle(.insetGrouped)
    }

    /// The run is no longer anywhere in the transcript (for example the
    /// transcript was replaced under the sheet). Say so instead of showing an
    /// empty list.
    private var unavailable: some View {
        Text("This activity is no longer in the transcript.")
            .font(.manta(size: Metrics.type.small))
            .foregroundColor(tokens.tx3)
            .multilineTextAlignment(.center)
            .padding(Metrics.spacing.sp3)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - One call

/// One call row: status glyph · label · duration, the target under it in mono
/// (middle-truncated), and — tapped — its detail inline.
struct ActivityCallRow: View {
    let part: OpencodePart
    let callCount: Int
    let userToggled: Bool?
    let tokens: Tokens
    let onToggle: (Bool) -> Void
    let onOpenSubagent: (SubagentSession) -> Void

    private var activity: Activity { ToolActivity.describe(part) }
    private var detail: ToolActivity.Detail { ToolActivity.detail(of: part) }

    /// A task is a SESSION, not a tool call: it navigates, it never expands.
    private var subagent: SubagentSession? {
        activity.kind == .task ? ChatSubagentMapper.session(from: part) : nil
    }

    /// A task row is tappable only when its child session is known — a task not
    /// yet stamped with one has nothing to open (no dead tap).
    private var canOpenSubagent: Bool {
        subagent?.childSessionId?.isEmpty == false
    }

    private var expandable: Bool {
        activity.kind != .task && !detail.isEmpty
    }

    private var expanded: Bool {
        expandable && ActivityDisclosure.expanded(
            callCount: callCount,
            status: activity.status,
            isTool: part.type == "tool",
            userToggled: userToggled
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            if expandable || canOpenSubagent {
                Button(action: tap) { header }
                    .buttonStyle(.plain)
            } else {
                header
            }
            if expanded {
                detailView
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("activity-call-row")
    }

    private func tap() {
        if let subagent, canOpenSubagent {
            onOpenSubagent(subagent)
        } else if expandable {
            onToggle(!expanded)
        }
    }

    @MainActor
    private var header: some View {
        let target = ToolActivity.target(of: part)
        return VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            HStack(spacing: Metrics.spacing.sp2) {
                ActivityStatusGlyph(status: activity.status, tokens: tokens)
                Text(activity.label)
                    .font(.manta(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.semibold)))
                    .foregroundColor(tokens.tx1)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
                durationView
                if expandable {
                    Image(systemName: "chevron.right")
                        .font(.manta(size: Metrics.type.xs))
                        .foregroundColor(tokens.tx4)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                } else if canOpenSubagent {
                    // A navigation push, so it is never rotated.
                    Image(systemName: "chevron.right")
                        .font(.manta(size: Metrics.type.xs))
                        .foregroundColor(tokens.tx4)
                }
            }
            if !target.isEmpty {
                Text(target)
                    .font(.manta(size: Metrics.type.xs, design: .monospaced))
                    .foregroundColor(tokens.tx4)
                    .lineLimit(1)
                    // Middle-ellipsis: a long project-root prefix truncates at the
                    // tail and every path under it collapses to the same prefix,
                    // so the part that tells two paths apart survives.
                    .truncationMode(.middle)
                    .padding(.leading, Metrics.type.stepDot + Metrics.spacing.sp2)
            }
        }
        .frame(minHeight: ActivityLayout.minRowHeight, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var durationView: some View {
        if let text = ChatDuration.text(seconds: ToolActivity.durationSeconds(of: part)) {
            durationText(text)
        } else if activity.status == .running, let start = ToolActivity.startMs(of: part) {
            // A running call ticks, so it reads as alive rather than stuck.
            TimelineView(.periodic(from: .now, by: 1)) { context in
                durationText(ChatDuration.text(seconds: max(0, context.date.timeIntervalSince1970 - start / 1000)) ?? "")
            }
        }
    }

    private func durationText(_ text: String) -> some View {
        Text(text)
            .font(.manta(size: Metrics.type.twoXS))
            .monospacedDigit()
            .foregroundColor(tokens.tx4)
    }

    // MARK: Detail

    @ViewBuilder
    private var detailView: some View {
        let d = detail
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            if let command = d.command {
                codeWell(command, lineLimit: 12)
            }
            if let path = d.path {
                codeWell(path, lineLimit: 6)
            }
            if let arguments = d.arguments {
                codeWell(arguments, lineLimit: 8)
            }
            if let diff = d.diff {
                diffWell(diff)
            }
            // An edit's or write's output only ever echoes "applied
            // successfully"; its diff (above) is the record.
            if let output = d.output, activity.kind != .edit, activity.kind != .write {
                codeWell(ToolOutputPreview.tail(output), lineLimit: nil)
            }
            if let error = d.error {
                Text(error)
                    .textSelection(.enabled)
                    .font(.manta(size: Metrics.type.xs, design: .monospaced))
                    .foregroundColor(tokens.danger)
                    .lineLimit(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .accessibilityIdentifier("activity-call-detail")
    }

    private func codeWell(_ text: String, lineLimit: Int?) -> some View {
        Text(text)
            .textSelection(.enabled)
            .font(.manta(size: Metrics.type.xs, design: .monospaced))
            .foregroundColor(tokens.tx3)
            .lineLimit(lineLimit)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Metrics.spacing.sp2)
            .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.xs))
    }

    private func diffWell(_ diff: String) -> some View {
        Text(ActivityDiff.attributed(diff, tokens: tokens))
            .textSelection(.enabled)
            .font(.manta(size: Metrics.type.xs, design: .monospaced))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Metrics.spacing.sp2)
            .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.xs))
    }
}

// MARK: - Diff colouring

/// A unified diff with added lines green, removed lines red, headers quiet.
/// Capped so a huge diff cannot make a self-sizing row enormous.
enum ActivityDiff {
    static let maxLines = 60

    enum LineKind: Equatable {
        case added, removed, header, context
    }

    static func kind(of line: String) -> LineKind {
        if line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("@@") || line.hasPrefix("diff ") || line.hasPrefix("index ") {
            return .header
        }
        if line.hasPrefix("+") { return .added }
        if line.hasPrefix("-") { return .removed }
        return .context
    }

    /// The lines to draw (capped) and whether any were cut.
    static func visibleLines(_ diff: String) -> (lines: [String], truncated: Bool) {
        let all = diff.components(separatedBy: "\n")
        guard all.count > maxLines else { return (all, false) }
        return (Array(all.prefix(maxLines)), true)
    }

    static func attributed(_ diff: String, tokens: Tokens) -> AttributedString {
        let (lines, truncated) = visibleLines(diff)
        var out = AttributedString()
        for (index, line) in lines.enumerated() {
            var piece = AttributedString(index < lines.count - 1 || truncated ? line + "\n" : line)
            switch kind(of: line) {
            case .added: piece.foregroundColor = tokens.ok
            case .removed: piece.foregroundColor = tokens.danger
            case .header: piece.foregroundColor = tokens.tx4
            case .context: piece.foregroundColor = tokens.tx3
            }
            out += piece
        }
        if truncated {
            var more = AttributedString("…")
            more.foregroundColor = tokens.tx4
            out += more
        }
        return out
    }
}
