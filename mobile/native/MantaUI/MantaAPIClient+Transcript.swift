import Foundation

// ===========================================================================
// WS01 (C1) — bounded file access for transcript media and attachments.
//
// `GET` / `HEAD {serverURL}/api/peek?path=<box path>` with the bearer token. The
// box expands `~`, keeps the path inside the user's home and answers `HEAD` with
// `content-length` and no body. `peekFile(path:)` (MantaAPIClient.swift) loads a
// whole body into memory; these two members exist so a transcript image can be
// size-checked first and streamed to disk, never into memory.
//
// `tokenProvider` and `session` are private to MantaAPIClient.swift, so these
// build their request from the internal `serverURL` plus the token from the same
// Keychain source `MantaAPIClient.live()` uses.
// ===========================================================================

extension MantaAPIClient {
    /// A peek request: method + bearer token. Internal so a test can assert the
    /// auth header and method without a network.
    static func peekRequest(url: URL, method: String, token: String?) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func peekURL(path: String) throws -> URL {
        guard let url = TranscriptPeekRequest.url(serverURL: serverURL, path: path) else {
            throw MantaError.transport("invalid server address")
        }
        return url
    }

    /// `HEAD /api/peek?path=` → the file's byte count, or nil when the header is
    /// absent. Throws `authRequired` on 401 and `server(_)` on any other error.
    func peekFileSize(path: String) async throws -> Int64? {
        let request = Self.peekRequest(
            url: try peekURL(path: path),
            method: "HEAD",
            token: KeychainCredentialStore.shared.boxToken
        )
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { return nil }
        if http.statusCode == 401 { throw MantaError.authRequired }
        if http.statusCode >= 400 { throw MantaError.server("peek failed (\(http.statusCode))") }
        if let header = http.value(forHTTPHeaderField: "Content-Length"), let bytes = Int64(header) {
            return bytes
        }
        return nil
    }

    /// `GET /api/peek?path=` streamed to `destination` in 64 KiB chunks through a
    /// FileHandle — disk, never memory. It stops AS SOON AS the running byte count
    /// exceeds `maxBytes` (deleting the partial file), and refuses up front when
    /// the response already declares more. That covers a missing or lying
    /// `content-length`.
    ///
    /// Throws `TranscriptFileFailure.tooLarge`, `CancellationError` (the caller was
    /// cancelled or reset), `MantaError.authRequired` on 401, `MantaError.server`
    /// on any other error status.
    func downloadPeekFile(path: String, to destination: URL, maxBytes: Int64) async throws {
        let request = Self.peekRequest(
            url: try peekURL(path: path),
            method: "GET",
            token: KeychainCredentialStore.shared.boxToken
        )
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw MantaError.transport("the box did not answer with HTTP")
        }
        if http.statusCode == 401 { throw MantaError.authRequired }
        if http.statusCode >= 400 {
            var body = Data()
            for try await byte in bytes {
                body.append(byte)
                if body.count >= 4096 { break }
            }
            if let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
               let error = object["error"] as? String, !error.isEmpty {
                throw MantaError.server(error)
            }
            throw MantaError.server("peek failed (\(http.statusCode))")
        }
        if response.expectedContentLength > maxBytes {
            throw TranscriptFileFailure.tooLarge(response.expectedContentLength)
        }

        let fileManager = FileManager.default
        try fileManager.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard fileManager.createFile(atPath: destination.path, contents: nil) else {
            throw MantaError.transport("could not create a local file for the download")
        }
        let handle = try FileHandle(forWritingTo: destination)
        let chunkSize = 64 * 1024
        do {
            var chunk = [UInt8]()
            chunk.reserveCapacity(chunkSize)
            var total: Int64 = 0
            for try await byte in bytes {
                total += 1
                if total > maxBytes { throw TranscriptFileFailure.tooLarge(total) }
                chunk.append(byte)
                if chunk.count >= chunkSize {
                    try handle.write(contentsOf: Data(chunk))
                    chunk.removeAll(keepingCapacity: true)
                    try Task.checkCancellation()
                }
            }
            if !chunk.isEmpty { try handle.write(contentsOf: Data(chunk)) }
            try handle.close()
        } catch {
            // Best-effort cleanup; the ORIGINAL error is what the caller sees.
            try? handle.close()
            try? fileManager.removeItem(at: destination)
            if Task.isCancelled || (error as? URLError)?.code == .cancelled {
                throw CancellationError()
            }
            throw error
        }
    }
}
