import Foundation

// ===========================================================================
// WS09 F7 — the client half of the box's usage-alert protocol (SF-M16). The BOX
// owns the alerts (levels, baseline, text, expiry); frames are DELTAS and a
// `usage:alerts` snapshot is the authority. `UsageAlertQueue` keeps the two
// consistent, step for step the same rules and cases as the desktop's
// `src/renderer/usageAlertsQueue.ts`:
//   - a snapshot is never discarded in favour of a frame; frames that arrive while
//     a snapshot is pending are buffered and replayed on top of it;
//   - a late answer (older epoch) is ignored;
//   - a revision gap, a box restart or a buffer overflow re-hydrates.
// Foundation-only (verify.sh, D19).
// ===========================================================================

enum UsageAlertText {
    /// The box's text plus the client-formatted reset clause (M19, KEEP-CLIENT):
    /// "Weekly limit reached on Claude — resets in 6d 3h (Thu 09:00).", "… — resetting…"
    /// once the instant passed, and just "<text>." when the provider gave no reset time.
    static func line(alert: UsageAlertWire, now: Date) -> String {
        guard let resetsAt = alert.resetsAt else { return alert.text + "." }
        let date = Date(timeIntervalSince1970: resetsAt / 1000)
        if date <= now { return alert.text + " — resetting…" }
        return alert.text + " — resets " + UsageMeters.formatReset(date, now: now) + "."
    }
}

/// Retry schedule for a failed `usage:alerts` request: 1 s, 2 s, 5 s, then every 30 s.
enum UsageAlertsRetry {
    static func delaySeconds(attempt: Int) -> Double {
        let schedule: [Double] = [1, 2, 5]
        return attempt >= 0 && attempt < schedule.count ? schedule[attempt] : 30
    }
}

struct UsageAlertQueue: Equatable, Sendable {
    enum Phase: Equatable, Sendable { case hydrating, live }

    /// `.hydrate` = the caller must call `startHydration()` and request a snapshot.
    enum Action: Equatable, Sendable { case none, hydrate }

    static let bufferCap = 200

    private(set) var phase: Phase = .hydrating
    private(set) var epoch = 0
    private(set) var lastBootId: String?
    private(set) var lastRevision = 0
    private(set) var buffer: [UsageAlertFrame] = []
    private var carry: UsageAlertFrame?
    private(set) var queue: [UsageAlertWire] = []
    private(set) var seenIDs: Set<String> = []

    /// The alerts to show, oldest first.
    var visible: [UsageAlertWire] { queue }

    /// Begin (re)hydration: new epoch, buffer cleared (a frame that forced this
    /// re-hydration is kept for the next snapshot). Tag the request with the result.
    mutating func startHydration() -> Int {
        epoch += 1
        phase = .hydrating
        buffer = carry.map { [$0] } ?? []
        carry = nil
        return epoch
    }

    mutating func applySnapshot(_ list: UsageAlertsList, epoch forEpoch: Int) -> Action {
        guard forEpoch == epoch else { return .none }
        if buffer.contains(where: { $0.bootId != list.bootId }) { return .hydrate }
        let active = Set(list.alerts.map(\.id))
        queue.removeAll { !active.contains($0.id) }
        for alert in list.alerts { enqueue(alert) }
        lastBootId = list.bootId
        lastRevision = list.revision
        let pending = buffer.sorted { $0.revision < $1.revision }
        buffer = []
        phase = .live
        for frame in pending {
            if frame.revision <= lastRevision { continue }
            if applyLive(frame) == .hydrate { return .hydrate }
        }
        return .none
    }

    mutating func applyFrame(_ frame: UsageAlertFrame) -> Action {
        if phase == .hydrating {
            buffer.append(frame)
            return buffer.count > Self.bufferCap ? .hydrate : .none
        }
        return applyLive(frame)
    }

    /// Close an alert: it leaves the queue but its id stays seen (it never re-shows).
    mutating func dismiss(_ id: String) {
        queue.removeAll { $0.id == id }
    }

    /// Forget everything (box change): queue, seen ids, buffers, boot/revision.
    /// The epoch keeps counting so an answer to a pre-reset request can never match.
    mutating func reset() {
        let keep = epoch
        self = UsageAlertQueue()
        epoch = keep
    }

    private mutating func enqueue(_ alert: UsageAlertWire) {
        if seenIDs.contains(alert.id) { return }
        seenIDs.insert(alert.id)
        queue.append(alert)
    }

    private mutating func applyLive(_ frame: UsageAlertFrame) -> Action {
        if frame.bootId != lastBootId {
            carry = frame
            return .hydrate
        }
        if frame.revision <= lastRevision { return .none }
        if frame.revision > lastRevision + 1 {
            carry = frame
            return .hydrate
        }
        if let alert = frame.alert { enqueue(alert) }
        if let retired = frame.retired {
            let gone = Set(retired)
            queue.removeAll { gone.contains($0.id) }
        }
        lastRevision = frame.revision
        return .none
    }
}
