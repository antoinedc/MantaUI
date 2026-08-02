import Foundation

// ===========================================================================
// MantaPairing — the pure pairing/claim logic for the S2 onboarding joiner.
//
// This is a Swift port of the shared, tested pairing contract so the native
// client and the desktop/web clients can never disagree about what counts as a
// valid code or how an HTTP claim outcome maps to a user-facing result:
//   • src/shared/claim.mjs         — code normalization + classifyClaimResult
//   • src/shared/pairPayload.ts    — parsePairPayload / normalizeVerifyCode
//   • src/shared/setupLogic.ts     — boxDirectUrl / normalizeServerUrl
//   • src/server/auth.mjs          — the server contract this classifies
//
// Pure (no HTTP, no view, no Keychain) — unit-tested in MantaPairingTests.
// ===========================================================================

enum MantaPairing {

    // MARK: - Pairing code (claim.mjs)
    // A pairing code is exactly 6 decimal digits. normalizeCode strips every
    // non-digit (so spaces / dashes a user types or a paste carries are
    // dropped) and clamps to the first 6 digits.

    static func normalizeCode(_ raw: String) -> String {
        String(raw.filter(\.isNumber).prefix(6))
    }

    /// True when `code` is exactly 6 digits — worth POSTing to /auth/claim.
    static func isSubmittableCode(_ code: String) -> Bool {
        code.range(of: #"^[0-9]{6}$"#, options: .regularExpression) != nil
    }

    // MARK: - Two-sided four-character confirm (pairPayload.ts / §6.2)
    //
    // Normalize a presented verification code for comparison: strip whitespace
    // and fold case so "K7 Q2", "k7 q2" and "K7Q2" all resolve to "K7Q2".
    static func normalizeVerify(_ raw: String) -> String {
        String(raw.uppercased().filter { !$0.isWhitespace })
    }

    /// A valid four-char verification code after normalization.
    static func isValidVerify(_ raw: String) -> Bool {
        normalizeVerify(raw).range(of: #"^[A-Z0-9]{4}$"#, options: .regularExpression) != nil
    }

    // MARK: - Box ID + server URL (setupLogic.ts / transport.mjs)

    /// The 32-hex box token shape — same gate as isValidBoxToken.
    static func isValidBoxId(_ raw: String) -> Bool {
        raw.range(of: #"^[0-9a-f]{32}$"#, options: .regularExpression) != nil
    }

    /// `https://<boxId>.boxes.mantaui.com` — the box's public hostname.
    static func boxDirectURL(_ boxId: String) -> URL? {
        guard isValidBoxId(boxId) else { return nil }
        return URL(string: "https://\(boxId).boxes.mantaui.com")
    }

    /// Normalize a user-entered server URL: trim + drop trailing slashes;
    /// returns the value only when it begins with http(s)://, else nil.
    static func normalizeServerURL(_ raw: String?) -> String? {
        let v = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if v.isEmpty { return nil }
        let stripped = String(v.reversed().drop { $0 == "/" }.reversed())
        guard stripped.hasPrefix("http://") || stripped.hasPrefix("https://") else { return nil }
        return stripped
    }

    /// True when a server URL is a loopback / RFC1918 private / CGNAT /
    /// Tailscale (100.64/10, .ts.net) listener (isPrivateServerUrl in
    /// transport.mjs). The pair-link `server` param is gated through this so a
    /// crafted link can never point the app at an arbitrary public host.
    static func isPrivateServerURL(_ raw: String?) -> Bool {
        guard let raw, let url = URL(string: raw), let host = url.host else { return false }
        let hostLower = host.lowercased()
        if hostLower == "localhost" || hostLower.hasSuffix(".ts.net") { return true }
        let parts = hostLower.split(separator: ".").map(String.init)
        let octets = parts.map { Int($0) }
        guard octets.count == 4,
              octets.allSatisfy({ $0 != nil && (0...255).contains($0!) })
        else { return false }
        let values = octets.compactMap { $0 }
        let a = values[0], b = values[1]
        if a == 10 { return true }                              // RFC1918 10/8
        if a == 172, (16...31).contains(b) { return true }      // RFC1918 172.16/12
        if a == 192, b == 168 { return true }                   // RFC1918 192.168/16
        if a == 127 { return true }                             // loopback
        if a == 100, (64...127).contains(b) { return true }     // CGNAT/Tailscale
        return false
    }

    // MARK: - Pair payload (pairPayload.ts parsePairPayload)

    struct PairPayload: Equatable, Sendable {
        var boxId: String
        var code: String
        /// Optional four-char verification code (§5.3 "K7 Q2"). When present,
        /// the claim is forwarded WITH `verify` so the box provisions a
        /// DISTINCT Stage-2 joiner device rather than the shared primary
        /// box_token. Always stored in the normalized form.
        var verify: String?
        /// Optional server URL (Tailscale path). When present the claim is
        /// made against this URL instead of the derived public hostname.
        var serverUrl: String?

        static func == (lhs: PairPayload, rhs: PairPayload) -> Bool {
            lhs.boxId == rhs.boxId && lhs.code == rhs.code
                && lhs.verify == rhs.verify && lhs.serverUrl == rhs.serverUrl
        }
    }

    /// Parse a scanned/deeplinked string into a PairPayload, or nil for any
    /// malformed / foreign input. Accepts the box form (`box` + `code`, or the
    /// `token` spelling) and both URL shapes: the custom `<scheme>://pair`
    /// form and the `https://<host>/m/...` deferred-deeplink form.
    static func parsePairPayload(_ raw: String, scheme: String = "manta") -> PairPayload? {
        let input = String(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty, let url = URL(string: input) else { return nil }

        let isChannelScheme = url.scheme == scheme && url.host == "pair"
        let isHttps = url.scheme == "https" || url.scheme == "http"
        if !isChannelScheme {
            // Deferred-deeplink https family: path starts with /m or /m/.
            if !isHttps { return nil }
            let path = url.path
            if path != "/m" && !path.hasPrefix("/m/") { return nil }
        }

        guard let comps = URLComponents(string: input) else { return nil }
        var q: [String: String] = [:]
        for item in comps.queryItems ?? [] {
            if let value = item.value {
                q[item.name] = value
            }
        }

        let rawBox = q["box"] ?? ""
        let rawCode = q["code"] ?? q["token"] ?? ""
        let rawServer = q["server"] ?? ""
        let rawVerify = q["verify"] ?? ""

        let boxId = rawBox.trimmingCharacters(in: .whitespaces)
        guard isValidBoxId(boxId) else { return nil }

        let code = normalizeCode(rawCode)
        if !isSubmittableCode(code) { return nil }
        // A 7-digit input would pass length-6 after normalization but silently
        // drop a digit — require the raw code to carry exactly 6 digits.
        if rawCode.filter(\.isNumber).count != 6 { return nil }

        var serverUrl: String?
        if !rawServer.isEmpty {
            guard let normalized = normalizeServerURL(rawServer) else { return nil }
            // A non-private server URL is refused outright (never silently
            // dropped and never allowed to point the app at a public host).
            guard isPrivateServerURL(normalized) else { return nil }
            serverUrl = normalized
        }

        var verify: String?
        if !rawVerify.isEmpty {
            let normalized = normalizeVerify(rawVerify)
            guard isValidVerify(normalized) else { return nil }
            verify = normalized
        }

        return PairPayload(boxId: boxId, code: code, verify: verify, serverUrl: serverUrl)
    }

    // MARK: - Claim outcome classification (claim.mjs classifyClaimResult)
    //
    // Server contract (src/server/auth.mjs claim() + index.mjs):
    //   200 { box_token, box_id, device_id } — success
    //   429 { error }                        — rate limited
    //   400/403 { error }                    — wrong / expired / already-used code
    //   5xx                                  — server error
    //   fetch error (no HTTP response)       — network
    //
    // 400 and 403 collapse to `wrongCode`: the server deliberately returns 403
    // for every guess (no partial-progress leak).

    enum ClaimOutcome: Equatable, Sendable {
        case success(boxToken: String, boxId: String, deviceId: String?)
        case wrongCode
        case rateLimited
        case network
        case serverError
        case invalidResponse
    }

    static func classifyClaim(status: Int, body: [String: Any]?) -> ClaimOutcome {
        if status == 200 {
            guard
                let body,
                let token = body["box_token"] as? String,
                isValidBoxId(token),
                let boxId = body["box_id"] as? String,
                isValidBoxId(boxId)
            else {
                return .invalidResponse
            }
            let deviceId = body["device_id"] as? String
            return .success(boxToken: token, boxId: boxId, deviceId: deviceId)
        }
        if status == 429 { return .rateLimited }
        if status == 400 || status == 403 { return .wrongCode }
        return .serverError
    }

    /// The claim target URL for a payload: an explicit `serverUrl` wins, else
    /// the box-derived public hostname (setupLogic buildSetupClaimInput).
    static func claimBaseURL(_ payload: PairPayload) -> URL? {
        if let serverUrl = payload.serverUrl {
            return URL(string: serverUrl)
        }
        return boxDirectURL(payload.boxId)
    }
}
