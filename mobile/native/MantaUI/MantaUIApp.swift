import SwiftUI

@main
struct MantaUIApp: App {
    // S1b: the observable event store is the app-wide owner of the /events
    // stream. It binds to whatever SwiftUI views S4 mounts (session lists,
    // chat transcript, subagents) and owns reconnect + degraded mode. When a
    // box is paired (serverUrl + boxToken in the Keychain) it connects live;
    // otherwise start() no-ops into a closed state without spinning.
    //
    // S3: the session-list store drives the §7.1 list, deriving live row
    // status from the event store and persisting pin/haptics through config.
    @StateObject private var store: MantaEventStore
    @StateObject private var sessionStore: SessionListStore

    init() {
        let event = MantaEventStore()
        _store = StateObject(wrappedValue: event)
        _sessionStore = StateObject(wrappedValue: SessionListStore(eventStore: event))
    }

    var body: some Scene {
        WindowGroup {
            // S2: MantaAppRoot gates fresh-install onboarding vs. the paired
            // main destination (BET-594). The app-wide event store still owns
            // the /events stream and bounds to whatever S4 mounts.
            MantaAppRoot()
                .environmentObject(store)
                .environmentObject(sessionStore)
                .task {
                    store.start()
                    sessionStore.bindResync()
                }
        }
    }
}
