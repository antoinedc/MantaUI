import Combine
import Foundation

// ===========================================================================
// WS08 — connect a subscription provider (Claude / Codex / Kimi), the iPhone
// twin of the Mac app's `ConnectProvider`.
//
//   starting → waiting (device code) | needsCode | needsKey
//            | needsClaudeLogin | installingClaudeCli → applying → done | failed
//
// Every start is a new `SignInAttempt`; every continuation asks
// `SignInAttemptGate` before it touches state; every failure, retry, cancel and
// disappearance releases exactly what the attempt allocated (`teardownPlan`).
// The provider-wide device wait goes through `ProviderOAuthLease`, so a late
// cancel of an old attempt can never cancel a newer attempt's wait.
//
// Claude is driven through the `pty:*` RPCs and the `kind:"pty"` bus frames
// (`ClaudeLoginSession`) — never the `/pty` socket, which would bypass the guard
// that stops a login from replacing the box's live credentials.
// ===========================================================================

struct ConnectSheetRequest: Identifiable, Equatable {
    let id = UUID()
    let status: SubscriptionStatus
}

@MainActor
final class ProviderConnectFlow: ObservableObject {

    @Published private(set) var phase: ProviderConnectPhase = .starting
    @Published private(set) var claudeSession: ClaudeLoginSession?
    /// "Closing the previous sign-in…": this start waits for an earlier attempt's cleanup.
    @Published private(set) var waitingForPrevious = false
    @Published private(set) var cancelling = false
    @Published private(set) var shouldDismiss = false
    /// The code / key is being sent.
    @Published private(set) var submitting = false
    /// The last code / key refusal, shown under its field.
    @Published private(set) var fieldError: String?
    /// When the device wait started (the countdown's origin).
    @Published private(set) var waitStartedAt = Date()
    /// The pasted code / typed key. Lives only here: cleared when it is sent and
    /// when the flow ends. Never logged.
    @Published var codeDraft = ""
    @Published var keyDraft = ""

    let status: SubscriptionStatus

    private let accounts: AccountsStore
    private let connections: ProviderConnectionsStore
    private let api: MantaAPIClient
    private let lease: ProviderOAuthLease
    private var current: SignInAttempt?
    private var pollTask: Task<Void, Never>?
    private var installSubscription: AnyCancellable?
    private var installerExited = false
    private var pendingTeardown: Task<Void, Never>?
    private var begun = false
    /// Cancel / Close / the sheet going away has happened: nothing may start again.
    private var closed = false

    init(status: SubscriptionStatus, accounts: AccountsStore, connections: ProviderConnectionsStore,
         lease: ProviderOAuthLease = ProviderOAuthLease.shared) {
        self.status = status
        self.accounts = accounts
        self.connections = connections
        self.api = accounts.api
        self.lease = lease
    }

    var title: String { ProviderConnectCopy.title(label: status.displayName) }
    var phaseLabel: String { ProviderConnectCopy.phaseLabel(phase) }

    /// Who writes a device flow's instructions (the disclosure's title).
    var deviceMessageSource: String { status.id == "openai" ? "ChatGPT" : status.displayName }

    /// While a sign-in is in progress a stray swipe must not throw it away.
    var isOpen: Bool {
        switch phase {
        case .done, .failed: return false
        default: return true
        }
    }

    // MARK: Entry points

    func begin() {
        guard !begun else { return }
        begun = true
        // The one production transport for the provider-wide cancel; the lease
        // turns a thrown error into a result the caller can report.
        let api = self.api
        lease.configure(cancel: { id in try await api.providerAuthOauthCancel(id: id) })
        launchStart()
    }

    func retry() {
        phase = .starting
        fieldError = nil
        launchStart()
    }

    private func launchStart() {
        Task { await runStart() }
    }

    // MARK: Starting an attempt

    private func runStart() async {
        // Release the previous attempt (awaited) BEFORE allocating anything new.
        if let old = current {
            current = nil
            stopLocalWork()
            beginTeardown(old)
        }
        await pendingTeardown?.value
        // The user may have pressed Cancel / Close while the old attempt was
        // being released: a closed flow starts nothing (it would run with no UI
        // and, for a device wait, own the provider-wide slot forever).
        guard !closed else { return }

        let attempt = SignInAttempt()
        current = attempt
        phase = .starting
        fieldError = nil
        // The device-wait slot is provider-wide: this attempt owns it from the
        // moment it asks, so a retire during the start goes through the lease.
        current?.oauthProviderId = status.id
        waitingForPrevious = true

        let reply: ProviderAuthStartReply?
        let startAPI = api
        let providerId = status.id
        do {
            reply = try await lease.start(provider: providerId, attempt: attempt.id) {
                // This attempt's turn: any earlier attempt's cleanup has finished.
                self.waitingForPrevious = false
                return try await startAPI.providerAuthStart(id: providerId)
            }
        } catch {
            waitingForPrevious = false
            lease.settled(provider: status.id, attempt: attempt.id)
            guard SignInAttemptGate.accepts(resultFor: attempt.id, current: current?.id) else { return }
            current = nil
            phase = .failed(ProviderConnectCopy.startUnreachable, claudeInstall: false)
            return
        }
        waitingForPrevious = false
        // Retired while waiting for its turn: the lease already dropped it.
        guard let reply else { return }

        guard SignInAttemptGate.accepts(resultFor: attempt.id, current: current?.id) else {
            // Cancelled or retired while the start was in flight. A device wait
            // is cancelled by the lease (its retire). A Claude login registration
            // is not: release it here.
            if reply.shape == .claudeLogin, let key = reply.sessionKey, !key.isEmpty {
                beginTeardown(SignInAttempt(loginSessionKey: key))
            }
            if reply.shape == .oauthAuto {
                // Idempotent: a no-op when the retire already happened or this
                // attempt no longer owns the slot.
                let lease = self.lease
                let providerId = status.id
                let attemptId = attempt.id
                Task { @MainActor in
                    if case .failure(let error) = await lease.retire(provider: providerId, attempt: attemptId) {
                        NSLog("[accounts] cleanup of a late device start failed: %@", String(describing: error))
                    }
                }
            }
            if reply.shape != .oauthAuto { lease.settled(provider: status.id, attempt: attempt.id) }
            return
        }

        switch reply.shape {
        case .claudeLogin:
            // Claude never fills the device slot.
            lease.settled(provider: status.id, attempt: attempt.id)
            current?.oauthProviderId = nil
            guard let key = reply.sessionKey, !key.isEmpty else {
                failAndTeardown(attempt.id, ProviderConnectCopy.cantStartKind)
                return
            }
            current?.loginSessionKey = key
            let cwd = (reply.cwd?.isEmpty == false) ? (reply.cwd ?? "~") : "~"
            let startedAt = reply.startedAt ?? Date().timeIntervalSince1970 * 1000
            await beginClaude(attempt.id, key: key, cwd: cwd, serverStartedAt: startedAt)

        case .oauthAuto:
            waitStartedAt = Date()
            phase = .waiting(url: reply.url ?? "", instructions: reply.instructions ?? "")
            startDevicePolling(attempt.id)

        case .oauthCode:
            lease.settled(provider: status.id, attempt: attempt.id)
            current?.oauthProviderId = nil
            phase = .needsCode(methodIndex: reply.methodIndex ?? 0, url: reply.url ?? "", instructions: reply.instructions ?? "", error: nil)

        case .apiKey:
            lease.settled(provider: status.id, attempt: attempt.id)
            current?.oauthProviderId = nil
            phase = .needsKey(consoleURL: status.console, error: nil)

        case .other:
            failAndTeardown(attempt.id, ProviderConnectCopy.cantStartKind)
        }
    }

    // MARK: Claude

    private func beginClaude(_ id: UUID, key: String, cwd: String, serverStartedAt: Double) async {
        // Is the `claude` CLI on the box? A failed probe falls through to the
        // sign-in (better to try than to block the whole flow on a probe).
        var installed = true
        do { installed = try await api.providerClaudeCliStatus().installed } catch {
            NSLog("[accounts] claude CLI probe failed: %@", String(describing: error))
        }
        guard SignInAttemptGate.accepts(resultFor: id, current: current?.id) else { return }
        if installed {
            await beginClaudeSignIn(id, key: key, cwd: cwd, serverStartedAt: serverStartedAt)
        } else {
            await beginInstall(id, loginKey: key, cwd: cwd, serverStartedAt: serverStartedAt)
        }
    }

    private func beginInstall(_ id: UUID, loginKey: String, cwd: String, serverStartedAt: Double) async {
        let installerKey = "claude-install-\(Int(Date().timeIntervalSince1970 * 1000))"
        current?.installerKey = installerKey
        installerExited = false
        phase = .installingClaudeCli(installerKey: installerKey, loginSessionKey: loginKey, cwd: cwd, startedAt: Date())
        // Watch for the installer exiting without a binary (when the bus is there).
        installSubscription = accounts.ptyEvents
            .filter { SignInAttemptGate.accepts(ptyEventKey: $0.sessionKey, attemptKey: installerKey) }
            .sink { [weak self] event in
                guard case .exit = event.kind else { return }
                MainActor.assumeIsolated { self?.installerExited = true }
            }
        do {
            try await api.signInPtySpawn(
                sessionKey: installerKey, cwd: cwd,
                cols: ProviderConnectRules.installerCols, rows: ProviderConnectRules.installerRows,
                launcherId: "claude-cli-install"
            )
        } catch {
            failAndTeardown(id, ProviderConnectCopy.installFailed, claudeInstall: true)
            return
        }
        guard SignInAttemptGate.accepts(resultFor: id, current: current?.id) else { return }
        startInstallPolling(id, installerKey: installerKey, loginKey: loginKey, cwd: cwd, serverStartedAt: serverStartedAt)
    }

    private func startInstallPolling(_ id: UUID, installerKey: String, loginKey: String, cwd: String, serverStartedAt: Double) {
        pollTask?.cancel()
        let began = Date()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: ProviderConnectRules.installPollInterval)
                guard !Task.isCancelled, let self else { return }
                if SignInClock.isExpired(startedAt: began, now: Date(), limit: ProviderConnectRules.installPollLimit) {
                    self.failAndTeardown(id, ProviderConnectCopy.installTimedOut, claudeInstall: true)
                    return
                }
                var installed = false
                var answered = false
                do {
                    installed = try await self.api.providerClaudeCliStatus().installed
                    answered = true
                } catch {
                    // The box may be briefly unreachable: keep polling.
                    NSLog("[accounts] claude CLI install poll failed: %@", String(describing: error))
                }
                guard SignInAttemptGate.accepts(resultFor: id, current: self.current?.id) else { return }
                if answered, installed {
                    // The binary is on disk: end the installer, then sign in with
                    // the login key minted at start.
                    do { try await self.api.signInPtyKill(sessionKey: installerKey) } catch {
                        NSLog("[accounts] couldn't end the installer pty: %@", String(describing: error))
                    }
                    guard SignInAttemptGate.accepts(resultFor: id, current: self.current?.id) else { return }
                    self.installSubscription = nil
                    self.current?.installerKey = nil
                    await self.beginClaudeSignIn(id, key: loginKey, cwd: cwd, serverStartedAt: serverStartedAt)
                    return
                }
                if self.installerExited, answered, !installed {
                    self.failAndTeardown(id, ProviderConnectCopy.installFailed, claudeInstall: true)
                    return
                }
            }
        }
    }

    private func beginClaudeSignIn(_ id: UUID, key: String, cwd: String, serverStartedAt: Double) async {
        guard accounts.hasEventStream else {
            failAndTeardown(id, AccountsSignInCopy.noEventStream)
            return
        }
        let session = ClaudeLoginSession(
            sessionKey: key, cwd: cwd, api: api, events: accounts.ptyEvents,
            onFailedExit: { [weak self] in
                self?.failAndTeardown(id, AccountsSignInCopy.badCode)
            },
            onLinkTimeout: { [weak self] in
                self?.failAndTeardown(id, AccountsSignInCopy.linkDidNotAppear)
            }
        )
        claudeSession = session
        phase = .needsClaudeLogin(sessionKey: key, cwd: cwd, startedAt: Date())
        // The spawn is about to be sent: from here the login has a pty to kill.
        current?.loginSpawned = true
        do {
            try await session.start()
        } catch {
            let text: String
            if case MantaError.server(let message) = error, !message.isEmpty { text = message } else { text = ProviderConnectCopy.startUnreachable }
            failAndTeardown(id, text)
            return
        }
        guard SignInAttemptGate.accepts(resultFor: id, current: current?.id) else { return }
        startClaudePolling(id, key: key, serverStartedAt: serverStartedAt)
    }

    private func startClaudePolling(_ id: UUID, key: String, serverStartedAt: Double) {
        pollTask?.cancel()
        let began = Date()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: ProviderConnectRules.claudePollInterval)
                guard !Task.isCancelled, let self else { return }
                if SignInClock.isExpired(startedAt: began, now: Date(), limit: ProviderConnectRules.claudePollLimit) {
                    self.failAndTeardown(id, ProviderConnectCopy.claudeTimedOut)
                    return
                }
                var reply: ClaudeStatusReply?
                do {
                    reply = try await self.api.providerAuthClaudeStatus(sessionKey: key, startedAt: serverStartedAt)
                } catch {
                    // The box may be briefly unreachable: keep polling.
                    reply = nil
                }
                guard SignInAttemptGate.accepts(resultFor: id, current: self.current?.id) else { return }
                guard let reply else { continue }
                switch ProviderConnectRules.next(after: .claudeStatus(reply)) {
                case .stay:
                    continue
                case .to(.failed(let message, _)):
                    self.failAndTeardown(id, message)
                    return
                case .to(.applying(let restarted)):
                    self.startApplying(id, restarted: restarted)
                    return
                case .to:
                    return
                }
            }
        }
    }

    // MARK: Device code (Codex)

    private func startDevicePolling(_ id: UUID) {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: ProviderConnectRules.devicePollInterval)
                guard !Task.isCancelled, let self else { return }
                var reply: OauthStatusReply?
                do {
                    reply = try await self.api.providerAuthOauthStatus(id: self.status.id)
                } catch {
                    reply = nil   // the box may be briefly unreachable: keep polling
                }
                guard SignInAttemptGate.accepts(resultFor: id, current: self.current?.id) else { return }
                guard let reply else { continue }
                switch ProviderConnectRules.next(after: .oauthStatus(reply)) {
                case .stay:
                    continue
                case .to(.applying(let restarted)):
                    // The wait is over on the box: free the slot without cancelling.
                    self.lease.settled(provider: self.status.id, attempt: id)
                    self.current?.oauthProviderId = nil
                    self.startApplying(id, restarted: restarted)
                    return
                case .to(.failed(let message, _)):
                    self.lease.settled(provider: self.status.id, attempt: id)
                    self.current?.oauthProviderId = nil
                    self.failAndTeardown(id, message)
                    return
                case .to:
                    return
                }
            }
        }
    }

    // MARK: Code / key

    /// `oauth-code`: hand back the code pasted from the page.
    func submitCode() async {
        guard case .needsCode(let methodIndex, let url, let instructions, _) = phase, !submitting,
              let attempt = current else { return }
        let code = codeDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty else { return }
        codeDraft = ""
        submitting = true
        fieldError = nil
        defer { submitting = false }
        do {
            let reply = try await api.providerAuthCode(id: status.id, methodIndex: methodIndex, code: code)
            guard SignInAttemptGate.accepts(resultFor: attempt.id, current: current?.id) else { return }
            if reply.ok {
                startApplying(attempt.id, restarted: false)
            } else {
                fieldError = ProviderConnectCopy.codeErrorText(reply.error)
                phase = .needsCode(methodIndex: methodIndex, url: url, instructions: instructions, error: fieldError)
            }
        } catch {
            guard SignInAttemptGate.accepts(resultFor: attempt.id, current: current?.id) else { return }
            fieldError = ProviderConnectCopy.startUnreachable
        }
    }

    /// `api-key`: save the key. The value is cleared as it is sent and is never
    /// logged or echoed.
    func submitKey() async {
        guard case .needsKey(let consoleURL, _) = phase, !submitting, let attempt = current else { return }
        let key = keyDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        keyDraft = ""
        submitting = true
        fieldError = nil
        defer { submitting = false }
        do {
            let reply = try await api.providerAuthKey(id: status.id, key: key)
            guard SignInAttemptGate.accepts(resultFor: attempt.id, current: current?.id) else { return }
            if reply.ok {
                startApplying(attempt.id, restarted: false)
            } else {
                fieldError = ProviderConnectCopy.keyErrorText(reply.error)
                phase = .needsKey(consoleURL: consoleURL, error: fieldError)
            }
        } catch {
            guard SignInAttemptGate.accepts(resultFor: attempt.id, current: current?.id) else { return }
            fieldError = ProviderConnectCopy.startUnreachable
        }
    }

    // MARK: Applying

    /// Restart opencode (unless the box already did) and wait for it to report
    /// the provider connected. The restart's own answer is not fatal: the 30 s
    /// readiness poll decides.
    private func startApplying(_ id: UUID, restarted: Bool) {
        claudeSession?.stop()
        claudeSession = nil
        installSubscription = nil
        pollTask?.cancel()
        phase = .applying(restarted: restarted)
        pollTask = Task { [weak self] in
            guard let self else { return }
            if !restarted {
                do {
                    let result = try await self.api.opencodeRestart()
                    if !result.ok { NSLog("[accounts] opencode restart answered not-ok: %@", result.error ?? "no reason") }
                } catch {
                    NSLog("[accounts] opencode restart failed: %@", String(describing: error))
                }
            }
            guard SignInAttemptGate.accepts(resultFor: id, current: self.current?.id) else { return }
            let began = Date()
            while !Task.isCancelled {
                try? await Task.sleep(for: ProviderConnectRules.applyPollInterval)
                guard !Task.isCancelled else { return }
                guard SignInAttemptGate.accepts(resultFor: id, current: self.current?.id) else { return }
                if SignInClock.isExpired(startedAt: began, now: Date(), limit: ProviderConnectRules.applyPollLimit) {
                    self.failAndTeardown(id, ProviderConnectCopy.didNotComeOnline)
                    return
                }
                var list: [SubscriptionStatus]?
                do {
                    list = try await self.api.providerAuthStatus()
                } catch {
                    list = nil   // keep polling
                }
                guard SignInAttemptGate.accepts(resultFor: id, current: self.current?.id) else { return }
                if let list, list.contains(where: { $0.id == self.status.id && $0.connected }) {
                    await self.finish(id)
                    return
                }
            }
        }
    }

    private func finish(_ id: UUID) async {
        guard SignInAttemptGate.accepts(resultFor: id, current: current?.id) else { return }
        current = nil
        keyDraft = ""
        codeDraft = ""
        phase = .done
        ProviderChange.announce()
        accounts.announce(ProviderConnectCopy.connected(label: status.displayName))
        shouldDismiss = true
        // Not `stopLocalWork()`: this runs inside the poll task, and cancelling
        // it would make the reads below fail as cancelled.
        await connections.load()
        await accounts.refresh()
    }

    // MARK: Failure, cancel, disappear

    private func failAndTeardown(_ id: UUID, _ message: String, claudeInstall: Bool = false) {
        guard SignInAttemptGate.accepts(resultFor: id, current: current?.id), let attempt = current else { return }
        stopLocalWork()
        current = nil
        keyDraft = ""
        codeDraft = ""
        phase = .failed(message, claudeInstall: claudeInstall)
        beginTeardown(attempt)
    }

    private func beginTeardown(_ attempt: SignInAttempt) {
        guard !attempt.teardownPlan().isEmpty else { return }
        let api = self.api
        let lease = self.lease
        let previous = pendingTeardown
        pendingTeardown = Task { @MainActor in
            await previous?.value
            if await SignInTeardown.run(attempt, api: api, lease: lease) == false {
                NSLog("[accounts] cleanup of an earlier connect attempt did not finish; the box will expire it")
            }
        }
    }

    private func stopLocalWork() {
        pollTask?.cancel()
        pollTask = nil
        claudeSession?.stop()
        claudeSession = nil
        installSubscription = nil
    }

    /// The explicit Cancel / Close: release what the attempt allocated, report a
    /// failure to do so, close.
    func cancel() async {
        guard !cancelling else { return }
        closed = true
        cancelling = true
        stopLocalWork()
        await pendingTeardown?.value
        let attempt = current
        current = nil
        keyDraft = ""
        codeDraft = ""
        if let attempt, !attempt.teardownPlan().isEmpty {
            if !(await SignInTeardown.run(attempt, api: api, lease: lease)) {
                accounts.announce(AccountsSignInCopy.cancelFailed, isError: true)
            }
        }
        cancelling = false
        shouldDismiss = true
    }

    /// The sheet went away with the flow still open: best-effort cleanup, logged.
    func abandonIfOpen() {
        closed = true
        stopLocalWork()
        keyDraft = ""
        codeDraft = ""
        guard let attempt = current else { return }
        current = nil
        guard !attempt.teardownPlan().isEmpty else { return }
        let api = self.api
        let lease = self.lease
        Task { @MainActor in
            if await SignInTeardown.run(attempt, api: api, lease: lease) == false {
                NSLog("[accounts] cleanup after the connect sheet went away did not finish; the box will expire it")
            }
        }
    }
}
