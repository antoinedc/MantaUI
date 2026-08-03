import SwiftUI

// ===========================================================================
// Harness-only capture scene (BET-628). Rendered ONLY when the capture harness
// elects the scene `chat-overflow-clear` (MANTA_SCENE / MantaScene) — never in
// normal app use.
//
// Faithfully reproduces where the real ChatScreen presents the Clear
// confirmation: a confirmationDialog attached to a PUSHED navigation view (this
// capture host sits on the navigation stack, exactly like ChatScreenContent
// does inside SessionListView's stack). A `confirmationDialog` presented from
// within a `.sheet` — or from the app's bare root — adapts to a popover on
// iOS 26 and drops its detached `.cancel` button; from a pushed navigation view
// it presents as a true bottom action sheet: destructive item at the top, Cancel
// detached at the bottom (DECISIONS.md:709-715).
// ===========================================================================

struct ChatOverflowCaptureScene: View {
    @State private var path: [Int] = []

    var body: some View {
        NavigationStack(path: $path) {
            Color.clear
                .navigationDestination(for: Int.self) { _ in
                    CaptureHost()
                }
        }
        .onAppear {
            if path.isEmpty {
                DispatchQueue.main.async { path.append(1) }
            }
        }
    }
}

/// The pushed destination — the analog of ChatScreenContent. Owns the overflow
/// sheet AND the Clear confirmation dialog (which must live on the presenter,
/// not inside the sheet).
private struct CaptureHost: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var showOverflow = false
    @State private var confirmingClear = false
    @State private var confirmingDelete = false

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        tokens.canvas
            .ignoresSafeArea()
            .safeAreaInset(edge: .top) {
                Text("Session") // minimal header so the destination reads as a pushed screen
                    .padding()
            }
            .sheet(isPresented: $showOverflow) {
                ChatOverflowSheet(
                    sessionTitle: "better-ui",
                    projectName: "manta",
                    branch: "main",
                    onAttach: {},
                    onSchedules: {},
                    onSecrets: {},
                    onWebhooks: {},
                    onCompact: {},
                    onFork: {},
                    onOpenTerminal: {},
                    confirmingClear: $confirmingClear,
                    confirmingDelete: $confirmingDelete
                )
            }
            .confirmationDialog("Clear this session?", isPresented: $confirmingClear, titleVisibility: .visible) {
                Button("Clear session", role: .destructive) { showOverflow = false }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Starts a fresh session in this window. The transcript stays on the box.")
            }
            .onAppear { showOverflow = true }
    }
}
