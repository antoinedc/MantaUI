import Foundation
import Combine

// ===========================================================================
// S5 — box-wide model catalog (BET-597).
//
// The model list + server-default are data about the BOX, not about any one
// chat session — identical across sessions. So they are fetched once and shared
// through a single app-wide catalog rather than refetched per ChatModelStore.
//
// This is what keeps the model list from reloading when a session is cleared:
// clearing swaps the session id and rebuilds the screen's stores, but the
// catalog has already loaded and `loadIfNeeded()` is a no-op, so the new store
// seeds instantly from the same in-memory list. No second round-trip.
//
// WS09 (server-first, D24): the catalog also holds the BOX's picker decision
// (`models:picker` — which models are selectable, which deprecated ones are
// locked, the recents that survive), so no client derives that again. It
// refreshes on the raw `models.updated` frame (full reload) and
// `model-prefs.updated` (picker only), and when the set of providers changes
// (WS08's `.mantaProvidersChanged`).
//
// Box lifecycle: this is a process-wide singleton and the app can switch boxes
// without relaunching, so it owns its client PER BOX (`ModelsBoxBinding`): URL
// and token always come from one Keychain snapshot, a box change drops every
// piece of state, and a late answer from the old box is discarded by `generation`.
// ===========================================================================

@MainActor
final class ChatModelCatalog: ObservableObject {

    @Published private(set) var models: [OpencodeModel] = []
    /// The opencode provider's own default (from `opencode:default-model`).
    @Published private(set) var defaultModel: OpencodeModelID?
    /// The box config's `defaultModel` (`AppConfig.defaultModel` shape) read
    /// from `config:get` — the middle tier of the per-session precedence.
    @Published private(set) var configDefault: OpencodeModelID?
    /// True once the model list has arrived (or failed). Drives the composer
    /// pill's loading state and the picker's "Loading models…" placeholder.
    @Published private(set) var loaded = false
    /// The box's picker decision, nil until the first read (or on an older box).
    @Published private(set) var picker: ModelsPickerWire?
    /// The box predates `models:picker`: everything enabled stays selectable and
    /// the picker says "Update your box to hide models and manage deprecated ones."
    @Published private(set) var pickerUnsupported = false
    /// The last picker read failed for a reason other than an older box; the
    /// picker offers a retry instead of silently locking every model.
    @Published private(set) var pickerError: String?

    /// Fires on every `models.updated` frame (after the catalogue reload starts),
    /// so an open Models screen refetches its own table. A subject because the
    /// raw-frame handler list cannot unsubscribe and the screen comes and goes.
    let modelsUpdates = PassthroughSubject<Void, Never>()

    static let shared = ChatModelCatalog()

    private let fixedClient: MantaAPIClient?
    private let credentials: @MainActor () -> ModelsBoxCredentials?
    private let makeClient: (ModelsBoxBinding) -> MantaAPIClient
    private let defaults: UserDefaults
    private var api: MantaAPIClient?
    private(set) var binding: ModelsBoxBinding?
    private var generation = 0
    private var didStart = false
    private var boundEvents = false
    private var loadTask: Task<Void, Never>?
    private var pickerTask: Task<Void, Never>?
    nonisolated(unsafe) private var providersObserver: NSObjectProtocol?
    nonisolated(unsafe) private var removedObserver: NSObjectProtocol?

    /// - Parameter api: a fixed client (tests); production derives its client
    ///   from the Keychain per box.
    init(
        api: MantaAPIClient? = nil,
        credentials: @escaping @MainActor () -> ModelsBoxCredentials? = ChatModelCatalog.keychainCredentials,
        makeClient: @escaping (ModelsBoxBinding) -> MantaAPIClient = ChatModelCatalog.liveClient,
        defaults: UserDefaults = .standard
    ) {
        self.fixedClient = api
        self.credentials = credentials
        self.makeClient = makeClient
        self.defaults = defaults
        providersObserver = NotificationCenter.default.addObserver(
            forName: .mantaProvidersChanged, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.reload() }
        }
        removedObserver = NotificationCenter.default.addObserver(
            forName: .mantaBoxRemoved, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.resetForBoxChange() }
        }
    }

    deinit {
        if let providersObserver { NotificationCenter.default.removeObserver(providersObserver) }
        if let removedObserver { NotificationCenter.default.removeObserver(removedObserver) }
    }

    @MainActor
    static func keychainCredentials() -> ModelsBoxCredentials? {
        guard let stored = (try? KeychainCredentialStore.shared.load()) ?? nil else { return nil }
        return ModelsBoxCredentials(serverUrl: stored.serverUrl, boxId: stored.boxId, boxToken: stored.boxToken)
    }

    static func liveClient(_ binding: ModelsBoxBinding) -> MantaAPIClient {
        MantaAPIClient(serverURL: binding.serverURL, tokenProvider: { [token = binding.token] in token })
    }

    // MARK: - Loading

    /// Fetch the box's model list + the two defaults + the picker exactly once.
    /// Idempotent: a second call while a fetch is in flight, or after one has
    /// completed, does nothing — which is what lets every ChatModelStore
    /// (including a freshly rebuilt one after a clear) share the same loaded
    /// list. A failed/empty fetch still flips `loaded` (so the pill leaves its
    /// loading state). The box `defaultModel` is read through the EXISTING
    /// `config:get` channel at the same time the models load.
    func loadIfNeeded() {
        guard !didStart, !loaded else { return }
        startLoad()
    }

    /// Re-read everything the catalogue holds (models, both defaults, picker).
    /// A failed read keeps what is already shown.
    func reload() {
        startLoad()
    }

    /// Refetch only the picker (recents changed on another device).
    func reloadPicker() {
        guard let client = currentClient() else { return }
        let gen = generation
        pickerTask?.cancel()
        pickerTask = Task { [weak self] in
            await self?.fetchPicker(client: client, generation: gen)
        }
    }

    private func startLoad() {
        guard let client = currentClient() else { return }
        didStart = true
        let gen = generation
        loadTask?.cancel()
        loadTask = Task { [weak self] in
            let modelsResult = try? await client.models()
            let defaultResult = try? await client.defaultModel()
            let config = (try? await client.configGet()) ?? nil
            guard let self, gen == self.generation else { return }
            // A reload that failed keeps the list already shown; the first load
            // still flips `loaded` so the pill leaves its loading state.
            if let modelsResult { self.models = modelsResult }
            if let defaultResult { self.defaultModel = defaultResult } else if modelsResult != nil { self.defaultModel = nil }
            self.configDefault = Self.configDefaultID(config)
            self.loaded = true
            await self.fetchPicker(client: client, generation: gen)
        }
    }

    private func fetchPicker(client: MantaAPIClient, generation gen: Int) async {
        do {
            let fresh = try await client.modelsPicker()
            guard gen == generation else { return }
            picker = fresh
            pickerUnsupported = false
            pickerError = nil
            await copyDeprecatedOptIns(client: client, generation: gen)
        } catch {
            guard gen == generation else { return }
            if ModelsCapability.isUnsupported(error) {
                picker = nil
                pickerUnsupported = true
                pickerError = nil
            } else if picker == nil {
                pickerError = "Couldn't load the model list's rules."
            }
        }
    }

    /// One-time copy of the on-device deprecated-model opt-ins to the box (D24):
    /// after the first successful picker read for a binding, when the local set is
    /// non-empty and the per-box flag is unset. On success the flag is set and the
    /// local set cleared; on failure both stay and the next picker read retries —
    /// silent, because the user did nothing (the models simply stay locked).
    private func copyDeprecatedOptIns(client: MantaAPIClient, generation gen: Int) async {
        let boxKey = binding?.boxKey ?? "fixed-client"
        let flag = DeprecatedOptInCopy.flagKey(boxKey: boxKey)
        let local = DeprecatedModelOptIns.load(defaults)
        guard DeprecatedOptInCopy.shouldCopy(local: local, alreadyCopied: defaults.bool(forKey: flag)) else { return }
        guard let reply = try? await client.modelsOptIn(keys: local.sorted()), reply.ok, gen == generation else { return }
        defaults.set(true, forKey: flag)
        DeprecatedModelOptIns.save([], defaults)
        if let fresh = try? await client.modelsPicker(), gen == generation { picker = fresh }
    }

    /// Test seam: wait for the load / picker fetches started by `reload()` & co.
    func waitForLoad() async {
        await loadTask?.value
        await pickerTask?.value
    }

    /// Test seam: seed the box's picker decision without a network round trip.
    func setPickerForTesting(_ picker: ModelsPickerWire?) {
        self.picker = picker
    }

    // MARK: - Bus

    /// Subscribe to the box's `models.updated` (full reload) and
    /// `model-prefs.updated` (picker only) frames. Idempotent; called once from
    /// `UsageAlertsStore.bind(eventStore:)` at the app root.
    func subscribe(to eventStore: MantaEventStore) {
        guard !boundEvents else { return }
        boundEvents = true
        eventStore.addRawFrameHandler { [weak self] frame in
            switch frame.kind {
            case "models.updated":
                self?.reload()
                self?.modelsUpdates.send()
            case "model-prefs.updated":
                self?.reloadPicker()
            default:
                break
            }
        }
    }

    // MARK: - Box lifecycle

    /// Drop everything belonging to the previous box. Nothing is fetched until a
    /// chat or the Models screen asks again.
    func resetForBoxChange() {
        generation += 1
        loadTask?.cancel()
        pickerTask?.cancel()
        loadTask = nil
        pickerTask = nil
        api = nil
        binding = nil
        models = []
        defaultModel = nil
        configDefault = nil
        picker = nil
        pickerUnsupported = false
        pickerError = nil
        loaded = false
        didStart = false
    }

    /// The client for the CURRENT credentials, or nil while unpaired. A different
    /// box resets the state first; the client is built from one snapshot so a
    /// request can only ever pair box B's URL with box B's token.
    private func currentClient() -> MantaAPIClient? {
        if let fixedClient { return fixedClient }
        switch ModelsBoxBinding.resolve(current: binding, credentials: credentials()) {
        case .unpaired:
            return nil
        case .same:
            if let api { return api }
            guard let binding else { return nil }
            let client = makeClient(binding)
            api = client
            return client
        case .rebind(let next, let boxChanged):
            if boxChanged { resetForBoxChange() }
            binding = next
            let client = makeClient(next)
            api = client
            return client
        }
    }

    /// Extract the box config's `defaultModel` (`{ providerID, modelID }`)
    /// from a `config:get` envelope. Malformed/absent → nil.
    private static func configDefaultID(_ config: [String: JSONValue]?) -> OpencodeModelID? {
        guard case .object(let dm)? = config?["defaultModel"],
              case .string(let providerID)? = dm["providerID"],
              case .string(let modelID)? = dm["modelID"]
        else { return nil }
        return OpencodeModelID(providerID: providerID, modelID: modelID)
    }
}
