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
    /// The last 3–5 (model, effort, fast) triples actually used, most recent
    /// first. Persisted PER BOX (a habit, not a conversation), unlike the
    /// override/variant above which are per-session.
    @Published private(set) var recents: [ModelChoice] = []

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
        self.recents = ModelRecents.load()
        catalog.objectWillChange
            .receive(on: DispatchQueue.main)
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

    // MARK: - Recents (BET-825)

    /// The currently-active (model, effort, fast) triple, or nil when there is
    /// no per-session override (the "Server default" state — the checkmark
    /// lands on Server default, not on a recent). `modelID` is always the
    /// base id; fast is expressed as the `fast` flag.
    var activeChoice: ModelChoice? {
        guard let override, let active = ChatModel.activeModel(models, override: override, default: defaultModel) else {
            return nil
        }
        return ModelChoice(
            providerID: override.providerID,
            modelID: ChatModel.baseModelID(active.id),
            variant: variant,
            fast: ChatModel.isFastModelID(active.id)
        )
    }

    /// Apply a stored recent choice (base model id + effort + fast) to the
    /// override + variant, then move it to the front of recents. Selecting a
    /// recent IS the act of using it, so it is recorded on apply.
    func apply(_ choice: ModelChoice) {
        let targetID = choice.fast ? ChatModel.fastModelID(choice.modelID) : choice.modelID
        setOverride(OpencodeModelID(providerID: choice.providerID, modelID: targetID))
        setVariant(choice.variant)
        recents = ModelRecents.record(choice, into: recents)
        ModelRecents.save(recents)
    }

    /// Record the current effective (model, effort, fast) as a recent — called
    /// when the user changes effort or fast, or picks a model from the
    /// catalogue sheet. Only records when the user has an explicit model
    /// override (the "Server default" state is not a recent — it is the
    /// always-present escape hatch, so it must not crowd recents with one
    /// entry per effort dial).
    func recordCurrentChoice() {
        guard
            let override,
            let active = ChatModel.activeModel(models, override: override, default: defaultModel)
        else { return }
        let choice = ModelChoice(
            providerID: override.providerID,
            modelID: ChatModel.baseModelID(active.id),
            variant: variant,
            fast: ChatModel.isFastModelID(active.id)
        )
        recents = ModelRecents.record(choice, into: recents)
        ModelRecents.save(recents)
    }

    /// Flip fast mode on the active model, carrying the current effort across
    /// (the fast twin keeps the chosen effort, or fast is unavailable). Moved
    /// here from the sheet so the menu and the sheet share one implementation.
    func setFast(_ on: Bool) {
        guard let active = ChatModel.activeModel(models, override: override, default: defaultModel) else { return }
        let f = ChatModel.fastToggle(models: models, active: active, variantId: variant)
        guard let target = f.target else { return }
        let currentVariant = variant
        setOverride(OpencodeModelID(providerID: target.providerID, modelID: target.modelID))
        if let currentVariant { setVariant(currentVariant) }
    }

    static func loadOverride(for sessionId: String) -> OpencodeModelID? {
        guard let raw = UserDefaults.standard.string(forKey: storageKey(for: sessionId)) else { return nil }
        return ChatModel.decode(raw)
    }
}
