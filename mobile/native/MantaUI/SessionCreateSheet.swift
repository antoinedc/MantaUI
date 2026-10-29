import SwiftUI

// ===========================================================================
// S3 — create-session sheet (BET-595 §create), restructured by WS04 (§3–§5, §12).
//
// The `+` on the session list opens THIS. The project is a choice inside the
// sheet — any existing project, or a new one — and the session name is optional.
//
// Existing project: Session (name · folder · open as) and, when the folder is a
// git repository, "Create in a fresh git worktree" + an editable branch name.
//
// New project: first the repository scan (check what to set up, or Browse /
// Clone from GitHub / Start from scratch); once a source is picked, the same
// session + worktree sections, or the scratch name + location.
//
// A "new session from this" draft (D2) prefills the folder, the worktree and the
// carried-over text; nothing is created until the user taps Create.
//
// Deliberately built from STOCK SwiftUI (NavigationStack + Form + Picker +
// toolbar Cancel/Create): the platform's own components carry the keyboard
// handling, grouped styling, dynamic type and accessibility for free.
//
// The decisions (what the confirm button says and does, where a draft lands, how
// names are made unique) are the pure logic in `SessionCreateLogic.swift`.
// ===========================================================================

struct SessionCreateSheet: View {
    @ObservedObject var store: SessionListStore
    /// Pre-selected project (the one the user was looking at), if any.
    let initialProject: String?
    /// A "start a session with this" request (D2). Nothing is created for it
    /// until Create is tapped.
    let draft: NewSessionDraft?
    /// Open straight into "New project" (the empty list's "Get started").
    let startWithNewProject: Bool
    let onClose: () -> Void
    /// The created session. The box's FRESH project list rides along: every
    /// create RPC already returns it, and resolving the brand-new window against
    /// a list that predates it opened the session nameless and without its
    /// opencode session id.
    let onCreated: (SessionCreated) -> Void

    init(
        store: SessionListStore,
        initialProject: String?,
        draft: NewSessionDraft? = nil,
        startWithNewProject: Bool = false,
        onClose: @escaping () -> Void,
        onCreated: @escaping (SessionCreated) -> Void
    ) {
        self.store = store
        self.initialProject = initialProject
        self.draft = draft
        self.startWithNewProject = startWithNewProject
        self.onClose = onClose
        self.onCreated = onCreated
    }

    /// Where the new session goes: an existing project, or a brand new one.
    private enum Target: Hashable {
        case existing(String)
        case newProject
    }

    private enum PickerTarget: String, Identifiable {
        case folder, scratchRoot
        var id: String { rawValue }
    }

    private enum GitProbe: Equatable {
        case idle, checking, repo, notRepo, failed
    }

    @State private var target: Target = .newProject
    @State private var source: SessionCreateForm.Source = .none
    @State private var newProjectName = ""
    @State private var nameEdited = false
    @State private var folder = ""
    @State private var sessionName = ""
    @State private var openAs: SessionMode = .chat
    @State private var scratchName = ""
    @State private var scratchRoot = ""
    /// The box's preview of the scratch folder name and its one hint (`sessions:propose-name`).
    @State private var scratchProposal: SessionNameProposal?
    @State private var gitProbe: GitProbe = .idle
    @State private var worktreeOn = false
    @State private var worktreeBranch = SessionWorktreeDefaults.branch
    @State private var worktreeTouched = false
    @State private var boxWorktreeDefault = false
    @State private var fanOut: [MantaWorktree]?
    @State private var linkedIssueURL: String?
    @State private var carriedDraft: NewSessionDraft?
    @State private var dropCarryOver = false
    @State private var didSetup = false
    @State private var creating = false
    @State private var error: String?
    @State private var pickerTarget: PickerTarget?
    @State private var cloneOpen = false

    @StateObject private var setup = SessionSetupStore()
    @EnvironmentObject private var capabilities: BoxCapabilitiesStore
    @Environment(\.openURL) private var openURL

    private let api = MantaAPIClient.live()

    // MARK: - Derived

    private var existingProject: MantaProject? {
        if case .existing(let name) = target { return store.projects.first { $0.tmuxSession == name } }
        return nil
    }

    private var form: SessionCreateForm {
        var f = SessionCreateForm()
        switch target {
        case .existing: f.target = .existing
        case .newProject: f.target = .newProject
        }
        f.source = source
        f.newProjectName = newProjectName
        f.folder = folder
        f.scratchName = scratchName
        f.scratchRoot = scratchRoot
        f.scratchUsable = scratchProposal.map { !$0.name.isEmpty } ?? !scratchName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        f.nameEdited = nameEdited
        f.worktreeAvailable = gitProbe == .repo
        f.worktreeOn = worktreeOn
        f.worktreeBranch = worktreeBranch
        f.checkedRepoCount = setup.checked.count
        f.fanOutCount = fanOut?.count ?? 0
        f.openAs = openAs
        f.draft = carriedDraft
        f.dropCarryOver = dropCarryOver
        return f
    }

    private var plan: SessionCreatePlan { SessionCreatePlan.make(form) }

    /// The folder the git probe looks at: the existing project's folder, or the
    /// folder picked for a new project. Scratch and the scan list have none.
    private var probeFolder: String? {
        switch target {
        case .existing: return folder
        case .newProject: return source == .folder ? folder : nil
        }
    }

    private var batchRunning: Bool { setup.batch?.isRunning == true }
    private var batchFinished: Bool { setup.batch != nil && !batchRunning }

    private var cliChoicesAuthoritative: Bool { store.launcherCatalog.authoritativeIDs != nil }

    /// The folder the box will create under the scratch root, and the one hint under the field — both the
    /// box's preview (WS11 D5 / S1).
    private var slug: String { scratchProposal?.name ?? "" }

    private var scratchHint: String? { scratchProposal?.hint }

    /// An older box can't name a new project (an unsafe name would be silently rewritten by tmux), so
    /// creating one is disabled with the note.
    private var namingBlocked: Bool { target == .newProject && capabilities.has(.sessionsNaming) == false }

    // MARK: - Body

    var body: some View {
        NavigationStack {
            Form {
                if let linkedIssueURL, let url = URL(string: linkedIssueURL) {
                    Section {
                        Button {
                            openURL(url)
                        } label: {
                            Label("For \(linkedIssueURL)", systemImage: "link")
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                }

                carriedOverSection

                if namingBlocked {
                    Section { UpdateBoxNote(showsLink: false) }
                }

                Section {
                    Picker("Project", selection: Binding(get: { target }, set: { selectTarget($0) })) {
                        ForEach(store.projects, id: \.tmuxSession) { project in
                            Text(project.tmuxSession).tag(Target.existing(project.tmuxSession))
                        }
                        Text("New project…").tag(Target.newProject)
                    }
                    .disabled(setup.batch != nil)
                }

                switch target {
                case .existing:
                    existingSections
                case .newProject:
                    newProjectSections
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
                    Button("Cancel", action: close)
                        .disabled(batchRunning)
                }
                ToolbarItem(placement: .confirmationAction) {
                    // While a batch runs the button is hidden; once it ends with
                    // failures it becomes "Done" (an all-success batch lands on
                    // its own).
                    if batchFinished && setup.batch?.hasFailures == true {
                        Button("Done", action: finishBatch)
                    } else if setup.batch == nil {
                        Button(plan.label, action: create)
                            .disabled(!plan.enabled || creating || namingBlocked)
                    }
                }
            }
            .disabled(creating)
            .overlay {
                if creating { ProgressView().controlSize(.large) }
            }
            .navigationDestination(isPresented: $cloneOpen) {
                CloneFromGitHubView(defaultRoot: setup.proposedRoot) { paths in
                    cloneOpen = false
                    startBatch(paths: paths)
                }
            }
        }
        .task { await prepare() }
        .task(id: probeFolder ?? "") { await probeGit() }
        .task(id: scratchProposalKey) { await proposeScratchName() }
        .task(id: nameProposalKey) { await proposeProjectName() }
        .onChange(of: setup.probe) { _, _ in adoptProposedScratchRoot() }
        .onChange(of: setup.batch) { _, batch in batchChanged(batch) }
        .onDisappear { setup.cancel() }
        .sheet(item: $pickerTarget) { which in
            switch which {
            case .folder:
                FolderPickerView(
                    initialPath: folder.isEmpty ? "~" : folder,
                    onSelect: { path in
                        folderChosen(path, fanOut: nil)
                        pickerTarget = nil
                    },
                    onFanOut: { base, worktrees in
                        folderChosen(base, fanOut: worktrees)
                        pickerTarget = nil
                    },
                    onCancel: { pickerTarget = nil }
                )
            case .scratchRoot:
                FolderPickerView(
                    initialPath: scratchRoot.isEmpty ? "~" : scratchRoot,
                    title: "Choose location",
                    allowsFanOut: false,
                    onSelect: { path in
                        scratchRoot = path
                        pickerTarget = nil
                    },
                    onFanOut: { base, _ in
                        scratchRoot = base
                        pickerTarget = nil
                    },
                    onCancel: { pickerTarget = nil }
                )
            }
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private var carriedOverSection: some View {
        if let carried = carriedDraft, carried.hasCarryOver, !dropCarryOver {
            Section {
                if !carried.text.isEmpty {
                    Text(carried.text)
                        .lineLimit(3)
                        .font(.footnote)
                }
                if !carried.attachments.isEmpty {
                    Text("\(carried.attachments.count) attachment\(carried.attachments.count == 1 ? "" : "s")")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Button("Don't carry over") { dropCarryOver = true }
            } header: {
                Text("Carried over")
            } footer: {
                if plan.mode != .chat {
                    Text("Terminal sessions don't take a first message")
                }
            }
        }
    }

    @ViewBuilder
    private var existingSections: some View {
        Section {
            sessionNameField
            folderRow
            openAsPicker
        } header: {
            Text("Session")
        } footer: {
            Text("Leave the name empty and the session is named for you.")
        }
        worktreeSection
    }

    @ViewBuilder
    private var newProjectSections: some View {
        switch source {
        case .none:
            SessionRepoScanSection(
                setup: setup,
                onBrowse: { pickerTarget = .folder },
                onClone: { cloneOpen = true },
                onScratch: startScratch,
                cloneEnabled: capabilities.has(.forgeCloneView) != false
            )
        case .folder:
            Section("New project") {
                TextField("Name", text: Binding(
                    get: { newProjectName },
                    set: { newProjectName = $0; nameEdited = true }
                ))
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                folderRow
                Button("Choose a different source") { chooseDifferentSource() }
            }
            if let worktrees = fanOut, worktrees.count > 1 {
                Section("Git worktrees") {
                    Text("\(worktrees.count) worktrees found — one session will be opened for each.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    ForEach(worktrees, id: \.path) { worktree in
                        Text(WorktreeInfoLogic.name(worktree))
                            .font(.system(.footnote, design: .monospaced))
                    }
                }
            } else {
                Section {
                    sessionNameField
                    openAsPicker
                } header: {
                    Text("Session")
                } footer: {
                    Text("Leave the name empty and the session is named for you.")
                }
                worktreeSection
            }
        case .scratch:
            Section {
                TextField("Project name", text: $scratchName)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                Button {
                    pickerTarget = .scratchRoot
                } label: {
                    LabeledContent("Location") {
                        Text(scratchRoot.isEmpty ? "Choose a folder" : scratchRoot)
                            .font(.system(.body, design: .monospaced))
                            .foregroundStyle(scratchRoot.isEmpty ? .secondary : .primary)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                }
                .buttonStyle(.plain)
                if !scratchRoot.isEmpty && !slug.isEmpty {
                    Text("↳ \(scratchRoot.hasSuffix("/") ? String(scratchRoot.dropLast()) : scratchRoot)/\(slug)")
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                if let scratchHint {
                    Text(scratchHint)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
                Button("Choose a different source") { chooseDifferentSource() }
            } header: {
                Text("Start something new")
            }
            Section {
                openAsPicker
            }
        }
    }

    private var sessionNameField: some View {
        TextField("Session name", text: $sessionName, prompt: Text("Optional"))
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
    }

    private var folderRow: some View {
        Button {
            pickerTarget = .folder
        } label: {
            LabeledContent("Folder") {
                Text(folder.isEmpty ? "Choose a folder" : folder)
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(folder.isEmpty ? .secondary : .primary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
        }
        .buttonStyle(.plain)
    }

    /// "Open as": Chat (default), Terminal, then each installed AI CLI — only
    /// once the box has confirmed which are installed. While the check is
    /// loading or failed the picker offers Chat and Terminal, and a failure
    /// carries a working retry.
    @ViewBuilder
    private var openAsPicker: some View {
        Picker("Open as", selection: $openAs) {
            Text("Chat").tag(SessionMode.chat)
            Text("Terminal").tag(SessionMode.terminal)
            if cliChoicesAuthoritative {
                ForEach(store.launchers) { launcher in
                    Text(launcher.label).tag(SessionMode.cli(launcherID: launcher.id))
                }
            }
        }
        .pickerStyle(.menu)
        if case .failed = store.launcherCatalog, !cliChoicesAuthoritative {
            Button("Couldn't check which AI CLIs are installed — Try again") {
                Task { await store.refreshLaunchers() }
            }
            .font(.footnote)
        }
    }

    @ViewBuilder
    private var worktreeSection: some View {
        switch gitProbe {
        case .checking:
            Section {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Checking for git…").foregroundStyle(.secondary)
                }
            }
        case .repo:
            Section {
                Toggle("Create in a fresh git worktree", isOn: Binding(
                    get: { worktreeOn },
                    set: { worktreeOn = $0; worktreeTouched = true }
                ))
                if worktreeOn {
                    TextField("Branch name", text: $worktreeBranch, prompt: Text(SessionWorktreeDefaults.branch))
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
            } header: {
                Text("Git worktree")
            } footer: {
                if worktreeOn {
                    Text("The branch is created next to the repository; a name already in use gets a number added.")
                }
            }
        case .notRepo:
            if draftWantsWorktree {
                Section {
                    EmptyView()
                } footer: {
                    Text("This folder isn't a git repository — the worktree can't be created.")
                }
            }
        case .idle, .failed:
            EmptyView()
        }
    }

    private var draftWantsWorktree: Bool {
        !(draft?.worktreeBranch ?? "").isEmpty
    }

    // MARK: - Selection + defaults

    /// User-initiated project choice: reset what depends on it.
    private func selectTarget(_ next: Target) {
        guard next != target else { return }
        target = next
        error = nil
        switch next {
        case .existing(let name):
            folder = defaultFolder(for: name)
            fanOut = nil
            if !worktreeTouched { worktreeOn = boxWorktreeDefault }
        case .newProject:
            source = .none
            folder = ""
            fanOut = nil
            if !worktreeTouched { worktreeOn = false }
            Task { await setup.runProbe() }
        }
        openAs = .chat
    }

    private func defaultFolder(for project: String) -> String {
        guard let proj = store.projects.first(where: { $0.tmuxSession == project }) else { return "" }
        if !proj.defaultCwd.isEmpty { return proj.defaultCwd }
        return proj.windows.first(where: { !$0.paneCurrentPath.isEmpty })?.paneCurrentPath ?? ""
    }

    /// First appearance: read the box defaults fresh, then place the draft.
    private func prepare() async {
        guard !didSetup else { return }
        didSetup = true
        boxWorktreeDefault = await store.readWorktreePerSession()
        applyInitialSelection()
        if target == .newProject { await setup.runProbe() }
        if store.launcherCatalog.authoritativeIDs == nil { await store.refreshLaunchers() }
    }

    private func applyInitialSelection() {
        var placed = false
        if let draft {
            let prefill = SessionDraftPrefill.apply(draft: draft, projects: store.projects, worktreePerSession: boxWorktreeDefault)
            carriedDraft = draft
            linkedIssueURL = prefill.linkedIssueURL
            worktreeOn = prefill.worktreeOn
            worktreeBranch = prefill.worktreeBranch
            worktreeTouched = draftWantsWorktree
            switch prefill.target {
            case .existing(let name):
                target = .existing(name)
                folder = prefill.folder ?? defaultFolder(for: name)
                placed = true
            case .newProjectFolder:
                target = .newProject
                source = .folder
                folder = prefill.folder ?? ""
                nameEdited = false
                placed = true
            case .unspecified:
                break
            }
        }
        guard !placed else { return }
        if startWithNewProject || store.projects.isEmpty {
            target = .newProject
            source = .none
        } else if let initialProject, store.projects.contains(where: { $0.tmuxSession == initialProject }) {
            target = .existing(initialProject)
            folder = defaultFolder(for: initialProject)
        } else if let first = store.projects.first {
            target = .existing(first.tmuxSession)
            folder = defaultFolder(for: first.tmuxSession)
        }
        if draft == nil || !draftWantsWorktree {
            if case .existing = target { worktreeOn = boxWorktreeDefault }
        }
    }

    // MARK: - Folder + probes

    private func folderChosen(_ path: String, fanOut worktrees: [MantaWorktree]?) {
        folder = path
        fanOut = worktrees
        if target == .newProject {
            source = .folder
        }
    }

    private func chooseDifferentSource() {
        source = .none
        fanOut = nil
        folder = ""
        error = nil
    }

    private func startScratch() {
        source = .scratch
        error = nil
        adoptProposedScratchRoot()
    }

    private func adoptProposedScratchRoot() {
        guard source == .scratch, scratchRoot.isEmpty else { return }
        scratchRoot = setup.proposedRoot
    }

    /// The scratch preview is keyed on what it depends on, and debounced 250 ms (it is a preview — the
    /// create re-checks; a failed read just clears it).
    private var scratchProposalKey: String { source == .scratch ? "\(scratchName)\u{1F}\(scratchRoot)" : "" }

    private func proposeScratchName() async {
        guard source == .scratch else { scratchProposal = nil; return }
        try? await Task.sleep(nanoseconds: 250_000_000)
        guard !Task.isCancelled else { return }
        let proposal = try? await api.sessionsProposeName(scratch: scratchName, root: scratchRoot)
        guard !Task.isCancelled else { return }
        scratchProposal = proposal
    }

    /// The name a new project would get, previewed in the field until the user types their own.
    private var nameProposalKey: String { (target == .newProject && source == .folder && !nameEdited) ? folder : "" }

    private func proposeProjectName() async {
        let path = folder.trimmingCharacters(in: .whitespacesAndNewlines)
        guard target == .newProject, source == .folder, !nameEdited, !path.isEmpty else { return }
        guard let proposal = try? await api.sessionsProposeName(project: path), !Task.isCancelled, !nameEdited else { return }
        newProjectName = proposal.name
    }

    private func probeGit() async {
        guard let dir = probeFolder?.trimmingCharacters(in: .whitespacesAndNewlines), !dir.isEmpty, dir != "~" else {
            gitProbe = .idle
            return
        }
        gitProbe = .checking
        do {
            let worktrees = try await api.listWorktrees(dir)
            guard !Task.isCancelled else { return }
            gitProbe = worktrees.isEmpty ? .notRepo : .repo
        } catch {
            guard !Task.isCancelled else { return }
            gitProbe = .failed
        }
    }

    // MARK: - Batch

    private func startBatch(paths: [String]) {
        guard !paths.isEmpty, !namingBlocked else { return }
        source = .none
        setup.setUp(paths: paths)
    }

    private func batchChanged(_ batch: SessionSetupBatch?) {
        guard let batch else { return }
        if !setup.latestProjects.isEmpty { store.applyProjects(setup.latestProjects) }
        guard !batch.isRunning, batch.allReady else { return }
        if let landing = setup.landing(path: batch.autoLandingPath) {
            onCreated(landing)
        }
    }

    /// "Done" after a partial failure: land on the first success, or just close.
    private func finishBatch() {
        if let landing = setup.landing(path: setup.batch?.doneLandingPath) {
            onCreated(landing)
        } else {
            onClose()
        }
    }

    private func close() {
        setup.cancel()
        if setup.batch != nil, !setup.latestProjects.isEmpty { store.applyProjects(setup.latestProjects) }
        onClose()
    }

    // MARK: - Create
    //
    // The session is created for real here (tmux window + opencode session);
    // the caller pushes it, and the user types their first message in the
    // session itself rather than in this sheet.

    private func create() {
        guard !creating, plan.enabled, !namingBlocked else { return }
        let plan = self.plan
        if plan.kind == .repoBatch {
            setup.setUp(paths: setup.checkedPathsInOrder)
            return
        }
        creating = true
        error = nil
        Task {
            do {
                let created = try await perform(plan)
                creating = false
                onCreated(created)
            } catch {
                self.error = SessionCreateFailure.message(for: error)
                creating = false
            }
        }
    }

    private var resolvedSessionName: String {
        let trimmed = sessionName.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "session" : trimmed
    }

    private func perform(_ plan: SessionCreatePlan) async throws -> SessionCreated {
        switch plan.kind {
        case .existingWindow: return try await createInExistingProject(plan)
        case .newProjectFolder: return try await createNewProject(plan)
        case .fanOut: return try await createFanOut(plan)
        case .scratch: return try await createScratch(plan)
        case .repoBatch: throw MantaError.transport("nothing to create")
        }
    }

    /// Existing project, optionally in a fresh worktree. If the worktree was cut
    /// but the session could not open in it, the message says where the worktree
    /// is — nothing is undone, and nothing is left silently half-created.
    private func createInExistingProject(_ plan: SessionCreatePlan) async throws -> SessionCreated {
        guard case .existing(let project) = target else { throw MantaError.transport("no project chosen") }
        let windowName = resolvedSessionName
        let projectFolder = defaultFolder(for: project)
        let trimmedFolder = folder.trimmingCharacters(in: .whitespacesAndNewlines)
        var cwd: String? = (trimmedFolder.isEmpty || trimmedFolder == projectFolder) ? nil : trimmedFolder
        var worktreePath: String?
        if let wt = plan.worktree {
            let added = try await api.gitAddWorktree(cwd: wt.cwd, name: wt.branch)
            cwd = added.path
            worktreePath = added.path
        }
        let reply: TmuxCreateResult
        do {
            reply = try await api.createWindow(SessionNewWindowInput(
                sessionName: project, windowName: windowName, cwd: cwd, chatMode: true, worktreePath: worktreePath
            ))
        } catch {
            if let worktreePath {
                let reason = SessionCreateFailure.message(for: error)
                throw MantaError.server("Created worktree at \(worktreePath), but couldn't open a session in it: \(reason)")
            }
            throw error
        }
        return try finish(reply: reply, project: project, windowName: windowName, plan: plan)
    }

    private func createNewProject(_ plan: SessionCreatePlan) async throws -> SessionCreated {
        let windowName = resolvedSessionName
        let folderPath = folder.trimmingCharacters(in: .whitespacesAndNewlines)
        var cwd = folderPath
        var createDir = true
        if let wt = plan.worktree {
            let added = try await api.gitAddWorktree(cwd: wt.cwd, name: wt.branch)
            cwd = added.path
            createDir = false
        }
        let reply: TmuxCreateResult
        do {
            // A typed name is sent as is; otherwise the box names the session from the folder.
            let typed = newProjectName.trimmingCharacters(in: .whitespacesAndNewlines)
            reply = try await api.createSession(SessionNewProjectInput(
                name: nameEdited ? typed : nil, nameHint: nameEdited ? nil : folderPath,
                cwd: cwd, windowName: windowName, chatMode: true, createDir: createDir
            ))
        } catch {
            if plan.worktree != nil {
                let reason = SessionCreateFailure.message(for: error)
                throw MantaError.server("Created worktree at \(cwd), but couldn't open a session in it: \(reason)")
            }
            throw error
        }
        return try finish(reply: reply, project: try createdName(reply), windowName: windowName, plan: plan)
    }

    /// The name the box gave the session it just created (it picks it — WS11 D5 / S1).
    private func createdName(_ reply: TmuxCreateResult) throws -> String {
        guard let name = reply.name, !name.isEmpty else { throw MantaError.transport("the box didn't report the new session's name") }
        return name
    }

    /// The folder holds several worktrees and the user chose one session each:
    /// the first becomes the project's initial window, the rest are added.
    private func createFanOut(_ plan: SessionCreatePlan) async throws -> SessionCreated {
        guard let worktrees = fanOut, let first = worktrees.first else { throw MantaError.transport("no worktrees to open") }
        let firstName = WorktreeInfoLogic.name(first)
        let typed = newProjectName.trimmingCharacters(in: .whitespacesAndNewlines)
        var reply = try await api.createSession(SessionNewProjectInput(
            name: nameEdited ? typed : nil, nameHint: nameEdited ? nil : folder.trimmingCharacters(in: .whitespacesAndNewlines),
            cwd: first.path, windowName: firstName, chatMode: true, createDir: false
        ))
        let projectName = try createdName(reply)
        let landingIndex = reply.windowIndex
        for worktree in worktrees.dropFirst() {
            reply = try await api.createWindow(SessionNewWindowInput(
                sessionName: projectName, windowName: WorktreeInfoLogic.name(worktree), cwd: worktree.path, chatMode: true
            ))
        }
        // Land on the FIRST worktree's window (the index its create reported),
        // against the newest project list.
        let combined = TmuxCreateResult(projects: reply.projects, sessionId: nil, windowIndex: landingIndex)
        return try finish(reply: combined, project: projectName, windowName: firstName, plan: plan)
    }

    private func createScratch(_ plan: SessionCreatePlan) async throws -> SessionCreated {
        let scratch = try await api.projectCreateScratch(root: scratchRoot, name: scratchName)
        let reply = try await api.createSession(SessionNewProjectInput(
            nameHint: scratch.path, cwd: scratch.path, windowName: "default", chatMode: true, createDir: false
        ))
        return try finish(reply: reply, project: try createdName(reply), windowName: "default", plan: plan)
    }

    /// Resolve the created window (by the index the box reported first), save the
    /// chosen mode for it, and describe where to land.
    private func finish(reply: TmuxCreateResult, project: String, windowName: String, plan: SessionCreatePlan) throws -> SessionCreated {
        guard let located = SessionCreatedWindow.locate(
            in: reply.projects, project: project, windowIndex: reply.windowIndex,
            sessionId: reply.sessionId, name: windowName
        ) else {
            throw MantaError.transport("created session was not returned")
        }
        let window = located.window
        let landing = SessionCreateLanding.make(mode: plan.mode, sessionId: window.opencodeSessionId ?? reply.sessionId)
        if landing.writesMode, let sid = landing.sessionId {
            SessionModeStore.write(landing.mode, sessionID: sid)
        }
        return SessionCreated(
            // The project's REAL name (tmux may have rewritten the one we sent).
            project: located.project,
            windowIndex: window.index,
            sessionId: landing.sessionId,
            projects: reply.projects,
            mode: landing.mode,
            draft: plan.draft
        )
    }
}
