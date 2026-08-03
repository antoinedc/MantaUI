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

struct ChatScreen: View {
    let title: String
    let projectName: String
    @ObservedObject var eventStore: MantaEventStore
    @StateObject private var store: ChatSessionStore
    @StateObject private var modelStore: ChatModelStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    init(sessionId: String, title: String, projectName: String, eventStore: MantaEventStore) {
        self.title = title
        self.projectName = projectName
        self.eventStore = eventStore
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
            } else {
                transcript
            }
        }
        .background(tokens.canvas.ignoresSafeArea())
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 0) {
                bottomCards
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
        .onAppear { store.start() }
        .onDisappear { store.stop() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-screen")
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

            // Trailing 38×38 glass button (§8) — a tappable placeholder in S4.
            // Inert until BET-626 builds the real overflow sheet; it carries a
            // stable identifier so the simulator capture driver (BET-625) and
            // BET-626 can both address it. No action yet — BET-626 wires it.
            Button(action: {}) {
                Image(systemName: "ellipsis")
                    .font(.system(size: Metrics.type.body, weight: .semibold))
                    .foregroundColor(tokens.tx1)
                    .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
                    .background(.ultraThinMaterial, in: Circle())
                    .accessibilityLabel("More options")
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("overflow-button")
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
        }
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
    }

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
