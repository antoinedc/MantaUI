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
//   - device-local entries (`configKey == nil`, e.g. `serverUrlMobile`) stay
//     on-device via `UserDefaults` (not a credential — safe there, matching the
//     retired implementation's localStorage).
//
// The PURE decisions (defaults, Modified, per-section reset, reset-all, undo
// snapshot, segmented coercion) live in `MantaSettingsModels.swift`; this store
// is the I/O + published-state wiring around them. Persistence is injected
// (`SettingsConfigurationStore`) so the wiring is unit-testable without a box.
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

    /// Current value per schema entry id. Absent keys read as the schema
    /// default, so `current(_:)` never shows a nil fallback surprise.
    @Published private(set) var values: [String: SettingValue] = [:]
    @Published private(set) var loaded = false
    @Published private(set) var lastError: String?
    /// Set after a per-section reset / reset-all offers an undo action.
    @Published private(set) var undoMessage: String?

    /// Snapshot captured before the most recent reset, restored by undo.
    private var undoSnapshot: [String: SettingValue] = [:]

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
    // MARK: - Value surface (read)

    func current(_ entry: SettingEntry) -> SettingValue {
        values[entry.id] ?? MantaSettingsLogic.defaultValue(of: entry)
    }

    func isModified(_ entry: SettingEntry) -> Bool {
        MantaSettingsLogic.isModified(entry, current(entry))
    }

    func sectionModified(_ sectionID: String) -> Bool {
        MantaSettingsLogic.sectionIsModified(sectionID, values)
    }

    // MARK: - Load

    func load() async {
        for entry in SettingsSchema.entries where entry.configKey == nil {
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
            lastError = "Couldn't load settings from the box."
        }
        loaded = true
    }

    // MARK: - Commit (instant apply)

    func commit(_ entry: SettingEntry, _ value: SettingValue) {
        let coerced = MantaSettingsLogic.coerce(entry, value)
        values[entry.id] = coerced
        if let configKey = entry.configKey {
            Task {
                do {
                    _ = try await configuration.update([configKey: coerced.json])
                    lastError = nil
                } catch {
                    lastError = "Couldn't save \(entry.label)."
                }
            }
        } else {
            persistDeviceLocal(entry, value: coerced)
        }
    }

    /// Set a config-driven boolean and persist it over `config:update` (the
    /// store's own persistence path — the same one Settings uses), then flip
    /// the in-memory value.
    ///
    /// Unlike `commit`, which flips the value optimistically and swallows the
    /// box's answer, this AWAITS the update and only mutates the published
    /// value after the box confirms. A failed `config:update` throws (so the
    /// caller can revert / surface it) and leaves the stored value untouched —
    /// never a fabricated success. This is the chat trust-mode toggle's path
    /// (BET-748).
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
        applyReset(MantaSettingsLogic.sectionResetValues(sectionID),
                   message: "Section reset to defaults.")
    }

    func resetAll() {
        applyReset(MantaSettingsLogic.resetAllValues(),
                   message: "All settings reset to defaults.")
    }

    func undoLastReset() {
        guard !undoSnapshot.isEmpty else { return }
        restore(undoSnapshot)
        undoSnapshot = [:]
        undoMessage = nil
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

        if !patch.isEmpty {
            Task {
                do {
                    _ = try await configuration.update(patch)
                    lastError = nil
                } catch {
                    lastError = "Couldn't reset settings."
                }
            }
        }
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
        if !patch.isEmpty {
            Task {
                do {
                    _ = try await configuration.update(patch)
                    lastError = nil
                } catch {
                    lastError = "Couldn't restore settings."
                }
            }
        }
    }

    // MARK: - Device-local persistence (UserDefaults)

    private func deviceStorageKey(_ entry: SettingEntry) -> String {
        "manta.settings.local.\(entry.id)"
    }

    private func readDeviceLocal(_ entry: SettingEntry) -> SettingValue {
        let key = deviceStorageKey(entry)
        if let s = defaults.string(forKey: key) { return .string(s) }
        if entry.defaultBool != nil { return .bool(defaults.bool(forKey: key)) }
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
