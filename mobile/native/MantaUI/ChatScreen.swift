import SwiftUI
import UIKit

// ===========================================================================
// S4 — chat screen wired to live data (BET-596).
//
// Replaces the SessionListView tap target (was a placeholder). This screen
// binds to a ChatSessionStore (live transcript + status + todos + context +
// answerable permissions/questions) and renders through the EXISTING
// TranscriptComponents (§8/§8a): there is no second transcript renderer.
//
// Container per BET-481: ScrollView + LazyVStack — do NOT re-measure or replace.
// The scroll anchor is the one part that moved: it is scoped to `.sizeChanges`
// and the initial landing is an explicit post-layout scroll (see `transcript`).
// Subagent rows PUSH a live child
// screen via NavigationStack (parent scroll untouched; BET-576 binds the child
// to the same observable source).
//
// No colour/spacing/radius/size/weight literal; every value resolves through
// the generated tokens.
// ===========================================================================

/// The BET-627 overflow-sheet items that present a card of their own.
///
/// Attaching is NOT one of them: the composer carries its own paperclip, so a
/// second entry point in the overflow sheet was a duplicate of a control that
/// is already one tap away, in a sheet you have to open first.
private enum OverflowDestination: String, Identifiable {
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
    /// Whether the one-shot "open at the newest message" scroll has run.
    @State private var didLandAtBottom = false

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
        //
        // The lifecycle hooks live on the OUTER view, not inside the loading
        // branch: switching branch would otherwise fire onDisappear and stop
        // the permission poll, which `start()`'s run-once guard would then
        // refuse to restart.
        content
            .toolbar(.hidden, for: .navigationBar)
            .navigationBarBackButtonHidden(true)
            .onAppear {
                // Three independent fetches, all started together: the
                // transcript, the model list (previously not fetched until the
                // picker was opened, so the first open always stalled) and the
                // window/branch lookup.
                store.start()
                modelStore.load()
                Task { await resolveWindowAndBranch() }
            }
            .onDisappear { store.stop() }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-screen")
    }

    /// While the session loads there is nothing to act on, so the screen shows
    /// ONLY the loader — no header, no composer, no cards. Hiding the chrome
    /// outright is both honest (a disabled control still invites a tap) and
    /// simpler than keeping every control in a disabled state.
    @ViewBuilder
    private var content: some View {
        if store.loading {
            MantaLoader(caption: "Loading session…", tokens: tokens)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(tokens.canvas.ignoresSafeArea())
        } else {
            loadedLayout
        }
    }

    private var loadedLayout: some View {
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
        // The bottom stack is an OVERLAY, not a safeAreaInset.
        //
        // As an inset, the composer's height was part of the scroll view's
        // layout: every line the text gained shrank the viewport, and with the
        // transcript anchored to its bottom the content shifted by the same
        // amount. So growing the composer scrolled the conversation — on the
        // first wrap and on every line break after it.
        //
        // As an overlay it takes no layout space, so the viewport never
        // changes size and the transcript does not move at all while the
        // composer grows; the composer simply covers more of it. The space the
        // inset used to reserve is now a fixed spacer at the tail of the scroll
        // content (see `transcript`), sized for the composer at REST — so the
        // last message still comes to rest above a compact composer, and a
        // grown one overlaps content that is dimmed by the scrim below rather
        // than pushing it.
        .overlay(alignment: .bottom) {
            VStack(spacing: 0) {
                bottomCards
                // BET-630 (D1): the running-state working row. Shown only while a
                // turn runs; the ambient refetch sweep lives on the composer's
                // border and means a different thing, so the two never share an
                // indicator. Not shown during a background refetch.
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
            // Transcript text passing behind the composer fades out instead of
            // competing with it. Shared with the session list's search capsule
            // — same gesture, one component. Bounded to this overlay rather
            // than the screen, so it rides up with the composer when the
            // keyboard opens.
            .background { Scrim(edge: .bottom, tokens: tokens) }
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
        // The header is an OVERLAY so the transcript runs full-bleed and the
        // conversation scrolls under the floating buttons — that is the whole
        // point of floating them.
        //
        // It was previously an inset for a real reason: as an overlay nothing
        // reserved its space, so the first rows sat under it and were clipped
        // AT REST, not just mid-scroll. That failure is why the transcript now
        // carries its own top inset (see `transcript`) — the space is reserved
        // by the scroll content instead of by the header, which is what lets
        // rows pass beneath the glass while still coming to rest below it.
        // Top scrim UNDER the header buttons (declared first, so it draws
        // below them). The chat screen hides the navigation bar, so it gets
        // none of the system's own scroll-edge treatment — which is what the
        // session list has and why its top edge reads cleanly. Without this
        // the transcript runs straight under the clock and the battery.
        .overlay(alignment: .top) {
            Scrim(edge: .top, tokens: tokens)
                .frame(height: Self.headerReservedHeight + Metrics.spacing.sp6)
        }
        .overlay(alignment: .top) { header }
        .sheet(isPresented: $showOverflow) { overflowSheet }
        .sheet(item: $overflowDestination) { destination in
            destinationCard(destination)
        }
    }

    // MARK: - Overflow sheet (§8)

    private var overflowSheet: some View {
        ChatOverflowSheet(
            sessionTitle: title,
            projectName: projectName,
            branch: branch,
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

    /// The BET-627 overflow items that present their cards here.
    @ViewBuilder
    private func destinationCard(_ destination: OverflowDestination) -> some View {
        switch destination {
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

    /// Two floating glass circles over the transcript — nothing else.
    ///
    /// The title and subtitle were removed: the session name is already the row
    /// you tapped to get here, so repeating it costs a whole bar of vertical
    /// space to say something the user just read. Without it there is no
    /// content to seat, so the bar itself goes too — the buttons float directly
    /// on the transcript and the conversation scrolls beneath them.
    ///
    /// Each button carries its own glass circle, so the material is
    /// per-control rather than one edge-to-edge sheet.
    private var header: some View {
        // Liquid Glass, the iOS 26 system material — the same treatment the
        // session list's search capsule uses, rather than the flat
        // `.ultraThinMaterial` disc these carried before. A GlassEffectContainer
        // groups the two so the system can relate them as one piece of chrome
        // instead of two unrelated blurs.
        GlassEffectContainer(spacing: Metrics.spacing.sp2) {
            HStack(spacing: Metrics.spacing.sp2) {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: Metrics.type.body, weight: .semibold))
                        .foregroundColor(tokens.tx1)
                        .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
                        .glassEffect(.regular.interactive(), in: .circle)
                        .accessibilityLabel("Back to sessions")
                }
                .buttonStyle(.plain)

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
                        .glassEffect(.regular.interactive(), in: .circle)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Session actions")
            }
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
    }

    // MARK: - Transcript (BET-481 container; anchor + landing corrected)

    /// Id of the zero-height row that marks the end of the transcript. Scrolling
    /// to a real anchor is what makes the landing deterministic (see below).
    private static let bottomAnchorID = "transcript-bottom"

    /// Space the transcript reserves for the floating header: the 38pt button
    /// plus the header's own vertical padding on both sides. Derived from the
    /// same tokens the header lays itself out with, so retuning the button size
    /// or the padding moves both together instead of leaving a magic number
    /// here to drift out of sync.
    private static let headerReservedHeight =
        Metrics.type.chatHeaderBtn + Metrics.spacing.sp2 * 2

    /// Space the transcript reserves for the floating composer.
    ///
    /// FIXED, and deliberately sized for the composer at REST rather than
    /// tracking its live height. Tracking is what the safeAreaInset used to do,
    /// and it is precisely why the transcript lurched every time the text
    /// wrapped. A constant means the viewport never changes, so the
    /// conversation holds still while the composer grows over it.
    ///
    /// Covers the model-chip row, the compact input box and the stack's own
    /// vertical padding — all from the tokens those are laid out with.
    private static let composerReservedHeight =
        Metrics.type.chatHeaderBtn          // compact input row
        + Metrics.spacing.sp1 * 2           // its vertical padding
        + Metrics.type.small + Metrics.spacing.sp1 * 2  // model chip row
        + Metrics.spacing.sp2 * 3           // stack spacing + outer padding

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    // Reserves the floating header's height INSIDE the scroll
                    // content. The header is an overlay and reserves nothing
                    // itself, so without this the first row rests underneath
                    // the glass instead of below it. Putting the space here
                    // rather than on the header is what lets content pass under
                    // the buttons while scrolling and still land clear of them —
                    // a safeAreaInset would push content down permanently and
                    // leave nothing to scroll under.
                    Color.clear.frame(height: Self.headerReservedHeight)
                    if store.hasEarlier {
                        LoadEarlierRow(loading: store.loadingEarlier, tokens: tokens) {
                            store.loadEarlier()
                        }
                    }
                    TranscriptView(blocks: store.blocks, tokens: tokens)
                    // The end-of-transcript marker. Zero-height and invisible;
                    // it exists only so `scrollTo` has something stable to aim
                    // at that is guaranteed to be the last thing in the stack.
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomAnchorID)
                    // Reserve for the floating composer, inside the scroll
                    // content — the mirror of the header spacer at the top.
                    // The composer is an overlay and reserves nothing itself,
                    // so without this the last message would rest underneath
                    // it. AFTER the anchor, so "scroll to bottom" still lands
                    // on the last message rather than on empty space.
                    Color.clear.frame(height: Self.composerReservedHeight)
                }
                // Pin the content to the scroll view's own width. A vertical scroll
                // view otherwise sizes itself to its WIDEST child, so one long line
                // of tool output widens the whole screen and drags the composer off
                // with it.
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollClipDisabled(false)
            // Scoped to `.sizeChanges` — the same correction the subagent screen
            // already carries, for the same reason plus one more:
            //
            //  * `.bottom` in its all-roles form also decides the INITIAL offset,
            //    and it decides it from the content height known at the first
            //    layout pass. A LazyVStack has not measured the rows below the
            //    viewport at that point and prose rows resolve their height a
            //    pass or two later, so the offset it picks stops corresponding to
            //    the bottom the moment the real heights land — which is the blank
            //    transcript that only a manual scroll repairs.
            //  * It also bottom-ALIGNS content shorter than the viewport, leaving
            //    a screenful of dead space above a short session.
            //
            // Keeping only the size-changes role preserves the half that is
            // wanted (the view sticks to the bottom as a turn streams) and hands
            // the initial landing to the explicit scroll below, which runs after
            // layout and therefore aims at a height that is actually real.
            .defaultScrollAnchor(.bottom, for: .sizeChanges)
            .scrollDismissesKeyboard(.interactively)
            // Dragging the transcript already lowers the keyboard; a TAP on it now
            // does the same, which is what "put the keyboard away so I can read"
            // looks like on iOS. A simultaneous gesture, so it neither blocks the
            // scroll (a tap that moves is not a tap) nor swallows taps on rows that
            // have their own action — a subagent row still pushes its child.
            .simultaneousGesture(TapGesture().onEnded { resignKeyboard() })
            .task { await landAtBottom(proxy) }
        }
    }

    /// Put the freshly-opened session at its newest message.
    ///
    /// Runs once per screen, never again: re-running it on every content change
    /// would yank the viewport back down while the user is reading history.
    /// Streaming stickiness is the scroll anchor's job, not this one's.
    ///
    /// It scrolls more than once on purpose. The lazy stack materialises rows
    /// over several layout passes, so a single scroll issued on the first pass
    /// lands short of the end; repeating it across the next couple of passes
    /// converges on the real bottom. Each pass is a no-op once the view is
    /// already there.
    private func landAtBottom(_ proxy: ScrollViewProxy) async {
        guard !didLandAtBottom else { return }
        didLandAtBottom = true
        for delayNs in [UInt64(0), 50_000_000, 250_000_000] {
            if delayNs > 0 { try? await Task.sleep(nanoseconds: delayNs) }
            guard !Task.isCancelled else { return }
            proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
        }
    }

    /// Lower the keyboard by asking whoever holds first responder to give it
    /// up. The composer's focus binding lives inside ComposerView, and routing
    /// a "please blur" signal down to it would mean threading state through a
    /// sibling view for one gesture.
    private func resignKeyboard() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    // MARK: - Loading skeleton (D2 / BET-631)

    /// Transcript-shaped loading placeholder, shown while the session's first
    /// transcript fetch is in flight. Renders the shared `ChatLoadingSkeleton`
    /// (single source of truth — the same one the capture fixture uses) which
    /// replaces the transcript in place: no layout shift, no full-screen
    /// spinner.
    private var loadingSkeleton: some View {
        ChatLoadingSkeleton()
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
                    if store.hasEarlier {
                        LoadEarlierRow(loading: store.loadingEarlier, tokens: tokens) {
                            store.loadEarlier()
                        }
                    }
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
