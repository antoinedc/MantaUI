import Foundation

// ===========================================================================
// MantaAuthClient — the S2 `/auth/claim` client (BET-594).
//
// POSTs { pairing_code, name? } to <server>/auth/claim (src/server/index.mjs)
// and classifies the outcome through the pure `MantaPairing.classifyClaim`
// (the shared claim.mjs contract). Reuses the S1a `KeychainCredentialStore`
// on success so the token survives a relaunch.
// ===========================================================================

struct MantaAuthClient: Sendable {
    let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    /// Exchange a pairing payload for a device credential. The claim target is
    /// the payload's explicit `serverUrl`, else the box-derived public hostname.
    func claim(_ payload: MantaPairing.PairPayload, deviceName: String? = nil) async -> MantaPairing.ClaimOutcome {
        guard let base = MantaPairing.claimBaseURL(payload) else {
            return .invalidResponse
        }
        return await claim(serverURL: base, code: payload.code, deviceName: deviceName)
    }

    /// Exchange a raw 6-digit code for a device credential against an explicit
    /// server URL (the manual / desktop-free path, §5.2.10 — the caller
    /// supplies the reachable listener).
    func claim(
        serverURL: URL,
        code: String,
        deviceName: String? = nil
    ) async -> MantaPairing.ClaimOutcome {
        let url = serverURL.appendingPathComponent("auth").appendingPathComponent("claim")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = ["pairing_code": code]
        if let deviceName, !deviceName.isEmpty {
            body["name"] = deviceName
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            return MantaPairing.classifyClaim(status: status, body: json)
        } catch {
            return .network
        }
    }
}
