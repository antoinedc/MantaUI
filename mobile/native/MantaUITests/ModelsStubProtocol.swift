import Foundation
@testable import MantaUI

/// A recording `/rpc` stub for the WS09 store tests: replies per channel, records
/// every request (host, bearer, channel, JSON args), and can hold a channel's
/// answer until the test releases it (to prove a late answer is dropped).
final class ModelsStubProtocol: URLProtocol, @unchecked Sendable {
    struct Recorded: Equatable {
        let host: String
        let auth: String
        let channel: String
        let args: String
    }

    nonisolated(unsafe) static var responses: [String: String] = [:]
    nonisolated(unsafe) static var recorded: [Recorded] = []
    nonisolated(unsafe) static var held: Set<String> = []
    nonisolated(unsafe) private static var pending: [ModelsStubProtocol] = []
    private static let lock = NSLock()

    static func reset() {
        lock.lock(); defer { lock.unlock() }
        responses = [:]; recorded = []; held = []; pending = []
    }

    static func count(_ channel: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return recorded.filter { $0.channel == channel }.count
    }

    /// The decoded `args` array of the first recorded request on `channel`. Compare
    /// decoded values, never substrings: `JSONSerialization` escapes "/" as "\/", so
    /// a key like "anthropic/old" never appears verbatim in the recorded body.
    static func args(of channel: String) -> [Any] {
        lock.lock(); defer { lock.unlock() }
        guard let body = recorded.first(where: { $0.channel == channel })?.args.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        else { return [] }
        return object["args"] as? [Any] ?? []
    }

    /// Answer later requests on every channel immediately again, leaving the ones
    /// already held pending (released by `releaseHeld()`).
    static func stopHolding() {
        lock.lock(); defer { lock.unlock() }
        held = []
    }

    static func releaseHeld() {
        lock.lock()
        let toFinish = pending
        pending = []
        held = []
        lock.unlock()
        for p in toFinish { p.finish() }
    }

    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ModelsStubProtocol.self]
        return URLSession(configuration: config)
    }

    static func client(host: String = "box.example", token: String = "tok") -> MantaAPIClient {
        MantaAPIClient(serverURL: URL(string: "https://\(host)")!, tokenProvider: { token }, session: session())
    }

    static func makeClient(_ binding: ModelsBoxBinding) -> MantaAPIClient {
        MantaAPIClient(serverURL: binding.serverURL, tokenProvider: { binding.token }, session: session())
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let channel = request.url?.lastPathComponent ?? ""
        var body = ""
        if let data = request.httpBodyStream.map(Self.read) ?? request.httpBody { body = String(decoding: data, as: UTF8.self) }
        Self.lock.lock()
        Self.recorded.append(Recorded(
            host: request.url?.host ?? "",
            auth: request.value(forHTTPHeaderField: "Authorization") ?? "",
            channel: channel,
            args: body
        ))
        let hold = Self.held.contains(channel)
        if hold { Self.pending.append(self) }
        Self.lock.unlock()
        if !hold { finish() }
    }

    override func stopLoading() {}

    private func finish() {
        let channel = request.url?.lastPathComponent ?? ""
        Self.lock.lock()
        let body = Self.responses[channel] ?? #"{"result":null}"#
        Self.lock.unlock()
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    private static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }
}

/// Poll a main-actor condition until it holds (stores finish work in detached-looking Tasks).
@MainActor
func eventually(timeout: Double = 3, _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
}
