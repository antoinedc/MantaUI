import Foundation

// ===========================================================================
// WS11 D1 — what the box says it can do (`GET /api/version` → `capabilities`).
//
// One list (`src/server/boxCapabilities.mjs`), one client reader
// (`BoxCapabilitiesStore`). A surface whose capability the box does not list is
// hidden, or disabled with "Update your box to use this"; there is no fallback copy
// of the moved logic. Ids are `kebab-name-N`; unknown ids are ignored.
// ===========================================================================

/// Every id in the master "Capability id registry".
enum BoxCapability: String, CaseIterable, Sendable {
    case chatCards = "chat-cards-1"
    case artifactsList = "artifacts-list-1"
    case modelsTable = "models-table-1"
    case modelsPicker = "models-picker-1"
    case modelsUnidentified = "models-unidentified-1"
    case modelsPriceForm = "models-price-form-1"
    case ledgerView = "ledger-view-1"
    case optimizerView = "optimizer-view-1"
    case usageResumeView = "usage-resume-view-1"
    case usageAlerts = "usage-alerts-1"
    case usageWindowTone = "usage-window-tone-1"
    case searchScopeAll = "search-scope-all-1"
    case forgePrView = "forge-pr-view-1"
    case forgeDiffView = "forge-diff-view-1"
    case forgeInboxView = "forge-inbox-view-1"
    case forgeMessages = "forge-messages-1"
    case cacheStaleAt = "cache-stale-at-1"
    case contextSelectedModel = "context-selected-model-1"
    case devicesView = "devices-view-1"
    case forgeStatusSecondary = "forge-status-secondary-1"
    case updateTargetsView = "update-targets-view-1"
    case upgradeView = "upgrade-view-1"
    case launchersFlags = "launchers-flags-1"
    case accountsCopy = "accounts-copy-1"
    case sessionsNaming = "sessions-naming-1"
    case forgeCloneView = "forge-clone-view-1"
    case sessionsClose = "sessions-close-1"
    case sessionsWindowStatus = "sessions-window-status-1"
    case transcriptView = "transcript-view-1"
    case questionsPlan = "questions-plan-1"
    case transcriptRuns = "transcript-runs-1"
}

struct BoxCapabilities: Equatable, Sendable {
    let ids: Set<String>

    init(ids: Set<String>) {
        self.ids = ids
    }

    func has(_ capability: BoxCapability) -> Bool {
        ids.contains(capability.rawValue)
    }

    /// A body without `capabilities` is an older box: the empty set ("has none"),
    /// distinct from a failed request.
    static func decode(version: ServerVersionInfo) -> BoxCapabilities {
        BoxCapabilities(ids: Set(version.capabilities ?? []))
    }

    /// The box answered "unknown rpc channel: <name>" (an older box that predates the
    /// channel). One classifier for every wave-B surface that detects an old box this
    /// way; a transport / auth failure is never "an old box".
    static func isUnknownChannel(_ error: Error) -> Bool {
        guard case MantaError.server(let message) = error else { return false }
        return message.hasPrefix("unknown rpc channel")
    }
}

enum BoxCapabilitiesState: Equatable, Sendable {
    case loading
    case loaded(BoxCapabilities)
    /// The box could not be asked. NEVER read as "old box"; `lastLoaded` keeps the
    /// previous answer so a reconnect blip does not hide features.
    case failed(lastLoaded: BoxCapabilities?)

    /// The list to answer from: the loaded one, or the last good one after a failure.
    var known: BoxCapabilities? {
        switch self {
        case .loading: return nil
        case .loaded(let caps): return caps
        case .failed(let last): return last
        }
    }
}

enum BoxCapabilitiesRetry {
    /// Failed-read retry schedule in seconds: 1, 2, 5, 10, 10, …
    static func delay(attempt: Int) -> TimeInterval {
        let schedule: [TimeInterval] = [1, 2, 5, 10]
        return schedule[min(max(attempt, 0), schedule.count - 1)]
    }
}
