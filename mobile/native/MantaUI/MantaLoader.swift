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
//
// Two SIZES, though — not two designs. The full waiting state and the inline
// running row draw the same object at different diameters (see
// `MantaLoaderSize`), so a wait always looks like the same thing, big or small.
// ===========================================================================

/// The loader's two forms. `screen` is the full waiting state (a session
/// opening); `inline` is the running row, beside 13pt text. The two share
/// one geometry so a wait always looks like the same object — the desktop
/// client (src/renderer/MantaLoader.tsx) draws the same pair.
enum MantaLoaderSize {
    case inline
    case screen

    /// Outer diameter.
    var diameter: CGFloat { self == .screen ? 92 : 24 }
    /// Arc weight. Pinned at 2 below `screen` rather than scaled: holding
    /// the 92pt ratio at 24pt gives a 0.8pt hairline that disappears
    /// against the transcript, so the small form is deliberately heavier.
    var stroke: CGFloat { self == .screen ? 3 : 2 }
}

struct MantaLoader: View {
    var caption: String? = nil
    var tokens: Tokens
    var size: MantaLoaderSize = .screen

    @State private var outer = false
    @State private var inner = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Whether the loader animates at all. The two counter-rotating rings run
    /// `repeatForever` regardless of the user's accessibility setting; with
    /// "Reduce Motion" on they should render static instead (BET-752 task 4).
    /// Pure so the guard is unit-testable without driving the view environment.
    nonisolated static func shouldAnimate(reduceMotion: Bool) -> Bool { !reduceMotion }

    private var diameter: CGFloat { size.diameter }
    private var stroke: CGFloat { size.stroke }

    // The ratios the old 92pt/46pt/72pt numbers already encoded (46/92 = 0.5,
    // 72/92 ≈ 0.78) — the same values the desktop uses. Kept as ratios so the
    // inline form is the large form scaled, not a second drawing.
    private static let outerArc: CGFloat = 0.28
    private static let innerArc: CGFloat = 0.22
    private static let innerRatio: CGFloat = 0.78
    private static let markRatio: CGFloat = 0.5

    var body: some View {
        VStack(spacing: Metrics.spacing.sp4) {
            ZStack {
                // Outer ring: one accent arc, clockwise.
                Circle()
                    .trim(from: 0, to: Self.outerArc)
                    .stroke(tokens.accent, style: StrokeStyle(lineWidth: stroke, lineCap: .round))
                    .frame(width: diameter, height: diameter)
                    .rotationEffect(.degrees(outer ? 360 : 0))

                // Inner ring: softer, slower, and turning the other way — which
                // is what stops the pair reading as a single spinning circle.
                Circle()
                    .trim(from: 0, to: Self.innerArc)
                    .stroke(tokens.accent.opacity(0.4), style: StrokeStyle(lineWidth: stroke, lineCap: .round))
                    .frame(width: diameter * Self.innerRatio, height: diameter * Self.innerRatio)
                    .rotationEffect(.degrees(inner ? -360 : 0))

                mark
            }
            .frame(width: diameter, height: diameter)
            .accessibilityHidden(true)

            if let caption {
                Text(caption)
                    .font(.manta(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
                    .foregroundColor(tokens.tx4)
                    .accessibilityLabel(caption)
            }
        }
        .onAppear {
            // Reduce Motion on → a static loader (the arcs at rest, no
            // repeatForever rotation). Off → the usual spin.
            guard Self.shouldAnimate(reduceMotion: reduceMotion) else { return }
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
        // The logo is a bundled resource under Resources/logo, not an asset
        // catalog entry — there is no generated symbol to prefer.
        // swiftlint:disable:next prefer_asset_symbols
        Image(uiImage: UIImage(named: "manta-logo") ?? UIImage(named: "manta-logo.png") ?? UIImage())
            .resizable()
            .scaledToFit()
            .frame(width: diameter * Self.markRatio, height: diameter * Self.markRatio)
    }
}
