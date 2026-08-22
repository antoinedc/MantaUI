import Foundation
import Combine

// ===========================================================================
// BET-1282 — box-wide model-prefs cache.
//
// The per-conversation model choice + the model recents used to live in
// UserDefaults, so they never left the phone. They now live in the box store
// (~/.manta/model-prefs.json, src/server/modelPrefs.mjs, BET-1279) so the
// same conversation opened on another device shows the same choice, and a
// reinstall doesn't lose the recents.
//
// This cache is the SINGLE iOS mirror of that store — one `model-prefs:get`
// for the whole box, refetched on the `model-prefs.updated` bus event, exactly
// like `ChatModelCatalog` mirrors the model list. `ChatModelStore` is the ONE
// place the UI mutates the selection; views never talk to this cache directly.
//
// The wire rule pinned by MantaActionRPCWireTests also holds here: every
// mutating channel sends its payload as a SINGLE element (`args: [dict]`),
// never `args: [[dict]]` — see MantaAPIClient.modelPrefsSet/Seed.
//
// NOT the migration: `migrateIfNeeded()` at the bottom scavenges the old
// UserDefaults values into the box exactly once after an upgrade.
// ===========================================================================

/// The box's whole model-prefs store (`model-prefs:get` reply): per-session
/// selections + the model recents list. `recents` reuses `ModelChoice`, whose
/// `{ providerID, modelID, variant?, fast }` shape is byte-identical to the
/// box's `recents[]` entry.
struct ModelPrefsState: Decodable {
    var sessions: [String: ModelPrefsSessionRecord]
    var recents: [ModelChoice]
}

/// One per-session record from the box store — `{ providerID, modelID,
/// variant?, updatedAt }`. `updatedAt` is present on the wire but unused here.
struct ModelPrefsSessionRecord: Decodable {
    var providerID: String
    var modelID: String
    var variant: String?
}

/// A selection sent TO the box (`model-prefs:set` / `:seed`):
/// `{ providerID, modelID, variant? }`, with `variant` omitted when nil.
/// Distinct from the on-disk record (no `updatedAt`) and from a recent (no
/// `fast` flag) — a session record has no fast field; fast is the `-fast`
/// modelID suffix (BET-1279 rule).
struct ModelPrefsSelection: Encodable {
    var providerID: String
    var modelID: String
    var variant: String?
}

@MainActor
final class ChatModelPrefs: ObservableObject {

    /// The per-session selections known to the box (key = session id).
    @Published private(set) var sessions: [String: ChatModel.ModelSelection] = [:]
    /// The box's recent-model list, most recent first (capped at 5 box-side).
    @Published private(set) var recents: [ModelChoice] = []

    static let shared = ChatModelPrefs()

    private let api: MantaAPIClient
    private var didStart = false
    private var didSubscribe = false

    init(api: MantaAPIClient = .live()) {
        self.api = api
    }

    /// The box selection for a session, or nil (the server default applies).
    func selection(for sessionId: String) -> ChatModel.ModelSelection? {
        sessions[sessionId]
    }

    /// Fetch the whole box store once and subscribe to `model-prefs.updated`.
    /// Idempotent; safe to call on every paired launch and after a re-pair.
    func startIfNeeded() {
        guard !didStart else { return }
        didStart = true
        load()
    }

    /// Register for the box's `model-prefs.updated` bus event (single
    /// subscription). `model-prefs.updated` is neither `stream` nor
    /// `runningSet`, so it already arrives via the event store's raw-frame
    /// multicast; a change on another device refetches the whole store. No
    /// first-class routing — exactly one listener, one refetch.
    func subscribe(to eventStore: MantaEventStore) {
        guard !didSubscribe else { return }
        didSubscribe = true
        eventStore.addRawFrameHandler { [weak self] frame in
            guard frame.kind == "model-prefs.updated" else { return }
            self?.load()
        }
    }

    /// Refetch the whole box store. A client refetching its own write is a
    /// harmless no-op — deliberately NO echo suppression, sequence numbers, or
    /// write lock (BET-1282 write rule).
    func load() {
        Task {
            let state = try? await api.modelPrefsGet()
            await MainActor.run {
                guard let state else { return }
                sessions = state.sessions.mapValues {
                    ChatModel.ModelSelection(providerID: $0.providerID, modelID: $0.modelID, variant: $0.variant)
                }
                recents = state.recents
            }
        }
    }

    // MARK: - Write path (the single writer is ChatModelStore)

    /// Persist (or clear, with nil) a session's selection — update local state
    /// immediately AND write the box. Fire-and-forget; see the write rule.
    func setSession(_ selection: ChatModel.ModelSelection?, for sessionId: String) {
        if let selection {
            sessions[sessionId] = selection
        } else {
            sessions.removeValue(forKey: sessionId)
        }
        let box = selection.map { ModelPrefsSelection(providerID: $0.providerID, modelID: $0.modelID, variant: $0.variant) }
        Task {
            try? await api.modelPrefsSet(sessionId: sessionId, selection: box, recents: nil)
        }
    }

    /// Replace the box recents. The CLIENT owns ordering + dedupe
    /// (`ModelRecents.record`, cap-at-5 + whole-quad dedupe stay client-side);
    /// the server stores what it is given, truncated to 5.
    func setRecents(_ list: [ModelChoice]) {
        recents = list
        Task {
            try? await api.modelPrefsSet(sessionId: nil, selection: nil, recents: list)
        }
    }

    /// One-shot migration write: seed sessions + recents without overwriting
    /// anything already in the box (non-destructive by the server contract).
    func seed(sessions: [String: ChatModel.ModelSelection], recents: [ModelChoice]) {
        let boxSessions = sessions.mapValues {
            ModelPrefsSelection(providerID: $0.providerID, modelID: $0.modelID, variant: $0.variant)
        }
        Task {
            try? await api.modelPrefsSeed(sessions: boxSessions, recents: recents)
        }
    }
}

// MARK: - One-shot migration (BET-1282 step 5)

extension ChatModelPrefs {
    /// The flag that marks the one-shot migration done.
    static let migrationFlagKey = "manta:model-prefs:migrated"
    /// The legacy per-session model key prefix/suffix (UserDefaults,
    /// pre-BET-1282), mirroring the desktop's old `manta:chat:<sid>:model`.
    static let legacyModelKeyPrefix = "manta:chat:"
    static let legacyModelKeySuffix = ":model"
    /// The legacy recents key (UserDefaults, pre-BET-1282).
    static let legacyRecentsKey = "manta:model-recents"

    /// Pure scan of the legacy keys into the box seed payload + the keys to
    /// remove. Injectable lookups (`stringForKey`/`dataForKey`) keep it
    /// unit-testable; the real caller passes UserDefaults. Malformed values are
    /// skipped — a broken value must never break the migration.
    static func collectLegacy(
        keys: [String],
        stringForKey: (String) -> String?,
        dataForKey: (String) -> Data?
    ) -> (sessions: [String: ChatModel.ModelSelection], recents: [ModelChoice], keysToRemove: [String]) {
        var sessions: [String: ChatModel.ModelSelection] = [:]
        var keysToRemove: [String] = []
        for key in keys where key.hasPrefix(legacyModelKeyPrefix) && key.hasSuffix(legacyModelKeySuffix) {
            let sessionId = String(key.dropFirst(legacyModelKeyPrefix.count).dropLast(legacyModelKeySuffix.count))
            guard !sessionId.isEmpty,
                  let raw = stringForKey(key),
                  let selection = ChatModel.decode(raw)
            else { continue }
            sessions[sessionId] = selection
            keysToRemove.append(key)
        }
        var recents: [ModelChoice] = []
        if let data = dataForKey(legacyRecentsKey),
           let list = try? JSONDecoder().decode([ModelChoice].self, from: data) {
            recents = list
            keysToRemove.append(legacyRecentsKey)
        }
        return (sessions, recents, keysToRemove)
    }

    /// Run the one-shot migration on first launch after upgrade: scan legacy
    /// `manta:chat:*:model` + `manta:model-recents`, seed them to the box via
    /// `modelPrefsSeed`, remove the scanned keys, set the flag. Best-effort —
    /// never throws or breaks boot. Does NOT touch `manta:chat:*:plan` (plan
    /// mode is out of scope) nor `DeprecatedModelOptIns`.
    static func migrateIfNeeded() {
        let defaults = UserDefaults.standard
        guard defaults.object(forKey: migrationFlagKey) == nil else { return }
        let collected = collectLegacy(
            keys: Array(defaults.dictionaryRepresentation().keys),
            stringForKey: { defaults.string(forKey: $0) },
            dataForKey: { defaults.data(forKey: $0) }
        )
        if !collected.sessions.isEmpty || !collected.recents.isEmpty {
            ChatModelPrefs.shared.seed(sessions: collected.sessions, recents: collected.recents)
        }
        for key in collected.keysToRemove { defaults.removeObject(forKey: key) }
        defaults.set(true, forKey: migrationFlagKey)
    }
}
