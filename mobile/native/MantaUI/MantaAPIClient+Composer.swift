import Foundation

/// Arguments of `opencode:run-command` (desktop `api.ts:1657-1673`).
struct RunCommandInput: Sendable {
    var sessionId: String
    var command: String
    var arguments: String
    var model: SendPromptInput.Model?
    var agent: String?
    var attachments: [SendPromptInput.Attachment]
    /// `"steer"` / `"queue"` — only for a command sent while a turn runs.
    var delivery: String?
    var background: Bool = false
}

extension MantaAPIClient {

    /// `opencode:commands` — the box's opencode commands AND skills for a
    /// working directory (the desktop's `/` palette source). `callRequired`: a
    /// missing result must be an error, not an empty "loaded" catalog — an empty
    /// list would make a real command send as plain text.
    func commands(directory: String?) async throws -> [OpencodeCommandInfo] {
        var args: [Any] = []
        if let directory, !directory.isEmpty {
            args = [["directory": directory]]
        }
        return try await callRequired("opencode:commands", args: args, as: [OpencodeCommandInfo].self)
    }

    /// `opencode:references` — the configured `@alias` references.
    func references() async throws -> [OpencodeReferenceInfo] {
        try await callRequired("opencode:references", args: [], as: [OpencodeReferenceInfo].self)
    }

    /// `opencode:run-command` — run an opencode command or skill in a session.
    /// `call`, not `callRequired`: a `null` result is a legitimate success.
    func runCommand(_ input: RunCommandInput) async throws -> RunCommandResult? {
        var dict: [String: Any] = [
            "sessionId": input.sessionId,
            "command": input.command,
            "arguments": input.arguments,
        ]
        dict["attachments"] = input.attachments.map { attachment -> [String: Any] in
            var item: [String: Any] = [
                "remotePath": attachment.remotePath,
                "mime": attachment.mime,
            ]
            if let filename = attachment.filename {
                item["filename"] = filename
            }
            return item
        }
        if let model = input.model {
            var modelDict: [String: Any] = [
                "providerID": model.providerID,
                "modelID": model.modelID,
            ]
            if let variant = model.variant {
                modelDict["variant"] = variant
            }
            dict["model"] = modelDict
        }
        if let agent = input.agent {
            dict["agent"] = agent
        }
        if let delivery = input.delivery {
            dict["delivery"] = delivery
        }
        if input.background {
            dict["background"] = true
        }
        return try await call("opencode:run-command", args: [dict], as: RunCommandResult.self)
    }
}
