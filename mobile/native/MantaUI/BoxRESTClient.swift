import Foundation

// ===========================================================================
// WS10 — the few box calls that are plain REST (not `/rpc/<channel>`), plus the
// status-preserving RPC used only for `server:update-apply`.
//
//   GET    /auth/devices                 linked devices (F15 / F17)
//   DELETE /auth/revoke?device_id=<id>   sign ONE device out (F15 / F17)
//   POST   /api/upgrade/{retry|rollback} a failed box upgrade's actions (F19)
//   POST   /rpc/server:update-apply      via `rpcRaw` (F18)
//
// SAFETY: a phone must NEVER call `/auth/revoke` without a `device_id` — with no
// target the box resets the whole identity and drops EVERY device. The only
// revoke method here takes an id.
//
// Like `MantaAPIClient`, a `503 {upgrade:true}` answer posts `.mantaBoxUpgrading`
// so the upgrade screen takes over.
// ===========================================================================

struct BoxRESTClient: Sendable {
    let serverURL: URL
    private let tokenProvider: @Sendable () -> String?
    private let session: URLSession

    init(serverURL: URL,
         tokenProvider: @escaping @Sendable () -> String? = { KeychainCredentialStore.shared.boxToken },
         session: URLSession = .shared) {
        self.serverURL = serverURL
        self.tokenProvider = tokenProvider
        self.session = session
    }

    /// A client bound to the paired box in the Keychain. The fallback is an
    /// unreachable file URL: with no pairing there is nothing to call, and every
    /// request then fails as a transport error rather than reaching anywhere.
    static func live() -> BoxRESTClient {
        BoxRESTClient(serverURL: KeychainCredentialStore.shared.serverURL ?? URL(fileURLWithPath: "/"))
    }

    // MARK: - Devices

    /// `GET /auth/devices`. A 401 (this phone's token is already dead) throws
    /// `MantaError.authRequired`; the caller decides what that means.
    func devices() async throws -> BoxDevicesResponse {
        var request = URLRequest(url: serverURL.appendingPathComponent("auth").appendingPathComponent("devices"))
        request.httpMethod = "GET"
        request.timeoutInterval = 15
        applyBearer(&request)
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode
        noteUpgradeRefusal(status: status, body: data)
        if status == 401 { throw MantaError.authRequired }
        if let status, status >= 400 { throw MantaError.server("HTTP \(status)") }
        guard let decoded = try? JSONDecoder().decode(BoxDevicesResponse.self, from: data) else {
            throw MantaError.transport("unrecognised device list")
        }
        return decoded
    }

    /// `DELETE /auth/revoke?device_id=<id>` — sign exactly one device out.
    /// Returns the HTTP status (nil when no answer arrived) and whether the
    /// request failed at the transport level; `BoxRemoval.classify` reads both.
    ///
    /// An empty / blank id is NEVER sent: the box reads a missing OR empty
    /// `device_id` as "no target" and runs the whole-box reset that drops every
    /// device. Refusing here protects every caller; it reports as a transport
    /// failure (nothing was revoked).
    func revokeDevice(id: String) async -> (status: Int?, transportError: Bool) {
        guard BoxDevices.isRevocableID(id) else { return (nil, true) }
        guard var parts = URLComponents(url: serverURL.appendingPathComponent("auth").appendingPathComponent("revoke"),
                                        resolvingAgainstBaseURL: false) else {
            return (nil, true)
        }
        parts.queryItems = [URLQueryItem(name: "device_id", value: id)]
        guard let url = parts.url else { return (nil, true) }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.timeoutInterval = 15
        applyBearer(&request)
        do {
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode
            noteUpgradeRefusal(status: status, body: data)
            return (status, false)
        } catch {
            return (nil, true)
        }
    }

    // MARK: - Upgrade actions

    /// `POST /api/upgrade/retry` / `/rollback` → `{ok}` or `{ok:false, error}`.
    /// Never throws: every failure is a result the screen can show.
    func upgradeAction(_ action: UpgradeAction) async -> UpgradeActionResult {
        var request = URLRequest(url: serverURL
            .appendingPathComponent("api").appendingPathComponent("upgrade").appendingPathComponent(action.rawValue))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        applyBearer(&request)
        do {
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode
            if status == 401 { return UpgradeActionResult(ok: false, error: UpdateFlow.revokedMessage) }
            if let status, !(200..<300).contains(status) {
                return UpgradeActionResult(ok: false, error: "HTTP \(status)")
            }
            guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let ok = object["ok"] as? Bool else {
                return UpgradeActionResult(ok: false, error: "The box sent an answer this app couldn't read.")
            }
            return UpgradeActionResult(ok: ok, error: object["error"] as? String)
        } catch {
            return UpgradeActionResult(ok: false, error: error.localizedDescription)
        }
    }

    // MARK: - Status-preserving RPC

    /// POST `/rpc/<channel>` and hand back the status + body UNINTERPRETED. Used
    /// only for `server:update-apply`: the box restarts itself as the last step of
    /// a successful update, so the HTTP status (a proxy's 502 vs the box's own
    /// 500) is the only thing that tells success-by-restart from failure.
    func rpcRaw(channel: String, args: [Any], timeout: TimeInterval) async -> RawRPCResponse {
        do {
            var request = try MantaAPIClient.makeRequest(
                serverURL: serverURL, channel: channel, args: args, token: tokenProvider())
            request.timeoutInterval = timeout
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode
            noteUpgradeRefusal(status: status, body: data)
            return RawRPCResponse(status: status, body: data)
        } catch let error as URLError {
            return RawRPCResponse(
                status: nil,
                transportError: TransportFailure(code: error.code.rawValue, message: error.localizedDescription))
        } catch {
            return RawRPCResponse(
                status: nil,
                transportError: TransportFailure(code: 0, message: error.localizedDescription))
        }
    }

    // MARK: - Helpers

    private func applyBearer(_ request: inout URLRequest) {
        if let token = tokenProvider(), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
    }

    private func noteUpgradeRefusal(status: Int?, body: Data) {
        if let status, UpgradeStatus.isUpgradeRefusal(statusCode: status, body: body) {
            NotificationCenter.default.post(name: .mantaBoxUpgrading, object: nil)
        }
    }
}
