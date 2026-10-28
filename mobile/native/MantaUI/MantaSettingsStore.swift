import Foundation
import Combine

// ===========================================================================
// S7 — settings store + persistence (BET-599).
//
// Owns the live values behind the settings screen, rendered from the GENERATED
// `SettingsSchema` inventory:
//   - config-driven entries (those with a `configKey`) persist through the
//     shared `config:update` RPC, so the box is the source of truth and the
//     changes are visible to every surface that reads config (the S5 mic gate
//     reads `groqApiKey`, the upload sweep reads `uploadCleanupHours`, etc.);
//   - device-local entries (`configKey == nil`, e.g. `themeMobile`) stay
//     on-device via `UserDefaults` (not a credential — safe there, matching the
//     retired implementation's localStorage).
//
// The PURE decisions (defaults, Modified, per-section reset, reset-all, undo
// snapshot, segmented coercion) live in `MantaSettingsModels.swift`; this store
// is the I/O + published-state wiring around them. Persistence is injected
// (`SettingsConfigurationStore`) so the wiring is unit-testable without a box.
//
// FAILURE-SAFE SAVES (WS10 §0.2). `values` holds only CONFIRMED values (loaded
// from the box or acknowledged by it). A config write is awaited and serialized
// per entry: while it is in flight the new value lives in `pending` (so the
// control moves at once) and the entry is in `saving` (so the row is disabled);
// success promotes it into `values`, failure leaves the confirmed value in
// place and sets `lastError` — which the screen renders. Reset / undo are
// batch writes guarded against commits by `isMutating`, so a pending toggle and
// a reset can never interleave.
// ===========================================================================

/// The config read/write seam for settings, so the store is testable without a
/// live box. The live adapter wraps `MantaAPIClient.configGet`/`configUpdate`.
/// MainActor-isolated so the store's unstructured `Task`s (which inherit the
/// caller's MainActor context) never send the non-Sendable config dict across
/// an isolation boundary.
@MainActor
protocol SettingsConfigurationStore {
    func load() async -> [String: JSONValue]?
    func update(_ patch: [String: JSONValue]) async throws -> [String: JSONValue]?
}

@MainActor
struct ServerSettingsConfigurationStore: SettingsConfigurationStore {
    let api: MantaAPIClient

    func load() async -> [String: JSONValue]? {
        try? await api.configGet()
    }

    func update(_ patch: [String: JSONValue]) async throws -> [String: JSONValue]? {
        var any: [String: Any] = [:]
        for (key, value) in patch {
            any[key] = MantaSettingsLogic.anyValue(value)
        }
        return try await api.configUpdate(any)
    }
}

@MainActor
final class MantaSettingsStore: ObservableObject {

    /// CONFIRMED value per schema entry id. Absent keys read as the schema
    /// default, so `current(_:)` never shows a nil fallback surprise.
    @Published private(set) var values: [String: SettingValue] = [:]
    @Published private(set) var loaded = false
    @Published private(set) var lastError: String?
    /// Set after a per-section reset / reset-all offers an undo action.
    @Published private(set) var undoMessage: String?

    /// Values being saved right now, keyed by entry id. `current(_:)` prefers
    /// them so a control moves the instant it is tapped; they never reach
    /// `values` until the box acknowledges the write.
    @Published private(set) var pending: [String: SettingValue] = [:]
    /// Entries with a config write in flight — their rows render disabled.
    @Published private(set) var saving: Set<String> = []
    /// True while a reset / undo batch write is in flight.
    @Published private(set) var batchWriting = false

    /// Any write (single or batch) in flight. Reset / undo refuse to start while
    /// it is set; config commits refuse while `batchWriting`.
    var isMutating: Bool { batchWriting || !saving.isEmpty }

    /// Snapshot captured before the most recent reset, restored by undo.
    private var undoSnapshot: [String: SettingValue] = [:]

    /// The in-flight batch write, so callers (and tests) can wait for it.
    private var batchTask: Task<Void, Never>?

    private let configuration: SettingsConfigurationStore
    private let defaults: UserDefaults

    init(configuration: SettingsConfigurationStore? = nil,
         defaults: UserDefaults = .standard) {
        self.configuration = configuration ?? MantaSettingsStore.liveConfiguration()
        self.defaults = defaults
    }

    static func liveConfiguration() -> SettingsConfigurationStore {
        ServerSettingsConfigurationStore(api: .live())
    }

    /// The UserDefaults key a device-local entry persists under. The one place
    /// the format lives; `SettingsAppearance.storageKey` must equal this for
    /// `themeMobile` (pinned by a test).
    nonisolated static func deviceStorageKey(entryID: String) -> String {
        "manta.settings.local.\(entryID)"
    }

    // MARK: - Value surface (read)

    func current(_ entry: SettingEntry) -> SettingValue {
        pending[entry.id] ?? values[entry.id] ?? MantaSettingsLogic.defaultValue(of: entry)
    }

    func isModified(_ entry: SettingEntry) -> Bool {
        MantaSettingsLogic.isModified(entry, current(entry))
    }

    func sectionModified(_ sectionID: String) -> Bool {
        MantaSettingsLogic.sectionIsModified(sectionID, values)
    }

    func clearError() {
        lastError = nil
    }

    // MARK: - Load

    func load() async {
        // `custom` entries are screens, not values: nothing to read for them.
        for entry in SettingsSchema.entries where entry.configKey == nil && entry.control != .custom {
            values[entry.id] = readDeviceLocal(entry)
        }

        let config = await configuration.load()
        if let config {
            for entry in SettingsSchema.entries {
                guard let configKey = entry.configKey, let raw = config[configKey] else { continue }
                values[entry.id] = SettingValue.from(raw)
            }
            lastError = nil
        } else {
            lastError = "Couldn't load settings from the server."
        }
        loaded = true
    }

    // MARK: - Commit (instant apply, awaited + serialized)

    /// Persist `value` for `entry`. Returns true when the value is now the
    /// confirmed one (device-local entries always; config entries once the box
    /// acknowledged). Returns false when the write failed (the confirmed value
    /// is untouched and `lastError` is set) or was refused because a write for
    /// this entry / a reset is already running — rows are disabled in those
    /// states, so the refusal is a guard, not a UX path.
    @discardableResult
    func commit(_ entry: SettingEntry, _ value: SettingValue) async -> Bool {
        let coerced = MantaSettingsLogic.coerce(entry, value)
        guard let configKey = entry.configKey else {
            values[entry.id] = coerced
            persistDeviceLocal(entry, value: coerced)
            return true
        }
        guard !batchWriting, !saving.contains(entry.id) else { return false }

        saving.insert(entry.id)
        pending[entry.id] = coerced
        let confirmed: Bool
        do {
            _ = try await configuration.update([configKey: coerced.json])
            values[entry.id] = coerced
            lastError = nil
            confirmed = true
        } catch {
            lastError = "Couldn't save \(entry.label)."
            confirmed = false
        }
        pending[entry.id] = nil
        saving.remove(entry.id)
        return confirmed
    }

    /// Set a config-driven boolean and persist it over `config:update` (the
    /// store's own persistence path — the same one Settings uses), then flip
    /// the in-memory value.
    ///
    /// Unlike `commit`, this THROWS on a failed update so the caller can revert
    /// / surface it in its own way, and never fabricates a success. This is the
    /// chat trust-mode toggle's path (BET-748).
    func setBool(_ entry: SettingEntry, _ value: Bool) async throws {
        guard let configKey = entry.configKey else {
            // Device-local entries persist locally; there is no box round-trip
            // to fail, so flip directly.
            values[entry.id] = .bool(value)
            persistDeviceLocal(entry, value: .bool(value))
            return
        }
        _ = try await configuration.update([configKey: .bool(value)])
        values[entry.id] = .bool(value)
        lastError = nil
    }

    // MARK: - Reset (per-section + reset-all), both undoable

    func resetSection(_ sectionID: String) {
        guard !isMutating else { return }
        applyReset(MantaSettingsLogic.sectionResetValues(sectionID),
                   message: "Section reset to defaults.")
    }

    func resetAll() {
        guard !isMutating else { return }
        applyReset(MantaSettingsLogic.resetAllValues(),
                   message: "All settings reset to defaults.")
    }

    func undoLastReset() {
        guard !isMutating, !undoSnapshot.isEmpty else { return }
        restore(undoSnapshot)
        undoSnapshot = [:]
        undoMessage = nil
    }

    /// Resolves once the in-flight reset / undo write (if any) has finished.
    func settled() async {
        await batchTask?.value
    }

    private func applyReset(_ targets: [String: SettingValue], message: String) {
        var snapshot: [String: SettingValue] = [:]
        for key in targets.keys {
            snapshot[key] = values[key] ?? MantaSettingsLogic.defaultValue(of: entry(id: key))
        }
        undoSnapshot = snapshot

        var patch: [String: JSONValue] = [:]
        for entry in SettingsSchema.entries {
            guard let target = targets[entry.id] else { continue }
            values[entry.id] = target
            if let configKey = entry.configKey {
                patch[configKey] = target.json
            } else {
                persistDeviceLocal(entry, value: target)
            }
        }

        writeBatch(patch, failure: "Couldn't reset settings.")
        undoMessage = message
    }

    private func restore(_ snapshot: [String: SettingValue]) {
        var patch: [String: JSONValue] = [:]
        for entry in SettingsSchema.entries {
            guard let value = snapshot[entry.id] else { continue }
            values[entry.id] = value
            if let configKey = entry.configKey {
                patch[configKey] = value.json
            } else {
                persistDeviceLocal(entry, value: value)
            }
        }
        writeBatch(patch, failure: "Couldn't restore settings.")
    }

    /// Send `patch` as one config write. `batchWriting` is set synchronously,
    /// before this returns, so the very next reset / undo / commit sees it.
    private func writeBatch(_ patch: [String: JSONValue], failure: String) {
        guard !patch.isEmpty else { return }
        batchWriting = true
        batchTask = Task {
            do {
                _ = try await configuration.update(patch)
                self.lastError = nil
            } catch {
                self.lastError = failure
            }
            self.batchWriting = false
        }
    }

    // MARK: - Device-local persistence (UserDefaults)

    private func deviceStorageKey(_ entry: SettingEntry) -> String {
        Self.deviceStorageKey(entryID: entry.id)
    }

    private func readDeviceLocal(_ entry: SettingEntry) -> SettingValue {
        let key = deviceStorageKey(entry)
        if let s = defaults.string(forKey: key) { return .string(s) }
        if entry.defaultBool != nil, let stored = defaults.object(forKey: key) as? Bool { return .bool(stored) }
        return MantaSettingsLogic.defaultValue(of: entry)
    }

    private func persistDeviceLocal(_ entry: SettingEntry, value: SettingValue) {
        let key = deviceStorageKey(entry)
        switch value {
        case .string(let s): defaults.set(s, forKey: key)
        case .bool(let b): defaults.set(b, forKey: key)
        case .number(let n): defaults.set(n, forKey: key)
        case .null: defaults.removeObject(forKey: key)
        }
    }

    private func entry(id: String) -> SettingEntry {
        SettingsSchema.entries.first { $0.id == id }
            ?? SettingsSchema.entries[0]
    }
}
