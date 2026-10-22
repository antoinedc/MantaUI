import Foundation

// ===========================================================================
// Box upgrade (OpenCode V2 cutover, slice C4 — contract K3).
//
// While the box migrates onto OpenCode V2 it serves `GET /api/upgrade` and
// publishes the same object as `{kind:"upgrade", payload}` on /events. This
// file is the Foundation-only half: the tolerant decoding of that object and
// the pure presentation rules (what to say, how far along, the disk numbers).
// It deliberately imports nothing else so it compiles in the Linux SwiftPM
// package (`Package.swift`) and is unit-tested by `UpgradeModelsTests`.
//
// The iPhone shows this READ-ONLY. Retry and Roll back are desktop actions —
// there is no button here and no API call that mutates anything.
//
// Mirrors src/renderer/upgradeGateLogic.ts (the desktop's pure half). Keep the two
// in step: same tolerance, same wording for the shared facts.
// ===========================================================================

enum UpgradeState: Equatable, Sendable {
    case idle, running, failed, completed, rolledBack

    /// nil for a state this build does not know — the frame is then ignored
    /// rather than guessed at, so a newer box can never flip the screen wrongly.
    init?(wire: String) {
        switch wire {
        case "idle": self = .idle
        case "running": self = .running
        case "failed": self = .failed
        case "completed": self = .completed
        case "rolled_back": self = .rolledBack
        default: return nil
        }
    }
}

enum UpgradeStepStatus: String, Equatable, Sendable {
    case pending, running, done, failed
}

/// A step's measurable progress. Absent numbers mean "indeterminate", not zero.
struct UpgradeProgress: Decodable, Equatable, Sendable {
    var label: String?
    var numerator: Double?
    var denominator: Double?

    init(label: String? = nil, numerator: Double? = nil, denominator: Double? = nil) {
        self.label = label
        self.numerator = numerator
        self.denominator = denominator
    }

    private enum CodingKeys: String, CodingKey { case label, numerator, denominator }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rawLabel = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? nil
        label = (rawLabel?.isEmpty == false) ? rawLabel : nil
        numerator = Self.finite((try? c.decodeIfPresent(Double.self, forKey: .numerator)) ?? nil)
        denominator = Self.finite((try? c.decodeIfPresent(Double.self, forKey: .denominator)) ?? nil)
    }

    fileprivate static func finite(_ v: Double?) -> Double? {
        guard let v, v.isFinite else { return nil }
        return v
    }
}

struct UpgradeStep: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var label: String
    var status: UpgradeStepStatus
    var progress: UpgradeProgress?
    var error: String?

    init(id: String, label: String? = nil, status: UpgradeStepStatus,
         progress: UpgradeProgress? = nil, error: String? = nil) {
        self.id = id
        self.label = label ?? UpgradePresentation.defaultLabel(for: id)
        self.status = status
        self.progress = progress
        self.error = error
    }

    private enum CodingKeys: String, CodingKey { case id, label, status, progress, error }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(String.self, forKey: .id) // a step with no id is dropped
        self.id = id
        let rawLabel = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? nil
        label = (rawLabel?.isEmpty == false ? rawLabel : nil) ?? UpgradePresentation.defaultLabel(for: id)
        let rawStatus = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? nil
        status = rawStatus.flatMap(UpgradeStepStatus.init(rawValue:)) ?? .pending
        progress = (try? c.decodeIfPresent(UpgradeProgress.self, forKey: .progress)) ?? nil
        let rawError = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? nil
        error = (rawError?.isEmpty == false) ? rawError : nil
    }
}

struct UpgradeFailure: Decodable, Equatable, Sendable {
    var step: String
    var message: String
    var retryable: Bool
    var needBytes: Double?
    var haveBytes: Double?

    init(step: String, message: String, retryable: Bool = true,
         needBytes: Double? = nil, haveBytes: Double? = nil) {
        self.step = step
        self.message = message
        self.retryable = retryable
        self.needBytes = needBytes
        self.haveBytes = haveBytes
    }

    private enum CodingKeys: String, CodingKey { case step, message, retryable, needBytes, haveBytes }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        step = ((try? c.decodeIfPresent(String.self, forKey: .step)) ?? nil) ?? "preflight"
        let msg = ((try? c.decodeIfPresent(String.self, forKey: .message)) ?? nil) ?? ""
        message = msg.isEmpty ? "The upgrade failed." : msg
        retryable = ((try? c.decodeIfPresent(Bool.self, forKey: .retryable)) ?? nil) ?? true
        needBytes = UpgradeProgress.finite((try? c.decodeIfPresent(Double.self, forKey: .needBytes)) ?? nil)
        haveBytes = UpgradeProgress.finite((try? c.decodeIfPresent(Double.self, forKey: .haveBytes)) ?? nil)
    }
}

/// The K3 object, from `GET /api/upgrade` or an `upgrade` frame's payload.
/// Tolerant: a malformed step or field is repaired or dropped rather than
/// failing the whole decode; only an unknown `state` throws (nothing to show).
struct UpgradeStatus: Decodable, Equatable, Sendable {
    var state: UpgradeState
    var steps: [UpgradeStep]
    /// 0...1
    var overall: Double
    var etaSeconds: Double?
    var error: UpgradeFailure?

    init(state: UpgradeState, steps: [UpgradeStep] = [], overall: Double = 0,
         etaSeconds: Double? = nil, error: UpgradeFailure? = nil) {
        self.state = state
        self.steps = steps
        self.overall = min(1, max(0, overall))
        self.etaSeconds = etaSeconds
        self.error = error
    }

    private enum CodingKeys: String, CodingKey { case state, steps, overall, etaSeconds, error }

    /// Decodes an element without letting its failure fail the surrounding array.
    private struct LossyStep: Decodable {
        let step: UpgradeStep?
        init(from decoder: Decoder) throws { step = try? UpgradeStep(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let wire = try c.decode(String.self, forKey: .state)
        guard let parsed = UpgradeState(wire: wire) else {
            throw DecodingError.dataCorruptedError(
                forKey: .state, in: c, debugDescription: "unknown upgrade state \(wire)")
        }
        state = parsed
        steps = ((try? c.decode([LossyStep].self, forKey: .steps)) ?? []).compactMap(\.step)
        let o = UpgradeProgress.finite((try? c.decodeIfPresent(Double.self, forKey: .overall)) ?? nil) ?? 0
        overall = min(1, max(0, o))
        let eta = UpgradeProgress.finite((try? c.decodeIfPresent(Double.self, forKey: .etaSeconds)) ?? nil)
        etaSeconds = (eta ?? -1) >= 0 ? eta : nil
        error = (try? c.decodeIfPresent(UpgradeFailure.self, forKey: .error)) ?? nil
    }

    /// Parse an HTTP body. nil when it is not a K3 object.
    static func parse(_ data: Data) -> UpgradeStatus? {
        try? JSONDecoder().decode(UpgradeStatus.self, from: data)
    }

    /// Parse an `upgrade` frame. nil for any other frame or a payload that is
    /// not a K3 object, so a stray frame can never flip the screen.
    static func from(frame: MantaStreamFrame) -> UpgradeStatus? {
        guard frame.kind == "upgrade" else { return nil }
        return (try? frame.decodedPayload(UpgradeStatus.self)) ?? nil
    }
}

// MARK: - State the screen is derived from

/// What the device knows about the box's upgrade. The one writer is the store;
/// the transitions are pure so they are tested without a socket.
struct UpgradeGateState: Equatable, Sendable {
    /// Latest K3 object from a frame or a read; nil = none yet / an old box
    /// with no upgrade API.
    var status: UpgradeStatus?
    /// A data call was refused `503 {upgrade:true}`; cleared by any answer that
    /// says the box is not (or no longer) upgrading.
    var upgradeModeSeen = false

    /// A frame/read result. `nil` = the box has no upgrade API (404) — an old
    /// box is never "upgrading".
    mutating func apply(status next: UpgradeStatus?) {
        status = next
        if next == nil || next?.state == .idle || next?.state == .completed {
            upgradeModeSeen = false
        }
    }

    mutating func markUpgradeMode() { upgradeModeSeen = true }

    /// Whether the box is believed to be mid-upgrade — what keeps the 1 s poll
    /// alive while the stream is down (a restart is expected during an upgrade).
    var isActive: Bool { UpgradeScreenModel.make(self) != nil }
}

// MARK: - What to show (pure)

struct UpgradeScreenModel: Equatable, Sendable {
    enum Kind: Equatable, Sendable { case waiting, running, failed, rolledBack }

    var kind: Kind
    var title: String
    var message: String
    var steps: [UpgradeStep]
    /// 0...1; nil when there is nothing measurable (the waiting state).
    var overall: Double?
    var eta: String?
    var currentStep: UpgradeStep?
    /// nil → indeterminate
    var currentFraction: Double?
    /// "needs 31 GB free, has 3 GB" on a disk failure.
    var disk: String?
    /// The failure the device cannot act on, so says where to act.
    var hint: String?

    /// nil when the app should open normally (idle, completed, an old box).
    static func make(_ s: UpgradeGateState) -> UpgradeScreenModel? {
        if let status = s.status {
            switch status.state {
            case .running:
                let current = UpgradePresentation.currentStep(status)
                return UpgradeScreenModel(
                    kind: .running,
                    title: "Your box is upgrading",
                    message: "Conversations are unavailable until this finishes. You can leave the app; it will pick up where the box is.",
                    steps: status.steps,
                    overall: status.overall,
                    eta: UpgradePresentation.etaText(status.etaSeconds),
                    currentStep: current,
                    currentFraction: UpgradePresentation.fraction(current),
                    disk: nil,
                    hint: nil
                )
            case .failed:
                return UpgradeScreenModel(
                    kind: .failed,
                    title: "The upgrade couldn't finish",
                    message: status.error?.message
                        ?? status.steps.first(where: { $0.status == .failed })?.error
                        ?? "The upgrade failed.",
                    steps: status.steps,
                    overall: status.overall,
                    eta: nil,
                    currentStep: UpgradePresentation.currentStep(status),
                    currentFraction: nil,
                    disk: UpgradePresentation.diskText(status.error),
                    hint: "Open Manta on your computer to retry or roll back."
                )
            case .rolledBack:
                return UpgradeScreenModel(
                    kind: .rolledBack,
                    title: "Your box was rolled back",
                    message: "The box is back on its previous version with your original history. This app may not match it until the previous version is reinstalled.",
                    steps: status.steps,
                    overall: nil,
                    eta: nil,
                    currentStep: nil,
                    currentFraction: nil,
                    disk: nil,
                    hint: nil
                )
            case .idle, .completed:
                break
            }
        }
        // A call was refused 503 "box upgrading" but no K3 object has arrived.
        if s.upgradeModeSeen {
            return UpgradeScreenModel(
                kind: .waiting,
                title: "Your box is upgrading",
                message: "The box is moving to a new version and can't take requests right now. This screen updates by itself.",
                steps: [],
                overall: nil,
                eta: nil,
                currentStep: nil,
                currentFraction: nil,
                disk: nil,
                hint: nil
            )
        }
        return nil
    }
}

enum UpgradePresentation {
    /// The running step, else the failed one.
    static func currentStep(_ status: UpgradeStatus) -> UpgradeStep? {
        status.steps.first(where: { $0.status == .running })
            ?? status.steps.first(where: { $0.status == .failed })
    }

    /// numerator/denominator → 0...1, or nil (indeterminate) when not measurable.
    static func fraction(_ step: UpgradeStep?) -> Double? {
        guard let p = step?.progress, let n = p.numerator, let d = p.denominator, d > 0 else { return nil }
        return min(1, max(0, n / d))
    }

    /// "about 4 min left"; nil when the box gave no estimate.
    static func etaText(_ seconds: Double?) -> String? {
        guard let seconds, seconds.isFinite, seconds >= 0 else { return nil }
        if seconds < 45 { return "less than a minute left" }
        let minutes = Int((seconds / 60).rounded())
        if minutes < 60 { return "about \(minutes) min left" }
        let h = minutes / 60
        let m = minutes % 60
        return m == 0 ? "about \(h) h left" : "about \(h) h \(m) min left"
    }

    /// "needs 31 GB free, has 3 GB"; nil unless the failure carries disk numbers.
    static func diskText(_ failure: UpgradeFailure?) -> String? {
        guard let need = failure?.needBytes, need > 0 else { return nil }
        let needText = "needs \(bytes(need)) free"
        guard let have = failure?.haveBytes, have >= 0 else { return needText }
        return "\(needText), has \(have == 0 ? "0 B" : bytes(have))"
    }

    /// "needs 31 GB free, has 3 GB" → "Needs 31 GB free, has 3 GB."
    static func sentence(_ text: String) -> String {
        guard let first = text.first else { return text }
        return first.uppercased() + text.dropFirst() + "."
    }

    /// Binary units, same shape as the desktop's `formatBytes` (31 GB, 1.5 GB).
    static func bytes(_ n: Double) -> String {
        guard n.isFinite, n > 0 else { return "0 B" }
        if n < 1024 { return "\(Int(n)) B" }
        let units = ["KB", "MB", "GB", "TB"]
        var value = n / 1024
        var i = 0
        while value >= 1024, i < units.count - 1 {
            value /= 1024
            i += 1
        }
        if value < 10 {
            let tenths = (value * 10).rounded() / 10
            let text = tenths == tenths.rounded() ? String(Int(tenths)) : String(tenths)
            return "\(text) \(units[i])"
        }
        return "\(Int(value.rounded())) \(units[i])"
    }

    static func defaultLabel(for id: String) -> String {
        switch id {
        case "preflight": return "Check disk space"
        case "stop": return "Stop running agents"
        case "copy": return "Copy history"
        case "migrate": return "Migrate conversations"
        case "verify": return "Verify"
        case "cutover": return "Switch over"
        default: return id
        }
    }
}

// MARK: - The 503 signal

extension Notification.Name {
    /// Posted by `MantaAPIClient` when a data call is refused `503 {upgrade:true}`.
    static let mantaBoxUpgrading = Notification.Name("manta.boxUpgrading")
}

extension UpgradeStatus {
    /// True for exactly the refusal K3 defines: HTTP 503 with a JSON body
    /// carrying `upgrade: true`. A bare 503 (a proxy, an overloaded box) is not
    /// an upgrade and must not raise the screen.
    static func isUpgradeRefusal(statusCode: Int, body: Data) -> Bool {
        guard statusCode == 503,
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let flag = object["upgrade"] as? Bool else { return false }
        return flag
    }
}
