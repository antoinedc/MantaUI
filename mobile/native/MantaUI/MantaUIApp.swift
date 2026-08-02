import SwiftUI

@main
struct MantaUIApp: App {
    // S1b: the observable event store is the app-wide owner of the /events
    // stream. It binds to whatever SwiftUI views S4 mounts (session lists,
    // chat transcript, subagents) and owns reconnect + degraded mode. When a
    // box is paired (serverUrl + boxToken in the Keychain) it connects live;
    // otherwise start() no-ops into a closed state without spinning.
    @StateObject private var store = MantaEventStore()

    var body: some Scene {
        WindowGroup {
            // S2: MantaAppRoot gates fresh-install onboarding vs. the paired
            // main destination (BET-594). The app-wide event store still owns
            // the /events stream and bounds to whatever S4 mounts.
            MantaAppRoot()
                .environmentObject(store)
                .task { store.start() }
        }
    }
}
