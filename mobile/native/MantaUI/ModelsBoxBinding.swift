import Foundation

// ===========================================================================
// WS09 — which box a process-wide singleton (`UsageAlertsStore.shared`,
// `ChatModelCatalog.shared`) is talking to. The app can switch boxes without
// relaunching, and `MantaAPIClient.live()` fixes its URL at construction while
// its default token provider re-reads the Keychain per request — so a client
// kept across a switch would send box B's token to box A's URL. These stores
// therefore rebuild their client from ONE credentials snapshot (URL + captured
// token) whenever the decision below says so. Pure + Foundation-only.
// ===========================================================================

/// The three Keychain fields the decision needs (`MantaCredentials` lives in a
/// Security-importing file, so the package-buildable input is this mirror).
struct ModelsBoxCredentials: Equatable, Sendable {
    var serverUrl: String
    var boxId: String
    var boxToken: String
}

struct ModelsBoxBinding: Equatable, Sendable {
    let boxKey: String
    let serverURL: URL
    let token: String
}

enum ModelsBoxBindingDecision: Equatable {
    /// No usable credentials: issue no request, publish nothing new.
    case unpaired
    /// Same box, same token: keep the current client.
    case same
    /// Rebuild the client; `boxChanged` means the old box's state must be dropped first.
    case rebind(ModelsBoxBinding, boxChanged: Bool)
}

extension ModelsBoxBinding {
    static func resolve(current: ModelsBoxBinding?, credentials: ModelsBoxCredentials?) -> ModelsBoxBindingDecision {
        guard let credentials,
              !credentials.serverUrl.isEmpty,
              let url = URL(string: credentials.serverUrl), url.scheme != nil, url.host != nil,
              !credentials.boxToken.isEmpty
        else { return .unpaired }
        let key = credentials.boxId.isEmpty ? credentials.serverUrl : credentials.boxId
        let next = ModelsBoxBinding(boxKey: key, serverURL: url, token: credentials.boxToken)
        guard let current else { return .rebind(next, boxChanged: true) }
        if current == next { return .same }
        return .rebind(next, boxChanged: current.boxKey != next.boxKey)
    }
}

/// The one-time copy of on-device deprecated-model opt-ins to the box (D24).
enum DeprecatedOptInCopy {
    static func flagKey(boxKey: String) -> String { "manta:deprecated-opt-ins-copied:\(boxKey)" }

    /// Copy only when there is something local and this box has not received it yet.
    static func shouldCopy(local: Set<String>, alreadyCopied: Bool) -> Bool {
        !local.isEmpty && !alreadyCopied
    }
}
