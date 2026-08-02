import SwiftUI

// ===========================================================================
// S3 — create-session sheet (BET-595 §create).
//
// THE OWNER OVERRIDE (§5.5 "you do not create a session" is overridden): the
// user chooses a NAME and (on new-project) a FOLDER (optionally a worktree
// fan-out), then the FIRST MESSAGE creates the session — no session is
// created at "Continue"; it is created the moment the first message is sent,
// then that message is delivered to it. Ports the retired `MobileCreateSheet`
// / `MobileFolderPicker` to SwiftUI per §7-ported folderPicker helpers.
// ===========================================================================

enum SessionCreateMode: Equatable {
    case newProject
    case newSession(projectName: String)
}

struct SessionCreateSheet: View {
    let mode: SessionCreateMode
    let onClose: () -> Void
    let onCreated: (String, Int) -> Void
    @Environment(\.colorScheme) private var colorScheme

    @State private var step: Step = .form
    @State private var name = ""
    @State private var cwd = "~"
    @State private var detectedWorktrees: [MantaWorktree]?
    @State private var creating = false
    @State private var error: String?
    @State private var folderPickerOpen = false
    @State private var firstMessage = ""

    private let api = MantaAPIClient.live()

    enum Step { case form, firstMessage }

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    private var titleText: String {
        switch mode {
        case .newProject: return "New project"
        case .newSession(let project): return "New session in \"\(project)\""
        }
    }

    private var isNewProject: Bool {
        if case .newProject = mode { return true }
        return false
    }

    var body: some View {
        ZStack {
            tokens.canvas.ignoresSafeArea()
            VStack(spacing: 0) {
                header
                switch step {
                case .form: formStep
                case .firstMessage: firstMessageStep
                }
            }
        }
        .overlay {
            if folderPickerOpen {
                FolderPickerView(
                    initialPath: cwd,
                    onSelect: { path in
                        cwd = path
                        folderPickerOpen = false
                    },
                    onFanOut: { base, wts in
                        cwd = base
                        detectedWorktrees = wts
                        folderPickerOpen = false
                    },
                    onCancel: { folderPickerOpen = false }
                )
                .transition(.move(edge: .bottom))
            }
        }
    }

    private var header: some View {
        HStack {
            Text(titleText)
                .font(.system(size: Metrics.type.body, weight: .semibold))
                .foregroundColor(tokens.tx1)
            Spacer()
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: Metrics.type.body, weight: .regular))
                    .foregroundColor(tokens.tx2)
            }
            .accessibilityLabel("Close")
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp3)
    }

    // MARK: - Form step

    private var formStep: some View {
        VStack(spacing: Metrics.spacing.sp3) {
            field(label: "Name", placeholder: isNewProject ? "my-project" : "session", text: $name)

            if isNewProject {
                VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                    Text("Default working directory")
                        .font(.system(size: Metrics.type.twoXS, weight: .semibold))
                        .foregroundColor(tokens.tx3)
                    HStack(spacing: Metrics.spacing.sp2) {
                        TextField("~/code/foo", text: $cwd)
                            .font(.system(size: Metrics.type.small, design: .monospaced))
                            .foregroundColor(tokens.tx1)
                            .padding(.horizontal, Metrics.spacing.sp3)
                            .padding(.vertical, Metrics.spacing.sp2)
                            .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                        Button {
                            folderPickerOpen = true
                        } label: {
                            Image(systemName: "folder")
                                .font(.system(size: Metrics.type.body))
                                .foregroundColor(tokens.tx2)
                                .padding(Metrics.spacing.sp2)
                                .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
                        }
                        .accessibilityLabel("Browse folders")
                    }
                    worktreeInfo
                }
            }

            if let error {
                Text(error)
                    .font(.system(size: Metrics.type.small))
                    .foregroundColor(tokens.danger)
            }

            VStack(spacing: Metrics.spacing.sp2) {
                Button {
                    continueToFirstMessage()
                } label: {
                    primaryButton("Continue")
                }
                .disabled(!formValid)
                Button(action: onClose) {
                    Text("Cancel")
                        .font(.system(size: Metrics.type.small, weight: .medium))
                        .foregroundColor(tokens.tx3)
                        .padding(Metrics.spacing.sp2)
                }
            }
            .padding(.top, Metrics.spacing.sp1)
        }
        .padding(.horizontal, Metrics.spacing.sp3)
    }

    @ViewBuilder
    private var worktreeInfo: some View {
        if let wts = detectedWorktrees, wts.count > 1 {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                Text("Detected \(wts.count) git worktrees. Open a session for each?")
                    .font(.system(size: Metrics.type.small))
                    .foregroundColor(tokens.tx2)
                ForEach(wts, id: \.path) { w in
                    HStack {
                        Text(WorktreeInfoLogic.name(w))
                            .font(.system(size: Metrics.type.xs, design: .monospaced))
                            .foregroundColor(tokens.tx1)
                        Spacer()
                        Text(w.path)
                            .font(.system(size: Metrics.type.xs, design: .monospaced))
                            .foregroundColor(tokens.tx4)
                            .lineLimit(1)
                    }
                }
            }
            .padding(Metrics.spacing.sp2)
            .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        }
    }

    private func continueToFirstMessage() {
        guard formValid else { return }
        if isNewProject {
            Task {
                // Auto-detect worktrees for the fan-out question (best-effort).
                let trimmed = cwd.trimmingCharacters(in: .whitespaces)
                if let wts = try? await api.listWorktrees(trimmed), wts.count > 1 {
                    detectedWorktrees = wts
                }
            }
        }
        step = .firstMessage
    }

    // MARK: - First-message step (creation happens HERE)

    private var firstMessageStep: some View {
        VStack(spacing: Metrics.spacing.sp3) {
            Text("Type your first message")
                .font(.system(size: Metrics.type.small))
                .foregroundColor(tokens.tx2)
                .frame(maxWidth: .infinity, alignment: .leading)
            TextField("Message…", text: $firstMessage, axis: .vertical)
                .lineLimit(1...6)
                .font(.system(size: Metrics.type.body))
                .foregroundColor(tokens.tx1)
                .padding(Metrics.spacing.sp3)
                .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
                .autocorrectionDisabled()

            if let error {
                Text(error)
                    .font(.system(size: Metrics.type.small))
                    .foregroundColor(tokens.danger)
            }

            Button {
                createAndSend()
            } label: {
                primaryButton(creating ? "Creating…" : "Create session")
            }
            .disabled(creating)
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.top, Metrics.spacing.sp2)
    }

    private func createAndSend() {
        guard !creating else { return }
        let message = firstMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return }
        creating = true
        error = nil
        Task {
            do {
                switch mode {
                case .newProject:
                    try await createProjectAndSend(message)
                case .newSession(let project):
                    try await createWindowAndSend(projectName: project, message: message)
                }
            } catch {
                self.error = "Couldn't create the session"
                creating = false
            }
        }
    }

    private func createProjectAndSend(_ message: String) async throws {
        let projectName = name.trimmingCharacters(in: .whitespaces)
        let dir = cwd.trimmingCharacters(in: .whitespaces)
        var targetSessionID: String?
        var targetProject: String = projectName
        var targetWindow: Int = 0

        if let wts = detectedWorktrees, wts.count > 1 {
            let first = wts[0]
            var projects = try await api.newSession(NewSessionInput(
                name: projectName, cwd: first.path, windowName: WorktreeInfoLogic.name(first),
                createDir: false, chatMode: true))
            for w in wts.dropFirst() {
                projects = try await api.newWindow(NewWindowInput(
                    sessionName: projectName, windowName: WorktreeInfoLogic.name(w),
                    cwd: w.path, chatMode: true))
            }
            if let window = Self.findInitialWindow(projects, projectName: projectName, cwd: first.path) {
                targetSessionID = window.opencodeSessionId
                targetWindow = window.index
            }
        } else {
            let projects = try await api.newSession(NewSessionInput(
                name: projectName, cwd: dir, windowName: "default",
                createDir: true, chatMode: true))
            if let proj = projects.first(where: { $0.tmuxSession == projectName }),
               let window = proj.windows.first(where: { $0.name == "default" }) ?? proj.windows.first {
                targetSessionID = window.opencodeSessionId
                targetWindow = window.index
            }
        }

        guard let sessionID = targetSessionID else {
            throw MantaError.transport("created session returned no chat id")
        }
        try await api.sendPrompt(SendPromptInput(sessionId: sessionID, text: message))
        await MainActor.run {
            creating = false
            onCreated(targetProject, targetWindow)
        }
    }

    private func createWindowAndSend(projectName: String, message: String) async throws {
        let windowName = name.trimmingCharacters(in: .whitespaces).isEmpty ? "session" : name.trimmingCharacters(in: .whitespaces)
        let projects = try await api.newWindow(NewWindowInput(
            sessionName: projectName, windowName: windowName, cwd: nil, chatMode: true))
        guard let proj = projects.first(where: { $0.tmuxSession == projectName }),
              let window = proj.windows.first(where: { $0.name == windowName }),
              let sessionID = window.opencodeSessionId else {
            throw MantaError.transport("created session returned no chat id")
        }
        try await api.sendPrompt(SendPromptInput(sessionId: sessionID, text: message))
        await MainActor.run {
            creating = false
            onCreated(projectName, window.index)
        }
    }

    /// The initial (first-worktree) window after a fan-out create.
    private static func findInitialWindow(_ projects: [MantaProject], projectName: String, cwd: String) -> MantaWindow? {
        guard let proj = projects.first(where: { $0.tmuxSession == projectName }) else { return nil }
        if let exact = proj.windows.first(where: { $0.paneCurrentPath == cwd }) { return exact }
        return proj.windows.min(by: { $0.index < $1.index })
    }

    // MARK: - shared pieces

    private var formValid: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty
    }

    @ViewBuilder
    private func field(label: String, placeholder: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            Text(label)
                .font(.system(size: Metrics.type.twoXS, weight: .semibold))
                .foregroundColor(tokens.tx3)
            TextField(placeholder, text: text)
                .font(.system(size: Metrics.type.body))
                .foregroundColor(tokens.tx1)
                .padding(.horizontal, Metrics.spacing.sp3)
                .padding(.vertical, Metrics.spacing.sp2)
                .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
        }
    }

    @ViewBuilder
    private func primaryButton(_ text: String) -> some View {
        Text(text)
            .font(.system(size: Metrics.type.small, weight: .semibold))
            .foregroundColor(text.hasPrefix("Creating") ? tokens.tx4 : tokens.onAccent)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Metrics.spacing.sp3)
            .background(
                text.hasPrefix("Creating") ? AnyShapeStyle(tokens.panel) : AnyShapeStyle(tokens.accentSolid),
                in: RoundedRectangle(cornerRadius: Metrics.radius.md))
    }
}
