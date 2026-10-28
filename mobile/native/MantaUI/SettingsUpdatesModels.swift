import Foundation

// ===========================================================================
// WS10 F18 — software updates. Pure decisions behind the Updates screen,
// Foundation-only ([pkg], D19):
//
//   - `UpdateTargets`   the display list + row wording (port of
//                       src/shared/updateTargets.mjs `buildUpdateTargets` and
//                       src/renderer/chatUtils.ts `describeUpdateTarget` /
//                       `boxUpgradeLanded`, minus the desktop row);
//   - `UpdateApplyClassifier`  what the `server:update-apply` answer means. The
//                       box restarts ITSELF as the last step of a successful
//                       update, so a dropped connection or a proxy 5xx is the
//                       SUCCESS path, while a structured `{ok:false}` or an
//                       ordinary 500 is a real failure (port of
//                       `isTransientUpdateNetworkError` + the RPC envelope);
//   - `UpdateFlow`      the confirm → applying → restarting → done state machine.
// ===========================================================================

// MARK: - Raw transport answer

/// A transport-level failure, reduced to what the classifier needs. `code` is the
/// `URLError` code's raw value (the NSURLError numbers) — kept numeric so this
/// file stays Foundation-only and testable on Linux.
struct TransportFailure: Equatable, Sendable {
    var code: Int
    var message: String

    init(code: Int, message: String) {
        self.code = code
        self.message = message
    }

    // NSURLError raw values.
    static let cancelled = -999
    static let timedOut = -1001
    static let cannotFindHost = -1003
    static let cannotConnectToHost = -1004
    static let networkConnectionLost = -1005
    static let dnsLookupFailed = -1006
    static let notConnectedToInternet = -1009

    /// The connection-level failures a box restarting itself mid-request causes.
    static let restartCodes: Set<Int> = [
        networkConnectionLost, cannotConnectToHost, timedOut,
        notConnectedToInternet, cannotFindHost, dnsLookupFailed, cancelled,
    ]
}

/// What `BoxRESTClient.rpcRaw` returns: the HTTP status and body UNINTERPRETED,
/// or the transport failure. `MantaAPIClient`'s own transport keeps only 401 and
/// the 503-upgrade signal and then JSON-parses the body, so an HTML 502 from the
/// proxy during a restart would arrive as a decode error — indistinguishable
/// from a genuine failure.
struct RawRPCResponse: Sendable {
    var status: Int?
    var body: Data
    var transportError: TransportFailure?

    init(status: Int?, body: Data = Data(), transportError: TransportFailure? = nil) {
        self.status = status
        self.body = body
        self.transportError = transportError
    }
}

// MARK: - Classifying the apply call

enum ApplyOutcome: Equatable, Sendable {
    /// The box accepted the update and is working.
    case started
    /// The connection dropped / a proxy answered 5xx — the box is (very likely)
    /// restarting itself. Wait for it to come back on a different version.
    case restartLikely
    /// A real failure the box (or this phone) reported.
    case failed(String)
    /// 401 — this phone's pairing was revoked.
    case authRequired
    /// 503 with `{"upgrade": true}` — the box is mid-upgrade.
    case upgrading
}

enum UpdateApplyClassifier {

    /// HTTP statuses a reverse proxy answers while the origin restarts. A bare
    /// 500 is NOT here — the box is up, so that is a genuine failure.
    static let proxyRestartStatuses: Set<Int> = [502, 503, 504, 521, 522, 524]

    static func classify(_ r: RawRPCResponse) -> ApplyOutcome {
        if let failure = r.transportError {
            return TransportFailure.restartCodes.contains(failure.code)
                ? .restartLikely
                : .failed(failure.message)
        }
        guard let status = r.status else { return .failed("No answer from the box.") }

        if status == 401 { return .authRequired }
        if status == 503, UpgradeStatus.isUpgradeRefusal(statusCode: status, body: r.body) { return .upgrading }
        if proxyRestartStatuses.contains(status) { return .restartLikely }

        let object = (try? JSONSerialization.jsonObject(with: r.body)) as? [String: Any]

        if status == 200 {
            guard let result = object?["result"] as? [String: Any], let ok = result["ok"] as? Bool else {
                return .failed("The box sent an answer this app couldn't read.")
            }
            if ok { return .started }
            let message = result["error"] as? String
            return .failed((message?.isEmpty == false ? message : nil) ?? "Server update failed")
        }

        if let message = object?["error"] as? String, !message.isEmpty { return .failed(message) }
        return .failed("HTTP \(status)")
    }
}

// MARK: - Targets + rows

enum UpdateTone: Equatable, Sendable {
    case ok, action, muted, error
}

enum UpdateTargets {

    /// The rows, in a FIXED order (never discovery order): the box server, then
    /// opencode, then the other AI CLIs alphabetically by label. The desktop row
    /// is never present on the phone. A missing check (it timed out or threw) is
    /// a server row with `ok == false` — never "up to date".
    static func build(check: ServerUpdateCheck?, serverVersion: String?) -> [UpdateTarget] {
        let server = UpdateTarget(
            id: "server",
            label: "Manta Server",
            current: serverVersion,
            latest: check?.version,
            available: check?.available == true,
            ok: check != nil && check?.ok != false,
            manual: false,
            disruption: "reconnect"
        )
        let clis = (check?.targets ?? []).filter { $0.id != "desktop" && $0.id != "server" }
        let opencode = clis.first { $0.id == "opencode" }
        let rest = clis
            .filter { $0.id != "opencode" }
            .sorted { $0.label < $1.label }
        return [server] + (opencode.map { [$0] } ?? []) + rest
    }

    /// The row's status wording. Order IS the semantics: an unanswerable check
    /// wins over everything and is NEVER rendered as ok.
    static func describe(_ t: UpdateTarget) -> (tone: UpdateTone, text: String) {
        if !t.ok { return (.error, "Couldn't check") }
        if t.manual { return (.muted, "Update manually") }
        if t.available { return (.action, "Update available") }
        return (.ok, "Up to date")
    }

    /// True when an Update button should be offered for this row.
    static func hasUpdate(_ t: UpdateTarget) -> Bool {
        t.ok && t.available && !t.manual
    }

    /// Has the box restarted onto a different build than the one it was running
    /// when the update started? The ONLY signal that ends the restarting state:
    /// an edge (the version CHANGED), never a level. A missing value on either
    /// side can never satisfy it — "we don't know" must not read as "it worked".
    static func landed(from: String?, current: String?) -> Bool {
        guard let from, !from.isEmpty, let current, !current.isEmpty else { return false }
        return from != current
    }

    /// "current → latest" for a row, omitting what is unknown.
    static func versionText(_ t: UpdateTarget) -> String? {
        if let c = t.current, let l = t.latest, c != l { return "\(c) → \(l)" }
        return t.current ?? t.latest
    }
}

// MARK: - Apply flow

/// The box-server update, from the confirm to its end. One update in flight:
/// events that do not apply to the current phase are ignored, so a late answer
/// can never resurrect a finished flow.
struct UpdateFlow: Equatable, Sendable {
    /// The safety cap (desktop `BOX_UPGRADE_MAX_MS`).
    static let maxDuration: TimeInterval = 600

    enum Phase: Equatable, Sendable {
        case idle
        case confirming
        /// The apply call is in flight (or answered `.started`).
        case applying
        /// The box dropped / a proxy answered 5xx: waiting for it to return.
        case restarting
        case done(version: String)
        case failed(String)
        case timedOut
    }

    enum Event: Equatable, Sendable {
        case requestConfirm
        case cancelConfirm
        case confirm(fromVersion: String?, now: Date)
        case applyOutcome(ApplyOutcome)
        case connection(Bool)
        case version(String)
        case tick(Date)
        /// Acknowledge a terminal phase (done / failed / timed out).
        case dismiss
    }

    var phase: Phase = .idle
    var fromVersion: String?
    var startedAt: Date?
    var connected = true

    /// Something is in flight — every other Update button is disabled.
    var isBusy: Bool {
        switch phase {
        case .confirming, .applying, .restarting: return true
        case .idle, .done, .failed, .timedOut: return false
        }
    }

    /// The box is (or is about to be) unreachable on purpose.
    var isWaitingForBox: Bool {
        switch phase {
        case .applying, .restarting: return !connected
        default: return false
        }
    }

    static let revokedMessage = "Sign in again — this phone's pairing was revoked."
    static let upgradingMessage = "The box is upgrading right now."
    static let timedOutMessage = "Couldn't confirm the update finished. Check again."

    mutating func reduce(_ event: Event) {
        switch (phase, event) {
        case (.idle, .requestConfirm):
            phase = .confirming

        case (.confirming, .cancelConfirm):
            phase = .idle

        case (.confirming, .confirm(let from, let now)):
            fromVersion = from
            startedAt = now
            phase = .applying

        case (.applying, .applyOutcome(let outcome)):
            switch outcome {
            case .started, .restartLikely: phase = .restarting
            case .failed(let message): phase = .failed(message)
            case .authRequired: phase = .failed(Self.revokedMessage)
            case .upgrading: phase = .failed(Self.upgradingMessage)
            }

        case (.applying, .version(let v)), (.restarting, .version(let v)):
            if UpdateTargets.landed(from: fromVersion, current: v) { phase = .done(version: v) }

        case (.applying, .tick(let now)), (.restarting, .tick(let now)):
            if let startedAt, now.timeIntervalSince(startedAt) >= Self.maxDuration { phase = .timedOut }

        case (.done, .dismiss), (.failed, .dismiss), (.timedOut, .dismiss):
            self = UpdateFlow(connected: connected)

        default:
            break
        }

        if case .connection(let isConnected) = event { connected = isConnected }
    }

    private init(connected: Bool) { self.connected = connected }
    init() {}
}
