import Foundation

// ===========================================================================
// WS10 F4 — the phone's own theme override, and the Settings deep link.
//
// Foundation-only so it compiles in the Linux SwiftPM package (D19). The
// SwiftUI half (`ThemePreference.colorScheme`) lives in
// `SettingsAppearanceView.swift`.
//
// The theme is DEVICE-LOCAL (schema entry `themeMobile`, `configKey == nil`):
// the box config is shared by every device, so writing the desktop's `theme`
// key from the phone would re-theme the Mac too.
// ===========================================================================

enum ThemePreference: String, Sendable, Equatable {
    case system, light, dark
}

enum SettingsAppearance {
    /// Where `MantaSettingsStore` keeps the device-local `themeMobile` entry.
    /// Must equal `MantaSettingsStore.deviceStorageKey(entryID: "themeMobile")`
    /// (pinned by a test) — it exists so `@AppStorage` can read the same key
    /// without the store.
    static let storageKey = "manta.settings.local.themeMobile"
    static let systemValue = "system"

    /// "light" / "dark" select that scheme; anything else (nil, "system",
    /// garbage from a newer build) follows the phone.
    static func preference(for stored: String?) -> ThemePreference {
        switch stored {
        case "light": return .light
        case "dark": return .dark
        default: return .system
        }
    }
}

enum SettingsDeepLink {
    /// The section id to scroll to when Settings is opened with
    /// `initialSection:` (C2 `.settings(section:)`). Only an id the phone really
    /// shows qualifies; nil, empty or unknown ids (a desktop-only `secrets` /
    /// `cto`) leave the screen at the top.
    static func target(_ requested: String?, available: [String]) -> String? {
        guard let requested, !requested.isEmpty, available.contains(requested) else { return nil }
        return requested
    }
}
