import SwiftUI

/// Application shell for the native MantaUI client.
///
/// This stage is deliberately minimal: it only wires the app lifecycle and the
/// generated design tokens. Every colour resolves through `Tokens.scheme(_:)`
/// — the generated `Theme.swift` — which is itself generated from
/// `src/renderer/tokens.css` (the single source of truth). No colour literal is
/// allowed in hand-written app code.
struct RootView: View {
    @Environment(\.colorScheme) private var colorScheme

    private var tokens: Tokens {
        Tokens.scheme(colorScheme)
    }

    var body: some View {
        ZStack {
            tokens.canvas.ignoresSafeArea()
            Text("MantaUI")
                .foregroundColor(tokens.tx1)
        }
    }
}

#Preview {
    RootView()
}
