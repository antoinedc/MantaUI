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
// ===========================================================================

@MainActor
final class ChatModelCatalog: ObservableObject {

    @Published private(set) var models: [OpencodeModel] = []
    @Published private(set) var defaultModel: OpencodeModelID?
    @Published private(set) var loadFailed = false
    /// True once the model list has arrived (or failed). Drives the composer
    /// pill's loading state and the picker's "Loading models…" placeholder.
    @Published private(set) var loaded = false

    static let shared = ChatModelCatalog()

    private let api: MantaAPIClient
    private var didStart = false

    init(api: MantaAPIClient = .live()) {
        self.api = api
    }

    /// Fetch the box's model list + default exactly once. Idempotent: a second
    /// call while a fetch is in flight, or after one has completed, does
    /// nothing — which is what lets every ChatModelStore (including a freshly
    /// rebuilt one after a clear) share the same loaded list. A failed/empty
    /// fetch still flips `loaded` (so the pill leaves its loading state); the
    /// HTTP error is not distinguished from a genuinely empty box — matching
    /// the prior per-store behaviour.
    func loadIfNeeded() {
        guard !didStart, !loaded else { return }
        didStart = true
        Task {
            let modelsResult = (try? await api.models()) ?? []
            let defaultResult = try? await api.defaultModel()
            await MainActor.run {
                self.models = modelsResult
                self.defaultModel = defaultResult
                self.loadFailed = modelsResult.isEmpty && defaultResult == nil
                self.loaded = true
            }
        }
    }
}
