import Foundation

extension MantaAPIClient {

    /// `opencode:search-messages` with `scope:"all"` — the box resolves the
    /// scope, groups and labels the hits (server-first, D23). `callRequired`: a
    /// missing result is an error, never an empty "no matches" answer.
    func searchMessages(_ request: SearchRequest) async throws -> SearchResponse {
        try await callRequired(
            "opencode:search-messages",
            args: [try jsonObject(request)],
            as: SearchResponse.self
        )
    }
}
