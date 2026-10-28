import Foundation

// WS09 client members (09-models-usage.md "Client members"). Every one is a thin
// `/rpc` call; the box computes the views and applies the rules. A box that
// predates a channel rejects with `unknown rpc channel: …`, which the callers map
// through `BoxCapabilities.isUnknownChannel`.

extension MantaAPIClient {

    // MARK: Models table / picker

    func modelsTable() async throws -> ModelsTableWire {
        try await callRequired("models:table", args: [], as: ModelsTableWire.self)
    }

    func modelsPicker() async throws -> ModelsPickerWire {
        try await callRequired("models:picker", args: [], as: ModelsPickerWire.self)
    }

    /// `key == nil` clears the default.
    func modelsSetDefault(key: String?) async throws -> ModelsWriteReply {
        let arg: [String: Any] = ["key": key ?? NSNull()]
        return try await callRequired("models:set-default", args: [arg], as: ModelsWriteReply.self)
    }

    func modelsSetMain(key: String, on: Bool) async throws -> ModelsWriteReply {
        try await callRequired("models:set-main", args: [["key": key, "on": on]], as: ModelsWriteReply.self)
    }

    func modelsSetSub(key: String, on: Bool) async throws -> ModelsWriteReply {
        try await callRequired("models:set-sub", args: [["key": key, "on": on]], as: ModelsWriteReply.self)
    }

    func modelsRetrySubSync() async throws -> ModelsWriteReply {
        try await callRequired("models:retry-sub-sync", args: [[String: Any]()], as: ModelsWriteReply.self)
    }

    func modelsOptIn(keys: [String]) async throws -> ModelsWriteReply {
        try await callRequired("models:opt-in", args: [["keys": keys]], as: ModelsWriteReply.self)
    }

    /// The three strings are sent AS TYPED; the box diffs against the provider
    /// defaults and validates the context.
    func modelsSetOverride(key: String, name: String, description: String, context: String) async throws -> ModelsWriteReply {
        let fields: [String: Any] = ["name": name, "description": description, "context": context]
        return try await callRequired("models:set-override", args: [["key": key, "fields": fields]], as: ModelsWriteReply.self)
    }

    // MARK: Spend / optimizer

    func ledgerSummary() async throws -> LedgerSummaryWire {
        try await callRequired("ledger:summary", args: [], as: LedgerSummaryWire.self)
    }

    func optimizerSummary() async throws -> OptimizerSummaryWire {
        try await callRequired("optimizer:summary", args: [], as: OptimizerSummaryWire.self)
    }

    /// `range`: "24h" | "7d" | "30d".
    func optimizerSeries(range: String) async throws -> OptimizerSeriesWire {
        try await callRequired("optimizer:series", args: [["range": range]], as: OptimizerSeriesWire.self)
    }

    func optimizerPrices() async throws -> OptimizerPricesWire {
        try await callRequired("optimizer:prices", args: [], as: OptimizerPricesWire.self)
    }

    /// The four strings are sent AS TYPED; the box validates and writes.
    func modelsSetPrice(providerID: String, modelID: String, input: String, output: String,
                        cacheRead: String, cacheWrite: String) async throws -> ModelsSetPriceReply {
        let draft: [String: Any] = ["input": input, "output": output, "cacheRead": cacheRead, "cacheWrite": cacheWrite]
        return try await callRequired(
            "models:set-price",
            args: [["providerID": providerID, "modelID": modelID, "draft": draft]],
            as: ModelsSetPriceReply.self
        )
    }

    // MARK: Unidentified models

    func modelCatalog() async throws -> ModelsCatalogWire {
        try await callRequired("opencode:model-catalog", args: [], as: ModelsCatalogWire.self)
    }

    func modelsUnidentified() async throws -> UnidentifiedList {
        try await callRequired("models:unidentified", args: [], as: UnidentifiedList.self)
    }

    func modelsDeclare(key: String, catalogId: String) async throws -> ModelsDeclareReply {
        try await callRequired("models:declare", args: [["key": key, "catalogId": catalogId]], as: ModelsDeclareReply.self)
    }

    func modelsDeclare(key: String, form: ModelsDeclareForm) async throws -> ModelsDeclareReply {
        try await callRequired("models:declare", args: [["key": key, "form": try jsonObject(form)]], as: ModelsDeclareReply.self)
    }

    // MARK: Resume after limit reset (the resume screen only — D29)

    func usageStoppedView() async throws -> UsageResumeViewWire {
        try await callRequired("usage-stopped:view", args: [], as: UsageResumeViewWire.self)
    }

    func usageStoppedApply(selected: [String], dryRun: Bool) async throws -> UsageResumePlanWire {
        try await callRequired(
            "usage-stopped:apply",
            args: [["selected": selected, "dryRun": dryRun]],
            as: UsageResumePlanWire.self
        )
    }

    func usageStoppedStampLastLooked() async throws {
        _ = try await callVoid("usage-stopped:stamp-last-looked", args: [])
    }

    // MARK: Usage alerts

    func usageAlerts() async throws -> UsageAlertsList {
        try await callRequired("usage:alerts", args: [], as: UsageAlertsList.self)
    }

    func usageRemindAtReset(key: String, sessionID: String) async throws -> UsageRemindReply {
        try await callRequired("usage:remind-at-reset", args: [["key": key, "sessionID": sessionID]], as: UsageRemindReply.self)
    }
}
