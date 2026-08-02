import SwiftUI

// ===========================================================================
// S2 — application gate (BET-594).
//
// Routes the fresh install into the onboarding/joiner flow (§5), and a paired
// device into the main destination (the S3 session list replaces the current
// content shell). The capture harness's scenes (`MANTA_SCENE`/`MantaScene`)
// bypass the pair gate so the measurement fixtures remain reachable and the
// S4b baseline stays reproducible.
// ===========================================================================

@MainActor
struct MantaAppRoot: View {
    @EnvironmentObject private var store: MantaEventStore
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var flow: MantaOnboardingFlow
    @State private var paired: Bool

    init() {
        let isPaired = (try? KeychainCredentialStore.shared.load()) != nil
        _paired = State(initialValue: isPaired)
        _flow = StateObject(wrappedValue: MantaOnboardingFlow(onPaired: {}))
    }

    private var tokens: Tokens {
        Tokens.scheme(colorScheme)
    }

    /// Scene selector for the capture harness. Prefers the launch environment,
    /// falls back to the app's UserDefaults (which is how the hierarchy leg's
    /// test-managed launch receives the same selection as the `simctl launch`
    /// screenshot leg). Mirrors RootView.harnessScene.
    private var scene: String? {
        if let s = ProcessInfo.processInfo.environment["MANTA_SCENE"], !s.isEmpty {
            return s
        }
        return UserDefaults.standard.string(forKey: "MantaScene")
    }

    var body: some View {
        Group {
            if let scene, scene.hasPrefix("onboarding") {
                // S2 joiner screens as measurement scenes (onboarding-<screen>).
                MantaOnboardingRoot(flow: flow, tokens: tokens)
                    .onAppear { flow.prepare(onboardingScene: scene) }
                    .onAppear {
                        flow.onPaired = {
                            paired = true
                            store.start()
                        }
                    }
            } else if let scene, !scene.isEmpty {
                // Capture-harness fixture mode — bypass the pair gate so the
                // measurement scenes stay reachable (S4b parent/child baseline).
                RootView()
            } else if paired {
                // Paired → main destination. S3 replaces this content shell
                // with the session list; S4 wires it to live data.
                RootView()
                    .onAppear { store.start() }
            } else {
                MantaOnboardingRoot(flow: flow, tokens: tokens)
                    .onAppear {
                        flow.onPaired = {
                            paired = true
                            store.start()
                        }
                    }
            }
        }
    }
}
