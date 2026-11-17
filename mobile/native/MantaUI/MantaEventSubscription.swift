import Foundation

// ===========================================================================
// iOS stability — what the /events socket subscribes to, and the pure
// decisions about when it is open (spec 2026-11-17, contract C1, items B5–B7).
//
// Everything here is value-in / value-out so it can be unit-tested without a
// socket, a timer or a view hierarchy.
// ===========================================================================

// MARK: - C1 kinds

enum MantaEventKinds {
    /// Kinds the event store consumes itself (through its Subjects and the
    /// stream router) rather than through a raw-frame registration. Raw-frame
    /// registrations declare their own kinds; the subscription is the UNION.
    static let storeOwned: Set<String> = [
        "heartbeat", "runningSet", "stream",
        "delegate.updated", "delegate.approval.requested", "progress.updated",
        "accounts.updated", "accounts.moved", "handoff",
    ]

    /// The box ignores a `kinds` list longer than this (and then delivers everything).
    static let maxEntries = 64

    static func union(registrations: [Set<String>]) -> Set<String> {
        registrations.reduce(into: storeOwned) { $0.formUnion($1) }
    }

    /// The `kinds=` query value: sorted so the URL is deterministic.
    static func queryValue(_ kinds: Set<String>) -> String {
        kinds.sorted().joined(separator: ",")
    }

    /// `{"type":"kinds","kinds":[…]}` — replaces the connection's kinds at runtime.
    static func kindsMessage(_ kinds: Set<String>) -> String {
        json(["type": "kinds", "kinds": kinds.sorted()])
    }

    /// `{"type":"focus","sessions":[…]}` — the connection's focus set.
    static func focusMessage(_ sessions: [String]) -> String {
        json(["type": "focus", "sessions": sessions])
    }

    private static func json(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }
}

// MARK: - C1 focus set

/// The sessions whose heavy stream frames (`flush`, `toolOutput`, `messageChanged`)
/// this device wants. Several owners (each open chat screen, each open subagent
/// screen) contribute; the union is what is sent to the box.
struct MantaFocusSet: Equatable, Sendable {
    /// The box drops ids beyond this.
    static let maxSessions = 32

    private var owners: [String: [String]] = [:]

    /// The deterministic union (owners in key order, ids in the order given), capped.
    var sessions: [String] {
        var seen = Set<String>()
        var out: [String] = []
        for owner in owners.keys.sorted() {
            for id in owners[owner] ?? [] where !id.isEmpty && seen.insert(id).inserted {
                out.append(id)
            }
        }
        return Array(out.prefix(Self.maxSessions))
    }

    /// Returns whether the union changed.
    @discardableResult
    mutating func set(owner: String, sessions: [String]) -> Bool {
        let before = self.sessions
        if sessions.isEmpty {
            owners.removeValue(forKey: owner)
        } else {
            owners[owner] = sessions
        }
        return before != self.sessions
    }

    @discardableResult
    mutating func remove(owner: String) -> Bool {
        set(owner: owner, sessions: [])
    }
}

// MARK: - B7 socket lifecycle

enum MantaForegroundDecision: Equatable {
    /// The socket is demonstrably healthy: only mark the next open as a reconnect.
    case keep
    /// Reopen now (a fresh snapshot replay) instead of trusting the old socket.
    case forceReconnect
}

enum MantaForegroundPolicy {
    /// The socket is closed this long after the app enters the background, unless it returns first.
    static let backgroundCloseGraceSeconds: TimeInterval = 5

    /// What to do when the app becomes active again. After ≥ the grace period away
    /// the socket is always reopened; after a shorter trip it is kept only while
    /// connected and not stale.
    static func onForeground(
        awayFor: TimeInterval?,
        connected: Bool,
        stale: Bool
    ) -> MantaForegroundDecision {
        if let awayFor, awayFor >= backgroundCloseGraceSeconds { return .forceReconnect }
        return connected && !stale ? .keep : .forceReconnect
    }
}

/// Why a stream was closed on purpose (the watchdog never recovers these).
enum MantaCloseReason {
    static let noServer = "no server configured"
    static let storeStopped = "store stopped"
    static let background = "app in background"
}

extension MantaLivenessPolicy {
    /// A stream that is neither carrying events nor retrying must not stay that way. `since` is when the
    /// current state began. A `reconnecting` state has its own backoff timer and is left alone; a state the
    /// app chose (stopped, no server, backgrounded) is never recovered.
    static func shouldRecoverFromDeadState(state: MantaConnectionState, since: Date, now: Date, staleMs: Double) -> Bool {
        let inState = now.timeIntervalSince(since) * 1000.0
        guard inState > staleMs else { return false }
        switch state {
        case .connecting, .stalled:
            return true
        case .closed(let reason):
            return reason != MantaCloseReason.noServer
                && reason != MantaCloseReason.storeStopped
                && reason != MantaCloseReason.background
        case .idle, .connected, .reconnecting:
            return false
        }
    }
}

// MARK: - B5 polling

enum MantaPollPolicy {
    static let branchSeconds: TimeInterval = 15
    static let forgeSeconds: TimeInterval = 30
    static let approvalsSeconds: TimeInterval = 3
    static let ageLabelSeconds: TimeInterval = 10
    static let artifactsSeconds: TimeInterval = 5
    static let usageAccountsSeconds: TimeInterval = 60

    /// A timer or poll runs only while the app is active AND its screen is in front.
    static func shouldRun(sceneActive: Bool, visible: Bool = true) -> Bool {
        sceneActive && visible
    }
}

// MARK: - Stream change notifications

/// One session's interpreted state changed. `sub` is the routing sub of the frame that did it
/// (`nil` for a local republish: retirement, run-view ingest).
struct MantaSessionChange: Equatable, Sendable {
    var sessionId: String
    var sub: String?

    /// The authoritative running set was just applied: sent once, AFTER the per-session changes, for the
    /// consumers whose answer depends on the set as a whole (a child session no frame ever named is, by the set's
    /// own definition, not running).
    static let runningSetApplied = MantaSessionChange(sessionId: "", sub: "runningSet")

    var isGlobal: Bool { sessionId.isEmpty }

    /// The subs that can change a session's running flag (a local republish never does).
    var touchesRunning: Bool {
        sub == "running" || sub == "turnComplete" || sub == "runningSet"
    }
}

/// The part of a session's state a session-list row shows. The event store publishes a row-status change
/// only when this changes, so a streamed chunk never redraws the list.
struct MantaRowSignature: Equatable, Sendable {
    var running: Bool?
    var runningSince: Date?
    var windowStatus: StreamWindowStatusPayload?
    var hasQuestions: Bool
    var hasPermissions: Bool

    init(_ state: MantaSessionStreamState) {
        running = state.running
        runningSince = state.runningSince
        windowStatus = state.windowStatus
        hasQuestions = !(state.questions?.questions.isEmpty ?? true)
        hasPermissions = !(state.permissions?.permissions.isEmpty ?? true)
    }
}
