import XCTest
@testable import MantaUI

// ===========================================================================
// WS04 — the sessions workstream's PURE logic (Linux-eligible: Foundation only).
// Rename, mode, create plan, draft prefill, repository scan + batch, close
// copy/counts/decisions, the switcher's scoring, C2 route parsing, row status
// and the wire decoders.
// ===========================================================================

// MARK: - Helpers

private func window(_ index: Int, _ name: String = "w", sid: String? = nil, cwd: String = "", worktree: String? = nil,
                    owner: String? = nil) -> MantaWindow {
    MantaWindow(index: index, name: name, active: false, paneCurrentPath: cwd, opencodeSessionId: sid,
                worktreePath: worktree, owner: owner)
}

private func project(_ name: String, _ cwd: String = "", _ windows: [MantaWindow] = []) -> MantaProject {
    MantaProject(tmuxSession: name, defaultCwd: cwd, windows: windows, attached: false, mantaOwned: nil)
}

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

// MARK: - Rename

final class SessionRenameLogicTests: XCTestCase {
    // Whether a name is valid is the box's call (sentences pinned in sessionNaming.test.mjs); the phone only
    // skips the call for an unchanged name.
    func testRenameSkipsAnUnchangedName() {
        XCTAssertNil(SessionRenameLogic.changed("a", current: "a"))
        XCTAssertNil(SessionRenameLogic.changed("  a  ", current: "a"))
    }

    func testRenameSendsTheTrimmedName() {
        XCTAssertEqual(SessionRenameLogic.changed("  b  ", current: "a"), "b")
        // An empty name is sent too: the box refuses it with its sentence, which the sheet then shows.
        XCTAssertEqual(SessionRenameLogic.changed("   ", current: "a"), "")
    }

    func testActionErrorNeverShowsTransportText() {
        XCTAssertEqual(SessionActionError.message("create", error: MantaError.transport("tmux:new-session returned no result")),
                       "Couldn't create — check the connection")
        XCTAssertEqual(SessionCreateFailure.message(for: MantaError.transport("invalid rpc envelope")), SessionCreateFailure.generic)
    }

    func testActionErrorUsesServerReasonOrFallsBack() {
        XCTAssertEqual(SessionActionError.message("rename", error: MantaError.server("duplicate session name")),
                       "Couldn't rename — duplicate session name")
        XCTAssertEqual(SessionActionError.message("rename", error: MantaError.server("")),
                       "Couldn't rename — check the connection")
        XCTAssertEqual(SessionActionError.message("rename", error: URLError(.notConnectedToInternet)),
                       "Couldn't rename — check the connection")
    }
}

// MARK: - Mode

final class SessionModeLogicTests: XCTestCase {
    func testModeRawRoundTrip() {
        for mode in [SessionMode.chat, .terminal, .cli(launcherID: "claude")] {
            XCTAssertEqual(SessionMode(raw: mode.raw), mode)
        }
        XCTAssertEqual(SessionMode.cli(launcherID: "claude").raw, "tui:claude")
    }

    func testUnknownRawParsesAsChat() {
        XCTAssertEqual(SessionMode(raw: nil), .chat)
        XCTAssertEqual(SessionMode(raw: ""), .chat)
        XCTAssertEqual(SessionMode(raw: "tui:"), .chat)
        XCTAssertEqual(SessionMode(raw: "voice"), .chat)
    }

    func testResolveCliWaitsWhileCatalogLoading() {
        XCTAssertEqual(SessionModeResolution.resolve(saved: .cli(launcherID: "claude"), catalog: .loading),
                       .waiting(launcherID: "claude"))
    }

    func testResolveCliWaitsAfterFailureWithoutSnapshot() {
        let catalog = SessionLauncherCatalog.failed(message: "x", lastGood: nil)
        XCTAssertEqual(SessionModeResolution.resolve(saved: .cli(launcherID: "claude"), catalog: catalog),
                       .waiting(launcherID: "claude"))
    }

    func testResolveCliUsesLastGoodSnapshotAfterFailure() {
        let has = SessionLauncherCatalog.failed(message: "x", lastGood: ["claude"])
        XCTAssertEqual(SessionModeResolution.resolve(saved: .cli(launcherID: "claude"), catalog: has),
                       .ready(.cli(launcherID: "claude")))
        let lacks = SessionLauncherCatalog.failed(message: "x", lastGood: ["codex"])
        XCTAssertEqual(SessionModeResolution.resolve(saved: .cli(launcherID: "claude"), catalog: lacks), .ready(.chat))
    }

    func testResolveCliDowngradesOnlyOnAuthoritativeList() {
        XCTAssertEqual(SessionModeResolution.resolve(saved: .cli(launcherID: "claude"), catalog: .loaded(ids: [])),
                       .ready(.chat))
        XCTAssertEqual(SessionModeResolution.resolve(saved: .cli(launcherID: "claude"), catalog: .loaded(ids: ["codex"])),
                       .ready(.chat))
    }

    func testResolveInstalledCliKept() {
        XCTAssertEqual(SessionModeResolution.resolve(saved: .cli(launcherID: "claude"), catalog: .loaded(ids: ["claude", "codex"])),
                       .ready(.cli(launcherID: "claude")))
    }

    func testResolveChatAndTerminalNeverWait() {
        for catalog in [SessionLauncherCatalog.loading, .failed(message: "x", lastGood: nil), .loaded(ids: [])] {
            XCTAssertEqual(SessionModeResolution.resolve(saved: .chat, catalog: catalog), .ready(.chat))
            XCTAssertEqual(SessionModeResolution.resolve(saved: .terminal, catalog: catalog), .ready(.terminal))
        }
    }

    func testDowngradeDoesNotRewriteSavedMode() throws {
        let suite = "SessionModeLogicTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        SessionModeStore.write(.cli(launcherID: "claude"), sessionID: "ses_1", defaults: defaults)
        let saved = SessionModeStore.read(sessionID: "ses_1", defaults: defaults)
        XCTAssertEqual(SessionModeResolution.resolve(saved: saved, catalog: .loaded(ids: [])), .ready(.chat))
        // The downgrade is a decision about this open, never a write.
        XCTAssertEqual(SessionModeStore.read(sessionID: "ses_1", defaults: defaults), .cli(launcherID: "claude"))
        XCTAssertEqual(SessionModeResolution.resolve(saved: SessionModeStore.read(sessionID: "ses_1", defaults: defaults),
                                                     catalog: .loaded(ids: ["claude"])),
                       .ready(.cli(launcherID: "claude")))
    }

    func testModeStoreKeyIsDesktopIdentical() {
        XCTAssertEqual(SessionModeStore.key(sessionID: "ses_1"), "manta:session:ses_1:mode")
    }

    func testPtyKeyTerminalKeepsLegacyKey() {
        XCTAssertEqual(SessionPtyKey.key(project: "p", windowIndex: 2, mode: .terminal), "p:2")
    }

    func testPtyKeyCliIsDistinct() {
        let cli = SessionPtyKey.key(project: "p", windowIndex: 2, mode: .cli(launcherID: "claude"))
        XCTAssertEqual(cli, "p:2:tui:claude")
        XCTAssertNotEqual(cli, SessionPtyKey.key(project: "p", windowIndex: 2, mode: .terminal))
    }

    func testPtyLauncherQueryJSONIsStable() {
        let a = SessionPtyLauncher(id: "claude", flags: ["b": true, "a": false])
        let b = SessionPtyLauncher(id: "claude", flags: ["a": false, "b": true])
        XCTAssertEqual(a.queryJSON, b.queryJSON)
        XCTAssertEqual(a.queryJSON, "{\"flags\":{\"a\":false,\"b\":true},\"id\":\"claude\"}")
        // WS11 D3: with no flags the box applies the saved launch options.
        XCTAssertEqual(SessionPtyLauncher(id: "claude").queryJSON, "{\"id\":\"claude\"}")
    }

    // WS11 D3 review #2: an older box runs only the flags it is given, so it gets the row's own defaults.
    func testLauncherSendsJustTheIdToACurrentBoxAndTheDefaultsToAnOlderOne() {
        let current = AvailableLauncher(id: "claude", label: "Claude", flags: [AvailableLauncherFlag(key: "skipPermissions", label: "Skip", default: true, value: false)])
        XCTAssertEqual(SessionPtyLauncher.make(id: "claude", launchers: [current]).queryJSON, "{\"id\":\"claude\"}")
        let old = AvailableLauncher(id: "claude", label: "Claude", flags: [AvailableLauncherFlag(key: "skipPermissions", label: "Skip", default: true)])
        XCTAssertEqual(SessionPtyLauncher.make(id: "claude", launchers: [old]).queryJSON, "{\"flags\":{\"skipPermissions\":true},\"id\":\"claude\"}")
        XCTAssertEqual(SessionPtyLauncher.make(id: "claude", launchers: []).queryJSON, "{\"id\":\"claude\"}")
        XCTAssertEqual(SessionPtyLauncher.make(id: "codex", launchers: [AvailableLauncher(id: "codex", label: "Codex")]).queryJSON, "{\"id\":\"codex\"}")
    }
}

// MARK: - Create: naming, hints, roots

final class SessionNamingTests: XCTestCase {
    func testDeriveProjectName() {
        XCTAssertEqual(SessionNaming.deriveProjectName("/a/b/"), "b")
        XCTAssertEqual(SessionNaming.deriveProjectName("~"), "project")
        XCTAssertEqual(SessionNaming.deriveProjectName(""), "project")
        XCTAssertEqual(SessionNaming.deriveProjectName("/"), "project")
        XCTAssertEqual(SessionNaming.deriveProjectName("~/code/api"), "api")
    }
}

// MARK: - Create: the plan

final class SessionCreatePlanTests: XCTestCase {
    private func form(_ edit: (inout SessionCreateForm) -> Void) -> SessionCreatePlan {
        var f = SessionCreateForm()
        edit(&f)
        return SessionCreatePlan.make(f)
    }

    func testExistingProjectCreateIsEnabled() {
        let p = form { $0.target = .existing }
        XCTAssertEqual(p.label, "Create")
        XCTAssertTrue(p.enabled)
        XCTAssertEqual(p.kind, .existingWindow)
    }

    func testNewProjectWithEmptyNameIsDisabled() {
        // A typed-then-emptied name is refused; an untouched field lets the box name the session.
        let p = form { $0.target = .newProject; $0.source = .folder; $0.folder = "/a/b"; $0.newProjectName = " "; $0.nameEdited = true }
        XCTAssertFalse(p.enabled)
        let ok = form { $0.target = .newProject; $0.source = .folder; $0.folder = "/a/b"; $0.newProjectName = "b"; $0.nameEdited = true }
        XCTAssertTrue(ok.enabled)
        let hinted = form { $0.target = .newProject; $0.source = .folder; $0.folder = "/a/b" }
        XCTAssertTrue(hinted.enabled)
    }

    func testScratchEmptySlugIsDisabledWithItsLabel() {
        // `scratchUsable` is the box's verdict on the name (an empty slug → not usable).
        let p = form { $0.target = .newProject; $0.source = .scratch; $0.scratchRoot = "/r"; $0.scratchName = "!!!"; $0.scratchUsable = false }
        XCTAssertFalse(p.enabled)
        XCTAssertEqual(p.label, "Create workspace")
        let ok = form { $0.target = .newProject; $0.source = .scratch; $0.scratchRoot = "/r"; $0.scratchName = "My App"; $0.scratchUsable = true }
        XCTAssertTrue(ok.enabled)
        let noRoot = form { $0.target = .newProject; $0.source = .scratch; $0.scratchRoot = ""; $0.scratchName = "x"; $0.scratchUsable = true }
        XCTAssertFalse(noRoot.enabled)
    }

    func testReposCheckedSetsUpWorkspaces() {
        let two = form { $0.target = .newProject; $0.source = .none; $0.checkedRepoCount = 2 }
        XCTAssertEqual(two.label, "Set up 2 workspaces")
        XCTAssertTrue(two.enabled)
        XCTAssertEqual(two.kind, .repoBatch)
        let one = form { $0.target = .newProject; $0.source = .none; $0.checkedRepoCount = 1 }
        XCTAssertEqual(one.label, "Set up 1 workspace")
        XCTAssertFalse(form { $0.target = .newProject; $0.source = .none }.enabled)
    }

    func testWorktreeOnWithEmptyBranchIsDisabled() {
        let p = form {
            $0.target = .existing; $0.folder = "/repo"; $0.worktreeAvailable = true
            $0.worktreeOn = true; $0.worktreeBranch = "  "
        }
        XCTAssertFalse(p.enabled)
    }

    func testWorktreeIgnoredWhenFolderIsNotARepo() {
        let p = form { $0.target = .existing; $0.folder = "/x"; $0.worktreeAvailable = false; $0.worktreeOn = true }
        XCTAssertNil(p.worktree)
        XCTAssertTrue(p.enabled)
    }

    func testCreatePlanPreservesDraftBranchIntoWorktreeCreate() {
        let p = form {
            $0.target = .existing; $0.folder = " /repo "; $0.worktreeAvailable = true
            $0.worktreeOn = true; $0.worktreeBranch = "fix/bug-12"
        }
        XCTAssertEqual(p.worktree, SessionCreatePlan.Worktree(cwd: "/repo", branch: "fix/bug-12"))
    }

    func testOpenAsOnlyAppliesToASingleSession() {
        let single = form { $0.target = .existing; $0.openAs = .terminal }
        XCTAssertEqual(single.mode, .terminal)
        let batch = form { $0.target = .newProject; $0.source = .none; $0.checkedRepoCount = 1; $0.openAs = .terminal }
        XCTAssertEqual(batch.mode, .chat)
    }

    func testPlanCarriesDraftAndNeverASeed() {
        let draft = NewSessionDraft(cwd: "/r", text: "hello", attachments: [NewSessionDraftAttachment(remotePath: "/u/a.png", displayName: "a.png", mime: "image/png")])
        let p = form { $0.target = .existing; $0.draft = draft }
        XCTAssertEqual(p.draft, draft)
        XCTAssertNil(p.seed)
    }

    func testDontCarryOverDropsTextAndAttachmentsButKeepsTheRest() {
        let draft = NewSessionDraft(cwd: "/r", text: "hello",
                                    attachments: [NewSessionDraftAttachment(remotePath: "/u/a.png", displayName: "a.png", mime: nil)],
                                    worktreeBranch: "wt", linkedIssueURL: "https://x/1")
        let p = form { $0.target = .existing; $0.draft = draft; $0.dropCarryOver = true }
        XCTAssertEqual(p.draft?.text, "")
        XCTAssertEqual(p.draft?.attachments, [])
        XCTAssertEqual(p.draft?.cwd, "/r")
        XCTAssertEqual(p.draft?.worktreeBranch, "wt")
        XCTAssertNil(p.seed)
    }

    func testTerminalSessionsDropTheSeed() {
        let draft = NewSessionDraft(text: "hello")
        let p = form { $0.target = .existing; $0.draft = draft; $0.openAs = .terminal }
        XCTAssertEqual(p.draft?.text, "")
    }

    func testOpenAsTerminalWritesModeAndPushesTerminal() {
        let l = SessionCreateLanding.make(mode: .terminal, sessionId: "ses_1")
        XCTAssertEqual(l, SessionCreateLanding(mode: .terminal, sessionId: "ses_1", writesMode: true))
        let c = SessionCreateLanding.make(mode: .cli(launcherID: "claude"), sessionId: "ses_1")
        XCTAssertEqual(c.mode, .cli(launcherID: "claude"))
        XCTAssertTrue(c.writesMode)
    }

    func testOpenAsCliWithoutSessionIdFallsBackToPlainTerminal() {
        let l = SessionCreateLanding.make(mode: .cli(launcherID: "claude"), sessionId: nil)
        XCTAssertEqual(l, SessionCreateLanding(mode: .terminal, sessionId: nil, writesMode: false))
        XCTAssertEqual(SessionCreateLanding.make(mode: .terminal, sessionId: "").sessionId, nil)
    }

    func testCreatedWindowFoundBySessionIdWhenNameDiffers() {
        let projects = [project("other", "", [window(0, "x", sid: "ses_o")]), project("next_js", "", [window(0, "default", sid: "ses_new")])]
        let located = SessionCreatedWindow.locate(in: projects, project: "next.js", windowIndex: nil, sessionId: "ses_new", name: "default")
        XCTAssertEqual(located?.project, "next_js")
        XCTAssertEqual(located?.window.opencodeSessionId, "ses_new")
        // Even a name that is wrong in another way resolves by the session id.
        let renamed = SessionCreatedWindow.locate(in: projects, project: "totally-else", windowIndex: 0, sessionId: "ses_new", name: nil)
        XCTAssertEqual(renamed?.project, "next_js")
        XCTAssertNil(SessionCreatedWindow.locate(in: projects, project: "nope", windowIndex: 0, sessionId: nil, name: nil))
        XCTAssertNil(SessionCreatedWindow.locate(in: projects, project: "nope", windowIndex: 0, sessionId: "ses_none", name: nil))
    }

    func testCreatedWindowFoundByTheNameTheBoxReported() {
        let projects = [project("api_v2", "", [window(1, "default")])]
        let located = SessionCreatedWindow.locate(in: projects, project: "api_v2", windowIndex: 1, sessionId: nil, name: "default")
        XCTAssertEqual(located?.project, "api_v2")
        XCTAssertEqual(located?.window.index, 1)
    }

    func testCreateResultDecodesTheBoxsName() throws {
        let with = try JSONDecoder().decode(TmuxCreateResult.self, from: Data(#"{"name":"next_js","projects":[],"sessionId":"s","windowIndex":0}"#.utf8))
        XCTAssertEqual(with.name, "next_js")
        let old = try JSONDecoder().decode(TmuxCreateResult.self, from: Data(#"{"projects":[],"sessionId":"s","windowIndex":0}"#.utf8))
        XCTAssertNil(old.name)
        XCTAssertNil(try JSONDecoder().decode(TmuxCreateResult.self, from: Data("[]".utf8)).name)
    }

    func testProposalAndProbeDecode() throws {
        let p = try JSONDecoder().decode(SessionNameProposal.self, from: Data(#"{"name":"app-2","hint":"app already exists — will create app-2"}"#.utf8))
        XCTAssertEqual(p, SessionNameProposal(name: "app-2", hint: "app already exists — will create app-2"))
        XCTAssertNil(try JSONDecoder().decode(SessionNameProposal.self, from: Data(#"{"name":"app","hint":null}"#.utf8)).hint)
        let probe = try JSONDecoder().decode(ForgeProbeResult.self, from: Data(#"{"repos":[],"cli":{},"partial":false,"homeDir":"/home/u","proposedRoot":"/home/u/code"}"#.utf8))
        XCTAssertEqual(probe.proposedRoot, "/home/u/code")
    }

    func testChatLandingWritesNothing() {
        XCTAssertFalse(SessionCreateLanding.make(mode: .chat, sessionId: "ses_1").writesMode)
    }

    func testCreatedWindowIsFoundByIndexBeforeName() {
        // Two windows share a name; the index the box reported is the truth (B2).
        let projects = [project("p", "", [window(0, "session", sid: "a"), window(3, "session", sid: "b")])]
        XCTAssertEqual(SessionCreatedWindow.find(in: projects, project: "p", windowIndex: 3, name: "session")?.opencodeSessionId, "b")
        XCTAssertEqual(SessionCreatedWindow.find(in: projects, project: "p", windowIndex: nil, name: "session")?.opencodeSessionId, "a")
        XCTAssertEqual(SessionCreatedWindow.find(in: projects, project: "p", windowIndex: 9, name: "nope")?.opencodeSessionId, "b")
        XCTAssertNil(SessionCreatedWindow.find(in: projects, project: "missing", windowIndex: 0, name: nil))
    }
}

// MARK: - Create: draft prefill

final class SessionDraftPrefillTests: XCTestCase {
    private let projects = [
        project("web", "/work/web", [window(0, "main", cwd: "/work/web/app")]),
        project("deep", "/work/web/deep"),
        project("other", "/work/other"),
    ]

    private func apply(_ draft: NewSessionDraft, boxDefault: Bool = false) -> SessionCreatePrefill {
        SessionDraftPrefill.apply(draft: draft, projects: projects, worktreePerSession: boxDefault)
    }

    func testPrefillMatchesProjectDefaultCwd() {
        XCTAssertEqual(apply(NewSessionDraft(cwd: "/work/other")).target, .existing(project: "other"))
        XCTAssertEqual(apply(NewSessionDraft(cwd: "/work/other")).folder, "/work/other")
    }

    func testPrefillLongestPrefixWins() {
        XCTAssertEqual(apply(NewSessionDraft(cwd: "/work/web/deep/src")).target, .existing(project: "deep"))
    }

    func testPrefillUnderPaneCurrentPath() {
        XCTAssertEqual(apply(NewSessionDraft(cwd: "/work/web/app/sub")).target, .existing(project: "web"))
    }

    func testPrefillUnknownCwdIsNewProjectFolder() {
        let p = apply(NewSessionDraft(cwd: "/elsewhere/x"))
        XCTAssertEqual(p.target, .newProjectFolder)
        XCTAssertEqual(p.folder, "/elsewhere/x")
    }

    func testPrefillNilCwdKeepsDefault() {
        let p = apply(NewSessionDraft(cwd: nil))
        XCTAssertEqual(p.target, .unspecified)
        XCTAssertNil(p.folder)
    }

    func testPrefillDoesNotMatchSiblingPrefix() {
        // `/work/other2` is not under `/work/other`.
        XCTAssertEqual(apply(NewSessionDraft(cwd: "/work/other2")).target, .newProjectFolder)
    }

    func testPrefillWorktreeBranchOverridesBoxDefaultOff() {
        let p = apply(NewSessionDraft(cwd: "/work/other", worktreeBranch: "issue-7"), boxDefault: false)
        XCTAssertTrue(p.worktreeOn)
        XCTAssertEqual(p.worktreeBranch, "issue-7")
    }

    func testPrefillWorktreeBranchOverridesBoxDefaultOn() {
        let p = apply(NewSessionDraft(cwd: "/work/other", worktreeBranch: "issue-7"), boxDefault: true)
        XCTAssertTrue(p.worktreeOn)
        XCTAssertEqual(p.worktreeBranch, "issue-7")
        XCTAssertNotEqual(p.worktreeBranch, SessionWorktreeDefaults.branch)
    }

    func testPrefillWorktreeBranchOverridesDefaultForANewProjectFolderToo() {
        let p = apply(NewSessionDraft(cwd: "/elsewhere/x", worktreeBranch: "issue-7"))
        XCTAssertTrue(p.worktreeOn)
        XCTAssertEqual(p.worktreeBranch, "issue-7")
    }

    func testPrefillNilBranchUsesBoxDefault() {
        XCTAssertTrue(apply(NewSessionDraft(cwd: "/work/other"), boxDefault: true).worktreeOn)
        XCTAssertFalse(apply(NewSessionDraft(cwd: "/work/other"), boxDefault: false).worktreeOn)
        XCTAssertEqual(apply(NewSessionDraft(cwd: "/work/other"), boxDefault: true).worktreeBranch, SessionWorktreeDefaults.branch)
        // A new project from a folder defaults OFF whatever the box says.
        XCTAssertFalse(apply(NewSessionDraft(cwd: "/elsewhere/x"), boxDefault: true).worktreeOn)
    }

    func testPrefillCarriesLinkedIssueURL() {
        XCTAssertEqual(apply(NewSessionDraft(linkedIssueURL: "https://github.com/o/r/issues/7")).linkedIssueURL,
                       "https://github.com/o/r/issues/7")
    }

    func testPrefillNilIssueHasNoHeader() {
        XCTAssertNil(apply(NewSessionDraft()).linkedIssueURL)
        XCTAssertNil(apply(NewSessionDraft(linkedIssueURL: "  ")).linkedIssueURL)
    }

    func testCarryOverDetection() {
        XCTAssertFalse(NewSessionDraft().hasCarryOver)
        XCTAssertTrue(NewSessionDraft(text: "x").hasCarryOver)
        XCTAssertTrue(NewSessionDraft(attachments: [NewSessionDraftAttachment(remotePath: "/a", displayName: "a", mime: nil)]).hasCarryOver)
    }
}

// MARK: - Repository scan + batch

final class SessionRepoScanTests: XCTestCase {
    func testZeroStatePendingWinsOverFailed() {
        XCTAssertEqual(RepoZeroState.mode(pending: true, failed: true, repos: []), .scanning)
    }

    func testZeroStateFreshWhenNoRepos() {
        XCTAssertEqual(RepoZeroState.mode(pending: false, failed: false, repos: []), .fresh)
        XCTAssertEqual(RepoZeroState.mode(pending: false, failed: true, repos: []), .degraded)
    }

    func testZeroStateListWhenRepos() {
        XCTAssertEqual(RepoZeroState.mode(pending: false, failed: false, repos: [RepoHit(path: "/a", name: "a")]), .list)
    }

    func testRepoSecondaryWithOrigin() {
        let repo = RepoHit(path: "/home/u/api", name: "api", branch: "main", originUrl: "git@x:o/api.git")
        XCTAssertEqual(RepoRowFormat.secondary(repo, homeDir: "/home/u"), "⎇ main")
    }

    func testRepoSecondaryNoRemoteUsesTilde() {
        let repo = RepoHit(path: "/home/u/scratch", name: "scratch", branch: "main")
        XCTAssertEqual(RepoRowFormat.secondary(repo, homeDir: "/home/u"), "⎇ main · ~/scratch · no remote")
    }

    func testRepoSecondaryDetached() {
        let repo = RepoHit(path: "/srv/x", name: "x")
        XCTAssertEqual(RepoRowFormat.secondary(repo, homeDir: "/home/u"), "no branch · /srv/x · no remote")
    }

    func testHomeRelative() {
        XCTAssertEqual(RepoRowFormat.homeRelative("/home/u", homeDir: "/home/u"), "~")
        XCTAssertEqual(RepoRowFormat.homeRelative("/home/ux/a", homeDir: "/home/u"), "/home/ux/a")
        XCTAssertEqual(RepoRowFormat.homeRelative("/a", homeDir: nil), "/a")
    }

    func testAgeNowMinutesHoursDays() {
        XCTAssertEqual(RepoRowFormat.age(ms: 59_999), "now")
        XCTAssertEqual(RepoRowFormat.age(ms: 60_000), "1m")
        XCTAssertEqual(RepoRowFormat.age(ms: 3_600_000), "1h")
        XCTAssertEqual(RepoRowFormat.age(ms: 86_400_000), "1d")
        XCTAssertEqual(RepoRowFormat.age(ms: -5), "now")
    }

    func testBatchRowsAreLabelledByTheirFolder() {
        let two = SessionSetupBatch(paths: ["/a/api", "/b/api"])
        XCTAssertEqual(two.rows.map(\.name), ["api", "api"], "a label only — the box names each session uniquely")
        XCTAssertEqual(SessionSetupBatch(paths: ["/r/next.js"]).rows.map(\.name), ["next.js"])
    }

    func testFailCreatingLeavesNoRowStuckCreating() {
        var batch = SessionSetupBatch(paths: ["/a", "/b", "/c"])
        batch.markCreating(at: 0)
        batch.markReady(path: "/a")
        batch.markCreating(at: 1)
        batch.failCreating(message: "Cancelled")
        XCTAssertEqual(batch.rows.map(\.phase), [.ready, .failed, .queued])
        XCTAssertEqual(batch.rows[1].error, "Cancelled")
        XCTAssertFalse(batch.rows.contains { $0.phase == .creating })
    }

    func testBatchRunsInOrderAndTracksPhases() {
        var batch = SessionSetupBatch(paths: ["/a", "/b"])
        XCTAssertEqual(batch.nextQueuedIndex, 0)
        batch.markCreating(at: 0)
        XCTAssertTrue(batch.isRunning)
        batch.markReady(path: "/a")
        XCTAssertEqual(batch.nextQueuedIndex, 1)
        batch.markCreating(at: 1)
        batch.markReady(path: "/b")
        XCTAssertFalse(batch.isRunning)
        XCTAssertTrue(batch.allReady)
    }

    func testBatchLandsOnFirstSuccess() {
        var batch = SessionSetupBatch(paths: ["/a", "/b"])
        batch.markReady(path: "/a")
        batch.markReady(path: "/b")
        XCTAssertEqual(batch.autoLandingPath, "/a")
    }

    func testBatchPartialFailureDoesNotLand() {
        var batch = SessionSetupBatch(paths: ["/a", "/b"])
        batch.markFailed(path: "/a", message: "boom")
        batch.markReady(path: "/b")
        XCTAssertNil(batch.autoLandingPath)
        XCTAssertTrue(batch.hasFailures)
        // "Done" lands on the first success.
        XCTAssertEqual(batch.doneLandingPath, "/b")
        var none = SessionSetupBatch(paths: ["/a"])
        none.markFailed(path: "/a", message: "boom")
        XCTAssertNil(none.doneLandingPath)
    }

    func testRetryRequeuesOnlyAFailedRow() {
        var batch = SessionSetupBatch(paths: ["/a/api", "/b/api"])
        batch.markFailed(path: "/b/api", message: "boom")
        batch.requeue(path: "/b/api")
        XCTAssertEqual(batch.rows[1].phase, .queued)
        XCTAssertNil(batch.rows[1].error)
        batch.markReady(path: "/a/api")
        batch.requeue(path: "/a/api")
        XCTAssertEqual(batch.rows[0].phase, .ready)
    }

    func testProbeDecodesLeniently() throws {
        let result = try decode(ForgeProbeResult.self, """
        {"repos":[{"path":"/a/x","name":"x","branch":null,"originUrl":null,"lastCommitAt":1730000000000},{"nope":1}],
         "cli":{"installed":true,"authenticated":true,"login":"octo"},"partial":true,"homeDir":"/home/u"}
        """)
        XCTAssertEqual(result.repos.map(\.path), ["/a/x"])
        XCTAssertEqual(result.repos.first?.lastCommitAt, 1_730_000_000_000)
        XCTAssertEqual(result.cli.login, "octo")
        XCTAssertTrue(result.partial)
        XCTAssertEqual(result.homeDir, "/home/u")
    }
}

// MARK: - Close

final class SessionCloseLogicTests: XCTestCase {
    // The confirm copy, the worktree orchestration, the notices and the sentences are the BOX's (WS11 D6; pinned in
    // sessionClose.test.mjs). The phone decodes and shows them.

    func testPreviewDecodesTheBoxsWords() throws {
        let json = #"{"title":"Close “p” and its 2 sessions?","body":"All 2 tmux windows will be killed on the server.","confirmLabel":"Close project","runningCount":1,"worktrees":[{"path":"/wt/a","willRemove":true}]}"#
        let p = try JSONDecoder().decode(SessionClosePreview.self, from: Data(json.utf8))
        XCTAssertEqual(p.confirm, SessionCloseConfirm(title: "Close “p” and its 2 sessions?", body: "All 2 tmux windows will be killed on the server.", destructiveTitle: "Close project"))
        XCTAssertEqual(p.runningCount, 1)
        XCTAssertEqual(p.worktrees, [SessionClosePreview.Worktree(path: "/wt/a", willRemove: true)])
    }

    func testResultDecodesSuccessWithFailuresAndWarnings() throws {
        let json = #"{"ok":true,"removed":["/a"],"kept":["/b"],"failed":[{"path":"/c","message":"Couldn't remove the worktree at /c — it was left in place."}],"warnings":["Couldn't remove the worktree at /c — it was left in place.","The project was closed, but its saved folder setting couldn't be cleared."],"notice":"Kept worktree at /b — it has uncommitted changes."}"#
        let r = try JSONDecoder().decode(SessionCloseResult.self, from: Data(json.utf8))
        XCTAssertTrue(r.ok)
        XCTAssertEqual(r.kept, ["/b"])
        XCTAssertEqual(r.failed.map(\.path), ["/c"])
        XCTAssertEqual(r.warnings.count, 2)
        XCTAssertEqual(r.notice, "Kept worktree at /b — it has uncommitted changes.")
    }

    func testResultDecodesTheDirtyQuestionAndASentenceFailure() throws {
        let ask = #"{"ok":false,"needsConfirm":{"kind":"worktree-dirty","path":"/wt","title":"Uncommitted changes in this worktree","body":"/wt has uncommitted changes. Removing the worktree will permanently delete that work.","removeLabel":"Remove worktree","keepLabel":"Keep worktree"}}"#
        let r = try JSONDecoder().decode(SessionCloseResult.self, from: Data(ask.utf8))
        XCTAssertFalse(r.ok)
        XCTAssertEqual(r.needsConfirm?.path, "/wt")
        XCTAssertEqual(r.needsConfirm?.keepLabel, "Keep worktree")
        let bad = try JSONDecoder().decode(SessionCloseResult.self, from: Data(#"{"ok":false,"error":"Couldn't close it — the server couldn't stop it."}"#.utf8))
        XCTAssertEqual(bad.error, "Couldn't close it — the server couldn't stop it.")
        XCTAssertNil(bad.needsConfirm)
    }

    func testChoiceMapsToTheWireValue() {
        XCTAssertNil(SessionCloseChoice.none.wire)
        XCTAssertEqual(SessionCloseChoice.keep.wire, "keep")
        XCTAssertEqual(SessionCloseChoice.remove.wire, "remove")
    }

    // MARK: prompt queue

    private func prompt(_ key: String) -> SessionWorktreePrompt {
        SessionWorktreePrompt(key: key, project: "p", index: 0, windowName: "w", worktreePath: "/wt/\(key)",
                              ask: SessionCloseAsk(path: "/wt/\(key)", title: "t", body: "b", removeLabel: "Remove worktree", keepLabel: "Keep worktree"))
    }

    func testTwoPromptsQueuedInOrder() {
        var q: [SessionWorktreePrompt] = []
        q = SessionWorktreePromptQueue.append(prompt("p#0"), to: q)
        q = SessionWorktreePromptQueue.append(prompt("p#1"), to: q)
        XCTAssertEqual(q.map(\.key), ["p#0", "p#1"])
    }

    func testSameKeyNotDuplicated() {
        var q = SessionWorktreePromptQueue.append(prompt("p#0"), to: [])
        q = SessionWorktreePromptQueue.append(prompt("p#0"), to: q)
        XCTAssertEqual(q.count, 1)
    }

    func testResolveRemovesOnlyThatKey() {
        let q = [prompt("p#0"), prompt("p#1"), prompt("p#2")]
        XCTAssertEqual(SessionWorktreePromptQueue.resolve(key: "p#1", in: q).map(\.key), ["p#0", "p#2"])
        XCTAssertEqual(SessionWorktreePromptQueue.resolve(key: "missing", in: q).count, 3)
    }

    func testRequestKeyMatchesTheRowKey() {
        XCTAssertEqual(SessionCloseRequest(project: "a#b", index: 3).key, "a#b#3")
        XCTAssertEqual(SessionRouteLogic.windowKey(project: "a#b", windowIndex: 3), "a#b#3")
    }
}

// MARK: - Row status (subagents, halted)

final class SessionRowStatusTests: XCTestCase {
    private func status(running: Bool = false, attention: Bool = false, jobs: Int = 0, subagents: Int = 0,
                        halted: Bool = false, terminal: Bool = false, model: String? = nil) -> SessionRowStatus {
        SessionRowStatus(running: running, attention: attention, backgroundJobs: jobs, modelLabel: model,
                         isTerminal: terminal, runningSubagents: subagents, halted: halted)
    }

    private func sub(_ status: String?) -> StreamSubagentPayload {
        StreamSubagentPayload(childSessionId: UUID().uuidString, status: status)
    }

    func testSubtitleSubagentsReplaceEverythingButJobs() {
        XCTAssertEqual(SessionRowSubtitle.text(for: status(running: true, subagents: 3, model: "opus 4.8")), "3 subagents")
    }

    func testSubtitleOneSubagentSingular() {
        XCTAssertEqual(SessionRowSubtitle.text(for: status(running: true, subagents: 1)), "1 subagent")
    }

    func testSubtitleJobsBeatSubagents() {
        XCTAssertEqual(SessionRowSubtitle.text(for: status(running: true, jobs: 2, subagents: 3)), "2 background jobs")
    }

    func testSubagentCountIgnoresCompletedAndError() {
        let list = [sub("running"), sub("completed"), sub("error"), sub(nil)]
        XCTAssertEqual(SessionSubagentCount.running(list, parentRunning: true), 1)
    }

    func testSubagentCountZeroWhenParentNotRunning() {
        // A missed finish frame must not leave "2 subagents" on an idle row.
        XCTAssertEqual(SessionSubagentCount.running([sub("running"), sub("running")], parentRunning: false), 0)
    }

    func testSubagentCountCountsPending() {
        XCTAssertEqual(SessionSubagentCount.running([sub("pending"), sub("running")], parentRunning: true), 2)
    }

    func testHaltedSubtitleWhenIdle() {
        XCTAssertEqual(SessionRowSubtitle.text(for: status(halted: true, model: "opus 4.8")), "stopped by a provider limit")
    }

    func testAttentionOutranksHalted() {
        let s = status(attention: true, halted: true)
        XCTAssertEqual(SessionRowSubtitle.text(for: s), "needs you")
        XCTAssertEqual(SessionDotState.forRow(s), .needsYou)
    }

    func testRunningOutranksHalted() {
        let s = status(running: true, halted: true)
        XCTAssertEqual(SessionRowSubtitle.text(for: s), "running")
        XCTAssertEqual(SessionDotState.forRow(s), .running)
    }

    func testDotHalted() {
        XCTAssertEqual(SessionDotState.forRow(status(halted: true)), .halted)
        XCTAssertEqual(SessionDotState.forRow(status()), .idle)
    }

    func testTerminalHaltedBeatsTerminalLabel() {
        XCTAssertEqual(SessionRowSubtitle.text(for: status(halted: true, terminal: true)), "stopped by a provider limit")
        XCTAssertEqual(SessionRowSubtitle.text(for: status(terminal: true)), "terminal")
    }

    // MARK: stopped records

    func testStoppedListDecodesAndIgnoresUnknownFields() throws {
        let list = try decode(SessionStoppedList.self, """
        {"records":[{"workspace":"w","conversation":"ses_1","provider":"claude","model":"opus","window":"weekly",
                     "stoppedAt":1730000100000,"cachedTokens":1200,"armed":true,"attempts":2,"future":"x"},
                    {"workspace":"w","conversation":"ses_2","provider":"codex","window":null,"stoppedAt":1730000200000},
                    {"broken":true}],
         "lastLooked":1730000000000}
        """)
        XCTAssertEqual(list.records.map(\.conversation), ["ses_1", "ses_2"])
        XCTAssertEqual(list.records[0].window, "weekly")
        XCTAssertNil(list.records[1].window)
        XCTAssertEqual(list.records[0].attempts, 2)
    }

    func testUnarmedCountIgnoresArmed() throws {
        let list = try decode(SessionStoppedList.self, """
        {"records":[{"conversation":"a","stoppedAt":1,"armed":true},{"conversation":"b","stoppedAt":2},{"conversation":"c","stoppedAt":3,"armed":false}],"lastLooked":null}
        """)
        XCTAssertEqual(list.records.filter { $0.armed != true }.count, 2)
    }

    func testLastLookedDecodesAsEpochMillis() throws {
        XCTAssertEqual(try decode(SessionStoppedList.self, #"{"records":[],"lastLooked":1730000000000}"#).lastLooked, 1_730_000_000_000.0)
        XCTAssertNil(try decode(SessionStoppedList.self, #"{"records":[],"lastLooked":null}"#).lastLooked)
    }

    func testStoppedAtComparesWithLastLooked() throws {
        let list = try decode(SessionStoppedList.self, """
        {"records":[{"conversation":"a","stoppedAt":1730000100000}],"lastLooked":1730000000000}
        """)
        let looked = try XCTUnwrap(list.lastLooked)
        XCTAssertGreaterThan(list.records[0].stoppedAt, looked)
    }
}

// MARK: - Switcher

final class SessionSwitcherLogicTests: XCTestCase {
    private func cand(_ project: String, _ index: Int, _ name: String) -> SessionSwitcherCandidate {
        SessionSwitcherCandidate(key: SessionRouteLogic.windowKey(project: project, windowIndex: index),
                                 project: project, windowIndex: index, name: name)
    }

    func testScoreContiguousBeatsSubsequence() {
        let contiguous = SessionSwitcher.score(query: "api", session: "api-server", workspace: "x")
        let subsequence = SessionSwitcher.score(query: "asr", session: "api-server", workspace: "x")
        XCTAssertGreaterThan(contiguous, subsequence)
        XCTAssertGreaterThan(subsequence, 0)
    }

    func testScoreEarlierMatchHigher() {
        XCTAssertGreaterThan(SessionSwitcher.score(query: "web", session: "web", workspace: "p"),
                             SessionSwitcher.score(query: "web", session: "my-web", workspace: "p"))
        XCTAssertEqual(SessionSwitcher.score(query: "web", session: "web", workspace: "p"), 1000)
    }

    func testScoreSubsequenceAdjacencyBonus() {
        // "ab" is non-contiguous in both; the second has two adjacent hits.
        let loose = SessionSwitcher.score(query: "abc", session: "a-b-c", workspace: "")
        let tight = SessionSwitcher.score(query: "abd", session: "ab-d", workspace: "")
        XCTAssertEqual(loose, 100)
        XCTAssertEqual(tight, 110)
    }

    func testScoreNoMatchIsZero() {
        XCTAssertEqual(SessionSwitcher.score(query: "zzz", session: "api", workspace: "web"), 0)
    }

    func testScoreMatchesWorkspaceName() {
        XCTAssertGreaterThan(SessionSwitcher.score(query: "ethernal", session: "dev", workspace: "ethernal"), 0)
        XCTAssertEqual(SessionSwitcher.score(query: "", session: "a", workspace: "b"), 1)
    }

    func testEmptyQueryOrdersByRecencyThenListOrder() {
        let all = [cand("p", 0, "a"), cand("p", 1, "b"), cand("q", 0, "c"), cand("q", 1, "d")]
        let out = SessionSwitcher.results(candidates: all, query: "", recents: ["q#1", "p#0"])
        XCTAssertEqual(out.map(\.key), ["q#1", "p#0", "p#1", "q#0"])
    }

    func testResultsExcludeZeroScores() {
        let all = [cand("p", 0, "alpha"), cand("p", 1, "beta")]
        XCTAssertEqual(SessionSwitcher.results(candidates: all, query: "alp", recents: []).map(\.name), ["alpha"])
        XCTAssertEqual(SessionSwitcher.results(candidates: all, query: "zzz", recents: []), [])
    }

    func testResultsRankBestFirst() {
        let all = [cand("p", 0, "my-api"), cand("p", 1, "api")]
        XCTAssertEqual(SessionSwitcher.results(candidates: all, query: "api", recents: []).map(\.name), ["api", "my-api"])
    }

    func testRecentsPushDedupesAndCaps64() {
        var list: [String] = []
        for i in 0..<70 { list = SessionRecents.push("p#\(i)", into: list) }
        XCTAssertEqual(list.count, 64)
        XCTAssertEqual(list.first, "p#69")
        list = SessionRecents.push("p#40", into: list)
        XCTAssertEqual(list.first, "p#40")
        XCTAssertEqual(list.filter { $0 == "p#40" }.count, 1)
        XCTAssertEqual(list.count, 64)
    }
}

// MARK: - C2 route resolution

final class SessionRouteLogicTests: XCTestCase {
    private let projects = [
        project("a#b", "", [window(3, "x", sid: "ses_x")]),
        project("web", "", [window(0, "main", sid: "ses_m"), window(1, "term")]),
    ]

    func testParseWindowKeyHandlesHashInProjectName() {
        let parsed = SessionRouteLogic.parse(windowKey: "a#b#3")
        XCTAssertEqual(parsed?.project, "a#b")
        XCTAssertEqual(parsed?.windowIndex, 3)
    }

    func testParseRejectsNonNumericIndex() {
        XCTAssertNil(SessionRouteLogic.parse(windowKey: "web#x"))
        XCTAssertNil(SessionRouteLogic.parse(windowKey: "web"))
        XCTAssertNil(SessionRouteLogic.parse(windowKey: "#3"))
        XCTAssertNil(SessionRouteLogic.parse(windowKey: "web#-1"))
    }

    func testWindowKeyRoundTrip() {
        let key = SessionRouteLogic.windowKey(project: "a#b", windowIndex: 3)
        let parsed = SessionRouteLogic.parse(windowKey: key)
        XCTAssertEqual(parsed?.project, "a#b")
        XCTAssertEqual(parsed?.windowIndex, 3)
    }

    func testResolveWindowByKey() {
        let t = SessionRouteLogic.window(forKey: "a#b#3", in: projects)
        XCTAssertEqual(t, SessionRouteTarget(project: "a#b", windowIndex: 3, name: "x", sessionId: "ses_x"))
        // A terminal window has no session id.
        XCTAssertNil(SessionRouteLogic.window(forKey: "web#1", in: projects)?.sessionId)
    }

    func testResolveMissingWindowIsNil() {
        XCTAssertNil(SessionRouteLogic.window(forKey: "web#9", in: projects))
        XCTAssertNil(SessionRouteLogic.window(forKey: "nope#0", in: projects))
    }

    func testResolveByOpencodeSessionID() {
        XCTAssertEqual(SessionRouteLogic.window(forSessionID: "ses_m", in: projects)?.windowIndex, 0)
        XCTAssertEqual(SessionRouteLogic.window(forSessionID: "ses_m", in: projects)?.project, "web")
        XCTAssertNil(SessionRouteLogic.window(forSessionID: "ses_none", in: projects))
        XCTAssertNil(SessionRouteLogic.window(forSessionID: "", in: projects))
    }
}

// MARK: - Wire shapes

final class SessionWireTests: XCTestCase {
    func testDirListingDecodesObjectAndFiltersHidden() throws {
        // B1: the reply is an object, never `[String]`.
        let listing = try decode(SessionDirListing.self, """
        {"dir":"/home/u","entries":[{"name":".cache","path":"/home/u/.cache","hidden":true},
                                    {"name":"code","path":"/home/u/code","hidden":false}]}
        """)
        XCTAssertEqual(listing.dir, "/home/u")
        XCTAssertEqual(listing.visibleEntries.map(\.path), ["/home/u/code"])
        XCTAssertThrowsError(try decode([String].self, #"{"dir":"/a","entries":[]}"#))
    }

    func testDirListingMissingEntriesIsEmpty() throws {
        XCTAssertEqual(try decode(SessionDirListing.self, #"{"dir":"/a"}"#).entries, [])
    }

    func testCreateResultCarriesTheWindowIdentity() throws {
        // B2: the box names the window it created.
        let json = """
        {"sessionId":"ses_new","windowIndex":4,"projects":[{"tmuxSession":"p","defaultCwd":"/p","windows":[],"attached":false}]}
        """
        let result = try decode(TmuxCreateResult.self, json)
        XCTAssertEqual(result.sessionId, "ses_new")
        XCTAssertEqual(result.windowIndex, 4)
        XCTAssertEqual(result.projects.count, 1)
    }

    func testCreateResultLegacyBareArray() throws {
        let result = try decode(TmuxCreateResult.self, #"[{"tmuxSession":"p","defaultCwd":"/p","windows":[],"attached":false}]"#)
        XCTAssertNil(result.sessionId)
        XCTAssertNil(result.windowIndex)
        XCTAssertEqual(result.projects.count, 1)
    }

    func testWorktreeAddedShape() throws {
        XCTAssertEqual(try decode(SessionWorktreeAdded.self, #"{"path":"/r-wt","branch":"worktree-2"}"#).branch, "worktree-2")
    }

    func testDeviceStartDecodesAllThreeShapes() throws {
        let connected = try decode(GitHubDeviceStart.self, #"{"connected":true,"grant":null}"#)
        XCTAssertTrue(connected.connected)
        XCTAssertNil(connected.grant)
        let notConfigured = try decode(GitHubDeviceStart.self, #"{"connected":false,"notConfigured":true,"grant":null}"#)
        XCTAssertTrue(notConfigured.notConfigured)
        let grant = try decode(GitHubDeviceStart.self, """
        {"connected":false,"grant":{"grantId":"g1","userCode":"AB12-CD34","verificationUri":"https://github.com/login/device","expiresIn":900,"pollInterval":5},"error":null}
        """)
        XCTAssertEqual(grant.grant?.userCode, "AB12-CD34")
        XCTAssertEqual(grant.grant?.expiresIn, 900)
        XCTAssertFalse(grant.connected)
    }

    func testDevicePollDecodesAllFourShapes() throws {
        XCTAssertEqual(try decode(GitHubDevicePoll.self, #"{"status":"pending","pollInterval":10}"#).kind, .pending)
        XCTAssertEqual(try decode(GitHubDevicePoll.self, #"{"status":"pending","pollInterval":10}"#).pollInterval, 10)
        XCTAssertEqual(try decode(GitHubDevicePoll.self, #"{"status":"done"}"#).kind, .done)
        XCTAssertEqual(try decode(GitHubDevicePoll.self, #"{"status":"expired"}"#).kind, .expired)
        let error = try decode(GitHubDevicePoll.self, #"{"status":"error","error":"nope"}"#)
        XCTAssertEqual(error.kind, .error)
        XCTAssertEqual(error.error, "nope")
        XCTAssertEqual(try decode(GitHubDevicePoll.self, #"{"status":"weird"}"#).kind, .unknown("weird"))
    }

    func testNewInputsAreValueTypes() {
        let w = SessionNewWindowInput(sessionName: "p", windowName: "w", cwd: nil, chatMode: true)
        XCTAssertNil(w.worktreePath)
    }
}
