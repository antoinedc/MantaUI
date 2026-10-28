import XCTest
@testable import MantaUI

// WS10 F8–F12 — the pure rules behind the Extensions screens. The reference
// cases mirror src/shared/settingsSchema.test.ts so the two clients cannot
// disagree about aliases and targets. Pure, Foundation-only.

final class SettingsExtensionsTests: XCTestCase {

    // MARK: - References (validateReferenceAlias / classifyReferenceTarget)

    func testValidAliasesAreAccepted() {
        XCTAssertNil(ExtensionsReferences.validateAlias("docs"))
        XCTAssertNil(ExtensionsReferences.validateAlias("my-lib"))
        XCTAssertNil(ExtensionsReferences.validateAlias("a.b_c-1"))
        XCTAssertNil(ExtensionsReferences.validateAlias("  padded  "), "surrounding whitespace is trimmed")
    }

    func testAnEmptyAliasIsRequired() {
        XCTAssertEqual(ExtensionsReferences.validateAlias(""), "Alias is required.")
        XCTAssertEqual(ExtensionsReferences.validateAlias("   "), "Alias is required.")
    }

    func testAliasesWithForbiddenCharactersAreRejected() {
        let message = "Alias can't contain spaces, slashes, backticks, or commas."
        XCTAssertEqual(ExtensionsReferences.validateAlias("a b"), message)
        XCTAssertEqual(ExtensionsReferences.validateAlias("a/b"), message)
        XCTAssertEqual(ExtensionsReferences.validateAlias("a`b"), message)
        XCTAssertEqual(ExtensionsReferences.validateAlias("a,b"), message)
        XCTAssertEqual(ExtensionsReferences.validateAlias("a\tb"), message)
    }

    func testClassifyTarget() {
        // Local paths.
        for path in ["/abs/path", "./rel", "../docs", "~/notes", "", "   ", "justaword", "some folder"] {
            XCTAssertEqual(ExtensionsReferences.classifyTarget(path), .path, path)
        }
        // Repositories.
        for repo in ["https://github.com/o/r", "git@github.com:o/r.git", "ssh://git@host/r", "o/r.git",
                     "owner/repo", "my-org/my.repo_x", "gitlab.com:owner/repo"] {
            XCTAssertEqual(ExtensionsReferences.classifyTarget(repo), .repository, repo)
        }
    }

    func testUpsertPayloadForAPath() {
        XCTAssertEqual(
            ExtensionsReferences.upsertPayload(alias: " docs ", target: " ../docs ", description: ""),
            ["alias": "docs", "path": "../docs"])
    }

    func testUpsertPayloadForARepositoryWithDescription() {
        XCTAssertEqual(
            ExtensionsReferences.upsertPayload(alias: "lib", target: "owner/repo", description: " the lib "),
            ["alias": "lib", "repository": "owner/repo", "description": "the lib"])
    }

    func testBlankDescriptionIsOmitted() {
        let payload = ExtensionsReferences.upsertPayload(alias: "a", target: "/x", description: "   ")
        XCTAssertNil(payload["description"])
    }

    func testDisplayTarget() {
        XCTAssertEqual(ExtensionsReferences.displayTarget(name: "docs", path: "/d", repository: nil, branch: nil), "@docs → /d")
        XCTAssertEqual(ExtensionsReferences.displayTarget(name: "lib", path: nil, repository: "o/r", branch: nil), "@lib → o/r")
        XCTAssertEqual(ExtensionsReferences.displayTarget(name: "lib", path: nil, repository: "o/r", branch: "dev"), "@lib → o/r (dev)")
        XCTAssertEqual(ExtensionsReferences.displayTarget(name: "x", path: nil, repository: nil, branch: nil), "@x → ")
    }

    // MARK: - Skill registries

    func testRegistryAddTrimsAndAppends() {
        XCTAssertEqual(ExtensionsRegistries.add("  https://a.test/skills  ", to: ["https://b.test"]),
                       ["https://b.test", "https://a.test/skills"])
    }

    func testRegistryAddRefusesBlankAndDuplicates() {
        XCTAssertNil(ExtensionsRegistries.add("   ", to: []))
        XCTAssertNil(ExtensionsRegistries.add("https://a.test", to: ["https://a.test"]))
    }

    func testRegistryRemove() {
        XCTAssertEqual(ExtensionsRegistries.remove("b", from: ["a", "b", "c"]), ["a", "c"])
        XCTAssertEqual(ExtensionsRegistries.remove("z", from: ["a"]), ["a"])
    }

    // MARK: - Launchers: decoding

    func testLauncherDecodesAFullPayload() throws {
        let json = """
        [{"id":"claude","label":"Claude Code","flags":[
            {"key":"skipPermissions","label":"Skip permission prompts","type":"boolean","default":false},
            {"key":"resume","label":"Resume","type":"boolean","default":true}]},
         {"id":"codex","label":"Codex","flags":[]}]
        """
        let list = try JSONDecoder().decode([AvailableLauncher].self, from: Data(json.utf8))
        XCTAssertEqual(list.map(\.id), ["claude", "codex"])
        XCTAssertEqual(list[0].flags.map(\.key), ["skipPermissions", "resume"])
        XCTAssertEqual(list[0].flags[0].default, false)
        XCTAssertEqual(list[0].flags[1].default, true)
        XCTAssertEqual(list[0].flags[0].label, "Skip permission prompts")
        XCTAssertEqual(list[1].flags, [])
    }

    func testLauncherToleratesMissingFlagsTypeAndDefault() throws {
        let noFlags = try JSONDecoder().decode(AvailableLauncher.self, from: Data(#"{"id":"a","label":"A"}"#.utf8))
        XCTAssertEqual(noFlags.flags, [])
        let sparse = try JSONDecoder().decode(
            AvailableLauncher.self, from: Data(#"{"id":"a","label":"A","flags":[{"key":"k","label":"K"}]}"#.utf8))
        XCTAssertEqual(sparse.flags[0].type, "boolean")
        XCTAssertEqual(sparse.flags[0].default, false)
    }

    func testLauncherWithoutAnIdFailsToDecode() {
        XCTAssertThrowsError(try JSONDecoder().decode(AvailableLauncher.self, from: Data(#"{"label":"A"}"#.utf8)))
    }

    func testAFlagWithoutAKeyIsDroppedNotFatal() throws {
        let l = try JSONDecoder().decode(
            AvailableLauncher.self,
            from: Data(#"{"id":"a","label":"A","flags":[{"label":"no key"},{"key":"k","label":"K"}]}"#.utf8))
        XCTAssertEqual(l.flags.map(\.key), ["k"])
    }

    // MARK: - Launchers: resolve / update / saved

    private let flags = [
        AvailableLauncherFlag(key: "a", label: "A", default: false),
        AvailableLauncherFlag(key: "b", label: "B", default: true),
    ]

    func testResolveSavedWinsAndDefaultsFillTheRest() {
        XCTAssertEqual(ExtensionsLaunchers.resolve(schema: flags, saved: ["a": true]), ["a": true, "b": true])
        XCTAssertEqual(ExtensionsLaunchers.resolve(schema: flags, saved: ["b": false]), ["a": false, "b": false])
    }

    func testResolveWithNothingSavedIsAllDefaults() {
        XCTAssertEqual(ExtensionsLaunchers.resolve(schema: flags, saved: nil), ["a": false, "b": true])
    }

    func testResolveDropsKeysTheSchemaNoLongerHas() {
        XCTAssertEqual(ExtensionsLaunchers.resolve(schema: flags, saved: ["gone": true, "a": true]), ["a": true, "b": true])
    }

    func testResolveOfAnEmptySchemaIsEmpty() {
        XCTAssertEqual(ExtensionsLaunchers.resolve(schema: [], saved: ["a": true]), [:])
    }

    func testUpdateWritesTheFullResolvedMapPlusTheToggledKey() {
        let launchers = [AvailableLauncher(id: "claude", label: "Claude", flags: flags),
                         AvailableLauncher(id: "codex", label: "Codex", flags: [])]
        let prev: [String: [String: Bool]] = ["codex": ["x": true]]
        let next = ExtensionsLaunchers.update(launchers: launchers, launcherID: "claude", flagKey: "a", checked: true, prev: prev)
        // `b` was never touched but is written with its default, so the box never holds a partial map.
        XCTAssertEqual(next["claude"], ["a": true, "b": true])
        XCTAssertEqual(next["codex"], ["x": true], "other launchers are untouched")
    }

    func testUpdateKeepsPriorSavedValuesOfTheSameLauncher() {
        let launchers = [AvailableLauncher(id: "claude", label: "Claude", flags: flags)]
        let next = ExtensionsLaunchers.update(
            launchers: launchers, launcherID: "claude", flagKey: "a", checked: true, prev: ["claude": ["b": false]])
        XCTAssertEqual(next["claude"], ["a": true, "b": false])
    }

    func testUpdateOfAnUnknownLauncherChangesNothing() {
        let launchers = [AvailableLauncher(id: "claude", label: "Claude", flags: flags)]
        let prev: [String: [String: Bool]] = ["claude": ["a": true]]
        XCTAssertEqual(ExtensionsLaunchers.update(launchers: launchers, launcherID: "nope", flagKey: "a", checked: false, prev: prev), prev)
    }

    func testSavedFlagsReadsAnObjectOfBools() {
        let config: [String: JSONValue] = [
            "launcherFlags": .object([
                "claude": .object(["a": .bool(true), "b": .bool(false)]),
            ])
        ]
        XCTAssertEqual(ExtensionsLaunchers.savedFlags(from: config), ["claude": ["a": true, "b": false]])
    }

    func testSavedFlagsSkipsWhatIsNotBoolOrObject() {
        let config: [String: JSONValue] = [
            "launcherFlags": .object([
                "claude": .object(["a": .bool(true), "junk": .string("yes"), "n": .number(1)]),
                "weird": .string("not an object"),
                "list": .array([]),
            ])
        ]
        XCTAssertEqual(ExtensionsLaunchers.savedFlags(from: config), ["claude": ["a": true]])
    }

    func testSavedFlagsFromNothingIsEmpty() {
        XCTAssertEqual(ExtensionsLaunchers.savedFlags(from: nil), [:])
        XCTAssertEqual(ExtensionsLaunchers.savedFlags(from: [:]), [:])
        XCTAssertEqual(ExtensionsLaunchers.savedFlags(from: ["launcherFlags": .string("x")]), [:])
    }

    // MARK: - Forge (forgeCredentialSecondary)

    func testForgeSecondaryForEverySourceWithAndWithoutALogin() {
        XCTAssertEqual(ExtensionsForge.secondary(login: "octo", source: "cli", valid: nil), "@octo · from the gh CLI on your server")
        XCTAssertEqual(ExtensionsForge.secondary(login: "octo", source: "env", valid: true), "@octo · from the MANTA_GITHUB_TOKEN env var")
        XCTAssertEqual(ExtensionsForge.secondary(login: "octo", source: "stored", valid: true), "@octo · signed in on this server")
        XCTAssertEqual(ExtensionsForge.secondary(login: "octo", source: nil, valid: nil), "@octo · connected")
        XCTAssertEqual(ExtensionsForge.secondary(login: nil, source: "cli", valid: nil), "from the gh CLI on your server")
        XCTAssertEqual(ExtensionsForge.secondary(login: nil, source: nil, valid: nil), "connected")
        XCTAssertEqual(ExtensionsForge.secondary(login: "", source: "stored", valid: nil), "signed in on this server")
    }

    func testForgeSecondaryWhenGitHubRejectedTheCredential() {
        XCTAssertEqual(ExtensionsForge.secondary(login: "octo", source: "cli", valid: false),
                       "GitHub rejected the gh CLI sign-in on your server. Run `gh auth login` there, or Disconnect.")
        XCTAssertEqual(ExtensionsForge.secondary(login: "octo", source: "env", valid: false),
                       "GitHub rejected the MANTA_GITHUB_TOKEN environment variable on your server. Replace it there, or Disconnect.")
        XCTAssertEqual(ExtensionsForge.secondary(login: "octo", source: "stored", valid: false),
                       "GitHub rejected this sign-in. Disconnect, then connect again.")
        XCTAssertEqual(ExtensionsForge.secondary(login: nil, source: nil, valid: false),
                       "GitHub rejected this sign-in. Disconnect, then connect again.")
    }

    func testForgeStatusDecodes() throws {
        let connected = try JSONDecoder().decode(
            ForgeConnectionStatus.self,
            from: Data(#"{"connected":true,"login":"octo","kind":"github","source":"cli","valid":null}"#.utf8))
        XCTAssertTrue(connected.connected)
        XCTAssertEqual(connected.login, "octo")
        XCTAssertNil(connected.valid)
        let off = try JSONDecoder().decode(ForgeConnectionStatus.self, from: Data(#"{"connected":false}"#.utf8))
        XCTAssertFalse(off.connected)
        XCTAssertNil(off.login)
    }

    // MARK: - Plugins / formatting

    func testTimeoutFormatting() {
        XCTAssertEqual(ExtensionsFormat.timeout(ms: 500), "500ms")
        XCTAssertEqual(ExtensionsFormat.timeout(ms: 1000), "1s")
        XCTAssertEqual(ExtensionsFormat.timeout(ms: 5000), "5s")
        XCTAssertEqual(ExtensionsFormat.timeout(ms: 59_400), "59s")
        XCTAssertEqual(ExtensionsFormat.timeout(ms: 60_000), "1m")
        XCTAssertEqual(ExtensionsFormat.timeout(ms: 1_800_000), "30m")
    }

    func testStepsLine() {
        XCTAssertEqual(ExtensionsFormat.stepsLine(stepCount: 1, timeoutMs: nil), "1 step")
        XCTAssertEqual(ExtensionsFormat.stepsLine(stepCount: 3, timeoutMs: 30_000), "3 steps · 30s")
        XCTAssertEqual(ExtensionsFormat.stepsLine(stepCount: 0, timeoutMs: nil), "0 steps")
    }

    func testInputsLine() {
        XCTAssertNil(ExtensionsFormat.inputsLine([]))
        let inputs = [
            PluginRegistryInput(id: "scheme"),
            PluginRegistryInput(id: "name", default: .string("App")),
            PluginRegistryInput(id: "n", default: .number(5)),
            PluginRegistryInput(id: "fast", default: .bool(true)),
        ]
        XCTAssertEqual(ExtensionsFormat.inputsLine(inputs), #"Inputs: scheme, name="App", n=5, fast=true"#)
    }

    func testRuleCountText() {
        XCTAssertEqual(ExtensionsFormat.ruleCountText(nil), "0 rules")
        XCTAssertEqual(ExtensionsFormat.ruleCountText(1), "1 rule")
        XCTAssertEqual(ExtensionsFormat.ruleCountText(3), "3 rules")
    }

    func testPluginRowsDecodeValidAndInvalid() throws {
        let json = """
        [{"name":"ios-app","description":"Build","inputs":[{"id":"scheme","description":"","type":"string","default":"App"}],
          "valid":true,"yaml":"name: ios-app","stepCount":2,"timeoutMs":30000},
         {"name":"broken","description":"","inputs":[],"valid":false,"error":"unknown key \\"x\\"","yaml":"x: 1","stepCount":0,"timeoutMs":null}]
        """
        let rows = try JSONDecoder().decode([PluginRegistryRow].self, from: Data(json.utf8))
        XCTAssertEqual(rows.map(\.name), ["ios-app", "broken"])
        XCTAssertTrue(rows[0].valid)
        XCTAssertEqual(rows[0].inputs.first?.default, .string("App"))
        XCTAssertEqual(rows[0].timeoutMs, 30_000)
        XCTAssertFalse(rows[1].valid)
        XCTAssertEqual(rows[1].error, #"unknown key "x""#)
        XCTAssertNil(rows[1].timeoutMs)
    }

    func testForgeRuleRowsDecode() throws {
        let rows = try JSONDecoder().decode(
            [ForgeRuleRow].self,
            from: Data(#"[{"repoKey":"github.com/o/r","valid":true,"ruleCount":2},{"repoKey":"github.com/o/x","valid":false,"error":"bad verb"}]"#.utf8))
        XCTAssertEqual(rows[0].ruleCount, 2)
        XCTAssertEqual(rows[1].error, "bad verb")
    }

    // MARK: - Error wording

    func testSettingsErrorMessages() {
        XCTAssertEqual(SettingsError.message(MantaError.server("boom")), "boom")
        XCTAssertEqual(SettingsError.message(MantaError.transport("offline")), "offline")
        XCTAssertEqual(SettingsError.message(MantaError.authRequired), "Sign in again — this phone's pairing was revoked.")
    }
}
