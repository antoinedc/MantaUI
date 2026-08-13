import SwiftUI

// ===========================================================================
// Harness-only capture scene (BET-628). Rendered ONLY when the capture harness
// elects the scene `chat-overflow-clear` (MANTA_SCENE / MantaScene) — never in
// normal app use.
//
// Raises the real ChatOverflowSheet. The Clear confirmation is a custom native
// SwiftUI bottom sheet (`ConfirmActionSheet`) presented from WITHIN
// ChatOverflowSheet (sheet-on-sheet), so tapping the Clear row raises it
// exactly as in the real app — destructive "Clear session" first, separated
// "Cancel" at the bottom (DECISIONS.md:709-715). No live box required.
// ===========================================================================

struct ChatOverflowCaptureScene: View {
    @Environment(\.colorScheme) private var colorScheme
    // Present from onAppear (NOT an initial `true`): SwiftUI does not raise a
    // sheet whose binding is already true at first render.
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
                    onSchedules: {},
                    onSecrets: {},
                    onCompact: {},
                    onClear: {},
                    onFork: {},
                    onOpenTerminal: {},
                    onDelete: {}
                )
            }
    }
}
