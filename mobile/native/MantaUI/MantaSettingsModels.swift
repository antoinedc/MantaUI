import Foundation

// ===========================================================================
// S7 — settings value model + pure decision logic (BET-599).
//
// The settings INVENTORY lives in the GENERATED `SettingsSchema` (from
// src/shared/settingsSchema.ts via scripts/gen-swift-settings.mjs) — this file
// holds the value layer that reads/writes ./compares against it and mirrors the
// shared schema's pure helpers (`isModified`, `sectionIsModified`,
// `resetAllPayload`) so the Modified dot, per-section reset and undoable
// reset-all behave exactly like the retired mobile implementation.
//
// This file is PURE (no MantaAPIClient, no UserDefaults, no SwiftUI) so the
// decisions are unit-testable like the shared TS helpers they mirror. The I/O
// (config:get/config:update + device-local UserDefaults) lives in
// `MantaSettingsStore.swift`.
// ===========================================================================

/// The typed current value of a setting, mirroring the shared schema's
/// `unknown` default slots. Config values decode from `JSONValue`; device-local
/// values build directly from Swift.
enum SettingValue: Equatable {
    case string(String)
    case bool(Bool)
    case number(Double)
    case null

    static func from(_ value: JSONValue?) -> SettingValue {
        guard let value else { return .null }
        switch value {
        case .string(let s): return .string(s)
        case .bool(let b): return .bool(b)
        case .number(let n): return .number(n)
        default: return .null
        }
    }

    /// JSON payload sent to `config:update`.
    var payload: Any {
        switch self {
        case .string(let s): return s
        case .bool(let b): return b
        case .number(let n): return n
        case .null: return NSNull()
        }
    }

    /// JSON payload sent to `config:update` (Sendable form).
    var json: JSONValue {
        switch self {
        case .string(let s): return .string(s)
        case .bool(let b): return .bool(b)
        case .number(let n): return .number(n)
        case .null: return .null
        }
    }

    /// Best-effort text used for the undo/apply toast, mirroring the TS
    /// `describeValue`.
    var displayText: String {
        switch self {
        case .string(let s): return s
        case .bool(let b): return b ? "on" : "off"
        case .number(let n): return String(format: "%g", n)
        case .null: return ""
        }
    }
}

/// Pure helpers mirroring `src/shared/settingsSchema.ts` over the generated
/// `SettingsSchema` inventory.
enum MantaSettingsLogic {

    /// The schema's default for an entry, resolved to a typed value.
    static func defaultValue(of entry: SettingEntry) -> SettingValue {
        if let s = entry.defaultString { return .string(s) }
        if let b = entry.defaultBool { return .bool(b) }
        if let n = entry.defaultNumber { return .number(n) }
        return .null
    }

    /// True when the entry's current value differs from its default (mirrors
    /// the shared `isModified`). Device-local and config-driven entries both
    /// compare against the schema default.
    static func isModified(_ entry: SettingEntry, _ value: SettingValue) -> Bool {
        value != defaultValue(of: entry)
    }

    /// True when any config-driven entry in the section is non-default
    /// (mirrors the shared `sectionIsModified`).
    static func sectionIsModified(_ sectionID: String, _ values: [String: SettingValue]) -> Bool {
        SettingsSchema.entries(in: sectionID).contains { entry in
            guard entry.configKey != nil else { return false }
            let current = values[entry.id] ?? defaultValue(of: entry)
            return isModified(entry, current)
        }
    }

    /// `entry.id -> default` for every entry in a section (config-driven AND
    /// device-local). Used by per-section reset.
    static func sectionResetValues(_ sectionID: String) -> [String: SettingValue] {
        var out: [String: SettingValue] = [:]
        for entry in SettingsSchema.entries(in: sectionID) {
            out[entry.id] = defaultValue(of: entry)
        }
        return out
    }

    /// `entry.id -> default` for the whole schema. Drives reset-all (both
    /// config-driven and device-local); mirror of the shared
    /// `resetAllPayload` but keyed by entry id so the surface can undo
    /// device-local settings too.
    static func resetAllValues() -> [String: SettingValue] {
        var out: [String: SettingValue] = [:]
        for entry in SettingsSchema.entries {
            out[entry.id] = defaultValue(of: entry)
        }
        return out
    }

    /// Coerce a UI-produced value to the entry's stored type. Segmented
    /// controls emit their option `value` (always a string); when the entry's
    /// default is a number (e.g. uploadCleanupHours), coerce to a number so
    /// the server config stays numeric (keeps the Modified comparison
    /// strict-equal and the box poller's arithmetic correct).
    static func coerce(_ entry: SettingEntry, _ value: SettingValue) -> SettingValue {
        if entry.control == .segmented, entry.defaultNumber != nil,
           case .string(let s) = value, let n = Double(s) {
            return .number(n)
        }
        return value
    }

    /// Bridge a `JSONValue` to the `Any` form `MantaAPIClient.configUpdate`
    /// consumes (`JSONSerialization`, not `Codable`, so it must be an
    /// NSString/NSNumber/NSArray/NSDictionary-compatible graph).
    static func anyValue(_ value: JSONValue) -> Any {
        switch value {
        case .string(let s): return s
        case .bool(let b): return b
        case .number(let n): return n
        case .null: return NSNull()
        case .object(let o): return o.mapValues { anyValue($0) }
        case .array(let a): return a.map { anyValue($0) }
        }
    }
}
