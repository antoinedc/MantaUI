import SwiftUI

// ===========================================================================
// D2 / BET-631 — the transcript-shaped session-loading skeleton.
//
// Single source of truth for the "opening a chat" placeholder: three greyed
// blocks at the user-band / prose / step-group rhythm, shown in place of the
// transcript while a session's first fetch is in flight. It occupies the same
// scroll region the real transcript will, so the first blocks replacing it
// cause no layout shift — and there is deliberately no full-screen spinner
// (which would discard the scroll anchor and flash on a warm reopen).
//
// Extracted out of ChatScreen so the capture-harness fixture scene
// (`ChatLoadingScene`, SCENE_MODE=chat-loading) renders the SAME skeleton the
// live chat screen shows during load — one definition, no copy, no drift.
//
// No colour/spacing/radius/size/weight literal; every value resolves through
// the generated tokens.
// ===========================================================================

struct ChatLoadingSkeleton: View {
    @Environment(\.colorScheme) private var colorScheme

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                userBand
                    .padding(.bottom, Metrics.spacing.sp4)
                prose
                stepGroup
            }
        }
        .defaultScrollAnchor(.bottom)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("loading-skeleton")
    }

    /// Greyed block in the shape of a user band (§8): a full-bleed `fill` band
    /// with a leading edge, holding two placeholder body lines.
    private var userBand: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            line(height: bodyLine)
            line(height: bodyLine)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Metrics.spacing.sp3)
        .background(tokens.fill, in: UnevenRoundedRectangle(
            topLeadingRadius: 0,
            bottomLeadingRadius: 0,
            bottomTrailingRadius: Metrics.radius.md,
            topTrailingRadius: Metrics.radius.md
        ))
        .overlay(alignment: .leading) {
            tokens.borderSubtle
                .frame(width: Metrics.spacing.spPx * 2)
        }
    }

    /// Greyed prose block: placeholder body lines at the prose rhythm.
    private var prose: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            line(height: bodyLine)
            line(height: bodyLine)
            line(height: bodyLine)
        }
        .padding(.top, Metrics.spacing.sp1)
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.bottom, Metrics.spacing.sp3)
    }

    /// Greyed step-group block: a `panel` container with placeholder step rows
    /// and hairlines between them, echoing the step-row geometry.
    private var stepGroup: some View {
        VStack(spacing: 0) {
            ForEach(0..<3, id: \.self) { index in
                HStack(spacing: Metrics.spacing.sp2) {
                    Circle()
                        .fill(tokens.inset)
                        .frame(width: Metrics.type.stepDot, height: Metrics.type.stepDot)
                    line(height: smallLine)
                }
                .padding(.vertical, Metrics.type.stepRowY)
                .padding(.horizontal, Metrics.spacing.sp3)
                if index < 2 {
                    Rectangle()
                        .fill(tokens.borderSubtle)
                        .frame(height: Metrics.spacing.spPx)
                }
            }
        }
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.bottom, Metrics.spacing.sp3)
    }

    /// A single grey placeholder bar, at the base of a text line's cap height.
    private func line(height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: Metrics.radius.xs)
            .fill(tokens.inset)
            .frame(maxWidth: .infinity)
            .frame(height: height)
    }

    /// The rendered height of a body line at the prose leading.
    private var bodyLine: CGFloat { Metrics.type.body * Metrics.type.proseLineHeight }

    /// The rendered height of a small (13px) line at the UI leading.
    private var smallLine: CGFloat { Metrics.type.small * Metrics.type.uiLineHeight }
}

// ===========================================================================
// Capture-harness scene (SCENE_MODE=chat-loading / MANTA_SCENE=chat-loading).
//
// A deterministic measurement fixture for the D2 loading state: the app canvas
// with the real `ChatLoadingSkeleton` — the same ones `ChatScreen` renders while
// `ChatSessionStore.loading` is true — shown in place of the transcript. This is
// how the transient "opening a chat" state is evidenced on-device without a
// live paired box (which is unreachable from the capture harness: reaching a
// real ChatScreen needs a working `tmux:list` + open session).
// ===========================================================================

struct ChatLoadingScene: View {
    @Environment(\.colorScheme) private var colorScheme

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        ZStack {
            tokens.canvas.ignoresSafeArea()
            ChatLoadingSkeleton()
        }
    }
}
