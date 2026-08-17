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

    /// The session's durable progress record (BET-790/791), or nil when it
    /// never reported / the record was cleared. Read-only `progress:get`.
    func progressGet(sessionID: String) async throws -> MantaProgress? {
        try await call("progress:get", args: [sessionID], as: MantaProgress.self)
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

    /// `opencode:context` — the transcript-derived context breakdown for a
    /// session, same shape as the live `stream/context` frame's payload
    /// (`computeContextBreakdown`: `freshInput`, `cacheRead`, `cacheWrite`,
    /// `totalInput`, `pct`, `segments`). Returns nil when the transcript has
    /// no billed assistant turn yet. This is the idle/open fallback: the live
    /// `stream/context` frame is preferred when it arrives, but an existing
    /// conversation that is idle on open has no such frame, so the meter stays
    /// blank until this RPC fills it (BET-1030).
    func context(sessionId: String) async throws -> StreamContextPayload? {
        try await call("opencode:context", args: [sessionId], as: StreamContextPayload.self)
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
        if let agent = input.agent {
            argsDict["agent"] = agent
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
        try await callRequired("tmux:list", args: [], as: [MantaProject].self)
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
        return try await callRequired("tmux:new-session", args: [dict], as: [MantaProject].self)
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
        return try await callRequired("tmux:new-window", args: [dict], as: [MantaProject].self)
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
    /// long-press Fork, and the chat overflow sheet). `messageID` is optional
    /// (fork at head when absent). Returns the NEW session id so the caller
    /// can navigate to the fork; nil when the box returns none.
    func forkSession(sessionId: String, sessionName: String, windowName: String, cwd: String? = nil, messageID: String? = nil) async throws -> String? {
        var dict: [String: Any] = [
            "sessionId": sessionId,
            "sessionName": sessionName,
            "windowName": windowName,
        ]
        if let cwd { dict["cwd"] = cwd }
        if let messageID { dict["messageID"] = messageID }
        let result: ForkSessionResult? = try await call("opencode:fork-session", args: [dict], as: ForkSessionResult.self)
        return result?.newSessionId
    }

    /// `opencode:clear-session` — start a fresh opencode session in the same
    /// window (the desktop `/clear`). Returns the new session id so the caller
    /// can re-point at it.
    func clearSession(sessionName: String, windowIndex: Int, cwd: String? = nil, title: String? = nil) async throws -> String? {
        var dict: [String: Any] = ["sessionName": sessionName, "windowIndex": windowIndex]
        if let cwd { dict["cwd"] = cwd }
        if let title { dict["title"] = title }
        let result = try await call("opencode:clear-session", args: [dict], as: ClearSessionResult.self)
        return result?.newSessionId
    }

    /// `opencode:vcs-branch` — the git branch for a working directory, or nil
    /// (not a repo, detached head, unreachable). Spawned locally by the box,
    /// so a terminal-side checkout is reflected on the next call.
    func vcsBranch(directory: String) async throws -> String? {
        try await call("opencode:vcs-branch", args: [directory], as: String.self)
    }

    /// `opencode:find-files` — ripgrep-backed file-name search under a
    /// directory (the desktop's `@`-file lookup channel). `directory` may be
    /// nil when the session doesn't thread one; the box then returns a
    /// browse-style listing. Result is a bare `[String]` of matching paths.
    func findFiles(query: String, directory: String? = nil) async throws -> [String] {
        var input: [String: Any] = ["query": query]
        if let directory { input["directory"] = directory }
        return try await call("opencode:find-files", args: [input], as: [String].self) ?? []
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

    /// `opencode:agents` — the box's named agents (plan primary agent, etc).
    /// Feeds the plan-mode toggle's availability (BET-952).
    func agents() async throws -> [OpencodeAgent] {
        try await call("opencode:agents", args: [], as: [OpencodeAgent].self) ?? []
    }

    /// `opencode:session-agent` — the agent opencode currently has attached to
    /// this session ("plan", "build", …). Authoritative: a session put into
    /// plan mode outside this device is only discoverable this way. Nil when
    /// absent / unknown / the box erred — failure is non-fatal (the caller
    /// keeps its stored value).
    func sessionAgent(sessionId: String) async throws -> String? {
        try await call("opencode:session-agent", args: [sessionId], as: String.self)
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

    /// `schedule:list` — scheduled-prompt jobs, filtered to the session when a
    /// sessionId is given. BET-627 uses the count for the sheet's live badge.
    func listSchedules(sessionId: String? = nil) async throws -> [ScheduledJob] {
        let args: [Any] = sessionId.map { [$0] } ?? []
        return try await call("schedule:list", args: args, as: [ScheduledJob].self) ?? []
    }

    /// `secrets:list` — secret METADATA only (values never leave the box).
    func listSecrets(sessionId: String? = nil) async throws -> [SecretMeta] {
        let args: [Any] = sessionId.map { [$0] } ?? []
        return try await call("secrets:list", args: args, as: [SecretMeta].self) ?? []
    }

    /// `schedule:delete` — delete a scheduled-prompt job by its id.
    /// `args[0]` is the job `id` (a `ScheduledJob.id`).
    func deleteSchedule(id: String) async throws {
        _ = try await call("schedule:delete", args: [id], as: VoidResult.self)
    }

    /// `secrets:set` — store (or upsert) a secret. The value travels to the box
    /// and is never returned or rendered again; only the metadata comes back.
    func setSecret(_ input: SecretInput) async throws -> SecretSetResult {
        try await callRequired("secrets:set", args: [try jsonObject(input)], as: SecretSetResult.self)
    }

    /// `secrets:delete` — delete a secret by its store id (a `SecretMeta.id`).
    func deleteSecret(id: String) async throws {
        _ = try await call("secrets:delete", args: [id], as: VoidResult.self)
    }

    /// `outbox:list` — agent-pushed artifacts scoped to the session (the box's
    /// `~/.manta-outbox/` row shape from `src/server/outbox.mjs`). Non-
    /// destructive: entries expire via the box's TTL sweep, not on download.
    func listOutbox(sessionId: String? = nil) async throws -> [OutboxFile] {
        let args: [Any] = sessionId.map { [$0] } ?? []
        return try await call("outbox:list", args: args, as: [OutboxFile].self) ?? []
    }

    /// `serve-page:list` — the box's published serve-page registry (read-only;
    /// `manta-server` owned, written by the `serve_page`/`stop_page` tools).
    /// BET-822 feeds these into the artifacts card's Links tab.
    func servePageList() async throws -> [ServedPageMeta] {
        try await call("serve-page:list", args: [], as: [ServedPageMeta].self) ?? []
    }

    /// `usage:list` — the box's cached subscription-plan snapshots (BET-824).
    /// Per-provider `UsageWindow[]` for the plan the box polls itself (the 5-
    /// hour `session` + 7-day `weekly` windows). The box refreshes its own
    /// snapshot on its 3-minute poll; the chat re-reads this channel on its
    /// own 60s cadence.
    func usageList() async throws -> [UsageSnapshot] {
        try await call("usage:list", args: [], as: [UsageSnapshot].self) ?? []
    }

    /// Fetch a file's bytes via `GET {serverURL}/api/peek?path=<box path>` with
    /// the bearer token. The box resolves `~` and path-traversal-guards the
    /// result to the home dir, so it serves BOTH transcript file parts (the
    /// `pathOnly` href stripped of `file://`) and outbox rows uniformly. Used
    /// by QuickLook staging, which needs a local file (BET-822). A non-2xx
    /// THROWS — a missing/denied file must be a visible failure, never a silent
    /// empty preview.
    func peekFile(path: String) async throws -> Data {
        var url = serverURL.appendingPathComponent("api").appendingPathComponent("peek")
        url.append(queryItems: [URLQueryItem(name: "path", value: path)])

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        if let token = tokenProvider(), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            throw MantaError.authRequired
        }
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let error = object["error"] as? String, !error.isEmpty {
                throw MantaError.server(error)
            }
            throw MantaError.server("peek failed (\(http.statusCode))")
        }
        return data
    }

    /// Download an outbox file's bytes via `GET {serverURL}/api/download?path=`
    /// with the bearer token. The box path-traversal-guards `path` to the
    /// outbox root, so a `403 "path outside outbox"` / `404` must THROW rather
    /// than surface as a successful empty `Data` (BET-750). Non-destructive:
    /// the source stays on the box until the TTL sweep.
    func downloadOutboxFile(path: String) async throws -> Data {
        var url = serverURL.appendingPathComponent("api").appendingPathComponent("download")
        url.append(queryItems: [URLQueryItem(name: "path", value: path)])

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        if let token = tokenProvider(), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            throw MantaError.authRequired
        }
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            // Non-2xx: the box replies `{error: "…"}` (e.g. "path outside
            // outbox") — surface that text rather than an empty `Data`.
            if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let error = object["error"] as? String, !error.isEmpty {
                throw MantaError.server(error)
            }
            throw MantaError.server("download failed (\(http.statusCode))")
        }
        return data
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

    /// `POST /push/focus` — tell the box which session the user is looking at so
    /// its router suppresses redundant pushes (mirrors the desktop's presence
    /// heartbeat; the endpoint + suppression logic already exist server-side).
    func reportFocus(sessionId: String?, visible: Bool) async throws {
        var request = URLRequest(url: serverURL.appendingPathComponent("push/focus"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let tokenValue = tokenProvider(), !tokenValue.isEmpty {
            request.setValue("Bearer \(tokenValue)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "sessionId": sessionId as Any, "visible": visible,
        ])
        _ = try await session.data(for: request)
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
        // `.fragmentsAllowed` is load-bearing, not defensive. A channel whose
        // result is a bare string or number (opencode:vcs-branch returns
        // "main") is a valid JSON FRAGMENT, and re-serialising one without this
        // option does not fail gracefully — NSJSONSerialization raises
        // NSInvalidArgumentException ("Invalid top-level type in JSON write"),
        // an Objective-C exception that Swift cannot catch, so the whole app
        // died the moment any such channel was called.
        let resultData = try JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed])
        return try JSONDecoder().decode(type, from: resultData)
    }

    private func call<D: Decodable>(_ channel: String, args: [Any], as type: D.Type) async throws -> D? {
        let data = try await transport(channel: channel, args: args)
        return try Self.decode(data, as: type)
    }

    /// Like `call`, but for a channel whose result is never legitimately
    /// absent. `decode` returns nil for a missing-or-null `result`, and a
    /// caller that folds that into an empty collection cannot tell a box that
    /// answered "nothing" from one that did not answer at all — which is how a
    /// box full of sessions came up blank, and reported as a success.
    private func callRequired<D: Decodable>(_ channel: String, args: [Any], as type: D.Type) async throws -> D {
        guard let value = try await call(channel, args: args, as: type) else {
            throw MantaError.transport("\(channel) returned no result")
        }
        return value
    }

    private func callVoid(_ channel: String, args: [Any]) async throws -> VoidResult? {
        let data = try await transport(channel: channel, args: args)
        return try Self.decode(data, as: VoidResult.self)
    }

    /// Encode an `Encodable` payload (e.g. `SecretInput`) back into the
    /// `[String: Any]` JSON-object shape the RPC transport serialises. Nil
    /// optional properties are omitted, matching the box's `{...i}` merge.
    private func jsonObject(_ value: some Encodable) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw MantaError.transport("payload is not a JSON object")
        }
        return object
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

/// The `opencode:fork-session` reply is `{ newSessionId, projects }`; only the
/// new session id is consumed by callers (to navigate to the fork). The extra
/// keys are ignored by decoding.
private struct ForkSessionResult: Decodable {
    let newSessionId: String?
}

private struct ClearSessionResult: Decodable {
    let newSessionId: String?
}
