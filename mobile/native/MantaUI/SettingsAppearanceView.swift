import SwiftUI

// WS10 F4 — the SwiftUI half of `SettingsAppearance.swift` (which is
// Foundation-only). `nil` means "follow the phone": passing it to
// `.preferredColorScheme(_:)` removes the override.
extension ThemePreference {
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}
