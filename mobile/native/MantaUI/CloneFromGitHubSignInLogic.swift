import Foundation

// ===========================================================================
// WS04 §6 / D14 — the GitHub device sign-in state machine, as PURE logic.
// Foundation-only (D19); the clock is an argument everywhere so the tests
// drive time themselves.
//
// The invariants are the desktop's (`ConnectGithub.tsx:16-27, 152-233`):
//   - no immediate first poll;
//   - the interval is `max(pollInterval, 5)`, re-read from EVERY `pending`
//     reply (that is how the server says "slow down");
//   - `pending` resets the error budget; three consecutive errors (server
//     `error` replies or transport failures) stop the flow;
//   - the local deadline passing is `expired` with no network call.
// `GitHubDeviceSignInStore` (CloneFromGitHubSignIn.swift) owns the single poll
// task and runs this machine.
// ===========================================================================

struct GitHubDeviceFlow: Equatable, Sendable {
    enum Stage: Equatable, Sendable {
        case starting
        case code
        case notConfigured
        case expired
        case error(String)
        case connected
    }

    static let maxConsecutiveErrors = 3
    static let minInterval = 5
    static let unreachableMessage = "Couldn't reach the server. Try again."
    static let defaultFailureMessage = "GitHub sign-in failed."

    var stage: Stage = .starting
    var grant: GitHubDeviceGrant?
    /// Seconds between polls.
    var interval: Int = GitHubDeviceFlow.minInterval
    var consecutiveErrors = 0
    /// When the code stops working.
    var deadline: Date?
    /// The last time the server was asked (the grant's creation counts: the
    /// first poll is a full interval after it).
    var lastPoll: Date?

    init() {}

    /// The `forge:device-start` reply.
    mutating func started(_ reply: GitHubDeviceStart, now: Date) {
        if reply.connected {
            stage = .connected
        } else if reply.notConfigured {
            stage = .notConfigured
        } else if let grant = reply.grant {
            self.grant = grant
            interval = max(grant.pollInterval, Self.minInterval)
            deadline = now.addingTimeInterval(TimeInterval(grant.expiresIn))
            lastPoll = now
            consecutiveErrors = 0
            stage = .code
        } else {
            let detail = (reply.error ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            stage = .error(detail.isEmpty ? Self.unreachableMessage : detail)
        }
    }

    /// `forge:device-start` threw.
    mutating func startFailed() {
        stage = .error(Self.unreachableMessage)
    }

    /// A `forge:device-poll` reply. Ignored unless a code is on screen.
    mutating func polled(_ reply: GitHubDevicePoll, now: Date) {
        guard stage == .code else { return }
        lastPoll = now
        switch reply.kind {
        case .pending:
            consecutiveErrors = 0
            interval = max(reply.pollInterval ?? interval, Self.minInterval)
        case .done:
            stage = .connected
        case .expired:
            stage = .expired
        case .error:
            countError(message: reply.error)
        case .unknown:
            countError(message: nil)
        }
    }

    /// A poll that could not reach the server.
    mutating func pollThrew(now: Date) {
        guard stage == .code else { return }
        lastPoll = now
        consecutiveErrors += 1
        if consecutiveErrors >= Self.maxConsecutiveErrors {
            stage = .error(Self.unreachableMessage)
        }
    }

    /// The deadline passed while a code was on screen: expired, no poll.
    mutating func tick(now: Date) {
        guard stage == .code, let deadline, now >= deadline else { return }
        stage = .expired
    }

    /// Seconds until the code expires; nil without a deadline.
    func remaining(now: Date) -> TimeInterval? {
        deadline.map { $0.timeIntervalSince(now) }
    }

    /// Whether a foreground wake may poll right away: only when a full interval
    /// has passed since the last request — never faster than the interval.
    static func shouldPollNow(lastPoll: Date?, now: Date, interval: Int) -> Bool {
        guard let lastPoll else { return true }
        return now.timeIntervalSince(lastPoll) >= TimeInterval(interval)
    }

    /// `m:ss`, floored at `0:00`. Rounds UP so a code with half a second left
    /// never reads `0:00` while it still works.
    static func countdownLabel(remaining: TimeInterval) -> String {
        let total = max(0, Int(remaining.rounded(.up)))
        return "\(total / 60):" + String(format: "%02d", total % 60)
    }

    /// The verification link without its scheme, for display.
    static func displayURL(_ uri: String) -> String {
        for prefix in ["https://", "http://"] where uri.lowercased().hasPrefix(prefix) {
            return String(uri.dropFirst(prefix.count))
        }
        return uri
    }

    private mutating func countError(message: String?) {
        consecutiveErrors += 1
        guard consecutiveErrors >= Self.maxConsecutiveErrors else { return }
        let detail = (message ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        stage = .error(detail.isEmpty ? Self.defaultFailureMessage : detail)
    }
}
