import Foundation

// ===========================================================================
// WS08 — the pure half of the sign-in flows (add a seat, re-sign a seat, and
// the sign-in half of connecting a subscription): the connect shape the box
// answers, the Claude sign-in link finder, the clock, the attempt bookkeeping
// that makes every failure / retry / cancel release exactly what it allocated,
// and every sentence the flows speak.
//
// Foundation-only (compiled by the Linux SwiftPM package) so the decisions are
// unit-tested without a box. The controllers that run them are
// `AccountsSignInFlow.swift` / `ProviderConnectFlow.swift`.
// ===========================================================================

// MARK: - Connect shape

/// The `connect` object `accounts:add-seat`, `accounts:resign-seat` and
/// `opencode:provider-auth {action:"start"}` all answer (`SeatConnect` /
/// `OpencodeProviderAuthResult`'s start branch on the box):
/// `{ shape, url?, instructions?, methodIndex?, sessionKey?, startedAt?, cwd? }`.
struct SignInConnect: Equatable, Sendable {
    enum Shape: Equatable, Sendable {
        case claudeLogin
        case oauthAuto
        case oauthCode
        case apiKey
        case other(String)

        init(wire: String) {
            switch wire {
            case "claude-login": self = .claudeLogin
            case "oauth-auto": self = .oauthAuto
            case "oauth-code": self = .oauthCode
            case "api-key": self = .apiKey
            default: self = .other(wire)
            }
        }
    }

    var shape: Shape
    var url: String? = nil
    var instructions: String? = nil
    var methodIndex: Int? = nil
    var sessionKey: String? = nil
    var startedAt: Double? = nil
    var cwd: String? = nil

    init(shape: Shape, url: String? = nil, instructions: String? = nil, methodIndex: Int? = nil,
         sessionKey: String? = nil, startedAt: Double? = nil, cwd: String? = nil) {
        self.shape = shape
        self.url = url
        self.instructions = instructions
        self.methodIndex = methodIndex
        self.sessionKey = sessionKey
        self.startedAt = startedAt
        self.cwd = cwd
    }

    /// Read a connect object off the wire. nil when it is not an object or has
    /// no `shape` — the caller cannot drive a sign-in it cannot name.
    init?(json: JSONValue?) {
        guard case .object(let object)? = json,
              case .string(let rawShape)? = object["shape"], !rawShape.isEmpty else { return nil }
        func text(_ key: String) -> String? {
            if case .string(let s)? = object[key] { return s }
            return nil
        }
        var methodIndex: Int?
        if case .number(let n)? = object["methodIndex"], n.isFinite, let whole = Int(exactly: n) { methodIndex = whole }
        var startedAt: Double?
        if case .number(let n)? = object["startedAt"], n.isFinite { startedAt = n }
        self.init(
            shape: Shape(wire: rawShape),
            url: text("url"),
            instructions: text("instructions"),
            methodIndex: methodIndex,
            sessionKey: text("sessionKey"),
            startedAt: startedAt,
            cwd: text("cwd")
        )
    }
}

extension SignInConnect: Decodable {
    init(from decoder: Decoder) throws {
        let value = try JSONValue(from: decoder)
        guard let connect = SignInConnect(json: value) else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "not a connect shape")
            )
        }
        self = connect
    }
}

/// What a driveable sign-in looks like (port of `signInFromConnect`).
enum SignInPhase: Equatable, Sendable {
    /// Claude: a terminal on the box prints a link; the user pastes a code back.
    case claude(sessionKey: String, cwd: String)
    /// OAuth device flow: a link + a code, approved in the browser.
    case device(url: String, instructions: String)

    /// nil = a shape this client cannot drive (the half-made seat / flow is
    /// then cancelled by the caller).
    static func from(_ connect: SignInConnect) -> SignInPhase? {
        switch connect.shape {
        case .claudeLogin:
            guard let key = connect.sessionKey, !key.isEmpty else { return nil }
            let cwd = (connect.cwd?.isEmpty == false) ? (connect.cwd ?? "~") : "~"
            return .claude(sessionKey: key, cwd: cwd)
        case .oauthAuto:
            return .device(url: connect.url ?? "", instructions: connect.instructions ?? "")
        case .oauthCode, .apiKey, .other:
            return nil
        }
    }
}

// MARK: - Claude sign-in link

/// Finds the OAuth link `claude auth login` prints into its pty.
enum ClaudeLoginURL {
    static let prefix = "https://claude.com/cai/oauth/authorize?"
    /// The accumulated pty output is capped; the tail is what matters.
    static let bufferLimit = 64 * 1024

    /// The first COMPLETE link in `buffer`. A match counts only when a
    /// terminator (whitespace, BEL, ESC) follows it inside the buffer, so a
    /// link split across two chunks is never taken half-read. Trailing
    /// `)].,;` are stripped.
    static func extract(from buffer: String) -> URL? {
        let scalars = buffer.unicodeScalars
        var from = buffer.startIndex
        while from < buffer.endIndex, let found = buffer.range(of: prefix, range: from..<buffer.endIndex) {
            var cursor = found.upperBound
            var terminated = false
            while cursor < scalars.endIndex {
                if isTerminator(scalars[cursor]) {
                    terminated = true
                    break
                }
                cursor = scalars.index(after: cursor)
            }
            guard terminated else { return nil }
            var candidate = String(scalars[found.lowerBound..<cursor])
            while let last = candidate.unicodeScalars.last, ")].,;".unicodeScalars.contains(last) {
                candidate.unicodeScalars.removeLast()
            }
            if candidate.count > prefix.count, let url = URL(string: candidate) { return url }
            from = cursor
        }
        return nil
    }

    /// `buffer + chunk`, keeping only the last `bufferLimit` characters.
    static func appending(_ buffer: String, _ chunk: String) -> String {
        let joined = buffer + chunk
        let scalars = joined.unicodeScalars
        guard scalars.count > bufferLimit else { return joined }
        return String(String.UnicodeScalarView(scalars.suffix(bufferLimit)))
    }

    private static func isTerminator(_ scalar: Unicode.Scalar) -> Bool {
        scalar.value == 0x07 || scalar.value == 0x1B || CharacterSet.whitespacesAndNewlines.contains(scalar)
    }
}

// MARK: - Clock

/// Wall-clock deadlines. The user leaves the app to sign in, so the app is
/// suspended mid-flow: every limit is compared against a `Date` captured when
/// the flow started, never against accumulated timer ticks.
enum SignInClock {
    /// How long the box waits for a sign-in (`LOGIN_TIMEOUT_MS`).
    static let serverLoginLimit: TimeInterval = 15 * 60
    /// A flow gives up only AFTER the box would have, plus slack for the two
    /// clocks starting at slightly different moments.
    static let clientLimit: TimeInterval = serverLoginLimit + 30
    static let seatPollInterval: Duration = .seconds(2)
    /// No Claude link within this long: the attempt is torn down and offered again.
    static let linkTimeout: TimeInterval = 20

    static func isExpired(startedAt: Date, now: Date, limit: TimeInterval) -> Bool {
        let elapsed = now.timeIntervalSince(startedAt)
        guard elapsed.isFinite, limit.isFinite else { return false }
        return elapsed >= limit
    }
}

// MARK: - Attempts and teardown

/// One call that releases something an attempt allocated on the box.
enum TeardownStep: Equatable, Sendable {
    /// `accounts:cancel-seat` (the box also kills the seat's Claude pty).
    case cancelSeat(String)
    /// `accounts:resign-cancel`.
    case resignCancel(String)
    /// `opencode:provider-auth oauth-cancel` — provider-wide, so it is only
    /// ever sent through `ProviderOAuthLease`.
    case oauthCancel(provider: String)
    /// `pty:kill`.
    case ptyKill(String)
    /// `claude:login-cancel` (drops the box's record of a Claude login).
    case claudeLoginCancel(String)
}

/// Everything one start of a sign-in allocated on the box, recorded as soon as
/// the reply that allocates it arrives. Every Try again makes a NEW attempt.
struct SignInAttempt: Equatable, Sendable {
    let id: UUID
    /// F1: from `accounts:add-seat`.
    var seatId: String?
    /// F2: from `accounts:resign-seat`.
    var flowId: String?
    /// Claude: the registered `claude-login-…` key.
    var loginSessionKey: String?
    /// `pty:spawn` for `loginSessionKey` was sent.
    var loginSpawned: Bool
    /// F3: the `claude-install-…` pty.
    var installerKey: String?
    /// F3: a device wait is in progress for this opencode provider id.
    var oauthProviderId: String?
    /// F1: a different-org login the box holds, awaiting the user's choice.
    var parked: Bool

    init(id: UUID = UUID(), seatId: String? = nil, flowId: String? = nil, loginSessionKey: String? = nil,
         loginSpawned: Bool = false, installerKey: String? = nil, oauthProviderId: String? = nil,
         parked: Bool = false) {
        self.id = id
        self.seatId = seatId
        self.flowId = flowId
        self.loginSessionKey = loginSessionKey
        self.loginSpawned = loginSpawned
        self.installerKey = installerKey
        self.oauthProviderId = oauthProviderId
        self.parked = parked
    }

    /// The calls, in order, that release whatever this attempt allocated. All
    /// are idempotent on the box (an unknown seat / flow / pty / key is a
    /// no-op), so teardown always runs the whole plan.
    func teardownPlan() -> [TeardownStep] {
        var steps: [TeardownStep] = []
        if let seatId { steps.append(.cancelSeat(seatId)) }
        if let flowId { steps.append(.resignCancel(flowId)) }
        if let oauthProviderId { steps.append(.oauthCancel(provider: oauthProviderId)) }
        if let installerKey { steps.append(.ptyKill(installerKey)) }
        // A seat / flow cancel already drops its own Claude login on the box;
        // only a bare login (the connect flow) is released here — including
        // during the install phase, where the registration exists but was
        // never spawned.
        if seatId == nil, flowId == nil, let loginSessionKey {
            if loginSpawned { steps.append(.ptyKill(loginSessionKey)) }
            steps.append(.claudeLoginCancel(loginSessionKey))
        }
        return steps
    }
}

/// Whether an async result still belongs to the attempt on screen. Every
/// continuation (start reply, poll reply, pty event, submit) asks before it
/// touches state.
enum SignInAttemptGate {
    enum StartReplyRoute: Equatable, Sendable {
        /// The attempt is still current — use the reply.
        case use
        /// The attempt was cancelled or retired while the start was in flight:
        /// release what the reply allocated straight away, never show it.
        case tearDownOneOff
    }

    static func accepts(resultFor attempt: UUID, current: UUID?) -> Bool {
        current == attempt
    }

    static func routeStartReply(attempt: UUID, current: UUID?) -> StartReplyRoute {
        accepts(resultFor: attempt, current: current) ? .use : .tearDownOneOff
    }

    /// A pty event belongs to the attempt only if it came from ITS login key.
    static func accepts(ptyEventKey: String, attemptKey: String?) -> Bool {
        guard let attemptKey, !attemptKey.isEmpty else { return false }
        return ptyEventKey == attemptKey
    }
}

// MARK: - Poll decisions (F1 / F2)

/// What a `accounts:seat-status` reading means (port of AddSeatFlow's poll).
enum SeatPollOutcome: Equatable, Sendable {
    case keepPolling
    /// Past the client limit and the box has nothing: abandon (cancel the seat).
    case abandon(unreachable: Bool)
    case added(AccountsSeat?)
    case differentOrg(orgName: String?)
    /// The box's sentence (nil on an older box).
    case failed(message: String?)
}

enum ResignPollOutcome: Equatable, Sendable {
    case keepPolling
    case abandon(unreachable: Bool)
    case signedBack(AccountsSeat?)
    case failed(message: String?)
}

enum SignInPollRules {
    /// `reply == nil` means the status call failed (box unreachable). While the
    /// client limit has not been reached a failed or pending reading just
    /// keeps polling; at the limit the box is asked one last time (this is
    /// that reading) before the flow gives up.
    static func decideSeat(reply: SeatStatusReply?, expired: Bool) -> SeatPollOutcome {
        guard let reply, reply.state != .pending else {
            return expired ? .abandon(unreachable: reply == nil) : .keepPolling
        }
        switch reply.state {
        case .ok:
            return .added(reply.seat)
        case .failed:
            if reply.error == "different-org" { return .differentOrg(orgName: reply.orgName) }
            return .failed(message: reply.message)
        case .pending:
            return .keepPolling
        }
    }

    static func decideResign(reply: ResignStatusReply?, expired: Bool) -> ResignPollOutcome {
        guard let reply, reply.state != .pending else {
            return expired ? .abandon(unreachable: reply == nil) : .keepPolling
        }
        switch reply.state {
        case .ok:
            return .signedBack(reply.seat)
        case .failed:
            return .failed(message: reply.message)
        case .pending:
            return .keepPolling
        }
    }
}

// MARK: - Rules

enum AccountsSignInRules {
    /// The terms note shows before a second ACCOUNT (not a seat of an existing
    /// account) is added, until the device acknowledged it once.
    static func needsTosNote(accountCount: Int, acknowledged: Bool, addingAccount: Bool) -> Bool {
        addingAccount && !acknowledged && accountCount >= 1
    }

    /// What to say on a broken seat the box refuses to re-sign because it is
    /// the box's own live login. Only names a path the box will accept.
    /// `managedBy` is the status row's owner ("the Claude CLI on this box")
    /// when the credential is managed outside Manta, else nil.
    static func liveSeatAdvice(provider: AccountsProvider, seat: AccountsSeat, managedBy: String?) -> String {
        let name = AccountsSelectors.providerName(provider.provider)
        if let replacement = AccountsSelectors.liveSeatReplacement(provider, removing: seat.id) {
            let label = replacement.label.isEmpty ? "another seat" : "“\(replacement.label)”"
            return "This is the box's own login. Remove it — the box switches to \(label) first — then sign it in again with Add \(name) account."
        }
        if AccountsSelectors.seatCount(provider) >= 2 {
            return "This is the box's own login and no other login is ready to take over. Sign in another account with Add \(name) account first; then this seat can be removed and added again."
        }
        if let managedBy, !managedBy.isEmpty {
            return "This login belongs to \(managedBy), so it has to be signed in again there — open a terminal session and run “claude auth login”. That isn't available from this screen."
        }
        return "This is the box's only \(name) login, and signing it in again isn't available from this screen yet."
    }
}

// MARK: - Copy

/// Where a seat landed, read from the refreshed list.
struct SignInSeatLocation: Equatable, Sendable {
    var seatLabel: String
    var accountLabel: String
    var email: String?

    static func find(seatId: String, provider: String, in providers: [AccountsProvider]) -> SignInSeatLocation? {
        guard let view = providers.first(where: { $0.provider == provider }),
              let seat = AccountsSelectors.seat(seatId, in: view) else { return nil }
        let account = AccountsSelectors.account(containing: seatId, in: view)
        return SignInSeatLocation(seatLabel: seat.label, accountLabel: account?.label ?? "", email: seat.email)
    }
}

enum AccountsSignInCopy {
    static let termsNote = "Rotating several personal subscriptions to get around one plan's limits may breach the provider's terms. Team and Enterprise seats are each licensed to a person."
    static let termsAcknowledge = "I understand"

    static let startUnreachable = "Couldn't reach the server. Try again."
    static let unreachableAtDeadline = "Couldn't reach the server to check the sign-in. If you finished it, the seat will appear in the list once the box is reachable."
    static let badCode = "That code didn't work (it may have expired). Start the sign-in again."
    static let cantStartFromHere = "This provider's sign-in can't be started from here yet."
    static let cancelFailed = "Couldn't cancel the sign-in on the server — it will expire by itself."
    static let noEventStream = "Can't show the Claude sign-in link right now — reconnect and try again."
    static let signInExpired = "This sign-in has expired. Start again."
    static let linkDidNotAppear = "The sign-in link didn't appear. Start again."
    static let writeFailed = "Couldn't reach the server. Try again."
    static let liveSeatRace = "This is the box's own login, so it can't be signed in again from here."
    static let createAccountFailed = "Couldn't create the account — the server didn't answer. Try again."

    static func differentOrgPrompt(orgName: String?, accountLabel: String?) -> String {
        let org = (orgName?.isEmpty == false) ? " (\(orgName ?? ""))" : ""
        let target = (accountLabel?.isEmpty == false) ? "“\(accountLabel ?? "")”" : "this account"
        return "That sign-in belongs to a different organization\(org), so it can't join \(target). Create a new account for it?"
    }

    static func addTitle(providerLabel: String, accountLabel: String?, addingToAccount: Bool) -> String {
        addingToAccount ? "Add a seat to \((accountLabel?.isEmpty == false) ? (accountLabel ?? "") : "this account")" : "Add a \(providerLabel) account"
    }

    /// "Added Seat 2 to Work." / "Added the account “Work” — x@y is signed in." /
    /// "Added <name> to Claude."
    static func addedMessage(addingToAccount: Bool, found: SignInSeatLocation?, fallbackLabel: String, providerLabel: String) -> String {
        if addingToAccount {
            let seat = (found?.seatLabel.isEmpty == false) ? (found?.seatLabel ?? "") : fallbackLabel
            let account = (found?.accountLabel.isEmpty == false) ? (found?.accountLabel ?? "") : providerLabel
            return "Added \(seat) to \(account)."
        }
        if let found {
            let who = (found.email?.isEmpty == false) ? (found.email ?? "") : found.seatLabel
            return "Added the account “\(found.accountLabel)” — \(who) is signed in."
        }
        return "Added \(fallbackLabel) to \(providerLabel)."
    }

    // MARK: Re-sign

    static func resignTitle(seatLabel: String) -> String { "Sign \(seatLabel) back in" }

    static func resignLead(seatLabel: String, email: String?) -> String {
        "Sign in with \((email?.isEmpty == false) ? (email ?? "") : "this seat's account"). \(seatLabel) stays as it is until the sign-in is confirmed to be the same account."
    }

    static func resignUnreachable(seatLabel: String) -> String {
        "Couldn't reach the server to check the sign-in. \(seatLabel) was not changed — try again once the box is reachable."
    }

    static func resignBadCode(seatLabel: String) -> String {
        "That code didn't work (it may have expired). \(seatLabel) was not changed — start the sign-in again."
    }

    static func resignDone(email: String?, seatLabel: String) -> String {
        if let email = nonEmpty(email) { return "Signed back in as \(email)" }
        return "\(seatLabel) is signed back in"
    }

    static func resignCancelled(seatLabel: String) -> String { "Sign-in cancelled — \(seatLabel) was not changed." }

    static func resignCancelFailed(seatLabel: String) -> String { "\(cancelFailed) \(seatLabel) was not changed." }

    /// Why starting a sign-in failed. `resign` adds the live-seat race mapping
    /// (whose general text is about removal, so it is not in `AccountsCopy`).
    static func startFailure(_ error: Error, resign: Bool) -> String {
        if resign, let refusal = error as? AccountsRefusal, refusal.code == "live-seat" { return liveSeatRace }
        if let manta = error as? MantaError {
            switch manta {
            case .transport:
                return startUnreachable
            default:
                break
            }
        }
        return AccountsCopy.failure("start the sign-in", error)
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }
}

// MARK: - Device code (Codex)

enum DeviceCode {
    /// The code in a device-flow instruction sentence ("… enter code: ABCD-1234").
    static func parse(_ instructions: String) -> String? {
        guard !instructions.isEmpty,
              let regex = try? NSRegularExpression(pattern: #"\bcode[:\s]+([A-Z0-9]+-[A-Z0-9]+)"#, options: [.caseInsensitive]) else { return nil }
        let whole = NSRange(instructions.startIndex..., in: instructions)
        guard let match = regex.firstMatch(in: instructions, options: [], range: whole), match.numberOfRanges > 1,
              let range = Range(match.range(at: 1), in: instructions) else { return nil }
        return String(instructions[range])
    }

    /// When no code could be parsed but the provider sent a sentence, point the
    /// user at it instead of showing an empty code slot.
    static func fallback(_ instructions: String) -> String? {
        if parse(instructions) != nil { return nil }
        if !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "The code is in the message below — copy it from there."
        }
        return nil
    }
}

/// "M:SS remaining", clamped at 0 and NaN-safe.
func formatRemaining(startedAt: Date, now: Date, limit: TimeInterval) -> String {
    let elapsed = now.timeIntervalSince(startedAt)
    guard elapsed.isFinite, limit.isFinite else { return "0:00 remaining" }
    let seconds = max(0, (limit - elapsed).rounded(.up))
    let whole = Int(seconds)
    return "\(whole / 60):\(String(format: "%02d", whole % 60)) remaining"
}
