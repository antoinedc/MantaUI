import Foundation
import Combine

// ===========================================================================
// WS09 F1 — the Models screen's state. View state only: every rule (Main / Sub /
// Default invariants, the deprecated lock, the override diff, the subagent
// reconcile outcome) is the box's (`models:table` and the `models:*` writes).
// Each action calls ONE write channel, takes `table` from the reply and shows the
// reply's own `message`.
// ===========================================================================

@MainActor
final class ModelsStore: ObservableObject {

    enum Phase: Equatable {
        case loading
        case loaded(ModelsTableWire)
        /// The box predates `models:table` ("Update your box to use this.").
        case unsupported
        case failed(String)
    }

    enum Feedback: Equatable {
        /// Auto-clears after 3 s.
        case saved(String)
        case failed(String)
        /// Saved, but the subagent list on the box was not (fully) updated.
        /// `retry` is true only for `not-applied` (Try again re-runs the sync).
        case partial(String, retry: Bool)
    }

    struct FieldError: Equatable {
        let field: String
        let message: String
    }

    @Published private(set) var phase: Phase = .loading
    /// The row key whose write is in flight ("" for a table-level retry).
    @Published private(set) var busyKey: String?
    @Published private(set) var feedback: Feedback?
    @Published private(set) var fieldError: FieldError?

    private let api: MantaAPIClient
    private let catalog: ChatModelCatalog
    private var cancellables: Set<AnyCancellable> = []
    private var feedbackSeq = 0
    private var started = false

    init(api: MantaAPIClient = .live(), catalog: ChatModelCatalog = .shared) {
        self.api = api
        self.catalog = catalog
    }

    // MARK: - Reading

    /// Load the table and keep it fresh while the screen is open (another device's
    /// write arrives as `models.updated`).
    func start() {
        guard !started else { return }
        started = true
        catalog.modelsUpdates
            .receive(on: DispatchQueue.main)
            .sink { [weak self] in Task { await self?.refresh() } }
            .store(in: &cancellables)
        Task { await refresh() }
    }

    func stop() {
        cancellables.removeAll()
        started = false
    }

    func refresh() async {
        do {
            phase = .loaded(try await api.modelsTable())
        } catch {
            if ModelsCapability.isUnsupported(error) {
                phase = .unsupported
            } else if case .loaded = phase {
                // Keep what is on screen; a background refresh failing is not news.
            } else {
                phase = .failed(ModelsCapability.reason(error))
            }
        }
    }

    var table: ModelsTableWire? {
        if case .loaded(let table) = phase { return table }
        return nil
    }

    func row(key: String) -> ModelsTableRowWire? {
        table?.rows.first { $0.key == key }
    }

    // MARK: - Writes (one channel each)

    func setDefault(key: String?) async {
        await write(key: key ?? "") { [api] in try await api.modelsSetDefault(key: key) }
    }

    func setMain(key: String, on: Bool) async {
        await write(key: key) { [api] in try await api.modelsSetMain(key: key, on: on) }
    }

    func setSub(key: String, on: Bool) async {
        await write(key: key) { [api] in try await api.modelsSetSub(key: key, on: on) }
    }

    /// "Enable deprecated model" — also registers it as a subagent.
    func optIn(key: String) async {
        await write(key: key) { [api] in try await api.modelsOptIn(keys: [key]) }
    }

    /// "Try again" on a partial save: re-runs only the subagent sync.
    func retrySubSync() async {
        await write(key: "") { [api] in try await api.modelsRetrySubSync() }
    }

    /// Sends the three strings as typed. Returns true when the box saved them (the
    /// edit form closes); a `context` error stays under that field.
    @discardableResult
    func saveOverride(key: String, name: String, description: String, context: String) async -> Bool {
        await write(key: key) { [api] in
            try await api.modelsSetOverride(key: key, name: name, description: description, context: context)
        }
    }

    func dismissFeedback() {
        feedbackSeq += 1
        feedback = nil
    }

    func clearFieldError() {
        fieldError = nil
    }

    @discardableResult
    private func write(key: String, _ call: @escaping () async throws -> ModelsWriteReply) async -> Bool {
        guard busyKey == nil else { return false }
        busyKey = key
        fieldError = nil
        dismissFeedback()
        defer { busyKey = nil }
        do {
            let reply = try await call()
            guard reply.ok else {
                if let field = reply.field {
                    fieldError = FieldError(field: field, message: reply.message)
                } else {
                    show(.failed(reply.message))
                }
                return false
            }
            if let table = reply.table {
                phase = .loaded(table)
            } else {
                await refresh()
            }
            // A failed catalogue reload never turns a save into a failure.
            catalog.reload()
            if reply.isPartial {
                show(.partial(reply.message, retry: reply.retry == true))
            } else {
                show(.saved(reply.message))
            }
            return true
        } catch {
            if ModelsCapability.isUnsupported(error) {
                phase = .unsupported
            } else {
                show(.failed("Couldn't save — \(ModelsCapability.reason(error)). Pull to refresh to check what changed."))
            }
            return false
        }
    }

    private func show(_ next: Feedback) {
        feedbackSeq += 1
        feedback = next
        guard case .saved = next else { return }
        let seq = feedbackSeq
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard let self, self.feedbackSeq == seq else { return }
            self.feedback = nil
        }
    }
}
