import Foundation

// ===========================================================================
// Multi-account & seats, phase 3 — wire DTOs + the pure decisions behind the
// Accounts screen and the usage sheet.
//
// Mirrors the `accounts:*` contract in
// docs/superpowers/specs/2026-10-08-multi-account-subscriptions-design.md §8
// ("Contract v2"). The box is the authority on every decision that matters (the
// seat load, which seat is "next", where a conversation lives); this file only
// DECODES what the box says and picks what to show. It holds no I/O, so it is
// Foundation-only and unit-testable with plain values (see `AccountsTests`).
//
// DECODING IS TOLERANT ON PURPOSE. A newer box may add keys, an older one may
// omit optional ones, and one malformed seat must never blank the whole list:
// every collection is a `LenientArray`, every optional field decodes with
// `try?`, and only the identity of a record (its id) is required. A missing
// value renders nothing or a neutral default — never a confident number.
// ===========================================================================

// MARK: - Lenient collection

/// Decodes an array and SKIPS a record that will not decode instead of failing
/// the whole list (the same stepping-over trick as `LenientDelegateJobs`): an
/// unkeyed container's index only advances on a SUCCESSFUL decode, so a
/// throwing element is consumed by decoding it as an empty `Skip`.
struct LenientArray<Element: Decodable>: Decodable {
    let elements: [Element]

    private struct Skip: Decodable {}

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var out: [Element] = []
        while !container.isAtEnd {
            if let element = try? container.decode(Element.self) {
                out.append(element)
                continue
            }
            // If even the skip fails the container did not advance — stop
            // rather than spin.
            do { _ = try container.decode(Skip.self) } catch { break }
        }
        elements = out
    }
}

// MARK: - Seat / account / provider views (accounts:list)

/// A seat's sign-in state. Unknown strings decode to `.unknown` — a state the
/// client does not understand is neither "ok" nor "needs fixing".
enum SeatStatus: String, Equatable, Sendable {
    case ok
    case expired
    case signedOut = "signed-out"
    case unknown
}

/// Per-provider seat routing mode. Anything unrecognised decodes to `.manual`:
/// the mode that makes no claim about automatic moves.
enum AccountsMode: String, Equatable, Sendable {
    case auto
    case manual
}

/// `SeatView` in the contract.
struct AccountsSeat: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var label: String = ""
    var email: String? = nil
    var status: SeatStatus = .unknown
    /// This seat is the box's current (live) login.
    var live: Bool = false
    /// Latest per-seat reading; `[]` when there is none yet.
    var windows: [UsageWindow] = []
    /// The box's `seatLoad()` — the higher of the 5h and weekly percentages.
    var load: Double? = nil
    var fetchedAt: Double? = nil
    /// Conversations currently assigned to this seat.
    var conversations: Int = 0
}

extension AccountsSeat {
    private enum CodingKeys: String, CodingKey {
        case id, label, email, status, live, windows, load, fetchedAt, conversations
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? ""
        email = try? c.decodeIfPresent(String.self, forKey: .email)
        let rawStatus = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? nil
        status = rawStatus.flatMap(SeatStatus.init(rawValue:)) ?? .unknown
        live = (try? c.decodeIfPresent(Bool.self, forKey: .live)) ?? false
        windows = (try? c.decodeIfPresent(LenientArray<UsageWindow>.self, forKey: .windows))?.elements ?? []
        load = try? c.decodeIfPresent(Double.self, forKey: .load)
        fetchedAt = try? c.decodeIfPresent(Double.self, forKey: .fetchedAt)
        conversations = Self.count(c, .conversations)
    }

    /// An integer count that tolerates the box sending a whole double.
    private static func count(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> Int {
        if let n = (try? c.decodeIfPresent(Int.self, forKey: key)) ?? nil { return max(0, n) }
        if let d = (try? c.decodeIfPresent(Double.self, forKey: key)) ?? nil, d.isFinite { return max(0, Int(d)) }
        return 0
    }
}

/// `AccountView` in the contract. Seats of one org are grouped into one account.
struct AccountsAccount: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var label: String = ""
    var orgName: String? = nil
    var plan: String? = nil
    var seats: [AccountsSeat] = []
}

extension AccountsAccount {
    private enum CodingKeys: String, CodingKey { case id, label, orgName, plan, seats }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? ""
        orgName = try? c.decodeIfPresent(String.self, forKey: .orgName)
        plan = try? c.decodeIfPresent(String.self, forKey: .plan)
        seats = (try? c.decodeIfPresent(LenientArray<AccountsSeat>.self, forKey: .seats))?.elements ?? []
    }
}

/// `ProviderView` in the contract. Named `AccountsProvider` here so it cannot
/// be mistaken for an opencode model provider.
struct AccountsProvider: Decodable, Equatable, Sendable, Identifiable {
    /// "claude" | "codex" (open set — rendered through `UsageMeters.providerLabel`).
    var provider: String
    var mode: AccountsMode = .manual
    var activeSeatId: String? = nil
    /// The per-conversation routing plugin has been seen by the box. Until it
    /// has, the mode has no effect yet.
    var routingActive: Bool = false
    /// Automatic mode: the seat a new conversation / a move goes to.
    var nextSeatId: String? = nil
    var accounts: [AccountsAccount] = []

    var id: String { provider }
}

extension AccountsProvider {
    private enum CodingKeys: String, CodingKey {
        case provider, mode, activeSeatId, routingActive, nextSeatId, accounts
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = try c.decode(String.self, forKey: .provider)
        let rawMode = (try? c.decodeIfPresent(String.self, forKey: .mode)) ?? nil
        mode = rawMode.flatMap(AccountsMode.init(rawValue:)) ?? .manual
        activeSeatId = try? c.decodeIfPresent(String.self, forKey: .activeSeatId)
        routingActive = (try? c.decodeIfPresent(Bool.self, forKey: .routingActive)) ?? false
        nextSeatId = try? c.decodeIfPresent(String.self, forKey: .nextSeatId)
        accounts = (try? c.decodeIfPresent(LenientArray<AccountsAccount>.self, forKey: .accounts))?.elements ?? []
    }
}

/// `accounts:list` reply: `{ providers: ProviderView[] }`.
struct AccountsListReply: Decodable, Equatable, Sendable {
    var providers: [AccountsProvider] = []

    private enum CodingKeys: String, CodingKey { case providers }

    init(providers: [AccountsProvider] = []) { self.providers = providers }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        providers = (try? c.decodeIfPresent(LenientArray<AccountsProvider>.self, forKey: .providers))?.elements ?? []
    }
}

// MARK: - Conversation seat (accounts:session-seat)

/// `lastMove` of a conversation's seat: the box moved it from another seat.
struct SeatMove: Decodable, Equatable, Sendable {
    var from: String? = nil
    var fromLabel: String = ""
    /// Epoch milliseconds of the move; nil when the box did not say.
    var at: Double? = nil
    var reason: String? = nil
}

extension SeatMove {
    private enum CodingKeys: String, CodingKey { case from, fromLabel, at, reason }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        from = try? c.decodeIfPresent(String.self, forKey: .from)
        fromLabel = (try? c.decodeIfPresent(String.self, forKey: .fromLabel)) ?? ""
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
        // `at` is an epoch-ms number; an ISO-8601 string is tolerated too.
        if let n = (try? c.decodeIfPresent(Double.self, forKey: .at)) ?? nil {
            at = n
        } else if let s = (try? c.decodeIfPresent(String.self, forKey: .at)) ?? nil,
                  let date = ISO8601DateFormatter().date(from: s) {
            at = date.timeIntervalSince1970 * 1000
        } else {
            at = nil
        }
    }
}

/// `accounts:session-seat` reply (the null reply — no assignment — is a nil
/// `SessionSeat` at the call site).
struct SessionSeat: Decodable, Equatable, Sendable {
    var provider: String
    var seatId: String
    var seatLabel: String = ""
    var accountLabel: String = ""
    var lastMove: SeatMove? = nil
}

extension SessionSeat {
    private enum CodingKeys: String, CodingKey {
        case provider, seatId, seatLabel, accountLabel, lastMove
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = try c.decode(String.self, forKey: .provider)
        seatId = try c.decode(String.self, forKey: .seatId)
        seatLabel = (try? c.decodeIfPresent(String.self, forKey: .seatLabel)) ?? ""
        accountLabel = (try? c.decodeIfPresent(String.self, forKey: .accountLabel)) ?? ""
        lastMove = try? c.decodeIfPresent(SeatMove.self, forKey: .lastMove)
    }
}

// MARK: - Action replies

/// The reply of a channel that answers a `ProviderView` — OR `{error: code}`.
/// The contract lists its class-1 error literals as a `{error}` body, which
/// reaches the client either as the rpc envelope's `error` (thrown by the
/// transport as `MantaError.server`) or as the `result` itself; this decodes the
/// second form so the caller can throw the same error for both.
struct AccountsActionReply: Decodable, Equatable, Sendable {
    var error: String? = nil
    var provider: AccountsProvider? = nil

    private enum CodingKeys: String, CodingKey { case error }

    init(error: String? = nil, provider: AccountsProvider? = nil) {
        self.error = error
        self.provider = provider
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let code = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? nil
        if let code, !code.isEmpty {
            error = code
            provider = nil
        } else {
            error = nil
            provider = try? AccountsProvider(from: decoder)
        }
    }
}

/// `accounts:add-seat` reply. `connect` is the existing connect-flow shape the
/// desktop drives; iOS has no such flow, so it is kept opaque.
struct AddSeatReply: Decodable, Equatable, Sendable {
    var seatId: String
    var connect: JSONValue? = nil
}

/// `accounts:seat-status` reply.
struct SeatStatusReply: Decodable, Equatable, Sendable {
    enum State: String, Sendable { case pending, ok, failed }

    var state: State = .pending
    /// "duplicate-login" | "login-failed" | "different-org".
    var error: String? = nil
    var seat: AccountsSeat? = nil
    var orgName: String? = nil

    private enum CodingKeys: String, CodingKey { case state, error, seat, orgName }

    init(state: State = .pending, error: String? = nil, seat: AccountsSeat? = nil, orgName: String? = nil) {
        self.state = state
        self.error = error
        self.seat = seat
        self.orgName = orgName
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? nil
        state = raw.flatMap(State.init(rawValue:)) ?? .pending
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        seat = try? c.decodeIfPresent(AccountsSeat.self, forKey: .seat)
        orgName = try? c.decodeIfPresent(String.self, forKey: .orgName)
    }
}

// MARK: - Bus events (/events)

/// `accounts.updated {provider}` and `accounts.moved {sessionId, provider, …}`.
/// Both mean "re-read"; the payload only narrows who needs to care.
enum AccountsBusEvent: Equatable, Sendable {
    case updated(provider: String?)
    case moved(sessionId: String?, provider: String?)

    /// The conversation a `moved` event is about (nil for `updated`).
    var sessionId: String? {
        if case .moved(let sid, _) = self { return sid }
        return nil
    }

    static func from(_ frame: MantaStreamFrame) -> AccountsBusEvent? {
        guard frame.kind == "accounts.updated" || frame.kind == "accounts.moved" else { return nil }
        var provider: String?
        if case .object(let payload)? = frame.payload, case .string(let p)? = payload["provider"], !p.isEmpty {
            provider = p
        }
        if frame.kind == "accounts.moved" {
            return .moved(sessionId: frame.sessionId, provider: provider)
        }
        return .updated(provider: provider)
    }
}

// MARK: - User feedback

/// The one-line outcome of a user action — success OR failure, never silence.
struct AccountsFeedback: Equatable, Identifiable, Sendable {
    let id: Int
    let text: String
    let isError: Bool
}

// MARK: - Copy

/// Every user-facing sentence the accounts surfaces speak, in one place so the
/// two screens (and the tests) word the same thing the same way.
enum AccountsCopy {
    static let resendTitle = "Switch seat?"
    static let resendMessage = "Conversations will re-send their history to the new seat on their next message."
    static let resendConfirm = "Use this seat"

    static let addSeatOnDesktop = "To add a seat, sign in from the MantaUI desktop app (Settings → Accounts)."
    static let noSeats = "No subscription seats yet. Sign in to a Claude or Codex account from the MantaUI desktop app to add one."
    static let routingInactive = "Seat routing isn't active on this box yet, so conversations keep using the live login for now."
    static let staleBox = "This box doesn't support multiple accounts yet — update it to manage seats here."

    /// "All conversations now use Seat 3".
    static func usingSeat(_ label: String) -> String {
        "All conversations now use \(label)"
    }

    /// Why a call failed, in words the user can act on. Maps the contract's
    /// class-1 literals; anything else is shown as the box sent it (it is
    /// already a safe literal), and transport/auth failures say what to check.
    static func reason(for error: Error) -> String {
        if let manta = error as? MantaError {
            switch manta {
            case .authRequired:
                return "the box rejected this device — pair it again"
            case .transport:
                return "check the connection and try again"
            case .server(let message):
                return reason(forCode: message)
            case .storedButUntranscribed:
                return "something went wrong — try again"
            }
        }
        let text = error.localizedDescription
        return text.isEmpty ? "something went wrong — try again" : text
    }

    static func reason(forCode code: String) -> String {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        switch trimmed {
        case "unknown-seat": return "that seat no longer exists — pull to refresh"
        case "invalid-label": return "names must be 1–40 characters"
        case "live-seat": return "that is the box's live login — switch to another seat before removing it"
        case "unknown-provider": return "that provider isn't set up on this box"
        case "login-failed": return "sign-in failed — try again"
        case "duplicate-login": return "that login is already added"
        case "different-org": return "that login belongs to a different organisation"
        default:
            if trimmed.lowercased().hasPrefix("unknown rpc channel") { return staleBox }
            return trimmed.isEmpty ? "something went wrong — try again" : trimmed
        }
    }

    /// "Couldn't rename the seat — names must be 1–40 characters".
    static func failure(_ action: String, _ error: Error) -> String {
        failure(action, reason: reason(for: error))
    }

    static func failure(_ action: String, reason: String) -> String {
        "Couldn't \(action) — \(reason)"
    }
}

// MARK: - Selectors

/// One conversation's resolved seat: the box's `session-seat` answer joined to
/// the seat it names in the `accounts:list` snapshot (when that has it).
struct ConversationSeat: Equatable, Sendable {
    let sessionSeat: SessionSeat
    let provider: AccountsProvider?
    let account: AccountsAccount?
    let seat: AccountsSeat?

    /// "Work · Seat 2" — account · seat; just the account label when the
    /// account has one seat; just the seat label when there is no account label.
    var displayName: String {
        let accountLabel = account?.label.isEmpty == false ? (account?.label ?? "") : sessionSeat.accountLabel
        let seatLabel = (seat?.label.isEmpty == false ? seat?.label : nil) ?? sessionSeat.seatLabel
        if let account, account.seats.count <= 1 {
            return accountLabel.isEmpty ? seatLabel : accountLabel
        }
        if accountLabel.isEmpty { return seatLabel }
        if seatLabel.isEmpty || seatLabel == accountLabel { return accountLabel }
        return "\(accountLabel) · \(seatLabel)"
    }
}

/// A window row as the sheet draws it.
struct SeatWindowRow: Equatable, Identifiable, Sendable {
    let id: String
    let window: UsageWindow
    let title: String
    /// The provider says this window is not in force (drawn greyed).
    let inactive: Bool
}

/// The other seats, grouped by account, with an account heading only when the
/// provider has two or more accounts.
struct SeatGroup: Equatable, Identifiable, Sendable {
    let id: String
    let heading: String?
    let seats: [AccountsSeat]
}

/// What a seat row offers.
enum SeatRowAction: Equatable, Sendable {
    /// Signed out / expired — point the user at Settings to fix it.
    case fix
    /// Manual mode: switch every conversation to this seat.
    case use
    /// Manual mode: this is the seat in use.
    case inUse
    /// Automatic mode (or one seat): read-only.
    case readOnly
}

enum AccountsSelectors {

    /// A move older than this is no longer worth a line.
    static let recentMoveSeconds: Double = 5 * 3600

    // MARK: Provider shape

    static func allSeats(_ provider: AccountsProvider) -> [AccountsSeat] {
        provider.accounts.flatMap(\.seats)
    }

    static func seatCount(_ provider: AccountsProvider) -> Int {
        provider.accounts.reduce(0) { $0 + $1.seats.count }
    }

    /// The mode chip / picker only exists with two or more seats.
    static func hasChoice(_ provider: AccountsProvider) -> Bool {
        seatCount(provider) >= 2
    }

    static func account(containing seatId: String?, in provider: AccountsProvider) -> AccountsAccount? {
        guard let seatId else { return nil }
        return provider.accounts.first { $0.seats.contains { $0.id == seatId } }
    }

    static func seat(_ seatId: String?, in provider: AccountsProvider) -> AccountsSeat? {
        guard let seatId else { return nil }
        return allSeats(provider).first { $0.id == seatId }
    }

    // MARK: Load

    /// The seat's load: the box's `seatLoad()` when it sent one, else the higher
    /// of the in-force 5h and weekly percentages, else nil (no reading — never
    /// a confident 0).
    static func load(_ seat: AccountsSeat) -> Double? {
        if let load = seat.load, load.isFinite { return load }
        let pcts = seat.windows
            .filter { $0.active != false && ($0.kind == "session" || $0.kind == "weekly") && $0.pct.isFinite }
            .map(\.pct)
        return pcts.max()
    }

    // MARK: Conversation seat

    /// Join the box's `session-seat` answer to the list snapshot. nil when the
    /// conversation has no assignment.
    static func conversationSeat(providers: [AccountsProvider], sessionSeat: SessionSeat?) -> ConversationSeat? {
        guard let sessionSeat else { return nil }
        let provider = providers.first { $0.provider == sessionSeat.provider }
        let seat = provider.flatMap { seat(sessionSeat.seatId, in: $0) }
        let account = provider.flatMap { account(containing: sessionSeat.seatId, in: $0) }
        return ConversationSeat(sessionSeat: sessionSeat, provider: provider, account: account, seat: seat)
    }

    /// The seat layout (conversation seat + other seats) replaces today's
    /// single-snapshot layout only when it has something to add: a provider
    /// with two or more seats AND the conversation's own seat in the snapshot.
    /// One seat, one subscription looks exactly like today.
    static func usesSeatLayout(_ conversation: ConversationSeat?) -> Bool {
        guard let conversation, let provider = conversation.provider, conversation.seat != nil else { return false }
        return hasChoice(provider)
    }

    /// The composer dot's window: the conversation's seat's 5h window, or nil
    /// (caller falls back to the provider snapshot — the dot never goes blank
    /// just because a seat has no reading yet).
    static func dotWindow(_ conversation: ConversationSeat?) -> UsageWindow? {
        guard let seat = conversation?.seat else { return nil }
        return UsageMeters.sessionWindow([UsageSnapshot(windows: seat.windows)])
    }

    // MARK: Windows

    /// A seat's windows in reading order: the 5h, the weekly, any other
    /// account-wide window, then model-scoped weeklies — the ones in force
    /// first, the "not active" ones last.
    static func windowRows(_ seat: AccountsSeat) -> [SeatWindowRow] {
        var session: [UsageWindow] = []
        var weekly: [UsageWindow] = []
        var other: [UsageWindow] = []
        var scopedActive: [UsageWindow] = []
        var scopedInactive: [UsageWindow] = []
        for window in seat.windows {
            if isScoped(window) {
                if window.active == false { scopedInactive.append(window) } else { scopedActive.append(window) }
            } else if window.kind == "session" {
                session.append(window)
            } else if window.kind == "weekly" {
                weekly.append(window)
            } else {
                other.append(window)
            }
        }
        let ordered = session + weekly + other + scopedActive + scopedInactive
        return ordered.enumerated().map { index, window in
            SeatWindowRow(
                id: "\(index)-\(window.kind)",
                window: window,
                title: windowTitle(window),
                inactive: window.active == false
            )
        }
    }

    static func isScoped(_ window: UsageWindow) -> Bool {
        window.kind.hasPrefix("weekly_scoped") || (window.scope?.isEmpty == false)
    }

    static func windowTitle(_ window: UsageWindow) -> String {
        if let label = window.label, !label.isEmpty { return label }
        if let scope = window.scope, !scope.isEmpty { return "Weekly · \(scope)" }
        switch window.kind {
        case "session": return "5h"
        case "weekly": return "Weekly"
        default: return window.kind
        }
    }

    /// The window to quote a reset time for in a compact row: the in-force
    /// 5h/weekly with the highest percentage at/over 90, or nil.
    static func resetHintWindow(_ seat: AccountsSeat) -> UsageWindow? {
        seat.windows
            .filter { $0.active != false && $0.stale != true && $0.resetsAt != nil && $0.pct >= 90 }
            .max { $0.pct < $1.pct }
    }

    // MARK: Ordering / status text

    /// The providers in the box's order, with `focus` (a provider the user
    /// tapped through to) moved to the top. An unknown focus changes nothing.
    static func ordered(_ providers: [AccountsProvider], focus: String?) -> [AccountsProvider] {
        guard let focus, let index = providers.firstIndex(where: { $0.provider == focus }), index != 0 else {
            return providers
        }
        var out = providers
        let picked = out.remove(at: index)
        out.insert(picked, at: 0)
        return out
    }

    /// The badge a seat's sign-in state earns; nil for a seat that is fine or
    /// whose state the box has not reported.
    static func statusText(_ status: SeatStatus) -> String? {
        switch status {
        case .expired: return "Expired"
        case .signedOut: return "Signed out"
        case .ok, .unknown: return nil
        }
    }

    // MARK: Other seats

    /// Every seat except the conversation's own, grouped by account (the
    /// server's order), with a heading only when the provider has ≥ 2 accounts.
    static func otherSeatGroups(_ provider: AccountsProvider, excluding seatId: String?) -> [SeatGroup] {
        let showHeadings = provider.accounts.count >= 2
        return provider.accounts.compactMap { account in
            let seats = account.seats.filter { $0.id != seatId }
            guard !seats.isEmpty else { return nil }
            return SeatGroup(id: account.id, heading: showHeadings ? account.label : nil, seats: seats)
        }
    }

    /// The "next" tag: automatic mode only, on the seat the box says a new
    /// conversation / a move goes to. The id comes FROM THE BOX (the same
    /// function that places conversations), so the hint cannot disagree with
    /// the move.
    static func isNextSeat(_ seat: AccountsSeat, in provider: AccountsProvider) -> Bool {
        provider.mode == .auto && provider.nextSeatId != nil && provider.nextSeatId == seat.id
    }

    static func rowAction(_ seat: AccountsSeat, in provider: AccountsProvider) -> SeatRowAction {
        if seat.status == .expired || seat.status == .signedOut { return .fix }
        guard provider.mode == .manual, hasChoice(provider) else { return .readOnly }
        return provider.activeSeatId == seat.id ? .inUse : .use
    }

    /// Switching to a seat in a DIFFERENT account re-sends each conversation's
    /// whole history once (a different org does not share the prompt cache);
    /// a seat of the same account shares it, so no confirmation is needed.
    /// Without a known current seat there is nothing to compare — no prompt.
    static func needsResendConfirmation(_ provider: AccountsProvider, switchingTo seatId: String) -> Bool {
        guard let from = account(containing: provider.activeSeatId, in: provider),
              let to = account(containing: seatId, in: provider) else { return false }
        return from.id != to.id
    }

    // MARK: Other subscriptions

    /// The provider's least-loaded usable seat (ties keep the server's order).
    static func bestSeat(_ provider: AccountsProvider) -> AccountsSeat? {
        var best: AccountsSeat?
        var bestLoad = Double.infinity
        for seat in allSeats(provider) where seat.status == .ok || seat.status == .unknown {
            guard let seatLoad = load(seat) else { continue }
            if seatLoad < bestLoad {
                best = seat
                bestLoad = seatLoad
            }
        }
        return best
    }

    /// "OpenAI · best seat 12% of 5h" — one line for a subscription other than
    /// the conversation's own.
    static func otherSubscriptionLine(_ provider: AccountsProvider) -> String {
        let name = UsageMeters.providerLabel(provider.provider)
        guard let best = bestSeat(provider), let load = load(best) else {
            let anyUsable = allSeats(provider).contains { $0.status == .ok || $0.status == .unknown }
            return anyUsable ? "\(name) · no usage reading yet" : "\(name) · needs sign-in"
        }
        if let session = UsageMeters.sessionWindow([UsageSnapshot(windows: best.windows)]) {
            return "\(name) · best seat \(percent(session.pct)) of \(windowTitle(session))"
        }
        return "\(name) · best seat \(percent(load)) used"
    }

    /// The providers other than the conversation's own.
    static func otherProviders(_ providers: [AccountsProvider], than provider: String?) -> [AccountsProvider] {
        guard let provider else { return [] }
        return providers.filter { $0.provider != provider && seatCount($0) >= 1 }
    }

    // MARK: Last move

    /// "Moved from Seat 1 · seat was at its limit · 2h ago", or nil when the
    /// conversation has not moved in the last 5 hours (or the box gave no time).
    static func lastMoveLine(_ move: SeatMove?, now: Date) -> String? {
        guard let move, let at = move.at, at.isFinite else { return nil }
        let ageSeconds = now.timeIntervalSince1970 - at / 1000
        // A little negative age is clock skew between box and phone, not the future.
        guard ageSeconds > -60, ageSeconds <= recentMoveSeconds else { return nil }
        let from = !move.fromLabel.isEmpty ? move.fromLabel : (move.from ?? "")
        var parts = [from.isEmpty ? "Moved from another seat" : "Moved from \(from)"]
        if let reason = reasonText(move.reason) { parts.append(reason) }
        parts.append(agoText(seconds: Int(max(0, ageSeconds))))
        return parts.joined(separator: " · ")
    }

    static func reasonText(_ reason: String?) -> String? {
        guard let reason = reason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty else { return nil }
        switch reason {
        case "exhausted": return "seat was at its limit"
        case "load", "balance": return "to balance load"
        default: return reason.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
        }
    }

    static func agoText(seconds: Int) -> String {
        seconds < 60 ? "just now" : "\(UsageMeters.resetDistance(seconds)) ago"
    }

    // MARK: Labels

    /// A rename's text: trimmed, 1–40 UTF-16 units (the server counts the way
    /// JavaScript does), no control characters. nil = invalid.
    static func normalizedLabel(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf16.count <= 40 else { return nil }
        if trimmed.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) { return nil }
        return trimmed
    }

    // MARK: Small formatting

    static func percent(_ pct: Double) -> String {
        guard pct.isFinite else { return "–" }
        return "\(Int(UsageMeters.clamp(pct).rounded()))%"
    }

    /// The provider's heading: "Claude", "OpenAI" (shared with the usage sheet).
    static func providerName(_ provider: String) -> String {
        let name = UsageMeters.providerLabel(provider)
        return name.isEmpty ? provider : name
    }

    /// Where a seat row's secondary line comes from: the email, with the plan
    /// appended when a single-seat account shows it in the row.
    static func seatSubtitle(_ seat: AccountsSeat, plan: String?) -> String? {
        let parts = [seat.email, plan].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// "1 conversation" / "3 conversations" / nil for none.
    static func conversationsText(_ count: Int) -> String? {
        switch count {
        case ..<1: return nil
        case 1: return "1 conversation"
        default: return "\(count) conversations"
        }
    }
}
