import SwiftUI

@main
struct MantaSpikeRefApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

struct RootView: View {
    // Launch with -chatRoot to open the chat screen directly (the simulator can
    // not tap, so the screenshot harness launches straight into the detail).
    var body: some View {
        NavigationStack {
            if ProcessInfo.processInfo.arguments.contains("-chatRoot") {
                ChatView(session: Sample.sessions[0])
            } else {
                SessionListView()
            }
        }
    }
}

#Preview {
    RootView()
}