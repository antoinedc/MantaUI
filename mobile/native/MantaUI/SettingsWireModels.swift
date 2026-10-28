import Foundation

// ===========================================================================
// WS10 — wire types for the Settings / Box / Extensions RPC members in
// `MantaAPIClient+Settings.swift`. Foundation-only (compiled by the Linux
// SwiftPM package, D19) and TOLERANT: an older or newer box that adds, drops or
// nulls a field must never blank a screen, so optional fields decode with
// `try?` and absent counters default to a harmless value.
//
// Mirrors src/shared/types.ts / src/shared/api.ts (the desktop's contract).
// ===========================================================================

/// `{ ok: true }` or `{ ok: false, error }` — the shape of `opencode:restart`,
/// `forge:disconnect`, `opencode:set-references`. (Also consumed by WS08.)
struct OkResult: Decodable, Equatable, Sendable {
    var ok: Bool
    var error: String?

    init(ok: Bool, error: String? = nil) {
        self.ok = ok
        self.error = error
    }
}

/// `server:version` — `{ version, minClient, opencodeVersion }`.
struct ServerVersionInfo: Decodable, Equatable, Sendable {
    var version: String
    var minClient: String?
    var opencodeVersion: String?

    init(version: String, minClient: String? = nil, opencodeVersion: String? = nil) {
        self.version = version
        self.minClient = minClient
        self.opencodeVersion = opencodeVersion
    }
}

// MARK: - Updates

/// One line in the unified update list (`UpdateTarget`, types.ts). `ok == false`
/// means "we could not determine" and must NEVER render as up to date.
struct UpdateTarget: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var label: String
    var current: String?
    var latest: String?
    var available: Bool
    var ok: Bool
    var manual: Bool
    var manualUrl: String?
    /// "none" | "reconnect" | "ends-turns" | "app-restart"
    var disruption: String

    init(id: String, label: String, current: String? = nil, latest: String? = nil,
         available: Bool = false, ok: Bool = true, manual: Bool = false,
         manualUrl: String? = nil, disruption: String = "none") {
        self.id = id
        self.label = label
        self.current = current
        self.latest = latest
        self.available = available
        self.ok = ok
        self.manual = manual
        self.manualUrl = manualUrl
        self.disruption = disruption
    }

    private enum CodingKeys: String, CodingKey {
        case id, label, current, latest, available, ok, manual, manualUrl, disruption
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decode(String.self, forKey: .label)
        current = (try? c.decodeIfPresent(String.self, forKey: .current)) ?? nil
        latest = (try? c.decodeIfPresent(String.self, forKey: .latest)) ?? nil
        available = ((try? c.decodeIfPresent(Bool.self, forKey: .available)) ?? nil) ?? false
        // Absent `ok` is treated as true (an old box), exactly like the desktop.
        ok = ((try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? nil) ?? true
        manual = ((try? c.decodeIfPresent(Bool.self, forKey: .manual)) ?? nil) ?? false
        manualUrl = (try? c.decodeIfPresent(String.self, forKey: .manualUrl)) ?? nil
        disruption = ((try? c.decodeIfPresent(String.self, forKey: .disruption)) ?? nil) ?? "none"
    }
}

/// `server:update-check` — the box verdict plus the box-side CLI targets.
struct ServerUpdateCheck: Decodable, Equatable, Sendable {
    var available: Bool
    var version: String?
    var notesUrl: String?
    /// nil on an old box (treated as true).
    var ok: Bool?
    var targets: [UpdateTarget]?

    init(available: Bool, version: String? = nil, notesUrl: String? = nil,
         ok: Bool? = nil, targets: [UpdateTarget]? = nil) {
        self.available = available
        self.version = version
        self.notesUrl = notesUrl
        self.ok = ok
        self.targets = targets
    }

    private enum CodingKeys: String, CodingKey { case available, version, notesUrl, ok, targets }

    /// Decodes an element without letting its failure drop the whole list.
    private struct LossyTarget: Decodable {
        let target: UpdateTarget?
        init(from decoder: Decoder) throws { target = try? UpdateTarget(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = ((try? c.decodeIfPresent(Bool.self, forKey: .available)) ?? nil) ?? false
        version = (try? c.decodeIfPresent(String.self, forKey: .version)) ?? nil
        notesUrl = (try? c.decodeIfPresent(String.self, forKey: .notesUrl)) ?? nil
        ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? nil
        if let lossy = try? c.decodeIfPresent([LossyTarget].self, forKey: .targets) {
            targets = lossy.compactMap(\.target)
        } else {
            targets = nil
        }
    }
}

/// `server:cli-update` — never throws on the box; `{ ok: false, error }` instead.
struct CliUpdateResult: Decodable, Equatable, Sendable {
    var ok: Bool
    var before: String?
    var after: String?
    var changed: Bool?
    var error: String?

    init(ok: Bool, before: String? = nil, after: String? = nil, changed: Bool? = nil, error: String? = nil) {
        self.ok = ok
        self.before = before
        self.after = after
        self.changed = changed
        self.error = error
    }
}

// MARK: - Window layout backup (tmux:restore-*)

struct TopologyRestoreOp: Decodable, Equatable, Sendable {
    var kind: String?
    var tmuxSession: String
    var index: Int?
    var name: String?

    init(kind: String? = nil, tmuxSession: String, index: Int? = nil, name: String? = nil) {
        self.kind = kind
        self.tmuxSession = tmuxSession
        self.index = index
        self.name = name
    }

    private enum CodingKeys: String, CodingKey { case kind, tmuxSession, index, name }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? nil
        tmuxSession = try c.decode(String.self, forKey: .tmuxSession)
        index = (try? c.decodeIfPresent(Int.self, forKey: .index)) ?? nil
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil
    }
}

struct TopologyRestoreSkipped: Decodable, Equatable, Sendable {
    var tmuxSession: String
    var index: Int?
    var name: String?
    /// "index-occupied" | "already-restored" | "opencode-session-gone"
    var reason: String?

    init(tmuxSession: String, index: Int? = nil, name: String? = nil, reason: String? = nil) {
        self.tmuxSession = tmuxSession
        self.index = index
        self.name = name
        self.reason = reason
    }

    private enum CodingKeys: String, CodingKey { case tmuxSession, index, name, reason }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tmuxSession = try c.decode(String.self, forKey: .tmuxSession)
        index = (try? c.decodeIfPresent(Int.self, forKey: .index)) ?? nil
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil
        reason = (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? nil
    }
}

/// `tmux:restore-preview` — READ-ONLY. `available == false` means no usable
/// snapshot (a normal answer — "No backup yet"), distinct from a failed request.
struct TopologyRestorePreview: Decodable, Equatable, Sendable {
    var available: Bool
    /// Epoch milliseconds, nil when never captured.
    var capturedAt: Double?
    var ops: [TopologyRestoreOp]
    var skipped: [TopologyRestoreSkipped]
    var restorable: Int

    init(available: Bool, capturedAt: Double? = nil, ops: [TopologyRestoreOp] = [],
         skipped: [TopologyRestoreSkipped] = [], restorable: Int? = nil) {
        self.available = available
        self.capturedAt = capturedAt
        self.ops = ops
        self.skipped = skipped
        self.restorable = restorable ?? ops.count
    }

    private enum CodingKeys: String, CodingKey { case available, capturedAt, ops, skipped, restorable }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = try c.decode(Bool.self, forKey: .available)
        capturedAt = (try? c.decodeIfPresent(Double.self, forKey: .capturedAt)) ?? nil
        ops = ((try? c.decodeIfPresent([TopologyRestoreOp].self, forKey: .ops)) ?? nil) ?? []
        skipped = ((try? c.decodeIfPresent([TopologyRestoreSkipped].self, forKey: .skipped)) ?? nil) ?? []
        restorable = ((try? c.decodeIfPresent(Int.self, forKey: .restorable)) ?? nil) ?? ops.count
    }
}

/// `tmux:restore-topology`.
struct TopologyRestoreResult: Decodable, Equatable, Sendable {
    var ok: Bool
    var error: String?
    var created: Int?
    var failed: Int?
    var message: String?

    init(ok: Bool, error: String? = nil, created: Int? = nil, failed: Int? = nil, message: String? = nil) {
        self.ok = ok
        self.error = error
        self.created = created
        self.failed = failed
        self.message = message
    }
}

// MARK: - Pairing code mint (auth:pair)

/// `auth:pair` — a one-time pairing code. NOTE the wire `expiresAt` is the
/// server's epoch-MILLISECONDS number (`authEngine.pair()` → `now() + ttl`), although
/// the desktop's TS type calls it an ISO string; the desktop only ever feeds it
/// to `new Date(...)`, which accepts both. This decodes either (and epoch
/// seconds) into a `Date`.
struct AuthPairResult: Decodable, Equatable, Sendable {
    var ok: Bool
    var pairingCode: String?
    var boxId: String?
    var expiresAt: Date?
    var error: String?

    init(ok: Bool, pairingCode: String? = nil, boxId: String? = nil, expiresAt: Date? = nil, error: String? = nil) {
        self.ok = ok
        self.pairingCode = pairingCode
        self.boxId = boxId
        self.expiresAt = expiresAt
        self.error = error
    }

    private enum CodingKeys: String, CodingKey { case ok, pairingCode, boxId, expiresAt, error }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decode(Bool.self, forKey: .ok)
        pairingCode = (try? c.decodeIfPresent(String.self, forKey: .pairingCode)) ?? nil
        boxId = (try? c.decodeIfPresent(String.self, forKey: .boxId)) ?? nil
        error = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? nil
        if let n = (try? c.decodeIfPresent(Double.self, forKey: .expiresAt)) ?? nil {
            expiresAt = BoxPairing.date(fromEpoch: n)
        } else if let s = (try? c.decodeIfPresent(String.self, forKey: .expiresAt)) ?? nil {
            expiresAt = BoxPairing.parseExpiresAt(s)
        } else {
            expiresAt = nil
        }
    }
}

// MARK: - Plugins (plugins:registry)

struct PluginRegistryInput: Decodable, Equatable, Sendable {
    var id: String
    var description: String
    var type: String
    var `default`: JSONValue?
    var values: [String]?

    private enum CodingKeys: String, CodingKey { case id, description, type, `default`, values }

    init(id: String, description: String = "", type: String = "string",
         default defaultValue: JSONValue? = nil, values: [String]? = nil) {
        self.id = id
        self.description = description
        self.type = type
        self.default = defaultValue
        self.values = values
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        description = ((try? c.decodeIfPresent(String.self, forKey: .description)) ?? nil) ?? ""
        type = ((try? c.decodeIfPresent(String.self, forKey: .type)) ?? nil) ?? "string"
        // A missing key stays nil. (An explicit JSON null also reads as nil —
        // `decodeIfPresent` folds null into absent; the desktop would print
        // "id=null", which carries no information a user needs.)
        `default` = (try? c.decodeIfPresent(JSONValue.self, forKey: .default)) ?? nil
        values = (try? c.decodeIfPresent([String].self, forKey: .values)) ?? nil
    }
}

/// One installed plugin as the Mac executor published it. `valid == false` rows
/// carry the validator's `error` so the user can see why a YAML did not load.
struct PluginRegistryRow: Decodable, Equatable, Sendable, Identifiable {
    var name: String
    var description: String
    var inputs: [PluginRegistryInput]
    var valid: Bool
    var error: String?
    var yaml: String
    var stepCount: Int
    var timeoutMs: Double?

    var id: String { name }

    init(name: String, description: String = "", inputs: [PluginRegistryInput] = [], valid: Bool = true,
         error: String? = nil, yaml: String = "", stepCount: Int = 0, timeoutMs: Double? = nil) {
        self.name = name
        self.description = description
        self.inputs = inputs
        self.valid = valid
        self.error = error
        self.yaml = yaml
        self.stepCount = stepCount
        self.timeoutMs = timeoutMs
    }

    private enum CodingKeys: String, CodingKey {
        case name, description, inputs, valid, error, yaml, stepCount, timeoutMs
    }

    private struct LossyInput: Decodable {
        let input: PluginRegistryInput?
        init(from decoder: Decoder) throws { input = try? PluginRegistryInput(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        description = ((try? c.decodeIfPresent(String.self, forKey: .description)) ?? nil) ?? ""
        inputs = (((try? c.decodeIfPresent([LossyInput].self, forKey: .inputs)) ?? nil) ?? []).compactMap(\.input)
        valid = ((try? c.decodeIfPresent(Bool.self, forKey: .valid)) ?? nil) ?? false
        error = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? nil
        yaml = ((try? c.decodeIfPresent(String.self, forKey: .yaml)) ?? nil) ?? ""
        stepCount = ((try? c.decodeIfPresent(Int.self, forKey: .stepCount)) ?? nil) ?? 0
        timeoutMs = (try? c.decodeIfPresent(Double.self, forKey: .timeoutMs)) ?? nil
    }
}

// MARK: - Forge (forge:*)

/// `forge:status` — presence + identity only, never a token. (Single owner
/// WS10, D16; WS05 consumes it.)
struct ForgeConnectionStatus: Decodable, Equatable, Sendable {
    var connected: Bool
    /// Only when connected.
    var login: String?
    /// "github"
    var kind: String?
    /// "cli" | "env" | "stored" | nil
    var source: String?
    /// nil = not probed.
    var valid: Bool?

    init(connected: Bool, login: String? = nil, kind: String? = nil, source: String? = nil, valid: Bool? = nil) {
        self.connected = connected
        self.login = login
        self.kind = kind
        self.source = source
        self.valid = valid
    }
}

/// `forge:rules-list` — one row per repo with a box-side rules file, invalid
/// ones included (a rules file that silently fails to load is worse than one
/// that loudly refuses).
struct ForgeRuleRow: Decodable, Equatable, Sendable, Identifiable {
    var repoKey: String
    var valid: Bool
    var error: String?
    var ruleCount: Int?

    var id: String { repoKey }

    init(repoKey: String, valid: Bool, error: String? = nil, ruleCount: Int? = nil) {
        self.repoKey = repoKey
        self.valid = valid
        self.error = error
        self.ruleCount = ruleCount
    }
}

// MARK: - AI CLI launchers (launchers:list) — D21: WS10 owns discovery

struct AvailableLauncherFlag: Decodable, Equatable, Hashable, Sendable {
    /// Stable config key, e.g. "skipPermissions".
    var key: String
    /// User-facing label.
    var label: String
    /// Always "boolean" today; rows render only `type == "boolean"`.
    var type: String
    /// JSON key "default".
    var `default`: Bool

    private enum CodingKeys: String, CodingKey { case key, label, type, `default` }

    init(key: String, label: String, type: String = "boolean", default defaultValue: Bool = false) {
        self.key = key
        self.label = label
        self.type = type
        self.default = defaultValue
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        label = try c.decode(String.self, forKey: .label)
        type = ((try? c.decodeIfPresent(String.self, forKey: .type)) ?? nil) ?? "boolean"
        `default` = ((try? c.decodeIfPresent(Bool.self, forKey: .default)) ?? nil) ?? false
    }
}

struct AvailableLauncher: Decodable, Equatable, Hashable, Sendable, Identifiable {
    /// Launcher id, e.g. "claude".
    var id: String
    /// e.g. "Claude Code".
    var label: String
    /// `[]` when the CLI has no flags.
    var flags: [AvailableLauncherFlag]

    private enum CodingKeys: String, CodingKey { case id, label, flags }

    init(id: String, label: String, flags: [AvailableLauncherFlag] = []) {
        self.id = id
        self.label = label
        self.flags = flags
    }

    private struct LossyFlag: Decodable {
        let flag: AvailableLauncherFlag?
        init(from decoder: Decoder) throws { flag = try? AvailableLauncherFlag(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decode(String.self, forKey: .label)
        flags = (((try? c.decodeIfPresent([LossyFlag].self, forKey: .flags)) ?? nil) ?? []).compactMap(\.flag)
    }
}

// MARK: - Error wording

/// One place that turns a thrown error into the sentence a Settings screen shows
/// after its "Couldn't …" lead. `MantaError` carries the box's own words; any
/// other error (a dropped connection, a timeout) uses the system's description.
enum SettingsError {
    static let revoked = "Sign in again — this phone's pairing was revoked."

    static func message(_ error: Error) -> String {
        if let manta = error as? MantaError {
            switch manta {
            case .authRequired: return revoked
            case .server(let message), .transport(let message): return message
            case .storedButUntranscribed: return "The box stored it but couldn't finish."
            }
        }
        return error.localizedDescription
    }
}
