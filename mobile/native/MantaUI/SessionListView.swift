import SwiftUI
import UIKit

// ===========================================================================
// S3 — session list (BET-595). Implements DECISIONS.md §7.
//
//   §7.1   grouped list: project group headers (Title Case, 15px/600 tx2),
//          rows = windows with [dot][name+subtitle][timer], min-height 62,
//          radius 20, no dividers, most-recently-active row gets `fill`.
//   §7.1a  subtitle table (subagents / running · model / needs you / absent).
//   §7.2   tap opens; swipe-left delete (full-swipe commit); swipe-right pin;
//          long-press context menu (Rename · Pin · Fork, sep, Delete).
//   §7.3   idle delete → immediate + 5 s undo (RPC held); running → confirm
//          naming what is interrupted.
//   §7.4   haptics, user-disableable.
//   §7.6   every swipe action is also in the context menu (WCAG 2.5.7).
//
// A real box drives the list through `SessionListStore`; the chat screen that
// tap opens is S4's (this stage delivers the list + actions + creation).
// ===========================================================================

struct SessionListView: View {
    @ObservedObject var store: SessionListStore
    @EnvironmentObject private var eventStore: MantaEventStore
    @EnvironmentObject private var pushRouter: MantaPushRouter
    @Environment(\.colorScheme) private var colorScheme

    @State private var searchText = ""
    // ONE sheet binding. Three separate `.sheet` modifiers used to sit on the
    // same view, and SwiftUI honours only one of them — which is why the `+`
    // button appeared dead: its sheet was never the one that won.
    @State private var sheetRoute: SheetRoute?
    // ONE path-driven stack. It used to be a bare NavigationStack whose only
    // destination was item-based (`navigationDestination(item:)`) while the
    // subagent row inside the chat screen pushed a VALUE
    // (`NavigationLink(value:)`). Mixing the two in one stack is what made a
    // subagent tap resolve against the session destination — you landed back on
    // the parent session and only saw the child after going back. Everything is
    // a value push now, so each entry resolves against its own destination.
    // NavigationPath, not a typed array: the stack carries TWO route types
    // (a session target here, a subagent value pushed from inside the chat
    // screen), and a typed path would silently swallow the second.
    @State private var path = NavigationPath()

    @State private var renameProject = ""
    @State private var renameValue = ""
    @State private var confirmDeleteProject = ""

    @State private var deleteRunningText = ""
    @State private var showSettings = false
    /// The row that carries the `fill` background while its session is OPEN.
    /// Cleared the moment you come back to the list: a highlight there reads as
    /// "you are here", and you are not — you are on the list. (It used to track
    /// tmux's active window, which lit one row in every project and never
    /// cleared at all.)
    @State private var openRow: String?

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                // Three distinct nothing-on-screen cases, and they used to
                // collapse into one. `projects.isEmpty && !loading` rendered
                // the inviting "No sessions yet. Tap + to create one." whether
                // the box really had no sessions, the fetch had FAILED, or it
                // had never run — which is exactly how a box full of sessions
                // came up blank and reassuring. A search that matches nothing
                // rendered a totally bare screen with no message at all.
                // Gated on loadError, NOT on `loading`: the first frame renders
                // before `.task` has flipped `loading`, so a `loading`-based
                // gate flashes the failure state on every cold launch.
                if !store.loadedOnce && store.loadError == nil {
                    loadingState
                } else if !store.loadedOnce {
                    unreachableState
                } else if store.projects.isEmpty {
                    emptyState
                } else if filteredProjects.isEmpty {
                    noMatchState
                } else {
                    list
                }
            }
            .navigationTitle("Sessions")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        SessionHaptics.fire(.selection, enabled: store.hapticsEnabled)
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                            .foregroundColor(tokens.tx2)
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .refreshable { await store.refresh() }
            .safeAreaInset(edge: .bottom) { capsule }
            .overlay(alignment: .top) { errorBanner }
            .navigationDestination(for: SessionOpenTarget.self) { target in
                if let sessionId = target.sessionId, !sessionId.isEmpty {
                    ChatScreen(sessionId: sessionId, title: target.name, projectName: target.project, eventStore: eventStore, path: $path)
                } else if let project = store.projects.first(where: { $0.tmuxSession == target.project }),
                          let window = project.windows.first(where: { $0.index == target.windowIndex }) {
                    // S6 (BET-598): a non-chat window opens the native
                    // terminal (xterm.js in a WKWebView + the key-row chrome).
                    TerminalScreen(window: window, project: project, sessionStore: store)
                } else {
                    SessionScreenPlaceholder(name: target.name)
                }
            }
            // The sheet hangs off the stack's CONTENT, not off the stack
            // itself. A single view can only run one presentation, and the
            // settings cover below already claims the stack — with both on the
            // same view the cover won, so every sheet (create, rename, delete)
            // was silently dead and the `+` looked like it did nothing.
            .sheet(item: $sheetRoute) { route in
                sheetContent(route)
            }
        }
        .overlay(alignment: .bottom) { undoToast }
        .fullScreenCover(isPresented: $showSettings) {
            SettingsScreen()
        }
        // S8 (BET-600): a tapped notification opens the session that fired it,
        // not the list. The push router carries the opencode sessionId; we turn
        // it into the same openTarget the list rows use. onChange covers a
        // warm launch (view already mounted), onAppear the cold-start case
        // (the tap routed before the list appeared).
        // Back on the list means nothing is open, so nothing is highlighted.
        .onChange(of: path.count) { count in
            if count == 0 { openRow = nil }
        }
        .onAppear { consumePushLink() }
        .onChange(of: pushRouter.pendingSessionID) { _ in consumePushLink() }
    }

    @ViewBuilder
    private func sheetContent(_ route: SheetRoute) -> some View {
        switch route {
        case .create(let project):
            SessionCreateSheet(
                projects: store.projects,
                initialProject: project,
                onClose: { sheetRoute = nil },
                onCreated: { project, index, fresh in
                    // Adopt the post-create list BEFORE resolving the window,
                    // otherwise the lookup runs against the pre-create snapshot
                    // and the new session opens as an unnamed, session-id-less
                    // placeholder.
                    store.applyProjects(fresh)
                    let window = store.projects.first(where: { $0.tmuxSession == project })?
                        .windows.first(where: { $0.index == index })
                    let name = window?.name ?? "session"
                    sheetRoute = nil
                    path.append(SessionOpenTarget(project: project, windowIndex: index, name: name, sessionId: window?.opencodeSessionId))
                }
            )
        case .rename(let window, let project):
            renameSheet(target: window, targetProject: project)
                .presentationDetents([.height(320)])
        case .confirmDelete(let window):
            confirmDeleteSheet(target: window)
                .presentationDetents([.height(320)])
        }
    }

    // MARK: - Push deep-link (§S8)

    private func consumePushLink() {
        guard let sessionId = pushRouter.pendingSessionID, !sessionId.isEmpty else { return }
        pushRouter.pendingSessionID = nil
        // Resolve the row that fired the notification so the opened screen
        // carries the right title/project; fall back to a bare session open
        // (ChatScreen works off sessionId alone, so a not-yet-loaded list is
        // still fine).
        if let project = store.projects.first(where: { $0.windows.contains { $0.opencodeSessionId == sessionId } }),
           let window = project.windows.first(where: { $0.opencodeSessionId == sessionId }) {
            path.append(SessionOpenTarget(project: project.tmuxSession, windowIndex: window.index, name: window.name, sessionId: sessionId))
        } else {
            path.append(SessionOpenTarget(project: "", windowIndex: 0, name: "session", sessionId: sessionId))
        }
    }

    // MARK: - List

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(filteredProjects) { project in
                    Section {
                        groupHeader(project.tmuxSession)
                        // Identity MUST be project-scoped. `MantaWindow.id` is
                        // the tmux window index, which repeats across projects
                        // (every project has a window 0), and a LazyVStack
                        // keeps ONE flat identity space across the nested
                        // ForEachs — so the second project's window 0 collided
                        // with the first project's and rendered as a blank row.
                        ForEach(project.windows.map { SessionRowKey(project: project.tmuxSession, window: $0) }) { entry in
                            row(project: project, window: entry.window)
                        }
                    }
                }
            }
            .padding(.horizontal, Metrics.spacing.spPx)
        }
    }

    private var filteredProjects: [MantaProject] {
        guard !searchText.isEmpty else { return store.projects }
        let q = searchText.lowercased()
        return store.projects.compactMap { p in
            // A project-name match keeps the whole group. Matching window names
            // only meant typing the name of the project you were looking at
            // emptied the screen.
            if p.tmuxSession.lowercased().contains(q) { return p }
            let kept = p.windows.filter { $0.name.lowercased().contains(q) }
            guard !kept.isEmpty else { return nil }
            var copy = p
            copy.windows = kept
            return copy
        }
    }

    @ViewBuilder
    private func groupHeader(_ name: String) -> some View {
        Text(titleCased(name))
            .font(.system(size: Metrics.type.body, weight: .semibold))
            .kerning(Metrics.type.headingTracking * Metrics.type.body)
            .foregroundColor(tokens.tx2)
            .padding(.top, Metrics.type.listGroupAbove)
            .padding(.bottom, Metrics.type.listGroupBelow)
            .padding(.leading, Metrics.spacing.sp3)
            .textCase(nil)
    }

    @ViewBuilder
    private func row(project: MantaProject, window: MantaWindow) -> some View {
        Button {
            openRow = SessionRowKey(project: project.tmuxSession, window: window).id
            path.append(SessionOpenTarget(project: project.tmuxSession, windowIndex: window.index, name: window.name, sessionId: window.opencodeSessionId))
        } label: {
            SessionRowContent(
                window: window,
                status: store.rowStatus(for: window),
                timer: timerText(window),
                isActive: openRow == SessionRowKey(project: project.tmuxSession, window: window).id,
                pinned: store.isPinned(session: project.tmuxSession, index: window.index),
                tokens: tokens
            )
        }
        .buttonStyle(.plain)
        .contextMenu {
            let id = SessionPinID.window(project.tmuxSession, index: window.index)
            Button("Rename") {
                renameProject = project.tmuxSession
                renameValue = window.name
                sheetRoute = .rename(window: window, project: project.tmuxSession)
            }
            Button(store.isPinned(session: project.tmuxSession, index: window.index) ? "Unpin" : "Pin") {
                store.togglePin(session: project.tmuxSession, index: window.index)
                SessionHaptics.fire(.selection, enabled: store.hapticsEnabled)
            }
            Button("Fork") {
                fork(window: window, project: project)
                SessionHaptics.fire(.selection, enabled: store.hapticsEnabled)
            }
            Divider()
            Button("Delete", role: .destructive) {
                requestDelete(window: window, project: project)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) {
                requestDelete(window: window, project: project)
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                store.togglePin(session: project.tmuxSession, index: window.index)
                SessionHaptics.fire(.selection, enabled: store.hapticsEnabled)
            } label: {
                Label(store.isPinned(session: project.tmuxSession, index: window.index) ? "Unpin" : "Pin",
                      systemImage: store.isPinned(session: project.tmuxSession, index: window.index) ? "pin.slash" : "pin")
            }
            .tint(store.isPinned(session: project.tmuxSession, index: window.index) ? tokens.tx4 : tokens.accent)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(window.name), \(subtitle(for: window))")
        .accessibilityHint("Opens the session. Swipe or long-press for actions.")
    }

    private func timerText(_ window: MantaWindow) -> String? {
        let status = store.rowStatus(for: window)
        guard status.running, let sid = window.opencodeSessionId, let since = store.runningSince[sid] else {
            return nil
        }
        return SessionTimerFormat.elapsed(Date().timeIntervalSince(since))
    }

    private func subtitle(for window: MantaWindow) -> String {
        SessionRowSubtitle.text(for: store.rowStatus(for: window)) ?? ""
    }

    // MARK: - Delete (§7.3)

    private func requestDelete(window: MantaWindow, project: MantaProject) {
        let status = store.rowStatus(for: window)
        if status.running {
            let durationText = runningDuration(of: window)
            deleteRunningText = durationText
            confirmDeleteProject = project.tmuxSession
            sheetRoute = .confirmDelete(window: window)
            SessionHaptics.fire(.warning, enabled: store.hapticsEnabled)
        } else {
            store.beginIdleDelete(session: project.tmuxSession, index: window.index)
        }
    }

    private func runningDuration(of window: MantaWindow) -> String {
        guard let sid = window.opencodeSessionId, let since = store.runningSince[sid] else {
            return SessionTimerFormat.runningDuration(0)
        }
        return SessionTimerFormat.runningDuration(Date().timeIntervalSince(since))
    }

    private func confirmDeleteSheet(target: MantaWindow) -> some View {
        VStack(spacing: Metrics.spacing.sp3) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: Metrics.type.display))
                .foregroundColor(tokens.warn)
            Text("Delete this session?")
                .font(.system(size: Metrics.type.body, weight: .semibold))
                .foregroundColor(tokens.tx1)
            Text("This will stop a turn that's been running \(deleteRunningText).")
                .font(.system(size: Metrics.type.small))
                .foregroundColor(tokens.tx2)
                .multilineTextAlignment(.center)
            Button {
                let index = target.index
                let project = confirmDeleteProject
                sheetRoute = nil
                Task {
                    if let sid = target.opencodeSessionId {
                        try? await MantaAPIClient.live().deleteSession(sessionId: sid, sessionName: project, windowIndex: index)
                    } else {
                        try? await MantaAPIClient.live().killWindow(KillWindowInput(sessionName: project, windowIndex: index))
                    }
                    await store.refresh()
                    SessionHaptics.fire(.success, enabled: store.hapticsEnabled)
                }
            } label: {
                Text("Delete Session")
                    .font(.system(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.onAccent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Metrics.spacing.sp3)
                    .background(tokens.danger, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
            }
            Button {
                sheetRoute = nil
            } label: {
                Text("Cancel")
                    .font(.system(size: Metrics.type.small, weight: .medium))
                    .foregroundColor(tokens.tx2)
                    .padding(Metrics.spacing.sp2)
            }
        }
        .padding(Metrics.spacing.sp4)
    }

    // MARK: - Undo toast

    @ViewBuilder
    private var undoToast: some View {
        if let pending = newestPending {
            HStack(spacing: Metrics.spacing.sp3) {
                Image(systemName: "trash")
                    .font(.system(size: Metrics.type.small))
                    .foregroundColor(tokens.tx2)
                Text("Deleted")
                    .font(.system(size: Metrics.type.small, weight: .medium))
                    .foregroundColor(tokens.tx1)
                Spacer()
                Button("Undo") {
                    store.undoPendingDelete(pending.pinID)
                }
                .font(.system(size: Metrics.type.small, weight: .semibold))
                .foregroundColor(tokens.accentTx)
                .padding(.horizontal, Metrics.spacing.sp2)
                .padding(.vertical, Metrics.spacing.sp1)
                .background(tokens.fillActive, in: Capsule())
            }
            .padding(.horizontal, Metrics.spacing.sp4)
            .padding(.vertical, Metrics.spacing.sp2)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: Metrics.type.listRowRadius))
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.bottom, Metrics.spacing.sp3)
            .task {
                try? await Task.sleep(nanoseconds: UInt64(PendingDelete.undoWindow * 1_000_000_000))
                store.commitExpiredDeletes()
                SessionHaptics.fire(.success, enabled: store.hapticsEnabled)
            }
        }
    }

    private var newestPending: PendingDelete? {
        store.pendingDeletes.values.max(by: { $0.startedAt < $1.startedAt })
    }

    // MARK: - Floating capsule (+ search) + create

    // The search + create control FLOATS over the list on Liquid Glass, the
    // system material for iOS 26 chrome. It used to be a flat
    // `.ultraThinMaterial` rectangle spanning the full width, which reads as an
    // opaque grey band with a hard seam — not glass, and visibly not a system
    // control. Each element carries its own glass so the pill and the button
    // are separate floating shapes, which is what `GlassEffectContainer` is
    // for; there is no full-bleed backing plate any more.
    private var capsule: some View {
        GlassEffectContainer(spacing: Metrics.spacing.sp3) {
            HStack(spacing: Metrics.spacing.sp3) {
                HStack(spacing: Metrics.spacing.sp2) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: Metrics.type.xs))
                        .foregroundColor(tokens.tx4)
                    TextField("Search sessions", text: $searchText)
                        .font(.system(size: Metrics.type.small))
                        .foregroundColor(tokens.tx1)
                }
                .padding(.horizontal, Metrics.spacing.sp3)
                .padding(.vertical, Metrics.spacing.sp3)
                .glassEffect(.regular.interactive(), in: .capsule)

                Button {
                    SessionHaptics.fire(.selection, enabled: store.hapticsEnabled)
                    presentCreateMenu()
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: Metrics.type.body, weight: .semibold))
                        // onAccent, NOT accentTx: accentTx is the accent colour
                        // for text on a NEUTRAL background. Over a solid accent
                        // fill it is the same colour in light mode, which is why
                        // this button was a featureless blue disc. Every other
                        // filled-accent control in the app already uses onAccent.
                        .foregroundColor(tokens.onAccent)
                        .frame(width: 44, height: 44)
                }
                // The system's own glass BUTTON style, not a plain button with
                // a glass effect layered over it: the layered version rendered
                // correctly but ate the touch, so the button looked dead.
                .buttonStyle(.glassProminent)
                .tint(tokens.accentSolid)
                .clipShape(.circle)
                .accessibilityLabel("New")
            }
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.bottom, Metrics.spacing.sp2)
        // Rows passing behind the floating capsule fade out rather than
        // colliding with it. Same component as the chat composer's scrim, so
        // the two screens read identically — including the overhang, without
        // which the list comes back to full brightness in the strip below the
        // capsule.
        // Sized to the capsule itself — a `.background` is exactly its
        // container — plus the overhang below, matching the chat composer:
        // the fade starts at the control's top edge, never above it.
        .background {
            Scrim(edge: .bottom, tokens: tokens, overhang: Metrics.spacing.sp12)
        }
    }

    private func presentCreateMenu() {
        sheetRoute = .create(project: store.projects.first?.tmuxSession)
    }

    // MARK: - Rename (§7.2 context menu)

    private func renameSheet(target: MantaWindow, targetProject: String) -> some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
            Text("Rename session")
                .font(.system(size: Metrics.type.body, weight: .semibold))
                .foregroundColor(tokens.tx1)
            TextField("Name", text: $renameValue)
                .font(.system(size: Metrics.type.body))
                .foregroundColor(tokens.tx1)
                .padding(.horizontal, Metrics.spacing.sp3)
                .padding(.vertical, Metrics.spacing.sp2)
                .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
                .autocorrectionDisabled()
            HStack {
                Spacer()
                Button("Cancel") { sheetRoute = nil }
                    .foregroundColor(tokens.tx2)
                Button("Save") {
                    let value = renameValue.trimmingCharacters(in: .whitespaces)
                    if !value.isEmpty {
                        Task {
                            try? await MantaAPIClient.live().renameWindow(session: targetProject, index: target.index, newName: value)
                            await store.refresh()
                        }
                    }
                    sheetRoute = nil
                }
                .fontWeight(.semibold)
                .foregroundColor(tokens.accentTx)
            }
        }
        .padding(Metrics.spacing.sp4)
    }

    // MARK: - Fork

    private func fork(window: MantaWindow, project: MantaProject) {
        let sid = window.opencodeSessionId ?? ""
        let newName = "\(window.name) fork"
        Task {
            try? await MantaAPIClient.live().forkSession(sessionId: sid, sessionName: project.tmuxSession, windowName: newName)
            await store.refresh()
        }
    }

    // MARK: - Empty / error

    private var emptyState: some View {
        VStack(spacing: Metrics.spacing.sp2) {
            Text("No sessions yet")
                .font(.system(size: Metrics.type.body, weight: .semibold))
                .foregroundColor(tokens.tx3)
            Text("Tap + to create one.")
                .font(.system(size: Metrics.type.small))
                .foregroundColor(tokens.tx4)
        }
        .accessibilityIdentifier("sessions-empty")
    }

    private var loadingState: some View {
        ProgressView()
            .accessibilityIdentifier("sessions-loading")
    }

    /// Never loaded successfully. Says so, and offers the retry — the one
    /// thing the user could previously only get by force-quitting the app.
    private var unreachableState: some View {
        VStack(spacing: Metrics.spacing.sp2) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: Metrics.type.display))
                .foregroundColor(tokens.tx4)
            Text("Can't load your sessions")
                .font(.system(size: Metrics.type.body, weight: .semibold))
                .foregroundColor(tokens.tx3)
            Text(store.loadError ?? "Couldn't reach your box")
                .font(.system(size: Metrics.type.small))
                .foregroundColor(tokens.tx4)
                .multilineTextAlignment(.center)
            Button("Try again") {
                Task { await store.refresh() }
            }
            .font(.system(size: Metrics.type.small, weight: .semibold))
            .foregroundColor(tokens.accentTx)
            .padding(.top, Metrics.spacing.sp1)
            .disabled(store.loading)
        }
        .padding(.horizontal, Metrics.spacing.sp4)
        .accessibilityIdentifier("sessions-unreachable")
    }

    private var noMatchState: some View {
        VStack(spacing: Metrics.spacing.sp2) {
            Text("No sessions match")
                .font(.system(size: Metrics.type.body, weight: .semibold))
                .foregroundColor(tokens.tx3)
            Text("Nothing named “\(searchText)”.")
                .font(.system(size: Metrics.type.small))
                .foregroundColor(tokens.tx4)
        }
        .accessibilityIdentifier("sessions-no-match")
    }

    @ViewBuilder
    private var errorBanner: some View {
        if let error = store.loadError {
            HStack {
                Image(systemName: "wifi.exclamationmark")
                Text(error)
                    .font(.system(size: Metrics.type.small))
                Spacer()
            }
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.vertical, Metrics.spacing.sp2)
            .background(tokens.warn.opacity(0.15), in: RoundedRectangle(cornerRadius: Metrics.radius.md))
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.top, Metrics.spacing.sp2)
        }
    }

    private func titleCased(_ s: String) -> String {
        s.split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }
            .joined(separator: " ")
    }
}

// MARK: - Row content (§7.1 slots)

/// Project-scoped row identity for the session list. A tmux window index is
/// only unique WITHIN its project, so it cannot be the identity of a row in a
/// LazyVStack that renders every project in one flat identity space.
private struct SessionRowKey: Identifiable {
    let project: String
    let window: MantaWindow
    var id: String { "\(project)#\(window.index)" }
}

private struct SessionRowContent: View {
    let window: MantaWindow
    let status: SessionRowStatus
    let timer: String?
    let isActive: Bool
    let pinned: Bool
    let tokens: Tokens

    var body: some View {
        HStack(spacing: Metrics.spacing.sp3) {
            Circle()
                .fill(dotColor)
                .frame(width: Metrics.spacing.sp2, height: Metrics.spacing.sp2)
            VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                HStack(spacing: Metrics.spacing.sp1) {
                    Text(window.name)
                        .font(.system(size: Metrics.type.rowName, weight: .medium))
                        .kerning(Metrics.type.rowNameTracking * Metrics.type.rowName)
                        .foregroundColor(tokens.tx1)
                        .lineLimit(1)
                    if pinned {
                        Image(systemName: "pin.fill")
                            .font(.system(size: Metrics.type.twoXS))
                            .foregroundColor(tokens.tx3)
                    }
                }
                if let subtitle = SessionRowSubtitle.text(for: status) {
                    Text(subtitle)
                        .font(.system(size: Metrics.type.xs, weight: .medium))
                        .foregroundColor(tokens.tx4)
                        .lineLimit(1)
                }
            }
            Spacer()
            if let timer {
                Text(timer)
                    .font(.system(size: Metrics.type.twoXS, weight: .medium, design: .monospaced))
                    .foregroundColor(tokens.tx4)
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .frame(maxWidth: .infinity, minHeight: Metrics.type.listRowMinH, alignment: .leading)
        .background(isActive ? AnyShapeStyle(tokens.fill) : AnyShapeStyle(Color.clear),
                    in: RoundedRectangle(cornerRadius: Metrics.type.listRowRadius))
        .padding(.bottom, Metrics.type.listRowMargin)
        .contentShape(Rectangle())
    }

    private var dotColor: Color {
        switch SessionDotState.forRow(status) {
        case .running: return tokens.accent
        case .needsYou: return tokens.warn
        case .idle: return tokens.tx4
        }
    }
}

// MARK: - Haptics (§7.4)

@MainActor
enum SessionHaptics {
    static func fire(_ kind: SessionHapticKind, enabled: Bool) {
        guard enabled else { return }
        switch kind {
        case .impactLight:
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .selection:
            UISelectionFeedbackGenerator().selectionChanged()
        case .warning:
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case .success:
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        }
    }
}

// MARK: - Identifiable helpers

/// Every sheet this screen can present, so exactly one `.sheet` modifier is
/// attached to the view.
private enum SheetRoute: Identifiable {
    case create(project: String?)
    case rename(window: MantaWindow, project: String)
    case confirmDelete(window: MantaWindow)

    var id: String {
        switch self {
        case .create(let project): return "create:\(project ?? "")"
        case .rename(let window, let project): return "rename:\(project):\(window.index)"
        case .confirmDelete(let window): return "delete:\(window.index)"
        }
    }
}

/// A route value, so its identity must be stable and derived from what it
/// addresses — never a fresh UUID, which would make the same session push as a
/// different destination every time it is constructed.
///
/// Internal (not `private`) so the chat screen can push routes onto the same
/// NavigationStack path — fork lands on the new session, and "Open terminal"
/// routes to the terminal surface for the same window.
struct SessionOpenTarget: Hashable {
    let project: String
    let windowIndex: Int
    let name: String
    let sessionId: String?

    static func == (lhs: SessionOpenTarget, rhs: SessionOpenTarget) -> Bool {
        lhs.project == rhs.project && lhs.windowIndex == rhs.windowIndex && lhs.sessionId == rhs.sessionId
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(project)
        hasher.combine(windowIndex)
        hasher.combine(sessionId)
    }
}

/// The chat screen this row opens is S4's (chat wired to live data). This
/// placeholder marks the tap target so §7.2 "tap opens" is reachable and the
/// S4 seam is a single navigation destination, not a second navigation shell.
private struct SessionScreenPlaceholder: View {
    let name: String
    @Environment(\.colorScheme) private var colorScheme

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        VStack(spacing: Metrics.spacing.sp2) {
            Image(systemName: "text.bubble")
                .font(.system(size: Metrics.type.display))
                .foregroundColor(tokens.tx4)
            Text(name)
                .font(.system(size: Metrics.type.body, weight: .semibold))
                .foregroundColor(tokens.tx1)
            Text("Chat arrives in a later stage.")
                .font(.system(size: Metrics.type.small))
                .foregroundColor(tokens.tx4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(tokens.canvas.ignoresSafeArea())
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
    }
}
