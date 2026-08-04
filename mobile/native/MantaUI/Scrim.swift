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
// The ramp is deliberately uneven — most of the darkening happens in the third
// nearest the edge, so content directly behind the control is well suppressed
// while the far end of the fade stays subtle enough not to read as a band.
// ===========================================================================

struct Scrim: View {
    enum Edge {
        case top
        case bottom
    }

    let edge: Edge
    let tokens: Tokens
    /// How far the fade reaches PAST its container's edge.
    ///
    /// The bottom scrim needs this because its container stops at the safe
    /// area while the transcript does not: content keeps rendering down
    /// through the home-indicator strip, so a scrim bounded to the safe area
    /// left that strip undimmed and the text came back to full brightness
    /// below the composer.
    ///
    /// A fixed overhang rather than `ignoresSafeArea`, which is what this
    /// replaced: ignoring the safe area pins the gradient to the display edge,
    /// so with the keyboard up it stretched behind the keyboard and stopped
    /// sitting under the composer at all. An overhang moves WITH the
    /// container — when the keyboard is up it simply falls behind the
    /// keyboard, where there is nothing to dim anyway.
    var overhang: CGFloat = 0

    var body: some View {
        LinearGradient(
            stops: stops,
            startPoint: edge == .bottom ? .top : .bottom,
            endPoint: edge == .bottom ? .bottom : .top
        )
        .padding(edge == .bottom ? .bottom : .top, -overhang)
        // The TOP scrim reaches into the status bar, which is the whole point
        // of it — that strip is where the transcript was running under the
        // clock and the battery.
        //
        // The BOTTOM one deliberately does NOT reach into the bottom safe area.
        // It used to, and that is what pinned it to the screen edge: with the
        // keyboard up the composer rides above the keyboard while the gradient
        // still stretched to the bottom of the display, so it no longer sat
        // under the composer at all — only the palest end of the ramp was
        // visible. Bounded to its container, it tracks the composer wherever
        // the keyboard puts it. The strip below is already painted canvas by
        // the screen's own background, so nothing is left bare.
        .ignoresSafeArea(edges: edge == .top ? .top : [])
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
    ///   * BOTTOM sits behind the composer, which is itself glass and already
    ///     obscures what is under it. The ramp can stay gentle for most of its
    ///     length and only go solid at the very end.
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
