import Foundation

// ===========================================================================
// WS05 — git / pull request / review, pure half (Foundation only).
//
// SERVER-FIRST (D23/D24): the box computes every rule — the panel / ship / merge
// state and their copy, the check tone + order + chip, the "send failures"
// prompt, the structured review diff with thread and draft placement, the error
// messages. These types DECODE what the box returns; the only logic kept here is
// what is genuinely client-side: the device-local connect-offer dismissal, the
// immutable merge snapshot, ship-preview request sequencing, the composer-insert
// policy, the draft-placement reconcile after a mutation, and the plural.
//
// Every wire type is lenient: `decodeIfPresent` + a default for everything but an
// identity field, so a new or missing field never drops a payload. Unknown enum
// strings are kept (`other`) and render neutrally.
// ===========================================================================

// MARK: - Lenient decoding

/// The keys of the `{ok, …}` result unions.
private enum WireKey: String, CodingKey {
    case ok, error, kind, message
    case head, base, fileCount, title, body
    case pr, url, draft
}

/// One element of a list that decodes to nil instead of failing the whole list.
private struct LossyElement<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
    }
}

extension KeyedDecodingContainer {
    /// A list where one malformed element is skipped instead of dropping the
    /// payload ("never drop a payload"). Missing / null / not-a-list → [].
    func lossyList<T: Decodable>(_ type: T.Type, forKey key: Key) -> [T] {
        lossyListIfPresent(type, forKey: key) ?? []
    }

    /// nil only when the key is absent or not a list (so an older box is told
    /// apart from an empty answer).
    func lossyListIfPresent<T: Decodable>(_ type: T.Type, forKey key: Key) -> [T]? {
        guard let elements = (try? decodeIfPresent([LossyElement<T>].self, forKey: key)) ?? nil else { return nil }
        return elements.compactMap(\.value)
    }
}

private extension KeyedDecodingContainer {
    func lenientString(_ key: Key) -> String? { (try? decodeIfPresent(String.self, forKey: key)) ?? nil }
    func lenientBool(_ key: Key) -> Bool? { (try? decodeIfPresent(Bool.self, forKey: key)) ?? nil }
    func lenientInt(_ key: Key) -> Int? {
        if let i = (try? decodeIfPresent(Int.self, forKey: key)) ?? nil { return i }
        if let d = (try? decodeIfPresent(Double.self, forKey: key)) ?? nil { return Int(d) }
        return nil
    }
    func lenientDouble(_ key: Key) -> Double? { (try? decodeIfPresent(Double.self, forKey: key)) ?? nil }
}

// MARK: - Tones (the box's vocabulary)

/// A tone word the box sends: a check's `ok | running | error`, a chip's
/// `ok | warn | danger`, a merge line's `ok | muted | danger`, an inbox row's
/// `danger | warn | muted`. Unknown words are kept and render neutrally.
enum GitTone: Equatable, Sendable {
    case ok, running, error, warn, danger, muted
    case other(String)

    init(wire: String?) {
        switch wire {
        case "ok": self = .ok
        case "running": self = .running
        case "error": self = .error
        case "warn": self = .warn
        case "danger": self = .danger
        case "muted": self = .muted
        case .some(let other): self = .other(other)
        case nil: self = .muted
        }
    }
}

/// The CI traffic light. Unknown → `.none`.
enum GitRollup: Equatable, Sendable {
    case green, yellow, red, none

    init(wire: String?) {
        switch wire {
        case "green": self = .green
        case "yellow": self = .yellow
        case "red": self = .red
        default: self = .none
        }
    }
}

// MARK: - Pull request

struct GitPullRequest: Decodable, Equatable, Sendable {
    var number: Int
    var title: String
    var url: String
    /// "draft" | "open" | "merged" | "closed" — unknown kept verbatim.
    var state: String
    var headRef: String
    var baseRef: String
    var headSha: String
    var reviewers: [String]
    /// true | false | nil (nil = the forge is still computing it).
    var mergeable: Bool?
    var mergeBlockedReason: String?
    var unresolvedThreads: Int

    private enum CodingKeys: String, CodingKey {
        case number, title, url, state, headRef, baseRef, headSha, reviewers
        case mergeable, mergeBlockedReason, unresolvedThreads
    }

    init(number: Int, title: String = "", url: String = "", state: String = "open", headRef: String = "",
         baseRef: String = "", headSha: String = "", reviewers: [String] = [], mergeable: Bool? = nil,
         mergeBlockedReason: String? = nil, unresolvedThreads: Int = 0) {
        self.number = number
        self.title = title
        self.url = url
        self.state = state
        self.headRef = headRef
        self.baseRef = baseRef
        self.headSha = headSha
        self.reviewers = reviewers
        self.mergeable = mergeable
        self.mergeBlockedReason = mergeBlockedReason
        self.unresolvedThreads = unresolvedThreads
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        number = try c.decode(Int.self, forKey: .number)
        title = c.lenientString(.title) ?? ""
        url = c.lenientString(.url) ?? ""
        state = c.lenientString(.state) ?? "open"
        headRef = c.lenientString(.headRef) ?? ""
        baseRef = c.lenientString(.baseRef) ?? ""
        headSha = c.lenientString(.headSha) ?? ""
        reviewers = ((try? c.decodeIfPresent([String].self, forKey: .reviewers)) ?? nil) ?? []
        mergeable = c.lenientBool(.mergeable)
        mergeBlockedReason = c.lenientString(.mergeBlockedReason)
        unresolvedThreads = c.lenientInt(.unresolvedThreads) ?? 0
    }
}

struct GitCheckRun: Decodable, Equatable, Sendable, Identifiable {
    var name: String
    /// The raw forge words, shown as the row's secondary text.
    var status: String?
    var conclusion: String?
    var url: String?
    /// The box's classification. A box that sends none leaves `.muted`.
    var tone: GitTone

    var id: String { name }

    /// "failure", "in_progress", … — the raw word for the row's detail line.
    var rawState: String? { conclusion ?? status }

    private enum CodingKeys: String, CodingKey { case name, status, conclusion, url, tone }

    init(name: String, status: String? = nil, conclusion: String? = nil, url: String? = nil, tone: GitTone = .muted) {
        self.name = name
        self.status = status
        self.conclusion = conclusion
        self.url = url
        self.tone = tone
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        status = c.lenientString(.status)
        conclusion = c.lenientString(.conclusion)
        url = c.lenientString(.url)
        tone = GitTone(wire: c.lenientString(.tone))
    }
}

/// How the branch chip behaves. Unknown kept; renders as a plain label.
enum GitPanel: Equatable, Sendable {
    case none, noPR, pr
    case other(String)

    init(wire: String?) {
        switch wire {
        case "none": self = .none
        case "no-pr": self = .noPR
        case "pr": self = .pr
        case .some(let other): self = .other(other)
        case nil: self = .none
        }
    }

    /// Only these two open the sheet.
    var isInteractive: Bool { self == .noPR || self == .pr }
}

/// The ship gate. Unknown kept; renders as "not shippable" with the box's copy.
enum GitShipKind: Equatable, Sendable {
    case hasPR, detached, unknown, onBase, noCommits, ready
    case other(String)

    init(wire: String?) {
        switch wire {
        case "has-pr": self = .hasPR
        case "detached": self = .detached
        case "unknown": self = .unknown
        case "on-base": self = .onBase
        case "no-commits": self = .noCommits
        case "ready": self = .ready
        case .some(let other): self = .other(other)
        case nil: self = .unknown
        }
    }
}

struct GitShipView: Decodable, Equatable, Sendable {
    var state: GitShipKind
    /// The box's sentence for a not-shippable state; nil for ready / has-pr.
    var copy: String?

    private enum CodingKeys: String, CodingKey { case state, copy }

    init(state: GitShipKind, copy: String? = nil) {
        self.state = state
        self.copy = copy
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = GitShipKind(wire: c.lenientString(.state))
        copy = c.lenientString(.copy)
    }
}

struct GitMergeableLine: Decodable, Equatable, Sendable {
    var text: String
    var tone: GitTone

    private enum CodingKeys: String, CodingKey { case text, tone }

    init(text: String, tone: GitTone) {
        self.text = text
        self.tone = tone
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = c.lenientString(.text) ?? ""
        tone = GitTone(wire: c.lenientString(.tone))
    }
}

struct GitMergeView: Decodable, Equatable, Sendable {
    /// The box's gate (G2): checks green, no unresolved threads, forge says mergeable.
    var can: Bool
    /// Why not, when `can` is false ("checks failing", "2 unresolved threads", …).
    var reason: String?
    var mergeable: GitMergeableLine

    private enum CodingKeys: String, CodingKey { case can, reason, mergeable }

    init(can: Bool, reason: String? = nil, mergeable: GitMergeableLine) {
        self.can = can
        self.reason = reason
        self.mergeable = mergeable
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        can = c.lenientBool(.can) ?? false
        reason = c.lenientString(.reason)
        mergeable = ((try? c.decodeIfPresent(GitMergeableLine.self, forKey: .mergeable)) ?? nil)
            ?? GitMergeableLine(text: "computing…", tone: .muted)
    }
}

struct GitChecksCounts: Decodable, Equatable, Sendable {
    var passed: Int
    var failed: Int
    var running: Int

    private enum CodingKeys: String, CodingKey { case passed, failed, running }

    init(passed: Int = 0, failed: Int = 0, running: Int = 0) {
        self.passed = passed
        self.failed = failed
        self.running = running
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        passed = c.lenientInt(.passed) ?? 0
        failed = c.lenientInt(.failed) ?? 0
        running = c.lenientInt(.running) ?? 0
    }
}

struct GitChecksChip: Decodable, Equatable, Sendable {
    var glyph: String
    /// "✓ 7" / "✗ 2 failed" / "◐ 3 running" — glyph included.
    var label: String
    var tone: GitTone

    private enum CodingKeys: String, CodingKey { case glyph, label, tone }

    init(glyph: String, label: String, tone: GitTone) {
        self.glyph = glyph
        self.label = label
        self.tone = tone
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        glyph = c.lenientString(.glyph) ?? ""
        label = c.lenientString(.label) ?? ""
        tone = GitTone(wire: c.lenientString(.tone))
    }
}

struct GitChecksView: Decodable, Equatable, Sendable {
    var counts: GitChecksCounts
    /// nil unless there is a PR, ≥1 check and a non-`none` rollup.
    var chip: GitChecksChip?
    /// The text "Send failures to the agent" appends; nil when nothing failed.
    var failuresPrompt: String?
    var logsUrl: String?

    private enum CodingKeys: String, CodingKey { case counts, chip, failuresPrompt, logsUrl }

    init(counts: GitChecksCounts = GitChecksCounts(), chip: GitChecksChip? = nil,
         failuresPrompt: String? = nil, logsUrl: String? = nil) {
        self.counts = counts
        self.chip = chip
        self.failuresPrompt = failuresPrompt
        self.logsUrl = logsUrl
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        counts = ((try? c.decodeIfPresent(GitChecksCounts.self, forKey: .counts)) ?? nil) ?? GitChecksCounts()
        chip = (try? c.decodeIfPresent(GitChecksChip.self, forKey: .chip)) ?? nil
        failuresPrompt = c.lenientString(.failuresPrompt)
        logsUrl = c.lenientString(.logsUrl)
    }
}

/// The box's render-ready view of a `forge:pull-request` read (S.1).
struct GitPullRequestView: Decodable, Equatable, Sendable {
    var panel: GitPanel
    /// "feat/x · #412" — nil when the panel is `none`.
    var chipLabel: String?
    var ship: GitShipView
    /// nil when there is no PR.
    var merge: GitMergeView?
    var checks: GitChecksView

    private enum CodingKeys: String, CodingKey { case panel, chipLabel, ship, merge, checks }

    init(panel: GitPanel, chipLabel: String? = nil, ship: GitShipView = GitShipView(state: .unknown),
         merge: GitMergeView? = nil, checks: GitChecksView = GitChecksView()) {
        self.panel = panel
        self.chipLabel = chipLabel
        self.ship = ship
        self.merge = merge
        self.checks = checks
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        panel = GitPanel(wire: c.lenientString(.panel))
        chipLabel = c.lenientString(.chipLabel)
        ship = ((try? c.decodeIfPresent(GitShipView.self, forKey: .ship)) ?? nil) ?? GitShipView(state: .unknown)
        merge = (try? c.decodeIfPresent(GitMergeView.self, forKey: .merge)) ?? nil
        checks = ((try? c.decodeIfPresent(GitChecksView.self, forKey: .checks)) ?? nil) ?? GitChecksView()
    }
}

/// `forge:pull-request` result.
struct GitPullRequestResult: Decodable, Equatable, Sendable {
    var pr: GitPullRequest?
    /// Server-ordered (failed → running → passed), each with its `tone`.
    var checks: [GitCheckRun]
    var rollup: GitRollup
    var stale: Bool
    /// "no_forge" | "not_connected" | nil.
    var error: String?
    var branch: String?
    var base: String?
    var aheadCount: Int?
    /// nil on a box without the `forge-pr-view-1` capability (an older box).
    var view: GitPullRequestView?

    private enum CodingKeys: String, CodingKey {
        case pr, checks, rollup, stale, error, branch, base, aheadCount, view
    }

    init(pr: GitPullRequest? = nil, checks: [GitCheckRun] = [], rollup: GitRollup = .none, stale: Bool = false,
         error: String? = nil, branch: String? = nil, base: String? = nil, aheadCount: Int? = nil,
         view: GitPullRequestView? = nil) {
        self.pr = pr
        self.checks = checks
        self.rollup = rollup
        self.stale = stale
        self.error = error
        self.branch = branch
        self.base = base
        self.aheadCount = aheadCount
        self.view = view
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pr = (try? c.decodeIfPresent(GitPullRequest.self, forKey: .pr)) ?? nil
        checks = c.lossyList(GitCheckRun.self, forKey: .checks)
        rollup = GitRollup(wire: c.lenientString(.rollup))
        stale = c.lenientBool(.stale) ?? false
        error = c.lenientString(.error)
        branch = c.lenientString(.branch)
        base = c.lenientString(.base)
        aheadCount = c.lenientInt(.aheadCount)
        view = (try? c.decodeIfPresent(GitPullRequestView.self, forKey: .view)) ?? nil
    }
}

// MARK: - Write results

/// A failed write: the box's raw `error`, its distinguished `kind` and — on a
/// box with `forge-messages-1` — the plain-language `message` to show.
struct GitFailure: Equatable, Sendable {
    var error: String
    var kind: String?
    var message: String?

    /// What the user reads: the box's message, else the raw error.
    var display: String {
        if let message, !message.isEmpty { return message }
        return error.isEmpty ? "Something went wrong." : error
    }

    fileprivate init(from c: KeyedDecodingContainer<WireKey>) {
        error = c.lenientString(.error) ?? ""
        kind = c.lenientString(.kind)
        message = c.lenientString(.message)
    }

    init(error: String, kind: String? = nil, message: String? = nil) {
        self.error = error
        self.kind = kind
        self.message = message
    }
}

private func gitOk(_ c: KeyedDecodingContainer<WireKey>) -> Bool {
    c.lenientBool(.ok) ?? false
}

struct GitShipPreview: Equatable, Sendable {
    var head: String
    var base: String
    var fileCount: Int
    var title: String
    var body: String

    /// The title the PR is created with: the drafted one, else the branch name.
    var effectiveTitle: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? head : title
    }
}

/// `forge:ship-preview`.
enum GitShipPreviewResult: Decodable, Equatable, Sendable {
    case ok(GitShipPreview)
    case failed(GitFailure)

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: WireKey.self)
        guard gitOk(c) else {
            self = .failed(GitFailure(from: c))
            return
        }
        self = .ok(GitShipPreview(
            head: c.lenientString(.head) ?? "",
            base: c.lenientString(.base) ?? "",
            fileCount: c.lenientInt(.fileCount) ?? 0,
            title: c.lenientString(.title) ?? "",
            body: c.lenientString(.body) ?? ""
        ))
    }
}

/// `forge:ship`.
enum GitShipResult: Decodable, Equatable, Sendable {
    case ok(pr: GitPullRequest?, url: String)
    case failed(GitFailure)

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: WireKey.self)
        guard gitOk(c) else {
            self = .failed(GitFailure(from: c))
            return
        }
        let pr = (try? c.decodeIfPresent(GitPullRequest.self, forKey: .pr)) ?? nil
        let url = c.lenientString(.url) ?? pr?.url ?? ""
        self = .ok(pr: pr, url: url)
    }
}

/// `forge:merge`.
enum GitMergeResult: Decodable, Equatable, Sendable {
    case ok
    case failed(GitFailure)

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: WireKey.self)
        self = gitOk(c) ? .ok : .failed(GitFailure(from: c))
    }
}

/// `delegate:start` → `{ok, error?}`.
struct GitDelegateStartResult: Decodable, Equatable, Sendable {
    var ok: Bool
    var error: String?

    private enum CodingKeys: String, CodingKey { case ok, error }

    init(ok: Bool, error: String? = nil) {
        self.ok = ok
        self.error = error
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenientBool(.ok) ?? false
        error = c.lenientString(.error)
    }
}

// MARK: - Connect offer (G8, KEEP-CLIENT — reads a device-local dismissed flag)

enum GitConnectOffer {
    /// "Connect GitHub to see checks and pull requests for this repo."
    static let sentence = "Connect GitHub to see checks and pull requests for this repo."
    static let configKey = "forgeConnectOfferDismissed"

    /// Only when GitHub is NOT connected, the origin is a recognised forge, and
    /// the offer was not dismissed for good.
    static func shouldShow(connected: Bool, forgeKind: String?, dismissed: Bool) -> Bool {
        if connected || dismissed { return false }
        return forgeKind != nil
    }
}

// MARK: - Poll state

/// What one poll tick gives the screen: the connection status plus the PR read,
/// copied field for field. No rule is derived here.
struct GitForgeState: Equatable, Sendable {
    var connected: Bool
    /// "github" unless the PR read answered `no_forge`.
    var kind: String?
    var pr: GitPullRequest?
    var checks: [GitCheckRun]
    var stale: Bool
    /// The FORGE branch (the one the PR read resolved).
    var branch: String?
    var base: String?
    var aheadCount: Int?
    var view: GitPullRequestView?
    var error: String?

    static let empty = GitForgeState(
        connected: false, kind: nil, pr: nil, checks: [], stale: false, branch: nil, base: nil,
        aheadCount: nil, view: nil, error: nil
    )

    init(connected: Bool, kind: String?, pr: GitPullRequest?, checks: [GitCheckRun], stale: Bool,
         branch: String?, base: String?, aheadCount: Int?, view: GitPullRequestView?, error: String?) {
        self.connected = connected
        self.kind = kind
        self.pr = pr
        self.checks = checks
        self.stale = stale
        self.branch = branch
        self.base = base
        self.aheadCount = aheadCount
        self.view = view
        self.error = error
    }

    init(status: ForgeConnectionStatus, result: GitPullRequestResult) {
        self.init(
            connected: status.connected,
            kind: result.error == "no_forge" ? nil : "github",
            pr: result.pr,
            checks: result.checks,
            stale: result.stale,
            branch: result.branch,
            base: result.base,
            aheadCount: result.aheadCount,
            view: result.view,
            error: result.error
        )
    }

    /// The box answered this poll without a `view` while GitHub is connected: an
    /// older box. The header says so once (D24).
    var boxLacksPullRequestView: Bool { connected && view == nil }

    /// This state with `pr` as the branch's pull request: the sheet goes straight
    /// to the PR view (checks and merge gate arrive with the next poll).
    func pinning(_ pr: GitPullRequest) -> GitForgeState {
        var next = self
        next.pr = pr
        next.view = GitPullRequestView(
            panel: .pr,
            chipLabel: branch.map { "\($0) · #\(pr.number)" },
            ship: GitShipView(state: .hasPR),
            merge: nil,
            checks: view?.checks ?? GitChecksView()
        )
        return next
    }
}

/// A just-created pull request, held on screen until a poll returns it (GitHub's
/// list often lags a new PR) or the branch changes.
struct GitPinnedPR: Equatable, Sendable {
    var pr: GitPullRequest
    var branch: String

    /// What `incoming` should become. nil `keep` = the pin is done.
    func resolve(_ incoming: GitForgeState) -> (state: GitForgeState, keep: Bool) {
        if incoming.pr?.number == pr.number || incoming.branch != branch { return (incoming, false) }
        return (incoming.pinning(pr), true)
    }
}

// MARK: - Merge snapshot (the user confirms exactly this)

/// What the merge confirmation was shown — captured at the tap, so a poll that
/// replaces or clears the PR while the dialog is open changes nothing about what
/// is merged. The box re-checks the gate and the head SHA when it arrives.
struct GitMergeTarget: Equatable, Sendable {
    var cwd: String
    var number: Int
    var title: String
    var base: String
    var headSha: String

    /// nil without a PR, or when the box's own gate says it can't merge.
    static func target(state: GitForgeState, cwd: String) -> GitMergeTarget? {
        guard let pr = state.pr, state.view?.merge?.can == true else { return nil }
        return GitMergeTarget(cwd: cwd, number: pr.number, title: pr.title, base: pr.baseRef, headSha: pr.headSha)
    }
}

// MARK: - Ship preview sequencing (G9, KEEP-CLIENT)

/// The branch a ship preview was drafted for. A preview for any other key is
/// never shown or submitted.
struct GitShipKey: Hashable, Sendable {
    var cwd: String
    var branch: String
    var base: String

    static func current(state: GitForgeState, cwd: String) -> GitShipKey? {
        guard let branch = state.branch, !branch.isEmpty else { return nil }
        return GitShipKey(cwd: cwd, branch: branch, base: state.base ?? "")
    }
}

enum GitShipPreviewState: Equatable, Sendable {
    case idle
    case loading(GitShipKey)
    case ready(GitShipKey, GitShipPreview)
    case failed(GitShipKey, String)

    var key: GitShipKey? {
        switch self {
        case .idle: return nil
        case .loading(let k), .ready(let k, _), .failed(let k, _): return k
        }
    }

    /// A response applies only if its key is still the current one; otherwise it
    /// is dropped (nil) — a late answer for a previous branch.
    static func accept(response: GitShipPreviewResult, for key: GitShipKey, current: GitShipKey?) -> GitShipPreviewState? {
        guard let current, current == key else { return nil }
        switch response {
        case .ok(let preview): return .ready(key, preview)
        case .failed(let failure): return .failed(key, failure.display)
        }
    }

    /// A poll that moved the branch or base resets the preview.
    func invalidated(by newKey: GitShipKey?) -> GitShipPreviewState {
        guard let key else { return self }
        return key == newKey ? self : .idle
    }

    /// Create is allowed only for a ready preview of the CURRENT branch with a
    /// title (the branch name stands in for an empty one).
    func canCreate(current: GitShipKey?) -> Bool {
        guard case .ready(let key, let preview) = self, let current, key == current else { return false }
        return !preview.effectiveTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Whether a fetch for `key` is already running or done (no second one).
    func covers(_ key: GitShipKey) -> Bool {
        switch self {
        case .loading(let k), .ready(let k, _): return k == key
        case .idle, .failed: return false
        }
    }
}

// MARK: - Composer insert policy (G12, KEEP-CLIENT)

enum GitComposerPolicy {
    /// Whether "Send to agent" / "Send failures" may be offered at all.
    static func canInsert(readOnly: Bool, hasController: Bool, acceptsInput: Bool) -> Bool {
        !readOnly && hasController && acceptsInput
    }
}

/// The outcome of putting text into the chat's composer.
enum GitSendResult: Equatable, Sendable {
    case added
    case readOnly
    case rejected

    /// The line shown when the insert did not happen; nil on success.
    var failureMessage: String? {
        switch self {
        case .added: return nil
        case .readOnly: return "This chat is read-only."
        case .rejected: return "Couldn't add it to your message."
        }
    }
}

// MARK: - Which chat window a session lives in

enum GitSessionLookup {
    /// The working directory of the window that hosts `sessionID`: the pane's
    /// current path, else the project root. nil when the session isn't open.
    static func cwd(for sessionID: String, in projects: [MantaProject]) -> String? {
        guard !sessionID.isEmpty else { return nil }
        for project in projects {
            if let window = project.windows.first(where: { $0.opencodeSessionId == sessionID }) {
                let path = window.paneCurrentPath.isEmpty ? project.defaultCwd : window.paneCurrentPath
                return path.isEmpty ? nil : path
            }
        }
        return nil
    }
}

// MARK: - Review: the forge target

enum GitRef: Hashable, Sendable {
    case cwd(String)
    case pr(repoKey: String, number: Int)

    var json: [String: Any] {
        switch self {
        case .cwd(let path): return ["cwd": path]
        case .pr(let repoKey, let number): return ["repoKey": repoKey, "number": number]
        }
    }
}

enum GitVerdict: String, CaseIterable, Identifiable, Equatable, Sendable {
    case approved
    case changesRequested = "changes_requested"
    case commented

    var id: String { rawValue }

    var title: String {
        switch self {
        case .approved: return "Approve"
        case .changesRequested: return "Request changes"
        case .commented: return "Comment"
        }
    }
}

// MARK: - Review: structured diff (the box parses and places)

/// Where a thread or draft comment belongs, by the box's coordinate placement.
enum GitPlacement: Decodable, Equatable, Hashable, Sendable {
    case row(file: Int, row: Int)
    case file(Int)
    case unplaced

    private enum CodingKeys: String, CodingKey { case at, file, row }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch c.lenientString(.at) {
        case "row":
            if let file = c.lenientInt(.file), let row = c.lenientInt(.row) {
                self = .row(file: file, row: row)
            } else {
                self = .unplaced
            }
        case "file":
            if let file = c.lenientInt(.file) { self = .file(file) } else { self = .unplaced }
        default:
            self = .unplaced
        }
    }
}

enum GitRowKind: Equatable, Sendable {
    case hunk, added, removed, context
    case other(String)

    init(wire: String?) {
        switch wire {
        case "hunk": self = .hunk
        case "added": self = .added
        case "removed": self = .removed
        case "context": self = .context
        case .some(let other): self = .other(other)
        case nil: self = .other("")
        }
    }
}

/// The exact anchor a comment on this row is sent with.
struct GitAnchor: Decodable, Equatable, Hashable, Sendable {
    var path: String
    var line: Int
    /// "new" | "old" | "both".
    var side: String

    private enum CodingKeys: String, CodingKey { case path, line, side }

    init(path: String, line: Int, side: String) {
        self.path = path
        self.line = line
        self.side = side
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        line = try c.decode(Int.self, forKey: .line)
        side = c.lenientString(.side) ?? "new"
    }
}

struct GitDiffRow: Decodable, Equatable, Sendable {
    var kind: GitRowKind
    var text: String
    var oldLine: Int?
    var newLine: Int?
    /// nil = not commentable (hunk header).
    var anchor: GitAnchor?

    private enum CodingKeys: String, CodingKey { case kind, text, oldLine, newLine, anchor }

    init(kind: GitRowKind, text: String, oldLine: Int? = nil, newLine: Int? = nil, anchor: GitAnchor? = nil) {
        self.kind = kind
        self.text = text
        self.oldLine = oldLine
        self.newLine = newLine
        self.anchor = anchor
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = GitRowKind(wire: c.lenientString(.kind))
        text = c.lenientString(.text) ?? ""
        oldLine = c.lenientInt(.oldLine)
        newLine = c.lenientInt(.newLine)
        anchor = (try? c.decodeIfPresent(GitAnchor.self, forKey: .anchor)) ?? nil
    }
}

struct GitDiffFile: Decodable, Equatable, Sendable {
    var path: String
    var added: Int
    var removed: Int
    var rowCount: Int
    /// Too large to ship: `rows` is empty; the screen offers GitHub instead.
    var truncated: Bool
    var rows: [GitDiffRow]

    private enum CodingKeys: String, CodingKey { case path, added, removed, rowCount, truncated, rows }

    init(path: String, added: Int = 0, removed: Int = 0, rowCount: Int = 0, truncated: Bool = false, rows: [GitDiffRow] = []) {
        self.path = path
        self.added = added
        self.removed = removed
        self.rowCount = rowCount
        self.truncated = truncated
        self.rows = rows
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        added = c.lenientInt(.added) ?? 0
        removed = c.lenientInt(.removed) ?? 0
        rows = c.lossyList(GitDiffRow.self, forKey: .rows)
        rowCount = c.lenientInt(.rowCount) ?? rows.count
        truncated = c.lenientBool(.truncated) ?? false
    }
}

struct GitThreadComment: Decodable, Equatable, Sendable {
    var author: String
    var body: String
    /// ISO-8601 from the forge, when present.
    var createdAt: String?

    private enum CodingKeys: String, CodingKey { case author, body, createdAt }

    init(author: String, body: String, createdAt: String? = nil) {
        self.author = author
        self.body = body
        self.createdAt = createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        author = c.lenientString(.author) ?? ""
        body = c.lenientString(.body) ?? ""
        createdAt = c.lenientString(.createdAt)
    }
}

struct GitThread: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var path: String?
    var line: Int?
    var side: String?
    var resolved: Bool
    var comments: [GitThreadComment]
    var placement: GitPlacement

    private enum CodingKeys: String, CodingKey { case id, path, line, side, resolved, comments, placement }

    init(id: String, path: String? = nil, line: Int? = nil, side: String? = nil, resolved: Bool = false,
         comments: [GitThreadComment] = [], placement: GitPlacement = .unplaced) {
        self.id = id
        self.path = path
        self.line = line
        self.side = side
        self.resolved = resolved
        self.comments = comments
        self.placement = placement
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        path = c.lenientString(.path)
        line = c.lenientInt(.line)
        side = c.lenientString(.side)
        resolved = c.lenientBool(.resolved) ?? false
        comments = c.lossyList(GitThreadComment.self, forKey: .comments)
        placement = ((try? c.decodeIfPresent(GitPlacement.self, forKey: .placement)) ?? nil) ?? .unplaced
    }

    /// "alice" or "alice · resolved".
    var attribution: String {
        let first = comments.first?.author ?? ""
        let name = first.isEmpty ? "Thread" : first
        return resolved ? "\(name) · resolved" : name
    }
}

struct GitDraftComment: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var path: String
    var line: Int
    /// "new" | "old" | "both".
    var side: String
    var body: String
    /// Set by `forge:diff`; a draft-mutation response carries none (the client
    /// reconciles by id, `ReviewDraftMerge`).
    var placement: GitPlacement?

    private enum CodingKeys: String, CodingKey { case id, path, line, side, body, placement }

    init(id: String, path: String, line: Int, side: String = "new", body: String, placement: GitPlacement? = nil) {
        self.id = id
        self.path = path
        self.line = line
        self.side = side
        self.body = body
        self.placement = placement
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        path = c.lenientString(.path) ?? ""
        line = c.lenientInt(.line) ?? 0
        side = c.lenientString(.side) ?? "new"
        body = c.lenientString(.body) ?? ""
        placement = (try? c.decodeIfPresent(GitPlacement.self, forKey: .placement)) ?? nil
    }
}

/// The box-buffered draft review. After the client reconciles a mutation, every
/// comment carries a placement (`GitPlacedDraft`).
struct GitDraft: Decodable, Equatable, Sendable {
    var headSha: String
    var verdict: GitVerdict?
    var body: String
    var comments: [GitDraftComment]
    /// The branch moved since the comments were written: kept, but warn.
    var stale: Bool
    var updatedAt: Double?

    private enum CodingKeys: String, CodingKey { case headSha, verdict, body, comments, stale, updatedAt }

    init(headSha: String = "", verdict: GitVerdict? = nil, body: String = "", comments: [GitDraftComment] = [],
         stale: Bool = false, updatedAt: Double? = nil) {
        self.headSha = headSha
        self.verdict = verdict
        self.body = body
        self.comments = comments
        self.stale = stale
        self.updatedAt = updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        headSha = c.lenientString(.headSha) ?? ""
        verdict = c.lenientString(.verdict).flatMap(GitVerdict.init(rawValue:))
        body = c.lenientString(.body) ?? ""
        comments = c.lossyList(GitDraftComment.self, forKey: .comments)
        stale = c.lenientBool(.stale) ?? false
        updatedAt = c.lenientDouble(.updatedAt)
    }
}

typealias GitPlacedDraft = GitDraft

/// `forge:diff` — diff rows, placed threads, the reconciled draft, in one call.
struct GitDiffResult: Decodable, Equatable, Sendable {
    /// nil = the box predates the structured diff (`forge-diff-view-1`).
    var files: [GitDiffFile]?
    var threads: [GitThread]
    var draft: GitPlacedDraft?
    var headSha: String
    var stale: Bool
    /// "no_forge" | "not_connected" | "no_pr" | nil.
    var error: String?
    /// The box's plain-language message for `error` / `parseFailed`.
    var message: String?
    /// The forge fetch worked but its diff text could not be read.
    var parseFailed: Bool

    private enum CodingKeys: String, CodingKey {
        case files, threads, draft, headSha, stale, error, message, parseFailed
    }

    /// The forge was rate-limited: a stale answer with no files and no error. A
    /// screen that already shows the diff keeps it (and the user's unpublished
    /// comments) and only marks it stale.
    var isRateLimitedEmpty: Bool {
        error == nil && stale && !parseFailed && (files?.isEmpty ?? false)
    }

    init(files: [GitDiffFile]?, threads: [GitThread] = [], draft: GitPlacedDraft? = nil, headSha: String = "",
         stale: Bool = false, error: String? = nil, message: String? = nil, parseFailed: Bool = false) {
        self.files = files
        self.threads = threads
        self.draft = draft
        self.headSha = headSha
        self.stale = stale
        self.error = error
        self.message = message
        self.parseFailed = parseFailed
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        files = c.lossyListIfPresent(GitDiffFile.self, forKey: .files)
        threads = c.lossyList(GitThread.self, forKey: .threads)
        draft = (try? c.decodeIfPresent(GitDraft.self, forKey: .draft)) ?? nil
        headSha = c.lenientString(.headSha) ?? ""
        stale = c.lenientBool(.stale) ?? false
        error = c.lenientString(.error)
        message = c.lenientString(.message)
        parseFailed = c.lenientBool(.parseFailed) ?? false
    }
}

// MARK: - Review: draft mutations

enum GitDraftOp: Equatable, Sendable {
    case add(path: String, line: Int, side: String, body: String)
    case delete(id: String)
    case setVerdict(GitVerdict?)

    /// The `forge:draft-comment` payload fields beside the ref.
    var json: [String: Any] {
        switch self {
        case .add(let path, let line, let side, let body):
            return ["op": "add", "comment": ["path": path, "line": line, "side": side, "body": body] as [String: Any]]
        case .delete(let id):
            return ["op": "delete", "comment": ["id": id]]
        case .setVerdict(let verdict):
            return ["op": "set-verdict", "verdict": verdict?.rawValue ?? NSNull()]
        }
    }
}

/// `forge:draft-comment`. `ok` with a nil draft = the draft no longer exists
/// (already submitted or cleared elsewhere).
enum GitDraftCommentResult: Decodable, Equatable, Sendable {
    case ok(GitDraft?)
    case failed(GitFailure)

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: WireKey.self)
        guard gitOk(c) else {
            self = .failed(GitFailure(from: c))
            return
        }
        let draft = (try? c.decodeIfPresent(GitDraft.self, forKey: .draft)) ?? nil
        self = .ok(draft)
    }
}

/// `forge:draft-submit`.
enum GitDraftSubmitResult: Decodable, Equatable, Sendable {
    case ok
    case failed(GitFailure)

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: WireKey.self)
        self = gitOk(c) ? .ok : .failed(GitFailure(from: c))
    }
}

/// `forge:thread-reply`.
enum GitThreadReplyResult: Decodable, Equatable, Sendable {
    case ok
    case failed(GitFailure)

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: WireKey.self)
        self = gitOk(c) ? .ok : .failed(GitFailure(from: c))
    }
}

// MARK: - Draft placement after a mutation (one rule, both clients)

enum ReviewDraftMerge {
    /// A mutation returns the raw draft with no placement. Reconcile by comment
    /// id only — never re-derive a placement from an anchor:
    ///  1. ids present before keep their previous placement;
    ///  2. the one new id of an `add` gets the row the user tapped;
    ///  3. ids no longer present are gone;
    ///  4. anything else (more than one unknown id, a new id with no tap, or a
    ///     changed head / stale flag) keeps what is known and asks for a refetch;
    ///  5. a nil response (the draft is gone) clears it — no refetch.
    /// verdict, body, stale and updatedAt always come from the response.
    static func merge(previous: GitPlacedDraft?, response: GitDraft?, tapped: GitPlacement?)
        -> (draft: GitPlacedDraft?, needsRefetch: Bool) {
        guard var next = response else { return (nil, false) }
        var knownPlacements: [String: GitPlacement] = [:]
        for comment in previous?.comments ?? [] where knownPlacements[comment.id] == nil {
            knownPlacements[comment.id] = comment.placement ?? .unplaced
        }
        let unknownIDs = next.comments.map(\.id).filter { knownPlacements[$0] == nil }
        var needsRefetch = false
        if let previous, previous.headSha != next.headSha || previous.stale != next.stale {
            needsRefetch = true
        }
        if unknownIDs.count > 1 || (unknownIDs.count == 1 && tapped == nil) {
            needsRefetch = true
        }
        next.comments = next.comments.map { comment in
            var placed = comment
            if let existing = knownPlacements[comment.id] {
                placed.placement = existing
            } else if unknownIDs.count == 1, let tapped {
                placed.placement = tapped
            } else {
                placed.placement = comment.placement ?? .unplaced
            }
            return placed
        }
        return (next, needsRefetch)
    }
}

// MARK: - Review: where each note renders

/// Notes grouped by where the box placed them, so the screen looks each one up in
/// O(1) instead of scanning per row.
struct ReviewNoteIndex: Equatable, Sendable {
    var unplacedThreads: [GitThread] = []
    var unplacedDrafts: [GitDraftComment] = []
    var fileThreads: [Int: [GitThread]] = [:]
    var fileDrafts: [Int: [GitDraftComment]] = [:]
    /// Keyed by `ReviewNoteIndex.rowID(file:row:)`.
    var rowThreads: [String: [GitThread]] = [:]
    var rowDrafts: [String: [GitDraftComment]] = [:]

    /// The deterministic row id.
    static func rowID(file: Int, row: Int) -> String { "\(file):\(row)" }

    init(threads: [GitThread], draft: GitPlacedDraft?) {
        for thread in threads {
            switch thread.placement {
            case .unplaced: unplacedThreads.append(thread)
            case .file(let file): fileThreads[file, default: []].append(thread)
            case .row(let file, let row): rowThreads[Self.rowID(file: file, row: row), default: []].append(thread)
            }
        }
        for comment in draft?.comments ?? [] {
            switch comment.placement ?? .unplaced {
            case .unplaced: unplacedDrafts.append(comment)
            case .file(let file): fileDrafts[file, default: []].append(comment)
            case .row(let file, let row): rowDrafts[Self.rowID(file: file, row: row), default: []].append(comment)
            }
        }
    }

    var hasUnplaced: Bool { !unplacedThreads.isEmpty || !unplacedDrafts.isEmpty }
}

// MARK: - Review copy

enum ReviewCopy {
    /// "1 comment" / "N comments" — the plural is client formatting.
    static func pendingLabel(_ count: Int) -> String {
        count == 1 ? "1 comment" : "\(count) comments"
    }

    static let staleDraftWarning =
        "The branch moved since you wrote these comments — the line anchors may be out of date. Your comments are kept; review them before submitting."
    static let parseFailedTitle = "Couldn't read this diff."
    static let updateBoxForPullRequests = "Update your box to see pull requests and checks here."
    static let updateBoxForReview = "Update your box to review pull requests here."
}
