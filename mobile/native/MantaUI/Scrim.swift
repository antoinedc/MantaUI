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

    var body: some View {
        LinearGradient(
            stops: stops,
            startPoint: edge == .bottom ? .top : .bottom,
            endPoint: edge == .bottom ? .bottom : .top
        )
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

    private var stops: [Gradient.Stop] {
        [
            .init(color: tokens.canvas.opacity(0), location: 0.0),
            .init(color: tokens.canvas.opacity(0.55), location: 0.45),
            .init(color: tokens.canvas.opacity(0.88), location: 0.75),
            .init(color: tokens.canvas.opacity(0.97), location: 1.0),
        ]
    }
}
