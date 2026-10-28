import Foundation

// ===========================================================================
// WS10 — the RPC members behind Settings / Box / Extensions (C1: this area's
// members live in their own file; nobody else edits `MantaAPIClient.swift`).
//
// Every one reuses the channel the desktop calls (`window.api.*` over `/rpc`),
// so the two clients can never disagree about what a setting does. Wire types
// are in `SettingsWireModels.swift`. A channel whose answer is never legitimately
// absent goes through `callRequired`, so a box that did not answer is an error
// the screen reports — never an empty list shown as a success.
//
// `server:update-apply` is deliberately NOT here: it goes through
// `BoxRESTClient.rpcRaw`, which keeps the HTTP status this transport discards.
// ===========================================================================

extension MantaAPIClient {

    /// `server:version` — `{ version, minClient, opencodeVersion }`.
    func serverVersion() async throws -> ServerVersionInfo {
        try await callRequired("server:version", args: [], as: ServerVersionInfo.self)
    }

    /// `server:update-check` — the box verdict plus the box-side CLI targets.
    /// Also raises the box's normal update push (deduped) — expected.
    func serverUpdateCheck() async throws -> ServerUpdateCheck {
        try await callRequired("server:update-check", args: [], as: ServerUpdateCheck.self)
    }

    /// `server:cli-update` — upgrade ONE installed AI CLI by catalog id. The box
    /// never throws here: a failure is `{ ok: false, error }`.
    func serverCliUpdate(cliID: String) async throws -> CliUpdateResult {
        try await callRequired("server:cli-update", args: [["cliId": cliID]], as: CliUpdateResult.self)
    }

    /// `tmux:restore-preview` — READ-ONLY plan of what a restore would recreate.
    func restorePreview() async throws -> TopologyRestorePreview {
        try await callRequired("tmux:restore-preview", args: [], as: TopologyRestorePreview.self)
    }

    /// `tmux:restore-topology` — apply the same plan the preview shows.
    func restoreTopology() async throws -> TopologyRestoreResult {
        try await callRequired("tmux:restore-topology", args: [], as: TopologyRestoreResult.self)
    }

    /// `auth:pair` — mint a one-time pairing code. Runs in-process on the box, so
    /// it works over the phone's authenticated `/rpc` (the HTTP `GET /auth/pair`
    /// is loopback-only and must not be used).
    func authPair() async throws -> AuthPairResult {
        try await callRequired("auth:pair", args: [], as: AuthPairResult.self)
    }

    /// `opencode:restart` — restart the agent engine. Ends every running turn.
    /// (Consumed by WS08's connect flow as well.)
    func opencodeRestart() async throws -> OkResult {
        try await callRequired("opencode:restart", args: [], as: OkResult.self)
    }

    /// `plugins:registry` — the plugin list the Mac executor published.
    func pluginsRegistry() async throws -> [PluginRegistryRow] {
        try await callRequired("plugins:registry", args: [], as: [PluginRegistryRow].self)
    }

    /// `forge:status` — presence + identity only, never a token. `validate: true`
    /// probes GitHub (Settings); the chat-side refresh passes `false`.
    func forgeStatus(validate: Bool) async throws -> ForgeConnectionStatus {
        try await callRequired("forge:status", args: [["validate": validate]], as: ForgeConnectionStatus.self)
    }

    /// `forge:rules-list` — one row per repo with a box-side rules file, invalid
    /// ones included.
    func forgeRulesList() async throws -> [ForgeRuleRow] {
        try await callRequired("forge:rules-list", args: [], as: [ForgeRuleRow].self)
    }

    /// `forge:disconnect` — clear the box's forge credential.
    func forgeDisconnect() async throws -> OkResult {
        try await callRequired("forge:disconnect", args: [], as: OkResult.self)
    }

    /// `opencode:set-references` — upsert references (`{alias, path|repository,
    /// description?}`). Hot-applies on the box; no restart.
    func opencodeSetReferences(upsert: [[String: String]]) async throws -> OkResult {
        try await callRequired("opencode:set-references", args: [["upsert": upsert]], as: OkResult.self)
    }

    /// `launchers:list` — installed AI CLIs and their launch flags. (D21: WS04
    /// consumes this for its session-mode rows.)
    func launchersList() async throws -> [AvailableLauncher] {
        try await callRequired("launchers:list", args: [], as: [AvailableLauncher].self)
    }
}
