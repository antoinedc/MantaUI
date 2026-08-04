import SwiftUI

// ===========================================================================
// Bottom scrim.
//
// The shared fade behind a floating bottom control — the chat composer and the
// session list's search capsule. Both float over scrolling content, and in both
// cases content passing behind them competed with the control for legibility.
//
// It exists as ONE component because the two uses must match: they are the same
// gesture on two screens, and a hand-rolled gradient per screen would drift the
// first time either is retuned.
//
// Shape of it: transparent at the top so there is no visible seam where the
// scrim begins, ramping to near-opaque canvas at the bottom. The ramp is
// deliberately uneven — most of the darkening happens in the lower half, so the
// content directly behind the control is well suppressed while the fade above
// it stays subtle enough not to read as a band.
// ===========================================================================

struct BottomScrim: View {
    let tokens: Tokens

    var body: some View {
        LinearGradient(
            stops: [
                .init(color: tokens.canvas.opacity(0), location: 0.0),
                .init(color: tokens.canvas.opacity(0.55), location: 0.45),
                .init(color: tokens.canvas.opacity(0.88), location: 0.75),
                .init(color: tokens.canvas.opacity(0.97), location: 1.0),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
        // Reaches through the home-indicator strip, which is otherwise a band
        // of bare canvas below the fade.
        .ignoresSafeArea(edges: .bottom)
        // Purely decorative: it sits over the scroll view, so without this it
        // would swallow every touch aimed at the content behind it.
        .allowsHitTesting(false)
    }
}
