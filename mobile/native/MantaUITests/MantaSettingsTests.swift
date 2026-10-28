import XCTest
@testable import MantaUI

// S7 — settings (BET-599) + WS10 §0.2.
//
// Tests the PURE decision logic (`MantaSettingsLogic`) mirroring the shared
// settingsSchema helpers, plus the store's persistence wiring (config:update
// for config-driven entries, UserDefaults for device-local) with a fake config
// seam so nothing touches a box. WS10 adds the FAILURE-SAFE commit path (a
// rejected save leaves the confirmed value in place and says so) and the guard
// that keeps a pending commit and a reset / undo from interleaving.

// MARK: - Pure logic

final class MantaSettingsLogicTests: XCTestCase {

    private func entry(id: String, in sections: [SettingSection] = SettingsSchema.sections) -> SettingEntry {
        SettingsSchema.entries.first { $0.id == id }!
    }

    func testDefaultValueIsModified() {
        let cacheTtl = entry(id: "cacheTtl")
        // Default is "5m" — the TTL opencode actually requests on the wire.
        XCTAssertEqual(MantaSettingsLogic.defaultValue(of: cacheTtl), .string("5m"))
        XCTAssertFalse(MantaSettingsLogic.isModified(cacheTtl, .string("5m")))
        XCTAssertTrue(MantaSettingsLogic.isModified(cacheTtl, .string("1h")))
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
        let theme = entry(id: "themeMobile")
        XCTAssertNil(theme.configKey)
        XCTAssertEqual(MantaSettingsLogic.defaultValue(of: theme), .string("system"))
        XCTAssertFalse(MantaSettingsLogic.isModified(theme, .string("system")))
        XCTAssertTrue(MantaSettingsLogic.isModified(theme, .string("dark")))
    }

    func testSectionIsModifiedOnlyCountsConfigDrivenEntries() {
        // Voice has groqApiKey/transcription/command — none set → not modified.
        XCTAssertFalse(MantaSettingsLogic.sectionIsModified("voice", [:]))
        XCTAssertTrue(MantaSettingsLogic.sectionIsModified("voice", ["groqApiKey": .string("gsk_x")]))
        // The device-local theme never marks General modified.
        XCTAssertFalse(MantaSettingsLogic.sectionIsModified("general", ["themeMobile": .string("dark")]))
        XCTAssertTrue(MantaSettingsLogic.sectionIsModified("general", ["hapticsEnabled": .bool(false)]))
        // Sessions has only config-driven toggles.
        XCTAssertFalse(MantaSettingsLogic.sectionIsModified("sessions", ["themeMobile": .string("x")]))
        XCTAssertTrue(MantaSettingsLogic.sectionIsModified("sessions", ["autoRenameSessions": .bool(true)]))
    }

    func testSectionResetValuesIncludeConfigAndDeviceLocalButNotCustom() {
        let values = MantaSettingsLogic.sectionResetValues("general")
        // themeMobile (device-local) is included in the section reset.
        XCTAssertEqual(values["themeMobile"], .string("system"))
        XCTAssertEqual(values["hapticsEnabled"], .bool(true))
        // The anchors hold no value — resetting them wrote `.null` into UserDefaults.
        XCTAssertNil(values["updatesMobile"])
        XCTAssertNil(values["backupMobile"])
        XCTAssertTrue(MantaSettingsLogic.sectionResetValues("box").isEmpty, "the Box section is all anchors")
    }

    func testResetAllValuesCoverEveryValueEntryAndNoCustomOne() {
        let values = MantaSettingsLogic.resetAllValues()
        let valueEntries = SettingsSchema.entries.filter { $0.control != .custom }
        XCTAssertEqual(values.count, valueEntries.count)
        for entry in valueEntries {
            XCTAssertEqual(values[entry.id], MantaSettingsLogic.defaultValue(of: entry))
        }
        XCTAssertNil(values["boxStatusMobile"])
        XCTAssertNil(values["accountsList"])
        XCTAssertLessThan(values.count, SettingsSchema.entries.count)
    }

    func testGeneratedSchemaSearch() {
        XCTAssertTrue(SettingsSchema.search("groq").contains { $0.id == "groqApiKey" })
        XCTAssertTrue(SettingsSchema.search("permission").contains { $0.id == "chatAutoAllow" })
        XCTAssertTrue(SettingsSchema.search("linked").contains { $0.id == "linkedDevicesMobile" })
        XCTAssertTrue(SettingsSchema.search("restart").contains { $0.id == "restartOpencodeMobile" })
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
        XCTAssertEqual(byID["cacheTtl"]?.configKey, "cacheTtl")
        // WS10.
        XCTAssertEqual(byID["themeMobile"]?.control, .segmented)
        XCTAssertNil(byID["themeMobile"]?.configKey)
        XCTAssertEqual(byID["hapticsEnabled"]?.configKey, "hapticsEnabled")
        XCTAssertEqual(byID["hapticsEnabled"]?.defaultBool, true)
        XCTAssertEqual(byID["worktreePerSession"]?.configKey, "worktreePerSession")
        XCTAssertEqual(byID["worktreeCleanOnClose"]?.configKey, "worktreeCleanOnClose")
        XCTAssertNil(byID["serverUrlMobile"], "the dead Server URL field is gone")
        XCTAssertEqual(byID["linkedDevicesMobile"]?.control, .custom)
    }

    func testSectionsIncludeGeneralAndExtensions() {
        let ids = SettingsSchema.sections.map(\.id)
        XCTAssertTrue(ids.contains("general"))
        XCTAssertTrue(ids.contains("extensions"))
        XCTAssertFalse(ids.contains("cto"))
        XCTAssertFalse(ids.contains("secrets"))
        // General leads, as on the desktop; the desktop-only sections are absent.
        XCTAssertEqual(ids, ["general", "box", "accounts", "models", "sessions", "files", "extensions", "voice"])
    }

    func testThemeStorageKeyMatchesTheStoresDeviceKey() {
        XCTAssertEqual(SettingsAppearance.storageKey, MantaSettingsStore.deviceStorageKey(entryID: "themeMobile"))
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

/// A config store whose every `update` SUSPENDS until the test releases it, so a
/// test can look at the store while a write is in flight.
@MainActor
private final class GatedConfigStore: SettingsConfigurationStore {
    var stored: [String: JSONValue] = [:]
    var updates: [[String: JSONValue]] = []
    var failUpdates = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    var inFlight: Int { waiters.count }

    func load() async -> [String: JSONValue]? { stored }

    func update(_ patch: [String: JSONValue]) async throws -> [String: JSONValue]? {
        updates.append(patch)
        await withCheckedContinuation { waiters.append($0) }
        if failUpdates { throw CancellationError() }
        stored.merge(patch) { _, new in new }
        return stored
    }

    func releaseAll() {
        let pending = waiters
        waiters = []
        for waiter in pending { waiter.resume() }
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

    /// Yield to the main actor until `condition` holds (a suspended gated write
    /// has reached the gate).
    private func waitUntil(_ message: String, _ condition: () -> Bool) async {
        for _ in 0..<500 where !condition() { await Task.yield() }
        XCTAssertTrue(condition(), message)
    }

    func testLoadSeedsConfigDrivenAndDeviceLocal() async {
        // Non-default on purpose ("5m" is the schema default) so this proves the
        // stored value is read rather than the default being echoed back.
        fake.stored["cacheTtl"] = .string("1h")
        fake.stored["autoRenameSessions"] = .bool(true)
        defaults.set("dark", forKey: "manta.settings.local.themeMobile")

        await store.load()

        XCTAssertEqual(store.current(entry(id: "cacheTtl")), .string("1h"))
        XCTAssertEqual(store.current(entry(id: "autoRenameSessions")), .bool(true))
        XCTAssertEqual(store.current(entry(id: "themeMobile")), .string("dark"))
        // Unset config-driven entries fall back to their schema default.
        XCTAssertEqual(store.current(entry(id: "groqApiKey")), .string(""))
        XCTAssertEqual(store.current(entry(id: "hapticsEnabled")), .bool(true))
        XCTAssertTrue(store.loaded)
    }

    func testLoadDoesNotInventValuesForCustomAnchors() async {
        await store.load()
        XCTAssertNil(store.values["linkedDevicesMobile"])
        XCTAssertNil(defaults.object(forKey: "manta.settings.local.linkedDevicesMobile"))
    }

    func testCommitConfigDrivenSendsCoercedPatch() async throws {
        await store.load()
        let confirmed = await store.commit(entry(id: "uploadCleanupHours"), .string("168"))

        XCTAssertTrue(confirmed)
        XCTAssertEqual(store.current(entry(id: "uploadCleanupHours")), .number(168))
        let last = try XCTUnwrap(fake.updates.last)
        XCTAssertEqual(last["uploadCleanupHours"], .number(168))
    }

    func testCommitDeviceLocalStaysInUserDefaultsAndNeverTouchesTheBox() async {
        await store.load()
        let confirmed = await store.commit(entry(id: "themeMobile"), .string("dark"))
        XCTAssertTrue(confirmed)
        XCTAssertEqual(defaults.string(forKey: "manta.settings.local.themeMobile"), "dark")
        XCTAssertEqual(store.current(entry(id: "themeMobile")), .string("dark"))
        XCTAssertTrue(fake.updates.isEmpty)
    }

    func testResetSectionIsUndoable() async throws {
        await store.load()
        // Commit the NON-default value so the reset below has something to undo.
        await store.commit(entry(id: "cacheTtl"), .string("1h"))
        fake.updates.removeAll()

        store.resetSection("models")
        await store.settled()
        XCTAssertEqual(store.current(entry(id: "cacheTtl")), .string("5m"))
        XCTAssertNotNil(store.undoMessage)

        store.undoLastReset()
        await store.settled()
        XCTAssertEqual(store.current(entry(id: "cacheTtl")), .string("1h"))
        XCTAssertNil(store.undoMessage)
    }

    func testResetAllIsUndoable() async throws {
        await store.load()
        await store.commit(entry(id: "autoRenameSessions"), .bool(true))
        await store.commit(entry(id: "themeMobile"), .string("dark"))

        store.resetAll()
        await store.settled()
        XCTAssertEqual(store.current(entry(id: "autoRenameSessions")), .bool(false))
        XCTAssertEqual(store.current(entry(id: "themeMobile")), .string("system"))
        XCTAssertNotNil(store.undoMessage)

        store.undoLastReset()
        await store.settled()
        XCTAssertEqual(store.current(entry(id: "autoRenameSessions")), .bool(true))
        XCTAssertEqual(store.current(entry(id: "themeMobile")), .string("dark"))
    }

    func testResetAllWritesNoAnchorKeysToTheBox() async throws {
        await store.load()
        store.resetAll()
        await store.settled()
        let patch = try XCTUnwrap(fake.updates.last)
        XCTAssertNil(patch["linkedDevicesMobile"])
        XCTAssertEqual(patch["hapticsEnabled"], .bool(true))
        XCTAssertNil(defaults.object(forKey: "manta.settings.local.updatesMobile"))
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

    // MARK: - Failure-safe commit (WS10 §0.2)

    func testAFailedSaveKeepsTheConfirmedValueAndSaysSo() async {
        fake.stored["worktreePerSession"] = .bool(false)
        await store.load()
        let worktree = entry(id: "worktreePerSession")
        fake.failUpdate = true

        let confirmed = await store.commit(worktree, .bool(true))

        XCTAssertFalse(confirmed)
        XCTAssertEqual(store.current(worktree), .bool(false), "the screen must not show a value the box never stored")
        XCTAssertEqual(store.values["worktreePerSession"], .bool(false))
        XCTAssertEqual(store.lastError, "Couldn't save Create git worktree for new sessions.")
        XCTAssertTrue(store.pending.isEmpty)
        XCTAssertTrue(store.saving.isEmpty)
    }

    func testASuccessfulSaveConfirmsTheValueAndClearsTheError() async {
        await store.load()
        let worktree = entry(id: "worktreePerSession")
        fake.failUpdate = true
        await store.commit(worktree, .bool(true))
        XCTAssertNotNil(store.lastError)
        fake.failUpdate = false

        let confirmed = await store.commit(worktree, .bool(true))

        XCTAssertTrue(confirmed)
        XCTAssertEqual(store.current(worktree), .bool(true))
        XCTAssertEqual(store.values["worktreePerSession"], .bool(true))
        XCTAssertNil(store.lastError)
    }

    func testClearErrorDismissesTheBanner() async {
        await store.load()
        fake.failUpdate = true
        await store.commit(entry(id: "worktreePerSession"), .bool(true))
        XCTAssertNotNil(store.lastError)
        store.clearError()
        XCTAssertNil(store.lastError)
    }

    func testASecondCommitForTheSameEntryWhileOneIsInFlightIsRefused() async {
        let gate = GatedConfigStore()
        let gated = MantaSettingsStore(configuration: gate, defaults: defaults)
        await gated.load()
        let worktree = entry(id: "worktreePerSession")

        let first = Task { await gated.commit(worktree, .bool(true)) }
        await waitUntil("the write reached the gate") { gate.inFlight == 1 }

        // While suspended: the control already shows the pending value, the row is
        // marked saving, and nothing is confirmed yet.
        XCTAssertEqual(gated.current(worktree), .bool(true))
        XCTAssertTrue(gated.saving.contains("worktreePerSession"))
        XCTAssertNil(gated.values["worktreePerSession"])

        let second = await gated.commit(worktree, .bool(false))
        XCTAssertFalse(second)
        XCTAssertEqual(gate.updates.count, 1, "no second update was issued")

        gate.releaseAll()
        let confirmed = await first.value
        XCTAssertTrue(confirmed)
        XCTAssertEqual(gated.values["worktreePerSession"], .bool(true))
        XCTAssertTrue(gated.saving.isEmpty)
        XCTAssertTrue(gated.pending.isEmpty)
    }

    func testADifferentEntryMaySaveWhileAnotherIsInFlight() async {
        let gate = GatedConfigStore()
        let gated = MantaSettingsStore(configuration: gate, defaults: defaults)
        await gated.load()

        let a = Task { await gated.commit(entry(id: "worktreePerSession"), .bool(true)) }
        await waitUntil("first write at the gate") { gate.inFlight == 1 }
        let b = Task { await gated.commit(entry(id: "autoRenameSessions"), .bool(true)) }
        await waitUntil("second write at the gate") { gate.inFlight == 2 }

        gate.releaseAll()
        let (ra, rb) = await (a.value, b.value)
        XCTAssertTrue(ra)
        XCTAssertTrue(rb)
    }

    // MARK: - Mutation guard (reset / undo vs. commit)

    /// (a) a pending commit blocks reset-all.
    func testResetAllIsRefusedWhileACommitIsInFlight() async {
        let gate = GatedConfigStore()
        let gated = MantaSettingsStore(configuration: gate, defaults: defaults)
        await gated.load()
        let worktree = entry(id: "worktreePerSession")

        let commit = Task { await gated.commit(worktree, .bool(true)) }
        await waitUntil("commit at the gate") { gate.inFlight == 1 }
        XCTAssertTrue(gated.isMutating)

        gated.resetAll()
        XCTAssertEqual(gate.updates.count, 1, "no reset write was issued")
        XCTAssertNil(gated.undoMessage)
        XCTAssertFalse(gated.batchWriting)

        gate.releaseAll()
        _ = await commit.value
        XCTAssertEqual(gated.values["worktreePerSession"], .bool(true))
        XCTAssertFalse(gated.isMutating)
    }

    /// (b) a pending reset blocks commits, and the value stays put.
    func testACommitIsRefusedWhileAResetIsInFlight() async {
        let gate = GatedConfigStore()
        let gated = MantaSettingsStore(configuration: gate, defaults: defaults)
        await gated.load()
        let worktree = entry(id: "worktreePerSession")

        gated.resetAll()
        XCTAssertTrue(gated.batchWriting, "the guard is visible synchronously, before the write even starts")
        await waitUntil("reset write at the gate") { gate.inFlight == 1 }
        XCTAssertTrue(gated.isMutating)

        let refused = await gated.commit(worktree, .bool(true))
        XCTAssertFalse(refused)
        XCTAssertEqual(gate.updates.count, 1, "no commit update was issued")
        XCTAssertEqual(gated.current(worktree), .bool(false))

        gate.releaseAll()
        await gated.settled()
        XCTAssertFalse(gated.batchWriting)
        XCTAssertFalse(gated.isMutating)
        XCTAssertEqual(gated.current(worktree), .bool(false))
    }

    /// (c) a pending reset blocks undo until it settles; then undo works.
    func testUndoWaitsForTheResetToSettle() async {
        let gate = GatedConfigStore()
        let gated = MantaSettingsStore(configuration: gate, defaults: defaults)
        gate.stored["autoRenameSessions"] = .bool(true)
        await gated.load()
        let autoRename = entry(id: "autoRenameSessions")

        gated.resetAll()
        await waitUntil("reset write at the gate") { gate.inFlight == 1 }
        XCTAssertEqual(gated.current(autoRename), .bool(false))

        gated.undoLastReset()
        XCTAssertEqual(gate.updates.count, 1, "undo did nothing while the reset was pending")
        XCTAssertNotNil(gated.undoMessage)

        gate.releaseAll()
        await gated.settled()
        gated.undoLastReset()
        XCTAssertEqual(gated.current(autoRename), .bool(true))
        XCTAssertNil(gated.undoMessage)
        await waitUntil("undo write at the gate") { gate.inFlight == 1 }
        gate.releaseAll()
        await gated.settled()
    }

    /// (d) `isMutating` reflects both kinds of write.
    func testIsMutatingReflectsBothSingleAndBatchWrites() async {
        let gate = GatedConfigStore()
        let gated = MantaSettingsStore(configuration: gate, defaults: defaults)
        await gated.load()
        XCTAssertFalse(gated.isMutating)

        let single = Task { await gated.commit(entry(id: "worktreePerSession"), .bool(true)) }
        await waitUntil("single at the gate") { gate.inFlight == 1 }
        XCTAssertTrue(gated.isMutating)
        gate.releaseAll()
        _ = await single.value
        XCTAssertFalse(gated.isMutating)

        gated.resetSection("sessions")
        XCTAssertTrue(gated.isMutating)
        await waitUntil("batch at the gate") { gate.inFlight == 1 }
        gate.releaseAll()
        await gated.settled()
        XCTAssertFalse(gated.isMutating)
    }

    func testAFailedResetIsReportedAndReleasesTheGuard() async {
        let gate = GatedConfigStore()
        gate.failUpdates = true
        let gated = MantaSettingsStore(configuration: gate, defaults: defaults)
        await gated.load()

        gated.resetAll()
        await waitUntil("reset write at the gate") { gate.inFlight == 1 }
        gate.releaseAll()
        await gated.settled()

        XCTAssertEqual(gated.lastError, "Couldn't reset settings.")
        XCTAssertFalse(gated.batchWriting)
    }
}
