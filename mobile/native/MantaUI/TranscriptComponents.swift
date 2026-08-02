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

// MARK: - Assistant prose
//
// §8: full width, `tx1`, 15px/`--prose-lh`, margin-bottom `--sp-3`.
struct AssistantProse: View {
    let text: String
    let tokens: Tokens

    var body: some View {
        Text(text)
            .font(.system(size: Metrics.type.body))
            .foregroundColor(tokens.tx1)
            .lineSpacing(pointsFor(multiplier: Metrics.type.proseLineHeight, size: Metrics.type.body))
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
                        .frame(width: 6, height: 6)
                    Text(step.verb)
                        .font(.system(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.semibold)))
                        .foregroundColor(tokens.tx2)
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

enum StepGroupContent {
    case rows([ToolStep])
    case rollup(summary: String, rows: [ToolStep])
}

struct StepGroupView: View {
    let content: StepGroupContent
    let tokens: Tokens
    @State private var rollupExpanded = false

    var body: some View {
        Group {
            switch content {
            case .rows(let steps):
                rowsOverride(steps)
            case .rollup(let summary, let rows):
                VStack(spacing: 0) {
                    Button(action: { rollupExpanded.toggle() }) {
                        HStack(spacing: Metrics.spacing.sp2) {
                            Image(systemName: rollupExpanded ? "chevron.down" : "chevron.right")
                                .font(.system(size: 9, weight: .semibold))
                            Text(summary)
                                .lineLimit(1)
                        }
                        .font(.system(size: Metrics.type.xs, design: .monospaced))
                        .foregroundColor(tokens.tx4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, Metrics.type.stepRowY)
                        .padding(.horizontal, Metrics.spacing.sp3)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if rollupExpanded {
                        rowsOverride(rows)
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
    private func rowsOverride(_ steps: [ToolStep]) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                StepRowView(step: step, tokens: tokens)
                if index < steps.count - 1 {
                    tokens.borderSubtle.frame(height: Metrics.spacing.spPx)
                }
            }
        }
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
