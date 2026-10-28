import Foundation
import CryptoKit

// ===========================================================================
// WS01 F1 — local staging of a transcript file so QuickLook and ImageIO can
// read it.
//
// Bounded on every axis:
//   - MEMORY: a box file is size-checked (`HEAD`, or the size the box reported)
//     and then streamed to DISK, aborting once it crosses the cap; a data URL is
//     size-checked before it is decoded.
//   - DISK: files live under `temporaryDirectory/transcript-files/`, at most
//     `maxFiles` of them, least recently used out first. The first use in a
//     process wipes the directory, so nothing survives from an earlier run.
//   - IDENTITY: the cache is keyed by box id + server URL + source. When the
//     paired box changes, in-flight work is cancelled and everything is dropped,
//     so the same path on a NEW box can never show the old box's file.
//
// The key INPUT is pure (`TranscriptStagingKey.input`, tested on Linux); only the
// SHA-256 of it happens here, with CryptoKit.
// ===========================================================================

/// Why a transcript file could not be staged.
enum TranscriptFileFailure: Error, Equatable, Sendable {
    /// More than `TranscriptMediaGeometry.maxPreviewBytes`; the associated value
    /// is the size, in bytes, that tripped the cap.
    case tooLarge(Int64)
    case unavailable(String)
}

@MainActor
final class TranscriptFileStager {
    static let shared = TranscriptFileStager()

    typealias Failure = TranscriptFileFailure

    /// Which box the cache belongs to.
    struct Identity: Equatable, Sendable {
        var boxID: String?
        var serverURL: String?
    }

    /// The two network calls staging needs, injectable for tests.
    struct Backend: Sendable {
        var peekSize: @Sendable (String) async throws -> Int64?
        var download: @Sendable (String, URL, Int64) async throws -> Void

        static let live = Backend(
            peekSize: { path in try await MantaAPIClient.live().peekFileSize(path: path) },
            download: { path, destination, maxBytes in
                try await MantaAPIClient.live().downloadPeekFile(path: path, to: destination, maxBytes: maxBytes)
            }
        )
    }

    static let maxFiles = 64

    private let identity: @MainActor () -> Identity
    private let backend: Backend
    private let fileManager: FileManager
    private let root: URL

    private var cacheIdentity: Identity?
    private var files: [String: URL] = [:]
    private var lru: [String] = []
    private var inflight: [String: Task<URL, Error>] = [:]
    private var generation = 0
    private var wipedRoot = false

    init(
        identity: @escaping @MainActor () -> Identity = {
            Identity(
                boxID: KeychainCredentialStore.shared.boxId,
                serverURL: KeychainCredentialStore.shared.serverURL?.absoluteString
            )
        },
        backend: Backend = .live,
        fileManager: FileManager = .default,
        root: URL? = nil
    ) {
        self.identity = identity
        self.backend = backend
        self.fileManager = fileManager
        self.root = root ?? FileManager.default.temporaryDirectory.appendingPathComponent("transcript-files", isDirectory: true)
    }

    /// Files currently cached (for tests).
    var cachedCount: Int { files.count }

    /// A local file URL for `source`, staging it first when needed. `sizeHint` is
    /// the size the box already reported (skips the `HEAD`). `filename` names the
    /// staged file (QuickLook titles itself from it and picks its viewer from its
    /// extension). Throws `TranscriptFileFailure` for an over-cap or unreadable
    /// source, and `CancellationError` when a reset cancelled the work — which a
    /// caller treats as "no change".
    func localURL(for source: TranscriptFileRef.Source, sizeHint: Int64?, filename: String? = nil) async throws -> URL {
        let current = identity()
        if let cacheIdentity, cacheIdentity != current { reset() }
        cacheIdentity = current
        wipeRootOnFirstUse()

        let name = Self.sha256Hex(TranscriptStagingKey.input(boxID: current.boxID, serverURL: current.serverURL, source: source))
        if let cached = files[name], fileManager.fileExists(atPath: cached.path) {
            touch(name)
            return cached
        }
        if let running = inflight[name] {
            return try await running.value
        }

        let generationAtStart = generation
        let target = directory(for: current, name: name)
            .appendingPathComponent(Self.localFilename(source: source, filename: filename))
        let task = Task<URL, Error> { [self] in
            try await stage(source: source, sizeHint: sizeHint, name: name, target: target, generation: generationAtStart)
        }
        inflight[name] = task
        return try await task.value
    }

    /// Cancel in-flight work, drop the cache and delete this run's files.
    func reset() {
        generation += 1
        for task in inflight.values { task.cancel() }
        inflight = [:]
        files = [:]
        lru = []
        removeRoot()
    }

    // MARK: Staging

    private func stage(
        source: TranscriptFileRef.Source,
        sizeHint: Int64?,
        name: String,
        target: URL,
        generation startGeneration: Int
    ) async throws -> URL {
        defer {
            if generation == startGeneration { inflight[name] = nil }
        }
        let cap = TranscriptMediaGeometry.maxPreviewBytes
        let directory = target.deletingLastPathComponent()
        switch source {
        case .none:
            throw Failure.unavailable("There is no file to open")
        case .boxPath(let path):
            let size: Int64?
            if let sizeHint {
                size = sizeHint
            } else {
                size = try await backend.peekSize(path)
            }
            if let size, size > cap { throw Failure.tooLarge(size) }
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
            let partial = directory.appendingPathComponent(".partial")
            try await backend.download(path, partial, cap)
            if fileManager.fileExists(atPath: target.path) { try fileManager.removeItem(at: target) }
            try fileManager.moveItem(at: partial, to: target)
        case .dataURL(_, let base64):
            let size = TranscriptFileParse.decodedSize(base64: base64)
            if size > cap { throw Failure.tooLarge(size) }
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
            try await Self.writeDecoded(base64: base64, to: target)
        }
        // A reset while the work ran: drop what it produced.
        guard generation == startGeneration, !Task.isCancelled else {
            removeItemQuietly(at: directory)
            throw CancellationError()
        }
        record(name: name, url: target)
        return target
    }

    /// Decode and write off the main actor: up to 25 MB.
    nonisolated private static func writeDecoded(base64: String, to url: URL) async throws {
        guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else {
            throw TranscriptFileFailure.unavailable("This attachment isn't valid data")
        }
        try data.write(to: url, options: .atomic)
    }

    // MARK: Cache

    private func record(name: String, url: URL) {
        files[name] = url
        touch(name)
        while lru.count > Self.maxFiles {
            let oldest = lru.removeFirst()
            if let evicted = files.removeValue(forKey: oldest) {
                removeItemQuietly(at: evicted.deletingLastPathComponent())
            }
        }
    }

    private func touch(_ name: String) {
        lru.removeAll { $0 == name }
        lru.append(name)
    }

    private func wipeRootOnFirstUse() {
        guard !wipedRoot else { return }
        wipedRoot = true
        removeRoot()
    }

    private func removeRoot() {
        removeItemQuietly(at: root)
    }

    /// Deleting a cache file is best-effort cleanup — a leftover file is
    /// harmless (the whole directory is wiped at the next launch).
    private func removeItemQuietly(at url: URL) {
        try? fileManager.removeItem(at: url)
    }

    private func directory(for identity: Identity, name: String) -> URL {
        let owner = Self.sha256Hex((identity.boxID ?? "") + "\n" + (identity.serverURL ?? ""))
        return root
            .appendingPathComponent(owner, isDirectory: true)
            .appendingPathComponent(name, isDirectory: true)
    }

    // MARK: Pure helpers

    private static func sha256Hex(_ input: String) -> String {
        SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// The staged file's name: the display filename (sanitised), with an extension
    /// guessed from the mime when it has none, so QuickLook can pick a viewer.
    private static func localFilename(source: TranscriptFileRef.Source, filename: String?) -> String {
        var base = filename ?? ""
        if base.isEmpty, case .boxPath(let path) = source {
            base = (path as NSString).lastPathComponent
        }
        let forbidden = CharacterSet(charactersIn: "/\\:").union(.controlCharacters)
        base = base.components(separatedBy: forbidden).joined(separator: "_")
        if base.isEmpty || base == "." || base == ".." { base = "file" }
        if base.count > 100 { base = String(base.suffix(100)) }
        if (base as NSString).pathExtension.isEmpty, case .dataURL(let mime, _) = source, let ext = fileExtension(forMime: mime) {
            base += "." + ext
        }
        return base
    }

    private static func fileExtension(forMime mime: String?) -> String? {
        switch mime?.lowercased() {
        case "image/png": return "png"
        case "image/jpeg": return "jpg"
        case "image/gif": return "gif"
        case "image/webp": return "webp"
        case "image/heic": return "heic"
        case "video/mp4": return "mp4"
        case "video/quicktime": return "mov"
        case "application/pdf": return "pdf"
        case "text/plain": return "txt"
        default: return nil
        }
    }
}
