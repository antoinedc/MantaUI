import Foundation

// ===========================================================================
// WS02 — the RPC members behind the chat cards (C1: this area's members live in
// their own file). Every one reuses the channel the desktop calls; the NEW ones
// (`delegate:job-for-session`, the `restore` flag, `capabilities`) are the box's
// server-first answers, gated by the `chat-cards-1` capability.
// ===========================================================================

/// The three approval calls the approval store depends on, so it is testable with
/// a fake (the live client conforms below).
protocol ChatCardApprovalAPI: Sendable {
    func delegatePendingApprovals(sessionId: String) async throws -> [ChatCardApproval]
    func delegateApprove(id: String, tools: [ChatCardApprovalTool]) async throws -> ChatCardApproveResult
    func delegateDecline(id: String) async throws -> Bool
}

/// The two job calls the ownership store depends on (testable with a fake).
protocol ChatCardJobAPI: Sendable {
    func delegateJobForSession(sessionId: String) async throws -> ChatCardJobForSession
    func delegateStop(id: String) async throws
}

extension MantaAPIClient {

    /// `delegate:pending-approvals` — the approvals the box holds for this
    /// parent session (bare array, or `{approvals: []}`).
    func delegatePendingApprovals(sessionId: String) async throws -> [ChatCardApproval] {
        let list = try await call("delegate:pending-approvals", args: [sessionId], as: ChatCardApprovalList.self)
        return list?.approvals ?? []
    }

    /// `delegate:approve` — start the job with this (possibly edited) access.
    /// `ok:false` with an `error` = the box refused the rules; the approval stays
    /// pending.
    func delegateApprove(id: String, tools: [ChatCardApprovalTool]) async throws -> ChatCardApproveResult {
        return try await callRequired(
            "delegate:approve",
            args: [["id": id, "tools": Self.approvalToolsPayload(tools)]],
            as: ChatCardApproveResult.self
        )
    }

    /// The wire form of the edited access list. `action` MUST ride along: the box reads
    /// a rule with no `action:"deny"` as an allow, so dropping it would turn a deny
    /// rule into an allow the moment a job is approved from the phone.
    static func approvalToolsPayload(_ tools: [ChatCardApprovalTool]) -> [[String: Any]] {
        tools.map { tool in
            var rule: [String: Any] = ["permission": tool.permission, "pattern": tool.pattern]
            if let action = tool.action { rule["action"] = action }
            return rule
        }
    }

    /// `delegate:decline` — `ok:false` only means it is no longer pending.
    func delegateDecline(id: String) async throws -> Bool {
        struct Reply: Decodable { let ok: Bool? }
        return try await call("delegate:decline", args: [id], as: Reply.self)?.ok ?? false
    }

    /// `delegate:job-for-session` — is this session a read-only background job,
    /// and the bar's copy (the box decides; a CTO work worker is writable).
    func delegateJobForSession(sessionId: String) async throws -> ChatCardJobForSession {
        try await callRequired("delegate:job-for-session", args: [["sessionId": sessionId]], as: ChatCardJobForSession.self)
    }

    /// `opencode:inbox-cancel` with `restore` — the box returns `notice` /
    /// `error` / `restoreText` worded for the gesture (× = false, Edit last = true).
    func inboxCancelReported(sessionId: String, id: String, restore: Bool) async throws -> InboxCancelResult {
        try await callRequired(
            "opencode:inbox-cancel",
            args: [["sessionId": sessionId, "id": id, "restore": restore]],
            as: InboxCancelResult.self
        )
    }
}

extension MantaAPIClient {
    /// `opencode:cache` — the box's cache-staleness payload for an idle session
    /// (WS11 D2); nil before any completed turn, and on a box that predates it
    /// (`cache-stale-at-1` missing → the warning never shows).
    func opencodeCache(sessionId: String) async throws -> StreamCachePayload? {
        try await call("opencode:cache", args: [sessionId], as: StreamCachePayload.self)
    }
}

extension MantaAPIClient: ChatCardApprovalAPI {}
extension MantaAPIClient: ChatCardJobAPI {}
