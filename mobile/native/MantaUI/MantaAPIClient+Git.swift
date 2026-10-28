import Foundation

// ===========================================================================
// WS05 — the forge channels, exactly as the desktop calls them
// (`src/renderer/api/httpApi.ts`, handlers `src/server/rpc.mjs` → `forge/index.mjs`).
// One JSON object in `args[0]`. The box's additive view fields (`view`, `files`,
// `message`, inbox row fields) are decoded by the types in `GitForgeModels.swift`.
//
// Every read is `callRequired`: a missing result is an error, never an empty
// "nothing here" answer.
// ===========================================================================

extension MantaAPIClient {

    /// `forge:pull-request` — the PR for the session's branch, its checks, and the
    /// box's `view` of both.
    func forgePullRequest(cwd: String) async throws -> GitPullRequestResult {
        try await callRequired("forge:pull-request", args: [["cwd": cwd]], as: GitPullRequestResult.self)
    }

    /// `forge:ship-preview` — the drafted title / body for the branch, BEFORE
    /// anything is pushed. `model` is the chat's model OVERRIDE (as the desktop
    /// sends it), so the box drafts with it out of band.
    func forgeShipPreview(cwd: String, model: OpencodeModelID?, sessionId: String?) async throws -> GitShipPreviewResult {
        var input: [String: Any] = ["cwd": cwd]
        if let model {
            input["model"] = ["providerID": model.providerID, "modelID": model.modelID]
        }
        if let sessionId, !sessionId.isEmpty { input["sessionId"] = sessionId }
        return try await callRequired("forge:ship-preview", args: [input], as: GitShipPreviewResult.self)
    }

    /// `forge:ship` — push the branch and open the pull request.
    func forgeShip(cwd: String, title: String, body: String) async throws -> GitShipResult {
        try await callRequired(
            "forge:ship",
            args: [["cwd": cwd, "title": title, "body": body]],
            as: GitShipResult.self
        )
    }

    /// `forge:merge` — always with the head SHA the user confirmed; the box
    /// re-checks the gate and the SHA before it merges.
    func forgeMerge(cwd: String, number: Int, sha: String) async throws -> GitMergeResult {
        try await callRequired(
            "forge:merge",
            args: [["cwd": cwd, "number": number, "method": "merge", "sha": sha]],
            as: GitMergeResult.self
        )
    }

    /// `forge:diff` — the diff rows, placed threads and the reconciled draft, in
    /// one call.
    func forgeDiff(_ ref: GitRef) async throws -> GitDiffResult {
        try await callRequired("forge:diff", args: [ref.json], as: GitDiffResult.self)
    }

    /// `forge:draft-comment` — add / delete a draft comment or set the verdict.
    func forgeDraftComment(_ ref: GitRef, op: GitDraftOp) async throws -> GitDraftCommentResult {
        var input = ref.json
        for (key, value) in op.json { input[key] = value }
        return try await callRequired("forge:draft-comment", args: [input], as: GitDraftCommentResult.self)
    }

    /// `forge:draft-submit` — flush the whole draft as ONE review.
    func forgeDraftSubmit(_ ref: GitRef, verdict: GitVerdict?) async throws -> GitDraftSubmitResult {
        var input = ref.json
        if let verdict { input["verdict"] = verdict.rawValue }
        return try await callRequired("forge:draft-submit", args: [input], as: GitDraftSubmitResult.self)
    }

    /// `forge:thread-reply` — posts at once (never buffered).
    func forgeThreadReply(_ ref: GitRef, threadId: String, body: String) async throws -> GitThreadReplyResult {
        var input = ref.json
        input["threadId"] = threadId
        input["body"] = body
        return try await callRequired("forge:thread-reply", args: [input], as: GitThreadReplyResult.self)
    }

    /// `forge:inbox` — the work inbox, rows ready to render.
    func forgeInbox() async throws -> WorkInboxResult {
        try await callRequired("forge:inbox", args: [], as: WorkInboxResult.self)
    }

    /// `delegate:start` — a background job under `sessionID` in `directory`.
    func delegateStart(prompt: String, sessionID: String, directory: String) async throws -> GitDelegateStartResult {
        try await callRequired(
            "delegate:start",
            args: [["prompt": prompt, "sessionID": sessionID, "directory": directory]],
            as: GitDelegateStartResult.self
        )
    }
}
