import SwiftUI

// ===========================================================================
// Harness-only capture scene (BET-628). Rendered ONLY when the capture harness
// elects the scene `chat-overflow-clear` (MANTA_SCENE / MantaScene) — it is
// never reachable in normal app use. It raises the real ChatOverflowSheet so
// the Clear confirmation — a NATIVE action sheet with the destructive item at
// the top and Cancel detached at the bottom (DECISIONS.md:709-715) — can be
// captured deterministically without a live box. The UI-test driver taps the
// "Clear session" row to present that action sheet, then captures it.
// ===========================================================================

struct ChatOverflowCaptureScene: View {
    @Environment(\.colorScheme) private var colorScheme
    // Present from onAppear (NOT an initial `true`): SwiftUI does not raise a
    // sheet whose binding is already true at first render, so the host below
    // would otherwise show a blank canvas with no sheet and no capture-able row.
    @State private var showOverflow = false

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        tokens.canvas
            .ignoresSafeArea()
            .onAppear { showOverflow = true }
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
                    onClear: {},
                    onFork: {},
                    onOpenTerminal: {},
                    onDelete: {}
                )
            }
    }
}
