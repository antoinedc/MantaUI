import Foundation
import Combine

// ===========================================================================
// The composer's remote typeahead sources (WS03): the box's opencode commands +
// skills for the `/` palette, and the `@` file / reference search.
//
// One instance per composer (`@StateObject` in ComposerView). Commands are
// cached per working directory for the life of the composer (desktop: one fetch
// per panel per directory); a failed load is retried by the next call.
// ===========================================================================

@MainActor
final class ComposerTypeaheadSources: ObservableObject {

    enum Load<T: Equatable & Sendable>: Equatable {
        case idle
        case loading
        case loaded(T)
        case failed(String)
    }

    @Published private(set) var commands: Load<[OpencodeCommandInfo]> = .idle
    @Published private(set) var references: [OpencodeReferenceInfo] = []
    @Published private(set) var fileResults: [String] = []
    @Published private(set) var fileSearching = false

    /// The directory (nil → "") the current `commands` state belongs to.
    private var commandsKey = ""
    private var commandsGeneration = 0
    private var commandsTask: Task<Void, Never>?
    private var searchTask: Task<Void, Never>?
    private var searchSeq = 0

    /// Most file rows kept for one query (the popup caps what it shows).
    private static let fileResultLimit = 20

    init() {}

    /// The loaded command list, or nil while idle / loading / failed.
    var loadedCommands: [OpencodeCommandInfo]? {
        if case .loaded(let list) = commands { return list }
        return nil
    }

    // MARK: - Commands

    /// Start loading the command list for `directory` unless it is already
    /// loading or loaded for that directory. A different directory reloads; a
    /// failed load is retried.
    func ensureCommands(api: MantaAPIClient, directory: String?) {
        let key = directory ?? ""
        if key == commandsKey {
            switch commands {
            case .loading, .loaded: return
            case .idle, .failed: break
            }
        }
        commandsKey = key
        commandsGeneration += 1
        let generation = commandsGeneration
        commands = .loading
        commandsTask?.cancel()
        commandsTask = Task { @MainActor [self] in
            let result: Load<[OpencodeCommandInfo]>
            do {
                let list = try await api.commands(directory: directory)
                result = .loaded(list)
            } catch {
                result = .failed(ComposerErrorCopy.message(for: error))
            }
            guard generation == commandsGeneration else { return }
            commands = result
        }
    }

    /// The command list for `directory`, waiting up to `timeout` for an
    /// in-flight (or freshly started) load. nil on timeout or failure — the
    /// caller then treats the list as unknown.
    func awaitCommands(api: MantaAPIClient, directory: String?, timeout: Duration) async -> [OpencodeCommandInfo]? {
        ensureCommands(api: api, directory: directory)
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while true {
            switch commands {
            case .loaded(let list): return list
            case .failed: return nil
            case .idle, .loading: break
            }
            if ContinuousClock.now >= deadline { return nil }
            do {
                try await Task.sleep(for: .milliseconds(40))
            } catch {
                return nil
            }
        }
    }

    // MARK: - @ search

    /// Debounced (250 ms) file search + references fetch for an `@` query. The
    /// two run concurrently and independently — a references failure keeps the
    /// file results (and the other way round). Sequence-guarded so a stale
    /// response never overwrites a newer one.
    func search(api: MantaAPIClient, query: String, directory: String?) {
        searchTask?.cancel()
        searchSeq += 1
        let seq = searchSeq
        fileSearching = true
        searchTask = Task { @MainActor [self] in
            do {
                try await Task.sleep(for: .milliseconds(250))
            } catch {
                return
            }
            async let files: [String]? = try? await api.findFiles(query: query, directory: directory)
            async let refs: [OpencodeReferenceInfo]? = try? await api.references()
            let foundFiles = await files
            let foundRefs = await refs
            guard !Task.isCancelled, searchSeq == seq else { return }
            fileResults = Array((foundFiles ?? []).prefix(Self.fileResultLimit))
            // A failed references fetch keeps the last known list.
            if let foundRefs { references = foundRefs }
            fileSearching = false
        }
    }

    /// Stop any pending search and clear its results (the `@` token ended).
    func cancelSearch() {
        searchTask?.cancel()
        searchSeq += 1
        if fileSearching { fileSearching = false }
        if !fileResults.isEmpty { fileResults = [] }
    }
}
