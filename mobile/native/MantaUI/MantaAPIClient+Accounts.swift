import Foundation

// ===========================================================================
// WS08 — the RPC members behind sign-in flows, provider connections and custom
// endpoints (C1: this area's members live in their own file; nobody else edits
// `MantaAPIClient.swift`). Wire types are in `AccountsModels.swift`,
// `ProviderConnectionModels.swift` and `ProviderEndpointModels.swift`.
//
// Every channel reuses the one the desktop calls, and sends its payload the way
// the box dispatches it (`fn(...args)`): a single object for the `accounts:*`
// and `opencode:provider-auth` channels, POSITIONAL arguments for the three
// `pty:*` channels, `claude:login-cancel` and `opencode:discover-models` (an
// object there silently probes `""`).
// ===========================================================================

extension MantaAPIClient {

    // MARK: - Re-sign a seat

    /// `accounts:resign-seat` — start signing a logged-out seat back in. The box
    /// refuses the live seat (`live-seat`).
    func accountsResignSeat(provider: String, seatId: String) async throws -> ResignSeatReply {
        let object = try await callRequired("accounts:resign-seat", args: [["provider": provider, "seatId": seatId]], as: [String: JSONValue].self)
        if case .string(let code)? = object["error"], !code.isEmpty { throw MantaError.server(code) }
        guard case .string(let flowId)? = object["flowId"], !flowId.isEmpty else {
            throw MantaError.transport("accounts:resign-seat returned no flow")
        }
        return ResignSeatReply(flowId: flowId, connect: object["connect"])
    }

    /// `accounts:resign-status` — poll a re-sign.
    func accountsResignStatus(flowId: String) async throws -> ResignStatusReply {
        try await callRequired("accounts:resign-status", args: [["flowId": flowId]], as: ResignStatusReply.self)
    }

    /// `accounts:resign-cancel` — drop a re-sign's scratch login.
    func accountsResignCancel(flowId: String) async throws {
        _ = try await callVoid("accounts:resign-cancel", args: [["flowId": flowId]])
    }

    // MARK: - Health, retry, probe

    /// `accounts:health` — never throws on the box (an unwired engine answers
    /// empty maps).
    func accountsHealth() async throws -> AccountsHealth {
        try await callRequired("accounts:health", args: [], as: AccountsHealth.self)
    }

    /// `accounts:retry` — the out-of-credit "Try again". The message is never empty.
    func accountsRetry(providerID: String) async throws -> AccountsRetryReply {
        try await callRequired("accounts:retry", args: [["providerID": providerID]], as: AccountsRetryReply.self)
    }

    /// `accounts:endpoint-probe` — run one endpoint's probe now.
    func accountsEndpointProbe(endpointKey: String) async throws -> EndpointProbeReply {
        try await callRequired("accounts:endpoint-probe", args: [["endpointKey": endpointKey]], as: EndpointProbeReply.self)
    }

    // MARK: - Subscription connections (`opencode:provider-auth`)

    /// `{action:"status"}` — every subscription provider and whether it is connected.
    func providerAuthStatus() async throws -> [SubscriptionStatus] {
        try await callRequired("opencode:provider-auth", args: [["action": "status"]], as: ProviderAuthStatusReply.self).providers
    }

    /// `{action:"start", id}` — begin connecting a provider; the reply names the
    /// shape of the sign-in.
    func providerAuthStart(id: String) async throws -> ProviderAuthStartReply {
        try await callRequired("opencode:provider-auth", args: [["action": "start", "id": id]], as: ProviderAuthStartReply.self)
    }

    /// `{action:"code", id, methodIndex, code}` — hand back a code pasted from an OAuth page.
    func providerAuthCode(id: String, methodIndex: Int, code: String) async throws -> ProviderAuthOkReply {
        try await callRequired("opencode:provider-auth", args: [["action": "code", "id": id, "methodIndex": methodIndex, "code": code]], as: ProviderAuthOkReply.self)
    }

    /// `{action:"key", id, key}` — save an API key. The key is never returned or logged.
    func providerAuthKey(id: String, key: String) async throws -> ProviderAuthOkReply {
        try await callRequired("opencode:provider-auth", args: [["action": "key", "id": id, "key": key]], as: ProviderAuthOkReply.self)
    }

    /// `{action:"disconnect", id}` — the box removes the credential and restarts opencode.
    func providerAuthDisconnect(id: String) async throws -> ProviderAuthOkReply {
        try await callRequired("opencode:provider-auth", args: [["action": "disconnect", "id": id]], as: ProviderAuthOkReply.self)
    }

    /// `{action:"claude-status", sessionKey, startedAt}` — has the Claude login landed?
    func providerAuthClaudeStatus(sessionKey: String, startedAt: Double) async throws -> ClaudeStatusReply {
        try await callRequired("opencode:provider-auth", args: [["action": "claude-status", "sessionKey": sessionKey, "startedAt": startedAt]], as: ClaudeStatusReply.self)
    }

    /// `{action:"oauth-status", id}` — the device-code wait's outcome.
    func providerAuthOauthStatus(id: String) async throws -> OauthStatusReply {
        try await callRequired("opencode:provider-auth", args: [["action": "oauth-status", "id": id]], as: OauthStatusReply.self)
    }

    /// `{action:"oauth-cancel", id}` — abandon a device wait. Provider-wide: only
    /// ever called through `ProviderOAuthLease`.
    func providerAuthOauthCancel(id: String) async throws {
        _ = try await callVoid("opencode:provider-auth", args: [["action": "oauth-cancel", "id": id]])
    }

    /// `opencode:claude-cli-status` — is the `claude` CLI on the box?
    func providerClaudeCliStatus() async throws -> ClaudeCliStatus {
        try await callRequired("opencode:claude-cli-status", args: [], as: ClaudeCliStatus.self)
    }

    /// `claude:login-cancel` — drop the box's record of a Claude login
    /// (positional session key). The pty itself is killed with `signInPtyKill`.
    func providerClaudeLoginCancel(sessionKey: String) async throws {
        _ = try await callVoid("claude:login-cancel", args: [sessionKey])
    }

    // MARK: - Sign-in pty (`pty:*`, over the RPC — never the /pty socket)

    /// `pty:spawn` — start a sign-in launcher (`claude-auth-login`,
    /// `claude-cli-install`). Output and exit come back as `kind:"pty"` bus
    /// frames. A refusal ("This sign-in has expired…") is thrown.
    func signInPtySpawn(sessionKey: String, cwd: String, cols: Int, rows: Int, launcherId: String) async throws {
        let options: [String: Any] = [
            "sessionKey": sessionKey,
            "cwd": cwd,
            "cols": cols,
            "rows": rows,
            "launcher": ["id": launcherId, "flags": [String: Any]()],
        ]
        _ = try await callVoid("pty:spawn", args: [options])
    }

    /// `pty:write` — positional `(sessionKey, data)`.
    func signInPtyWrite(sessionKey: String, data: String) async throws {
        _ = try await callVoid("pty:write", args: [sessionKey, data])
    }

    /// `pty:kill` — positional `(sessionKey)`.
    func signInPtyKill(sessionKey: String) async throws {
        _ = try await callVoid("pty:kill", args: [sessionKey])
    }

    // MARK: - Custom endpoints

    /// `opencode:get-providers` — the custom endpoints (the key itself never comes back).
    func providerEndpoints() async throws -> [ProviderEndpoint] {
        try await callRequired("opencode:get-providers", args: [], as: LenientArray<ProviderEndpoint>.self).elements
    }

    /// `opencode:set-providers` — upsert and/or remove endpoints. Empty arrays
    /// are omitted; an upsert's `apiKey` is omitted when nil (the box keeps the
    /// stored key). Not atomic — see `EndpointWriteReconcile`.
    func providerSetEndpoints(upsert: [ProviderEndpointInput], remove: [String]) async throws -> ProviderWriteReply {
        var payload: [String: Any] = [:]
        if !upsert.isEmpty { payload["upsert"] = upsert.map { $0.payload() } }
        if !remove.isEmpty { payload["remove"] = remove }
        return try await callRequired("opencode:set-providers", args: [payload], as: ProviderWriteReply.self)
    }

    /// `opencode:discover-models` — list an endpoint's models from the box's
    /// network view. POSITIONAL `(baseURL, apiKey)`; an empty key makes the box
    /// use the stored one.
    func providerDiscoverModels(baseURL: String, apiKey: String) async throws -> DiscoverResult {
        try await callRequired("opencode:discover-models", args: [baseURL, apiKey], as: DiscoverResult.self)
    }
}
