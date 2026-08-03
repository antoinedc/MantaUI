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

    /// A client bound to the paired box stored in the Keychain. Used by the
    /// session-list surface, which is only reachable after pairing. A paired
    /// Keychain always carries a serverURL; the placeholder is an unreachable
    /// fallback (no token → the call 401s rather than ever succeeding).
    static func live() -> MantaAPIClient {
        MantaAPIClient(serverURL: KeychainCredentialStore.shared.serverURL ?? URL(string: "https://127.0.0.1")!)
    }

    func listSessions(directory: String? = nil) async throws -> [OpencodeSessionListItem] {
        let args: [Any] = directory.map { [$0] } ?? []
        return try await call("opencode:list-sessions", args: args, as: [OpencodeSessionListItem].self) ?? []
    }

    /// Fetch a session's transcript.
    ///
    /// `limit` asks the box for only the most recent N messages (opencode's
    /// `?limit=` returns the tail, chronologically ordered). `slim` drops the
    /// part types this client never renders plus the duplicated copy of every
    /// tool's stdout that opencode writes into `state.metadata.output` — on a
    /// real 63-message session that is most of the payload. Both are opt-in on
    /// the wire; the desktop passes neither and still gets the full history.
    func messages(sessionId: String, limit: Int? = nil, slim: Bool = false) async throws -> [OpencodeMessage] {
        var opts: [String: Any] = [:]
        if let limit, limit > 0 { opts["limit"] = limit }
        if slim { opts["slim"] = true }
        let args: [Any] = opts.isEmpty ? [sessionId] : [sessionId, opts]
        return try await call("opencode:messages", args: args, as: [OpencodeMessage].self) ?? []
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

    // MARK: - Session list + creation (S3 / BET-595)

    /// `tmux:list` — the grouped session list (projects → windows).
    func projects() async throws -> [MantaProject] {
        try await call("tmux:list", args: [], as: [MantaProject].self) ?? []
    }

    /// `tmux:new-session` — create a new project (tmux session).
    func newSession(_ input: NewSessionInput) async throws -> [MantaProject] {
        let dict: [String: Any] = [
            "name": input.name,
            "cwd": input.cwd,
            "windowName": input.windowName,
            "createDir": input.createDir,
            "chatMode": input.chatMode,
        ]
        return try await call("tmux:new-session", args: [dict], as: [MantaProject].self) ?? []
    }

    /// `tmux:new-window` — create a new session (window) in an existing project.
    /// A chat-mode window becomes a live opencode session the moment its first
    /// message is sent.
    func newWindow(_ input: NewWindowInput) async throws -> [MantaProject] {
        var dict: [String: Any] = [
            "sessionName": input.sessionName,
            "windowName": input.windowName,
            "chatMode": input.chatMode,
        ]
        if let cwd = input.cwd { dict["cwd"] = cwd }
        return try await call("tmux:new-window", args: [dict], as: [MantaProject].self) ?? []
    }

    /// `tmux:kill-window` — delete a session (a row in the list).
    func killWindow(_ input: KillWindowInput) async throws {
        let dict: [String: Any] = [
            "sessionName": input.sessionName,
            "windowIndex": input.windowIndex,
        ]
        _ = try await callVoid("tmux:kill-window", args: [dict])
    }

    /// `opencode:delete-session` — delete a chat session AND its tmux window
    /// (the desktop path). Used when the row has an opencode session id.
    func deleteSession(sessionId: String, sessionName: String, windowIndex: Int) async throws {
        let dict: [String: Any] = [
            "sessionId": sessionId,
            "sessionName": sessionName,
            "windowIndex": windowIndex,
        ]
        _ = try await callVoid("opencode:delete-session", args: [dict])
    }

    /// `opencode:fork-session` — fork a chat session into a new window (§7.2
    /// long-press Fork). `messageID` is optional (fork at head when absent).
    func forkSession(sessionId: String, sessionName: String, windowName: String, cwd: String? = nil, messageID: String? = nil) async throws {
        var dict: [String: Any] = [
            "sessionId": sessionId,
            "sessionName": sessionName,
            "windowName": windowName,
        ]
        if let cwd { dict["cwd"] = cwd }
        if let messageID { dict["messageID"] = messageID }
        _ = try await callVoid("opencode:fork-session", args: [dict])
    }

    /// `tmux:rename-window` — rename a session (the row's name).
    func renameWindow(session: String, index: Int, newName: String) async throws {
        let dict: [String: Any] = [
            "sessionName": session,
            "windowIndex": index,
            "newName": newName,
        ]
        _ = try await callVoid("tmux:rename-window", args: [dict])
    }

    /// `tmux:select-window` — make a window the active one in its project.
    func selectWindow(session: String, index: Int) async throws {
        let dict: [String: Any] = [
            "sessionName": session,
            "windowIndex": index,
        ]
        _ = try await callVoid("tmux:select-window", args: [dict])
    }

    /// `fs:list-dirs` — directory path completion for the folder picker.
    func listDirs(_ partial: String) async throws -> [String] {
        try await call("fs:list-dirs", args: [partial], as: [String].self) ?? []
    }

    // MARK: - Composer extras (S5 / BET-597)

    /// `opencode:models` — models from CONNECTED providers only (no API keys).
    func models() async throws -> [OpencodeModel] {
        try await call("opencode:models", args: [], as: [OpencodeModel].self) ?? []
    }

    /// `opencode:default-model` — the configured global default, or nil when
    /// opencode picks its own.
    func defaultModel() async throws -> OpencodeModelID? {
        try await call("opencode:default-model", args: [], as: OpencodeModelID.self)
    }

    /// `opencode:compact-session` — free context for the voice `compact` action.
    func compactSession(sessionId: String) async throws {
        _ = try await callVoid("opencode:compact-session", args: [sessionId])
    }

    /// Upload raw bytes to `POST /api/upload?session=<project>` with the
    /// `X-Filename` header (unchanged endpoint, already serving the desktop).
    /// Returns the remote absolute path the box stored.
    func upload(project: String, filename: String, data: Data) async throws -> String {
        let query = URLQueryItem(name: "session", value: project)
        var url = serverURL.appendingPathComponent("api").appendingPathComponent("upload")
        url.append(queryItems: [query])

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        if let token = tokenProvider(), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let encodedName = filename.addingPercentEncoding(withAllowedCharacters: .urlHostAllowed) ?? filename
        request.setValue(encodedName, forHTTPHeaderField: "X-Filename")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.httpBody = data

        let (dataOut, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            throw MantaError.authRequired
        }
        guard let object = (try JSONSerialization.jsonObject(with: dataOut) as? [String: Any]) else {
            throw MantaError.transport("invalid upload envelope")
        }
        if let error = object["error"] as? String, !error.isEmpty {
            throw MantaError.server(error)
        }
        guard let path = object["path"] as? String, !path.isEmpty else {
            throw MantaError.transport("upload returned no path")
        }
        return path
    }

    /// `voice:transcribe` — ship recorded audio (base64 over the JSON RPC
    /// wire, as the desktop shim does) to the box's Groq transcription.
    /// Returns the transcribed text, or nil when the clip was empty.
    func voiceTranscribe(data: Data, mime: String) async throws -> String? {
        let input: [String: Any] = [
            "buffer": data.base64EncodedString(),
            "mime": mime,
        ]
        try await Task.sleep(nanoseconds: 0)
        let result: [String: JSONValue]? = try await call("voice:transcribe", args: [input], as: [String: JSONValue].self)
        return ChatJSON.string(result?["text"])
    }

    /// `voice:classify-command` — route a transcript through the box's rules +
    /// (fallback) LLM classifier. Returns the structured action.
    func voiceClassifyCommand(transcript: String, useLlmFallback: Bool? = nil) async throws -> VoiceClassifyResult? {
        var input: [String: Any] = ["transcript": transcript]
        if let useLlmFallback { input["useLlmFallback"] = useLlmFallback }
        let envelope: VoiceClassifyEnvelope? = try await call("voice:classify-command", args: [input], as: VoiceClassifyEnvelope.self)
        return envelope?.action
    }

    /// `git:list-worktrees` — git worktree fan-out detection for a folder.
    func listWorktrees(_ cwd: String) async throws -> [MantaWorktree] {
        try await call("git:list-worktrees", args: [cwd], as: [MantaWorktree].self) ?? []
    }

    /// `config:update` — persist a config patch (e.g. `pinnedWindows`,
    /// `hapticsEnabled`). Returns the merged config object.
    func configUpdate(_ patch: [String: Any]) async throws -> [String: JSONValue]? {
        try await call("config:update", args: [patch], as: [String: JSONValue].self)
    }

    /// `config:get` — read the full config (e.g. `pinnedWindows`, `hapticsEnabled`).
    func configGet() async throws -> [String: JSONValue]? {
        try await call("config:get", args: [], as: [String: JSONValue].self)
    }

    /// `POST /push/register-apns` — hand the APNs device token to the box
    /// (server mirror of the /rpc/push:register-apns channel; both call
    /// push.addApnsToken, see src/server/index.mjs). Fire-and-forget from the
    /// push service; a failure here just means the box doesn't push to the
    /// device (the token is re-sent on the next registration).
    func registerApnsToken(_ token: String) async throws {
        var request = URLRequest(url: serverURL.appendingPathComponent("push/register-apns"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let tokenValue = tokenProvider(), !tokenValue.isEmpty {
            request.setValue("Bearer \(tokenValue)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: ["token": token])
        let (_, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            throw MantaError.authRequired
        }
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
        // `.fragmentsAllowed` so a top-level String/Number (e.g. the bare git
        // branch name `String?` returned by `opencode:vcs-branch`) round-trips
        // instead of throwing. Without it `JSONSerialization` rejects any
        // non-object/non-array top level, which SIGABRT'd on any chat opened
        // in a git checkout.
        let resultData = try JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed])
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

/// The `voice:classify-command` reply is `{ action, source }` — the action is
/// the structured `VoiceAction`; `source` ("rules" | "llm" | "none") is
/// diagnostic only and discarded here (the device never interprets).
private struct VoiceClassifyEnvelope: Decodable {
    var action: VoiceClassifyResult?
}
