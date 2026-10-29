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
// The iPhone shows the status and — on a failure — can act on it (WS10 F19):
// Retry / Check again, Roll back (behind a confirm) and Copy details, with the
// desktop's labels and outcome lines. The decisions for those (which label, what
// is disabled, what the details text says) are pure and live here; the calls
// themselves go through `BoxRESTClient.upgradeAction`.
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

/// The box's wording of the gate (`view` on the K3 object): the current step, ETA text,
/// disk sentence, Retry / Roll back rules and the "Copy details" text. Lenient: every
/// field is optional so a newer box never breaks an older app.
struct UpgradeView: Decodable, Equatable, Sendable {
    var kind: String
    var currentStepId: String?
    var currentFraction: Double?
    var etaText: String?
    var details: String?
    var failedStep: String?
    var message: String?
    var diskSentence: String?
    var retryLabel: String?
    var canRetry: Bool?
    var retryDisabledReason: String?
    var canRollback: Bool?

    init(kind: String, currentStepId: String? = nil, currentFraction: Double? = nil, etaText: String? = nil,
         details: String? = nil, failedStep: String? = nil, message: String? = nil, diskSentence: String? = nil,
         retryLabel: String? = nil, canRetry: Bool? = nil, retryDisabledReason: String? = nil, canRollback: Bool? = nil) {
        self.kind = kind
        self.currentStepId = currentStepId
        self.currentFraction = currentFraction
        self.etaText = etaText
        self.details = details
        self.failedStep = failedStep
        self.message = message
        self.diskSentence = diskSentence
        self.retryLabel = retryLabel
        self.canRetry = canRetry
        self.retryDisabledReason = retryDisabledReason
        self.canRollback = canRollback
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
    /// The gate's wording, computed by the box (WS11 D3 / X5). nil on an older box.
    var view: UpgradeView?

    init(state: UpgradeState, steps: [UpgradeStep] = [], overall: Double = 0,
         etaSeconds: Double? = nil, error: UpgradeFailure? = nil, view: UpgradeView? = nil) {
        self.state = state
        self.steps = steps
        self.overall = min(1, max(0, overall))
        self.etaSeconds = etaSeconds
        self.error = error
        self.view = view
    }

    private enum CodingKeys: String, CodingKey { case state, steps, overall, etaSeconds, error, view }

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
        view = (try? c.decodeIfPresent(UpgradeView.self, forKey: .view)) ?? nil
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
    /// What happened the last time the user pressed Retry / Roll back. A press's
    /// outcome describes the state it was pressed in; once the box moves on
    /// (failed → running after a retry) it is stale and is cleared.
    var retry: UpgradeActionOutcome = .idle
    var rollback: UpgradeActionOutcome = .idle

    /// A frame/read result. `nil` = the box has no upgrade API (404) — an old
    /// box is never "upgrading".
    mutating func apply(status next: UpgradeStatus?) {
        let stateChanged = status?.state != next?.state
        status = next
        if next == nil || next?.state == .idle || next?.state == .completed {
            upgradeModeSeen = false
        }
        if stateChanged {
            retry = .idle
            rollback = .idle
        }
    }

    mutating func markUpgradeMode() { upgradeModeSeen = true }

    mutating func actionStarted(_ action: UpgradeAction) {
        switch action {
        case .retry: retry = .pending
        case .rollback: rollback = .pending
        }
    }

    mutating func actionFinished(_ action: UpgradeAction, result: UpgradeActionResult) {
        let outcome: UpgradeActionOutcome = result.ok
            ? .ok
            : .error((result.error?.isEmpty == false ? result.error : nil) ?? "The box refused the request.")
        switch action {
        case .retry: retry = outcome
        case .rollback: rollback = outcome
        }
    }

    /// Whether the box is believed to be mid-upgrade — what keeps the 1 s poll
    /// alive while the stream is down (a restart is expected during an upgrade).
    var isActive: Bool { UpgradeScreenModel.make(self) != nil }
}

// MARK: - Retry / Roll back

enum UpgradeAction: String, Equatable, Sendable {
    case retry, rollback
}

/// The answer of `POST /api/upgrade/{retry|rollback}`: `{ok: true}` or
/// `{ok: false, error}`.
struct UpgradeActionResult: Equatable, Sendable {
    var ok: Bool
    var error: String?

    init(ok: Bool, error: String? = nil) {
        self.ok = ok
        self.error = error
    }
}

enum UpgradeActionOutcome: Equatable, Sendable {
    case idle, pending, ok
    case error(String)

    /// The line shown under the buttons: `okText` after a success, the message
    /// after a failure, nothing otherwise.
    func line(okText: String) -> String? {
        switch self {
        case .ok: return okText
        case .error(let message): return message
        case .idle, .pending: return nil
        }
    }

    var isPending: Bool { self == .pending }

    var isError: Bool {
        if case .error = self { return true }
        return false
    }
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
    /// "Needs 31 GB free, has 3 GB." on a disk failure — worded by the box.
    var disk: String?
    /// Reserved for a state the phone cannot act on. Always nil now that a failed
    /// upgrade is actionable from here.
    var hint: String?

    // The failed state's actions (nil / defaults elsewhere).
    /// The step the failure happened in ("preflight" when the box did not say).
    var failedStep: String? = nil
    /// "Check again" for preflight / verify (a retry just re-checks), else "Retry".
    var retryLabel: String = "Retry"
    /// false → Retry is rendered disabled with `retryDisabledReason`.
    var canRetry: Bool = false
    var retryDisabledReason: String? = nil
    /// Preflight and verify failures are fixed in place; rolling back is wrong.
    var canRollback: Bool = false
    /// A preflight failure stops before anything is touched.
    var nothingChanged: Bool = false
    var retry: UpgradeActionOutcome = .idle
    var rollback: UpgradeActionOutcome = .idle
    /// Plain-text snapshot for "Copy details" (running, failed, rolled back) — the box's.
    var details: String = ""
    /// The box sent no `view` (an older box): no Retry / Roll back; the screen shows the update note.
    var needsBoxUpdate: Bool = false

    /// The success line under the Retry button, matching the label.
    var retryOkText: String { retryLabel == "Retry" ? "Retry requested" : "Checking again…" }
    static let rollbackOkText = "Roll-back requested"

    /// nil when the app should open normally (idle, completed, an old box).
    static func make(_ s: UpgradeGateState) -> UpgradeScreenModel? {
        if let status = s.status {
            switch status.state {
            case .running:
                let v = status.view
                let current = v?.currentStepId.flatMap { id in status.steps.first(where: { $0.id == id }) }
                return UpgradeScreenModel(
                    kind: .running,
                    title: "Your box is upgrading",
                    message: "Conversations are unavailable until this finishes. You can leave the app; it will pick up where the box is.",
                    steps: status.steps,
                    overall: status.overall,
                    eta: v?.etaText,
                    currentStep: current,
                    currentFraction: v?.currentFraction,
                    disk: nil,
                    hint: nil,
                    details: v?.details ?? ""
                )
            case .failed:
                let v = status.view
                let message = v?.message
                    ?? status.error?.message
                    ?? status.steps.first(where: { $0.status == .failed })?.error
                    ?? "The upgrade failed."
                let failedStep = v?.failedStep ?? status.error?.step ?? "preflight"
                let current = v?.currentStepId.flatMap { id in status.steps.first(where: { $0.id == id }) }
                return UpgradeScreenModel(
                    kind: .failed,
                    title: "The upgrade couldn't finish",
                    message: message,
                    steps: status.steps,
                    overall: status.overall,
                    eta: nil,
                    currentStep: current,
                    currentFraction: nil,
                    disk: v?.diskSentence,
                    hint: nil,
                    failedStep: failedStep,
                    retryLabel: v?.retryLabel ?? "Retry",
                    // No view = an older box: offer Retry anyway (it refuses with its own sentence).
                    canRetry: v?.canRetry ?? true,
                    retryDisabledReason: v?.retryDisabledReason,
                    canRollback: v?.canRollback ?? false,
                    nothingChanged: failedStep == "preflight",
                    retry: s.retry,
                    rollback: s.rollback,
                    details: v?.details ?? "",
                    needsBoxUpdate: v == nil
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
                    hint: nil,
                    details: status.view?.details ?? ""
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
    // The gate's wording (current step, ETA, disk sentence, details, retry rules) is the
    // BOX's now (`view`, WS11 D3); only the fallback label of a step the box did not name stays.
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
