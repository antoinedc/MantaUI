import XCTest
@testable import MantaUI

// ===========================================================================
// WS06 — conversation search, the pure layer (SearchModels.swift).
//
// Scope resolution, grouping and labels are the BOX's job (node tests in
// src/server/messageSearch.test.mjs). These tests pin the decoded server shape,
// the request, the fixed copy, the jump check and the query sequencing.
// ===========================================================================

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

private let hitJSON = """
{"sessionId":"s1","messageId":"m1","role":"user","pre":"see ","match":"needle","post":" here","timeCreated":1700000000000}
"""

private func hit(_ sid: String, _ mid: String) -> TranscriptHit {
    TranscriptHit(sessionId: sid, messageId: mid, role: "user", pre: "", match: "m", post: "", timeCreated: 1)
}

private func group(
    _ sid: String, current: Bool = false, workspace: String? = nil, name: String? = nil,
    label: String? = nil, hits: Int = 1
) -> TranscriptHitGroup {
    TranscriptHitGroup(
        sessionId: sid, isCurrent: current, workspace: workspace, name: name,
        label: label ?? sid, hits: (0..<hits).map { hit(sid, "\(sid)-m\($0)") }
    )
}

private func response(
    supported: Bool = true, groups: [TranscriptHitGroup]? = [], truncated: Bool? = nil, degraded: Bool? = nil
) -> SearchResponse {
    SearchResponse(supported: supported, hits: [], groups: groups, truncated: truncated, degraded: degraded)
}

private struct Boom: Error {}

final class SearchTests: XCTestCase {

    // MARK: - Request

    private func requestJSON(_ r: SearchRequest) throws -> [String: Any] {
        let data = try JSONEncoder().encode(r)
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func test_request_encodesScopeAll_andPrimary() throws {
        let state = SearchQueryState(primarySessionId: "ses_cur")
        let ticket = SearchTicket(seq: 1, query: "needle")
        let json = try requestJSON(state.request(for: ticket))
        XCTAssertEqual(json["query"] as? String, "needle")
        XCTAssertEqual(json["scope"] as? String, "all")
        XCTAssertEqual(json["primarySessionId"] as? String, "ses_cur")
    }

    func test_request_withoutPrimary_omitsPrimaryKey() throws {
        let state = SearchQueryState(primarySessionId: nil)
        let json = try requestJSON(state.request(for: SearchTicket(seq: 1, query: "needle")))
        XCTAssertNil(json["primarySessionId"])
        XCTAssertEqual(Set(json.keys), ["query", "scope"])
    }

    func test_request_neverSendsSessionIds() throws {
        let state = SearchQueryState(primarySessionId: "a")
        let json = try requestJSON(state.request(for: SearchTicket(seq: 1, query: "needle")))
        XCTAssertNil(json["sessionIds"])
    }

    func test_request_trimsWhitespaceAndNewlines() {
        var state = SearchQueryState(primarySessionId: nil)
        let ticket = state.queryChanged("  foo \n")
        XCTAssertEqual(ticket?.query, "foo")
        XCTAssertEqual(ticket.map { state.request(for: $0).query }, "foo")
    }

    // MARK: - Decoding

    func test_decode_groups_fullShape() throws {
        let r = try decode(SearchResponse.self, """
        {"supported":true,"hits":[\(hitJSON)],"groups":[{"sessionId":"s1","isCurrent":true,
         "workspace":"manta","name":"fix login","label":"manta › fix login","hits":[\(hitJSON)]}]}
        """)
        XCTAssertTrue(r.supported)
        let g = try XCTUnwrap(r.groups?.first)
        XCTAssertTrue(g.isCurrent)
        XCTAssertEqual(g.workspace, "manta")
        XCTAssertEqual(g.name, "fix login")
        XCTAssertEqual(g.label, "manta › fix login")
        XCTAssertEqual(g.id, "s1")
        XCTAssertEqual(g.hits.first?.match, "needle")
        XCTAssertEqual(g.hits.first?.timeCreated, 1_700_000_000_000)
        XCTAssertTrue(g.hits.first?.isUser == true)
    }

    func test_decode_group_nullWorkspaceName() throws {
        let g = try decode(TranscriptHitGroup.self, """
        {"sessionId":"ses_x","isCurrent":false,"workspace":null,"name":null,"label":"ses_x","hits":[]}
        """)
        XCTAssertNil(g.workspace)
        XCTAssertNil(g.name)
        XCTAssertEqual(g.label, "ses_x")
    }

    func test_decode_missingGroups_isNil() throws {
        let r = try decode(SearchResponse.self, #"{"supported":true,"hits":[]}"#)
        XCTAssertNil(r.groups)
    }

    func test_decode_supportedFalse() throws {
        let r = try decode(SearchResponse.self, #"{"supported":false,"hits":[],"groups":[]}"#)
        XCTAssertFalse(r.supported)
        XCTAssertEqual(r.groups?.count, 0)
    }

    func test_decode_truncated() throws {
        let r = try decode(SearchResponse.self, #"{"supported":true,"hits":[],"groups":[],"truncated":true}"#)
        XCTAssertEqual(r.truncated, true)
        XCTAssertNil(r.degraded)
    }

    func test_decode_degraded() throws {
        let r = try decode(SearchResponse.self, #"{"supported":true,"hits":[],"groups":[],"degraded":true}"#)
        XCTAssertEqual(r.degraded, true)
    }

    func test_decode_nullTimeCreated() throws {
        let h = try decode(TranscriptHit.self, """
        {"sessionId":"s","messageId":"m","role":"assistant","pre":"","match":"x","post":"","timeCreated":null}
        """)
        XCTAssertNil(h.timeCreated)
    }

    func test_decode_unknownRoleIsAssistant() throws {
        let h = try decode(TranscriptHit.self, """
        {"sessionId":"s","messageId":"m","role":"system","pre":"","match":"x","post":"","timeCreated":1}
        """)
        XCTAssertFalse(h.isUser)
    }

    func test_decode_missingFlatHits_defaultsEmpty() throws {
        let r = try decode(SearchResponse.self, #"{"supported":true,"groups":[]}"#)
        XCTAssertEqual(r.hits, [])
    }

    // MARK: - Copy

    func test_isActive_trimsAndRequiresTwoChars() {
        XCTAssertFalse(SearchCopy.isActive("a"))
        XCTAssertFalse(SearchCopy.isActive(" a "))
        XCTAssertTrue(SearchCopy.isActive("ab"))
        XCTAssertFalse(SearchCopy.isActive("a\n"))
        XCTAssertFalse(SearchCopy.isActive("   "))
        XCTAssertEqual(SearchCopy.normalized("  foo \n"), "foo")
    }

    func test_copy_pluralisation() {
        XCTAssertEqual(SearchCopy.currentCount(1), "1 match")
        XCTAssertEqual(SearchCopy.currentCount(2), "2 matches")
        XCTAssertEqual(SearchCopy.footer(total: 1, conversations: 1), "1 result · 1 conversation")
        XCTAssertEqual(SearchCopy.footer(total: 3, conversations: 2), "3 results · 2 conversations")
    }

    func test_copy_idleTitle_dependsOnEntryPoint() {
        XCTAssertEqual(SearchCopy.idleTitle(hasPrimary: true), "Search this conversation — and all others.")
        XCTAssertEqual(SearchCopy.idleTitle(hasPrimary: false), "Search every conversation.")
    }

    func test_copy_failureReason_passesBoxTextOnly() {
        XCTAssertEqual(SearchCopy.failureReason(MantaError.server("db busy")), "db busy")
        XCTAssertEqual(SearchCopy.failureReason(MantaError.authRequired), "this device isn't signed in to the box")
        XCTAssertEqual(SearchCopy.failureReason(Boom()), "check the connection")
        XCTAssertEqual(SearchCopy.failedMessage("db busy"), "Couldn't search — db busy.")
    }

    // MARK: - Jump

    func test_jump_reachable() {
        XCTAssertTrue(SearchJump.isReachable(sessionId: "s1") { $0 == "s1" })
    }

    func test_jump_unreachable() {
        XCTAssertFalse(SearchJump.isReachable(sessionId: "s1") { _ in false })
    }

    // MARK: - Section titles (the box's label, verbatim)

    func test_sectionTitle_currentIsFixedLabel() {
        let g = group("s1", current: true, workspace: "ws", name: "win", label: "ws › win")
        XCTAssertEqual(SearchCopy.sectionTitle(g), "This conversation")
    }

    func test_sectionTitle_usesServerLabelVerbatim() {
        let g = group("s1", workspace: "ws", name: "win", label: "box-label")
        XCTAssertEqual(SearchCopy.sectionTitle(g), "box-label")
    }

    func test_sectionTitle_missingComponent_usesLabel() {
        let g = group("ses_x", workspace: nil, name: "win", label: "ses_x")
        XCTAssertEqual(SearchCopy.sectionTitle(g), "ses_x")
    }

    // MARK: - State machine

    func test_state_belowMin_isIdle_noTicket() {
        var state = SearchQueryState(primarySessionId: nil)
        XCTAssertNil(state.queryChanged("a"))
        XCTAssertEqual(state.phase, .idle)
        XCTAssertNil(state.queryChanged("   "))
        XCTAssertEqual(state.phase, .idle)
        XCTAssertTrue(state.groups.isEmpty)
    }

    func test_state_staleResponseDropped() throws {
        var state = SearchQueryState(primarySessionId: nil)
        let t1 = try XCTUnwrap(state.queryChanged("ne"))
        let t2 = try XCTUnwrap(state.queryChanged("nee"))
        state.receive(response(groups: [group("a")]), for: t1)
        XCTAssertEqual(state.phase, .loading)
        XCTAssertTrue(state.groups.isEmpty)
        state.receive(response(groups: [group("b")]), for: t2)
        XCTAssertEqual(state.phase, .results)
        XCTAssertEqual(state.groups.map(\.sessionId), ["b"])
    }

    func test_state_staleFailureDropped() throws {
        var state = SearchQueryState(primarySessionId: nil)
        let t1 = try XCTUnwrap(state.queryChanged("ne"))
        _ = try XCTUnwrap(state.queryChanged("nee"))
        state.fail(MantaError.server("boom"), for: t1)
        XCTAssertEqual(state.phase, .loading)
    }

    func test_state_cancellationNeverFails() throws {
        var state = SearchQueryState(primarySessionId: nil)
        let t = try XCTUnwrap(state.queryChanged("needle"))
        state.fail(CancellationError(), for: t)
        XCTAssertEqual(state.phase, .loading)
        state.fail(NSError(domain: "NSURLErrorDomain", code: -999), for: t)
        XCTAssertEqual(state.phase, .loading)
    }

    func test_state_clearWhileInFlight_staysIdle() throws {
        var state = SearchQueryState(primarySessionId: nil)
        let t = try XCTUnwrap(state.queryChanged("needle"))
        XCTAssertNil(state.queryChanged(""))
        state.receive(response(groups: [group("a")]), for: t)
        XCTAssertEqual(state.phase, .idle)
        XCTAssertTrue(state.groups.isEmpty)
    }

    func test_state_invalidateDropsLateResult() throws {
        var state = SearchQueryState(primarySessionId: nil)
        let t = try XCTUnwrap(state.queryChanged("needle"))
        state.invalidate()
        state.receive(response(groups: [group("a")]), for: t)
        state.fail(MantaError.server("late"), for: t)
        XCTAssertEqual(state.phase, .loading)
        XCTAssertTrue(state.groups.isEmpty)
    }

    func test_state_errorBecomesFailed() throws {
        var state = SearchQueryState(primarySessionId: nil)
        let t = try XCTUnwrap(state.queryChanged("needle"))
        state.fail(MantaError.server("db busy"), for: t)
        XCTAssertEqual(state.phase, .failed("db busy"))
    }

    func test_state_unsupported() throws {
        var state = SearchQueryState(primarySessionId: nil)
        let t = try XCTUnwrap(state.queryChanged("needle"))
        state.receive(response(supported: false), for: t)
        XCTAssertEqual(state.phase, .unsupported)
    }

    func test_state_noGroups_isBoxTooOld() throws {
        var state = SearchQueryState(primarySessionId: nil)
        let t = try XCTUnwrap(state.queryChanged("needle"))
        state.receive(response(groups: nil), for: t)
        XCTAssertEqual(state.phase, .boxTooOld)
    }

    func test_state_degraded_isFailedNotEmpty() throws {
        var state = SearchQueryState(primarySessionId: nil)
        let t = try XCTUnwrap(state.queryChanged("needle"))
        state.receive(response(groups: [], degraded: true), for: t)
        XCTAssertEqual(state.phase, .failed(SearchCopy.degradedReason))
    }

    func test_state_emptyGroups_isEmpty() throws {
        var state = SearchQueryState(primarySessionId: nil)
        let t = try XCTUnwrap(state.queryChanged("needle"))
        state.receive(response(groups: []), for: t)
        XCTAssertEqual(state.phase, .empty)
    }

    func test_state_rendersServerGroupOrderVerbatim() throws {
        var state = SearchQueryState(primarySessionId: "cur")
        let t = try XCTUnwrap(state.queryChanged("needle"))
        // Not sorted, and the "current" group is not first: the client keeps
        // exactly what the box sent.
        state.receive(response(groups: [group("z"), group("cur", current: true, hits: 2), group("a")]), for: t)
        XCTAssertEqual(state.groups.map(\.sessionId), ["z", "cur", "a"])
        XCTAssertEqual(state.totalHits, 4)
    }

    func test_state_truncatedFlowsThrough_andClearsOnNextResult() throws {
        var state = SearchQueryState(primarySessionId: nil)
        let t1 = try XCTUnwrap(state.queryChanged("needle"))
        state.receive(response(groups: [group("a")], truncated: true), for: t1)
        XCTAssertTrue(state.truncated)
        let t2 = try XCTUnwrap(state.queryChanged("needles"))
        state.receive(response(groups: [group("a")]), for: t2)
        XCTAssertFalse(state.truncated)
    }

    func test_state_loadingKeepsPreviousGroups() throws {
        var state = SearchQueryState(primarySessionId: nil)
        let t1 = try XCTUnwrap(state.queryChanged("needle"))
        state.receive(response(groups: [group("a")]), for: t1)
        XCTAssertNotNil(state.queryChanged("needles"))
        XCTAssertEqual(state.phase, .loading)
        XCTAssertEqual(state.groups.map(\.sessionId), ["a"])
    }

    func test_state_retryReissuesLastQuery() throws {
        var state = SearchQueryState(primarySessionId: nil)
        let t1 = try XCTUnwrap(state.queryChanged(" needle "))
        state.fail(MantaError.transport("offline"), for: t1)
        XCTAssertEqual(state.phase, .failed("offline"))
        let t2 = try XCTUnwrap(state.retry())
        XCTAssertEqual(t2.query, "needle")
        XCTAssertGreaterThan(t2.seq, t1.seq)
        XCTAssertEqual(state.phase, .loading)
        // The first ticket's late answer is dropped; the retry's is applied.
        state.receive(response(groups: [group("a")]), for: t1)
        XCTAssertEqual(state.phase, .loading)
        state.receive(response(groups: [group("a")]), for: t2)
        XCTAssertEqual(state.phase, .results)
    }

    func test_state_retryWithoutActiveQuery_isNoOp() {
        var state = SearchQueryState(primarySessionId: nil)
        XCTAssertNil(state.retry())
        XCTAssertEqual(state.phase, .idle)
        _ = state.queryChanged("a")
        XCTAssertNil(state.retry())
    }
}
