import Combine
import Foundation

// ===========================================================================
// WS08 — the controllers behind the sign-in sheets.
//
//   `SignInTeardown`      releases whatever one attempt allocated on the box.
//   `ClaudeLoginSession`  drives `claude auth login` through the `pty:*` RPCs
//                         and the `kind:"pty"` bus frames (no terminal screen —
//                         the `/pty` socket would bypass the guard that points a
//                         seat sign-in at the seat's own directory).
//   `AccountsSeatSignIn`  add a seat / add an account (F1) and re-sign a
//                         logged-out seat (F2).
//
// Every start of a flow is a new `SignInAttempt`. Every async continuation asks
// `SignInAttemptGate` before it touches state, so a result for an attempt that
// was cancelled or retired is dropped (and a late start reply is torn down on
// the spot). Deadlines are wall-clock `Date`s: the user leaves the app to sign
// in, so timer ticks cannot be trusted to accumulate.
// ===========================================================================

// MARK: - Request (what the screen presents)

struct AccountsSignInRequest: Identifiable, Equatable {
    enum Mode: Equatable {
        /// `accountId == nil` adds a new account; otherwise a seat to that account.
        case add(provider: String, accountId: String?, accountLabel: String?)
        /// Sign a logged-out (non-live) seat back in — same account only.
        case resign(provider: String, seatId: String, seatLabel: String, accountLabel: String?, email: String?)
    }

    let id = UUID()
    let mode: Mode
}

// MARK: - Teardown

enum SignInTeardown {
    /// Run every step of the attempt's plan, in order, continuing past a failed
    /// step. Returns true only when every step succeeded. The provider-wide
    /// `oauth-cancel` goes through the lease, never directly.
    @MainActor
    static func run(_ attempt: SignInAttempt, api: MantaAPIClient, lease: ProviderOAuthLease = ProviderOAuthLease.shared) async -> Bool {
        var allSucceeded = true
        for step in attempt.teardownPlan() {
            do {
                switch step {
                case .cancelSeat(let seatId):
                    try await api.accountsCancelSeat(seatId: seatId)
                case .resignCancel(let flowId):
                    try await api.accountsResignCancel(flowId: flowId)
                case .oauthCancel(let provider):
                    if case .failure(let error) = await lease.retire(provider: provider, attempt: attempt.id) {
                        throw error
                    }
                case .ptyKill(let key):
                    try await api.signInPtyKill(sessionKey: key)
                case .claudeLoginCancel(let key):
                    try await api.providerClaudeLoginCancel(sessionKey: key)
                }
            } catch {
                allSucceeded = false
                NSLog("[accounts] sign-in cleanup step %@ failed: %@", String(describing: step), String(describing: error))
            }
        }
        return allSucceeded
    }
}

// MARK: - Claude sign-in through the pty RPCs

@MainActor
final class ClaudeLoginSession: ObservableObject {
    /// The OAuth link, once the terminal has printed all of it.
    @Published private(set) var url: URL?
    /// The code was typed into the terminal; waiting for the flow to settle.
    @Published private(set) var submitting = false
    @Published private(set) var inputError: String?

    let sessionKey: String

    private let cwd: String
    private let api: MantaAPIClient
    private let events: PassthroughSubject<PtyEvent, Never>
    private let onFailedExit: @MainActor () -> Void
    private let onLinkTimeout: @MainActor () -> Void
    private let linkTimeout: TimeInterval
    private var subscription: AnyCancellable?
    private var linkTimer: Task<Void, Never>?
    private var buffer = ""
    private var stopped = false

    init(sessionKey: String, cwd: String, api: MantaAPIClient, events: PassthroughSubject<PtyEvent, Never>,
         linkTimeout: TimeInterval = SignInClock.linkTimeout,
         onFailedExit: @escaping @MainActor () -> Void, onLinkTimeout: @escaping @MainActor () -> Void) {
        self.sessionKey = sessionKey
        self.cwd = cwd
        self.api = api
        self.events = events
        self.onFailedExit = onFailedExit
        self.onLinkTimeout = onLinkTimeout
        self.linkTimeout = linkTimeout
    }

    /// Subscribe to the pty frames FIRST, then spawn `claude auth login` (500
    /// columns keeps the ~400-character link on one line of output). A refusal
    /// from the box — "This sign-in has expired…" — is thrown.
    func start() async throws {
        let key = sessionKey
        subscription = events
            .filter { SignInAttemptGate.accepts(ptyEventKey: $0.sessionKey, attemptKey: key) }
            .sink { [weak self] event in
                // The subject is fed on the main actor, so this runs there already;
                // handling in place keeps chunk order for the link buffer.
                MainActor.assumeIsolated { self?.handle(event) }
            }
        let limit = linkTimeout
        linkTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(limit))
            guard !Task.isCancelled else { return }
            self?.linkTimedOut()
        }
        try await api.signInPtySpawn(
            sessionKey: sessionKey, cwd: cwd,
            cols: ProviderConnectRules.loginCols, rows: ProviderConnectRules.loginRows,
            launcherId: "claude-auth-login"
        )
    }

    /// Write the code pasted from the browser into the terminal. The spinner
    /// stays until the owning flow settles (`stop()` clears it).
    func submit(_ raw: String) async {
        let code = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty, !submitting, !stopped else { return }
        submitting = true
        inputError = nil
        do {
            try await api.signInPtyWrite(sessionKey: sessionKey, data: code + "\r")
        } catch {
            guard !stopped else { return }
            submitting = false
            inputError = AccountsSignInCopy.writeFailed
        }
    }

    /// Stop listening and drop timers. Does NOT kill the pty — teardown does.
    func stop() {
        stopped = true
        subscription?.cancel()
        subscription = nil
        linkTimer?.cancel()
        linkTimer = nil
        submitting = false
    }

    private func handle(_ event: PtyEvent) {
        guard !stopped else { return }
        switch event.kind {
        case .data(let chunk):
            guard url == nil else { return }
            buffer = ClaudeLoginURL.appending(buffer, chunk)
            if let found = ClaudeLoginURL.extract(from: buffer) {
                url = found
                buffer = ""
                linkTimer?.cancel()
                linkTimer = nil
            }
        case .exit(let code):
            // A clean exit is a successful login — keep waiting for the box. Any
            // other exit (a wrong or expired code) will never produce credentials.
            if code == 0 { return }
            onFailedExit()
        }
    }

    private func linkTimedOut() {
        guard !stopped, url == nil else { return }
        onLinkTimeout()
    }
}

// MARK: - Add a seat / re-sign a seat

@MainActor
final class AccountsSeatSignIn: ObservableObject {

    enum Phase: Equatable {
        case tosNote
        case starting
        /// Claude: see `claudeSession` for the link and the code field.
        case claude
        case device(url: String, instructions: String, startedAt: Date)
        case differentOrg(orgName: String?, busy: Bool)
        case done(String)
        case failed(String)
    }

    static let tosAckKey = "manta.accounts.tosAck"
    /// How long a re-sign's "Signed back in" stays up while the list refreshes.
    static let resignDoneHold: Duration = .milliseconds(1_500)

    @Published private(set) var phase: Phase = .starting
    @Published private(set) var claudeSession: ClaudeLoginSession?
    @Published private(set) var cancelling = false
    /// The sheet should close (a finished flow, or a Cancel that completed).
    @Published private(set) var shouldDismiss = false
    /// A different-org choice that failed (shown inline, the choice stays up).
    @Published private(set) var inlineError: String?

    let request: AccountsSignInRequest

    private let accounts: AccountsStore
    private let api: MantaAPIClient
    private let defaults: UserDefaults
    private var current: SignInAttempt?
    private var startedAt = Date()
    private var pollTask: Task<Void, Never>?
    private var pendingTeardown: Task<Void, Never>?
    private var begun = false
    /// Cancel / Close / the sheet going away has happened: nothing may start again.
    private var closed = false

    init(request: AccountsSignInRequest, accounts: AccountsStore, defaults: UserDefaults = .standard) {
        self.request = request
        self.accounts = accounts
        self.api = accounts.api
        self.defaults = defaults
    }

    // MARK: Derived

    private var provider: String {
        switch request.mode {
        case .add(let provider, _, _), .resign(let provider, _, _, _, _): return provider
        }
    }

    var providerLabel: String { AccountsSelectors.providerName(provider) }

    /// Who writes a device flow's instructions (the disclosure's title).
    var deviceMessageSource: String { provider == "codex" ? "ChatGPT" : providerLabel }

    /// The account a seat is being added to (named in the different-org prompt).
    var targetAccountLabel: String? {
        if case .add(_, _, let label) = request.mode { return label }
        return nil
    }

    private var isResign: Bool {
        if case .resign = request.mode { return true }
        return false
    }

    private var resignSeatLabel: String {
        if case .resign(_, _, let label, _, _) = request.mode { return label }
        return ""
    }

    var title: String {
        switch request.mode {
        case .add(_, let accountId, let accountLabel):
            return AccountsSignInCopy.addTitle(providerLabel: providerLabel, accountLabel: accountLabel, addingToAccount: accountId != nil)
        case .resign(_, _, let seatLabel, _, _):
            return AccountsSignInCopy.resignTitle(seatLabel: seatLabel)
        }
    }

    /// The line under the title in the re-sign sheet ("Work · a@x.com").
    var subtitle: String? {
        guard case .resign(_, _, _, let accountLabel, let email) = request.mode else { return nil }
        let account = (accountLabel?.isEmpty == false) ? "\(accountLabel ?? "") · " : ""
        return account + ((email?.isEmpty == false) ? (email ?? "") : "email unknown")
    }

    var lead: String? {
        guard case .resign(_, _, let seatLabel, _, let email) = request.mode else { return nil }
        return AccountsSignInCopy.resignLead(seatLabel: seatLabel, email: email)
    }

    /// While a sign-in is open on the box a stray swipe must not throw away a
    /// sign-in whose link the user is about to paste.
    var isOpen: Bool {
        switch phase {
        case .starting, .claude, .device, .differentOrg: return true
        case .tosNote, .done, .failed: return false
        }
    }

    // MARK: Entry points

    func begin() {
        guard !begun else { return }
        begun = true
        if case .add(let provider, let accountId, _) = request.mode {
            let count = accounts.provider(provider)?.accounts.count ?? 0
            if AccountsSignInRules.needsTosNote(accountCount: count, acknowledged: defaults.bool(forKey: Self.tosAckKey), addingAccount: accountId == nil) {
                phase = .tosNote
                return
            }
        }
        launchStart()
    }

    func acknowledgeTerms() {
        defaults.set(true, forKey: Self.tosAckKey)
        phase = .starting
        launchStart()
    }

    /// Try again: the old attempt is released first (awaited), then a new one starts.
    func retry() {
        phase = .starting
        launchStart()
    }

    private func launchStart() {
        Task { await runStart() }
    }

    // MARK: Starting an attempt

    private func runStart() async {
        // 1. Release the previous attempt BEFORE allocating anything new.
        if let old = current {
            current = nil
            stopLocalWork()
            beginTeardown(old)
        }
        await pendingTeardown?.value
        // Cancel / Close during the old attempt's release: a closed flow starts
        // nothing (it would allocate a seat / flow on the box with no UI).
        guard !closed else { return }

        let attempt = SignInAttempt()
        current = attempt
        startedAt = Date()
        phase = .starting
        inlineError = nil

        // 2. Ask the box to start the sign-in. Record what it allocated as soon
        // as the reply arrives, before anything else can be awaited.
        var connect: SignInConnect?
        switch request.mode {
        case .add(let provider, let accountId, _):
            let reply: AddSeatReply
            do {
                reply = try await api.accountsAddSeat(provider: provider, accountId: accountId)
            } catch {
                guard SignInAttemptGate.accepts(resultFor: attempt.id, current: current?.id) else { return }
                current = nil
                phase = .failed(AccountsSignInCopy.startFailure(error, resign: false))
                return
            }
            guard SignInAttemptGate.accepts(resultFor: attempt.id, current: current?.id) else {
                // Cancelled or retired while the start was in flight: give the seat back.
                beginTeardown(SignInAttempt(seatId: reply.seatId))
                return
            }
            current?.seatId = reply.seatId
            connect = SignInConnect(json: reply.connect)

        case .resign(let provider, let seatId, _, _, _):
            let reply: ResignSeatReply
            do {
                reply = try await api.accountsResignSeat(provider: provider, seatId: seatId)
            } catch {
                guard SignInAttemptGate.accepts(resultFor: attempt.id, current: current?.id) else { return }
                current = nil
                phase = .failed(AccountsSignInCopy.startFailure(error, resign: true))
                return
            }
            guard SignInAttemptGate.accepts(resultFor: attempt.id, current: current?.id) else {
                beginTeardown(SignInAttempt(flowId: reply.flowId))
                return
            }
            current?.flowId = reply.flowId
            connect = SignInConnect(json: reply.connect)
        }

        // 3. Drive the sign-in the box asked for.
        guard let connect, let sign = SignInPhase.from(connect) else {
            failAndTeardown(attempt.id, AccountsSignInCopy.cantStartFromHere)
            return
        }
        switch sign {
        case .device(let url, let instructions):
            phase = .device(url: url, instructions: instructions, startedAt: startedAt)
            startPolling(attempt.id)
        case .claude(let key, let cwd):
            await startClaude(attempt.id, key: key, cwd: cwd)
        }
    }

    private func startClaude(_ id: UUID, key: String, cwd: String) async {
        guard accounts.hasEventStream else {
            failAndTeardown(id, AccountsSignInCopy.noEventStream)
            return
        }
        current?.loginSessionKey = key
        let session = ClaudeLoginSession(
            sessionKey: key, cwd: cwd, api: api, events: accounts.ptyEvents,
            onFailedExit: { [weak self] in
                guard let self else { return }
                self.failAndTeardown(id, self.badCodeMessage)
            },
            onLinkTimeout: { [weak self] in
                self?.failAndTeardown(id, AccountsSignInCopy.linkDidNotAppear)
            }
        )
        claudeSession = session
        phase = .claude
        // The spawn is about to be sent: from here the login has a pty to kill.
        current?.loginSpawned = true
        do {
            try await session.start()
        } catch {
            failAndTeardown(id, Self.spawnFailureText(error))
            return
        }
        guard SignInAttemptGate.accepts(resultFor: id, current: current?.id) else { return }
        startPolling(id)
    }

    private var badCodeMessage: String {
        isResign ? AccountsSignInCopy.resignBadCode(seatLabel: resignSeatLabel) : AccountsSignInCopy.badCode
    }

    private static func spawnFailureText(_ error: Error) -> String {
        if case MantaError.server(let message) = error, !message.isEmpty { return message }
        return AccountsSignInCopy.startUnreachable
    }

    // MARK: Polling

    private func startPolling(_ id: UUID) {
        pollTask?.cancel()
        let began = startedAt
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: SignInClock.seatPollInterval)
                guard !Task.isCancelled, let self else { return }
                if await self.pollOnce(id, startedAt: began) { return }
            }
        }
    }

    /// One reading. Returns true when polling is over (settled, failed, stale).
    private func pollOnce(_ id: UUID, startedAt began: Date) async -> Bool {
        guard SignInAttemptGate.accepts(resultFor: id, current: current?.id), let attempt = current else { return true }
        let now = Date()
        let expired = SignInClock.isExpired(startedAt: began, now: now, limit: SignInClock.clientLimit)

        switch request.mode {
        case .add:
            guard let seatId = attempt.seatId else { return true }
            var reply: SeatStatusReply?
            do { reply = try await api.accountsSeatStatus(seatId: seatId) } catch { reply = nil }
            guard SignInAttemptGate.accepts(resultFor: id, current: current?.id) else { return true }
            switch SignInPollRules.decideSeat(reply: reply, expired: expired) {
            case .keepPolling:
                return false
            case .abandon(let unreachable):
                failAndTeardown(id, unreachable ? AccountsSignInCopy.unreachableAtDeadline : AccountsCopy.fallback)
                return true
            case .added(let seat):
                // The box placed it: nothing left to release.
                current?.seatId = nil
                await finishAdded(id, seatId: seat?.id ?? seatId, fallbackLabel: seat?.label ?? "the new seat", newAccount: false)
                return true
            case .differentOrg(let org):
                // Parked: the box holds the login until the user picks.
                stopLocalWork()
                current?.parked = true
                phase = .differentOrg(orgName: org, busy: false)
                return true
            case .failed(let message):
                // The box already dropped it.
                stopLocalWork()
                current = nil
                phase = .failed(message ?? AccountsCopy.fallback)
                return true
            }

        case .resign(_, _, let seatLabel, _, let email):
            guard let flowId = attempt.flowId else { return true }
            var reply: ResignStatusReply?
            do { reply = try await api.accountsResignStatus(flowId: flowId) } catch { reply = nil }
            guard SignInAttemptGate.accepts(resultFor: id, current: current?.id) else { return true }
            switch SignInPollRules.decideResign(reply: reply, expired: expired) {
            case .keepPolling:
                return false
            case .abandon(let unreachable):
                failAndTeardown(id, unreachable ? AccountsSignInCopy.resignUnreachable(seatLabel: seatLabel) : AccountsCopy.fallback)
                return true
            case .signedBack(let seat):
                current?.flowId = nil
                await finishResigned(id, message: AccountsSignInCopy.resignDone(email: seat?.email ?? email, seatLabel: seat?.label ?? seatLabel))
                return true
            case .failed(let message):
                stopLocalWork()
                current = nil
                phase = .failed(message ?? AccountsCopy.fallback)
                return true
            }
        }
    }

    // MARK: Finishing

    private func finishAdded(_ id: UUID, seatId: String, fallbackLabel: String, newAccount: Bool) async {
        // Not `stopLocalWork()`: this may be running INSIDE the poll task, and
        // cancelling it would make the list refresh below fail as cancelled.
        stopClaudeSession()
        // The new seat is on screen before the sheet closes.
        var list: [AccountsProvider]
        do {
            list = try await accounts.freshProviders()
        } catch {
            await accounts.refresh()
            list = accounts.providers
        }
        guard SignInAttemptGate.accepts(resultFor: id, current: current?.id) else { return }
        var addingToAccount = false
        if case .add(_, let accountId, _) = request.mode { addingToAccount = accountId != nil && !newAccount }
        let message = AccountsSignInCopy.addedMessage(
            addingToAccount: addingToAccount,
            found: SignInSeatLocation.find(seatId: seatId, provider: provider, in: list),
            fallbackLabel: fallbackLabel,
            providerLabel: providerLabel
        )
        current = nil
        phase = .done(message)
        // The new seat's models may be new to the picker.
        ProviderChange.announce()
        accounts.announce(message)
        shouldDismiss = true
    }

    private func finishResigned(_ id: UUID, message: String) async {
        guard SignInAttemptGate.accepts(resultFor: id, current: current?.id) else { return }
        stopClaudeSession()
        // The outcome is settled on the box: report it NOW, so swiping the sheet
        // away during the hold cannot drop the banner or the picker's notice,
        // and a later disappear has nothing left to tear down.
        current = nil
        phase = .done(message)
        ProviderChange.announce()
        accounts.announce(message)
        // Then hold the confirmation while the list shows the seat healthy again.
        let held = Date()
        await accounts.refresh()
        let remaining = 1.5 - Date().timeIntervalSince(held)
        if remaining > 0 { try? await Task.sleep(for: .seconds(remaining)) }
        shouldDismiss = true
    }

    // MARK: Different organisation (F1)

    func createNewAccount() async {
        guard case .differentOrg(let org, let busy) = phase, !busy,
              let attempt = current, let seatId = attempt.seatId else { return }
        phase = .differentOrg(orgName: org, busy: true)
        inlineError = nil
        do {
            _ = try await api.accountsAddSeatConfirm(seatId: seatId, newAccount: true)
            guard SignInAttemptGate.accepts(resultFor: attempt.id, current: current?.id) else { return }
            current?.seatId = nil
            current?.parked = false
            await finishAdded(attempt.id, seatId: seatId, fallbackLabel: org ?? "the new account", newAccount: true)
        } catch {
            guard SignInAttemptGate.accepts(resultFor: attempt.id, current: current?.id) else { return }
            phase = .differentOrg(orgName: org, busy: false)
            inlineError = AccountsCopy.failure("create the account", error)
        }
    }

    // MARK: Failure, cancel, disappear

    /// A client-side failure: show it and release everything the attempt allocated.
    private func failAndTeardown(_ id: UUID, _ message: String) {
        guard SignInAttemptGate.accepts(resultFor: id, current: current?.id), let attempt = current else { return }
        stopLocalWork()
        current = nil
        phase = .failed(message)
        beginTeardown(attempt)
    }

    /// Queue a teardown behind any earlier one, so a retry can wait for it.
    private func beginTeardown(_ attempt: SignInAttempt) {
        guard !attempt.teardownPlan().isEmpty else { return }
        let api = self.api
        let previous = pendingTeardown
        pendingTeardown = Task { @MainActor in
            await previous?.value
            _ = await SignInTeardown.run(attempt, api: api)
        }
    }

    private func stopLocalWork() {
        pollTask?.cancel()
        pollTask = nil
        stopClaudeSession()
    }

    private func stopClaudeSession() {
        claudeSession?.stop()
        claudeSession = nil
    }

    /// The explicit Cancel: tell the box, report BOTH outcomes, close.
    func cancel() async {
        guard !cancelling else { return }
        closed = true
        cancelling = true
        stopLocalWork()
        await pendingTeardown?.value
        let attempt = current
        current = nil
        var hadResources = false
        var cleanupFailed = false
        if let attempt, !attempt.teardownPlan().isEmpty {
            hadResources = true
            cleanupFailed = !(await SignInTeardown.run(attempt, api: api))
        }
        if hadResources {
            let seatLabel = resignSeatLabel
            if cleanupFailed {
                accounts.announce(isResign ? AccountsSignInCopy.resignCancelFailed(seatLabel: seatLabel) : AccountsSignInCopy.cancelFailed, isError: true)
            } else {
                accounts.announce(isResign ? AccountsSignInCopy.resignCancelled(seatLabel: seatLabel) : "Sign-in cancelled.")
            }
        }
        cancelling = false
        shouldDismiss = true
    }

    /// The sheet went away with the flow still open (the parent screen popped,
    /// the app dismissed it): best-effort cleanup, logged — not a user action.
    func abandonIfOpen() {
        closed = true
        stopLocalWork()
        guard let attempt = current else { return }
        current = nil
        guard !attempt.teardownPlan().isEmpty else { return }
        let api = self.api
        Task { @MainActor in
            if await SignInTeardown.run(attempt, api: api) == false {
                NSLog("[accounts] cleanup after the sign-in sheet went away did not finish; the box will expire it")
            }
        }
    }
}
