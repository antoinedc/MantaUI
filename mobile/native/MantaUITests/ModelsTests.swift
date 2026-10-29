import XCTest
@testable import MantaUI

// WS09 — wire decoding for the box-computed models / spend views (fixtures are the
// REAL output of src/server/{modelsTable,ledgerView,modelsUnidentified,modelsPricing}.mjs),
// plus the Foundation-only helpers: capability detection, money / count formatting,
// the identify typeahead + Save gate and the one-time opt-in copy rule.

private enum Fx {
    static let table = #"""
{"supported":true,"defaultKey":"anthropic/claude-opus-4-7","defaultLine":{"name":"Opus 4.7","providerID":"anthropic"},"rows":[{"key":"anthropic/claude-opus-4-7","providerID":"anthropic","modelID":"claude-opus-4-7","name":"Opus 4.7","contextLabel":"1M","tier":"deep","description":"Deep-reasoning model for complex architectural work.","searchText":"opus 4.7 anthropic claude-opus-4-7 deep-reasoning model for complex architectural work. architecture and design decisions hard debugging and root-cause analysis multi-file reasoning and tricky refactors","deprecated":false,"deprecatedLocked":false,"isMain":true,"isSub":true,"isDefault":true,"canMakeDefault":true,"defaultHint":null,"editable":{"name":"Opus 4.7","description":"Deep-reasoning model for complex architectural work.","context":1000000}},{"key":"anthropic/claude-3-opus","providerID":"anthropic","modelID":"claude-3-opus","name":"Opus 3","contextLabel":null,"tier":"deep","description":"Deep-reasoning model for complex architectural work.","searchText":"opus 3 anthropic claude-3-opus deep-reasoning model for complex architectural work. architecture and design decisions hard debugging and root-cause analysis multi-file reasoning and tricky refactors","deprecated":true,"deprecatedLocked":true,"isMain":false,"isSub":false,"isDefault":false,"canMakeDefault":false,"defaultHint":"Enable this deprecated model first","editable":{"name":"Opus 3","description":"Deep-reasoning model for complex architectural work.","context":null}},{"key":"openai/gpt-5.6","providerID":"openai","modelID":"gpt-5.6","name":"GPT 5.6","contextLabel":null,"tier":"balanced","description":"Balanced general-purpose GPT-5 for coding and reasoning.","searchText":"gpt 5.6 openai gpt-5.6 balanced general-purpose gpt-5 for coding and reasoning. general coding tasks feature implementation code review reasoning-heavy tasks","deprecated":false,"deprecatedLocked":false,"isMain":true,"isSub":true,"isDefault":false,"canMakeDefault":true,"defaultHint":null,"editable":{"name":"GPT 5.6","description":"Balanced general-purpose GPT-5 for coding and reasoning.","context":null}},{"key":"openai/gpt-5.6-fast","providerID":"openai","modelID":"gpt-5.6-fast","name":"GPT 5.6 Fast","contextLabel":null,"tier":"balanced","description":"Balanced general-purpose GPT-5 for coding and reasoning.","searchText":"gpt 5.6 fast openai gpt-5.6-fast balanced general-purpose gpt-5 for coding and reasoning. general coding tasks feature implementation code review reasoning-heavy tasks","deprecated":false,"deprecatedLocked":false,"isMain":true,"isSub":true,"isDefault":false,"canMakeDefault":true,"defaultHint":null,"editable":{"name":"GPT 5.6 Fast","description":"Balanced general-purpose GPT-5 for coding and reasoning.","context":null}}]}
"""#
    static let picker = #"""
{"supported":true,"groups":[{"provider":"anthropic","keys":["anthropic/claude-opus-4-7","anthropic/claude-3-opus"]},{"provider":"openai","keys":["openai/gpt-5.6"]}],"locked":["anthropic/claude-3-opus"],"selectable":["anthropic/claude-opus-4-7","openai/gpt-5.6","openai/gpt-5.6-fast"],"delegateGroups":[{"provider":"anthropic","keys":["anthropic/claude-opus-4-7"]},{"provider":"openai","keys":["openai/gpt-5.6"]}],"recents":[{"providerID":"anthropic","modelID":"claude-opus-4-7","variant":"high","fast":false,"key":"anthropic/claude-opus-4-7"}]}
"""#
    static let writeOK = #"""
{"ok":true,"table":{"supported":true,"defaultKey":"anthropic/claude-opus-4-7","defaultLine":{"name":"Opus 4.7","providerID":"anthropic"},"rows":[{"key":"anthropic/claude-opus-4-7","providerID":"anthropic","modelID":"claude-opus-4-7","name":"Opus 4.7","contextLabel":"1M","tier":"deep","description":"Deep-reasoning model for complex architectural work.","searchText":"opus 4.7 anthropic claude-opus-4-7 deep-reasoning model for complex architectural work. architecture and design decisions hard debugging and root-cause analysis multi-file reasoning and tricky refactors","deprecated":false,"deprecatedLocked":false,"isMain":true,"isSub":true,"isDefault":true,"canMakeDefault":true,"defaultHint":null,"editable":{"name":"Opus 4.7","description":"Deep-reasoning model for complex architectural work.","context":1000000}},{"key":"anthropic/claude-3-opus","providerID":"anthropic","modelID":"claude-3-opus","name":"Opus 3","contextLabel":null,"tier":"deep","description":"Deep-reasoning model for complex architectural work.","searchText":"opus 3 anthropic claude-3-opus deep-reasoning model for complex architectural work. architecture and design decisions hard debugging and root-cause analysis multi-file reasoning and tricky refactors","deprecated":true,"deprecatedLocked":true,"isMain":false,"isSub":false,"isDefault":false,"canMakeDefault":false,"defaultHint":"Enable this deprecated model first","editable":{"name":"Opus 3","description":"Deep-reasoning model for complex architectural work.","context":null}},{"key":"openai/gpt-5.6","providerID":"openai","modelID":"gpt-5.6","name":"GPT 5.6","contextLabel":null,"tier":"balanced","description":"Balanced general-purpose GPT-5 for coding and reasoning.","searchText":"gpt 5.6 openai gpt-5.6 balanced general-purpose gpt-5 for coding and reasoning. general coding tasks feature implementation code review reasoning-heavy tasks","deprecated":false,"deprecatedLocked":false,"isMain":true,"isSub":true,"isDefault":false,"canMakeDefault":true,"defaultHint":null,"editable":{"name":"GPT 5.6","description":"Balanced general-purpose GPT-5 for coding and reasoning.","context":null}},{"key":"openai/gpt-5.6-fast","providerID":"openai","modelID":"gpt-5.6-fast","name":"GPT 5.6 Fast","contextLabel":null,"tier":"balanced","description":"Balanced general-purpose GPT-5 for coding and reasoning.","searchText":"gpt 5.6 fast openai gpt-5.6-fast balanced general-purpose gpt-5 for coding and reasoning. general coding tasks feature implementation code review reasoning-heavy tasks","deprecated":false,"deprecatedLocked":false,"isMain":true,"isSub":true,"isDefault":false,"canMakeDefault":true,"defaultHint":null,"editable":{"name":"GPT 5.6 Fast","description":"Balanced general-purpose GPT-5 for coding and reasoning.","context":null}}]},"message":"Hidden from the model picker."}
"""#
    static let writePartial = #"""
{"ok":true,"table":{"supported":true,"defaultKey":"anthropic/claude-opus-4-7","defaultLine":{"name":"Opus 4.7","providerID":"anthropic"},"rows":[{"key":"anthropic/claude-opus-4-7","providerID":"anthropic","modelID":"claude-opus-4-7","name":"Opus 4.7","contextLabel":"1M","tier":"deep","description":"Deep-reasoning model for complex architectural work.","searchText":"opus 4.7 anthropic claude-opus-4-7 deep-reasoning model for complex architectural work. architecture and design decisions hard debugging and root-cause analysis multi-file reasoning and tricky refactors","deprecated":false,"deprecatedLocked":false,"isMain":true,"isSub":true,"isDefault":true,"canMakeDefault":true,"defaultHint":null,"editable":{"name":"Opus 4.7","description":"Deep-reasoning model for complex architectural work.","context":1000000}},{"key":"anthropic/claude-3-opus","providerID":"anthropic","modelID":"claude-3-opus","name":"Opus 3","contextLabel":null,"tier":"deep","description":"Deep-reasoning model for complex architectural work.","searchText":"opus 3 anthropic claude-3-opus deep-reasoning model for complex architectural work. architecture and design decisions hard debugging and root-cause analysis multi-file reasoning and tricky refactors","deprecated":true,"deprecatedLocked":true,"isMain":false,"isSub":false,"isDefault":false,"canMakeDefault":false,"defaultHint":"Enable this deprecated model first","editable":{"name":"Opus 3","description":"Deep-reasoning model for complex architectural work.","context":null}},{"key":"openai/gpt-5.6","providerID":"openai","modelID":"gpt-5.6","name":"GPT 5.6","contextLabel":null,"tier":"balanced","description":"Balanced general-purpose GPT-5 for coding and reasoning.","searchText":"gpt 5.6 openai gpt-5.6 balanced general-purpose gpt-5 for coding and reasoning. general coding tasks feature implementation code review reasoning-heavy tasks","deprecated":false,"deprecatedLocked":false,"isMain":true,"isSub":true,"isDefault":false,"canMakeDefault":true,"defaultHint":null,"editable":{"name":"GPT 5.6","description":"Balanced general-purpose GPT-5 for coding and reasoning.","context":null}},{"key":"openai/gpt-5.6-fast","providerID":"openai","modelID":"gpt-5.6-fast","name":"GPT 5.6 Fast","contextLabel":null,"tier":"balanced","description":"Balanced general-purpose GPT-5 for coding and reasoning.","searchText":"gpt 5.6 fast openai gpt-5.6-fast balanced general-purpose gpt-5 for coding and reasoning. general coding tasks feature implementation code review reasoning-heavy tasks","deprecated":false,"deprecatedLocked":false,"isMain":true,"isSub":true,"isDefault":false,"canMakeDefault":true,"defaultHint":null,"editable":{"name":"GPT 5.6 Fast","description":"Balanced general-purpose GPT-5 for coding and reasoning.","context":null}}]},"message":"Preference saved, but the subagent list on the box wasn't updated. Try again to apply it.","outcome":"not-applied","retry":true}
"""#
    static let writeNotLive = #"""
{"ok":true,"table":{"supported":true,"defaultKey":"anthropic/claude-opus-4-7","defaultLine":{"name":"Opus 4.7","providerID":"anthropic"},"rows":[{"key":"anthropic/claude-opus-4-7","providerID":"anthropic","modelID":"claude-opus-4-7","name":"Opus 4.7","contextLabel":"1M","tier":"deep","description":"Deep-reasoning model for complex architectural work.","searchText":"opus 4.7 anthropic claude-opus-4-7 deep-reasoning model for complex architectural work. architecture and design decisions hard debugging and root-cause analysis multi-file reasoning and tricky refactors","deprecated":false,"deprecatedLocked":false,"isMain":true,"isSub":true,"isDefault":true,"canMakeDefault":true,"defaultHint":null,"editable":{"name":"Opus 4.7","description":"Deep-reasoning model for complex architectural work.","context":1000000}},{"key":"anthropic/claude-3-opus","providerID":"anthropic","modelID":"claude-3-opus","name":"Opus 3","contextLabel":null,"tier":"deep","description":"Deep-reasoning model for complex architectural work.","searchText":"opus 3 anthropic claude-3-opus deep-reasoning model for complex architectural work. architecture and design decisions hard debugging and root-cause analysis multi-file reasoning and tricky refactors","deprecated":true,"deprecatedLocked":true,"isMain":false,"isSub":false,"isDefault":false,"canMakeDefault":false,"defaultHint":"Enable this deprecated model first","editable":{"name":"Opus 3","description":"Deep-reasoning model for complex architectural work.","context":null}},{"key":"openai/gpt-5.6","providerID":"openai","modelID":"gpt-5.6","name":"GPT 5.6","contextLabel":null,"tier":"balanced","description":"Balanced general-purpose GPT-5 for coding and reasoning.","searchText":"gpt 5.6 openai gpt-5.6 balanced general-purpose gpt-5 for coding and reasoning. general coding tasks feature implementation code review reasoning-heavy tasks","deprecated":false,"deprecatedLocked":false,"isMain":true,"isSub":true,"isDefault":false,"canMakeDefault":true,"defaultHint":null,"editable":{"name":"GPT 5.6","description":"Balanced general-purpose GPT-5 for coding and reasoning.","context":null}},{"key":"openai/gpt-5.6-fast","providerID":"openai","modelID":"gpt-5.6-fast","name":"GPT 5.6 Fast","contextLabel":null,"tier":"balanced","description":"Balanced general-purpose GPT-5 for coding and reasoning.","searchText":"gpt 5.6 fast openai gpt-5.6-fast balanced general-purpose gpt-5 for coding and reasoning. general coding tasks feature implementation code review reasoning-heavy tasks","deprecated":false,"deprecatedLocked":false,"isMain":true,"isSub":true,"isDefault":false,"canMakeDefault":true,"defaultHint":null,"editable":{"name":"GPT 5.6 Fast","description":"Balanced general-purpose GPT-5 for coding and reasoning.","context":null}}]},"message":"Preference saved and written, but opencode didn't reload it.","outcome":"saved-not-live","retry":false}
"""#
    static let writeFieldError = #"""
{"ok":false,"field":"context","code":"bad-context","message":"Context size must be a whole number of tokens above 0."}
"""#
    static let unidentified = #"""
{"supported":true,"intro":"Served under a name the catalogue doesn't recognise.","footer":"Can't say? Leave it.","rows":[{"key":"ep/opaque-id","label":"ep / opaque-id","providerID":"ep","modelID":"opaque-id","state":"exact","confidence":"probable","evidence":"same context size","catalogId":"gpt-5","candidates":[],"missing":["price"],"help":"We think this is GPT 5 — same context size — Auto still needs: what it costs.","actions":["confirm","change"]},{"key":"ep/dup","label":"ep / dup","providerID":"ep","modelID":"dup","state":"ambiguous","candidates":[{"id":"a","name":"A"},{"id":"b","name":"B"}],"missing":["identity"],"help":"2 models share this name — which one is it?","actions":["pick"],"chips":true}]}
"""#
    static let unidentifiedOff = #"""
{"supported":false,"intro":"Served under a name the catalogue doesn't recognise.","footer":"x","unavailableText":"Manta couldn't load the model catalogue.","rows":[]}
"""#
    static let declareOK = #"""
{"ok":true,"outcome":"still-needs","row":{"key":"ep/opaque-id","label":"ep / opaque-id","providerID":"ep","modelID":"opaque-id","state":"exact","confidence":"probable","evidence":"same context size","catalogId":"gpt-5","candidates":[],"missing":["price"],"help":"We think this is GPT 5 — same context size — Auto still needs: what it costs.","actions":["confirm","change"]},"list":{"supported":true,"intro":"Served under a name the catalogue doesn't recognise.","footer":"Can't say? Leave it.","rows":[{"key":"ep/opaque-id","label":"ep / opaque-id","providerID":"ep","modelID":"opaque-id","state":"exact","confidence":"probable","evidence":"same context size","catalogId":"gpt-5","candidates":[],"missing":["price"],"help":"We think this is GPT 5 — same context size — Auto still needs: what it costs.","actions":["confirm","change"]},{"key":"ep/dup","label":"ep / dup","providerID":"ep","modelID":"dup","state":"ambiguous","candidates":[{"id":"a","name":"A"},{"id":"b","name":"B"}],"missing":["identity"],"help":"2 models share this name — which one is it?","actions":["pick"],"chips":true}]},"message":"Identity saved — Auto still needs: what it costs."}
"""#
    static let declareError = #"""
{"ok":false,"field":"price","code":"invalid","message":"Choose Free or enter a price."}
"""#
    static let prices = #"""
{"fetchedAt":1,"models":{},"unpriced":["openrouter/deepseek/v4"],"unpricedByProvider":[{"providerID":"openrouter","models":["deepseek/v4"]}]}
"""#
    static let pricesOld = #"""
{"fetchedAt":1,"models":{}}
"""#
    static let setPriceOK = #"""
{"ok":true,"message":"Saved — the optimizer will use these prices","warning":"opencode didn't reload its config.","unpricedByProvider":[]}
"""#
    static let setPriceError = #"""
{"ok":false,"field":"input","message":"Input price is required."}
"""#
    static let catalog = #"""
{"supported":true,"size":2,"entries":[{"id":"gpt-5","name":"GPT 5","family":"gpt","description":"General","limit":{"context":400000,"output":1}},{"id":"opus-4","name":"Opus 4","family":"claude"}]}
"""#
    static let ledger = #"""
{"supported":true,"cacheShare":{"output":0.14,"cacheRead":0.61,"cacheWrite":0.22,"input":0.03},"byModel":[{"key":"anthropic/claude-opus-4-7","turns":120,"cost":14.4,"costPerTurn":0.12,"outPerTurn":1,"tokensPerSec":41,"p50Ms":null,"p90Ms":null},{"key":"p/m","turns":2,"cost":1,"costPerTurn":0.5,"outPerTurn":1,"tokensPerSec":null,"p50Ms":null,"p90Ms":null}],"byAgent":[{"agent":null,"isChild":false,"turns":90,"cost":9,"costPerTurn":0.1},{"agent":"explore","isChild":true,"turns":3,"cost":0.3,"costPerTurn":0.1}],"view":{"segments":[{"kind":"cacheRead","label":"cache read","pct":61,"inline":true},{"kind":"cacheWrite","label":"cache write","pct":22,"inline":true},{"kind":"output","label":"output","pct":14,"inline":true},{"kind":"input","label":"fresh input","pct":3,"inline":false}],"caption":"Cache is 83% of your bill — carrying the conversation, not generating answers.","topModels":[{"key":"anthropic/claude-opus-4-7","turns":120,"costPerTurn":0.12,"tokensPerSec":41,"cost":14.4},{"key":"p/m","turns":2,"costPerTurn":0.5,"tokensPerSec":null,"cost":1}],"agents":[{"label":"main","isChild":false,"turns":90,"costPerTurn":0.1,"cost":9},{"label":"explore","isChild":true,"turns":3,"costPerTurn":0.1,"cost":0.3}],"emptyModels":"No model spend recorded.","emptyAgents":"No agent spend recorded."}}
"""#
    static let ledgerOff = #"""
{"supported":false}
"""#
    static let ledgerOld = #"""
{"supported":true,"cacheShare":{"output":0.14,"cacheRead":0.61,"cacheWrite":0.22,"input":0.03},"byModel":[{"key":"anthropic/claude-opus-4-7","turns":120,"cost":14.4,"costPerTurn":0.12,"outPerTurn":1,"tokensPerSec":41,"p50Ms":null,"p90Ms":null},{"key":"p/m","turns":2,"cost":1,"costPerTurn":0.5,"outPerTurn":1,"tokensPerSec":null,"p50Ms":null,"p90Ms":null}],"byAgent":[{"agent":null,"isChild":false,"turns":90,"cost":9,"costPerTurn":0.1},{"agent":"explore","isChild":true,"turns":3,"cost":0.3,"costPerTurn":0.1}]}
"""#
}

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

final class ModelsTests: XCTestCase {

    // MARK: models:table / models:picker

    func testDecodeTable() throws {
        let t = try decode(ModelsTableWire.self, Fx.table)
        XCTAssertEqual(t.defaultKey, "anthropic/claude-opus-4-7")
        XCTAssertEqual(t.defaultLine?.name, "Opus 4.7")
        let opus = try XCTUnwrap(t.rows.first)
        XCTAssertEqual(opus.contextLabel, "1M")
        XCTAssertEqual(opus.tier, "deep")
        XCTAssertTrue(opus.isDefault && opus.isMain && opus.isSub && opus.canMakeDefault)
        XCTAssertNil(opus.defaultHint)
        XCTAssertEqual(opus.editable.context, 1_000_000)
        let old = try XCTUnwrap(t.rows.first { $0.deprecated })
        XCTAssertTrue(old.deprecatedLocked)
        XCTAssertFalse(old.canMakeDefault)
        XCTAssertEqual(old.defaultHint, "Enable this deprecated model first")
        XCTAssertNil(old.contextLabel)
        XCTAssertNil(old.editable.context)
    }

    func testDecodePicker() throws {
        let p = try decode(ModelsPickerWire.self, Fx.picker)
        XCTAssertEqual(p.groups.map(\.provider), ["anthropic", "openai"])
        XCTAssertEqual(p.locked, ["anthropic/claude-3-opus"])
        XCTAssertTrue(p.selectable.contains("openai/gpt-5.6-fast"))
        XCTAssertFalse(p.selectable.contains("anthropic/claude-3-opus"))
        XCTAssertEqual(p.recents.first?.variant, "high")
        XCTAssertEqual(p.recents.first?.fast, false)
    }

    func testDecodeWriteReplies() throws {
        let ok = try decode(ModelsWriteReply.self, Fx.writeOK)
        XCTAssertTrue(ok.ok)
        XCTAssertNotNil(ok.table)
        XCTAssertFalse(ok.isPartial)

        let partial = try decode(ModelsWriteReply.self, Fx.writePartial)
        XCTAssertTrue(partial.isPartial)
        XCTAssertEqual(partial.outcome, "not-applied")
        XCTAssertEqual(partial.retry, true)

        let notLive = try decode(ModelsWriteReply.self, Fx.writeNotLive)
        XCTAssertTrue(notLive.isPartial)
        XCTAssertEqual(notLive.retry, false)

        let err = try decode(ModelsWriteReply.self, Fx.writeFieldError)
        XCTAssertFalse(err.ok)
        XCTAssertEqual(err.field, "context")
        XCTAssertNil(err.table)

        let noField = try decode(ModelsWriteReply.self, #"{"ok":false,"code":"unknown-model","message":"That model is no longer on this box."}"#)
        XCTAssertNil(noField.field)
        XCTAssertEqual(noField.message, "That model is no longer on this box.")
    }

    // MARK: ledger:summary

    func testDecodeLedgerWithViewWithoutViewAndUnsupported() throws {
        let full = try decode(LedgerSummaryWire.self, Fx.ledger)
        let view = try XCTUnwrap(full.view)
        XCTAssertEqual(view.segments.map(\.kind), ["cacheRead", "cacheWrite", "output", "input"])
        XCTAssertEqual(view.segments.map(\.inline), [true, true, true, false])
        XCTAssertEqual(view.caption, "Cache is 83% of your bill — carrying the conversation, not generating answers.")
        XCTAssertEqual(view.topModels.count, 2)
        XCTAssertNil(view.topModels[1].tokensPerSec)
        XCTAssertEqual(view.agents.map(\.label), ["main", "explore"])
        XCTAssertEqual(view.agents.map(\.isChild), [false, true])

        let old = try decode(LedgerSummaryWire.self, Fx.ledgerOld)
        XCTAssertTrue(old.supported)
        XCTAssertNil(old.view)

        let off = try decode(LedgerSummaryWire.self, Fx.ledgerOff)
        XCTAssertFalse(off.supported)
        XCTAssertNil(off.view)
    }

    func testMoneyAndCountFormatting() {
        XCTAssertEqual(ModelsFormat.money(1.2), "$1.20")
        XCTAssertEqual(ModelsFormat.money(0), "$0.00")
        XCTAssertEqual(ModelsFormat.money(14.4), "$14.40")
        XCTAssertEqual(ModelsFormat.money(0.125), "$0.13")
        XCTAssertEqual(ModelsFormat.money(.nan), "$0.00")
        XCTAssertEqual(ModelsFormat.count(1234, locale: Locale(identifier: "en_US")), "1,234")
        XCTAssertEqual(ModelsFormat.count(7, locale: Locale(identifier: "en_US")), "7")
    }

    // MARK: models:unidentified / models:declare

    func testDecodeUnidentified() throws {
        let list = try decode(UnidentifiedList.self, Fx.unidentified)
        XCTAssertTrue(list.supported)
        XCTAssertEqual(list.rows.map(\.state), ["exact", "ambiguous"])
        XCTAssertEqual(list.rows[0].actions, ["confirm", "change"])
        XCTAssertEqual(list.rows[0].catalogId, "gpt-5")
        XCTAssertEqual(list.rows[1].chips, true)
        XCTAssertEqual(list.rows[1].candidates.map(\.id), ["a", "b"])

        let off = try decode(UnidentifiedList.self, Fx.unidentifiedOff)
        XCTAssertFalse(off.supported)
        XCTAssertEqual(off.unavailableText, "Manta couldn't load the model catalogue.")
        XCTAssertTrue(off.rows.isEmpty)
    }

    func testDecodeDeclareReplies() throws {
        let ok = try decode(ModelsDeclareReply.self, Fx.declareOK)
        XCTAssertTrue(ok.ok)
        XCTAssertEqual(ok.outcome, "still-needs")
        XCTAssertEqual(ok.row?.key, "ep/opaque-id")
        XCTAssertEqual(ok.list?.rows.count, 2)

        let err = try decode(ModelsDeclareReply.self, Fx.declareError)
        XCTAssertFalse(err.ok)
        XCTAssertEqual(err.field, "price")
        XCTAssertNil(err.list)
    }

    func testDeclareFormEncodesAsTyped() throws {
        let form = ModelsDeclareForm(catalogId: "gpt-5", price: nil, costIn: "3", costOut: "", caching: "none", reads: true, writes: false)
        let data = try JSONEncoder().encode(form)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["catalogId"] as? String, "gpt-5")
        XCTAssertNil(json["price"], "an unanswered price is omitted so the box refuses it")
        XCTAssertEqual(json["costIn"] as? String, "3")
        XCTAssertEqual(json["writes"] as? Bool, false)
    }

    func testIdentifySearchFilter() throws {
        let entries = (0..<80).map { ModelsCatalogEntryWire(id: "model-\($0)", name: "Model \($0)", family: $0 % 2 == 0 ? "even" : "odd") }
        XCTAssertEqual(ModelsIdentifySearch.filter(entries: entries, query: "").count, 30)
        XCTAssertEqual(ModelsIdentifySearch.filter(entries: entries, query: "  ").count, 30)
        XCTAssertEqual(ModelsIdentifySearch.filter(entries: entries, query: "model-7").map(\.id), ["model-7", "model-70", "model-71", "model-72", "model-73", "model-74", "model-75", "model-76", "model-77", "model-78", "model-79"])
        XCTAssertEqual(ModelsIdentifySearch.filter(entries: entries, query: "ODD").count, 40)
        XCTAssertEqual(ModelsIdentifySearch.filter(entries: entries, query: "model").count, 50, "a typed query is capped at 50")
        XCTAssertTrue(ModelsIdentifySearch.filter(entries: entries, query: "zzz").isEmpty)
        let cat = try decode(ModelsCatalogWire.self, Fx.catalog)
        XCTAssertEqual(cat.entries.count, 2)
        XCTAssertEqual(ModelsIdentifySearch.filter(entries: cat.entries, query: "opus").map(\.id), ["opus-4"])
    }

    func testIdentifyCanSaveMatrix() {
        let entry = ModelsCatalogEntryWire(id: "gpt-5", name: "GPT 5", family: nil)
        XCTAssertFalse(ModelsIdentifySearch.canSave(selected: nil, priceMode: "free", costIn: "", costOut: ""))
        XCTAssertFalse(ModelsIdentifySearch.canSave(selected: entry, priceMode: nil, costIn: "1", costOut: "1"))
        XCTAssertTrue(ModelsIdentifySearch.canSave(selected: entry, priceMode: "free", costIn: "", costOut: ""))
        XCTAssertTrue(ModelsIdentifySearch.canSave(selected: entry, priceMode: "custom", costIn: "3", costOut: ""))
        XCTAssertTrue(ModelsIdentifySearch.canSave(selected: entry, priceMode: "custom", costIn: "", costOut: " 15 "))
        XCTAssertFalse(ModelsIdentifySearch.canSave(selected: entry, priceMode: "custom", costIn: "", costOut: ""))
        XCTAssertFalse(ModelsIdentifySearch.canSave(selected: entry, priceMode: "custom", costIn: "abc", costOut: "x"))
    }

    // MARK: optimizer:prices / models:set-price

    func testDecodePricesWithAndWithoutGroups() throws {
        let p = try decode(OptimizerPricesWire.self, Fx.prices)
        XCTAssertEqual(p.unpricedByProvider?.first?.providerID, "openrouter")
        XCTAssertEqual(p.unpricedByProvider?.first?.models, ["deepseek/v4"])
        let old = try decode(OptimizerPricesWire.self, Fx.pricesOld)
        XCTAssertNil(old.unpricedByProvider)
    }

    func testDecodeSetPriceReplies() throws {
        let ok = try decode(ModelsSetPriceReply.self, Fx.setPriceOK)
        XCTAssertTrue(ok.ok)
        XCTAssertEqual(ok.warning, "opencode didn't reload its config.")
        XCTAssertEqual(ok.unpricedByProvider, [])
        let err = try decode(ModelsSetPriceReply.self, Fx.setPriceError)
        XCTAssertFalse(err.ok)
        XCTAssertEqual(err.field, "input")
        XCTAssertNil(err.unpricedByProvider)
        let noField = try decode(ModelsSetPriceReply.self, #"{"ok":false,"message":"Couldn't save — disk full. Nothing was changed; try again."}"#)
        XCTAssertNil(noField.field)
    }

    // MARK: capability + one-time copy

    func testReasonPrefersTheBoxsSentence() {
        XCTAssertEqual(ModelsCapability.reason(MantaError.server("disk full")), "disk full")
        XCTAssertEqual(ModelsCapability.reason(MantaError.transport("offline")), "offline")
        XCTAssertFalse(ModelsCapability.reason(MantaError.authRequired).isEmpty)
    }

    func testDeprecatedOptInCopyRule() {
        XCTAssertFalse(DeprecatedOptInCopy.shouldCopy(local: [], alreadyCopied: false))
        XCTAssertTrue(DeprecatedOptInCopy.shouldCopy(local: ["a/b"], alreadyCopied: false))
        XCTAssertFalse(DeprecatedOptInCopy.shouldCopy(local: ["a/b"], alreadyCopied: true))
        XCTAssertEqual(DeprecatedOptInCopy.flagKey(boxKey: "box1"), "manta:deprecated-opt-ins-copied:box1")
    }
}
