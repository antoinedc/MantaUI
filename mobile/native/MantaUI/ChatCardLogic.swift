import Foundation

// ===========================================================================
// WS02 — the pure rules behind the chat cards. FOUNDATION ONLY (Linux package).
//
// What is deliberately NOT here: any card COPY (retry headline, compaction
// line, send-error sentence, job bar lines, inbox outcome sentences). The box
// writes those (D23/D24); this file holds the client-only rules — view timing,
// gating, picking, the connection-state machine of the job check, and the
// message-focus planner.
// ===========================================================================

// MARK: - Stream rules

enum ChatCardStreamRules {
    /// The retry card goes away when the turn it belongs to ends. The box does
    /// not replay `retry` on a reconnect, so the client must also clear it.
    static func clearsRetry(sub: String, running: Bool?, complete: Bool?) -> Bool {
        switch sub {
        case "running": return running == false
        case "turnComplete": return complete == true
        default: return false
        }
    }
}

enum ChatCardCompactionReducer {
    /// Fold one `compaction` frame into the state. `generation` is the CURRENT
    /// generation (the router bumps it on `started`). A `delta` / `ended` with no
    /// prior state (a compaction we never saw start) stays nil.
    static func apply(
        _ payload: StreamCompactionPayload,
        to state: ChatCardCompactionState?,
        generation: Int
    ) -> ChatCardCompactionState? {
        switch payload.phase {
        case "started":
            return ChatCardCompactionState(
                generation: generation,
                reason: payload.reason ?? "context",
                text: payload.text ?? "",
                phase: .running
            )
        case "delta":
            guard var s = state else { return nil }
            s.text += payload.text ?? ""
            return s
        case "ended":
            guard var s = state else { return nil }
            s.phase = .done
            s.firstLine = (payload.firstLine?.isEmpty == false) ? payload.firstLine : nil
            return s
        default:
            return state
        }
    }
}

/// One-shot visibility for a transient card, keyed by something that only ever
/// grows (a compaction generation, a notice sequence number). The event store
/// keeps the state for the app's lifetime, so a card shown "for 3 seconds" must
/// be hidden by a latch here — clearing a copy would be undone by the next
/// snapshot.
struct ChatCardExpiryLatch: Equatable, Sendable {
    /// Keys ≤ this are never shown again.
    private(set) var expiredThrough: Int
    /// The key whose expiry timer is running.
    private(set) var scheduled: Int?

    /// `seed` = the newest key that must NOT show (opening a chat never shows a
    /// stale card).
    init(seed: Int) {
        expiredThrough = seed
    }

    /// Whether `key` is visible, and a key to start an expiry timer for — at most
    /// once per key.
    mutating func observe(key: Int, expiring: Bool) -> (visible: Bool, schedule: Int?) {
        guard key > expiredThrough else { return (false, nil) }
        guard expiring else { return (true, nil) }
        if scheduled == key { return (true, nil) }
        scheduled = key
        return (true, key)
    }

    mutating func expire(_ key: Int) {
        expiredThrough = max(expiredThrough, key)
        if scheduled == key { scheduled = nil }
    }
}

// MARK: - Background-job approval

enum ChatCardApprovalLogic {
    static let emptyListFootnote = "A job needs at least one rule. To give it no access, tap Not now."
    static let blankRuleFootnote = "Fill in or remove empty rules."
    static let noLongerPending = "That request is no longer pending"
    static let unreachable = "Couldn't reach your box — try again"

    /// Start is enabled only for a non-empty list whose every field is filled.
    /// (An empty edited list would NOT mean "deny everything" — the box then uses
    /// the original request. The box re-checks and refuses it too.)
    static func canStart(tools: [ChatCardApprovalTool]) -> Bool {
        footnote(tools: tools) == nil
    }

    /// Why Start is disabled; nil when it is enabled.
    static func footnote(tools: [ChatCardApprovalTool]) -> String? {
        if tools.isEmpty { return emptyListFootnote }
        if tools.contains(where: { blank($0.permission) || blank($0.pattern) }) { return blankRuleFootnote }
        return nil
    }

    /// One rule as the card shows it. A deny rule reads "deny · …" so the user can
    /// see what they are approving.
    static func ruleLabel(_ tool: ChatCardApprovalTool) -> String {
        let base = "\(tool.permission): \(tool.pattern)"
        return tool.action == "deny" ? "deny · \(base)" : base
    }

    /// The confirmation after a decision the box accepted (`ok: true`), or the
    /// "already decided elsewhere" line for `ok: false`.
    static func outcomeHint(ok: Bool, approved: Bool) -> String {
        guard ok else { return noLongerPending }
        return approved ? "Background job approved" : "Background job declined"
    }

    /// Drop approvals decided on this device: an in-flight poll that finishes
    /// after a local decision must not bring the card back.
    static func filterResolved(_ list: [ChatCardApproval], resolved: Set<String>) -> [ChatCardApproval] {
        list.filter { !resolved.contains($0.id) }
    }

    private static func blank(_ s: String) -> Bool {
        s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

enum ChatCardApprovalsDecoding {
    /// Both reply shapes: a bare array or `{approvals: []}`. Malformed → empty.
    static func decode(_ data: Data) -> [ChatCardApproval] {
        (try? JSONDecoder().decode(ChatCardApprovalList.self, from: data))?.approvals ?? []
    }
}

// MARK: - Who may change the conversation

/// What the job check learned.
enum ChatCardOwnershipInput: Equatable, Sendable {
    /// The box answered.
    case answer(ChatCardJobForSession)
    /// The box has no `chat-cards-1` (an older box): there is no job bar to show
    /// and no refusal either — exactly the behaviour before this feature.
    case capabilityAbsent
    /// The lookup failed, of any class (transport OR a server error string).
    case failure
}

struct ChatCardOwnershipVerdict: Equatable, Sendable {
    var policy: ChatCardMutationPolicy
    /// The bar content (non-nil only for a read-only job).
    var job: ChatCardJobView?
    var jobBarUnavailable: Bool
}

enum ChatCardOwnershipResolver {
    /// Maps the box's answer onto the policy. ANY failure keeps the current state:
    /// a known job stays read-only, `.resolving` stays resolving — only a
    /// successful answer may release held prompts (`MantaAPIClient` turns every
    /// non-empty RPC `error` into `MantaError.server`, and the lookup is a live
    /// read that can fail transiently).
    static func next(
        current: ChatCardMutationPolicy,
        currentJob: ChatCardJobView? = nil,
        result: ChatCardOwnershipInput
    ) -> ChatCardOwnershipVerdict {
        switch result {
        case .answer(.readOnly(let job)):
            return ChatCardOwnershipVerdict(policy: .readOnlyJob, job: job, jobBarUnavailable: false)
        case .answer(.writable):
            return ChatCardOwnershipVerdict(policy: .allowed, job: nil, jobBarUnavailable: false)
        case .capabilityAbsent:
            return ChatCardOwnershipVerdict(policy: .allowed, job: nil, jobBarUnavailable: true)
        case .failure:
            return ChatCardOwnershipVerdict(
                policy: current,
                job: current == .readOnlyJob ? currentJob : nil,
                jobBarUnavailable: false
            )
        }
    }
}

enum ChatCardMutationAction: Equatable, Sendable {
    /// A message the user is sending (held while the session is being checked).
    case send
    /// Anything else that changes the conversation (answer a card, compact, …).
    case mutate
}

enum ChatCardGateDecision: Equatable, Sendable {
    case run
    case hold
    case refuse(String)
}

enum ChatCardMutationGate {
    static let readOnlyJobMessage = "This is a background job — it can't take messages"
    static let checkingMessage = "One moment — checking this session"

    /// The client UX gate. The box refuses a message aimed at a job session
    /// anyway (HTTP 409); this keeps the phone from asking.
    static func decide(policy: ChatCardMutationPolicy, action: ChatCardMutationAction) -> ChatCardGateDecision {
        switch policy {
        case .allowed: return .run
        case .readOnlyJob: return .refuse(readOnlyJobMessage)
        case .resolving: return action == .send ? .hold : .refuse(checkingMessage)
        }
    }
}

extension ChatCardMutationGate {
    /// The composer takes input in every state but a read-only job: while the session
    /// is still being checked typing stays possible (the send is held instead).
    static func composerAcceptsInput(_ policy: ChatCardMutationPolicy) -> Bool {
        policy != .readOnlyJob
    }
}

// MARK: - Pending-message actions gate

enum ChatCardInboxGate {
    static let updateBoxNote = "Update your box to use this"

    /// Whether the pending card's actions (×, Send now, Wait, Edit last) are enabled,
    /// and the line that explains why not. `available` is `chat-cards-1`: nil = not
    /// known yet (disabled, no note), false = an older box (disabled + the note).
    static func resolve(available: Bool?, canMutate: Bool) -> (actionsEnabled: Bool, gateNote: String?) {
        (available == true && canMutate, available == false ? updateBoxNote : nil)
    }
}

// MARK: - Edit last

enum ChatCardEditLast {
    /// The newest pending message that has no action in flight.
    static func pick(items: [InboxItem], busy: Set<String>) -> InboxItem? {
        items.last { !busy.contains($0.id) }
    }
}

// MARK: - Seat line, progress rule

enum ChatCardSeatLine {
    /// "Work · Seat 2" for the context sheet; nil without a seat.
    static func value(_ seat: ConversationSeat?) -> String? {
        guard let name = seat?.displayName.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
        return name
    }
}

enum ChatCardProgressRule {
    /// The "Blocked — needs a decision" card shows for this state and no other.
    static func isBlocked(state: String) -> Bool { state == "blocked" }
}

// MARK: - Jump to a message

enum ChatCardFocusPlan: Equatable, Sendable {
    case present(index: Int)
    case widen(newLimit: Int)
    case tooFarBack
    case notFound
}

enum ChatCardFocusPlanner {
    static let defaultCap = 500
    static let defaultStep = 50

    /// Re-locate the target by id on every fetch, so messages appended between
    /// the lookup and the presentation (or turn-boundary refetches while focused)
    /// can never shift it.
    static func next(
        target: String,
        messageIDs: [String],
        limit: Int,
        hasEarlier: Bool,
        cap: Int = defaultCap,
        step: Int = defaultStep
    ) -> ChatCardFocusPlan {
        if let index = messageIDs.firstIndex(of: target) { return .present(index: index) }
        guard hasEarlier else { return .notFound }
        guard limit < cap else { return .tooFarBack }
        return .widen(newLimit: min(limit + step, cap))
    }
}

enum ChatCardFocusHighlightResult: Equatable, Sendable {
    case row(String)
    case unfinished
    case nothingToShow
}

enum ChatCardFocusHighlight {
    static let unfinishedHint = "That reply is still being written — it will appear here when it finishes"
    static let nothingToShowHint = "That message has nothing to show here — showing what came after it"

    /// Which row to highlight: the slice's first row only when the target itself
    /// maps to at least one row (the mapper emits blocks message by message, so
    /// the target's first block IS row 0). Otherwise highlight nothing and say why.
    static func resolve(
        targetBlockCount: Int,
        targetIsUnfinishedAssistant: Bool,
        sliceRowIDs: [String]
    ) -> ChatCardFocusHighlightResult {
        if targetBlockCount > 0, let first = sliceRowIDs.first { return .row(first) }
        if targetBlockCount == 0, targetIsUnfinishedAssistant { return .unfinished }
        return .nothingToShow
    }
}

enum ChatCardLoadEarlierAction: Equatable, Sendable {
    /// There are loaded messages above the target: reveal them (a prepend).
    case revealLocal
    /// The target is the first loaded message: reveal nothing, widen normally.
    case revealLocalThenWiden
}

enum ChatCardFocusPolicy {
    /// The blocking-card arrival jump to the bottom must not fight a focused message.
    static func allowsBottomJump(phase: ChatCardFocusPhase) -> Bool {
        phase == .none
    }

    static func loadEarlierAction(index: Int) -> ChatCardLoadEarlierAction {
        index > 0 ? .revealLocal : .revealLocalThenWiden
    }
}

enum ChatCardFocusEvent: Equatable, Sendable {
    case focus(id: String, token: Int)
    case presented(token: Int)
    case tooFarBack(token: Int)
    case notFound(token: Int)
    case fetchFailed(token: Int)
    case clear
}

enum ChatCardFocusMachine {
    static let tooFarBackMessage = "That message is too far back to open here — it's more than 500 messages ago"
    static let notFoundMessage = "Couldn't find that message — it may have been compacted away"
    static let fetchFailedMessage = "Couldn't load that message — check the connection"

    /// Events carrying a token other than the current focus's are ignored (a
    /// second `.message` route wins; the first one's late result is dropped).
    static func reduce(_ phase: ChatCardFocusPhase, event: ChatCardFocusEvent) -> ChatCardFocusPhase {
        func currentToken() -> Int? {
            switch phase {
            case .locating(_, let token), .presented(_, let token): return token
            case .none, .failed: return nil
            }
        }
        func currentID() -> String? {
            switch phase {
            case .locating(let id, _), .presented(let id, _): return id
            case .none, .failed: return nil
            }
        }
        switch event {
        case .focus(let id, let token):
            return .locating(id: id, token: token)
        case .presented(let token):
            guard token == currentToken(), let id = currentID() else { return phase }
            return .presented(id: id, token: token)
        case .tooFarBack(let token):
            return token == currentToken() ? .failed(tooFarBackMessage) : phase
        case .notFound(let token):
            return token == currentToken() ? .failed(notFoundMessage) : phase
        case .fetchFailed(let token):
            return token == currentToken() ? .failed(fetchFailedMessage) : phase
        case .clear:
            return .none
        }
    }
}
