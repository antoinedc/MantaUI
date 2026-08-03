import SwiftUI

// ===========================================================================
// S4 — chat screen wired to live data (BET-596).
//
// Replaces the SessionListView tap target (was a placeholder). This screen
// binds to a ChatSessionStore (live transcript + status + todos + context +
// answerable permissions/questions) and renders through the EXISTING
// TranscriptComponents (§8/§8a): there is no second transcript renderer.
//
// Container per BET-481: ScrollView + LazyVStack + .defaultScrollAnchor(.bottom)
// kept verbatim — do NOT re-measure or replace. Subagent rows PUSH a live child
// screen via NavigationStack (parent scroll untouched; BET-576 binds the child
// to the same observable source).
//
// No colour/spacing/radius/size/weight literal; every value resolves through
// the generated tokens.
// ===========================================================================

/// The BET-627 overflow-sheet items that present a card of their own.
private enum OverflowDestination: String, Identifiable {
    case attach
    case schedules
    case secrets

    var id: String { rawValue }
}

/// Thin wrapper that owns WHICH opencode session the screen is showing.
///
/// Clearing a session does not end the conversation on screen — it starts a new
/// opencode session in the same tmux window, and the user expects to stay
/// exactly where they are with an empty transcript. The stores are built from
/// the session id, so the id has to live one level ABOVE them: swapping it here
/// rebuilds the content view (and its stores) in place. Popping back to the
/// list instead, which is what this did before, both lost the user's place and
/// left them reopening the OLD session id from a stale list.
struct ChatScreen: View {
    let sessionId: String
    let title: String
    let projectName: String
    @ObservedObject var eventStore: MantaEventStore
    @Binding var path: NavigationPath
    @State private var currentSessionId: String?

    var body: some View {
        let sid = currentSessionId ?? sessionId
        ChatScreenContent(
            sessionId: sid,
            title: title,
            projectName: projectName,
            eventStore: eventStore,
            path: $path,
            onCleared: { newId in currentSessionId = newId }
        )
        .id(sid)
    }
}

private struct ChatScreenContent: View {
    let title: String
    let projectName: String
    @ObservedObject var eventStore: MantaEventStore
    @Binding var path: NavigationPath
    @StateObject private var store: ChatSessionStore
    @StateObject private var modelStore: ChatModelStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var showOverflow = false
    @State private var branch: String?
    @State private var sessionWindow: (name: String, index: Int, cwd: String)?
    /// Which overflow-sheet item's card is presented (BET-627).
    @State private var overflowDestination: OverflowDestination?
    /// Live scheduled-task count for the overflow sheet's badge (BET-627).
    @State private var scheduleCount = 0

    /// Called with the NEW session id after a clear, so the wrapper can swap it.
    let onCleared: (String) -> Void

    init(sessionId: String, title: String, projectName: String, eventStore: MantaEventStore, path: Binding<NavigationPath>, onCleared: @escaping (String) -> Void) {
        self.title = title
        self.projectName = projectName
        self.eventStore = eventStore
        self._path = path
        self.onCleared = onCleared
        let api = MantaAPIClient.live()
        _store = StateObject(wrappedValue: ChatSessionStore(
            sessionId: sessionId,
            eventStore: eventStore,
            api: api
        ))
        _modelStore = StateObject(wrappedValue: ChatModelStore(sessionId: sessionId, api: api))
    }

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        // ChatScreen is PUSHED within SessionListView's NavigationStack, so it
        // does not nest another stack (that would double the nav bar). The
        // subagent destination is registered against the enclosing stack here,
        // so a value-push keeps the parent in the stack (its scroll untouched)
        // and the child streams while open (BET-576).
        Group {
            if store.loadFailed {
                loadFailure
            } else if store.loading {
                loadingSkeleton
            } else {
                transcript
            }
        }
        .background(tokens.canvas.ignoresSafeArea())
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 0) {
                bottomCards
                // BET-630 (D1): the running-state working row. Shown only while a
                // turn runs; the ambient refetch sweep lives on the composer's
                // top divider and means a different thing, so the two never
                // share an indicator. Not shown during a background refetch.
                if store.running {
                    RunningIndicator(store: store)
                }
                ComposerView(
                    sessionId: store.sessionId,
                    projectName: projectName,
                    api: MantaAPIClient.live(),
                    store: store,
                    modelStore: modelStore
                )
            }
        }
        .navigationDestination(for: SubagentSession.self) { agent in
            if let child = store.store(for: agent.childSessionId) {
                ChatSubagentScreen(
                    title: agent.taskName,
                    subtitle: agent.subtitle,
                    store: child,
                    tokens: tokens
                )
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        // The header is an INSET, not an overlay: as an overlay it floated on
        // top of the transcript with nothing reserving its space, so the first
        // rows sat underneath it and were clipped at rest, not just while
        // scrolling.
        .safeAreaInset(edge: .top) { header }
        .sheet(isPresented: $showOverflow) { overflowSheet }
        .sheet(item: $overflowDestination) { destination in
            destinationCard(destination)
        }
        .onAppear {
            store.start()
            Task { await resolveWindowAndBranch() }
        }
        .onDisappear { store.stop() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-screen")
    }

    // MARK: - Overflow sheet (§8)

    private var overflowSheet: some View {
        ChatOverflowSheet(
            sessionTitle: title,
            projectName: projectName,
            branch: branch,
            onAttach: { overflowDestination = .attach },
            onSchedules: { overflowDestination = .schedules },
            onSecrets: { overflowDestination = .secrets },
            onWebhooks: {},
            onCompact: { store.compact() },
            onClear: { Task { await clearSession() } },
            onFork: { Task { await forkSession() } },
            onOpenTerminal: { Task { await openTerminal() } },
            onDelete: { Task { await deleteSession() } },
            scheduleCount: scheduleCount
        )
        .task { await refreshScheduleCount() }
    }

    /// The three BET-627 overflow items present their cards here. Attach sends
    /// an attachment-only prompt through the store's existing send path.
    @ViewBuilder
    private func destinationCard(_ destination: OverflowDestination) -> some View {
        switch destination {
        case .attach:
            AttachCard(
                sessionId: store.sessionId,
                projectName: projectName,
                onSend: { attachment in
                    overflowDestination = nil
                    store.send(text: "", attachments: [attachment], model: nil)
                },
                onClose: { overflowDestination = nil },
                api: MantaAPIClient.live()
            )
        case .schedules:
            SchedulesCard(
                sessionId: store.sessionId,
                onClose: { overflowDestination = nil }
            )
        case .secrets:
            SecretsCard(
                sessionId: store.sessionId,
                onClose: { overflowDestination = nil }
            )
        }
    }

    /// (Re)load the scheduled-task count backing the sheet's live badge.
    private func refreshScheduleCount() async {
        let api = MantaAPIClient.live()
        if let jobs = try? await api.listSchedules(sessionId: store.sessionId) {
            scheduleCount = jobs.count
        }
    }

    /// The chat screen knows its project by NAME only, but every session action
    /// (clear/fork/delete) and the branch lookup need the tmux window index and
    /// its working directory. Resolve both once when the screen appears.
    private func resolveWindowAndBranch() async {
        let api = MantaAPIClient.live()
        guard let projects = try? await api.projects(),
              let project = projects.first(where: { $0.tmuxSession == projectName }),
              let window = project.windows.first(where: { $0.opencodeSessionId == store.sessionId })
        else { return }
        let cwd = window.paneCurrentPath.isEmpty ? project.defaultCwd : window.paneCurrentPath
        await MainActor.run { sessionWindow = (project.tmuxSession, window.index, cwd) }
        if !cwd.isEmpty, let resolved = try? await api.vcsBranch(directory: cwd) {
            await MainActor.run { branch = resolved }
        }
    }

    /// Clear = a fresh opencode session in the SAME window. Stay on the screen
    /// and re-point it at the new id; the transcript comes back empty because
    /// the session really is new.
    private func clearSession() async {
        guard let w = sessionWindow else { return }
        let newId = try? await MantaAPIClient.live().clearSession(
            sessionName: w.name, windowIndex: w.index, cwd: w.cwd, title: title)
        guard let newId, !newId.isEmpty else { return }
        await MainActor.run { onCleared(newId) }
    }

    private func forkSession() async {
        guard let w = sessionWindow else { return }
        let newSessionId = try? await MantaAPIClient.live().forkSession(
            sessionId: store.sessionId, sessionName: w.name,
            windowName: "\(title)-fork", cwd: w.cwd)
        guard let newSessionId, !newSessionId.isEmpty else { return }
        // Fork = a full copy of the session in a fresh window. Land on the
        // fork: push the new session as the next destination (sessionId is
        // present, so it opens the forked chat). The original stays one pop
        // back. windowIndex is not used when sessionId is set.
        await MainActor.run {
            path.append(SessionOpenTarget(project: projectName, windowIndex: w.index, name: "\(title) fork", sessionId: newSessionId))
        }
    }

    /// "Open terminal" — push the terminal screen for the session's tmux
    /// window. The target carries NO opencode session id, so SessionListView's
    /// navigationDestination routes it to the native terminal instead of the
    /// chat screen.
    private func openTerminal() async {
        guard let w = sessionWindow else { return }
        await MainActor.run {
            path.append(SessionOpenTarget(project: projectName, windowIndex: w.index, name: title, sessionId: nil))
        }
    }

    private func deleteSession() async {
        guard let w = sessionWindow else { return }
        try? await MantaAPIClient.live().deleteSession(
            sessionId: store.sessionId, sessionName: w.name, windowIndex: w.index)
        await MainActor.run { dismiss() }
    }

    // MARK: - Header (§8)

    private var header: some View {
        HStack(spacing: Metrics.spacing.sp2) {
            Button {
                dismiss()
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: Metrics.type.body, weight: .semibold))
                    .foregroundColor(tokens.tx1)
                    .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
                    .background(.ultraThinMaterial, in: Circle())
                    .accessibilityLabel("Back to sessions")
            }
            .buttonStyle(.plain)

            Spacer(minLength: 0)

            VStack(spacing: Metrics.spacing.spPx) {
                Text(title)
                    .font(.system(size: Metrics.type.chatTitle, weight: mantaFontWeight(Metrics.type.semibold)))
                    .kerning(Metrics.type.chatTitleTracking * Metrics.type.chatTitle)
                    .foregroundColor(tokens.tx1)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(store.headerSubtitle)
                    .font(.system(size: Metrics.type.xs, weight: mantaFontWeight(Metrics.type.medium)))
                    .foregroundColor(tokens.tx4)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Spacer(minLength: 0)

            // Trailing 38×38 glass button (§8) — the overflow sheet, which is
            // where every session action lives (DECISIONS.md:667-670).
            Button {
                showOverflow = true
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: Metrics.type.body, weight: .semibold))
                    .foregroundColor(tokens.tx1)
                    .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Session actions")
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
        .background {
            Rectangle().fill(.ultraThinMaterial).ignoresSafeArea()
        }
    }

    // MARK: - Transcript (BET-481 container, kept verbatim)

    private var transcript: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                TranscriptView(blocks: store.blocks, tokens: tokens)
            }
            // Pin the content to the scroll view's own width. A vertical scroll
            // view otherwise sizes itself to its WIDEST child, so one long line
            // of tool output widens the whole screen and drags the composer off
            // with it.
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollClipDisabled(false)
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
    }

    // MARK: - Loading skeleton (D2 / BET-631)

    /// Transcript-shaped loading placeholder: three greyed blocks at the
    /// user-band / prose / step-group rhythm, shown while the session's first
    /// transcript fetch is in flight. It occupies the same scroll region the
    /// real transcript will, so the first blocks replacing it cause no layout
    /// shift — and there is deliberately no full-screen spinner (which would
    /// discard the scroll anchor and flash on a warm reopen).
    private var loadingSkeleton: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                skeletonUserBand
                    .padding(.bottom, Metrics.spacing.sp4)
                skeletonProse
                skeletonStepGroup
            }
        }
        .defaultScrollAnchor(.bottom)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("loading-skeleton")
    }

    /// Greyed block in the shape of a user band (§8): a full-bleed `fill` band
    /// with a leading edge, holding two placeholder body lines.
    private var skeletonUserBand: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            skeletonLine(height: bodyLine)
            skeletonLine(height: bodyLine)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Metrics.spacing.sp3)
        .background(tokens.fill, in: UnevenRoundedRectangle(
            topLeadingRadius: 0,
            bottomLeadingRadius: 0,
            bottomTrailingRadius: Metrics.radius.md,
            topTrailingRadius: Metrics.radius.md
        ))
        .overlay(alignment: .leading) {
            tokens.borderSubtle
                .frame(width: Metrics.spacing.spPx * 2)
        }
    }

    /// Greyed prose block: placeholder body lines at the prose rhythm.
    private var skeletonProse: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            skeletonLine(height: bodyLine)
            skeletonLine(height: bodyLine)
            skeletonLine(height: bodyLine)
        }
        .padding(.top, Metrics.spacing.sp1)
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.bottom, Metrics.spacing.sp3)
    }

    /// Greyed step-group block: a `panel` container with placeholder step rows
    /// and hairlines between them, echoing the step-row geometry.
    private var skeletonStepGroup: some View {
        VStack(spacing: 0) {
            ForEach(0..<3, id: \.self) { index in
                HStack(spacing: Metrics.spacing.sp2) {
                    Circle()
                        .fill(tokens.inset)
                        .frame(width: Metrics.type.stepDot, height: Metrics.type.stepDot)
                    skeletonLine(height: smallLine)
                }
                .padding(.vertical, Metrics.type.stepRowY)
                .padding(.horizontal, Metrics.spacing.sp3)
                if index < 2 {
                    Rectangle()
                        .fill(tokens.borderSubtle)
                        .frame(height: Metrics.spacing.spPx)
                }
            }
        }
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.bottom, Metrics.spacing.sp3)
    }

    /// A single grey placeholder bar, at the base of a text line's cap height.
    private func skeletonLine(height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: Metrics.radius.xs)
            .fill(tokens.inset)
            .frame(maxWidth: .infinity)
            .frame(height: height)
    }

    /// The rendered height of a body line at the prose leading.
    private var bodyLine: CGFloat { Metrics.type.body * Metrics.type.proseLineHeight }

    /// The rendered height of a small (13px) line at the UI leading.
    private var smallLine: CGFloat { Metrics.type.small * Metrics.type.uiLineHeight }

    // MARK: - Live cards (todos / permission / question)

    @ViewBuilder
    private var bottomCards: some View {
        VStack(spacing: Metrics.spacing.sp3) {
            if let todos = store.todos, let active = todos.active, !active.isEmpty {
                TodosCard(items: active, tokens: tokens)
            }
            if let permission = newestPermission {
                PermissionCard(permission: permission, tokens: tokens) { reply in
                    store.replyPermission(permission, reply: reply)
                }
            }
            if let question = newestQuestion {
                QuestionCard(question: question, tokens: tokens) { answers in
                    store.replyQuestion(question, answers: answers)
                } onReject: {
                    store.rejectQuestion(question)
                }
            }
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.top, Metrics.spacing.sp2)
    }

    private var newestPermission: PermissionRequest? {
        store.permissions.last
    }

    private var newestQuestion: QuestionRequest? {
        store.questions.last
    }

    // MARK: - Load failure

    private var loadFailure: some View {
        VStack(spacing: Metrics.spacing.sp2) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: Metrics.type.display))
                .foregroundColor(tokens.warn)
            Text("Couldn't reach your box")
                .font(.system(size: Metrics.type.body, weight: .semibold))
                .foregroundColor(tokens.tx1)
            Text("Tap to retry.")
                .font(.system(size: Metrics.type.small))
                .foregroundColor(tokens.tx4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture { store.load() }
    }
}

// MARK: - Child drill-in (S4 / BET-576)

/// The pushed subagent screen. Unlike the S4b frozen fixture screen, this one
/// binds to a LIVE ChatSessionStore for the child opencode session — the
/// transcript streams while the child is open. Reuses the existing
/// SubagentHeader + TranscriptView (no second renderer).
struct ChatSubagentScreen: View {
    let title: String
    let subtitle: String
    @ObservedObject var store: ChatSessionStore
    let tokens: Tokens
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            SubagentHeader(
                title: title,
                subtitle: subtitle,
                onBack: { dismiss() },
                tokens: tokens
            )
            // `.bottom` ALONE also aligns SHORT content to the bottom, which
            // is what put a screenful of dead space above a subagent report
            // that does not fill the view. Scoping the anchor to `.sizeChanges`
            // keeps the useful half — the view sticks to the bottom as the
            // child streams — while content that fits simply starts at the top.
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    TranscriptView(blocks: store.blocks, tokens: tokens)
                }
            }
            .defaultScrollAnchor(.bottom, for: .sizeChanges)
        }
        .background(tokens.canvas.ignoresSafeArea())
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .onAppear { store.start() }
        .onDisappear { store.stop() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("subagent-scene")
    }
}

// MARK: - Todos card (scope item 4)

private struct TodosCard: View {
    let items: [StreamTodoItem]
    let tokens: Tokens

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            ForEach(items, id: \.id) { item in
                HStack(spacing: Metrics.spacing.sp2) {
                    Image(systemName: item.status == "completed" ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: Metrics.type.xs))
                        .foregroundColor(item.status == "completed" ? tokens.ok : tokens.accent)
                    Text(item.content ?? "")
                        .font(.system(size: Metrics.type.small))
                        .foregroundColor(tokens.tx2)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.radius.md)
                .stroke(tokens.borderSubtle, lineWidth: Metrics.spacing.spPx)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("todos-card")
    }
}

// MARK: - Permission card (answerable, §7.5)

private struct PermissionCard: View {
    let permission: PermissionRequest
    let tokens: Tokens
    let onReply: (PermissionReply) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            Text("Permission needed")
                .font(.system(size: Metrics.type.xs, weight: mantaFontWeight(Metrics.type.semibold)))
                .foregroundColor(tokens.tx4)
            Text(summary)
                .font(.system(size: Metrics.type.body))
                .foregroundColor(tokens.tx1)
                .lineLimit(3)
            HStack(spacing: Metrics.spacing.sp2) {
                replyButton("Allow once", reply: .once, filled: true)
                replyButton("Allow always", reply: .always, filled: false)
                Spacer()
                Button {
                    onReply(.reject)
                } label: {
                    Text("Reject")
                        .font(.system(size: Metrics.type.small, weight: .medium))
                        .foregroundColor(tokens.danger)
                }
            }
        }
        .padding(Metrics.spacing.sp3)
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.radius.md)
                .stroke(tokens.borderSubtle, lineWidth: Metrics.spacing.spPx)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("permission-card")
    }

    private var summary: String {
        if let patterns = permission.patterns, !patterns.isEmpty {
            return patterns.joined(separator: " · ")
        }
        return permission.permission
    }

    private func replyButton(_ label: String, reply: PermissionReply, filled: Bool) -> some View {
        Button {
            onReply(reply)
        } label: {
            Text(label)
                .font(.system(size: Metrics.type.small, weight: .semibold))
                .foregroundColor(filled ? tokens.onAccent : tokens.accentTx)
                .padding(.horizontal, Metrics.spacing.sp3)
                .padding(.vertical, Metrics.spacing.sp2)
                .background(filled ? tokens.accentSolid : tokens.accentSoft, in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Question card (answerable, §7.5)

private struct QuestionCard: View {
    let question: QuestionRequest
    let tokens: Tokens
    let onSubmit: ([[String]]) -> Void
    let onReject: () -> Void

    /// Per-question selected option indices (keyed by the question's position
    /// in `question.questions`) — a request can carry several questions and
    /// each keeps its own selection, so option index 0 on question A cannot
    /// bleed into question B.
    @State private var selected: [Int: Set<Int>] = [:]
    @State private var customText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
            ForEach(Array(question.questions.enumerated()), id: \.offset) { index, q in
                VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                    if !q.header.isEmpty {
                        Text(q.header)
                            .font(.system(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.semibold)))
                            .foregroundColor(tokens.tx1)
                    }
                    Text(q.question)
                        .font(.system(size: Metrics.type.body))
                        .foregroundColor(tokens.tx1)
                    ForEach(Array(q.options.enumerated()), id: \.offset) { oi, option in
                        optionButton(questionIndex: index, optionIndex: oi, label: option.label, multi: q.multiple == true)
                    }
                }
            }
            // Always-available free text (the desktop QuestionCard shows it for
            // ANY question, not just custom:true). It must NOT be gated on its
            // own non-empty state — that gate would make the field that is its
            // only writer unreachable, so free-form questions could never be
            // answered.
            TextField("Or type your own answer…", text: $customText)
                .font(.system(size: Metrics.type.small))
                .foregroundColor(tokens.tx1)
                .padding(.horizontal, Metrics.spacing.sp3)
                .padding(.vertical, Metrics.spacing.sp2)
                .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
            HStack {
                Button("Reject", action: onReject)
                    .font(.system(size: Metrics.type.small, weight: .medium))
                    .foregroundColor(tokens.danger)
                Spacer()
                Button { submit() } label: {
                    Text("Send")
                        .font(.system(size: Metrics.type.small, weight: .semibold))
                        .foregroundColor(canSubmit ? tokens.onAccent : tokens.tx4)
                        .padding(.horizontal, Metrics.spacing.sp3)
                        .padding(.vertical, Metrics.spacing.sp2)
                        .background(canSubmit ? AnyShapeStyle(tokens.accentSolid) : AnyShapeStyle(tokens.inset), in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(!canSubmit)
            }
        }
        .padding(Metrics.spacing.sp3)
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.radius.md)
                .stroke(tokens.borderSubtle, lineWidth: Metrics.spacing.spPx)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("question-card")
    }

    /// Submit is enabled when every question has a selection (or the shared
    /// free text, which counts for all) — matching the desktop canSubmitQuestion.
    private var canSubmit: Bool {
        ChatQuestionAnswers.canSubmit(
            questions: question.questions,
            selected: selected,
            customText: customText
        )
    }

    private func optionButton(questionIndex: Int, optionIndex: Int, label: String, multi: Bool) -> some View {
        let isOn = selected[questionIndex, default: []].contains(optionIndex)
        return Button {
            toggle(questionIndex: questionIndex, optionIndex: optionIndex, multi: multi)
        } label: {
            HStack(spacing: Metrics.spacing.sp2) {
                Image(systemName: isOn ? "checkmark.square.fill" : "square")
                    .font(.system(size: Metrics.type.xs))
                    .foregroundColor(isOn ? tokens.accent : tokens.tx4)
                Text(label)
                    .font(.system(size: Metrics.type.small))
                    .foregroundColor(tokens.tx1)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .padding(.vertical, Metrics.spacing.sp1)
        }
        .buttonStyle(.plain)
    }

    private func toggle(questionIndex: Int, optionIndex: Int, multi: Bool) {
        var perQuestion = selected[questionIndex, default: []]
        if multi {
            if perQuestion.contains(optionIndex) { perQuestion.remove(optionIndex) } else { perQuestion.insert(optionIndex) }
        } else {
            perQuestion = [optionIndex]
        }
        selected[questionIndex] = perQuestion
    }

    private func submit() {
        onSubmit(
            ChatQuestionAnswers.answers(
                questions: question.questions,
                selected: selected,
                customText: customText
            )
        )
    }
}
