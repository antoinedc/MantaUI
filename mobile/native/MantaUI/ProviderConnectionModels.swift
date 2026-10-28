import Foundation

// ===========================================================================
// WS08 — the pure half of "connect a subscription provider" and the provider
// section of Settings → Accounts: wire types for `opencode:provider-auth`,
// `accounts:health`, `accounts:retry`, `accounts:endpoint-probe`; the section
// plan; what each connection row says and offers; the connect flow's phases and
// transitions; and the one notification that tells the model picker the set of
// models changed.
//
// Foundation-only (compiled by the Linux SwiftPM package). Every wire type is
// tolerant: a newer box may add keys and an older one omit them, and a
// malformed row must never blank the screen.
// ===========================================================================

// MARK: - Model-list change announcement

extension Notification.Name {
    /// Posted (through `ProviderChange.announce`) after anything that changes
    /// which models opencode serves: a seat / account added or re-signed, a
    /// subscription connected or disconnected, a custom endpoint saved, toggled
    /// or removed. `ChatModelCatalog` observes it and reloads the picker.
    static let mantaProvidersChanged = Notification.Name("manta.providersChanged")
}

/// What an endpoint write (or any provider change) came to, without payload.
enum ProviderChangeOutcome: Equatable, Sendable {
    case confirmed
    case partial
    case rejected
    case unconfirmed
}

enum ProviderChange {
    /// Only an outcome that may have changed the model list announces. An
    /// `.unconfirmed` write is followed by a forced read, which announces only
    /// if that read shows a change.
    static func shouldAnnounce(_ outcome: ProviderChangeOutcome) -> Bool {
        switch outcome {
        case .confirmed, .partial: return true
        case .rejected, .unconfirmed: return false
        }
    }

    /// Post `.mantaProvidersChanged`. The poster is injectable so a test can
    /// observe the post without a `NotificationCenter`.
    static func announce(post: (Notification.Name) -> Void = { NotificationCenter.default.post(name: $0, object: nil) }) {
        post(.mantaProvidersChanged)
    }
}

// MARK: - opencode:provider-auth wire types

/// One subscription provider as `opencode:provider-auth {action:"status"}`
/// lists it (`subscriptionStatuses`, `src/server/subscriptionProviders.mjs`).
struct SubscriptionStatus: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var label: String = ""
    var plan: String? = nil
    var console: String? = nil
    var docs: String? = nil
    var connected: Bool = false
    /// The credential belongs to something outside Manta (the Claude CLI), so
    /// there is no Disconnect to offer.
    var managedExternally: Bool = false
    var managedBy: String? = nil

    private enum CodingKeys: String, CodingKey {
        case id, label, plan, console, docs, connected, managedExternally, managedBy
    }

    init(id: String, label: String = "", plan: String? = nil, console: String? = nil, docs: String? = nil,
         connected: Bool = false, managedExternally: Bool = false, managedBy: String? = nil) {
        self.id = id
        self.label = label
        self.plan = plan
        self.console = console
        self.docs = docs
        self.connected = connected
        self.managedExternally = managedExternally
        self.managedBy = managedBy
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? ""
        plan = try? c.decodeIfPresent(String.self, forKey: .plan)
        console = try? c.decodeIfPresent(String.self, forKey: .console)
        docs = try? c.decodeIfPresent(String.self, forKey: .docs)
        connected = (try? c.decodeIfPresent(Bool.self, forKey: .connected)) ?? false
        managedExternally = (try? c.decodeIfPresent(Bool.self, forKey: .managedExternally)) ?? false
        managedBy = try? c.decodeIfPresent(String.self, forKey: .managedBy)
    }

    /// The name a row shows (the box's label, else the id).
    var displayName: String { label.isEmpty ? id : label }
}

/// `{ action: "status", providers: [...] }`.
struct ProviderAuthStatusReply: Decodable, Equatable, Sendable {
    var providers: [SubscriptionStatus] = []

    private enum CodingKeys: String, CodingKey { case providers }

    init(providers: [SubscriptionStatus] = []) { self.providers = providers }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        providers = (try? c.decodeIfPresent(LenientArray<SubscriptionStatus>.self, forKey: .providers))?.elements ?? []
    }
}

/// `{ action: "start", shape, ... }` — the same connect shape as the seat flows.
typealias ProviderAuthStartReply = SignInConnect

/// `{ action: "code" | "key" | "disconnect" | ..., ok, error? }`. The key is
/// never part of any reply.
struct ProviderAuthOkReply: Decodable, Equatable, Sendable {
    var ok: Bool = false
    var error: String? = nil

    private enum CodingKeys: String, CodingKey { case ok, error }

    init(ok: Bool = false, error: String? = nil) {
        self.ok = ok
        self.error = error
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? false
        error = try? c.decodeIfPresent(String.self, forKey: .error)
    }
}

/// `{ action: "claude-status", ok, progress?, error? }`.
struct ClaudeStatusReply: Decodable, Equatable, Sendable {
    enum Progress: Equatable, Sendable {
        case noFile
        /// The credentials file predates this flow: the user already had a login.
        case preExisting
        /// A fresh login landed (the box already restarted opencode).
        case completed
        case other(String)

        init(wire: String) {
            switch wire {
            case "no-file": self = .noFile
            case "pre-existing": self = .preExisting
            case "completed": self = .completed
            default: self = .other(wire)
            }
        }
    }

    var ok: Bool = false
    var progress: Progress? = nil
    /// "unknown_session": the box no longer has this sign-in (it can never recover).
    var error: String? = nil

    private enum CodingKeys: String, CodingKey { case ok, progress, error }
    private struct ProgressBody: Decodable { var state: String? }

    init(ok: Bool = false, progress: Progress? = nil, error: String? = nil) {
        self.ok = ok
        self.progress = progress
        self.error = error
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? false
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        if let body = (try? c.decodeIfPresent(ProgressBody.self, forKey: .progress)) ?? nil, let state = body.state {
            progress = Progress(wire: state)
        } else {
            progress = nil
        }
    }
}

/// `{ action: "oauth-status", state, error? }`. An unrecognised state keeps polling.
struct OauthStatusReply: Decodable, Equatable, Sendable {
    enum State: String, Sendable { case pending, ok, error }

    var state: State = .pending
    /// "expired" | "not_started" | other.
    var error: String? = nil

    private enum CodingKeys: String, CodingKey { case state, error }

    init(state: State = .pending, error: String? = nil) {
        self.state = state
        self.error = error
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? nil
        state = raw.flatMap(State.init(rawValue:)) ?? .pending
        error = try? c.decodeIfPresent(String.self, forKey: .error)
    }
}

/// `opencode:claude-cli-status` — `{ installed, path }`.
struct ClaudeCliStatus: Decodable, Equatable, Sendable {
    var installed: Bool = false
    var path: String? = nil

    private enum CodingKeys: String, CodingKey { case installed, path }

    init(installed: Bool = false, path: String? = nil) {
        self.installed = installed
        self.path = path
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        installed = (try? c.decodeIfPresent(Bool.self, forKey: .installed)) ?? false
        path = try? c.decodeIfPresent(String.self, forKey: .path)
    }
}

// MARK: - accounts:health / retry / probe

struct ProviderHealthEntry: Equatable, Sendable {
    var state: String
    var retryInMs: Double? = nil
}

struct EndpointHealthEntry: Equatable, Sendable {
    var state: String
    /// The one-line state, worded by the box (WS11 D4 / K3). nil on an older box.
    var stateLine: String? = nil
}

/// The worst endpoint of a provider, worded by the box: `key` is the register key
/// ("providerID/modelID"; nil = "Unproven" with nothing in the register yet).
struct ProviderHealthLine: Equatable, Sendable {
    var key: String?
    var stateLine: String
}

/// `accounts:health` — the health engine's per-provider and per-endpoint
/// states. Missing health is UNKNOWN, never healthy: a row with no entry simply
/// carries no health state.
struct AccountsHealth: Decodable, Equatable, Sendable {
    var providers: [String: ProviderHealthEntry] = [:]
    /// Keyed `"<providerID>/<modelID>"`.
    var endpoints: [String: EndpointHealthEntry] = [:]
    /// The worst endpoint per provider, worded by the box.
    var providerLines: [String: ProviderHealthLine] = [:]

    init(
        providers: [String: ProviderHealthEntry] = [:],
        endpoints: [String: EndpointHealthEntry] = [:],
        providerLines: [String: ProviderHealthLine] = [:]
    ) {
        self.providers = providers
        self.endpoints = endpoints
        self.providerLines = providerLines
    }

    init(from decoder: Decoder) throws {
        let value = try JSONValue(from: decoder)
        guard case .object(let root) = value else { return }
        func number(_ object: [String: JSONValue], _ key: String) -> Double? {
            if case .number(let n)? = object[key], n.isFinite { return n }
            return nil
        }
        if case .object(let map)? = root["providers"] {
            for (id, raw) in map {
                guard case .object(let entry) = raw, case .string(let state)? = entry["state"], !state.isEmpty else { continue }
                providers[id] = ProviderHealthEntry(state: state, retryInMs: number(entry, "retryInMs"))
            }
        }
        if case .object(let map)? = root["endpoints"] {
            for (key, raw) in map {
                guard case .object(let entry) = raw, case .string(let state)? = entry["state"], !state.isEmpty else { continue }
                var line: String?
                if case .string(let l)? = entry["stateLine"], !l.isEmpty { line = l }
                endpoints[key] = EndpointHealthEntry(state: state, stateLine: line)
            }
        }
        if case .object(let map)? = root["providerLines"] {
            for (id, raw) in map {
                guard case .object(let entry) = raw, case .string(let line)? = entry["stateLine"], !line.isEmpty else { continue }
                var key: String?
                if case .string(let k)? = entry["key"], !k.isEmpty { key = k }
                providerLines[id] = ProviderHealthLine(key: key, stateLine: line)
            }
        }
    }
}

/// `accounts:retry` — `{ ok, state, message }`; `message` is never empty.
struct AccountsRetryReply: Decodable, Equatable, Sendable {
    var ok: Bool = false
    var state: String = ""
    var message: String = ""

    private enum CodingKeys: String, CodingKey { case ok, state, message }

    init(ok: Bool = false, state: String = "", message: String = "") {
        self.ok = ok
        self.state = state
        self.message = message
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? false
        state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? ""
        message = (try? c.decodeIfPresent(String.self, forKey: .message)) ?? ""
    }
}

/// `accounts:endpoint-probe` — `{ ok, outcome, message }`.
struct EndpointProbeReply: Decodable, Equatable, Sendable {
    var ok: Bool = false
    var outcome: String? = nil
    var message: String = ""

    private enum CodingKeys: String, CodingKey { case ok, outcome, message }

    init(ok: Bool = false, outcome: String? = nil, message: String = "") {
        self.ok = ok
        self.outcome = outcome
        self.message = message
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? false
        outcome = try? c.decodeIfPresent(String.self, forKey: .outcome)
        message = (try? c.decodeIfPresent(String.self, forKey: .message)) ?? ""
    }
}

// MARK: - The section plan

/// Which phase one data source of the Accounts screen is in. Each source keeps
/// its own, so one failing call never hides the others.
enum ProviderSourcePhase: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case failed(String)
}

/// What the "Add endpoint…" row shows. The form's id-collision guard needs a
/// COMPLETE endpoint inventory, so it is only reachable while that is loaded.
enum AddEndpointState: Equatable, Sendable {
    case loading
    case retry(reason: String)
    case enabled
}

/// The fixed seat-provider ↔ opencode-provider table (the two namespaces differ
/// on purpose): `claude ↔ anthropic`, `codex ↔ openai`.
enum SeatProviderMap {
    static let pairs: [(seat: String, status: String)] = [("claude", "anthropic"), ("codex", "openai")]

    static func statusId(forSeatProvider seat: String) -> String? {
        pairs.first { $0.seat == seat }?.status
    }

    static func seatProvider(forStatusId status: String) -> String? {
        pairs.first { $0.status == status }?.seat
    }
}

/// One subscription provider's section.
struct SubscriptionSection: Equatable, Identifiable, Sendable {
    /// The opencode status id this section is about (`anthropic`), or, for a
    /// seat provider with no status row (an old box), the seat provider id.
    let canonicalId: String
    let title: String
    /// nil on an old box that has the seat view but no status row.
    let status: SubscriptionStatus?
    /// The seat view (`accounts:list` entry); nil when the provider has no seats.
    let seats: AccountsProvider?

    var id: String { canonicalId }
}

struct AccountsSectionPlan: Equatable, Sendable {
    var subscriptions: [SubscriptionSection]
    var endpoints: [ProviderEndpoint]

    /// Nothing at all to show (only reachable on a box that answers an empty
    /// status list): the screen then says nothing is connected yet.
    var isEmpty: Bool { subscriptions.isEmpty && endpoints.isEmpty }

    /// Every id a caller already passes → the canonical (opencode) id:
    /// `claude`→`anthropic`, `codex`→`openai`, WS02's `kimi`→`kimi-for-coding`;
    /// anything else is kept. Empty / nil → nil.
    static func normalizeFocus(_ raw: String?) -> String? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        if let mapped = SeatProviderMap.statusId(forSeatProvider: raw) { return mapped }
        if raw == "kimi" { return "kimi-for-coding" }
        return raw
    }

    /// Subscription sections in the box's status order (a seat provider with no
    /// status row follows them), the focused provider first.
    static func build(statuses: [SubscriptionStatus], seatProviders: [AccountsProvider],
                      endpoints: [ProviderEndpoint], focus: String?) -> AccountsSectionPlan {
        var sections: [SubscriptionSection] = []
        var usedSeatProviders = Set<String>()
        for status in statuses {
            var seatView: AccountsProvider?
            if let seatId = SeatProviderMap.seatProvider(forStatusId: status.id) {
                seatView = seatProviders.first { $0.provider == seatId }
                if seatView != nil { usedSeatProviders.insert(seatId) }
            }
            sections.append(SubscriptionSection(canonicalId: status.id, title: status.displayName, status: status, seats: seatView))
        }
        for view in seatProviders where !usedSeatProviders.contains(view.provider) {
            let canonical = SeatProviderMap.statusId(forSeatProvider: view.provider) ?? view.provider
            guard !sections.contains(where: { $0.canonicalId == canonical }) else { continue }
            sections.append(SubscriptionSection(
                canonicalId: canonical,
                title: AccountsSelectors.providerName(view.provider),
                status: nil,
                seats: view
            ))
        }
        if let focus = normalizeFocus(focus), let index = sections.firstIndex(where: { $0.canonicalId == focus }), index != 0 {
            let picked = sections.remove(at: index)
            sections.insert(picked, at: 0)
        }
        return AccountsSectionPlan(subscriptions: sections, endpoints: endpoints)
    }

    static func addEndpointState(inventory: ProviderSourcePhase) -> AddEndpointState {
        switch inventory {
        case .idle, .loading: return .loading
        case .failed(let reason): return .retry(reason: reason)
        case .loaded: return .enabled
        }
    }
}

// MARK: - Connection row

/// What a connection row says and offers — computed on the box (`accounts:row-states`,
/// WS11 D4 / K2) and shown as given. The box names the control by precedence (out of
/// credit → retry; a credential owned elsewhere → none; connected → disconnect; else
/// connect); the phone never re-derives it. An unreadable tone is quiet and an
/// unreadable control is none (no control is the safe answer).
struct AccountRowState: Equatable, Sendable, Decodable {
    enum Tone: String, Equatable, Sendable { case ok, warn, danger, quiet }
    enum Control: String, Equatable, Sendable {
        /// Out of credit: re-read the meter and clear the flag if funds are back.
        case tryAgain = "retry"
        case disconnect
        case connect
        /// Connected, but the credential is owned elsewhere: nothing to offer.
        case none
    }

    var text: String
    var tone: Tone
    var control: Control
    /// A custom endpoint's register line (its worst state); nil on subscription rows.
    var registerLine: String?

    init(text: String, tone: Tone, control: Control = .none, registerLine: String? = nil) {
        self.text = text
        self.tone = tone
        self.control = control
        self.registerLine = registerLine
    }

    private enum CodingKeys: String, CodingKey { case text, tone, control, registerLine }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        tone = ((try? c.decode(String.self, forKey: .tone)).flatMap(Tone.init(rawValue:))) ?? .quiet
        control = ((try? c.decode(String.self, forKey: .control)).flatMap(Control.init(rawValue:))) ?? .none
        registerLine = (try? c.decodeIfPresent(String.self, forKey: .registerLine)) ?? nil
    }
}

/// `accounts:row-states` — `{rows: {<providerID>: AccountRowState}}`.
struct AccountRowStatesReply: Decodable, Equatable, Sendable {
    var rows: [String: AccountRowState] = [:]
}

// MARK: - Connect: which flow does the Connect button open?

/// A provider that already has seats must never be connected through the live
/// login path (it would replace the box's credentials outside the isolated seat
/// directory): its Connect opens "Add account" instead. The decision never uses
/// the store's possibly stale list — it is made from a fresh read.
enum ConnectRoute: Equatable, Sendable {
    case connect
    case addAccount
    case blocked(String)

    /// `fresh` is the result of a read started after the tap; nil for a provider
    /// with no seats concept (Kimi).
    static func decide(statusId: String, seatProviderId: String?, fresh: Result<[AccountsProvider], Error>?) -> ConnectRoute {
        guard let seatProviderId else { return .connect }
        guard let fresh else { return .blocked("the existing logins couldn't be read") }
        switch fresh {
        case .failure(let error):
            return .blocked(AccountsCopy.reason(for: error))
        case .success(let providers):
            if let view = providers.first(where: { $0.provider == seatProviderId }), AccountsSelectors.seatCount(view) >= 1 {
                return .addAccount
            }
            return .connect
        }
    }

    static func blockedMessage(label: String, reason: String) -> String {
        "Couldn't check \(label)'s existing logins — \(reason). Try again."
    }
}

// MARK: - Connect flow phases

/// Phases of the connect flow, mirroring the Mac app's `ConnectPhase`.
enum ProviderConnectPhase: Equatable, Sendable {
    case starting
    /// Device code (Codex).
    case waiting(url: String, instructions: String)
    /// An OAuth page that hands back a code to paste.
    case needsCode(methodIndex: Int, url: String, instructions: String, error: String?)
    /// An API key (Kimi).
    case needsKey(consoleURL: String?, error: String?)
    case needsClaudeLogin(sessionKey: String, cwd: String, startedAt: Date)
    case installingClaudeCli(installerKey: String, loginSessionKey: String, cwd: String, startedAt: Date)
    /// Waiting for opencode to report the provider connected. `restarted`: the
    /// box already restarted opencode (so the client must not do it again).
    case applying(restarted: Bool)
    case done
    case failed(String, claudeInstall: Bool)

    var isTerminal: Bool {
        switch self {
        case .done, .failed: return true
        default: return false
        }
    }
}

enum ConnectObservation: Sendable {
    case claudeStatus(ClaudeStatusReply)
    case oauthStatus(OauthStatusReply)
}

enum ConnectTransition: Equatable, Sendable {
    case stay
    case to(ProviderConnectPhase)
}

enum ProviderConnectRules {
    static let claudePollInterval: Duration = .seconds(1)
    static let claudePollLimit: TimeInterval = 5 * 60
    static let installPollInterval: Duration = .seconds(2)
    static let installPollLimit: TimeInterval = 5 * 60
    static let devicePollInterval: Duration = .seconds(3)
    /// The box's code lifetime — used only for the countdown line; the box owns expiry.
    static let deviceLimit: TimeInterval = 15 * 60
    static let applyPollInterval: Duration = .seconds(3)
    static let applyPollLimit: TimeInterval = 30
    static let installerCols = 120
    static let installerRows = 40
    /// 500 columns is the box's clamp maximum: it keeps the ~400-character
    /// OAuth link on one line of pty output.
    static let loginCols = 500
    static let loginRows = 50

    /// The transition one status observation causes.
    static func next(after observation: ConnectObservation) -> ConnectTransition {
        switch observation {
        case .claudeStatus(let reply):
            if reply.ok == false, reply.error == "unknown_session" {
                // The box dropped this sign-in; unlike the Mac app, which keeps
                // polling to its cap, this can never recover — fail at once.
                return .to(.failed(AccountsSignInCopy.signInExpired, claudeInstall: false))
            }
            guard reply.ok, let progress = reply.progress else { return .stay }
            switch progress {
            case .completed: return .to(.applying(restarted: true))
            case .preExisting: return .to(.applying(restarted: false))
            case .noFile, .other: return .stay
            }
        case .oauthStatus(let reply):
            switch reply.state {
            case .pending: return .stay
            case .ok: return .to(.applying(restarted: false))
            case .error: return .to(.failed(ProviderConnectCopy.deviceAuthError(reply.error), claudeInstall: false))
            }
        }
    }
}

enum ProviderConnectCopy {
    static let startUnreachable = "Couldn't reach the server. Try again."
    static let unexpectedReply = "Unexpected response from the server."
    static let claudeTimedOut = "The Claude sign-in didn't complete in time. Try again."
    static let didNotComeOnline = "Saved, but the provider didn't come online. Check the credential and try again."
    static let installTimedOut = "The Claude CLI didn't install in time. The server itself is fine — try again, use a different model, or install it manually."
    static let installFailed = "The Claude CLI installer exited without installing the binary. The server itself is fine — try again, use a different model, or install it manually from https://claude.ai."
    static let installing = "The claude CLI isn't on this server yet. Installing it now via the official installer — no action needed."
    static let installManuallyURL = "https://claude.ai"
    static let cantStartKind = "This provider's sign-in can't be started from here yet."

    static func deviceAuthError(_ error: String?) -> String {
        switch error {
        case "expired": return "The sign-in code expired. Try again."
        case "not_started": return "Sign-in didn't start. Try again."
        default: return "Sign-in failed. Try again."
        }
    }

    static func keyErrorText(_ error: String?) -> String {
        error == "unauthorized" ? "That key didn't work. Try again." : "Save failed: \(error ?? "unknown")"
    }

    static func codeErrorText(_ error: String?) -> String {
        error == "unauthorized" ? "That code didn't work. Try again." : "Save failed: \(error ?? "unknown")"
    }

    static func title(label: String) -> String { "Connect \(label)" }

    /// The one-line status of a phase (`connectPhaseLabel`).
    static func phaseLabel(_ phase: ProviderConnectPhase) -> String {
        switch phase {
        case .starting: return "Connecting…"
        case .waiting: return "Waiting for sign-in"
        case .needsCode: return "Enter the code"
        case .needsKey: return "Enter your API key"
        case .needsClaudeLogin: return "Awaiting Claude sign-in"
        case .installingClaudeCli: return "Installing the Claude CLI"
        case .applying: return "Applying…"
        case .done: return "Connected."
        case .failed: return "Couldn't connect"
        }
    }

    static func connected(label: String) -> String { "\(label) connected." }
    static func disconnected(label: String) -> String { "\(label) disconnected." }
    static func disconnectFailed(label: String, reason: String) -> String { "Couldn't disconnect \(label) — \(reason)" }
    static let disconnectConfirmMessage = "This restarts opencode and interrupts every running session."
}
