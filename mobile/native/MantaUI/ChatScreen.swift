import SwiftUI
import UIKit
import MessagingUI

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
    /// Drives MessagingUI's `TiledView` scroll layer: stays on the newest
    /// message as content streams and the composer/keyboard resize, and stops
    /// following the moment the user scrolls away. This replaces the whole
    /// hand-rolled geometry/keyboard/landing machinery.
    @State private var scrollPosition = TiledScrollPosition(
        autoScrollsToBottomOnAppend: true,
        scrollsToBottomOnReplace: true
    )
    /// Whether the transcript has been scrolled up far enough that the round
    /// "scroll to bottom" control (rendered in ComposerView's model-selection
    /// row) should be shown. Driven purely by scroll geometry; it does not
    /// touch auto-follow, which stays constant so new messages pin smoothly.
    @State private var showScrollToBottom = false
    /// Measured height of the floating bottom bar (cards + composer), so the
    /// transcript can reserve exactly that much space and the newest message is
    /// never pinned underneath the composer while it floats over the tail.
    @State private var bottomBarHeight: CGFloat = 0

    /// How far the bottom scrim reaches past the safe area. Comfortably clears
    /// the tallest home indicator; when the keyboard is up it falls behind the
    /// keyboard, where there is nothing to dim.
    private static let scrimOverhang: CGFloat = 44

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
            // Hiding the bar also kills the left-edge interactive pop gesture;
            // this re-arms it so sliding back returns to the session list.
            .background(EdgeSwipeRestorer())
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
        // The bottom stack is a safeAreaInset, which reserves its space by
        // SHRINKING the scroll view. That is the whole point.
        //
        // Reserving the space the other way — by EXTENDING the scroll content
        // (a trailing spacer, or a bottom contentMargin) — is what blanked the
        // transcript on every keyboard open. The old scroll view carried
        // `.defaultScrollAnchor(.bottom, for:.sizeChanges)` and re-pinned to
        // the END of its content whenever it resized; with reserved space
        // inside the content, the end was that blank space and the conversation
        // scrolled off screen. MessagingUI's TiledView (see `transcript`)
        // reserves this same space by shrinking the viewport rather than by
        // extending content, which is the same principle.
        //
        // Accepted trade-off: because the inset shrinks the viewport, the
        // composer now PUSHES the transcript's tail up as it grows a line at a
        // time, rather than floating over it. The tail moving is the correct
        // failure mode; a blank transcript is not.
        //
        // The composer is deliberately JUST its own glass elements — there is
        // NO opaque backdrop on the inset. A scroll view still DRAWS its
        // content underneath a safe-area inset while scrolling, so the
        // transcript visibly slides beneath the glass composer (which blurs
        // it) instead of behind a solid bar. The todos card is pinned to the
        // bottom of this stack, in the transcript area; the running-state row
        // lives INSIDE the transcript as its typing indicator (see
        // `transcript`), so it is not duplicated here.
        // The bottom chrome (cards + composer) is an OVERLAY, not a safeAreaInset.
        //
        // As an inset it shrank the scroll viewport, so content never rendered
        // UNDER the composer and there was nothing for a scrim to dim. As an
        // overlay the transcript stays full-bleed and content genuinely passes
        // beneath the composer while scrolling — where the scrim below fades it.
        // Scrim FIRST so it draws beneath the composer. It is its own
        // bottom-aligned overlay sized to the composer plus an OVERHANG past the
        // safe area, so the ramp darkens content under the composer AND in the
        // home-indicator strip below it (which a plain safe-area-bounded scrim
        // leaves bright). No margin above the composer's top edge — the fade
        // begins exactly at it, so it reads as the composer's backdrop rather
        // than a shadow cast on the transcript.
        .overlay(alignment: .bottom) {
            Scrim(edge: .bottom, tokens: tokens, overhang: Self.scrimOverhang)
                .frame(height: bottomBarHeight + Self.scrimOverhang)
                .allowsHitTesting(false)
        }
        .overlay(alignment: .bottom) {
            VStack(spacing: 0) {
                bottomCards
                ComposerView(
                    sessionId: store.sessionId,
                    projectName: projectName,
                    api: MantaAPIClient.live(),
                    store: store,
                    modelStore: modelStore,
                    showScrollToBottom: showScrollToBottom,
                    onScrollToBottom: {
                        scrollPosition.scrollTo(edge: .bottom, animated: true)
                        showScrollToBottom = false
                    }
                )
            }
            // Feeds the scrim (and the transcript's footer reservation) its
            // live height. Safe to measure here: it is an overlay, so nothing
            // it reports changes the transcript's layout.
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.size.height
            } action: { height in
                bottomBarHeight = height
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
        // Carry the chosen model + effort to the new session id before the
        // wrapper rebuilds the stores against it (matching the desktop's clear,
        // which copies the override into the new session's key). The catalog
        // already holds the box-wide model list, so nothing reloads.
        modelStore.rebind(to: newId)
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
                // The system's own glass BUTTON style, NOT a plain button with
                // `.glassEffect` layered over its label. The layered form
                // renders correctly and then eats the touch — the button looks
                // right and does nothing, which is exactly what happened to the
                // ⋯ menu here. SessionListView's `+` carries the same note; it
                // learned this first.
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: Metrics.type.body, weight: .semibold))
                        .foregroundColor(tokens.tx1)
                        .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
                }
                .buttonStyle(.glass)
                .clipShape(.circle)
                .accessibilityLabel("Back to sessions")

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
                }
                .buttonStyle(.glass)
                .clipShape(.circle)
                .accessibilityLabel("Session actions")
            }
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
    }

    // MARK: - Transcript (BET-481 container; anchor + landing corrected)

    /// Space the transcript reserves for the floating header: the 38pt button
    /// plus the header's own vertical padding on both sides. Derived from the
    /// same tokens the header lays itself out with, so retuning the button size
    /// or the padding moves both together instead of leaving a magic number
    /// here to drift out of sync.
    private static let headerReservedHeight =
        Metrics.type.chatHeaderBtn + Metrics.spacing.sp2 * 2

    private var transcript: some View {
        // MessagingUI's TiledView owns the whole scroll layer: smooth
        // bottom-follow on append/replace, keyboard + safe-area insets, and
        // prepend-without-jump when older messages load. This deliberately
        // replaces the hand-rolled ScrollView + LazyVStack + geometry/keyboard/
        // landing machinery that was the source of the device-only blank-on-
        // open, snap, and disappear-on-scroll bugs.
        TiledView(dataSource: store.dataSource, scrollPosition: $scrollPosition) { row in
            TranscriptBlockCell(item: row, tokens: tokens)
        }
        // Reserves the floating header's height. The header is an overlay and
        // reserves nothing itself, so the conversation must rest below it.
        .headerContent(.header {
            Color.clear.frame(height: Self.headerReservedHeight)
        })
        // Older messages load as you reach the top; TiledView's virtual layout
        // inserts them without a scroll jump.
        .prependLoader(.loader(
            perform: { store.loadEarlier() },
            isProcessing: store.loadingEarlier
        ) {
            LoadEarlierRow(loading: store.loadingEarlier, tokens: tokens) {}
        })
        // The running-state working row rendered as MessagingUI's typing
        // indicator: a genuine row BELOW the last message, inside the scroll
        // content — not floating chrome. It pins to the bottom because that is
        // where the newest content sits, appears only while a turn runs, and
        // vanishes when it ends. (BET-630 D1; the ambient refetch sweep lives
        // on the composer's border and means a different thing, so the two
        // never share an indicator.)
        .typingIndicator(.indicator(isVisible: store.running) {
            RunningIndicator(store: store)
        })
        // The "scroll to bottom" control (rendered in ComposerView's
        // model-selection row). It shows only once the user has scrolled up
        // (pointsFromBottom above the threshold) — at the bottom there is
        // nowhere to return to, so the button would be noise.
        //
        // Auto-follow is left constant (see init) so new messages pin to the
        // newest turn smoothly. It must NOT be toggled from this geometry
        // callback: when a message appends while the user is at the bottom,
        // content grows before the scroll catches up, so pointsFromBottom
        // briefly spikes past the threshold — toggling auto-follow off there
        // makes every new event stop following then re-latch, which is exactly
        // the "transcript goes up and back down" jump. Driving only the button
        // from geometry keeps that from happening.
        //
        // These TiledView-only modifiers must be chained BEFORE
        // `.simultaneousGesture` below: `onTiledScrollGeometryChange` is a
        // method on the concrete TiledView type (it returns `Self`), not a
        // `View` modifier — once a `View` modifier like `.simultaneousGesture`
        // erases the type to `some View`, the compiler no longer sees it.
        .onTiledScrollGeometryChange { geometry in
            showScrollToBottom = geometry.pointsFromBottom > Self.scrollToBottomThreshold
        }
        // A tap on the transcript lowers the keyboard. (TiledView handles the
        // scroll-driven interactive keyboard dismiss itself.)
        .simultaneousGesture(TapGesture().onEnded { resignKeyboard() })
    }
    /// How far above the bottom the user must scroll for the down-arrow to
    /// appear. Same magnitude MessagingUI uses internally for its own "near
    /// bottom" checks.
    private static let scrollToBottomThreshold: CGFloat = 100

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
            if let todos = store.todos, !(todos.visible?.visible ?? todos.active ?? []).isEmpty {
                TodosCard(payload: todos, tokens: tokens)
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
        .background(EdgeSwipeRestorer())
        .onAppear { store.start() }
        .onDisappear { store.stop() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("subagent-scene")
    }
}

// MARK: - Todos card (scope item 4)

private struct TodosCard: View {
    let payload: StreamTodosPayload
    let tokens: Tokens

    /// The rows to draw: the box already computes the "top 5 + hidden counts"
    /// window (`visible`), so prefer it and fall back to the raw active list.
    private var rows: [StreamTodoItem] {
        payload.visible?.visible ?? payload.active ?? []
    }

    /// The one overflow summary line, or nil when nothing is hidden. Mirrors
    /// the desktop's formatHiddenTodosSummary: "+ 2 pending & 1 done" /
    /// "+ 2 pending" / "+ 1 done", omitting a zero side. Singular/plural is
    /// not varied — the desktop prints "pending"/"done" unchanged.
    private var overflowSummary: String? {
        guard let v = payload.visible else { return nil }
        var parts: [String] = []
        if v.hiddenPending > 0 { parts.append("\(Int(v.hiddenPending)) pending") }
        if v.hiddenDone > 0 { parts.append("\(Int(v.hiddenDone)) done") }
        guard !parts.isEmpty else { return nil }
        return "+ \(parts.joined(separator: " & "))"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            // The box's todo items carry NO id field, ever, so every item's
            // `id` is nil and keying on it gives every row the SAME identity —
            // SwiftUI then renders one row's content repeated N times. Key on
            // array POSITION instead: position IS the identity here, exactly as
            // the desktop card does (src/renderer/MessageRow.tsx, ActiveTodos).
            ForEach(Array(rows.enumerated()), id: \.offset) { pair in
                todoRow(pair.element)
            }
            if let overflowSummary {
                Text(overflowSummary)
                    .font(.system(size: Metrics.type.xs))
                    .foregroundColor(tokens.tx4)
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

    /// One todo row. Status styling matches the desktop; `status` is compared
    /// case-INSENSITIVELY (the desktop lowercases before comparing, iOS did
    /// not). The mark aligns to the FIRST line so a two-line item keeps the
    /// icon beside its opening words rather than centred against both.
    // `@MainActor` because this reads `mantaFontWeight`, which is main-actor
    // isolated. Only `View.body` carries that isolation implicitly, and this is
    // a plain helper — every other call site in the app happens to sit directly
    // in a `body`, so the annotation has never been needed before. Harmless if
    // the isolation is inferred anyway; a build error if it is not.
    @MainActor
    @ViewBuilder
    private func todoRow(_ item: StreamTodoItem) -> some View {
        let status = (item.status ?? "").lowercased()
        HStack(alignment: .top, spacing: Metrics.spacing.sp2) {
            Image(systemName: markName(status))
                .font(.system(size: Metrics.type.xs))
                .foregroundColor(markColor(status))
            Text(item.content ?? "")
                .font(.system(size: Metrics.type.small, weight: status == "in_progress" ? mantaFontWeight(Metrics.type.semibold) : .regular))
                .foregroundColor(textColor(status))
                .strikethrough(status == "cancelled")
                // A todo's text must not be silently clipped to one line.
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }

    private func markName(_ status: String) -> String {
        switch status {
        case "completed": return "checkmark.circle.fill"
        case "cancelled": return "xmark.circle"
        case "in_progress": return "circle.dotted"
        default: return "circle"
        }
    }

    private func markColor(_ status: String) -> Color {
        switch status {
        case "completed": return tokens.ok
        case "in_progress": return tokens.accent
        default: return tokens.tx4
        }
    }

    private func textColor(_ status: String) -> Color {
        switch status {
        case "completed", "cancelled": return tokens.tx4
        case "in_progress": return tokens.tx1
        default: return tokens.tx2
        }
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
