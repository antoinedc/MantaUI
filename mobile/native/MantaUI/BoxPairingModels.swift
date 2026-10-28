import Foundation

// ===========================================================================
// WS10 F14 — "Add a device": the pure half. A port of the desktop's
// `buildUniversalPairLink` (src/shared/pairPayload.ts), `resolveQrServerOverride`
// and the countdown / refresh rules (src/renderer/pairPanel.ts, PairingQR.tsx),
// so a code minted by an iPhone is scanned and typed exactly like one minted by
// the Mac. Foundation-only ([pkg], D19).
// ===========================================================================

enum BoxPairing {

    /// The single registered universal-link host (pairPayload.ts
    /// `UNIVERSAL_LINK_HOST`).
    static let universalLinkHost = "app.mantaui.com"

    /// JavaScript's `encodeURIComponent` leaves exactly these unescaped. Matching
    /// it (rather than `.urlQueryAllowed`, which also passes `: / ? & = +`) keeps
    /// the link byte-identical to the desktop's.
    private static let componentAllowed = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
    )

    private static func encodeComponent(_ raw: String) -> String {
        raw.addingPercentEncoding(withAllowedCharacters: componentAllowed) ?? raw
    }

    /// `https://app.mantaui.com/m?box=<id>&code=<code>[&server=<url>]` — what a
    /// camera scan of the QR opens (with or without the app installed). The
    /// result round-trips through `MantaPairing.parsePairPayload`.
    static func universalLink(boxId: String, code: String, serverUrl: String?) -> String {
        var link = "https://\(universalLinkHost)/m?box=\(encodeComponent(boxId))&code=\(code)"
        if let serverUrl, !serverUrl.isEmpty {
            link += "&server=\(encodeComponent(serverUrl))"
        }
        return link
    }

    /// The address a second device types into Manual Setup's "Server address"
    /// field: the one THIS phone actually reaches the box at (so on a Tailscale
    /// box it is the private address, where the Server ID's derived public host
    /// does not exist). Falls back to the box's public host when the phone has no
    /// stored address. nil when neither is known.
    static func manualAddress(boxId: String, connectedServerUrl: String?) -> String? {
        if let connected = MantaPairing.normalizeServerURL(connectedServerUrl) { return connected }
        return MantaPairing.boxDirectURL(boxId)?.absoluteString
    }

    /// Whether the QR should carry a `server=` override: only a PRIVATE address
    /// that differs from the box's public hostname. A custom public domain stays
    /// out because the pair-link parser refuses a public `server=` by design.
    static func qrServerOverride(boxId: String, configured: String?) -> String? {
        let direct = MantaPairing.boxDirectURL(boxId.trimmingCharacters(in: .whitespaces))?.absoluteString
        guard let configured = MantaPairing.normalizeServerURL(configured), configured != direct else { return nil }
        guard MantaPairing.isPrivateServerURL(configured) else { return nil }
        return configured
    }

    // MARK: - Expiry

    /// Expiry is inclusive: at or after `expiresAt` the code is dead (a joiner
    /// claiming it would get 403), so the panel mints a fresh one.
    static func shouldRefresh(expiresAt: Date, now: Date) -> Bool {
        now >= expiresAt
    }

    /// "Expires in m:ss" (low under 60 s) or "Expired. Generate a new code.".
    /// Whole seconds, floored — the desktop's `PairingCountdown`.
    static func countdown(expiresAt: Date, now: Date) -> (text: String, low: Bool, expired: Bool) {
        let remaining = max(0, Int((expiresAt.timeIntervalSince(now)).rounded(.down)))
        if remaining <= 0 { return ("Expired. Generate a new code.", true, true) }
        let minutes = remaining / 60
        let seconds = remaining % 60
        let padded = seconds < 10 ? "0\(seconds)" : "\(seconds)"
        return ("Expires in \(minutes):\(padded)", remaining < 60, false)
    }

    /// A `Date` from the server's epoch number: milliseconds (what `auth:pair`
    /// sends), tolerating seconds from a different build.
    static func date(fromEpoch value: Double) -> Date? {
        guard value.isFinite, value > 0 else { return nil }
        let seconds = value >= 100_000_000_000 ? value / 1000 : value
        return Date(timeIntervalSince1970: seconds)
    }

    /// ISO-8601, with or without fractional seconds.
    static func parseExpiresAt(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: iso) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: iso)
    }
}
