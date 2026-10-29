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

    // MARK: - Launchers + forge: the box's values (WS11 D3)

    func testLauncherFlagValueIsTheBoxsAnswerAndNilOnAnOlderBox() throws {
        let withValue = try JSONDecoder().decode(
            AvailableLauncher.self,
            from: Data(#"{"id":"claude","label":"Claude","flags":[{"key":"skipPermissions","label":"Skip","type":"boolean","default":true,"value":false}]}"#.utf8))
        XCTAssertEqual(withValue.flags[0].value, false)
        XCTAssertEqual(withValue.flags[0].default, true)
        let old = try JSONDecoder().decode(
            AvailableLauncher.self,
            from: Data(#"{"id":"claude","label":"Claude","flags":[{"key":"skipPermissions","label":"Skip","type":"boolean","default":true}]}"#.utf8))
        XCTAssertNil(old.flags[0].value)
    }

    func testForgeSecondaryIsTheBoxsLine() throws {
        let s = try JSONDecoder().decode(
            ForgeConnectionStatus.self,
            from: Data(#"{"connected":true,"login":"octo","kind":"github","source":"cli","valid":true,"secondary":"@octo · from the gh CLI on your server"}"#.utf8))
        XCTAssertEqual(s.secondary, "@octo · from the gh CLI on your server")
        let old = try JSONDecoder().decode(ForgeConnectionStatus.self, from: Data(#"{"connected":true,"login":"octo"}"#.utf8))
        XCTAssertNil(old.secondary)
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
