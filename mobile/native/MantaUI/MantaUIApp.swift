import SwiftUI
import FirebaseCore

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
    //
    // S8 (BET-600): the app delegate owns APNs registration + notification
    // routing; MantaPushRouter carries a notification tap's sessionId to the
    // session list so a push opens the session that fired it, not the list.
    @UIApplicationDelegateAdaptor(MantaAppDelegate.self) private var appDelegate

    @StateObject private var store: MantaEventStore
    @StateObject private var sessionStore: SessionListStore

    init() {
        // Before anything else, so a crash during start-up is captured too.
        // configure() installs Crashlytics' handlers as a side effect; there is
        // no separate "start recording" call and no upload call anywhere — a
        // crash is written to disk in the dying process and sent on the NEXT
        // launch by the SDK itself.
        FirebaseApp.configure()
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
                .environmentObject(MantaPushRouter.shared)
                .task {
                    store.start()
                    sessionStore.bindResync()
                }
        }
    }
}
