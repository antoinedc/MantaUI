import Foundation
import Combine

// ===========================================================================
// S5 — model store for the composer (BET-597).
//
// Owns the per-SESSION model selection (override + effort variant folded into
// one JSON blob); the box-wide model list + defaults come from the shared
// `ChatModelCatalog`, fetched once and mirrored here.
//
// BET-1282: the selection is no longer stored in UserDefaults under a
// per-session key — it now lives in the box store and is mirrored through the
// shared `ChatModelPrefs` cache (one box-wide fetch, refetched on
// `model-prefs.updated`), so the same conversation on another device shows the
// same model and a reinstall keeps the choice. `ChatModelStore` remains the
// SINGLE place the UI mutates the selection
// (setOverride/setVariant/apply/setFast/recordCurrentChoice): those mutators
// update local state immediately AND write the box through the cache — views
// never talk to `ChatModelPrefs` directly.
//
// The catalog is why clearing a session does NOT reload models: the clear
// rebuilds this store for the new session id, but the list is already loaded
// and shared, so there is no second fetch. The selection is carried to the new
// id by `rebind(to:)` — a single write through the box cache, matching the
// desktop's clear handler which copies the override into the new session's key.
// ===========================================================================

@MainActor
final class ChatModelStore: ObservableObject {

    @Published private(set) var models: [OpencodeModel] = []
    /// The opencode provider's own default (from `opencode:default-model`).
    @Published private(set) var defaultModel: OpencodeModelID?
    /// The box config's `defaultModel` entry (`AppConfig.defaultModel` from
    /// `config:get`), the middle tier of the precedence.
    @Published private(set) var configDefault: OpencodeModelID?
    @Published private(set) var override: OpencodeModelID?
    /// True once the shared catalog has its list (mirrored from the catalog).
    /// Drives the composer pill's loading state.
    @Published private(set) var loaded = false
    /// Reasoning-effort variant for the selected model (opencode calls these
    /// model "variants"). Model-specific, so it is cleared whenever the model
    /// changes rather than carried onto a model that has no such setting.
    @Published private(set) var variant: String?
    /// The last 3–5 (model, effort, fast) triples actually used, most recent
    /// first. Persisted in the BOX store (a habit that follows the user across
    /// devices — BET-1282), unlike the pre-upgrade device-local UserDefaults.
    @Published private(set) var recents: [ModelChoice] = []
    /// "providerID/modelID" keys of deprecated models the user has explicitly
    /// opted back in to (BET-1140). Per box (UserDefaults), like recents — not
    /// per session, so the choice follows the user across sessions. A
    /// deprecated model NOT in this set renders greyed/disabled in the
    /// catalogue list until opted in.
    @Published private(set) var deprecatedOptIns: Set<String> = []
    /// Plan mode is ON for this session (the per-session `manta:chat:<sid>:plan`
    /// boolean — BET-952). A plain Bool, deliberately NOT folded into the model
    /// blob: plan mode changes the agent, never the model (one model per
    /// session), so the flag stays separate from the JSON selection.
    @Published private(set) var planOn: Bool
    /// The box's agent list, once fetched (`opencode:agents`). Nil = not loaded
    /// yet (the plan chip shows a loading placeholder); a list with no `plan`
    /// primary agent makes the chip unavailable.
    @Published private(set) var agents: [OpencodeAgent]?

    let sessionId: String
    private let catalog: ChatModelCatalog
    private let prefs: ChatModelPrefs
    private let api: MantaAPIClient
    private var didLoadAgents = false
    private var cancellables: Set<AnyCancellable> = []

    init(sessionId: String, api: MantaAPIClient, catalog: ChatModelCatalog = .shared, prefs: ChatModelPrefs = .shared) {
        self.sessionId = sessionId
        self.catalog = catalog
        self.prefs = prefs
        self.api = api
        let planOn = UserDefaults.standard.bool(forKey: Self.planKey(for: sessionId))
        self.planOn = planOn
        // The per-session selection now comes from the box store (via the shared
        // cache), not UserDefaults.
        let stored = prefs.selection(for: sessionId)
        self.override = stored.map { OpencodeModelID(providerID: $0.providerID, modelID: $0.modelID) }
        self.variant = stored?.variant
        // Clean up the pre-BET-1280 per-mode plan key on first read of a
        // session so an upgrading user leaves no litter in UserDefaults.
        UserDefaults.standard.removeObject(forKey: "manta:chat:\(sessionId):model:plan")

        // Seed + mirror the shared catalog so the box-wide list and defaults are
        // published here (keeps every existing caller reading
        // `modelStore.models` unchanged). A clear rebuilds this store, but the
        // catalog is already loaded, so it seeds instantly — no refetch.
        self.models = catalog.models
        self.defaultModel = catalog.defaultModel
        self.configDefault = catalog.configDefault
        self.loaded = catalog.loaded
        self.recents = prefs.recents
        self.deprecatedOptIns = DeprecatedModelOptIns.load()
        catalog.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.mirrorCatalog() }
            .store(in: &cancellables)
        // Mirror the box prefs cache so a change — this device's write, or one
        // that arrived from another device via `model-prefs.updated` — lands on
        // the selection + recents.
        prefs.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.mirrorPrefs() }
            .store(in: &cancellables)
    }

    private func mirrorCatalog() {
        models = catalog.models
        defaultModel = catalog.defaultModel
        configDefault = catalog.configDefault
        loaded = catalog.loaded
    }

    private func mirrorPrefs() {
        let stored = prefs.selection(for: sessionId)
        override = stored.map { OpencodeModelID(providerID: $0.providerID, modelID: $0.modelID) }
        variant = stored?.variant
        recents = prefs.recents
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

    /// Carry the current selection to a NEW session id. Called just before a
    /// clear swaps the id, so the rebuilt store for the new session picks up
    /// the same model the user had chosen — matching the desktop, which copies
    /// the override into the new session's key on /clear. A SINGLE write
    /// through the box cache; the old session's record is left alone.
    func rebind(to newSessionId: String) {
        guard newSessionId != sessionId else { return }
        prefs.setSession(prefs.selection(for: sessionId), for: newSessionId)
        if planOn {
            UserDefaults.standard.set(planOn, forKey: Self.planKey(for: newSessionId))
        }
    }

    /// The effective selection for the next turn: override wins, else the box
    /// config default, else the opencode provider default.
    var active: OpencodeModelID? {
        ChatModel.effective(override, configDefault, defaultModel)
    }

    /// The selection to send on `opencode:prompt` (nil = let opencode pick).
    var promptModel: SendPromptInput.Model? {
        guard let active else { return nil }
        return SendPromptInput.Model(providerID: active.providerID, modelID: active.modelID, variant: variant)
    }

    /// Persist the whole current selection (override + variant) as one JSON
    /// value under the session's box record. No override means the session has
    /// no explicit model — clear the box record (server default applies),
    /// mirroring the desktop.
    private func persistSelection() {
        let selection: ChatModel.ModelSelection? = override.map {
            ChatModel.ModelSelection(
                providerID: $0.providerID,
                modelID: $0.modelID,
                variant: variant
            )
        }
        prefs.setSession(selection, for: sessionId)
    }

    /// Set (or clear, with nil) the per-session override. A model change drops
    /// the effort variant: the levels one model offers mean nothing on another,
    /// and most models offer none at all. Persisted as the whole selection.
    func setOverride(_ id: OpencodeModelID?) {
        let modelChanged = id != override
        override = id
        if modelChanged { variant = nil }
        persistSelection()
    }

    /// Set (or clear) the effort variant for the active model — a rewrite of
    /// the whole selection (the variant lives inside the JSON blob now).
    func setVariant(_ id: String?) {
        variant = id
        persistSelection()
    }

    /// The effort variants the ACTIVE model offers (empty when it has none).
    var activeVariants: [OpencodeModel.Variant] {
        ChatModel.activeModel(models, override: override, configuration: configDefault, provider: defaultModel)?.variants ?? []
    }

    // MARK: - Recents (BET-825)

    /// The currently-active (model, effort, fast) triple, or nil when there is
    /// no per-session override (the "Server default" state — the checkmark
    /// lands on Server default, not on a recent). `modelID` is always the
    /// base id; fast is expressed as the `fast` flag.
    var activeChoice: ModelChoice? {
        guard let override, let active = ChatModel.activeModel(models, override: override, configuration: configDefault, provider: defaultModel) else {
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
    /// recent IS the act of using it, so it is recorded on apply. The recents
    /// list is written to the box via the shared cache.
    func apply(_ choice: ModelChoice) {
        let targetID = choice.fast ? ChatModel.fastModelID(choice.modelID) : choice.modelID
        setOverride(OpencodeModelID(providerID: choice.providerID, modelID: targetID))
        setVariant(choice.variant)
        recents = ModelRecents.record(choice, into: recents)
        prefs.setRecents(recents)
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
            let active = ChatModel.activeModel(models, override: override, configuration: configDefault, provider: defaultModel)
        else { return }
        let choice = ModelChoice(
            providerID: override.providerID,
            modelID: ChatModel.baseModelID(active.id),
            variant: variant,
            fast: ChatModel.isFastModelID(active.id)
        )
        recents = ModelRecents.record(choice, into: recents)
        prefs.setRecents(recents)
    }

    /// Flip fast mode on the active model, carrying the current effort across
    /// (the fast twin keeps the chosen effort, or fast is unavailable). Moved
    /// here from the sheet so the menu and the sheet share one implementation.
    func setFast(_ on: Bool) {
        guard let active = ChatModel.activeModel(models, override: override, configuration: configDefault, provider: defaultModel) else { return }
        let f = ChatModel.fastToggle(models: models, active: active, variantId: variant)
        guard let target = f.target else { return }
        let currentVariant = variant
        setOverride(OpencodeModelID(providerID: target.providerID, modelID: target.modelID))
        if let currentVariant { setVariant(currentVariant) }
    }

    // MARK: - Deprecated-model opt-in (BET-1140)

    /// Persist the user's opt-in for a deprecated model, flipping its catalogue
    /// row from disabled to selectable. Idempotent — a second opt-in for the
    /// same model is a no-op.
    func optIn(_ model: OpencodeModel) {
        let key = "\(model.providerID)/\(model.id)"
        guard !deprecatedOptIns.contains(key) else { return }
        deprecatedOptIns.insert(key)
        DeprecatedModelOptIns.save(deprecatedOptIns)
    }

    // MARK: - Plan mode (BET-952)

    /// The resolved plan toggle for the composer chip: availability from the
    /// fetched agent list, `on` from the persisted per-session flag, `agent`
    /// (when on) the value to send on `opencode:prompt`.
    var planToggle: ChatModel.PlanToggle {
        ChatModel.planToggle(agents: agents, on: planOn)
    }

    /// Flip plan mode for this session, persisting the boolean. Plan mode
    /// changes the agent, never the model (mirroring the desktop's togglePlan
    /// at `src/renderer/ChatPanel.tsx`), so this ONLY sets the flag — the model
    /// key is untouched, exactly as on desktop.
    func setPlan(_ on: Bool) {
        planOn = on
        UserDefaults.standard.set(on, forKey: Self.planKey(for: sessionId))
    }
}
