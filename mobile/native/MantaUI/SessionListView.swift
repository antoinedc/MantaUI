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
    @Environment(\.colorScheme) private var colorScheme

    @State private var searchText = ""
    @State private var createItem: CreateItem?
    @State private var openTarget: SessionOpenTarget?
    @State private var renameTarget: MantaWindow?
    @State private var renameProject = ""
    @State private var renameValue = ""
    @State private var confirmDeleteProject = ""
    @State private var confirmDeleteWindow: MantaWindow?
    @State private var deleteRunningText = ""

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        NavigationStack {
            Group {
                if store.projects.isEmpty && !store.loading {
                    emptyState
                } else {
                    list
                }
            }
            .navigationTitle("Sessions")
            .navigationBarTitleDisplayMode(.large)
            .refreshable { await store.refresh() }
            .safeAreaInset(edge: .bottom) { capsule }
            .overlay(alignment: .top) { errorBanner }
            .sheet(item: $renameTarget) { _ in renameSheet(targetProject: renameProject) }
            .navigationDestination(item: $openTarget) { target in
                SessionScreenPlaceholder(name: target.name)
            }
        }
        .sheet(item: $confirmDeleteWindow) { target in confirmDeleteSheet(target: target) }
        .overlay(alignment: .bottom) { undoToast }
        .sheet(item: $createItem) { item in
            SessionCreateSheet(
                mode: item.mode,
                onClose: { createItem = nil },
                onCreated: { project, index in
                    let name = store.projects.first(where: { $0.tmuxSession == project })?
                        .windows.first(where: { $0.index == index })?.name ?? "session"
                    createItem = nil
                    openTarget = SessionOpenTarget(project: project, windowIndex: index, name: name)
                }
            )
            .presentationDetents([.medium, .large])
        }
    }

    // MARK: - List

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(filteredProjects) { project in
                    Section {
                        groupHeader(project.tmuxSession)
                        ForEach(project.windows) { window in
                            row(project: project, window: window)
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
            openTarget = SessionOpenTarget(project: project.tmuxSession, windowIndex: window.index, name: window.name)
        } label: {
            SessionRowContent(
                window: window,
                status: store.rowStatus(for: window),
                timer: timerText(window),
                isActive: window.active,
                pinned: store.isPinned(session: project.tmuxSession, index: window.index),
                tokens: tokens
            )
        }
        .buttonStyle(.plain)
        .contextMenu {
            let id = SessionPinID.window(project.tmuxSession, index: window.index)
            Button("Rename") {
                renameProject = project.tmuxSession
                renameTarget = window
                renameValue = window.name
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
            confirmDeleteWindow = window
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
                confirmDeleteWindow = nil
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
                confirmDeleteWindow = nil
            } label: {
                Text("Cancel")
                    .font(.system(size: Metrics.type.small, weight: .medium))
                    .foregroundColor(tokens.tx2)
                    .padding(Metrics.spacing.sp2)
            }
        }
        .padding(Metrics.spacing.sp4)
        .presentationDetents([.height(320)])
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

    private var capsule: some View {
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
            .padding(.vertical, Metrics.spacing.sp2)
            .overlay {
                Capsule().stroke(tokens.borderSubtle, lineWidth: 1)
            }

            Button {
                SessionHaptics.fire(.selection, enabled: store.hapticsEnabled)
                presentCreateMenu()
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: Metrics.type.body, weight: .semibold))
                    .foregroundColor(tokens.accentTx)
                    .frame(width: 44, height: 44)
                    .background(tokens.accentSolid, in: Circle())
            }
            .accessibilityLabel("New")
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.bottom, Metrics.spacing.sp2)
        .background {
            Rectangle().fill(.ultraThinMaterial).ignoresSafeArea()
        }
    }

    private func presentCreateMenu() {
        if store.projects.isEmpty {
            createItem = CreateItem(mode: .newProject)
        } else {
            createItem = CreateItem(mode: .newSession(projectName: store.projects.first?.tmuxSession ?? ""))
        }
    }

    // MARK: - Rename (§7.2 context menu)

    private func renameSheet(targetProject: String) -> some View {
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
                Button("Cancel") { renameTarget = nil }
                    .foregroundColor(tokens.tx2)
                Button("Save") {
                    let value = renameValue.trimmingCharacters(in: .whitespaces)
                    if !value.isEmpty, let target = renameTarget {
                        Task {
                            try? await MantaAPIClient.live().renameWindow(session: targetProject, index: target.index, newName: value)
                            await store.refresh()
                        }
                    }
                    renameTarget = nil
                }
                .fontWeight(.semibold)
                .foregroundColor(tokens.accentTx)
            }
        }
        .padding(Metrics.spacing.sp4)
        .presentationDetents([.height(220)])
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

private struct CreateItem: Identifiable {
    let id = UUID()
    let mode: SessionCreateMode
}

private struct SessionOpenTarget: Identifiable, Hashable {
    let id = UUID()
    let project: String
    let windowIndex: Int
    let name: String
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
