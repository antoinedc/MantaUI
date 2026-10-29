import Foundation

// ===========================================================================
// WS04 — the RPC members behind session creation, closing, the repository scan,
// GitHub clone and the stopped-conversation list (C1: this area's members live
// in their own file; nobody else edits `MantaAPIClient.swift`).
//
// Every one reuses the channel the desktop calls over `/rpc`, so the two clients
// cannot disagree about what an action does. A channel whose answer is never
// legitimately absent goes through `callRequired`: a box that did not answer is
// an error the screen reports, never an empty result shown as a success.
// ===========================================================================

extension MantaAPIClient {

    // MARK: - Create / rename / close

    /// `tmux:new-session` — a new project with its first window. The reply names
    /// the created window (B2): use `windowIndex` before falling back to a name.
    func createSession(_ input: SessionNewProjectInput) async throws -> TmuxCreateResult {
        var dict: [String: Any] = [
            "cwd": input.cwd,
            "windowName": input.windowName,
            "createDir": input.createDir,
            "chatMode": input.chatMode,
        ]
        if let name = input.name, !name.isEmpty { dict["name"] = name }
        if let hint = input.nameHint, !hint.isEmpty { dict["nameHint"] = hint }
        return try await callRequired("tmux:new-session", args: [dict], as: TmuxCreateResult.self)
    }

    /// `sessions:propose-name` — preview the name a create would pick (the create re-checks).
    /// `project`: from a folder/hint against the live sessions; `scratch`: the folder slug under `root`.
    func sessionsProposeName(project cwd: String) async throws -> SessionNameProposal {
        try await callRequired("sessions:propose-name", args: [["kind": "project", "cwd": cwd]], as: SessionNameProposal.self)
    }

    func sessionsProposeName(scratch hint: String, root: String) async throws -> SessionNameProposal {
        try await callRequired("sessions:propose-name", args: [["kind": "scratch", "hint": hint, "root": root]], as: SessionNameProposal.self)
    }

    /// `tmux:new-window` — a new session in an existing project. `worktreePath`
    /// stamps the window so clean-on-close can find the worktree later.
    func createWindow(_ input: SessionNewWindowInput) async throws -> TmuxCreateResult {
        var dict: [String: Any] = [
            "sessionName": input.sessionName,
            "windowName": input.windowName,
            "chatMode": input.chatMode,
        ]
        if let cwd = input.cwd, !cwd.isEmpty { dict["cwd"] = cwd }
        if let worktreePath = input.worktreePath, !worktreePath.isEmpty { dict["worktreePath"] = worktreePath }
        return try await callRequired("tmux:new-window", args: [dict], as: TmuxCreateResult.self)
    }

    /// `tmux:rename-session` — rename a project (the whole group).
    func tmuxRenameSession(oldName: String, newName: String) async throws {
        _ = try await callVoid("tmux:rename-session", args: [["oldName": oldName, "newName": newName]])
    }

    /// `tmux:kill-session` — close a whole project.
    func tmuxKillSession(_ name: String) async throws {
        _ = try await callVoid("tmux:kill-session", args: [name])
    }

    /// `project:meta:delete` — forget the project's stored defaults.
    func projectMetaDelete(_ tmuxSession: String) async throws {
        _ = try await callVoid("project:meta:delete", args: [tmuxSession])
    }

    // MARK: - git / fs

    /// `git:add-worktree` — cut a fresh worktree (and branch) next to the repo.
    /// Throws with git's own message when it can't.
    func gitAddWorktree(cwd: String, name: String) async throws -> SessionWorktreeAdded {
        try await callRequired("git:add-worktree", args: [["cwd": cwd, "name": name]], as: SessionWorktreeAdded.self)
    }

    /// `git:remove-worktree` — safe-first removal. A dirty checkout answers
    /// `{removed:false, reason:"dirty"}`; any other failure throws.
    func gitRemoveWorktree(path: String, force: Bool) async throws -> SessionWorktreeRemoval {
        try await callRequired("git:remove-worktree", args: [["path": path, "force": force]], as: SessionWorktreeRemoval.self)
    }

    /// `fs:list-dirs` — the sub-folders of `dir`: `{dir, entries:[{name,path,hidden}]}`.
    /// (The older `listDirs` decoded this as `[String]` and could never succeed.)
    func fsListDirectory(_ dir: String) async throws -> SessionDirListing {
        try await callRequired("fs:list-dirs", args: [dir], as: SessionDirListing.self)
    }

    /// `project:create-scratch` — an empty, git-initialised folder under `root`.
    func projectCreateScratch(root: String, name: String) async throws -> SessionScratchProject {
        try await callRequired("project:create-scratch", args: [["root": root, "name": name]], as: SessionScratchProject.self)
    }

    // MARK: - forge

    /// `forge:probe` — repositories on the box plus the `gh` CLI state.
    func forgeProbe() async throws -> ForgeProbeResult {
        try await callRequired("forge:probe", args: [], as: ForgeProbeResult.self)
    }

    /// `forge:device-start` — begin (or skip, when already connected) the GitHub
    /// device sign-in.
    func forgeDeviceStart() async throws -> GitHubDeviceStart {
        try await callRequired("forge:device-start", args: [], as: GitHubDeviceStart.self)
    }

    /// `forge:device-poll` — one poll of an outstanding grant.
    func forgeDevicePoll(grantId: String) async throws -> GitHubDevicePoll {
        try await callRequired("forge:device-poll", args: [["grantId": grantId]], as: GitHubDevicePoll.self)
    }

    /// `forge:device-cancel` — drop an outstanding grant (a no-op for an
    /// unknown one). Awaited by the store; the live adapter logs a failure.
    func forgeDeviceCancel(grantId: String) async throws {
        _ = try await callVoid("forge:device-cancel", args: [["grantId": grantId]])
    }

    /// `forge:repos` — the repositories the connected user can push to.
    func forgeRepos() async throws -> GitHubRepoList {
        try await callRequired("forge:repos", args: [], as: GitHubRepoList.self)
    }

    /// `forge:clone-start` — start a clone on the box. The destination is
    /// preflighted server-side; a refusal comes back as `{error, message}`.
    func forgeCloneStart(url: String, root: String, name: String) async throws -> CloneStartResult {
        // The box joins `<root>/<name>` itself and reports it as the status's `dest` (WS11 D5 / S8).
        try await callRequired("forge:clone-start", args: [["url": url, "root": root, "name": name]], as: CloneStartResult.self)
    }

    /// `forge:clone-status` — the job snapshot, or nil once the box forgot it.
    func forgeCloneStatus(id: String) async throws -> CloneJobStatus? {
        try await call("forge:clone-status", args: [["id": id]], as: CloneJobStatus.self)
    }

    /// `forge:clone-cancel` — stop a clone on the box.
    func forgeCloneCancel(id: String) async throws {
        _ = try await callVoid("forge:clone-cancel", args: [["id": id]])
    }

    // MARK: - Stopped conversations (D16: the single source on iOS)

    /// `usage-stopped:list` — `{records, lastLooked}`. A box that predates the
    /// channel answers with an error; the store treats that as "none".
    func usageStoppedList() async throws -> SessionStoppedList {
        try await callRequired("usage-stopped:list", args: [], as: SessionStoppedList.self)
    }
}
