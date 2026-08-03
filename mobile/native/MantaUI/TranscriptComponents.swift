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
// BLOCK-level markdown (headings, lists, fenced code, thematic breaks) is
// still unrendered; that needs a real block parser and its own components,
// which is a separate piece of work, not something to fake here.
enum MantaInlineMarkdown {
    static func render(_ raw: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: raw, options: options)) ?? AttributedString(raw)
    }
}

// MARK: - Assistant prose
//
// §8: full width, `tx1`, 15px/`--prose-lh`, margin-bottom `--sp-3`.
struct AssistantProse: View {
    let text: String
    let tokens: Tokens

    var body: some View {
        // `fixedSize(horizontal: false, …)` is what keeps a long unbreakable
        // token (a shell command, a URL, a path) INSIDE the screen. Without it
        // such a token makes the text demand its full unwrapped width, the
        // scroll view adopts that width, and every sibling — including the
        // composer, which shares the same layout — is laid out wider than the
        // display: text stops appearing to wrap, the send button sits off
        // screen, and each keystroke re-lays out an oversized view, which is
        // what made typing crawl.
        Text(MantaInlineMarkdown.render(text))
            .font(.system(size: Metrics.type.body))
            .foregroundColor(tokens.tx1)
            .lineSpacing(pointsFor(multiplier: Metrics.type.proseLineHeight, size: Metrics.type.body))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.bottom, Metrics.spacing.sp3)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("assistant-prose")
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
