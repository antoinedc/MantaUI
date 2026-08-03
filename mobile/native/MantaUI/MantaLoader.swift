import SwiftUI

// ===========================================================================
// The app's one loading state.
//
// Ported from the retired web client's ConnectingScreen (deleted in BET-559):
// the Manta mark on an accent tile, inside two counter-rotating rings — the
// outer sweeping clockwise from the top, the inner anticlockwise and softer.
// It is the app's established "we are waiting on the box" image, and reusing it
// means a session load, a connect and any future wait all look like the same
// thing rather than three different grey placeholders.
//
// Deliberately ONE component with a caption, not a family: every caller passes
// its own label so the visual is identical everywhere it appears.
// ===========================================================================

struct MantaLoader: View {
    var caption: String?
    var tokens: Tokens

    @State private var outer = false
    @State private var inner = false

    private let size: CGFloat = 92
    private let tile: CGFloat = 46

    var body: some View {
        VStack(spacing: Metrics.spacing.sp4) {
            ZStack {
                // Outer ring: one accent arc, clockwise.
                Circle()
                    .trim(from: 0, to: 0.28)
                    .stroke(tokens.accent, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .frame(width: size, height: size)
                    .rotationEffect(.degrees(outer ? 360 : 0))

                // Inner ring: softer, slower, and turning the other way — which
                // is what stops the pair reading as a single spinning circle.
                Circle()
                    .trim(from: 0, to: 0.22)
                    .stroke(tokens.accent.opacity(0.4), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .frame(width: size - 20, height: size - 20)
                    .rotationEffect(.degrees(inner ? -360 : 0))

                mark
            }
            .frame(width: size, height: size)
            .accessibilityHidden(true)

            if let caption {
                Text(caption)
                    .font(.system(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
                    .foregroundColor(tokens.tx4)
                    .accessibilityLabel(caption)
            }
        }
        .onAppear {
            withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { outer = true }
            withAnimation(.linear(duration: 1.4).repeatForever(autoreverses: false)) { inner = true }
        }
    }

    /// The manta mark: the same single stroke the web client drew, on the
    /// accent tile with its soft drop shadow.
    private var mark: some View {
        RoundedRectangle(cornerRadius: 13, style: .continuous)
            .fill(
                LinearGradient(
                    colors: [tokens.accent, tokens.accentSoft],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .frame(width: tile, height: tile)
            .shadow(color: tokens.accent.opacity(0.3), radius: 9, x: 0, y: 6)
            .overlay {
                MantaMark()
                    .stroke(tokens.onAccent, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .frame(width: 24, height: 24)
            }
    }
}

/// `M3 17c3-6 6-9 9-9s6 3 9 9` from the web mark, in a 24×24 box.
private struct MantaMark: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 24
        var p = Path()
        p.move(to: CGPoint(x: 3 * s, y: 17 * s))
        p.addCurve(
            to: CGPoint(x: 12 * s, y: 8 * s),
            control1: CGPoint(x: 6 * s, y: 11 * s),
            control2: CGPoint(x: 9 * s, y: 8 * s)
        )
        p.addCurve(
            to: CGPoint(x: 21 * s, y: 17 * s),
            control1: CGPoint(x: 15 * s, y: 8 * s),
            control2: CGPoint(x: 18 * s, y: 11 * s)
        )
        return p
    }
}
