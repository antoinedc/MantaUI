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
    @EnvironmentObject private var sessionStore: SessionListStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var flow: MantaOnboardingFlow
    @State private var paired: Bool
    /// A pairing payload that arrived while already paired — pending the
    /// "Switch box?" confirmation (BET-702).
    @State private var switchRequest: MantaPairing.PairPayload?

    init() {
        // UI-test / verification seam (BET-702): `MANTA_UI_FORCE_PAIRED` makes
        // the app boot into the paired destination WITHOUT touching the real
        // Keychain, so the "Switch box?" re-pair path is reachable from a
        // UITest with no persistent credentials write.
        let env = ProcessInfo.processInfo.environment
        let forcedPaired = env["MANTA_UI_FORCE_PAIRED"] == "1"
        let isPaired = forcedPaired ? true : (try? KeychainCredentialStore.shared.load()) != nil
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
                        flow.onPaired = commitPairing
                    }
            } else if let scene, scene == "chat-overflow-clear" {
                // BET-628 capture scene — raises the real ChatOverflowSheet so
                // the Clear confirmation (native action sheet) is captureable.
                ChatOverflowCaptureScene()
            } else if let scene, scene == "chat-loading" {
                // D2 / BET-631 fixture: the transcript-shaped session-loading
                // skeleton as a deterministic measurement scene (real
                // `ChatLoadingSkeleton`, no live box required).
                ChatLoadingScene()
            } else if let scene, scene == "chat-markdown" {
                // BET-671 fixture: render the real `MantaProse` wrapper against a
                // sample turn (bold/italic/inline code, fenced code, table) —
                // the acceptance fixtures, no live box required.
                MantaProseCaptureScene()
            } else if let scene, scene == "step-rows" {
                // BET-1212 fixture: render the REAL step-group rows inside their
                // grouped container against a fixed sample (running + completed
                // steps, an expanded output well, a roll-up, a subagent row) —
                // so the tool-call grouping is measurable with no live box.
                MantaStepRowsCaptureScene()
            } else if let scene, scene == "voice-note-stored" {
                // BET-1050 harness fixture: render the real `VoiceNotePlayerRow`
                // (the `.stored` waveform) for a finished note, so the stored/
                // playback path is evidenced on-device with no live box — the
                // overflow bug never touched this path, but the reviewer asked
                // to see it render post-change.
                VoiceNoteStoredCaptureScene()
            } else if let scene, !scene.isEmpty {
                // Capture-harness fixture mode — bypass the pair gate so the
                // measurement scenes stay reachable (S4b parent/child baseline).
                RootView()
            } else if paired {
                // Paired → main destination (S3): the session list. S4 wires
                // tap-open's chat to live data; S3 delivers the list, its
                // actions, and creation.
                SessionListView(store: sessionStore)
                    .onAppear { store.start() }
                    .task { await sessionStore.refresh() }
            } else {
                MantaOnboardingRoot(flow: flow, tokens: tokens)
                    .onAppear {
                        flow.onPaired = commitPairing
                    }
            }
        }
        // S8 (BET-600): a pairing link — either the manta:// custom scheme or
        // the associated-domain universal link (https://app.mantaui.com/m/…)—
        // is parsed and fed into the S2 onboarding flow. Delivery happens via
        // onOpenURL (warm launch) and MantaPairingRouter (cold start through
        // the app delegate's continue userActivity); both converge here.
        // Coming back to the app re-syncs. Nothing observed the scene phase
        // before, so `MantaEventStore.resume()` — written for exactly this and
        // documented as "App foreground / resume" — had ZERO call sites: iOS
        // suspends the process, the /events socket dies, its timers stop, and
        // on return the app sat on whatever it had when it went away. Combined
        // with a list fetch that only ran once at launch, a session list that
        // went stale or blank stayed that way until the app was force-quit —
        // which is precisely the "kill and restart and they're back" symptom.
        .onChange(of: scenePhase) { phase in
            guard phase == .active, paired else { return }
            MantaPushService.applyRegistrationState()
            store.resume()
            Task { await sessionStore.refresh() }
        }
        .onOpenURL { url in
            #if DEBUG
            if MantaDebugRouter.route(url) { return }
            #endif
            _ = MantaPairingRouter.route(url)
        }
        .onReceive(MantaPairingRouter.shared.$pendingPayload) { payload in
            guard let payload else { return }
            // The staged payload is consumed here — clear it so link handling
            // isn't state-dependent (the same link must stage once).
            MantaPairingRouter.shared.pendingPayload = nil
            if paired {
                // Paired device + a pairing link = a re-pair onto a different
                // box. Present the "Switch box?" confirmation instead of
                // silently ignoring the link (BET-702).
                switchRequest = payload
            } else {
                flow.receive(payload: payload)
            }
        }
        .sheet(isPresented: Binding(
            get: { switchRequest != nil },
            set: { if !$0 { switchRequest = nil } }
        )) {
            if let request = switchRequest {
                MantaSwitchBoxSheet(
                    tokens: tokens,
                    currentHost: currentBoxHost,
                    newHost: newBoxHost(for: request),
                    onCancel: { switchRequest = nil },
                    onSwitch: { beginSwitch(request) }
                )
            }
        }
    }

    /// Shared completion for a successful pairing, fresh or re-pair. When the
    /// flow is in "Switch box" mode, first tear down the old box's event
    /// stream and wipe its session list so nothing from the previous box
    /// bleeds into the new one (BET-702).
    private var commitPairing: () -> Void {
        {
            if flow.isSwitching {
                store.stop()
                sessionStore.resetForBoxChange()
            }
            paired = true
            store.start()
            MantaPushService.registerAfterPairing()
        }
    }

    private var currentBoxHost: String {
        // The same verification seam feeds a synthetic current host so the
        // Switch box sheet has a real value to compare even without credentials.
        if let h = ProcessInfo.processInfo.environment["MANTA_UI_PAIR_HOST"], !h.isEmpty {
            return h
        }
        return (try? KeychainCredentialStore.shared.load())?.serverUrl ?? ""
    }

    private func newBoxHost(for payload: MantaPairing.PairPayload) -> String {
        MantaPairing.claimBaseURL(payload)?.absoluteString ?? ""
    }

    /// Begin the re-pair: route the new payload through the EXISTING claim
    /// path by mounting the onboarding flow (which renders linking + the typed
    /// failure screens). `flow.isSwitching` makes a success reset local state.
    private func beginSwitch(_ payload: MantaPairing.PairPayload) {
        switchRequest = nil
        flow.isSwitching = true
        flow.receive(payload: payload)
        paired = false
    }
}
