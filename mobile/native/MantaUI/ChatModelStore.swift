import Foundation
import Combine

// ===========================================================================
// S5 — model store for the composer (BET-597).
//
// Owns the per-SESSION model override + effort variant; the box-wide model
// list + server default come from the shared `ChatModelCatalog`, fetched once
// and mirrored here. The per-session override is a plain `providerID/modelID`
// string in UserDefaults (NOT a credential — the raw string encodes
// provider+model ids only), mirroring the desktop's
// `manta:chat:<sessionId>:model` localStorage key.
//
// The catalog is why clearing a session does NOT reload models: the clear
// rebuilds this store for the new session id, but the list is already loaded
// and shared, so there is no second fetch. The override/variant are carried to
// the new id by `rebind(to:)` (matching the desktop's clear handler, which
// copies the override into the new session's key).
// ===========================================================================

@MainActor
final class ChatModelStore: ObservableObject {

    @Published private(set) var models: [OpencodeModel] = []
    @Published private(set) var defaultModel: OpencodeModelID?
    @Published private(set) var override: OpencodeModelID?
    @Published private(set) var loadFailed = false
    /// True once the shared catalog has its list (mirrored from the catalog).
    /// Drives the composer pill's loading state.
    @Published private(set) var loaded = false
    /// Reasoning-effort variant for the selected model (opencode calls these
    /// model "variants"). Model-specific, so it is cleared whenever the model
    /// changes rather than carried onto a model that has no such setting.
    @Published private(set) var variant: String?

    let sessionId: String
    private let catalog: ChatModelCatalog
    private var cancellables: Set<AnyCancellable> = []

    init(sessionId: String, api: MantaAPIClient, catalog: ChatModelCatalog = .shared) {
        self.sessionId = sessionId
        self.catalog = catalog
        self.override = Self.loadOverride(for: sessionId)
        self.variant = UserDefaults.standard.string(forKey: Self.variantKey(for: sessionId))

        // Seed + mirror the shared catalog so the box-wide list, default and
        // failure state are published here (keeps every existing caller reading
        // `modelStore.models` unchanged). A clear rebuilds this store, but the
        // catalog is already loaded, so it seeds instantly — no refetch.
        self.models = catalog.models
        self.defaultModel = catalog.defaultModel
        self.loadFailed = catalog.loadFailed
        self.loaded = catalog.loaded
        catalog.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.mirrorCatalog() }
            .store(in: &cancellables)
    }

    private func mirrorCatalog() {
        models = catalog.models
        defaultModel = catalog.defaultModel
        loadFailed = catalog.loadFailed
        loaded = catalog.loaded
    }

    /// The UserDefaults key mirroring the desktop's per-session model key.
    static func storageKey(for sessionId: String) -> String {
        "manta:chat:\(sessionId):model"
    }

    static func variantKey(for sessionId: String) -> String {
        "manta:chat:\(sessionId):variant"
    }

    func load() {
        catalog.loadIfNeeded()
    }

    /// Carry the current override + variant to a NEW session id. Called just
    /// before a clear swaps the id, so the rebuilt store for the new session
    /// picks up the same model the user had chosen — matching the desktop,
    /// which copies the override into the new session's key on /clear.
    func rebind(to newSessionId: String) {
        guard newSessionId != sessionId else { return }
        if let override {
            UserDefaults.standard.set(ChatModel.encode(override), forKey: Self.storageKey(for: newSessionId))
        }
        if let variant, !variant.isEmpty {
            UserDefaults.standard.set(variant, forKey: Self.variantKey(for: newSessionId))
        }
    }

    /// The effective selection for the next turn: override wins, else default.
    var active: OpencodeModelID? {
        ChatModel.effective(override, defaultModel)
    }

    /// The selection to send on `opencode:prompt` (nil = let opencode pick).
    var promptModel: SendPromptInput.Model? {
        guard let active else { return nil }
        return SendPromptInput.Model(providerID: active.providerID, modelID: active.modelID, variant: variant)
    }

    /// Set (or clear, with nil) the per-session override, persisting it. A
    /// model change drops the effort variant: the levels one model offers mean
    /// nothing on another, and most models offer none at all.
    func setOverride(_ id: OpencodeModelID?) {
        let modelChanged = id != override
        override = id
        if let id {
            UserDefaults.standard.set(ChatModel.encode(id), forKey: Self.storageKey(for: sessionId))
        } else {
            UserDefaults.standard.removeObject(forKey: Self.storageKey(for: sessionId))
        }
        if modelChanged { setVariant(nil) }
    }

    /// Set (or clear) the effort variant for the active model.
    func setVariant(_ id: String?) {
        variant = id
        if let id, !id.isEmpty {
            UserDefaults.standard.set(id, forKey: Self.variantKey(for: sessionId))
        } else {
            UserDefaults.standard.removeObject(forKey: Self.variantKey(for: sessionId))
        }
    }

    /// The effort variants the ACTIVE model offers (empty when it has none).
    var activeVariants: [OpencodeModel.Variant] {
        ChatModel.activeModel(models, override: override, default: defaultModel)?.variants ?? []
    }

    static func loadOverride(for sessionId: String) -> OpencodeModelID? {
        guard let raw = UserDefaults.standard.string(forKey: storageKey(for: sessionId)) else { return nil }
        return ChatModel.decode(raw)
    }
}
