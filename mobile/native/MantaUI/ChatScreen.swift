import SwiftUI
import UIKit
import UserNotifications
import MessagingUI

// ===========================================================================
// S4 — chat screen wired to live data (BET-596).
//
// Replaces the SessionListView tap target (was a placeholder). This screen
// binds to a ChatSessionStore (live transcript + status + todos + context +
// answerable permissions/questions) and renders through the EXISTING
// TranscriptComponents (§8/§8a): there is no second transcript renderer.
//
// The transcript container is MessagingUI `TiledView` (UICollectionView-backed),
// fed a snapshot of `store.rows`.
// Subagent rows PUSH a live child
// screen via NavigationStack (parent scroll untouched; BET-576 binds the child
// to the same observable source).
//
// No colour/spacing/radius/size/weight literal; every value resolves through
// the generated tokens.
// ===========================================================================

// ===========================================================================
// BET-752 task 3 — which region the session-loading branch renders.
//
// The transcript skeleton (`ChatLoadingSkeleton`) — NOT the full-screen mark
// loader (`MantaLoader`) — is the loading state. Kept as a pure decision at
// file scope so a unit test can pin the wiring without rendering a SwiftUI
// hierarchy.
// ===========================================================================
enum ChatLoadingMode { case skeleton; case content }

func chatLoadingMode(isLoading: Bool) -> ChatLoadingMode {
    isLoading ? .skeleton : .content
}

/// Pure decision behind the branch-freshness poll (BET-747 gap #13). The chat
/// polls the branch on the desktop's 5s cadence and refreshes on submit, so a
/// terminal-side `git checkout` reflects within one tick. Extracted at file
/// scope so the tick decision is unit-testable with an injected clock without
/// rendering a SwiftUI hierarchy.
enum BranchFreshnessPolicy {
    /// The desktop's branch-poll cadence.
    static let pollInterval: TimeInterval = 5

    /// Whether a tick at `now` warrants a refetch, given `lastFetch`. No prior
    /// fetch always refetches; otherwise a tick refetches once the interval has
    /// elapsed. (A submit unconditionally refetches — see `shouldRefresh`.)
    static func shouldRefetchAfterTick(now: Date, lastFetch: Date?) -> Bool {
        guard let lastFetch else { return true }
        return now.timeIntervalSince(lastFetch) >= pollInterval
    }

    /// Whether a branch refresh is warranted for the given trigger. A submit —
    /// a turn just started running, so the next message may land on a
    /// freshly-checked-out branch — ALWAYS refetches, even if the 5s interval
    /// has not yet elapsed. A tick (no submit) follows `shouldRefetchAfterTick`.
    static func shouldRefresh(didSubmit: Bool, now: Date, lastFetch: Date?) -> Bool {
        if didSubmit { return true }
        return shouldRefetchAfterTick(now: now, lastFetch: lastFetch)
    }
}

/// Head-first truncation for a branch label (BET-821). The TAIL of a branch
/// name is what distinguishes it (`…/BET-781-very-long`, never the front), so
/// when the name no longer fits it is the leading namespace that gets dropped.
/// Extracted at file scope so the rule is unit-testable without a SwiftUI
/// hierarchy, mirroring `BranchFreshnessPolicy`.
enum BranchLabel {
    /// Shorten `branch` to at most `maxChars`, keeping the distinguishing tail
    /// and gaining a leading ellipsis. Returns the branch unchanged when it
    /// already fits, and the empty string unchanged.
    static func display(_ branch: String, maxChars: Int = 28) -> String {
        guard !branch.isEmpty else { return "" }
        if branch.count <= maxChars { return branch }
        // Reserve one character for the leading ellipsis; keep the tail.
        let keep = max(1, maxChars - 1)
        return "…" + branch.suffix(keep)
    }
}

/// The BET-627 overflow-sheet items that present a card of their own.
///
/// Attaching is NOT one of them: the composer carries its own paperclip, so a
/// second entry point in the overflow sheet was a duplicate of a control that
/// is already one tap away, in a sheet you have to open first.
private enum OverflowDestination: String, Identifiable {
    case schedules
    case secrets
    case artifacts

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
    /// Loads `chatAutoAllow` (trust mode) from the box via `config:get` and
    /// persists it over the store's own `config:update` path (BET-748). This is
    /// the chat surface's window into the same settings the Settings screen
    /// renders — no second `config:get`.
    @StateObject private var settingsStore: MantaSettingsStore
    /// The plan-usage snapshot set (BET-824), polled every 60s while the chat
    /// is open. Feeds the composer dot, the usage sheet and the weekly banner.
    @StateObject private var usageStore: UsageStore
    /// The conversation-scoped voice-note playback engine (BET-1029). Owned
    /// ABOVE the transcript list — a player owned by a recycled cell would be
    /// destroyed by scrolling; this one survives it and plays one note at a
    /// time. Injected into the transcript via `Environment`.
    @StateObject private var voicePlayer: VoicePlaybackEngine
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var sessionStore: SessionListStore
    @State private var showOverflow = false
    /// Context sheet — opened by tapping the context strip.
    @State private var showContextSheet = false
    /// Usage sheet — opened by tapping the composer's usage dot, or the weekly
    /// banner's Details.
    @State private var showUsageSheet = false
    /// One-per-session gate for the weekly ≥ 90% warning banner. Resets when
    /// the session changes (ChatScreenContent is rebuilt on a clear via `.id`).
    @State private var weeklyBannerShown = false
    @State private var branch: String?
    /// The session's working directory relative to the project root, shown
    /// alongside the branch capsule (BET-747).
    @State private var branchRelPath: String?
    /// When the branch was last fetched, so a 5s tick only refetches once the
    /// interval has elapsed (see `BranchFreshnessPolicy`).
    @State private var lastBranchFetch: Date?
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
    /// The transcript rows are passed to `TiledView(items:)` as a snapshot of
    /// `store.rows`; MessagingUI diffs it internally, so there is no separate
    /// data source or change log to keep in sync (BET-1105).
    /// Whether the transcript has been scrolled up far enough that the round
    /// "scroll to bottom" control (rendered in ComposerView's model-selection
    /// row) should be shown. Driven purely by scroll geometry; it does not
    /// touch auto-follow, which stays constant so new messages pin smoothly.
    @State private var showScrollToBottom = false
    /// Tracks whether a blocking card was present on the last render, so the
    /// auto-scroll on card arrival fires ONCE per no-card → card transition
    /// (never per rebuild) and re-arms when a card leaves (BET-1214).
    @State private var wasBlockingCardPresent = false

    /// Measured height of the floating bottom bar (cards + composer), fed to
    /// the transcript's `additionalContentInset` bottom inset so the newest
    /// message rests above the whole floating stack, not just the composer.
    @State private var bottomBarHeight: CGFloat = 0

    /// Measured height of the composer's glass input box alone (plus the
    /// composer's own bottom padding), reported by `ComposerView` via
    /// `onGlassBoxHeightChange`. Used to size the under-composer scrim so its
    /// fade starts at the glass box's top edge — not at the top of the whole
    /// bottom stack (pinned cards / jump-to-bottom chip / picker anchors sit
    /// above the glass box and must stay undimmed).
    @State private var composerGlassHeight: CGFloat = 0

    /// How far the under-composer scrim reaches past the safe area, so content
    /// scrolling into the home-indicator strip stays dimmed too.
    private static let scrimOverhang: CGFloat = 44

    /// Called with the NEW session id after a clear, so the wrapper can swap it.
    let onCleared: (String) -> Void
    /// The box client bound to this session's paired server. Shared by the two
    /// stores and used by the plan card to build the deterministic plan-page URL.
    private let api: MantaAPIClient

    init(sessionId: String, title: String, projectName: String, eventStore: MantaEventStore, path: Binding<NavigationPath>, onCleared: @escaping (String) -> Void) {
        self.title = title
        self.projectName = projectName
        self.eventStore = eventStore
        self._path = path
        self.onCleared = onCleared
        let api = MantaAPIClient.live()
        self.api = api
        _store = StateObject(wrappedValue: ChatSessionStore(
            sessionId: sessionId,
            eventStore: eventStore,
            api: api
        ))
        _modelStore = StateObject(wrappedValue: ChatModelStore(sessionId: sessionId, api: api))
        _settingsStore = StateObject(wrappedValue: MantaSettingsStore())
        _usageStore = StateObject(wrappedValue: UsageStore(api: api))
        _voicePlayer = StateObject(wrappedValue: VoicePlaybackEngine(api: api))
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
            .environmentObject(voicePlayer)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .mantaNavigationBarBackground(tokens)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showOverflow = true } label: {
                        Image(systemName: "ellipsis")
                    }
                    .accessibilityLabel("Session actions")
                }
            }
            .onAppear {
                // Three independent fetches, all started together: the
                // transcript, the model list (previously not fetched until the
                // picker was opened, so the first open always stalled) and the
                // window/branch lookup.
                store.start()
                modelStore.load()
                modelStore.loadAgentsIfNeeded()
                seedPlanModeFromBox()
                Task { await settingsStore.load() }
                usageStore.start()
                MantaPushRouter.shared.visibleSessionID = store.sessionId
                Task { try? await MantaAPIClient.live().reportFocus(sessionId: store.sessionId, visible: true) }
                clearDeliveredNotifications(for: store.sessionId)
                Task { await resolveWindowAndBranch() }
            }
            .onDisappear {
                store.stop()
                usageStore.stop()
                MantaPushRouter.shared.visibleSessionID = nil
                Task { try? await MantaAPIClient.live().reportFocus(sessionId: nil, visible: false) }
            }
            // BET-977: the box mirrors opencode's LOCAL plan_enter/plan_exit via
            // the `planMode` frame. Route it into the session's ChatModelStore
            // through `setPlan` — the SAME entry point the Plan chip's tap uses,
            // so the value is persisted per-session identically and there is no
            // second persistence path. Published edge-triggers on change, so this
            // fires once per actual plan-mode switch.
            .onReceive(store.$planOn) { on in
                if let on { modelStore.setPlan(on) }
            }
            // 5s branch poll (desktop cadence) so a terminal-side checkout
            // reflects within one tick (BET-747 gap #13). Cancelled on disappear.
            .task { await pollBranch() }
            // A submit starts a turn optimistically (`send()` sets running), so
            // refreshing the branch on the running edge covers "refresh on
            // submit" — the new message is written in `cwd`'s current branch
            // (which a terminal-side checkout just changed). Only the turn START
            // (running true) warrants it; the settle edge does not. The
            // submit-override decision is `BranchFreshnessPolicy.shouldRefresh`.
            .onChange(of: store.running) { _, running in
                if running, BranchFreshnessPolicy.shouldRefresh(didSubmit: true, now: Date(), lastFetch: nil) {
                    Task { await refreshBranch() }
                }
            }
            // BET-1214: a blocking card (permission / plan / question) can now be
            // scrolled away — it is a transcript-tail row, not a pinned overlay.
            // When a card ARRIVES while the user is following it is already in
            // view; the auto-scroll matters when they are scrolled away, so the
            // new ask is not silently missed. Fire ONCE on the no-card → card
            // transition, never per rebuild; re-arm when the card leaves.
            .onChange(of: isBlockingCardPresent) { _, nowPresent in
                let decision = ChatSessionStore.shouldScrollForCardArrival(nowPresent, wasPresent: wasBlockingCardPresent)
                if decision.scroll {
                    scrollPosition.scrollTo(edge: .bottom, animated: true)
                }
                wasBlockingCardPresent = decision.present
            }
            // BET-673: fire one success haptic when a turn completes while the
            // user has scrolled up (scroll-to-bottom chip showing) and the scene
            // is active and haptics are enabled. The store coalesces multi-message
            // turns into ONE `turnCompletionCount` per turn (BET-752 task 5), so
            // `onChange` fires at most once per turn — no more per-message
            // double-fires from `turnComplete` flapping on `message.updated`.
            .onChange(of: store.turnCompletionCount) { _, _ in
                if shouldFireTurnCompleteHaptic(
                    turnCompleteEdge: true,
                    showScrollToBottom: showScrollToBottom,
                    isActive: scenePhase == .active,
                    hapticsEnabled: sessionStore.hapticsEnabled
                ) {
                    SessionHaptics.fire(.success, enabled: true)
                }
            }
            .onChange(of: scenePhase) { _, phase in
                // Mirror foreground state to the box so it suppresses redundant
                // pushes for this session, and clear delivered notifications
                // when the user comes back to the screen. On background the
                // screen is still the top of the stack when the app returns,
                // so visibleSessionID stays set — only the box is told it's
                // not visible.
                switch phase {
                case .active:
                    MantaPushRouter.shared.visibleSessionID = store.sessionId
                    Task { try? await MantaAPIClient.live().reportFocus(sessionId: store.sessionId, visible: true) }
                    clearDeliveredNotifications(for: store.sessionId)
                case .background, .inactive:
                    Task { try? await MantaAPIClient.live().reportFocus(sessionId: nil, visible: false) }
                default:
                    break
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-screen")
    }

    /// While the session loads there is nothing to act on, so the screen shows
    /// ONLY the transcript-shaped skeleton — no header, no composer, no cards.
    /// Hiding the chrome outright is both honest (a disabled control still
    /// invites a tap) and simpler than keeping every control in a disabled
    /// state. The skeleton (`ChatLoadingSkeleton`) occupies the same scroll
    /// region the real transcript will, so the first blocks replacing it cause
    /// no layout shift (BET-752 task 3, reconnecting the built skeleton).
    @ViewBuilder
    private var content: some View {
        if chatLoadingMode(isLoading: store.loading) == .skeleton {
            ChatLoadingSkeleton()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(tokens.canvas.ignoresSafeArea())
                .accessibilityIdentifier("chat-loading-skeleton")
        } else {
            loadedLayout
        }
    }

    /// Drop the delivered notifications for a session the user just opened
    /// (or returned to) and zero the app-icon badge — the user is reading
    /// that session, so its notifications are consumed.
    private func clearDeliveredNotifications(for sessionId: String) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { list in
            let ids = list
                .filter { ($0.request.content.userInfo["sessionId"] as? String) == sessionId }
                .map(\.request.identifier)
            if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
        center.setBadgeCount(0)
    }

    private var loadedLayout: some View {
        Group {
            if store.loadFailed {
                loadFailure
            } else {
                transcript
            }
        }
        .background(tokens.canvas.ignoresSafeArea())
        // The composer FLOATS as an overlay over the full-bleed transcript, so
        // messages genuinely pass under it while scrolling. The measured
        // `bottomBarHeight` of that floating stack feeds the transcript's
        // `additionalContentInset` bottom inset, so at rest the newest message
        // rests readable above the whole stack.
        //
        // Scrim FIRST so it draws beneath the composer stack. It is sized to
        // the composer's GLASS BOX only — reported by ComposerView via
        // `composerGlassHeight`, not the whole floating stack — so the
        // jump-to-bottom chip and the pinned cards above the box do not
        // extend it. `fadeInsideContainer: true` puts the fade band AT the
        // glass box's top edge instead of hanging above it, so the fade
        // begins right at the composer's own top edge and dissolves content
        // BEHIND the glass — everything above the box (transcript text,
        // chip, cards) stays fully readable.
        .overlay(alignment: .bottom) {
            Color.clear
                .frame(height: composerGlassHeight)
                .background(alignment: .bottom) {
                    Scrim(edge: .bottom, tokens: tokens, overhang: Self.scrimOverhang, fadeInsideContainer: true)
                }
                .allowsHitTesting(false)
        }
        .overlay(alignment: .bottom) {
            GlassEffectContainer(spacing: 0) {
                VStack(spacing: 0) {
                    bottomCards
                    ComposerView(
                        sessionId: store.sessionId,
                        projectName: projectName,
                        api: MantaAPIClient.live(),
                        store: store,
                        modelStore: modelStore,
                        usageStore: usageStore,
                        onShowUsage: { showUsageSheet = true },
                        showScrollToBottom: showScrollToBottom,
                        onScrollToBottom: {
                            scrollPosition.scrollTo(edge: .bottom, animated: true)
                            showScrollToBottom = false
                        },
                        onGlassBoxHeightChange: { composerGlassHeight = $0 },
                        sessionDirectory: sessionWindow?.cwd,
                        onSlashClear: { Task { await clearSession() } },
                        onSlashFork: { Task { await forkSession() } }
                    )
                }
                // Feeds the transcript's bottom content inset its height. Safe
                // to measure here: it is an overlay, so nothing it reports
                // changes the transcript.
                .onGeometryChange(for: CGFloat.self) { proxy in
                    proxy.size.height
                } action: { height in
                    bottomBarHeight = height
                }
            }
        }
        .navigationDestination(for: SubagentSession.self) { agent in
            ChatSubagentScreen(
                childSessionId: agent.childSessionId,
                title: agent.taskName,
                subtitle: agent.subtitle,
                eventStore: eventStore,
                api: MantaAPIClient.live(),
                tokens: tokens
            )
            .id(agent.childSessionId)
        }
        // The identity moved into the system navigation bar (BET-821): the bar
        // supplies its own scroll-edge effect and reserves its own space, so the
        // transcript no longer needs a hand-rolled top scrim or a reserved
        // header height.
        // Offline must not read as "the model is quiet": a slim banner pinned
        // just below the navigation bar. It disappears on its own when
        // `degraded` flips false.
        .overlay(alignment: .top) {
            if store.degraded {
                Text("Connection lost — reconnecting…")
                    .font(.manta(size: Metrics.type.xs, weight: .semibold))
                    .foregroundColor(tokens.danger)
                    .padding(.horizontal, Metrics.spacing.sp3)
                    .padding(.vertical, Metrics.spacing.sp1)
                    .background(tokens.danger.opacity(0.12), in: Capsule())
                    .padding(.top, Metrics.spacing.sp2)
                    .transition(.opacity)
                    .accessibilityIdentifier("connection-banner")
            }
        }
        .sheet(isPresented: $showOverflow) { overflowSheet }
        .sheet(item: $overflowDestination) { destination in
            destinationCard(destination)
        }
        // BET-824 — each meter opens the sheet for what it represents: the
        // strip opens context, the dot opens the plan.
        .sheet(isPresented: $showContextSheet) {
            contextSheet
        }
        .sheet(isPresented: $showUsageSheet) {
            usageSheet
        }
    }

    // MARK: - Overflow sheet (§8)

    private var overflowSheet: some View {
        ChatOverflowSheet(
            sessionTitle: title,
            projectName: projectName,
            onSchedules: { overflowDestination = .schedules },
            onSecrets: { overflowDestination = .secrets },
            onArtifacts: { overflowDestination = .artifacts },
            onCompact: { store.compact() },
            onClear: { Task { await clearSession() } },
            onFork: { Task { await forkSession() } },
            onOpenTerminal: { Task { await openTerminal() } },
            onDelete: { Task { await deleteSession() } },
            settingsStore: settingsStore,
            onToggleTrust: { _ in flipTrustMode() },
            scheduleCount: scheduleCount
        )
        .task { await refreshScheduleCount() }
    }

    // MARK: - Trust mode (BET-748 gap #14)

    /// Flip the `chatAutoAllow` trust setting: flip to the opposite of its
    /// current value, persist over the store's `config:update` path, and only
    /// treat it as changed after the box confirms. A failed update never
    /// fabricates a success — the visible toggle stays put (it reads the store,
    /// which only mutates on success) and the composer `actionHint` bus says
    /// why. Shared by the overflow toggle.
    private func flipTrustMode() {
        guard let entry = SettingsSchema.entries.first(where: { $0.id == "chatAutoAllow" }) else { return }
        let target = settingsStore.current(entry) != .bool(true)
        Task { await setTrustMode(entry, target) }
    }

    private func setTrustMode(_ entry: SettingEntry, _ enabled: Bool) async {
        do {
            try await settingsStore.setBool(entry, enabled)
        } catch {
            await MainActor.run { store.actionHint = "Couldn't change trust mode — check the connection" }
        }
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
        case .artifacts:
            ArtifactsCard(
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

    /// Seed plan mode from opencode's own session agent (the desktop's
    /// BET-949 §5 behaviour). A session pre-set to plan OUTSIDE this device is
    /// only discoverable here — its stored `planOn` key can't know, so the chip
    /// would otherwise read off until some unrelated event happened to arrive.
    /// Non-fatal: on failure or absence the stored value is left alone and no
    /// error is surfaced. `setPlan` also re-reads the model for the mode being
    /// entered, so the composer shows that mode's remembered model.
    private func seedPlanModeFromBox() {
        Task {
            guard let agent = try? await MantaAPIClient.live().sessionAgent(sessionId: store.sessionId) else { return }
            let planNow = agent == "plan"
            modelStore.setPlan(planNow)
        }
    }

    /// The chat screen knows its project by NAME only, but every session action
    /// (clear/fork/delete) and the branch lookup need the tmux window index and
    /// its working directory. Resolve both once when the screen appears. After
    /// `sessionWindow` is known, the branch stays current through `refreshBranch()`
    /// (the 5s poll `pollBranch` + a refresh on submit).
    private func resolveWindowAndBranch() async {
        let api = MantaAPIClient.live()
        guard let projects = try? await api.projects(),
              let project = projects.first(where: { $0.tmuxSession == projectName }),
              let window = project.windows.first(where: { $0.opencodeSessionId == store.sessionId })
        else { return }
        let cwd = window.paneCurrentPath.isEmpty ? project.defaultCwd : window.paneCurrentPath
        await MainActor.run {
            sessionWindow = (project.tmuxSession, window.index, cwd)
            branchRelPath = Self.relativeWorkingPath(cwd: cwd, root: project.defaultCwd)
        }
        await refreshBranch()
    }

    /// Re-fetch the git branch for the session's working directory. The desktop
    /// polls every 5s AND refreshes on submit so a terminal-side `git checkout`
    /// reflects within one tick; the chat does the same (BET-747 gap #13).
    private func refreshBranch() async {
        guard let cwd = sessionWindow?.cwd, !cwd.isEmpty else { return }
        if let resolved = try? await MantaAPIClient.live().vcsBranch(directory: cwd) {
            await MainActor.run {
                branch = resolved
                lastBranchFetch = Date()
            }
        }
    }

    /// The 5s branch poll, matching the desktop's cadence. Cancelled when the
    /// screen disappears (the `.task` lifecycle hook owns it).
    private func pollBranch() async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: UInt64(BranchFreshnessPolicy.pollInterval * 1_000_000_000))
            if BranchFreshnessPolicy.shouldRefresh(didSubmit: false, now: Date(), lastFetch: lastBranchFetch) {
                await refreshBranch()
            }
        }
    }

    /// The session's working directory relative to the project root, so the
    /// branch capsule shows *where* the branch lives (`project/⎇ branch`), not
    /// just the branch name. Falls back to the pane's own last path component
    /// when the cwd isn't under the project root.
    private static func relativeWorkingPath(cwd: String, root: String) -> String {
        let trimmedRoot = root.hasSuffix("/") ? String(root.dropLast()) : root
        if trimmedRoot.isEmpty || cwd == trimmedRoot { return "" }
        if let range = cwd.range(of: trimmedRoot), range.lowerBound == cwd.startIndex {
            var rel = String(cwd[range.upperBound...])
            rel = rel.hasPrefix("/") ? String(rel.dropFirst()) : rel
            return rel
        }
        return (cwd as NSString).lastPathComponent
    }

    /// The branch + relative path shown in the navigation bar's subtitle chip,
    /// or nil when there is no branch (non-git cwd, detached HEAD, unreachable
    /// box) — in which case the chip renders nothing at all.
    private var branchCapsuleInfo: (name: String, path: String?)? {
        guard let branch, !branch.isEmpty else { return nil }
        return (branch, branchRelPath)
    }

    /// The system navigation bar's subtitle chip (BET-821): the branch name and
    /// relative working-directory path once a branch is known. Renders NOTHING
    /// when there is no branch (non-git cwd, detached HEAD, unreachable box) so
    /// the inline title stands alone rather than showing a dead glyph.
    @ViewBuilder
    private var subtitleChip: some View {
        if let info = branchCapsuleInfo {
            let path = info.path.flatMap { $0.isEmpty ? nil : $0 }
            Label(path.map { "\(info.name) · \($0)" } ?? info.name,
                  systemImage: "arrow.triangle.branch")
                .labelStyle(.titleAndIcon)
                .font(.manta(size: Metrics.type.xs, weight: .semibold))
                .foregroundColor(tokens.tx4)
                .lineLimit(1)
        }
    }

    /// Clear = a fresh opencode session in the SAME window. Stay on the screen
    /// and re-point it at the new id; the transcript comes back empty because
    /// the session really is new.
    private func clearSession() async {
        guard let w = sessionWindow else {
            store.actionHint = "Can't clear — session's window not found. Go back and reopen from the list."
            return
        }
        let newId: String?
        do {
            newId = try await MantaAPIClient.live().clearSession(
                sessionName: w.name, windowIndex: w.index, cwd: w.cwd, title: title)
        } catch {
            await MainActor.run { store.actionHint = "Clear failed — the session is still there" }
            return
        }
        guard let newId, !newId.isEmpty else {
            await MainActor.run { store.actionHint = "Clear failed — the session is still there" }
            return
        }
        // Carry the chosen model + effort to the new session id before the
        // wrapper rebuilds the stores against it (matching the desktop's clear,
        // which copies the override into the new session's key). The catalog
        // already holds the box-wide model list, so nothing reloads.
        modelStore.rebind(to: newId)
        await MainActor.run { onCleared(newId) }
    }

    private func forkSession() async {
        guard let w = sessionWindow else {
            store.actionHint = "Can't fork — session's window not found. Go back and reopen from the list."
            return
        }
        let newSessionId: String?
        do {
            newSessionId = try await MantaAPIClient.live().forkSession(
                sessionId: store.sessionId, sessionName: w.name,
                windowName: "\(title)-fork", cwd: w.cwd)
        } catch {
            await MainActor.run { store.actionHint = "Fork failed — nothing was created" }
            return
        }
        guard let newSessionId, !newSessionId.isEmpty else {
            await MainActor.run { store.actionHint = "Fork failed — nothing was created" }
            return
        }
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
        guard let w = sessionWindow else {
            store.actionHint = "Can't open terminal — session's window not found. Go back and reopen from the list."
            return
        }
        await MainActor.run {
            path.append(SessionOpenTarget(project: projectName, windowIndex: w.index, name: title, sessionId: nil))
        }
    }

    private func deleteSession() async {
        guard let w = sessionWindow else {
            store.actionHint = "Can't delete — session's window not found."
            return
        }
        do {
            try await MantaAPIClient.live().deleteSession(
                sessionId: store.sessionId, sessionName: w.name, windowIndex: w.index)
            await MainActor.run { dismiss() }
        } catch {
            await MainActor.run { store.actionHint = "Delete failed — the session is still there" }
        }
    }

    private var transcript: some View {
        // The whole scroll layer lives in `TranscriptListView`, which renders a
        // snapshot of `store.rows` via `TiledView(items:)`. There is no separate
        // data source or change log to fall out of sync with the scroll view —
        // the BET-807/BET-1062 lifetime hazard is gone with the snapshot API.
        TranscriptListView(
            store: store,
            tokens: tokens,
            bottomInset: bottomBarHeight,
            scrollPosition: $scrollPosition,
            onPointsFromBottom: { showScrollToBottom = $0 > Self.scrollToBottomThreshold },
            header: { sessionHeaderBlock }
        )
        // Deliver the blocking-card actions to the transcript cells via the
        // SwiftUI environment (BET-1214). The subagent drill-in keeps `nil`.
        .environment(\.transcriptCardActions, cardActions)
    }
    /// How far above the bottom the user must scroll for the down-arrow to
    /// appear. Same magnitude MessagingUI uses internally for its own "near
    /// bottom" checks.
    private static let scrollToBottomThreshold: CGFloat = 100

    // MARK: - Loading skeleton (D2 / BET-631)

    // The loading skeleton (`ChatLoadingSkeleton`) is the chat screen's
    // loading state — `content` renders it while `store.loading` (BET-752 task
    // 3). It is ALSO the harness scene `ChatLoadingScene` (MantaAppRoot) that
    // the capture fixture drives, so fixture and live screen share one view.

    // MARK: - Context meter (BET-824)

    /// The context breakdown re-derived against the SELECTED model. One read,
    /// so the pill's percentage and the sheet's "of N" cannot describe two
    /// different models (which is exactly what "87% — 174k of 1M" was).
    private var contextBreakdown: StreamContextPayload? {
        store.context.map { UsageMeters.recompute($0, limit: activeModelContextLimit) }
    }

    /// The context percentage from the SELECTED model's breakdown: a real
    /// percentage when the box reports one, nil when it has none (nil early in
    /// a session, and again after a compaction). A missing value renders
    /// nothing — never a confident 0%.
    private var contextPct: Double? {
        guard let ctx = contextBreakdown, ctx.pct.isFinite else { return nil }
        return ctx.pct
    }

    /// Whether the prompt cache has gone cold. One read, so the tint, the label
    /// and the accessibility string cannot disagree.
    private var cacheIsStale: Bool { store.cache?.isStale == true }

    /// The active model's own context window — the meter's denominator. Opus
    /// 4.7 reports 1M against Sonnet's 200k, so it is read per-model, never
    /// hardcoded.
    private var activeModelContextLimit: Double? {
        guard let model = ChatModel.activeModel(modelStore.models,
                                                override: modelStore.override,
                                                default: modelStore.defaultModel) else { return nil }
        return model.limit?.context
    }

    private var activeModelName: String {
        ChatModel.label(modelStore.models, override: modelStore.override, default: modelStore.defaultModel)
    }

    /// The band colour for the current context reading (strip + sheet).
    private var contextBandColor: Color {
        if cacheIsStale { return tokens.warn }
        if let pct = contextPct {
            return MeterRing.tint(UsageMeters.band(pct), tokens)
        }
        return tokens.tx4
    }

    /// The header block mounted via `.safeAreaBar(edge: .top)` below the system
    /// navigation bar: a branch row (when a branch exists) stacked over a
    /// full-width context row. Its own background is fully opaque `tokens.canvas`
    /// so the bar's default material is not visible — that removes the seam
    /// between the solid nav bar and the block. The branch row drops out
    /// entirely when there is no branch (`subtitleChip` renders nothing then).
    @ViewBuilder
    private var sessionHeaderBlock: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            subtitleChip
            contextStrip
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.bottom, Metrics.spacing.sp2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tokens.canvas)
        .overlay(alignment: .bottom) {
            Rectangle().fill(tokens.borderSubtle).frame(height: 1)
        }
    }

    /// Full-width, one-tap strip directly under the navigation bar: the word
    /// "Context", a linear meter filling the remaining width, the percentage,
    /// a chevron. Always rendered for a KNOWN reading, because a meter that
    /// hides itself is a meter the user cannot find — the desktop's session
    /// header pill is always visible, and iOS matches it. It animates in above
    /// the transcript via `safeAreaBar`, and renders nothing while the reading
    /// is unknown (never a fabricated 0%). A `Gauge`, not a `ProgressView` —
    /// the HIG treats progress indicators as transient, and this one never
    /// disappears once the reading is known, so it reads as a persistent meter
    /// and VoiceOver announces it so.
    ///
    /// For a model that reports NO max context (`hasLimit == false`) the strip
    /// renders a solid full-green fill with no percentage — an "active, but
    /// unbounded" reading instead of a fabricated number.
    @ViewBuilder
    private var contextStrip: some View {
        if let ctx = contextBreakdown, !ctx.hasLimit {
            unknownContextStrip
        } else if let pct = contextPct, UsageMeters.shouldShowContext(pct: pct) {
            knownContextStrip(pct)
        }
    }

    private func knownContextStrip(_ pct: Double) -> some View {
        Button { showContextSheet = true } label: {
            HStack(spacing: Metrics.spacing.sp2) {
                Text("Context")
                    .font(.manta(size: Metrics.type.twoXS, weight: .semibold))
                    .foregroundColor(tokens.tx4)
                Gauge(value: pct, in: 0...100) { EmptyView() }
                    .gaugeStyle(.accessoryLinearCapacity)
                    .tint(contextBandColor)
                    .frame(maxWidth: .infinity, maxHeight: 4)
                Text("\(Int(pct.rounded()))%")
                    .font(.manta(size: Metrics.type.twoXS, weight: .bold))
                    .foregroundColor(contextBandColor)
                if let coldLabel = UsageMeters.staleChipLabel(store.cache) {
                    Text(coldLabel)
                        .font(.manta(size: Metrics.type.twoXS, weight: .bold))
                        .foregroundColor(tokens.warn)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: Metrics.type.twoXS, weight: .semibold))
                    .foregroundColor(tokens.tx4)
            }
            .frame(height: 24)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            cacheIsStale
                ? "Context \(Int(pct.rounded())) percent, cache cold, \(UsageMeters.formatTokens(store.cache?.staleTokens)) tokens re-billed on the next message"
                : "Context \(Int(pct.rounded())) percent"
        )
        .accessibilityIdentifier("context-strip")
        // Context legitimately drops after a compaction; animate that drop
        // rather than snapping it, or it reads as a glitch.
        .animation(.easeInOut(duration: 0.4), value: pct)
    }

    private var unknownContextStrip: some View {
        Button { showContextSheet = true } label: {
            HStack(spacing: Metrics.spacing.sp2) {
                Text("Context")
                    .font(.manta(size: Metrics.type.twoXS, weight: .semibold))
                    .foregroundColor(tokens.tx4)
                Gauge(value: 100, in: 0...100) { EmptyView() }
                    .gaugeStyle(.accessoryLinearCapacity)
                    .tint(tokens.ok)
                    .frame(maxWidth: .infinity, maxHeight: 4)
                Image(systemName: "chevron.right")
                    .font(.system(size: Metrics.type.twoXS, weight: .semibold))
                    .foregroundColor(tokens.tx4)
            }
            .frame(height: 24)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Context — no max context info for this model")
        .accessibilityIdentifier("context-strip")
    }

    @ViewBuilder
    private var contextSheet: some View {
        // The strip only shows for a known reading (or the no-max-context
        // unknown state), but the context can go unknown in the window between
        // the tap and the sheet presenting — never fabricate a 0% sheet for
        // "we don't know".
        if let ctx = contextBreakdown, !ctx.hasLimit || UsageMeters.shouldShowContext(pct: ctx.pct) {
            ContextSheet(
                context: ctx,
                cache: store.cache,
                limit: activeModelContextLimit,
                modelName: activeModelName,
                bandColor: contextBandColor,
                tokens: tokens,
                onCompact: { store.compact() },
                onClear: { Task { await clearSession() } }
            )
        } else {
            Color.clear
        }
    }

    private var usageSheet: some View {
        UsageSheet(snapshots: usageStore.snapshots, lastFetch: usageStore.lastFetch, tokens: tokens)
    }

    /// Whether the one-per-session weekly warning banner should render.
    private var weeklyBannerVisible: Bool {
        UsageMeters.shouldShowWeeklyBanner(
            UsageMeters.weeklyWindow(usageStore.snapshots),
            alreadyShown: weeklyBannerShown
        )
    }

    /// The pinned dismissible card shown once per session when the weekly sits
    /// at/over 90%. "Details" opens the usage sheet; the × dismisses (and
    /// stays dismissed this session).
    private var weeklyBanner: some View {
        let weekly = UsageMeters.weeklyWindow(usageStore.snapshots)
        return HStack(spacing: Metrics.spacing.sp2) {
            MeterRing(pct: weekly?.pct ?? 0, color: tokens.danger, diameter: 14, lineWidth: 2.5, track: tokens.borderSubtle)
            VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                Text("Weekly limit \(Int((weekly?.pct ?? 0).rounded()))%")
                    .font(.manta(size: Metrics.type.xs, weight: .semibold))
                    .foregroundColor(tokens.danger)
                if let resetsAt = weekly?.resetsAt {
                    Text("Resets \(UsageMeters.formatReset(Date(timeIntervalSince1970: resetsAt / 1000), now: Date()))")
                        .font(.manta(size: Metrics.type.twoXS))
                        .foregroundColor(tokens.tx4)
                }
            }
            Spacer(minLength: 0)
            Button { showUsageSheet = true } label: {
                Text("Details")
                    .font(.manta(size: Metrics.type.xs, weight: .semibold))
                    .foregroundColor(tokens.accentTx)
                    .padding(.horizontal, Metrics.spacing.sp2)
                    .padding(.vertical, Metrics.spacing.sp1)
                    .background(tokens.accentSoft, in: Capsule())
            }
            .buttonStyle(.plain)
            Button { weeklyBannerShown = true } label: {
                Image(systemName: "xmark")
                    .font(.system(size: Metrics.type.xs, weight: .semibold))
                    .foregroundColor(tokens.tx4)
                    .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(.leading, Metrics.spacing.sp3)
        .padding(.trailing, Metrics.spacing.sp2)
        .padding(.vertical, Metrics.spacing.sp2)
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.radius.md)
                .stroke(tokens.borderSubtle, lineWidth: Metrics.spacing.spPx)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("weekly-banner")
    }

    // MARK: - Live cards (todos / permission / question)

    @ViewBuilder
    private var bottomCards: some View {
        VStack(spacing: Metrics.spacing.sp3) {
            // Weekly-limit banner (BET-824): one pinned dismissible card, once
            // per session, when the weekly window is at/over 90%. The dot
            // tracks the 5-hour window, so it can read green while the weekly
            // is nearly spent — this banner is the only thing between a green
            // dot and a multi-day lockout the user did not see coming.
            if weeklyBannerVisible {
                weeklyBanner
            }
            // Only things that BLOCK the turn and need a tap stay here. Live
            // running tools now render INSIDE the transcript (in the turn that
            // spawned them); sessionError / truncation / queued prompts AND the
            // blocking cards (permission / plan / question) all moved into the
            // transcript tail too (BET-1214). Todos stay, collapsed to a single
            // line while a turn runs.
            if let todos = store.todos, !(todos.visible?.visible ?? todos.active ?? []).isEmpty {
                TodosCard(payload: todos, tokens: tokens, compact: store.running)
            }
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.top, Metrics.spacing.sp2)
    }

    /// The callbacks + context the blocking cards need now that they render in
    /// the transcript tail via `transcriptBlockView`, not the pinned bottom
    /// stack. Same closures the cards always took — only their delivery route
    /// changed (BET-1214).
    private var cardActions: TranscriptCardActions {
        TranscriptCardActions(
            messages: store.messages,
            buildModelName: buildModelName,
            planURL: planURL,
            onPermissionReply: { permission, reply in
                store.replyPermission(permission, reply: reply)
            },
            onQuestionSubmit: { question, answers in
                store.replyQuestion(question, answers: answers)
            },
            onQuestionReject: { question in
                store.rejectQuestion(question)
            },
            onBuildHere: { question, feedback in
                handleBuildHere(question, feedback: feedback)
            },
            onKeepPlanning: { question, feedback in
                store.keepPlanning(question: question, feedback: feedback)
            },
            onOpenPage: { openPlanPage() }
        )
    }

    /// True while a blocking card is present, driving the one-time scroll to
    /// its arrival (BET-1214).
    private var isBlockingCardPresent: Bool {
        store.hasBlockingCard
    }

    /// The deterministic plan-page URL for this session (`<base>/pages/plan-…`,
    /// auto-published by the plan agent's plan_render tool), or nil when no
    /// usable subdomain slug can be formed. There is no on-device publish call
    /// — the URL is derived, mirroring the current desktop
    /// (`ChatPanel.tsx:2544-2552`) which standardized on the single-HTML plan
    /// page auto-published under the per-session subdomain.
    private var planURL: String? {
        PlanDerivation.planPageURL(sessionID: store.sessionId, baseURL: api.serverURL)
    }

    /// The session's BUILD-model name for the card's "Ready to build · …"
    /// subtitle — the remembered build model, independent of the current
    /// plan/build mode, falling back to the server default (the plan model is
    /// only ever the composer's active model while plan mode is on).
    private var buildModelName: String {
        let buildID = ChatModelStore.loadOverride(for: store.sessionId, mode: .build)
        return ChatModel.label(modelStore.models, override: buildID, default: modelStore.defaultModel)
    }

    private func handleBuildHere(_ question: QuestionRequest, feedback: String) {
        // Port of the desktop's buildHere: answer "Yes" (switches to the build
        // agent), flip local plan state off so the BUILD model becomes active,
        // then re-send the plan text ourselves (feedback appended) with that
        // build model — opencode's own "yes" would otherwise stamp the injected
        // build turn with the planning model.
        var prompt = PlanDerivation.extractPlanData(question, in: store.messages).text
        let trimmed = feedback.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            prompt = prompt.isEmpty ? trimmed : "\(prompt)\n\n\(trimmed)"
        }
        modelStore.setPlan(false)
        let buildModel = modelStore.promptModel
        store.buildHere(question: question, planText: prompt, buildModel: buildModel)
    }

    private func openPlanPage() {
        if let planURL, let url = URL(string: planURL) {
            UIApplication.shared.open(url)
        }
    }

    // MARK: - Load failure

    private var loadFailure: some View {
        VStack(spacing: Metrics.spacing.sp2) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: Metrics.type.display))
                .foregroundColor(tokens.warn)
            Text("Couldn't reach your server")
                .font(.manta(size: Metrics.type.body, weight: .semibold))
                .foregroundColor(tokens.tx1)
            Text("Tap to retry.")
                .font(.manta(size: Metrics.type.small))
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
/// transcript streams while the child is open. Built on the SAME TiledView +
/// `TranscriptRow` machinery as the parent chat (BET-670): the child store
/// produces rows exactly like the parent, so the wiring is identical — same
/// scroll-position config, same `.headerContent` spacer pattern (for its own
/// header), same cell, prepend loader and running indicator. No composer, no
/// cards, no scrim — the child is read-only.
struct ChatSubagentScreen: View {
    let title: String
    let subtitle: String
    let childSessionId: String?
    /// The child screen OWNS its store (BET-1024). Keyed by the child session
    /// id and constructed from the shared eventStore + api, it is tied to this
    /// screen's identity via `.id(childSessionId)` at the call site — so a
    /// parent-side push/dismiss or any store sweep can never rebind this
    /// screen to a different, empty store. The parent owns nothing about it.
    @StateObject private var store: ChatSessionStore
    let tokens: Tokens

    init(childSessionId: String?, title: String, subtitle: String, eventStore: MantaEventStore, api: MantaAPIClient, tokens: Tokens) {
        self.childSessionId = childSessionId
        self.title = title
        self.subtitle = subtitle
        self.tokens = tokens
        _store = StateObject(wrappedValue: ChatSessionStore(
            sessionId: childSessionId ?? "",
            eventStore: eventStore,
            api: api,
            isReadOnly: true
        ))
    }

    /// Drives MessagingUI's `TiledView` scroll layer for the child transcript:
    /// stays on the newest message as the child streams, and stops following
    /// the moment the user scrolls away. Same config as the parent chat.
    @State private var scrollPosition = TiledScrollPosition(
        autoScrollsToBottomOnAppend: true,
        scrollsToBottomOnReplace: true
    )
    /// Rendered by `TranscriptListView` from a snapshot of `store.rows` — no
    /// separate data source or change log (BET-1105).

    var body: some View {
        content
            .navigationTitle(subtitle.isEmpty ? title : "\(title) · \(subtitle)")
            .navigationBarTitleDisplayMode(.inline)
            .mantaNavigationBarBackground(tokens)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("subagent-scene")
    }

    /// Unset when a task part has not yet been stamped with a child session id
    /// (see `SubagentSession`): there is nothing to stream yet, so explain it
    /// instead of pushing a silent blank screen.
    private var hasSession: Bool { !(childSessionId?.isEmpty ?? true) }

    @ViewBuilder private var content: some View {
        if hasSession {
            transcript
        } else {
            emptyState
        }
    }

    private var transcript: some View {
        TranscriptListView(
            store: store,
            tokens: tokens,
            bottomInset: 0,
            scrollPosition: $scrollPosition,
            onPointsFromBottom: nil,
            // BET-1257 — a literally-empty `EmptyView()` header broke touch
            // delivery to the transcript on THIS screen specifically: the
            // child is reached via `NavigationStack.navigationDestination`
            // (a push), while the parent's identical `TranscriptListView` is
            // the stack's root. Measured with real HID input (idb, clean
            // single-process room): with `EmptyView()` the collection view's
            // pan gesture recognizer never even reaches `.began` — zero pan
            // events under five real swipes, confirmed on a screenshot that
            // the transcript never moved. Swapping in ANY non-empty
            // `.safeAreaBar` content (a 0.5pt clear spacer — no visual
            // change) restored a full pan trace (Began/Changed/Ended,
            // hundreds of points of real movement) with no other change.
            // The parent, which has always passed real header content here,
            // is the control and is untouched by this file.
            header: { Color.clear.frame(height: 0.5) }
        )
        .background(tokens.canvas.ignoresSafeArea())
        .onAppear { store.start() }
        .onDisappear { store.stop() }
    }

    private var emptyState: some View {
        Text("This task has not started yet.")
            .font(.manta(size: Metrics.type.small))
            .foregroundColor(tokens.tx3)
            .multilineTextAlignment(.center)
            .padding(.horizontal, Metrics.spacing.sp3)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(tokens.canvas.ignoresSafeArea())
    }
}

// MARK: - Shared transcript scroll layer (BET-1062)

/// The transcript scroll layer, feeding `store.rows` to MessagingUI's
/// `TiledView(items:)` as a snapshot. There is no separate data source and no
/// change log to replay, so the BET-807/BET-1062 change-log lifetime hazard is
/// gone: the rows come straight from the store on every update, and MessagingUI
/// diffs the snapshot internally to animate changes.
///
/// One view serves both the parent chat and the read-only subagent drill-in:
/// the subagent's old chain was a strict subset of the parent's, so this
/// deletes a duplicated TiledView chain rather than adding a layer.
struct TranscriptListView<Header: View>: View {
    @ObservedObject var store: ChatSessionStore
    let tokens: Tokens
    let bottomInset: CGFloat
    @Binding var scrollPosition: TiledScrollPosition
    var onPointsFromBottom: ((CGFloat) -> Void)? = nil
    @ViewBuilder var header: () -> Header

    var body: some View {
        // The blocking-card actions are delivered to the cells through the
        // SwiftUI environment (a closure-carrying `@MainActor` reference can't
        // be threaded through the cell's nonisolated `body`); the enclosing chat
        // screen injects `\.transcriptCardActions` at its call site. Read-only
        // surfaces (subagent drill-in) leave it unset → cards render inert.
        TiledView(items: store.rows, scrollPosition: $scrollPosition) { row in
            TranscriptBlockCell(item: row, tokens: tokens, onRetry: { store.retry(promptID: $0) })
        }
        .prependLoader(.loader(
            perform: { store.loadEarlier() },
            isProcessing: store.loadingEarlier
        ) {
            LoadEarlierRow(loading: store.loadingEarlier, tokens: tokens) {}
        })
        .typingIndicator(.indicator(isVisible: store.running) {
            RunningIndicator(store: store)
        })
        .additionalContentInset(
            EdgeInsets(top: 0, leading: 0, bottom: bottomInset, trailing: 0)
        )
        .onTiledScrollGeometryChange { geometry in
            onPointsFromBottom?(geometry.pointsFromBottom)
        }
        .onTapBackground { resignKeyboard() }
        .safeAreaBar(edge: .top) {
            header()
        }
    }

    /// Lower the keyboard by asking whoever holds first responder to give it
    /// up. The composer's focus binding lives inside `ComposerView` (on the
    /// parent), and routing a "please blur" signal down to it would mean
    /// threading state through a sibling view for one gesture.
    private func resignKeyboard() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

// MARK: - Todos card (scope item 4)

private struct TodosCard: View {
    let payload: StreamTodosPayload
    let tokens: Tokens
    /// True while a turn runs: the card collapses to a single summary line so
    /// the pinned area reads quiet during work (BET-823).
    let compact: Bool

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
            if compact {
                compactRow
            } else {
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
                        .font(.manta(size: Metrics.type.xs))
                        .foregroundColor(tokens.tx4)
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

    /// The single-line collapse shown during a running turn — a count summary
    /// with the in-progress figure, so the user still knows work is pending
    /// without a full checklist pinning the composer.
    private var compactRow: some View {
        HStack(spacing: Metrics.spacing.sp2) {
            Image(systemName: "checklist")
                .font(.system(size: Metrics.type.xs))
                .foregroundColor(tokens.tx4)
            Text(compactSummary)
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.tx2)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
    }

    private var compactSummary: String {
        let total = rows.count
        let inProgress = rows.filter { ($0.status ?? "").lowercased() == "in_progress" }.count
        if total <= 1 { return "1 todo" }
        if inProgress == 0 { return "\(total) todos" }
        return "\(total) todos · \(inProgress) in progress"
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
                .font(.manta(size: Metrics.type.small, weight: status == "in_progress" ? mantaFontWeight(Metrics.type.semibold) : .regular))
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

struct PermissionCard: View {
    let permission: PermissionRequest
    let tokens: Tokens
    let onReply: (PermissionReply) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            Text("Permission needed")
                .font(.manta(size: Metrics.type.xs, weight: mantaFontWeight(Metrics.type.semibold)))
                .foregroundColor(tokens.tx4)
            Text(summary)
                .font(.manta(size: Metrics.type.body))
                .foregroundColor(tokens.tx1)
                .lineLimit(3)
            HStack(spacing: Metrics.spacing.sp2) {
                replyButton("Allow once", reply: .once, filled: true)
                replyButton("Allow always", reply: .always, filled: false)
                Spacer()
                rejectButton
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
                .font(.manta(size: Metrics.type.small, weight: .semibold))
                .foregroundColor(filled ? tokens.onAccent : tokens.accentTx)
                .padding(.horizontal, Metrics.spacing.sp3)
                .padding(.vertical, Metrics.spacing.sp2)
                .background(filled ? tokens.accentSolid : tokens.accentSoft, in: Capsule())
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var rejectButton: some View {
        Button {
            onReply(.reject)
        } label: {
            Text("Reject")
                .font(.manta(size: Metrics.type.small, weight: .medium))
                .foregroundColor(tokens.danger)
                .padding(.horizontal, Metrics.spacing.sp3)
                .padding(.vertical, Metrics.spacing.sp2)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Question card (answerable, §7.5)

struct QuestionCard: View {
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
                            .font(.manta(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.semibold)))
                            .foregroundColor(tokens.tx1)
                    }
                    Text(q.question)
                        .font(.manta(size: Metrics.type.body))
                        .foregroundColor(tokens.tx1)
                    // Options are spaced sp2 apart (BET-1214) so each 44pt row
                    // reads as its own target.
                    VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                        ForEach(Array(q.options.enumerated()), id: \.offset) { oi, option in
                            optionButton(questionIndex: index, optionIndex: oi, label: option.label, multi: q.multiple == true)
                        }
                    }
                }
            }
            // Always-available free text (the desktop QuestionCard shows it for
            // ANY question, not just custom:true). It must NOT be gated on its
            // own non-empty state — that gate would make the field that is its
            // only writer unreachable, so free-form questions could never be
            // answered.
            TextField("Or type your own answer…", text: $customText)
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.tx1)
                .padding(.horizontal, Metrics.spacing.sp3)
                .padding(.vertical, Metrics.spacing.sp2)
                .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
            HStack {
                Button("Reject", action: onReject)
                    .font(.manta(size: Metrics.type.small, weight: .medium))
                    .foregroundColor(tokens.danger)
                    .padding(.horizontal, Metrics.spacing.sp3)
                    .padding(.vertical, Metrics.spacing.sp2)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                Spacer()
                Button { submit() } label: {
                    Text("Send")
                        .font(.manta(size: Metrics.type.small, weight: .semibold))
                        .foregroundColor(canSubmit ? tokens.onAccent : tokens.tx4)
                        .padding(.horizontal, Metrics.spacing.sp3)
                        .padding(.vertical, Metrics.spacing.sp2)
                        .background(canSubmit ? AnyShapeStyle(tokens.accentSolid) : AnyShapeStyle(tokens.inset), in: Capsule())
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
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
                    .font(.system(size: Metrics.type.body))
                    .foregroundColor(isOn ? tokens.accent : tokens.tx4)
                Text(label)
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx1)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            // The FULL row width is the tap target — 44pt minimum (Apple's
            // minimum hit size) and a visible surface so the target is legible,
            // not merely present (BET-1214).
            .padding(.horizontal, Metrics.spacing.sp3)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
            .background(
                isOn ? AnyShapeStyle(tokens.accentSoft) : AnyShapeStyle(tokens.inset),
                in: RoundedRectangle(cornerRadius: Metrics.radius.md)
            )
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

// MARK: - Plan card (BET-1026)

/// The plan_exit question upgraded into a dedicated card. Detection is EXACT
/// (`PlanDerivation.isPlanExitQuestion`, a matching `plan_exit` tool callID —
/// never the question text), so this card REPLACES the generic QuestionCard for
/// that question and never coexists with it.
///
/// Recipes are reused, not invented: the container matches `PermissionCard`
/// / `QuestionCard` (`tokens.panel`, `Metrics.radius.md`, 1pt `borderSubtle`
/// stroke, `Metrics.spacing.sp3` padding); the feedback field is QuestionCard's
/// free-text field verbatim; the Build here / Open page buttons are
/// PermissionCard's "Allow once" / "Allow always" recipes; Keep planning is a
/// bare text button in `tx3` (not `danger` — keeping planning is not
/// destructive). All colours/spacing/radii/type resolve through the existing
/// generated tokens — no new token.
struct PlanCard: View {
    let question: QuestionRequest
    let messages: [OpencodeMessage]
    /// The session's BUILD-model name for "Ready to build · <model>".
    let buildModelName: String
    /// The deterministic plan-page URL (nil when no usable slug can be formed).
    let planURL: String?
    let tokens: Tokens
    let onBuildHere: (String) -> Void
    let onKeepPlanning: (String) -> Void
    let onOpenPage: () -> Void

    @State private var feedback = ""

    private var data: PlanData { PlanDerivation.extractPlanData(question, in: messages) }
    private var metrics: (steps: Int, files: Int) { PlanDerivation.planMetrics(data.text) }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            // Eyebrow — same recipe as PermissionCard's "Permission needed" header.
            Text("Plan ready")
                .font(.manta(size: Metrics.type.xs, weight: mantaFontWeight(Metrics.type.semibold)))
                .foregroundColor(tokens.tx4)
            Text(data.title)
                .font(.manta(size: Metrics.type.body, weight: mantaFontWeight(Metrics.type.semibold)))
                .foregroundColor(tokens.tx1)
                .lineLimit(2)
            Text(buildModelName.isEmpty ? "Ready to build" : "Ready to build · \(buildModelName)")
                .font(.manta(size: Metrics.type.twoXS))
                .foregroundColor(tokens.tx4)
            // The metrics line is hidden entirely when no plan path was recovered
            // (a plan authored via `write`/`plan` without a discoverable path) —
            // never an empty bullet, never a crash (BET-1026 decision 6).
            if let path = data.path {
                Text("\(metrics.steps) steps · \(metrics.files) files · \(path)")
                    .font(.manta(size: Metrics.type.twoXS, design: .monospaced))
                    .foregroundColor(tokens.tx3)
                    .lineLimit(1)
            }
            if let planURL {
                Button(action: onOpenPage) {
                    HStack(spacing: Metrics.spacing.sp1) {
                        Image(systemName: "link")
                            .font(.system(size: Metrics.type.twoXS))
                            .foregroundColor(tokens.accentTx)
                        Text(planURL)
                            .font(.manta(size: Metrics.type.twoXS))
                            .foregroundColor(tokens.accentTx)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                .buttonStyle(.plain)
            }
            // Feedback field — QuestionCard's free-text field verbatim.
            TextField("Anything to change before we start?", text: $feedback)
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.tx1)
                .padding(.horizontal, Metrics.spacing.sp3)
                .padding(.vertical, Metrics.spacing.sp2)
                .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
            HStack(spacing: Metrics.spacing.sp2) {
                buildButton
                openPageButton
                Spacer(minLength: 0)
                keepPlanningButton
            }
        }
        .padding(Metrics.spacing.sp3)
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.radius.md)
                .stroke(tokens.borderSubtle, lineWidth: Metrics.spacing.spPx)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("plan-card")
    }

    /// PermissionCard's "Allow once" recipe (accent-solid capsule).
    private var buildButton: some View {
        Button { onBuildHere(feedback) } label: {
            Text("Build here")
                .font(.manta(size: Metrics.type.small, weight: .semibold))
                .foregroundColor(tokens.onAccent)
                .padding(.horizontal, Metrics.spacing.sp3)
                .padding(.vertical, Metrics.spacing.sp2)
                .background(tokens.accentSolid, in: Capsule())
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// PermissionCard's "Allow always" recipe (accent-soft capsule) with the
    /// spec's ↗ glyph.
    private var openPageButton: some View {
        Button(action: onOpenPage) {
            HStack(spacing: Metrics.spacing.sp1) {
                Text("Open page")
                Image(systemName: "arrow.up.right")
                    .font(.system(size: Metrics.type.small, weight: .semibold))
            }
            .font(.manta(size: Metrics.type.small, weight: .semibold))
            .foregroundColor(tokens.accentTx)
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.vertical, Metrics.spacing.sp2)
            .background(tokens.accentSoft, in: Capsule())
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// "Keep planning" — bare text mirroring "Reject"'s text treatment, but in
    /// `tx3`, not `danger` (keeping planning is not destructive).
    private var keepPlanningButton: some View {
        Button { onKeepPlanning(feedback) } label: {
            Text("Keep planning")
                .font(.manta(size: Metrics.type.small, weight: .medium))
                .foregroundColor(tokens.tx3)
                .padding(.horizontal, Metrics.spacing.sp3)
                .padding(.vertical, Metrics.spacing.sp2)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
