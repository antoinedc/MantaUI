import Foundation

// ===========================================================================
// The pure parts of OS-kill diagnostics forwarding (contract C3 of
// docs/superpowers/specs/2026-11-17-ios-stability-and-status-freshness.md).
//
// Foundation-only and free of MetricKit / Firebase so the unit suite can cover
// them: the wire body for `POST /api/diagnostics/ios`, the upload request, the
// reply classification and the bounded on-disk outbox. `DiagnosticsReporter`
// does the MetricKit + Crashlytics + scheduling around them.
// ===========================================================================

/// The C3 `kind` values.
enum DiagnosticKind: String, Sendable, CaseIterable {
    case crash
    case hang
    case cpuException
    case diskWriteException
    case memoryException
    case appLaunch
    case other

    /// The `NSError` code of this kind's Crashlytics non-fatal (domain "MetricKit").
    /// Stable: Crashlytics groups non-fatals by domain + code, and a console
    /// filter / alert may be built on them — never renumber.
    var crashlyticsCode: Int {
        switch self {
        case .crash: return 1
        case .hang: return 2
        case .cpuException: return 3
        case .diskWriteException: return 4
        case .memoryException: return 5
        case .appLaunch: return 6
        case .other: return 99
        }
    }
}

/// The C3 `source` values.
enum DiagnosticSource: String, Sendable {
    case mxdiagnostic
    case metricManager
}

/// The app / OS / device the diagnostic body claims. Used for whatever the
/// diagnostic itself does not say (it describes the process that died, which may
/// be an older build).
struct DiagnosticContext: Sendable, Equatable {
    var appVersion: String
    var build: String
    var osVersion: String
    var device: String

    static func current() -> DiagnosticContext {
        let info = Bundle.main.infoDictionary
        let os = ProcessInfo.processInfo.operatingSystemVersion
        var uts = utsname()
        uname(&uts)
        let machine = withUnsafeBytes(of: &uts.machine) { raw in
            String(bytes: raw.prefix(while: { $0 != 0 }), encoding: .utf8) ?? "unknown"
        }
        return DiagnosticContext(
            appVersion: info?["CFBundleShortVersionString"] as? String ?? "unknown",
            build: info?["CFBundleVersion"] as? String ?? "unknown",
            osVersion: "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
            device: machine.isEmpty ? "unknown" : machine
        )
    }
}

/// One diagnostic, reduced to plain `Sendable` values so it can cross from
/// MetricKit's background queue to the main actor.
struct DiagnosticItem: Sendable, Equatable {
    let kind: DiagnosticKind
    let source: DiagnosticSource
    /// The diagnostic's own JSON (`MXDiagnostic.jsonRepresentation()`, or the
    /// encoded iOS 27 `DiagnosticReport`).
    let payload: Data
    /// Short facts for the Crashlytics non-fatal (termination reason, exception
    /// type/code, signal, durations), read out of the payload when present.
    let summary: [String: String]

    init(kind: DiagnosticKind, source: DiagnosticSource, payload: Data) {
        self.kind = kind
        self.source = source
        self.payload = payload
        self.summary = DiagnosticsBody.summary(fromPayload: payload)
    }

    /// The C3 request body, or nil if it cannot be serialised.
    func body(fallback: DiagnosticContext) -> Data? {
        DiagnosticsBody.make(kind: kind, source: source, payload: payload, fallback: fallback)
    }
}

enum DiagnosticsBody {
    /// The box answers 413 above this (C3).
    static let maxBytes = 2 * 1024 * 1024

    /// `diagnosticMetaData` keys worth copying into a Crashlytics non-fatal.
    static let summaryKeys = [
        "terminationReason", "exceptionType", "exceptionCode", "signal",
        "hangDuration", "totalCPUTime", "totalSampledTime", "writesCaused", "launchDuration",
    ]

    /// `{kind, appVersion, build, osVersion, device, source, payload}`. The payload
    /// is embedded as JSON; when it is not JSON, or the whole body would exceed
    /// `maxBytes`, a small marker object stands in so the kind and counts still
    /// reach the box instead of a guaranteed 413.
    static func make(kind: DiagnosticKind, source: DiagnosticSource, payload: Data,
                     fallback: DiagnosticContext) -> Data? {
        let parsed = parse(payload)
        let context = context(from: parsed, fallback: fallback)

        func encode(_ embedded: Any) -> Data? {
            let body: [String: Any] = [
                "kind": kind.rawValue,
                "appVersion": context.appVersion,
                "build": context.build,
                "osVersion": context.osVersion,
                "device": context.device,
                "source": source.rawValue,
                "payload": embedded,
            ]
            guard JSONSerialization.isValidJSONObject(body) else { return nil }
            return try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes])
        }

        let embedded: Any = parsed ?? ["unparsed": true, "bytes": payload.count] as [String: Any]
        guard let full = encode(embedded) else {
            return encode(["unparsed": true, "bytes": payload.count] as [String: Any])
        }
        if full.count <= maxBytes { return full }
        return encode(["truncated": true, "originalBytes": payload.count] as [String: Any])
    }

    /// Prefer what the diagnostic says about the process that died; fall back to
    /// the running app for anything missing.
    static func context(from parsed: Any?, fallback: DiagnosticContext) -> DiagnosticContext {
        guard let root = parsed as? [String: Any],
              let meta = root["diagnosticMetaData"] as? [String: Any] else { return fallback }
        func text(_ key: String) -> String? {
            guard let value = meta[key] as? String, !value.isEmpty else { return nil }
            return value
        }
        return DiagnosticContext(
            appVersion: text("appVersion") ?? fallback.appVersion,
            build: text("appBuildVersion") ?? fallback.build,
            osVersion: text("osVersion") ?? fallback.osVersion,
            device: text("deviceType") ?? fallback.device
        )
    }

    static func summary(fromPayload payload: Data) -> [String: String] {
        guard let root = parse(payload) as? [String: Any],
              let meta = root["diagnosticMetaData"] as? [String: Any] else { return [:] }
        var out: [String: String] = [:]
        for key in summaryKeys {
            guard let value = meta[key], !(value is NSNull) else { continue }
            let text = "\(value)"
            if !text.isEmpty { out[key] = String(text.prefix(200)) }
        }
        return out
    }

    private static func parse(_ payload: Data) -> Any? {
        try? JSONSerialization.jsonObject(with: payload, options: [.fragmentsAllowed])
    }
}

// MARK: - Upload

/// What one upload attempt means for its outbox file.
enum DiagnosticUploadResult: Sendable, Equatable {
    /// 2xx: delete the file.
    case sent
    /// The box will never accept this body (400 / 413): delete it, or it would block the queue forever.
    case rejected
    /// Anything else (offline, 401, 5xx, an upgrading box's 503): keep it and stop; try again at the next launch / foreground.
    case failed
}

enum DiagnosticsUpload {
    static func request(serverURL: URL, token: String, body: Data) -> URLRequest {
        var request = URLRequest(url: serverURL
            .appendingPathComponent("api").appendingPathComponent("diagnostics").appendingPathComponent("ios"))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = body
        return request
    }

    static func result(forStatus status: Int?) -> DiagnosticUploadResult {
        guard let status else { return .failed }
        switch status {
        case 200..<300: return .sent
        case 400, 413: return .rejected
        default: return .failed
        }
    }
}

// MARK: - Outbox

/// The not-yet-uploaded bodies, one JSON file each under
/// `Application Support/diagnostics-outbox/`, bounded to `limit` files (the oldest
/// are dropped). File names start with the creation time in milliseconds, zero
/// padded, so name order is age order.
struct DiagnosticsOutbox: Sendable {
    static let defaultLimit = 20

    let directory: URL
    let limit: Int

    init(directory: URL, limit: Int = DiagnosticsOutbox.defaultLimit) {
        self.directory = directory
        self.limit = max(1, limit)
    }

    /// The app's own outbox, or nil if Application Support cannot be resolved.
    static func standard() -> DiagnosticsOutbox? {
        guard let base = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        ) else { return nil }
        return DiagnosticsOutbox(directory: base.appendingPathComponent("diagnostics-outbox", isDirectory: true))
    }

    /// Write `body` as a new file and drop the oldest files beyond `limit`.
    @discardableResult
    func enqueue(_ body: Data, now: Date = Date()) throws -> URL {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let millis = Int(now.timeIntervalSince1970 * 1000)
        let name = String(format: "%015ld", millis) + "-" + UUID().uuidString + ".json"
        let url = directory.appendingPathComponent(name)
        // Readable after the first unlock: the retry may run while the phone is locked.
        try body.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        enforceLimit()
        return url
    }

    /// Oldest first.
    func pending() -> [URL] {
        let files = (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])) ?? []
        return files
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    func remove(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }

    func enforceLimit() {
        let files = pending()
        guard files.count > limit else { return }
        for url in files.prefix(files.count - limit) { remove(url) }
    }
}
