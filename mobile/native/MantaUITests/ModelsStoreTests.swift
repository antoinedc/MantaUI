import XCTest
import Combine
@testable import MantaUI

// ===========================================================================
// WS09 — store tests (Mac / Xcode only: they need the app target's stores and a
// URLProtocol stub). The Foundation-only wire + logic tests are in ModelsTests.
// ===========================================================================

@MainActor
final class ModelsStoreTests: XCTestCase {

    private let table = #"{"supported":true,"defaultKey":null,"defaultLine":null,"rows":[{"key":"anthropic/opus","providerID":"anthropic","modelID":"opus","name":"Opus","isMain":true,"isSub":true,"canMakeDefault":true,"editable":{"name":"Opus","description":"","context":null}}]}"#
    private let pickerJSON = #"{"supported":true,"groups":[{"provider":"anthropic","keys":["anthropic/opus","anthropic/old"]}],"locked":["anthropic/old"],"selectable":["anthropic/opus","anthropic/opus-fast"],"delegateGroups":[],"recents":[]}"#
    private let modelsJSON = #"[{"id":"opus","providerID":"anthropic","name":"Opus"},{"id":"opus-fast","providerID":"anthropic","name":"Opus Fast"},{"id":"old","providerID":"anthropic","name":"Old","status":"deprecated"}]"#

    override func setUp() {
        super.setUp()
        ModelsStubProtocol.reset()
    }

    private func reply(_ json: String) -> String { #"{"result":"# + json + "}" }

    private func store(catalog: ChatModelCatalog? = nil) -> (ModelsStore, ChatModelCatalog) {
        let api = ModelsStubProtocol.client()
        let catalog = catalog ?? ChatModelCatalog(api: api, defaults: UserDefaults(suiteName: "ModelsStoreTests-\(UUID().uuidString)")!)
        return (ModelsStore(api: api, catalog: catalog), catalog)
    }

    // MARK: F1 outcomes

    func testSetSubNotAppliedIsPartialWithTryAgainWhichCallsRetrySubSync() async throws {
        ModelsStubProtocol.responses = [
            "models:table": reply(table),
            "models:set-sub": reply(#"{"ok":true,"table":"# + table + #","message":"Preference saved, but the subagent list on the box wasn't updated. Try again to apply it.","outcome":"not-applied","retry":true}"#),
            "models:retry-sub-sync": reply(#"{"ok":true,"table":"# + table + #","message":"Subagent list updated.","outcome":"applied","retry":false}"#),
        ]
        let (store, _) = store()
        await store.refresh()
        await store.setSub(key: "anthropic/opus", on: false)
        XCTAssertEqual(store.feedback, .partial("Preference saved, but the subagent list on the box wasn't updated. Try again to apply it.", retry: true))

        await store.retrySubSync()
        XCTAssertEqual(ModelsStubProtocol.count("models:retry-sub-sync"), 1)
        XCTAssertEqual(store.feedback, .saved("Subagent list updated."))
    }

    func testSavedNotLiveIsPartialWithoutRetry() async {
        ModelsStubProtocol.responses = [
            "models:set-sub": reply(#"{"ok":true,"table":"# + table + #","message":"Saved, takes effect when opencode restarts.","outcome":"saved-not-live","retry":false}"#),
        ]
        let (store, _) = store()
        await store.setSub(key: "anthropic/opus", on: true)
        XCTAssertEqual(store.feedback, .partial("Saved, takes effect when opencode restarts.", retry: false))
    }

    func testOptInPartialShowsTheSamePartial() async {
        ModelsStubProtocol.responses = [
            "models:opt-in": reply(#"{"ok":true,"table":"# + table + #","message":"Enabled Old. Preference saved, but the subagent list on the box wasn't updated.","outcome":"not-applied","retry":true,"ignored":[]}"#),
        ]
        let (store, _) = store()
        await store.optIn(key: "anthropic/old")
        guard case .partial(_, let retry)? = store.feedback else { return XCTFail("expected a partial") }
        XCTAssertTrue(retry)
    }

    func testContextErrorStaysUnderTheFieldAndLeavesTheTable() async {
        ModelsStubProtocol.responses = [
            "models:table": reply(table),
            "models:set-override": reply(#"{"ok":false,"field":"context","code":"bad-context","message":"Context size must be a whole number of tokens above 0."}"#),
        ]
        let (store, _) = store()
        await store.refresh()
        let before = store.table
        let saved = await store.saveOverride(key: "anthropic/opus", name: "Opus", description: "", context: "abc")
        XCTAssertFalse(saved)
        XCTAssertEqual(store.fieldError, ModelsStore.FieldError(field: "context", message: "Context size must be a whole number of tokens above 0."))
        XCTAssertNil(store.feedback)
        XCTAssertEqual(store.table, before)
        // the strings were sent as typed
        let sent = ModelsStubProtocol.recorded.last { $0.channel == "models:set-override" }?.args ?? ""
        XCTAssertTrue(sent.contains("\"context\":\"abc\""))
    }

    func testUnknownChannelIsUnsupported() async {
        ModelsStubProtocol.responses = ["models:table": #"{"error":"unknown rpc channel: models:table"}"#]
        let (store, _) = store()
        await store.refresh()
        XCTAssertEqual(store.phase, .unsupported)
    }

    func testModelsUpdatedFrameRefetchesTheTableOnce() async {
        ModelsStubProtocol.responses = ["models:table": reply(table)]
        let (store, catalog) = store()
        store.start()
        do { let ok = await eventually { ModelsStubProtocol.count("models:table") == 1 }; XCTAssertTrue(ok) }
        catalog.modelsUpdates.send()
        do { let ok = await eventually { ModelsStubProtocol.count("models:table") == 2 }; XCTAssertTrue(ok) }
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(ModelsStubProtocol.count("models:table"), 2)
    }

    func testAThrownWriteSaysItMayHaveLanded() async {
        ModelsStubProtocol.responses = ["models:set-main": #"{"error":"socket hang up"}"#]
        let (store, _) = store()
        await store.setMain(key: "anthropic/opus", on: false)
        guard case .failed(let text)? = store.feedback else { return XCTFail("expected a failure") }
        XCTAssertTrue(text.contains("socket hang up"))
        XCTAssertTrue(text.contains("Pull to refresh"))
    }

    // MARK: Picker policy

    private func catalogWithPicker() async -> (ChatModelCatalog, ChatModelStore) {
        ModelsStubProtocol.responses = [
            "opencode:models": reply(modelsJSON),
            "opencode:default-model": reply("null"),
            "config:get": reply("{}"),
            "models:picker": reply(pickerJSON),
        ]
        let api = ModelsStubProtocol.client()
        let catalog = ChatModelCatalog(api: api, defaults: UserDefaults(suiteName: "ModelsStoreTests-\(UUID().uuidString)")!)
        catalog.loadIfNeeded()
        await catalog.waitForLoad()
        let prefs = ChatModelPrefs(api: api)
        let modelStore = ChatModelStore(sessionId: "s1", api: api, catalog: catalog, prefs: prefs)
        return (catalog, modelStore)
    }

    func testAKeyAbsentFromSelectableCannotBeAppliedByAnyPath() async {
        let (_, modelStore) = await catalogWithPicker()
        XCTAssertTrue(modelStore.isSelectable("anthropic/opus"))
        XCTAssertFalse(modelStore.isSelectable("anthropic/old"))
        XCTAssertTrue(modelStore.isLocked("anthropic/old"))
        XCTAssertFalse(modelStore.apply(ModelChoice(providerID: "anthropic", modelID: "old", variant: nil, fast: false)))
        XCTAssertNil(modelStore.override)
        XCTAssertTrue(modelStore.apply(ModelChoice(providerID: "anthropic", modelID: "opus", variant: nil, fast: true)))
        XCTAssertEqual(modelStore.override?.modelID, "opus-fast")
        XCTAssertEqual(modelStore.selectableModels.map(\.id), ["opus", "opus-fast"])
    }

    func testPickerGroupsFollowTheBoxAndSkipKeysWithoutAnObject() async {
        let (_, modelStore) = await catalogWithPicker()
        let groups = modelStore.pickerGroups
        XCTAssertEqual(groups.map(\.provider), ["anthropic"])
        XCTAssertEqual(groups[0].models.map(\.id), ["opus", "old"])
    }

    func testEnableCallsOptInAndReloadsTheCatalog() async throws {
        let (catalog, modelStore) = await catalogWithPicker()
        ModelsStubProtocol.responses["models:opt-in"] = reply(#"{"ok":true,"message":"Enabled Old.","outcome":"applied","retry":false}"#)
        let old = try XCTUnwrap(modelStore.models.first { $0.id == "old" })
        let ok = await modelStore.optIn(old)
        XCTAssertTrue(ok)
        XCTAssertEqual(ModelsStubProtocol.count("models:opt-in"), 1)
        await catalog.waitForLoad()
        XCTAssertEqual(ModelsStubProtocol.count("models:picker"), 2)
        XCTAssertNil(modelStore.optInPendingKey)
    }

    func testEnableFailureSaysWhyAndLeavesItLocked() async throws {
        let (_, modelStore) = await catalogWithPicker()
        ModelsStubProtocol.responses["models:opt-in"] = reply(#"{"ok":false,"code":"unknown-model","message":"That model is no longer on this box."}"#)
        let old = try XCTUnwrap(modelStore.models.first { $0.id == "old" })
        let ok = await modelStore.optIn(old)
        XCTAssertFalse(ok)
        XCTAssertTrue(modelStore.optInError?.contains("Couldn't enable Old") == true)
        XCTAssertTrue(modelStore.isLocked("anthropic/old"))
    }

    func testOlderBoxFallsBackToEverythingSelectable() async {
        ModelsStubProtocol.responses = [
            "opencode:models": reply(modelsJSON),
            "opencode:default-model": reply("null"),
            "config:get": reply("{}"),
            "models:picker": #"{"error":"unknown rpc channel: models:picker"}"#,
        ]
        let api = ModelsStubProtocol.client()
        let catalog = ChatModelCatalog(api: api, defaults: UserDefaults(suiteName: "ModelsStoreTests-\(UUID().uuidString)")!)
        catalog.loadIfNeeded()
        await catalog.waitForLoad()
        XCTAssertTrue(catalog.pickerUnsupported)
        let modelStore = ChatModelStore(sessionId: "s1", api: api, catalog: catalog, prefs: ChatModelPrefs(api: api))
        XCTAssertTrue(modelStore.isSelectable("anthropic/old"))
        // The raw enabled list, with the `-fast` twin folded into its base (a mode, not
        // a model): opus + old, not three rows.
        XCTAssertEqual(modelStore.pickerGroups.flatMap { $0.models }.map(\.id), ["opus", "old"])
    }

    // MARK: Frames / providers

    func testModelsUpdatedAndProvidersChangedReloadTheCatalog() async {
        ModelsStubProtocol.responses = [
            "opencode:models": reply(modelsJSON), "opencode:default-model": reply("null"),
            "config:get": reply("{}"), "models:picker": reply(pickerJSON),
        ]
        let api = ModelsStubProtocol.client()
        let catalog = ChatModelCatalog(api: api, defaults: UserDefaults(suiteName: "ModelsStoreTests-\(UUID().uuidString)")!)
        catalog.loadIfNeeded()
        await catalog.waitForLoad()
        XCTAssertEqual(ModelsStubProtocol.count("opencode:models"), 1)

        NotificationCenter.default.post(name: .mantaProvidersChanged, object: nil)
        do { let ok = await eventually { ModelsStubProtocol.count("opencode:models") == 2 }; XCTAssertTrue(ok) }
        await catalog.waitForLoad()
        XCTAssertEqual(ModelsStubProtocol.count("models:picker"), 2, "the picker is refetched with the list")
    }

    func testModelsUpdatedFrameReloadsTheCatalogueAndClearsAVanishedDefault() async throws {
        let renamed = #"[{"id":"opus","providerID":"anthropic","name":"Opus Renamed","limit":{"context":500000}}]"#
        ModelsStubProtocol.responses = [
            "opencode:models": reply(modelsJSON),
            "opencode:default-model": reply("null"),
            "config:get": reply(#"{"defaultModel":{"providerID":"anthropic","modelID":"opus"}}"#),
            "models:picker": reply(pickerJSON),
        ]
        let api = ModelsStubProtocol.client()
        let catalog = ChatModelCatalog(api: api, defaults: UserDefaults(suiteName: "ModelsStoreTests-\(UUID().uuidString)")!)
        let stream = ModelsTestStream()
        let events = MantaEventStore(stream: stream, tokenProvider: { nil }, serverProvider: { nil })
        catalog.subscribe(to: events)
        catalog.loadIfNeeded()
        await catalog.waitForLoad()
        XCTAssertEqual(catalog.configDefault, OpencodeModelID(providerID: "anthropic", modelID: "opus"))
        XCTAssertEqual(catalog.models.count, 3)

        // The box renamed a model and dropped the saved default.
        ModelsStubProtocol.responses["opencode:models"] = reply(renamed)
        ModelsStubProtocol.responses["config:get"] = reply("{}")
        stream.inject(#"{"kind":"models.updated"}"#)
        do { let ok = await eventually { ModelsStubProtocol.count("opencode:models") == 2 && catalog.models.count == 1 }; XCTAssertTrue(ok) }
        await catalog.waitForLoad()
        XCTAssertEqual(catalog.models.first?.name, "Opus Renamed")
        XCTAssertEqual(catalog.models.first?.limit?.context, 500000)
        XCTAssertNil(catalog.configDefault, "a successful answer without a default clears it")
        XCTAssertEqual(ModelsStubProtocol.count("opencode:models"), 2, "one full reload per frame")
    }

    func testAFailedReloadKeepsTheSavedDefaults() async {
        ModelsStubProtocol.responses = [
            "opencode:models": reply(modelsJSON),
            "opencode:default-model": reply(#"{"providerID":"anthropic","modelID":"old"}"#),
            "config:get": reply(#"{"defaultModel":{"providerID":"anthropic","modelID":"opus"}}"#),
            "models:picker": reply(pickerJSON),
        ]
        let catalog = ChatModelCatalog(api: ModelsStubProtocol.client(), defaults: UserDefaults(suiteName: "ModelsStoreTests-\(UUID().uuidString)")!)
        catalog.loadIfNeeded()
        await catalog.waitForLoad()
        XCTAssertEqual(catalog.configDefault?.modelID, "opus")
        XCTAssertEqual(catalog.defaultModel?.modelID, "old")

        ModelsStubProtocol.responses["config:get"] = #"{"error":"boom"}"#
        ModelsStubProtocol.responses["opencode:default-model"] = #"{"error":"boom"}"#
        catalog.reload()
        await catalog.waitForLoad()
        XCTAssertEqual(catalog.configDefault?.modelID, "opus", "a failed config read keeps the default")
        XCTAssertEqual(catalog.defaultModel?.modelID, "old", "a failed default read keeps the default")

        ModelsStubProtocol.responses["config:get"] = reply("{}")
        ModelsStubProtocol.responses["opencode:default-model"] = reply("null")
        catalog.reload()
        await catalog.waitForLoad()
        XCTAssertNil(catalog.configDefault)
        XCTAssertNil(catalog.defaultModel)
    }

    func testARecentWhoseFastTwinIsHiddenIsNotOffered() async {
        // `opus-fast` is not selectable though `opus` is: the box keeps the recent via
        // its base key, but a chip that cannot be applied must not be shown.
        let picker = #"{"supported":true,"groups":[{"provider":"anthropic","keys":["anthropic/opus"]}],"locked":[],"selectable":["anthropic/opus"],"delegateGroups":[],"recents":[{"providerID":"anthropic","modelID":"opus","fast":true,"key":"anthropic/opus"},{"providerID":"anthropic","modelID":"opus","fast":false,"key":"anthropic/opus"}]}"#
        ModelsStubProtocol.responses = [
            "opencode:models": reply(modelsJSON), "opencode:default-model": reply("null"),
            "config:get": reply("{}"), "models:picker": reply(picker),
        ]
        let api = ModelsStubProtocol.client()
        let catalog = ChatModelCatalog(api: api, defaults: UserDefaults(suiteName: "ModelsStoreTests-\(UUID().uuidString)")!)
        catalog.loadIfNeeded()
        await catalog.waitForLoad()
        let modelStore = ChatModelStore(sessionId: "s1", api: api, catalog: catalog, prefs: ChatModelPrefs(api: api))
        XCTAssertEqual(modelStore.visibleRecents.map(\.fast), [false])
        XCTAssertFalse(modelStore.apply(ModelChoice(providerID: "anthropic", modelID: "opus", variant: nil, fast: true)))
    }

    // MARK: Failures drawn where the user acted (finding 1)

    func testAnIdentifyConfirmRefusedForAFieldStillSaysSo() async {
        ModelsStubProtocol.responses = [
            "models:declare": reply(#"{"ok":false,"field":"catalogId","code":"unknown-catalog","message":"Pick the model this is."}"#),
        ]
        let api = ModelsStubProtocol.client()
        let catalog = ChatModelCatalog(api: api, defaults: UserDefaults(suiteName: "ModelsStoreTests-\(UUID().uuidString)")!)
        let unidentified = ModelsUnidentifiedStore(api: api, catalog: catalog)
        await unidentified.declare(key: "anthropic/mystery", catalogId: "nope")
        XCTAssertEqual(unidentified.feedback, .failed("Pick the model this is."))
    }

    func testTheEditorKeepsAFieldRefusalForItsOwnField() async {
        ModelsStubProtocol.responses = [
            "models:declare": reply(#"{"ok":false,"field":"price","code":"bad-price","message":"Choose Free, or enter at least one price."}"#),
        ]
        let api = ModelsStubProtocol.client()
        let catalog = ChatModelCatalog(api: api, defaults: UserDefaults(suiteName: "ModelsStoreTests-\(UUID().uuidString)")!)
        let unidentified = ModelsUnidentifiedStore(api: api, catalog: catalog)
        let form = ModelsDeclareForm(catalogId: "x", price: nil, costIn: "", costOut: "", caching: "none", reads: true, writes: true)
        let result = await unidentified.declare(key: "anthropic/mystery", form: form)
        XCTAssertEqual(result?.field, "price")
        XCTAssertNil(unidentified.feedback, "the form shows a field error under that field")
    }

    func testAnOverrideRefusalWithoutAFieldIsShownAsAFailure() async {
        ModelsStubProtocol.responses = [
            "models:table": reply(table),
            "models:set-override": reply(#"{"ok":false,"code":"unknown-model","message":"That model is no longer on this box."}"#),
        ]
        let (store, _) = store()
        await store.refresh()
        let saved = await store.saveOverride(key: "anthropic/opus", name: "X", description: "", context: "")
        XCTAssertFalse(saved)
        XCTAssertEqual(store.feedback, .failed("That model is no longer on this box."))
        XCTAssertNil(store.fieldError)
    }

    func testAThrownPriceSaveDoesNotClaimNothingWasChanged() async {
        ModelsStubProtocol.responses = [
            "models:set-price": #"{"error":"socket hang up"}"#,
            "optimizer:prices": reply(#"{"supported":true,"unpricedByProvider":[{"providerID":"anthropic","models":["old"]}]}"#),
        ]
        let priceStore = ModelsPriceStore(api: ModelsStubProtocol.client())
        let result = await priceStore.save(providerID: "anthropic", modelID: "old", input: "1", output: "2", cacheRead: "0.1", cacheWrite: "")
        XCTAssertNil(result.reply)
        let text = result.error ?? ""
        XCTAssertTrue(text.contains("Couldn't confirm the save"))
        XCTAssertFalse(text.contains("Nothing was changed"))
        XCTAssertEqual(ModelsStubProtocol.count("optimizer:prices"), 1, "what landed is re-read")
    }

    // MARK: M-03-5

    func testAgentsLoadErrorThenRetry() async {
        ModelsStubProtocol.responses = ["opencode:agents": #"{"error":"agents unavailable"}"#]
        let api = ModelsStubProtocol.client()
        let catalog = ChatModelCatalog(api: api, defaults: UserDefaults(suiteName: "ModelsStoreTests-\(UUID().uuidString)")!)
        let modelStore = ChatModelStore(sessionId: "s1", api: api, catalog: catalog, prefs: ChatModelPrefs(api: api))
        modelStore.loadAgentsIfNeeded()
        do { let ok = await eventually { modelStore.agentsLoadError != nil }; XCTAssertTrue(ok) }
        XCTAssertNil(modelStore.agents)
        XCTAssertEqual(modelStore.agentsLoadError, "agents unavailable")

        ModelsStubProtocol.responses["opencode:agents"] = reply(#"[{"name":"plan","mode":"primary"}]"#)
        modelStore.retryAgents()
        XCTAssertNil(modelStore.agentsLoadError)
        do { let ok = await eventually { modelStore.agents != nil }; XCTAssertTrue(ok) }
    }

    // MARK: Box lifecycle + one-time copy

    func testBoxSwitchNeverPairsBoxBsTokenWithBoxAsHost() async {
        ModelsStubProtocol.responses = [
            "opencode:models": reply(modelsJSON), "opencode:default-model": reply("null"),
            "config:get": reply("{}"), "models:picker": reply(pickerJSON),
        ]
        var creds: ModelsBoxCredentials? = nil
        let catalog = ChatModelCatalog(credentials: { creds }, makeClient: ModelsStubProtocol.makeClient,
                                       defaults: UserDefaults(suiteName: "ModelsStoreTests-\(UUID().uuidString)")!)
        // unpaired: no request at all
        catalog.reload()
        await catalog.waitForLoad()
        XCTAssertTrue(ModelsStubProtocol.recorded.isEmpty)

        creds = ModelsBoxCredentials(serverUrl: "https://a.example.com", boxId: "A", boxToken: "tokA")
        catalog.reload()
        await catalog.waitForLoad()
        XCTAssertTrue(catalog.loaded)
        XCTAssertTrue(ModelsStubProtocol.recorded.allSatisfy { $0.host == "a.example.com" && $0.auth == "Bearer tokA" })

        creds = ModelsBoxCredentials(serverUrl: "https://b.example.com", boxId: "B", boxToken: "tokB")
        ModelsStubProtocol.recorded = []
        catalog.reload()
        XCTAssertFalse(catalog.loaded, "the old box's state is dropped on the switch")
        await catalog.waitForLoad()
        XCTAssertFalse(ModelsStubProtocol.recorded.isEmpty)
        XCTAssertTrue(ModelsStubProtocol.recorded.allSatisfy { $0.host == "b.example.com" && $0.auth == "Bearer tokB" })
    }

    func testALateAnswerFromTheOldBoxIsDropped() async {
        ModelsStubProtocol.responses = [
            "opencode:models": reply(modelsJSON), "opencode:default-model": reply("null"),
            "config:get": reply("{}"), "models:picker": reply(pickerJSON),
        ]
        let catalog = ChatModelCatalog(api: ModelsStubProtocol.client(), defaults: UserDefaults(suiteName: "ModelsStoreTests-\(UUID().uuidString)")!)
        ModelsStubProtocol.held = ["opencode:models"]
        catalog.loadIfNeeded()
        do { let ok = await eventually { ModelsStubProtocol.count("opencode:models") == 1 }; XCTAssertTrue(ok) }
        catalog.resetForBoxChange()
        ModelsStubProtocol.releaseHeld()
        try? await Task.sleep(for: .milliseconds(150))
        XCTAssertTrue(catalog.models.isEmpty)
        XCTAssertFalse(catalog.loaded)
    }

    func testOneTimeCopyOfDeviceOptInsSendsOnceThenClears() async {
        let suite = "ModelsStoreTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        DeprecatedModelOptIns.save(["anthropic/old"], defaults)
        ModelsStubProtocol.responses = [
            "opencode:models": reply(modelsJSON), "opencode:default-model": reply("null"),
            "config:get": reply("{}"), "models:picker": reply(pickerJSON),
            "models:opt-in": reply(#"{"ok":true,"message":"Enabled Old.","outcome":"applied"}"#),
        ]
        let catalog = ChatModelCatalog(api: ModelsStubProtocol.client(), defaults: defaults)
        catalog.loadIfNeeded()
        await catalog.waitForLoad()
        XCTAssertEqual(ModelsStubProtocol.count("models:opt-in"), 1)
        // Decoded, not substring-matched: the recorded body is JSONSerialization output,
        // which escapes "/" ("anthropic\/old").
        let sent = ModelsStubProtocol.args(of: "models:opt-in").first as? [String: Any]
        XCTAssertEqual(sent?["keys"] as? [String], ["anthropic/old"])
        XCTAssertEqual(DeprecatedModelOptIns.load(defaults), [])
        catalog.reload()
        await catalog.waitForLoad()
        XCTAssertEqual(ModelsStubProtocol.count("models:opt-in"), 1, "not re-sent on a later read")
    }

    func testFailedCopyKeepsTheLocalSetAndRetriesOnTheNextRead() async {
        let defaults = UserDefaults(suiteName: "ModelsStoreTests-\(UUID().uuidString)")!
        DeprecatedModelOptIns.save(["anthropic/old"], defaults)
        ModelsStubProtocol.responses = [
            "opencode:models": reply(modelsJSON), "opencode:default-model": reply("null"),
            "config:get": reply("{}"), "models:picker": reply(pickerJSON),
            "models:opt-in": #"{"error":"boom"}"#,
        ]
        let catalog = ChatModelCatalog(api: ModelsStubProtocol.client(), defaults: defaults)
        catalog.loadIfNeeded()
        await catalog.waitForLoad()
        XCTAssertEqual(DeprecatedModelOptIns.load(defaults), ["anthropic/old"])
        catalog.reloadPicker()
        await catalog.waitForLoad()
        XCTAssertEqual(ModelsStubProtocol.count("models:opt-in"), 2)
    }
}

private final class ModelsTestStream: MantaEventStreamControl {
    var onState: ((MantaConnectionState) -> Void)?
    var onMessage: ((String) -> Void)?
    var onReconnect: (() -> Void)?
    var onConfigError: ((Error) -> Void)?
    var hasConnectedOnce = false
    var currentState: MantaConnectionState = .idle

    func ensure() {}
    func markReconnectAndEnsure() {}
    func retryNow() {}
    func forceReconnect() {}
    func close(reason: String) {}

    func inject(_ text: String) { onMessage?(text) }
}
