import Foundation

// ===========================================================================
// WS01 F2 — the "Show reasoning & full output" preference (desktop Ctrl+O).
//
// One app-wide, persisted switch, OFF by default (D9). Foundation-only so the
// Linux package can compile it. Readers: `TranscriptMapOptions.current` (the
// mapper) and the Activity sheet's verbose output. Writers go through
// `setShowDetails(_:)` so `didChange` fires and an open transcript re-maps.
// ===========================================================================

enum TranscriptDisplayOptions {
    static let defaultsKey = "manta.transcript.showDetails"

    /// OBSERVE (M-01-7 / D22): posted on the main queue whenever
    /// `setShowDetails(_:)` changes the switch. `ChatSessionStore` subscribes with
    /// `NotificationCenter.default.publisher(for: TranscriptDisplayOptions.didChange)`
    /// and REFETCHES the transcript (not just re-maps): reasoning parts are
    /// dropped by the slim fetch, so turning the switch on needs a full fetch.
    static let didChange = Notification.Name("TranscriptDisplayOptions.didChange")

    /// READ the persisted switch (M-01-7 / D22): `TranscriptDisplayOptions.showDetails`.
    /// Default false. It is read straight from UserDefaults on every access, so a
    /// fetch always sees the current value.
    static var showDetails: Bool { UserDefaults.standard.bool(forKey: defaultsKey) }

    /// The `slim:` argument for `MantaAPIClient.messages(sessionId:limit:slim:)`
    /// (M-01-7 / D22): slim while the switch is off, a FULL transcript (which
    /// carries the `reasoning` parts) while it is on.
    static var fetchSlim: Bool { !showDetails }

    /// Persist the switch and tell observers. The notification is posted on the
    /// main queue (immediately when already on it) so a store can refetch without
    /// caring which thread flipped the setting. A call that does not change the
    /// value posts nothing.
    static func setShowDetails(_ on: Bool) {
        guard on != showDetails else { return }
        UserDefaults.standard.set(on, forKey: defaultsKey)
        if Thread.isMainThread {
            NotificationCenter.default.post(name: didChange, object: nil)
        } else {
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: didChange, object: nil)
            }
        }
    }
}
