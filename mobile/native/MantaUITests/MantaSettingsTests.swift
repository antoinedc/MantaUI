import XCTest
@testable import MantaUI

// S7 — settings (BET-599).
//
// Tests the PURE decision logic (`MantaSettingsLogic`) mirroring the shared
// settingsSchema helpers, plus the store's persistence wiring (config:update
// for config-driven entries, UserDefaults for device-local) with a fake config
// seam so nothing touches a box.

// MARK: - Pure logic

final class MantaSettingsLogicTests: XCTestCase {

    private func entry(id: String, in sections: [SettingSection] = SettingsSchema.sections) -> SettingEntry {
        SettingsSchema.entries.first { $0.id == id }!
    }

    func testDefaultValueIsModified() {
        let cacheTtl = entry(id: "cacheTtl")
        XCTAssertEqual(MantaSettingsLogic.defaultValue(of: cacheTtl), .string("1h"))
        XCTAssertFalse(MantaSettingsLogic.isModified(cacheTtl, .string("1h")))
        XCTAssertTrue(MantaSettingsLogic.isModified(cacheTtl, .string("5m")))
    }

    func testToggleBoolModified() {
        let autoRename = entry(id: "autoRenameSessions")
        XCTAssertEqual(MantaSettingsLogic.defaultValue(of: autoRename), .bool(false))
        XCTAssertFalse(MantaSettingsLogic.isModified(autoRename, .bool(false)))
        XCTAssertTrue(MantaSettingsLogic.isModified(autoRename, .bool(true)))
    }

    func testNumberDefaultModifiedAndCoerced() {
        let upload = entry(id: "uploadCleanupHours")
        XCTAssertEqual(MantaSettingsLogic.defaultValue(of: upload), .number(24))
        // Segmented emits a string option value; numeric default coerces to a number.
        let coerced = MantaSettingsLogic.coerce(upload, .string("168"))
        XCTAssertEqual(coerced, .number(168))
        // Non-numeric defaults pass through unchanged.
        XCTAssertEqual(MantaSettingsLogic.coerce(entry(id: "cacheTtl"), .string("5m")), .string("5m"))
    }

    func testDeviceLocalEntryIsNotModifiedByDefaultValueSurface() {
        let serverUrl = entry(id: "serverUrlMobile")
        XCTAssertNil(serverUrl.configKey)
        XCTAssertEqual(MantaSettingsLogic.defaultValue(of: serverUrl), .string(""))
        XCTAssertFalse(MantaSettingsLogic.isModified(serverUrl, .string("")))
        XCTAssertTrue(MantaSettingsLogic.isModified(serverUrl, .string("https://other.example.com")))
    }

    func testSectionIsModifiedOnlyCountsConfigDrivenEntries() {
        // Voice has groqApiKey/transcription/command — none set → not modified.
        XCTAssertFalse(MantaSettingsLogic.sectionIsModified("voice", [:]))
        XCTAssertTrue(MantaSettingsLogic.sectionIsModified("voice", ["groqApiKey": .string("gsk_x")]))
        // Sessions has only config-driven toggles.
        XCTAssertFalse(MantaSettingsLogic.sectionIsModified("sessions", ["serverUrlMobile": .string("x")]))
        XCTAssertTrue(MantaSettingsLogic.sectionIsModified("sessions", ["autoRenameSessions": .bool(true)]))
    }

    func testSectionResetValuesIncludeConfigAndDeviceLocal() {
        let values = MantaSettingsLogic.sectionResetValues("box")
        // serverUrlMobile (device-local) is included in the section reset.
        XCTAssertNotNil(values["serverUrlMobile"])
        XCTAssertEqual(values["serverUrlMobile"], .string(""))
    }

    func testResetAllValuesCoverEveryEntry() {
        let values = MantaSettingsLogic.resetAllValues()
        XCTAssertEqual(values.count, SettingsSchema.entries.count)
        for entry in SettingsSchema.entries {
            XCTAssertEqual(values[entry.id], MantaSettingsLogic.defaultValue(of: entry))
        }
    }

    func testGeneratedSchemaSearch() {
        XCTAssertTrue(SettingsSchema.search("groq").contains { $0.id == "groqApiKey" })
        XCTAssertTrue(SettingsSchema.search("permission").contains { $0.id == "chatAutoAllow" })
        XCTAssertTrue(SettingsSchema.search("   ").isEmpty)
        XCTAssertFalse(SettingsSchema.search("zzznothing").contains { $0.id == "cacheTtl" })
    }

    func testGeneratedInventoryHasExpectedMobileControls() {
        let byID = Dictionary(uniqueKeysWithValues: SettingsSchema.entries.map { ($0.id, $0) })
        XCTAssertEqual(byID["cacheTtl"]?.control, .segmented)
        XCTAssertEqual(byID["autoRenameSessions"]?.control, .toggle)
        XCTAssertEqual(byID["chatAutoAllow"]?.control, .toggle)
        XCTAssertEqual(byID["uploadCleanupHours"]?.control, .segmented)
        XCTAssertEqual(byID["groqApiKey"]?.control, .password)
        XCTAssertTrue(byID["groqApiKey"]?.commitOnBlur == true)
        XCTAssertEqual(byID["voiceCommandModel"]?.control, .text)
        XCTAssertNil(byID["serverUrlMobile"]?.configKey)
        XCTAssertEqual(byID["cacheTtl"]?.configKey, "cacheTtl")
    }
}

// MARK: - Store persistence wiring

@MainActor
private final class FakeConfigStore: SettingsConfigurationStore {
    var stored: [String: JSONValue] = [:]
    var updates: [[String: JSONValue]] = []
    var failLoad = false
    var failUpdate = false

    func load() async -> [String: JSONValue]? {
        failLoad ? nil : stored
    }

    func update(_ patch: [String: JSONValue]) async throws -> [String: JSONValue]? {
        guard !failUpdate else { throw CancellationError() }
        updates.append(patch)
        stored.merge(patch) { _, new in new }
        return stored
    }
}

@MainActor
final class MantaSettingsStoreTests: XCTestCase {

    private var fake: FakeConfigStore!
    private var defaults: UserDefaults!
    private var store: MantaSettingsStore!

    override func setUp() async throws {
        fake = FakeConfigStore()
        defaults = UserDefaults(suiteName: "MantaSettingsTests-\(UUID().uuidString)")!
        store = MantaSettingsStore(configuration: fake, defaults: defaults)
    }

    override func tearDown() async throws {
        if let defaults, let name = defaults.volatileDomainNames.last {
            defaults.removeVolatileDomain(forName: name)
        }
        fake = nil
        defaults = nil
        store = nil
    }

    private func entry(id: String) -> SettingEntry {
        SettingsSchema.entries.first { $0.id == id }!
    }

    func testLoadSeedsConfigDrivenAndDeviceLocal() async {
        fake.stored["cacheTtl"] = .string("5m")
        fake.stored["autoRenameSessions"] = .bool(true)
        defaults.set("https://custom.example.com", forKey: "manta.settings.local.serverUrlMobile")

        await store.load()

        XCTAssertEqual(store.current(entry(id: "cacheTtl")), .string("5m"))
        XCTAssertEqual(store.current(entry(id: "autoRenameSessions")), .bool(true))
        XCTAssertEqual(store.current(entry(id: "serverUrlMobile")), .string("https://custom.example.com"))
        // Unset config-driven entries fall back to their schema default.
        XCTAssertEqual(store.current(entry(id: "groqApiKey")), .string(""))
        XCTAssertTrue(store.loaded)
    }

    func testCommitConfigDrivenSendsCoercedPatch() async throws {
        await store.load()
        store.commit(entry(id: "uploadCleanupHours"), .string("168"))
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(store.current(entry(id: "uploadCleanupHours")), .number(168))
        let last = try XCTUnwrap(fake.updates.last)
        XCTAssertEqual(last["uploadCleanupHours"], .number(168))
    }

    func testCommitDeviceLocalStaysInUserDefaults() async {
        await store.load()
        store.commit(entry(id: "serverUrlMobile"), .string("https://box.example.com"))
        XCTAssertEqual(
            defaults.string(forKey: "manta.settings.local.serverUrlMobile"),
            "https://box.example.com"
        )
    }

    func testResetSectionIsUndoable() async throws {
        await store.load()
        store.commit(entry(id: "cacheTtl"), .string("5m"))
        try? await Task.sleep(nanoseconds: 20_000_000)
        fake.updates.removeAll()

        store.resetSection("models")
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(store.current(entry(id: "cacheTtl")), .string("1h"))
        XCTAssertNotNil(store.undoMessage)

        store.undoLastReset()
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(store.current(entry(id: "cacheTtl")), .string("5m"))
        XCTAssertNil(store.undoMessage)
    }

    func testResetAllIsUndoable() async throws {
        await store.load()
        store.commit(entry(id: "autoRenameSessions"), .bool(true))
        store.commit(entry(id: "serverUrlMobile"), .string("https://box.example.com"))
        try? await Task.sleep(nanoseconds: 50_000_000)

        store.resetAll()
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(store.current(entry(id: "autoRenameSessions")), .bool(false))
        XCTAssertEqual(store.current(entry(id: "serverUrlMobile")), .string(""))
        XCTAssertNotNil(store.undoMessage)

        store.undoLastReset()
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(store.current(entry(id: "autoRenameSessions")), .bool(true))
        XCTAssertEqual(store.current(entry(id: "serverUrlMobile")), .string("https://box.example.com"))
    }

    // MARK: - Trust-mode toggle (BET-748)

    func testSetBoolRoundTripsChatAutoAllowPatch() async throws {
        await store.load()
        let entry = entry(id: "chatAutoAllow")
        XCTAssertEqual(store.current(entry), .bool(false))

        try await store.setBool(entry, true)

        // The in-memory value flips, and exactly the chatAutoAllow key is
        // sent over the store's config:update path.
        XCTAssertEqual(store.current(entry), .bool(true))
        let last = try XCTUnwrap(fake.updates.last)
        XCTAssertEqual(last["chatAutoAllow"], .bool(true))
    }

    func testSetBoolFailedUpdateThrowsAndDoesNotFlipValue() async throws {
        await store.load()
        let entry = entry(id: "chatAutoAllow")
        fake.failUpdate = true

        do {
            try await store.setBool(entry, true)
            XCTFail("Expected a thrown error for the failed config:update")
        } catch {
            // Expected — the update was rejected.
        }

        // No fabricated success: the persisted value must not flip.
        XCTAssertEqual(store.current(entry), .bool(false))
    }
}
