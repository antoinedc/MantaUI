import Foundation

enum MantaError: Error, Equatable {
    case authRequired
    case server(String)
    case transport(String)
}

final class MantaAPIClient: Sendable {
    let serverURL: URL
    private let tokenProvider: @Sendable () -> String?
    private let session: URLSession

    init(serverURL: URL,
         tokenProvider: @escaping @Sendable () -> String? = { KeychainCredentialStore.shared.boxToken },
         session: URLSession = .shared) {
        self.serverURL = serverURL
        self.tokenProvider = tokenProvider
        self.session = session
    }

    func listSessions(directory: String? = nil) async throws -> [OpencodeSessionListItem] {
        let args: [Any] = directory.map { [$0] } ?? []
        return try await call("opencode:list-sessions", args: args, as: [OpencodeSessionListItem].self) ?? []
    }

    func messages(sessionId: String) async throws -> [OpencodeMessage] {
        try await call("opencode:messages", args: [sessionId], as: [OpencodeMessage].self) ?? []
    }

    func sendPrompt(_ input: SendPromptInput) async throws {
        var argsDict: [String: Any] = [
            "sessionId": input.sessionId,
            "text": input.text,
        ]
        if let model = input.model {
            var modelDict: [String: Any] = [
                "providerID": model.providerID,
                "modelID": model.modelID,
            ]
            if let variant = model.variant {
                modelDict["variant"] = variant
            }
            argsDict["model"] = modelDict
        }
        if let attachments = input.attachments {
            argsDict["attachments"] = attachments.map { attachment in
                var dict: [String: Any] = [
                    "remotePath": attachment.remotePath,
                    "mime": attachment.mime,
                ]
                if let filename = attachment.filename {
                    dict["filename"] = filename
                }
                return dict
            }
        }
        if let mentions = input.mentions {
            argsDict["mentions"] = mentions.map { mention in
                [
                    "name": mention.name,
                    "source": [
                        "value": mention.source.value,
                        "start": mention.source.start,
                        "end": mention.source.end,
                    ],
                ]
            }
        }
        _ = try await callVoid("opencode:prompt", args: [argsDict])
    }

    func permissions(sessionId: String? = nil) async throws -> [PermissionRequest] {
        let args: [Any] = sessionId.map { [$0] } ?? []
        return try await call("opencode:permissions", args: args, as: [PermissionRequest].self) ?? []
    }

    func permissionReply(requestId: String, reply: PermissionReply, sessionId: String? = nil) async throws {
        var dict: [String: Any] = [
            "requestId": requestId,
            "reply": reply.rawValue,
        ]
        if let sessionId {
            dict["sessionId"] = sessionId
        }
        _ = try await callVoid("opencode:permission-reply", args: [dict])
    }

    func questions(sessionId: String? = nil) async throws -> [QuestionRequest] {
        let args: [Any] = sessionId.map { [$0] } ?? []
        return try await call("opencode:questions", args: args, as: [QuestionRequest].self) ?? []
    }

    func questionReply(requestId: String, answers: [[String]], sessionId: String? = nil) async throws {
        var dict: [String: Any] = [
            "requestId": requestId,
            "answers": answers,
        ]
        if let sessionId {
            dict["sessionId"] = sessionId
        }
        _ = try await callVoid("opencode:question-reply", args: [dict])
    }

    func questionReject(requestId: String, sessionId: String? = nil) async throws {
        var dict: [String: Any] = [
            "requestId": requestId,
        ]
        if let sessionId {
            dict["sessionId"] = sessionId
        }
        _ = try await callVoid("opencode:question-reject", args: [dict])
    }

    func abort(sessionId: String) async throws {
        _ = try await callVoid("opencode:abort", args: [sessionId])
    }

    // MARK: - Transport + envelope

    static func makeRequest(serverURL: URL, channel: String, args: [Any], token: String?) throws -> URLRequest {
        let base = serverURL.appendingPathComponent("rpc").appendingPathComponent(channel)
        var request = URLRequest(url: base)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let body: [String: Any] = ["args": args]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    static func decode<D: Decodable>(_ data: Data, as type: D.Type) throws -> D? {
        guard let object = (try JSONSerialization.jsonObject(with: data) as? [String: Any]) else {
            throw MantaError.transport("invalid rpc envelope")
        }
        if let error = object["error"] as? String, !error.isEmpty {
            throw MantaError.server(error)
        }
        guard let result = object["result"], !(result is NSNull) else {
            return nil
        }
        let resultData = try JSONSerialization.data(withJSONObject: result)
        return try JSONDecoder().decode(type, from: resultData)
    }

    private func call<D: Decodable>(_ channel: String, args: [Any], as type: D.Type) async throws -> D? {
        let data = try await transport(channel: channel, args: args)
        return try Self.decode(data, as: type)
    }

    private func callVoid(_ channel: String, args: [Any]) async throws -> VoidResult? {
        let data = try await transport(channel: channel, args: args)
        return try Self.decode(data, as: VoidResult.self)
    }

    private func transport(channel: String, args: [Any]) async throws -> Data {
        let request = try Self.makeRequest(serverURL: serverURL, channel: channel, args: args, token: tokenProvider())
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            throw MantaError.authRequired
        }
        return data
    }
}

private struct VoidResult: Decodable {}
