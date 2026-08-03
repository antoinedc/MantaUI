import Foundation
import Combine

// ===========================================================================
// S5 — model store for the composer (BET-597).
//
// Owns the model list + per-session override. Box-side data comes from the
// existing `opencode:models` / `opencode:default-model` RPCs; the per-session
// override is a plain `providerID/modelID` string in UserDefaults (NOT a
// credential — the raw string encodes provider+model ids only), mirroring the
// desktop's `manta:chat:<sessionId>:model` localStorage key. Resolution
// (override ?? default) is pure ChatModel logic, tested separately.
// ===========================================================================

@MainActor
final class ChatModelStore: ObservableObject {

    @Published private(set) var models: [OpencodeModel] = []
    @Published private(set) var defaultModel: OpencodeModelID?
    @Published private(set) var override: OpencodeModelID?
    /// Reasoning-effort variant for the selected model (opencode calls these
    /// model "variants"). Model-specific, so it is cleared whenever the model
    /// changes rather than carried onto a model that has no such setting.
    @Published private(set) var variant: String?
    @Published private(set) var loadFailed = false

    let sessionId: String
    private let api: MantaAPIClient

    init(sessionId: String, api: MantaAPIClient) {
        self.sessionId = sessionId
        self.api = api
        self.override = Self.loadOverride(for: sessionId)
        self.variant = UserDefaults.standard.string(forKey: Self.variantKey(for: sessionId))
    }

    /// The UserDefaults key mirroring the desktop's per-session model key.
    static func storageKey(for sessionId: String) -> String {
        "manta:chat:\(sessionId):model"
    }

    static func variantKey(for sessionId: String) -> String {
        "manta:chat:\(sessionId):variant"
    }

    func load() {
        Task {
            let modelsResult = (try? await api.models()) ?? []
            let defaultResult = try? await api.defaultModel()
            await MainActor.run {
                self.models = modelsResult
                self.defaultModel = defaultResult
                self.loadFailed = modelsResult.isEmpty && defaultResult == nil
            }
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
