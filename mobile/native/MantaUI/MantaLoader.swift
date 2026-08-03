import SwiftUI
import UIKit

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

    /// The REAL Manta mark, the same artwork as the app icon
    /// (assets/icons/512x512.png, bundled as Resources/logo/manta-logo.png).
    /// It is deliberately the shipped asset rather than a redrawn approximation
    /// — a hand-rolled path is a second, drifting copy of the brand.
    private var mark: some View {
        // Loaded by name from the bundle: the PNG is a loose resource, not an
        // asset-catalog entry, so both spellings are tried.
        Image(uiImage: UIImage(named: "manta-logo") ?? UIImage(named: "manta-logo.png") ?? UIImage())
            .resizable()
            .scaledToFit()
            .frame(width: tile, height: tile)
    }
}
