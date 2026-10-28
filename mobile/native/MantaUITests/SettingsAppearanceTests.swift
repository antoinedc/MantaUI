import XCTest
@testable import MantaUI

// WS10 F4 — the phone's own theme override + the Settings deep link. Pure,
// Foundation-only: also runs under `./verify.sh`.

final class SettingsAppearanceTests: XCTestCase {

    func testPreferenceMapsStoredValues() {
        XCTAssertEqual(SettingsAppearance.preference(for: "system"), .system)
        XCTAssertEqual(SettingsAppearance.preference(for: "light"), .light)
        XCTAssertEqual(SettingsAppearance.preference(for: "dark"), .dark)
    }

    func testAnythingElseFollowsThePhone() {
        XCTAssertEqual(SettingsAppearance.preference(for: nil), .system)
        XCTAssertEqual(SettingsAppearance.preference(for: ""), .system)
        XCTAssertEqual(SettingsAppearance.preference(for: "garbage"), .system)
        XCTAssertEqual(SettingsAppearance.preference(for: "DARK"), .system)
    }

    func testStorageKeyIsTheDeviceLocalThemeKey() {
        XCTAssertEqual(SettingsAppearance.storageKey, "manta.settings.local.themeMobile")
        XCTAssertEqual(SettingsAppearance.systemValue, "system")
    }

    // MARK: - Deep link

    private let sections = ["general", "box", "accounts", "models", "sessions", "files", "extensions", "voice"]

    func testDeepLinkTargetsAKnownNonFirstSection() {
        XCTAssertEqual(SettingsDeepLink.target("extensions", available: sections), "extensions")
        XCTAssertEqual(SettingsDeepLink.target("general", available: sections), "general")
    }

    func testDeepLinkIgnoresNilEmptyAndUnknownSections() {
        XCTAssertNil(SettingsDeepLink.target(nil, available: sections))
        XCTAssertNil(SettingsDeepLink.target("", available: sections))
        // Desktop-only sections the phone does not show.
        XCTAssertNil(SettingsDeepLink.target("secrets", available: sections))
        XCTAssertNil(SettingsDeepLink.target("cto", available: sections))
        XCTAssertNil(SettingsDeepLink.target("nope", available: sections))
    }
}
