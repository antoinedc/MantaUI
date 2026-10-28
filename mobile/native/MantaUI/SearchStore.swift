import Foundation

/// Runs one search request. Injected so the screen can be driven without a box.
typealias SearchFunction = @MainActor @Sendable (SearchRequest) async throws -> SearchResponse

/// A thin driver for `SearchQueryState`: debounces, runs the request, and feeds
/// the outcome back through the state machine, which owns every stale-result
/// rule. This type writes no state after an `await` except through
/// `receive` / `fail`.
@MainActor
final class SearchStore: ObservableObject {
    static let debounce: Duration = .milliseconds(120)

    @Published private(set) var state: SearchQueryState
    @Published var query = "" {
        // Keyed on the TRIMMED text, like the desktop: a trailing space or an
        // identical write is the same settled query and must not search twice.
        didSet {
            guard SearchCopy.normalized(oldValue) != SearchCopy.normalized(query) else { return }
            queryDidChange()
        }
    }

    private let search: SearchFunction
    private var task: Task<Void, Never>?

    init(primarySessionId: String?, search: @escaping SearchFunction) {
        self.state = SearchQueryState(primarySessionId: primarySessionId)
        self.search = search
    }

    /// "Try again" — re-runs the last active query.
    func retry() {
        task?.cancel()
        task = nil
        guard let ticket = state.retry() else { return }
        run(ticket, debounced: false)
    }

    /// The sheet went away: cancel the request and drop any late completion.
    func dismissed() {
        task?.cancel()
        task = nil
        state.invalidate()
    }

    private func queryDidChange() {
        task?.cancel()
        task = nil
        guard let ticket = state.queryChanged(query) else { return }
        run(ticket, debounced: true)
    }

    private func run(_ ticket: SearchTicket, debounced: Bool) {
        let request = state.request(for: ticket)
        task = Task { [weak self] in
            if debounced {
                do { try await Task.sleep(for: Self.debounce) } catch { return }
            }
            guard let self else { return }
            do {
                let response = try await self.search(request)
                self.state.receive(response, for: ticket)
            } catch {
                self.state.fail(error, for: ticket)
            }
        }
    }
}
