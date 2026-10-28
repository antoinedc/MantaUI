import Foundation

extension MantaAPIClient {

    /// `artifacts:list` — this conversation's artifacts, derived by the box
    /// (links, files, images, hosted pages, agent-sent files, plans, expiry state,
    /// counts). `callRequired`: a missing result is an error, never an empty list.
    /// A box that predates the channel answers `unknown rpc channel: artifacts:list`;
    /// callers classify that with `ArtifactsCapability.isUnsupported`.
    func artifactsList(sessionId: String) async throws -> ArtifactsListResult {
        try await callRequired(
            "artifacts:list",
            args: [["sessionId": sessionId]],
            as: ArtifactsListResult.self
        )
    }

    /// `webhook:list` — this session's inbound webhooks (metadata only; the
    /// signing secret never leaves the box).
    func listWebhooks(sessionId: String) async throws -> [WebhookMeta] {
        // The box maps a blank id to "every webhook on the box" — never ask that from a session card.
        guard !sessionId.trimmingCharacters(in: .whitespaces).isEmpty else { return [] }
        try await call("webhook:list", args: [sessionId], as: [WebhookMeta].self) ?? []
    }

    /// `webhook:delete` — revoke a webhook by id. `deleted: false` (already gone)
    /// is success: the decoded reply is not inspected.
    func deleteWebhook(id: String) async throws {
        _ = try await callVoid("webhook:delete", args: [id])
    }
}
