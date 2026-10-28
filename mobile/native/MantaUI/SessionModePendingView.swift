import SwiftUI

// ===========================================================================
// WS04 §2 — shown in the session's navigation slot while a saved AI-CLI mode
// can't be confirmed against the box's installed list. It never guesses: a
// loading or failed check waits (or offers Try again / Open in chat); the
// moment the catalog turns authoritative the owner swaps in the resolved
// screen. Observes the store, so the swap needs no action from here.
// ===========================================================================

struct SessionModePendingView: View {
    let launcherID: String
    let name: String
    @ObservedObject var sessionStore: SessionListStore
    let onOpenInChat: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        VStack(spacing: Metrics.spacing.sp3) {
            switch sessionStore.launcherCatalog {
            case .failed:
                Image(systemName: "wifi.exclamationmark")
                    .font(.system(size: Metrics.type.display))
                    .foregroundColor(tokens.tx4)
                Text("Couldn't check which AI CLIs are installed on your server.")
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx3)
                    .multilineTextAlignment(.center)
                Button("Try again") {
                    Task { await sessionStore.refreshLaunchers() }
                }
                .buttonStyle(.borderedProminent)
                Button("Open in chat", action: onOpenInChat)
                    .buttonStyle(.bordered)
            case .loading, .loaded:
                ProgressView()
                Text("Checking which AI CLIs are installed…")
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx3)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(Metrics.spacing.sp4)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(tokens.canvas.ignoresSafeArea())
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if case .loading = sessionStore.launcherCatalog {
                await sessionStore.refreshLaunchers()
            }
        }
        .accessibilityIdentifier("session-mode-pending")
    }
}
