import SwiftUI

// ===========================================================================
// Edge scrim.
//
// The shared fade behind floating chrome — the chat composer, the session
// list's search capsule, and the chat transcript's top edge where it runs
// under the status bar. In every case content scrolls past a control that
// floats over it, and without a fade the two collide.
//
// ONE component because these must match: the same gesture on three surfaces,
// and hand-rolled gradients would drift the first time any of them was retuned.
//
//   * TOP reaches INTO the status bar, where the transcript runs under the
//     clock and the battery. Its ramp goes solid canvas well before the
//     display edge and holds it.
//
//   * BOTTOM dissolves content to solid canvas before it passes behind the
//     floating control. It renders a fixed-height fade band ABOVE the
//     control, then solid canvas over the control itself and the overhang
//     below it — so by the time content reaches the glass it has fully
//     blended into canvas rather than staying faintly visible through it.
// ===========================================================================

struct Scrim: View {
    enum Edge {
        case top
        case bottom
    }

    let edge: Edge
    let tokens: Tokens
    /// How far solid canvas continues BELOW the container's edge.
    ///
    /// The bottom scrim needs this because its container stops at the safe
    /// area while the transcript does not: content keeps rendering down
    /// through the home-indicator strip, so solid canvas that stopped at the
    /// safe area would leave that strip showing text at full brightness below
    /// the composer.
    ///
    /// A fixed overhang rather than `ignoresSafeArea`, which is what this
    /// replaced: ignoring the safe area pins the strip to the display edge,
    /// so with the keyboard up it stretched behind the keyboard and stopped
    /// sitting under the composer at all. An overhang moves WITH the
    /// container — when the keyboard is up it simply falls behind the
    /// keyboard, where there is nothing to dim anyway.
    var overhang: CGFloat = 0

    /// Bottom edge only. When true, the fade band begins AT the container's
    /// top edge and runs DOWN INTO it, instead of hanging above it — so
    /// content passing under a glass control stays fully readable until the
    /// control's edge and dissolves behind the glass (ChatGPT-style). The
    /// default keeps the fade above the container, which is what the
    /// session list's search capsule wants.
    var fadeInsideContainer: Bool = false

    /// How tall the fade above the control is. Fixed in POINTS, deliberately
    /// NOT a fraction of the control's height: a fraction is exactly what made
    /// the visible part of the ramp shrink to nothing as the control grew.
    private static let fadeHeight: CGFloat = 96

    var body: some View {
        switch edge {
        case .top: topBody
        case .bottom: bottomBody
        }
    }

    /// Reaches into the status bar, which is the whole point of it — that
    /// strip is where the transcript was running under the clock and the
    /// battery.
    private var topBody: some View {
        LinearGradient(
            stops: stops,
            startPoint: .bottom,
            endPoint: .top
        )
        .ignoresSafeArea(edges: .top)
        // Purely decorative: it sits over a scroll view, so without this it
        // would swallow every touch aimed at the content behind it.
        .allowsHitTesting(false)
    }

    /// A fixed-height fade ABOVE the container, then solid canvas over the
    /// container itself and `overhang` points below it — so content is fully
    /// dissolved into canvas by the time it passes behind the floating
    /// control.
    private var bottomBody: some View {
        VStack(spacing: 0) {
            LinearGradient(
                stops: stops,
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: Self.fadeHeight)
            tokens.canvas
        }
        // The fade hangs ABOVE the container, so content fades while still
        // fully visible rather than behind the glass where it could not be
        // seen. With `fadeInsideContainer` set, the band instead occupies the
        // top of the container itself, so content stays fully readable right
        // up to the container's edge and dissolves behind the glass.
        .padding(.top, fadeInsideContainer ? 0 : -Self.fadeHeight)
        // Solid canvas continues below the container into the overhang strip.
        .padding(.bottom, -overhang)
        // Purely decorative: it sits over a scroll view, so without this it
        // would swallow every touch aimed at the content behind it.
        .allowsHitTesting(false)
    }

    /// An eased ramp, not a linear one — and a different easing per edge,
    /// because the two are solving different problems.
    ///
    /// A straight fade announces itself either way: the eye finds the point
    /// where the gradient begins and reads it as a band with an edge. Both
    /// profiles therefore start almost flat and steepen, putting the visible
    /// change where content is already mostly hidden.
    ///
    /// They differ in how fast they get there. `location` runs from the far
    /// end of the fade toward the screen edge in both cases.
    ///
    ///   * BOTTOM spans the fixed fade band ABOVE the composer, where the
    ///     transcript is still fully visible, so the ramp does its real work
    ///     across that band and ends in solid canvas where the control sits.
    ///
    ///   * TOP has to cover the STATUS BAR — the clock, the signal bars, the
    ///     battery — which occupies roughly the outer 40% of the fade and has
    ///     no control of its own sitting over it. A gentle ramp leaves the
    ///     transcript legible right behind the clock, which is the thing being
    ///     fixed, so this one reaches solid canvas well before the edge and
    ///     holds it.
    private var stops: [Gradient.Stop] {
        switch edge {
        case .bottom:
            return [
                .init(color: tokens.canvas.opacity(0), location: 0.0),
                .init(color: tokens.canvas.opacity(0.10), location: 0.25),
                .init(color: tokens.canvas.opacity(0.32), location: 0.45),
                .init(color: tokens.canvas.opacity(0.62), location: 0.62),
                .init(color: tokens.canvas.opacity(0.88), location: 0.80),
                .init(color: tokens.canvas.opacity(0.98), location: 0.92),
                .init(color: tokens.canvas.opacity(1.0), location: 1.0),
            ]
        case .top:
            return [
                .init(color: tokens.canvas.opacity(0), location: 0.0),
                .init(color: tokens.canvas.opacity(0.30), location: 0.25),
                .init(color: tokens.canvas.opacity(0.70), location: 0.45),
                .init(color: tokens.canvas.opacity(0.95), location: 0.60),
                .init(color: tokens.canvas.opacity(1.0), location: 0.72),
                .init(color: tokens.canvas.opacity(1.0), location: 1.0),
            ]
        }
    }
}
