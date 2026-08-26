import Foundation
import Combine
import UIKit
import SwiftUI

// ===========================================================================
// WidgetLiveStore.swift — the box-wide owner of widget liveness.
//
// Liveness is a property of the WIDGET IN THIS STORE, not of the transcript
// cell: the transcript recycles cells as you scroll, so if liveness rode on
// cell lifecycle a widget would flicker in and out based on scroll position
// and rows would stop being reproducible from the block alone. Every live-set
// mutation funnels through the pure `WidgetLiveWindow.resolve` decision maker;
// this store owns the state and observes the singleton bus + memory warnings.
//
// The cap is BOX-WIDE (across sessions and the expand sheet), so there is one
// shared instance (`WidgetLiveStore.shared`) wired at the app root to the
// `/events` stream. Fresh instances exist only in tests.
// ===========================================================================

@MainActor
final class WidgetLiveStore: ObservableObject {
    /// The app-wide instance, box-wide by construction. Registered with the
    /// `/events` stream once at the app root (see `bind`).
    static let shared = WidgetLiveStore()

    /// Every widget announced this app run, keyed by its bus id. A card reads
    /// its ref (url, dimensions, title) from here; the ChatSessionStore reads
    /// its session's widgets to merge them into the transcript.
    @Published private(set) var widgets: [String: WidgetRef] = [:]
    /// The ordered live set (oldest first, newest last) — what's actually
    /// running a web content process. At most `WidgetLiveWindow.maxLive` unless
    /// the screen-protection rule holds more.
    @Published private(set) var liveIDs: [String] = []
    /// Bitmaps captured when a widget went dormant, keyed by id. Used to render
    /// the dimmed `snapshot` state; absent → the card falls back to `placeholder`.
    @Published private(set) var snapshots: [String: UIImage] = [:]
    /// Widgets whose web content process was terminated (backgrounding, memory
    /// pressure) — they render the labelled `stopped` state, never a blank box.
    @Published private(set) var stoppedIDs: Set<String> = []

    /// Widgets currently on screen (their cards reported via `setOnScreen`).
    /// Rule 2 of the live window: nothing ever goes dead while it is on screen.
    private var onScreen: Set<String> = []
    private var boundEventStore = false

    init() {
        // Rule 4: drop to zero live on a memory warning. Selector-based (not a
        // token) so `deinit` can remove the observer without touching a
        // non-Sendable stored value (Swift 6 forbids that in a nonisolated
        // deinit).
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleMemoryWarningNotification),
            name: UIApplication.didReceiveMemoryWarningNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func handleMemoryWarningNotification() {
        handleMemoryWarning()
    }

    /// Register this store as a consumer of `kind: "widget"` frames on the
    /// `/events` stream. Idempotent — safe to call repeatedly (it binds once).
    func bind(eventStore: MantaEventStore) {
        guard !boundEventStore else { return }
        boundEventStore = true
        eventStore.addRawFrameHandler { [weak self] frame in
            self?.handleFrame(frame)
        }
    }

    /// Route a raw `/events` frame into this store if it is a widget frame.
    func handleFrame(_ frame: MantaStreamFrame) {
        guard frame.kind == "widget" else { return }
        if let payload = try? frame.decodedPayload(WidgetPayload.self) {
            handleShow(payload)
        }
    }

    // MARK: - Live-set mutations (all through WidgetLiveWindow.resolve)

    /// A widget was announced on the bus. Record its ref and grant it liveness
    /// (rule 2/3), then enforce the cap (rule 1).
    func handleShow(_ payload: WidgetPayload) {
        guard payload.action == "show" || payload.action.isEmpty,
              let id = payload.id, !id.isEmpty else { return }
        let ref = WidgetRef(
            id: id,
            url: payload.url,
            title: payload.title,
            width: payload.width,
            height: payload.height,
            aspectRatio: payload.aspectRatio,
            sessionId: payload.sessionId,
            messageId: payload.messageId
        )
        widgets[id] = ref
        stoppedIDs.remove(id)
        liveIDs = WidgetLiveWindow.resolve(existing: liveIDs, arriving: id, onScreen: onScreen)
    }

    /// A tap promoted a dormant widget into the live set (taps count against
    /// the cap like any other activation). No-op for an unknown / already-live
    /// widget.
    func activate(_ id: String) {
        guard widgets[id] != nil, !liveIDs.contains(id) else { return }
        stoppedIDs.remove(id)
        liveIDs = WidgetLiveWindow.resolve(existing: liveIDs, arriving: id, onScreen: onScreen)
    }

    /// Report a widget's on-screen / off-screen edge from its card. Called on
    /// the card's `onAppear`/`onDisappear`; re-resolves the live set so a
    /// widget that scrolled fully off-screen AND is out of the newest-2 is
    /// evicted, while an on-screen one is never torn out.
    func setOnScreen(_ id: String, _ visible: Bool) {
        if visible {
            onScreen.insert(id)
        } else {
            onScreen.remove(id)
        }
        liveIDs = WidgetLiveWindow.resolve(existing: liveIDs, arriving: nil, onScreen: onScreen)
    }

    /// Store a dormant widget's captured bitmap for the `snapshot` state.
    func captureSnapshot(id: String, image: UIImage) {
        snapshots[id] = image
    }

    /// A widget's web content process was terminated → the `stopped` state,
    /// and it leaves the live set (nothing blank renders in its place).
    func markStopped(_ id: String) {
        if liveIDs.contains(id) {
            liveIDs = WidgetLiveWindow.resolve(
                existing: liveIDs.filter { $0 != id },
                arriving: nil,
                onScreen: onScreen
            )
        }
        stoppedIDs.insert(id)
    }

    /// A user tapped to reload a `stopped` widget: clear the stopped marker so
    /// a fresh (recreated) webview can load and go live again.
    func clearStopped(_ id: String) {
        stoppedIDs.remove(id)
    }

    /// Rule 4: the live set goes to zero on a memory warning.
    func handleMemoryWarning() {
        liveIDs = []
    }

    // MARK: - Reads

    func ref(for id: String) -> WidgetRef? { widgets[id] }
    func isLive(_ id: String) -> Bool { liveIDs.contains(id) }
    func snapshot(for id: String) -> UIImage? { snapshots[id] }
    func isStopped(_ id: String) -> Bool { stoppedIDs.contains(id) }
}

// MARK: - Environment wiring

/// The box-wide live store, injected into transcript cells via the SwiftUI
/// environment (the same delivery as `transcriptCardActions`). `nil` on
/// read-only surfaces where widgets render inert with no live wiring.
private struct WidgetLiveStoreKey: EnvironmentKey {
    static let defaultValue: WidgetLiveStore? = nil
}

extension EnvironmentValues {
    var widgetLiveStore: WidgetLiveStore? {
        get { self[WidgetLiveStoreKey.self] }
        set { self[WidgetLiveStoreKey.self] = newValue }
    }
}
