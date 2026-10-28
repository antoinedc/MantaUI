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
    static let didChange = Notification.Name("TranscriptDisplayOptions.didChange")

    /// Reasoning parts + full (rather than tailed) tool output. Default false.
    static var showDetails: Bool { UserDefaults.standard.bool(forKey: defaultsKey) }

    /// Persist the switch and tell observers. The notification is posted on the
    /// main queue (immediately when already on it) so a store can re-map without
    /// caring which thread flipped the setting.
    static func setShowDetails(_ on: Bool) {
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
