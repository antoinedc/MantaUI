import SwiftUI

// ===========================================================================
// S3 — create-session sheet (BET-595 §create).
//
// The `+` on the session list opens THIS. It used to be handed a fixed mode
// (either "new project" or "new session in whatever project happened to be
// first"), so there was no way to choose which project a session belonged to.
// Now the project is a choice inside the sheet — any existing project, or a
// new one — and the session name is optional.
//
// Deliberately built from STOCK SwiftUI (NavigationStack + Form + Picker +
// toolbar Cancel/Create): this is a system-shaped data-entry screen, and the
// platform's own components carry the keyboard handling, grouped styling,
// dynamic type and accessibility for free. The bespoke token-styled fields it
// replaced did none of that.
// ===========================================================================

struct SessionCreateSheet: View {
    /// Existing projects, so the picker can offer them.
    let projects: [MantaProject]
    /// Pre-selected project (the one the user was looking at), if any.
    let initialProject: String?
    let onClose: () -> Void
    let onCreated: (String, Int) -> Void

    /// Where the new session goes: an existing project, or a brand new one.
    private enum Target: Hashable {
        case existing(String)
        case newProject
    }

    @State private var target: Target = .newProject
    @State private var newProjectName = ""
    @State private var cwd = "~"
    @State private var sessionName = ""
    @State private var detectedWorktrees: [MantaWorktree]?
    @State private var creating = false
    @State private var error: String?
    @State private var folderPickerOpen = false

    private let api = MantaAPIClient.live()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Project", selection: $target) {
                        ForEach(projects, id: \.tmuxSession) { project in
                            Text(project.tmuxSession).tag(Target.existing(project.tmuxSession))
                        }
                        Text("New project…").tag(Target.newProject)
                    }
                }

                if target == .newProject {
                    Section("New project") {
                        TextField("Name", text: $newProjectName)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                        Button {
                            folderPickerOpen = true
                        } label: {
                            LabeledContent("Folder") {
                                Text(cwd)
                                    .font(.system(.body, design: .monospaced))
                                    .lineLimit(1)
                                    .truncationMode(.head)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    if let worktrees = detectedWorktrees, worktrees.count > 1 {
                        Section("Git worktrees") {
                            Text("\(worktrees.count) worktrees found — one session will be opened for each.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            ForEach(worktrees, id: \.path) { worktree in
                                Text(WorktreeInfoLogic.name(worktree))
                                    .font(.system(.footnote, design: .monospaced))
                            }
                        }
                    }
                }

                Section {
                    TextField("Session name", text: $sessionName, prompt: Text("Optional"))
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } footer: {
                    Text("Leave empty and the session is named for you.")
                }

                if let error {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onClose)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create", action: create)
                        .disabled(!formValid || creating)
                }
            }
            .disabled(creating)
            .overlay {
                if creating { ProgressView().controlSize(.large) }
            }
        }
        .onAppear(perform: selectInitialTarget)
        .sheet(isPresented: $folderPickerOpen) {
            FolderPickerView(
                initialPath: cwd,
                onSelect: { path in
                    cwd = path
                    folderPickerOpen = false
                },
                onFanOut: { base, worktrees in
                    cwd = base
                    detectedWorktrees = worktrees
                    folderPickerOpen = false
                },
                onCancel: { folderPickerOpen = false }
            )
        }
    }

    private func selectInitialTarget() {
        if let initialProject, projects.contains(where: { $0.tmuxSession == initialProject }) {
            target = .existing(initialProject)
        } else if let first = projects.first {
            target = .existing(first.tmuxSession)
        } else {
            target = .newProject
        }
    }

    private var formValid: Bool {
        switch target {
        case .existing: return true
        case .newProject: return !newProjectName.trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    // MARK: - Create
    //
    // The session is created for real here (tmux window + opencode session);
    // the caller pushes it, and the user types their first message in the
    // session itself rather than in this sheet.

    private func create() {
        guard !creating, formValid else { return }
        creating = true
        error = nil
        Task {
            do {
                switch target {
                case .existing(let project):
                    try await createWindow(in: project)
                case .newProject:
                    try await createProject()
                }
            } catch {
                await MainActor.run {
                    self.error = "Couldn't create the session"
                    self.creating = false
                }
            }
        }
    }

    private var resolvedSessionName: String {
        let trimmed = sessionName.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? "session" : trimmed
    }

    private func createWindow(in project: String) async throws {
        let windowName = resolvedSessionName
        let projects = try await api.newWindow(NewWindowInput(
            sessionName: project, windowName: windowName, cwd: nil, chatMode: true))
        guard let proj = projects.first(where: { $0.tmuxSession == project }),
              let window = proj.windows.first(where: { $0.name == windowName }) ?? proj.windows.last else {
            throw MantaError.transport("created session was not returned")
        }
        await MainActor.run {
            creating = false
            onCreated(project, window.index)
        }
    }

    private func createProject() async throws {
        let projectName = newProjectName.trimmingCharacters(in: .whitespaces)
        let dir = cwd.trimmingCharacters(in: .whitespaces)
        var windowIndex = 0

        if let worktrees = detectedWorktrees, worktrees.count > 1 {
            // Fan out: the first worktree is the project's initial window, the
            // rest are added alongside it.
            var projects = try await api.newSession(NewSessionInput(
                name: projectName, cwd: worktrees[0].path,
                windowName: WorktreeInfoLogic.name(worktrees[0]),
                createDir: false, chatMode: true))
            for worktree in worktrees.dropFirst() {
                projects = try await api.newWindow(NewWindowInput(
                    sessionName: projectName, windowName: WorktreeInfoLogic.name(worktree),
                    cwd: worktree.path, chatMode: true))
            }
            windowIndex = Self.findInitialWindow(projects, projectName: projectName, cwd: worktrees[0].path)?.index ?? 0
        } else {
            let windowName = resolvedSessionName
            let projects = try await api.newSession(NewSessionInput(
                name: projectName, cwd: dir, windowName: windowName,
                createDir: true, chatMode: true))
            guard let proj = projects.first(where: { $0.tmuxSession == projectName }),
                  let window = proj.windows.first(where: { $0.name == windowName }) ?? proj.windows.first else {
                throw MantaError.transport("created project was not returned")
            }
            windowIndex = window.index
        }

        await MainActor.run {
            creating = false
            onCreated(projectName, windowIndex)
        }
    }

    /// The initial (first-worktree) window after a fan-out create.
    private static func findInitialWindow(_ projects: [MantaProject], projectName: String, cwd: String) -> MantaWindow? {
        guard let proj = projects.first(where: { $0.tmuxSession == projectName }) else { return nil }
        if let exact = proj.windows.first(where: { $0.paneCurrentPath == cwd }) { return exact }
        return proj.windows.min(by: { $0.index < $1.index })
    }
}
