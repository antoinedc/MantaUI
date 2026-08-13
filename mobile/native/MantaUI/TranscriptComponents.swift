import Foundation
import SwiftUI
import MarkdownView

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


// MARK: - Manta prose
//
// THE single wrapper seam for assistant prose. Every place that renders
// assistant text goes through this view, which delegates to the MarkdownView
// library (LiYanan2004/MarkdownView, built on swift-markdown) — so a future
// library swap touches exactly one file. Style is mapped from the generated
// tokens exactly as the hand-rolled renderer did: body text at the body
// size / tx1 colour / prose line-height, code in the mono face at the code
// size, links in the accent colour, headings kept near body size (a transcript
// turn is not a document — an h1 set at display size would shout over the user
// band).
struct MantaProse: View {
    let text: String
    let tokens: Tokens

    var body: some View {
        MarkdownView(text)
            .font(.system(size: Metrics.type.body), for: .body)
            .font(.system(size: Metrics.type.body + 4, weight: .semibold), for: .h1)
            .font(.system(size: Metrics.type.body + 2, weight: .semibold), for: .h2)
            .font(.system(size: Metrics.type.body + 1, weight: .semibold), for: .h3)
            .font(.system(size: Metrics.type.body, weight: .semibold), for: .h4)
            .font(.system(size: Metrics.type.body, weight: .semibold), for: .h5)
            .font(.system(size: Metrics.type.body, weight: .semibold), for: .h6)
            .font(.system(size: Metrics.type.xs, design: .monospaced), for: .codeBlock)
            // Tables run at the small size, not body — on a phone column a
            // body-size table wraps every cell into a tower. Header gets the
            // semibold weight like desktop's th.
            .font(.system(size: Metrics.type.small, weight: .semibold), for: .tableHeader)
            .font(.system(size: Metrics.type.small), for: .tableBody)
            .foregroundColor(tokens.tx1)
            .lineSpacing(pointsFor(multiplier: Metrics.type.proseLineHeight, size: Metrics.type.body))
            .tint(tokens.accent, for: .link)
            // Inline code: the library renders `code` spans as tint-colored
            // text on tint@10% background (MarkdownView 3.0.0 exposes no
            // inline-code FONT slot, so mono isn't reachable here). Untinted it
            // used the loud system accent; tx2 gives the subtle grey-on-grey
            // treatment desktop uses.
            .tint(tokens.tx2, for: .inlineCodeBlock)
            // Blockquote bar in the border grey (desktop: 2px var(--border)),
            // not the default accent.
            .tint(tokens.border, for: .blockQuote)
            .markdownTableStyle(MantaMarkdownTableStyle(tokens: tokens))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.bottom, Metrics.spacing.sp3)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("assistant-prose")
    }
}

// MARK: - Live prose (the streaming tail, BET-752 §4.4 task 1)
//
// The one `.prose` row that is NOT a completed canonical block: the LIVE
// streaming tail. Its text grows on every `stream:flush`, so rebuilding the
// full `MarkdownView(text)` from scratch each flush re-parses the whole
// accumulated turn — O(n²) markdown work that janks late in long answers.
//
// The live tail therefore renders as a lightweight plain `Text` (no markdown
// parse) at the same metrics/padding as `MantaProse`, so the transient stream
// stays visually continuous and the completed canonical block restores real
// markdown the moment the turn-boundary refetch replaces it (the refetch is the
// source of truth; this is only the live tail path, per the issue).
struct LiveProseTail: View {
    let text: String
    let tokens: Tokens

    var body: some View {
        Text(text)
            .font(.system(size: Metrics.type.body))
            .foregroundColor(tokens.tx1)
            .lineSpacing(pointsFor(multiplier: Metrics.type.proseLineHeight, size: Metrics.type.body))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.bottom, Metrics.spacing.sp3)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("live-tail")
    }
}

// MARK: - Markdown table style
//
// Token-mapped GFM table, mirroring desktop's MarkdownBody table treatment:
// hairline `borderSubtle` rules between cells, a `border` outline, header row
// on `fill`, cell padding on the spacing grid (sp2 × sp1 ≈ desktop's px-3
// py-1 scaled for the phone column). The library's default style is what made
// tables read huge — body-size text inside 8pt cell padding inside a 12pt
// frame inside a 20pt-radius outline.
struct MantaMarkdownTableStyle: MarkdownTableStyle {
    let tokens: Tokens

    func makeBody(configuration: Configuration) -> some View {
        Grid(horizontalSpacing: 0, verticalSpacing: 0) {
            configuration.table.header
                .markdownTableRowBackgroundStyle(AnyShapeStyle(tokens.fill))
            ForEach(Array(configuration.table.rows.enumerated()), id: \.offset) { _, row in
                row
            }
        }
        .markdownTableCellOverlay {
            Rectangle().strokeBorder(tokens.borderSubtle)
        }
        .markdownTableCellPadding(.horizontal, Metrics.spacing.sp2)
        .markdownTableCellPadding(.vertical, Metrics.spacing.sp1)
        .overlay {
            Rectangle().strokeBorder(tokens.border)
        }
    }
}

// ===========================================================================
// Capture-harness scene (MANTA_SCENE=chat-markdown).
//
// A deterministic fixture that renders the REAL `MantaProse` wrapper against a
// sample assistant turn — bold/italic/inline code, a fenced code block, and a
// GFM table — the BET-671 acceptance fixtures. Reachable with no live paired
// box, mirroring the D2 `ChatLoadingScene` pattern. It exists to be driven by
// the capture harness, not shipped as app UI.
// ===========================================================================

struct MantaProseCaptureScene: View {
    private static let sample = """
    This turn has **bold**, *italic*, and `inline code`.

    ```swift
    let greeting = "hello"
    ```

    | Latency | On-device |
    |---|---|
    | record → upload | live partials |
    """

    @Environment(\.colorScheme) private var colorScheme

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        ZStack {
            tokens.canvas.ignoresSafeArea()
            ScrollView {
                MantaProse(text: Self.sample, tokens: tokens)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-markdown-scene")
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
    /// STABLE across rebuilds — the mapper derives it deterministically from
    /// the wire data (see `ChatTranscriptMapper.step(from:...)`), so a step's
    /// identity survives a canonical refetch. It used to be a fresh random id
    /// minted on every mapping pass, which made the diffing list see every
    /// step as removed+reinserted at each turn boundary and made the rows
    /// flash/jump (same bug the subagent rows already fixed).
    let id: String
    let verb: String
    let target: String
    let duration: String
    let status: StepStatus
    let output: String?

    init(id: String, verb: String, target: String, duration: String, status: StepStatus, output: String?) {
        self.id = id
        self.verb = verb
        self.target = target
        self.duration = duration
        self.status = status
        self.output = output
    }
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
enum StepGroupRow: Identifiable, Equatable {
    case step(ToolStep)
    case subagent(SubagentSession)

    var id: String {
        switch self {
        case .step(let step): return step.id
        case .subagent(let agent): return agent.id
        }
    }
}

enum StepGroupContent: Equatable {
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

    /// Live drag offset, negative (leftward) and clamped to the strip width.
    /// `@GestureState` resets itself the instant the finger lifts, which is what
    /// springs the transcript back with no release handler of our own.
    @GestureState private var gutterReveal: CGFloat = 0

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
                transcriptBlockView(pair.element, tokens: tokens)
                    // The timestamp rides WITH its own block rather than living
                    // in a parallel column, so it stays aligned to the thing it
                    // describes no matter how tall that thing is. An overlay
                    // takes no part in layout, and the offset parks it just
                    // outside the trailing edge, so nothing about the transcript
                    // at rest changes: it is off screen until the slide brings
                    // it in, and the scroll view clips it the rest of the time.
                    .overlay(alignment: .trailing) {
                        TimestampGutterLabel(
                            date: pair.element.timestamp,
                            width: TranscriptGutter.gutterWidth,
                            tokens: tokens
                        )
                        .offset(x: TranscriptGutter.gutterWidth)
                    }
            }
        }
        // The whole transcript slides as ONE piece, the way Messages does it —
        // per-row swiping would read as "act on this message" (reply/delete),
        // which is a different gesture with a different outcome.
        .offset(x: gutterReveal)
        .animation(.interactiveSpring(response: 0.28, dampingFraction: 0.86), value: gutterReveal)
        .simultaneousGesture(gutterGesture)
    }

    /// Horizontal-only drag that reveals the timestamps.
    ///
    /// Simultaneous with the scroll view's own pan, and deliberately inert
    /// unless the movement is clearly sideways and leftward: a vertical scroll
    /// (or a rightward drag, which is the navigation back-swipe) leaves the
    /// offset at zero, so neither gesture is stolen from the other.
    private var gutterGesture: some Gesture {
        DragGesture(minimumDistance: 16)
            .updating($gutterReveal) { value, state, _ in
                let dx = value.translation.width
                let dy = value.translation.height
                guard dx < 0, -dx > abs(dy) * 1.5 else {
                    state = 0
                    return
                }
                let progress = min(1, -dx / TranscriptGutter.gutterTravel)
                state = -TranscriptGutter.gutterWidth * progress
            }
    }
}

/// The wall-clock time shown in the strip a leftward slide opens up.
///
/// Fixed width so every timestamp lands on the same vertical line — a gutter
/// that ragged-edges as the values change reads as a glitch. Blocks with no
/// time (machinery) render an empty label of the same width rather than
/// collapsing, which keeps the rows they sit next to from shifting.
struct TimestampGutterLabel: View {
    let date: Date?
    let width: CGFloat
    let tokens: Tokens

    var body: some View {
        Text(ChatClock.time(date))
            .font(.system(size: Metrics.type.twoXS))
            .foregroundColor(tokens.tx4)
            .monospacedDigit()
            .lineLimit(1)
            .frame(width: width, alignment: .center)
            .accessibilityHidden(true)
    }
}

enum TranscriptBlock: Equatable {
    // The date is the block's wall-clock time, shown only in the swipe-to-reveal
    // gutter. Machinery (`.steps`) carries none: a step row already states how
    // long it took, and a second time reading next to it is noise, not detail.
    case user(String, at: Date?)
    case prose(String, at: Date?)
    case steps(StepGroupContent)

    /// The time shown in the gutter; nil for blocks that have none.
    var timestamp: Date? {
        switch self {
        case .user(_, let at), .prose(_, let at): return at
        case .steps: return nil
        }
    }
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
