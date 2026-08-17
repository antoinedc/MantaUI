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
    /// Plan mode is ON for this session (the per-session `manta:chat:<sid>:plan`
    /// boolean — BET-952). A plain Bool, deliberately NOT folded into the model
    /// blob: iOS stores that as a distinct "providerID/modelID" string.
    @Published private(set) var planOn: Bool
    /// The box's agent list, once fetched (`opencode:agents`). Nil = not loaded
    /// yet (the plan chip shows a loading placeholder); a list with no `plan`
    /// primary agent makes the chip unavailable.
    @Published private(set) var agents: [OpencodeAgent]?

    let sessionId: String
    private let catalog: ChatModelCatalog
    private let api: MantaAPIClient
    private var didLoadAgents = false
    private var cancellables: Set<AnyCancellable> = []

    init(sessionId: String, api: MantaAPIClient, catalog: ChatModelCatalog = .shared) {
        self.sessionId = sessionId
        self.catalog = catalog
        self.api = api
        let planOn = UserDefaults.standard.bool(forKey: Self.planKey(for: sessionId))
        self.planOn = planOn
        self.override = Self.loadOverride(for: sessionId, mode: planOn ? .plan : .build)
        self.variant = UserDefaults.standard.string(forKey: Self.variantKey(for: sessionId))

        // Seed + mirror the shared catalog so the box-wide list and default are
        // published here (keeps every existing caller reading
        // `modelStore.models` unchanged). A clear rebuilds this store, but the
        // catalog is already loaded, so it seeds instantly — no refetch.
        self.models = catalog.models
        self.defaultModel = catalog.defaultModel
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
        loaded = catalog.loaded
    }

    /// Which model a session remembers. Plan and build are remembered
    /// separately so switching modes restores the model the user last chose
    /// for that mode — and so "Build here" has a build model to return to.
    /// Mirrors the desktop keys in src/renderer/chatShared.tsx exactly.
    enum ModelMode: String {
        case build
        case plan
    }

    /// The UserDefaults key mirroring the desktop's per-session model key —
    /// one per mode. `build` uses the original `…:model` key so every
    /// existing session keeps its model and nothing migrates; `plan` gets its
    /// own key (`…:model:plan`), same stored shape.
    static func storageKey(for sessionId: String, mode: ModelMode) -> String {
        switch mode {
        case .build: return "manta:chat:\(sessionId):model"
        case .plan:  return "manta:chat:\(sessionId):model:plan"
        }
    }

    static func variantKey(for sessionId: String) -> String {
        "manta:chat:\(sessionId):variant"
    }

    /// The per-session plan-mode key (BET-952), a plain Bool — never folded
    /// into the model blob (see the `planOn` doc).
    static func planKey(for sessionId: String) -> String {
        "manta:chat:\(sessionId):plan"
    }

    func load() {
        catalog.loadIfNeeded()
    }

    /// Fetch the box's agent list once (`opencode:agents`) so the plan chip can
    /// decide availability. Idempotent: a second call does nothing.
    func loadAgentsIfNeeded() {
        guard !didLoadAgents else { return }
        didLoadAgents = true
        Task {
            let result = (try? await api.agents()) ?? []
            await MainActor.run { self.agents = result }
        }
    }

    /// Carry the current override + variant to a NEW session id. Called just
    /// before a clear swaps the id, so the rebuilt store for the new session
    /// picks up the same model the user had chosen — matching the desktop,
    /// which copies the override into the new session's key on /clear.
    ///
    /// Copies BOTH per-mode model keys (mirroring the desktop's
    /// `copySavedModels`), preserving their independence: the RAW stored value
    /// of each key is copied — not `loadOverride`, whose plan→build fallback
    /// would stamp the build model into a plan key that was never explicitly
    /// written — and a plan key absent on the source stays absent on the new
    /// session. The old session's keys are left alone.
    func rebind(to newSessionId: String) {
        guard newSessionId != sessionId else { return }
        let defaults = UserDefaults.standard
        for mode in [ModelMode.build, .plan] {
            let fromKey = Self.storageKey(for: sessionId, mode: mode)
            let toKey = Self.storageKey(for: newSessionId, mode: mode)
            if let raw = defaults.string(forKey: fromKey) {
                defaults.set(raw, forKey: toKey)
            }
        }
        if let variant, !variant.isEmpty {
            UserDefaults.standard.set(variant, forKey: Self.variantKey(for: newSessionId))
        }
        if planOn {
            UserDefaults.standard.set(planOn, forKey: Self.planKey(for: newSessionId))
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

    /// The mode the session is currently in — drives which per-mode key the
    /// model selection reads and writes. Plan builds on the plan key; build
    /// (and the default) use the build key.
    var mode: ModelMode { planOn ? .plan : .build }

    /// Set (or clear, with nil) the per-session override, persisting it to the
    /// CURRENT mode's key. A model change drops the effort variant: the levels
    /// one model offers mean nothing on another, and most models offer none at
    /// all.
    func setOverride(_ id: OpencodeModelID?) {
        let modelChanged = id != override
        override = id
        let key = Self.storageKey(for: sessionId, mode: mode)
        if let id {
            UserDefaults.standard.set(ChatModel.encode(id), forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
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

    // MARK: - Plan mode (BET-952)

    /// The resolved plan toggle for the composer chip: availability from the
    /// fetched agent list, `on` from the persisted per-session flag, `agent`
    /// (when on) the value to send on `opencode:prompt`.
    var planToggle: ChatModel.PlanToggle {
        ChatModel.planToggle(agents: agents, on: planOn)
    }

    /// Flip plan mode for this session, persisting the boolean. When the mode
    /// actually changes, the composer's active model becomes the mode being
    /// entered's remembered model (mirroring `ChatPanel.tsx`'s togglePlan):
    /// reading plan pulls the plan key, falling back to build; reading build
    /// never consults the plan key. The model key is NOT written here — only
    /// on an explicit model pick.
    func setPlan(_ on: Bool) {
        let modeChanged = on != planOn
        planOn = on
        UserDefaults.standard.set(on, forKey: Self.planKey(for: sessionId))
        guard modeChanged else { return }
        let remembered = Self.loadOverride(for: sessionId, mode: mode)
        if remembered != override {
            override = remembered
            setVariant(nil)
        }
    }

    /// The remembered per-session model for a mode, or nil when the session
    /// has none (the server default applies). Plan reads the plan key first,
    /// falling back to the build key when the plan key is absent — that is the
    /// desktop's asymmetric rule and is what makes a first toggle to plan keep
    /// the build model until the user picks one while in plan mode. Build never
    /// falls back to plan. A present-but-malformed value counts as absent for
    /// the purpose of the fallback.
    static func loadOverride(for sessionId: String, mode: ModelMode) -> OpencodeModelID? {
        let key = storageKey(for: sessionId, mode: mode)
        if let raw = UserDefaults.standard.string(forKey: key), let decoded = ChatModel.decode(raw) {
            return decoded
        }
        if mode == .plan, let build = loadOverride(for: sessionId, mode: .build) {
            return build
        }
        return nil
    }
}
