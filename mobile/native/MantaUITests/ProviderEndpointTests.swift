import XCTest
@testable import MantaUI

// ===========================================================================
// WS08 — custom endpoints: draft validation, the model checklist, the per-model
// rows, endpoint health words, and how a (possibly non-atomic) write is
// classified (ProviderEndpointModels.swift).
// ===========================================================================

final class ProviderEndpointTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func endpoint(_ id: String, name: String? = nil, url: String = "https://api.example.com/v1", models: [String] = []) -> ProviderEndpoint {
        ProviderEndpoint(id: id, name: name ?? id, baseURL: url, hasApiKey: true, enabledModels: models)
    }

    // MARK: - Wire

    func testEndpointDecodesAndToleratesGaps() throws {
        let list = try decode(LenientArray<ProviderEndpoint>.self, #"""
        [{"id":"voska","name":"VoskaAI","baseURL":"https://api.voska.org/v1","hasApiKey":true,"enabledModels":["a","b"]},
         {"id":"bare"},
         {"name":"no id"}]
        """#).elements
        XCTAssertEqual(list.map(\.id), ["voska", "bare"])
        XCTAssertEqual(list[0].enabledModels, ["a", "b"])
        XCTAssertTrue(list[0].hasApiKey)
        XCTAssertEqual(list[1].name, "bare", "a missing name falls back to the id")
        XCTAssertEqual(list[1].baseURL, "")
        XCTAssertEqual(list[1].enabledModels, [])
    }

    func testDiscoverResultDecodes() throws {
        let ok = try decode(DiscoverResult.self, #"{"ok":true,"models":[{"id":"m1"},{"id":"m2"},{"id":"m1"},{"id":""},{"x":1}]}"#)
        XCTAssertTrue(ok.ok)
        XCTAssertEqual(ok.models, ["m1", "m2"], "deduplicated, blanks dropped")
        let bad = try decode(DiscoverResult.self, #"{"ok":false,"error":"unauthorized","detail":"Invalid API key"}"#)
        XCTAssertFalse(bad.ok)
        XCTAssertEqual(bad.error, "unauthorized")
        XCTAssertEqual(bad.detail, "Invalid API key")
        XCTAssertEqual(try decode(ProviderWriteReply.self, #"{"ok":false,"error":"boom"}"#), ProviderWriteReply(ok: false, error: "boom"))
        XCTAssertEqual(try decode(ProviderWriteReply.self, #"{"ok":true}"#).ok, true)
    }

    func testUpsertPayloadOmitsTheApiKeyWhenNil() {
        let keep = ProviderEndpointInput(id: "voska", name: "VoskaAI", baseURL: "https://x/v1", apiKey: nil, enabledModels: ["a"])
        let payload = keep.payload()
        XCTAssertNil(payload["apiKey"], "the key is omitted entirely so the box keeps the stored one")
        XCTAssertEqual(payload["id"] as? String, "voska")
        XCTAssertEqual(payload["name"] as? String, "VoskaAI")
        XCTAssertEqual(payload["baseURL"] as? String, "https://x/v1")
        XCTAssertEqual(payload["enabledModels"] as? [String], ["a"])
        XCTAssertEqual(Set(payload.keys), ["id", "name", "baseURL", "enabledModels"])

        let none = ProviderEndpointInput(id: "v", name: "V", baseURL: "https://x", apiKey: "", enabledModels: [])
        XCTAssertEqual(none.payload()["apiKey"] as? String, "", "an empty string means no key")
        let withKey = ProviderEndpointInput(id: "v", name: "V", baseURL: "https://x", apiKey: "sk-1", enabledModels: [])
        XCTAssertEqual(withKey.payload()["apiKey"] as? String, "sk-1")
    }

    // MARK: - Draft

    func testSlug() {
        XCTAssertEqual(ProviderEndpointDraft.slug("VoskaAI"), "voskaai")
        XCTAssertEqual(ProviderEndpointDraft.slug("My  Box!"), "my-box")
        XCTAssertEqual(ProviderEndpointDraft.slug("--"), "")
        XCTAssertEqual(ProviderEndpointDraft.slug("  "), "")
        XCTAssertEqual(ProviderEndpointDraft.slug("-a-b-"), "a-b")
        XCTAssertEqual(ProviderEndpointDraft.slug("Ünïcode 1"), "n-code-1", "non-ASCII is dropped like any other separator")
        XCTAssertEqual(ProviderEndpointDraft.slug("a/b.c_d"), "a-b-c-d")
        XCTAssertEqual(ProviderEndpointDraft.slug("Kimi 2"), "kimi-2")
    }

    func testValidationErrors() {
        let taken: Set<String> = ["voska"]
        func err(_ name: String, _ url: String) -> String? {
            ProviderEndpointDraft.validationError(name: name, baseURL: url, takenIds: taken)
        }
        XCTAssertEqual(err("", "https://x"), "Name is required.")
        XCTAssertEqual(err("   ", "https://x"), "Name is required.")
        XCTAssertEqual(err("!!!", "https://x"), "Name must contain a letter or digit.")
        XCTAssertEqual(err("Box", ""), "Base URL is required.")
        XCTAssertEqual(err("Box", "  "), "Base URL is required.")
        XCTAssertEqual(err("Box", "ftp://x"), "Base URL must start with http:// or https://.")
        XCTAssertEqual(err("Box", "x.com/v1"), "Base URL must start with http:// or https://.")
        XCTAssertNil(err("Box", "https://api.example.com/v1"))
        XCTAssertNil(err("Box", "HTTP://localhost:8000/v1"))
        XCTAssertEqual(err("Voska", "https://x"), "An endpoint with the id “voska” already exists — choose another name.")
    }

    func testDiscoverErrorText() {
        XCTAssertEqual(ProviderEndpointDraft.discoverErrorText(error: "unreachable", detail: nil), "Couldn't reach the endpoint")
        XCTAssertEqual(ProviderEndpointDraft.discoverErrorText(error: "unreachable", detail: "could not reach the endpoint"), "Couldn't reach the endpoint: could not reach the endpoint")
        XCTAssertEqual(ProviderEndpointDraft.discoverErrorText(error: "unauthorized", detail: nil), "The endpoint rejected the key")
        XCTAssertEqual(ProviderEndpointDraft.discoverErrorText(error: "unauthorized", detail: "Invalid API key"), "The endpoint rejected the key: Invalid API key")
        XCTAssertEqual(ProviderEndpointDraft.discoverErrorText(error: "bad_response", detail: nil), "The endpoint didn't return a model list")
        XCTAssertEqual(ProviderEndpointDraft.discoverErrorText(error: "bad_response", detail: "no data array"), "The endpoint didn't return a model list: no data array")
        XCTAssertEqual(ProviderEndpointDraft.discoverErrorText(error: nil, detail: ""), "The endpoint didn't return a model list")
    }

    func testCollisionAgainstAFreshInventory() {
        let fresh = [endpoint("voska"), endpoint("other")]
        XCTAssertTrue(ProviderEndpointDraft.collision(slug: "voska", endpoints: fresh, statusIds: []))
        XCTAssertFalse(ProviderEndpointDraft.collision(slug: "new", endpoints: fresh, statusIds: []))
        // A collision introduced after Test (the fresh list now contains the slug) refuses Save.
        XCTAssertFalse(ProviderEndpointDraft.collision(slug: "late", endpoints: [endpoint("voska")], statusIds: []))
        XCTAssertTrue(ProviderEndpointDraft.collision(slug: "late", endpoints: [endpoint("voska"), endpoint("late")], statusIds: []))
        // Static subscription ids are reserved even when the status list is unavailable.
        for id in ["anthropic", "openai", "kimi-for-coding"] {
            XCTAssertTrue(ProviderEndpointDraft.collision(slug: id, endpoints: [], statusIds: []), id)
        }
        XCTAssertTrue(ProviderEndpointDraft.collision(slug: "future-sub", endpoints: [], statusIds: ["future-sub"]), "any id in the status list")
        XCTAssertFalse(ProviderEndpointDraft.collision(slug: "", endpoints: fresh, statusIds: []))
        XCTAssertEqual(
            ProviderEndpointDraft.takenIds(endpoints: [endpoint("a")], statusIds: ["b"]),
            ["a", "b", "anthropic", "openai", "kimi-for-coding"]
        )
    }

    func testSaveCopy() {
        XCTAssertEqual(ProviderEndpointDraft.saved(name: "Voska", count: 3), "Added Voska with 3 models.")
        XCTAssertEqual(ProviderEndpointDraft.saved(name: "Voska", count: 1), "Added Voska with 1 model.")
        XCTAssertEqual(
            ProviderEndpointDraft.savedPartial(name: "Voska", reason: "boom"),
            "Saved Voska, but the model list couldn't be fully applied — boom. Check its switches in Accounts."
        )
        XCTAssertEqual(ProviderEndpointDraft.notConfirmed(name: "Voska"), "Couldn't confirm whether Voska was saved.")
        XCTAssertFalse(ProviderEndpointDraft.saveInventoryFailed.lowercased().contains("desktop"))
    }

    func testSavedEndpointCopy() {
        XCTAssertEqual(ProviderEndpointCopy.togglePartial(name: "V", reason: "boom"), "Saved V, but the model list couldn't be fully applied — boom.")
        XCTAssertEqual(ProviderEndpointCopy.updateFailed(name: "V", reason: "boom"), "Couldn't update V — boom")
        XCTAssertEqual(ProviderEndpointCopy.unconfirmedNote(name: "V"), "Couldn't confirm what's saved for V.")
        XCTAssertEqual(ProviderEndpointCopy.refreshFound(name: "V", count: 1), "Found 1 model on V.")
        XCTAssertEqual(ProviderEndpointCopy.refreshFound(name: "V", count: 4), "Found 4 models on V.")
        XCTAssertEqual(ProviderEndpointCopy.refreshFailed(name: "V", text: "Couldn't reach the endpoint"), "Couldn't refresh V — Couldn't reach the endpoint")
        XCTAssertEqual(ProviderEndpointCopy.removeTitle(name: "V"), "Remove V?")
        XCTAssertEqual(ProviderEndpointCopy.removed(name: "V"), "Removed V.")
        XCTAssertEqual(ProviderEndpointCopy.removeFailed(name: "V", reason: "boom"), "Couldn't remove V — boom")
        XCTAssertEqual(ProviderEndpointCopy.removeDestructive, "Remove endpoint")
        XCTAssertEqual(ProviderEndpointCopy.copiedURL(name: "V"), "Copied V's URL.")
    }

    // MARK: - Model checklist

    func testChecklistStartsAllSelected() {
        let list = ModelChecklistState(ids: ["gpt-a", "gpt-b", "claude-x", "gpt-a"])
        XCTAssertEqual(list.ids, ["gpt-a", "gpt-b", "claude-x"], "deduplicated")
        XCTAssertEqual(list.selectedCount, 3)
        XCTAssertEqual(list.countsLine, "3 of 3 selected · 3 shown")
        XCTAssertEqual(list.saveTitle, "Save 3 models")
        XCTAssertTrue(list.canSave)
        XCTAssertTrue(list.allChecked)
        XCTAssertFalse(list.noneChecked)
    }

    func testChecklistFilterIsCaseInsensitiveSubstring() {
        var list = ModelChecklistState(ids: ["GPT-a", "gpt-b", "claude-x"])
        list.filter = "GPT"
        XCTAssertEqual(list.visible, ["GPT-a", "gpt-b"])
        XCTAssertEqual(list.countsLine, "3 of 3 selected · 2 shown")
        list.filter = "  CLAUDE "
        XCTAssertEqual(list.visible, ["claude-x"])
        list.filter = "zzz"
        XCTAssertEqual(list.visible, [])
        XCTAssertEqual(list.emptyMessage, "No model matches “zzz”.")
        XCTAssertFalse(list.allChecked, "no visible rows → nothing to select-all")
        list.filter = ""
        XCTAssertNil(list.emptyMessage)
    }

    func testAllAndNoneActOnVisibleRowsOnly() {
        var list = ModelChecklistState(ids: ["gpt-a", "gpt-b", "claude-x"])
        list.filter = "gpt"
        list.selectNoneVisible()
        XCTAssertEqual(list.selectedIds, ["claude-x"], "the hidden row keeps its tick")
        XCTAssertTrue(list.noneChecked)
        XCTAssertFalse(list.allChecked)
        list.selectAllVisible()
        XCTAssertEqual(list.selectedIds, ["gpt-a", "gpt-b", "claude-x"])
        XCTAssertTrue(list.allChecked)

        // Filter + None + toggling three gives "Save 3 models".
        var big = ModelChecklistState(ids: (1...10).map { "m\($0)" })
        big.filter = "m"
        big.selectNoneVisible()
        XCTAssertFalse(big.canSave)
        XCTAssertEqual(big.saveTitle, "Save 0 models")
        for id in ["m2", "m5", "m9"] { big.set(id, selected: true) }
        XCTAssertEqual(big.saveTitle, "Save 3 models")
        XCTAssertEqual(big.selectedIds, ["m2", "m5", "m9"])
        big.set("m5", selected: false)
        XCTAssertEqual(big.saveTitle, "Save 2 models")
        big.set("not-there", selected: true)
        XCTAssertEqual(big.selectedCount, 2, "an unknown id is ignored")
        var one = ModelChecklistState(ids: ["only"])
        XCTAssertEqual(one.saveTitle, "Save 1 model")
        one.selectNoneVisible()
        XCTAssertFalse(one.canSave)
    }

    // MARK: - Per-model rows

    func testRows() {
        XCTAssertEqual(ProviderEndpointModels.rows(enabled: ["a", "b"], discovered: nil, disabledThisSession: []), ["a", "b"], "enabled only")
        XCTAssertEqual(ProviderEndpointModels.rows(enabled: ["a"], discovered: ["a", "b", "c"], disabledThisSession: []), ["a", "b", "c"], "discovered wins")
        XCTAssertEqual(ProviderEndpointModels.rows(enabled: ["a"], discovered: nil, disabledThisSession: ["z"]), ["a", "z"], "unticked this visit stays re-tickable")
        XCTAssertEqual(ProviderEndpointModels.rows(enabled: ["a", "a"], discovered: ["a", "b"], disabledThisSession: ["b", "q", "q"]), ["a", "b", "q"], "duplicates removed")
        XCTAssertEqual(ProviderEndpointModels.rows(enabled: [], discovered: nil, disabledThisSession: []), [])
        XCTAssertEqual(ProviderEndpointModels.rows(enabled: ["x"], discovered: [], disabledThisSession: []), [], "an empty discovered list is still a list")
    }

    func testToggledKeepsDisplayedOrder() {
        let rows = ["a", "b", "c"]
        XCTAssertEqual(ProviderEndpointModels.toggled(enabled: ["a", "c"], rows: rows, id: "b", on: true), ["a", "b", "c"])
        XCTAssertEqual(ProviderEndpointModels.toggled(enabled: ["a", "b", "c"], rows: rows, id: "b", on: false), ["a", "c"])
        XCTAssertEqual(ProviderEndpointModels.toggled(enabled: ["a"], rows: rows, id: "a", on: false), [])
        // An enabled id the row list does not show is kept, after the shown ones.
        XCTAssertEqual(ProviderEndpointModels.toggled(enabled: ["hidden"], rows: rows, id: "a", on: true), ["a", "hidden"])
    }

    // MARK: - Write reconciliation

    private func outcome(_ reply: EndpointWriteReply, before: ProviderEndpoint?, readBack: [ProviderEndpoint]?,
                         expect: EndpointWriteExpectation) -> EndpointWriteOutcome {
        EndpointWriteReconcile.outcome(reply: reply, before: before, readBack: readBack.map { .success($0) }, expect: expect)
    }

    func testReplyOkIsConfirmedWithoutAReadBack() {
        XCTAssertEqual(
            EndpointWriteReconcile.outcome(reply: .ok, before: nil, readBack: nil, expect: .present(id: "v", enabledModels: ["a"])),
            .confirmed
        )
    }

    func testReadBackFailureIsUnconfirmed() {
        struct Down: Error {}
        XCTAssertEqual(
            EndpointWriteReconcile.outcome(reply: .threw("x"), before: nil, readBack: .failure(Down()), expect: .present(id: "v", enabledModels: ["a"])),
            .unconfirmed
        )
        XCTAssertEqual(
            EndpointWriteReconcile.outcome(reply: .refused("x"), before: nil, readBack: nil, expect: .absent(id: "v")),
            .unconfirmed,
            "a failed write with no read-back at all cannot be classified"
        )
    }

    func testRefusedButMatchingExpectationIsPartial() {
        XCTAssertEqual(
            outcome(.refused("could not apply selection"), before: nil, readBack: [endpoint("v", models: ["a", "b"])], expect: .present(id: "v", enabledModels: ["b", "a"])),
            .partial("could not apply selection")
        )
    }

    func testThrownButMatchingExpectationIsAConfirmedLostResponse() {
        XCTAssertEqual(
            outcome(.threw("timed out"), before: nil, readBack: [endpoint("v", models: ["a"])], expect: .present(id: "v", enabledModels: ["a"])),
            .confirmed
        )
    }

    func testEqualToBeforeIsRejected() {
        let before = endpoint("v", models: ["a"])
        XCTAssertEqual(
            outcome(.refused("nope"), before: before, readBack: [before], expect: .present(id: "v", enabledModels: ["a", "b"])),
            .rejected("nope")
        )
        XCTAssertEqual(
            outcome(.threw("timed out"), before: before, readBack: [before], expect: .present(id: "v", enabledModels: ["a", "b"])),
            .rejected("timed out")
        )
    }

    func testAThirdStateIsPartial() {
        // The block was written but the selection landed somewhere else.
        XCTAssertEqual(
            outcome(.refused("boom"), before: endpoint("v", models: ["a"]), readBack: [endpoint("v", models: ["c"])], expect: .present(id: "v", enabledModels: ["a", "b"])),
            .partial("boom")
        )
        // A different name or URL is also a third state.
        XCTAssertEqual(
            outcome(.refused("boom"), before: endpoint("v", name: "Old", models: ["a"]), readBack: [endpoint("v", name: "New", models: ["a"])], expect: .present(id: "v", enabledModels: ["a", "b"])),
            .partial("boom")
        )
    }

    func testTheSameReadBackClassifiesByWhatWasThereBefore() {
        // Toggle on an endpoint whose read-back is [a], expecting [a, b].
        let readBack = [endpoint("v", models: ["a"])]
        let expect = EndpointWriteExpectation.present(id: "v", enabledModels: ["a", "b"])
        XCTAssertEqual(outcome(.refused("e"), before: endpoint("v", models: ["a"]), readBack: readBack, expect: expect), .rejected("e"))
        XCTAssertEqual(outcome(.refused("e"), before: endpoint("v", models: ["b"]), readBack: readBack, expect: expect), .partial("e"))
    }

    func testANewEndpointThatIsAbsentAfterTheWriteIsRejected() {
        XCTAssertEqual(
            outcome(.refused("e"), before: nil, readBack: [endpoint("other")], expect: .present(id: "v", enabledModels: ["a"])),
            .rejected("e")
        )
        XCTAssertEqual(
            outcome(.threw("e"), before: nil, readBack: [], expect: .present(id: "v", enabledModels: ["a"])),
            .rejected("e")
        )
    }

    func testRemoval() {
        let before = endpoint("v", models: ["a"])
        XCTAssertEqual(outcome(.threw("lost"), before: before, readBack: [], expect: .absent(id: "v")), .confirmed, "gone after a thrown write")
        XCTAssertEqual(outcome(.refused("e"), before: before, readBack: [], expect: .absent(id: "v")), .partial("e"))
        XCTAssertEqual(outcome(.refused("e"), before: before, readBack: [before], expect: .absent(id: "v")), .rejected("e"), "still present and equal to before")
        XCTAssertEqual(
            outcome(.refused("e"), before: before, readBack: [endpoint("v", models: [])], expect: .absent(id: "v")),
            .partial("e"),
            "present but changed"
        )
        XCTAssertEqual(EndpointWriteExpectation.absent(id: "v").id, "v")
    }

    func testAnEmptyErrorStillSaysSomething() {
        XCTAssertEqual(
            outcome(.refused(""), before: endpoint("v", models: ["a"]), readBack: [endpoint("v", models: ["a"])], expect: .present(id: "v", enabledModels: ["b"])),
            .rejected("the box didn't confirm the change")
        )
    }

    func testOutcomesMapToTheAnnounceGate() {
        XCTAssertEqual(EndpointWriteOutcome.confirmed.changeOutcome, .confirmed)
        XCTAssertEqual(EndpointWriteOutcome.partial("x").changeOutcome, .partial)
        XCTAssertEqual(EndpointWriteOutcome.rejected("x").changeOutcome, .rejected)
        XCTAssertEqual(EndpointWriteOutcome.unconfirmed.changeOutcome, .unconfirmed)
        XCTAssertTrue(ProviderChange.shouldAnnounce(EndpointWriteOutcome.partial("x").changeOutcome))
        XCTAssertFalse(ProviderChange.shouldAnnounce(EndpointWriteOutcome.unconfirmed.changeOutcome))
    }

    // MARK: - Round 3: retry after an unconfirmed write

    func testRetryAfterUnconfirmedKeepsTheOriginalExpectation() {
        // The first Save wrote [a, b], then its reply and read-back were lost.
        let pending = PendingEndpointWrite(
            id: "v", baseURL: "https://api.example.com/v1", before: nil,
            expect: .present(id: "v", enabledModels: ["a", "b"])
        )

        // Same id/URL and the SAME selection → the earlier write landed.
        XCTAssertEqual(
            EndpointWriteReconcile.recheck(pending: pending, fresh: [endpoint("v", models: ["b", "a"])]),
            .classified(.confirmed)
        )

        // Same id/URL but a DIFFERENT selection → partial, never silently confirmed.
        guard case .classified(.partial) = EndpointWriteReconcile.recheck(pending: pending, fresh: [endpoint("v", models: ["a", "b", "c"])]) else {
            return XCTFail("a different selection must classify as partial")
        }
        guard case .classified(.partial) = EndpointWriteReconcile.recheck(pending: pending, fresh: [endpoint("v", models: ["a"])]) else {
            return XCTFail("a subset is partial too")
        }

        // Editing the draft (here: asking for [x] now) never rewrites the pending expectation —
        // the pending value is the only input, and it still reads [a, b].
        XCTAssertEqual(pending.expect, .present(id: "v", enabledModels: ["a", "b"]))

        // Nothing of it landed → write again under the normal collision guard.
        XCTAssertEqual(EndpointWriteReconcile.recheck(pending: pending, fresh: []), .writeAgain)
        XCTAssertEqual(EndpointWriteReconcile.recheck(pending: pending, fresh: [endpoint("other")]), .writeAgain)
        // The same id with ANOTHER base URL is someone else's endpoint: a collision, not our write.
        XCTAssertEqual(
            EndpointWriteReconcile.recheck(pending: pending, fresh: [endpoint("v", url: "https://elsewhere.example/v1", models: ["a", "b"])]),
            .writeAgain
        )
        // A trailing slash / case difference in the URL is still the same endpoint.
        XCTAssertEqual(
            EndpointWriteReconcile.recheck(pending: pending, fresh: [endpoint("v", url: "HTTPS://API.example.com/v1/", models: ["a", "b"])]),
            .classified(.confirmed)
        )
    }
}
