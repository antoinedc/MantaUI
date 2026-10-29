import SwiftUI
import UIKit

// ===========================================================================
// S6 — terminal screen (BET-598).
//
// §9.2 "Chrome": a header showing the window name and the live geometry
// (`80×24`) — the number you need when a TUI renders wrong, currently
// invisible everywhere. The terminal surface is the native container
// (`TerminalContainerView`) hosted below it; the screen is pushed from
// SessionListView for a NON-chat window (no opencode session id) — the row
// today lands on a placeholder, which this screen replaces.
//
// The running state that tints esc red is derived live from the session list
// store (the same source the list rows use), then pushed onto the shared
// terminal state where the container's accessory observes it.
// ===========================================================================

struct TerminalScreen: View {
    let windowName: String
    let projectName: String
    let sessionName: String
    let windowIndex: Int
    let defaultCwd: String
    /// `.terminal` = a plain shell; `.cli` = an installed AI CLI in the window's
    /// folder (spec 04 §2).
    let mode: SessionMode
    /// The window's opencode session id. nil for an adopted (non-chat) window,
    /// which has no mode menu — there is no chat to go back to.
    let sessionID: String?

    @ObservedObject var sessionStore: SessionListStore
    @StateObject private var terminal = TerminalSessionState()
    @EnvironmentObject private var navigator: MantaNavigator
    /// A CLI starts only after the launch flags have been re-read from the box,
    /// so it launches with what the user last chose, never a stale copy.
    @State private var launcherReady: Bool
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    init(window: MantaWindow, project: MantaProject, sessionStore: SessionListStore,
         mode: SessionMode = .terminal, sessionID: String? = nil) {
        self.windowName = window.name
        self.projectName = project.tmuxSession
        self.sessionName = project.tmuxSession
        self.windowIndex = window.index
        self.defaultCwd = window.paneCurrentPath
        self.mode = mode
        self.sessionID = sessionID
        if case .cli = mode { _launcherReady = State(initialValue: false) } else { _launcherReady = State(initialValue: true) }
        self._sessionStore = ObservedObject(wrappedValue: sessionStore)
    }

    /// The launcher to start: the CLI's id — the box applies the saved launch options (WS11 D3) — plus the
    /// row's own defaults for an older box that cannot. Nil for a shell.
    private var launcher: SessionPtyLauncher? {
        guard case .cli(let id) = mode else { return nil }
        return SessionPtyLauncher.make(id: id, launchers: sessionStore.launchers)
    }

    /// The header's second line: the CLI's name (when it is one) and the live
    /// geometry.
    private var subtitle: String {
        let geometry = terminal.geometryText.isEmpty ? "—" : terminal.geometryText
        guard case .cli(let id) = mode else { return geometry }
        let label = sessionStore.launchers.first(where: { $0.id == id })?.label ?? id
        return "\(label) · \(geometry)"
    }

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    private var isRunning: Bool {
        guard let project = sessionStore.projects.first(where: { $0.tmuxSession == sessionName }),
              let window = project.windows.first(where: { $0.index == windowIndex }) else {
            return false
        }
        return sessionStore.rowStatus(for: window).running
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if launcherReady {
                TerminalContainerView(
                    state: terminal,
                    sessionName: sessionName,
                    windowIndex: windowIndex,
                    windowName: windowName,
                    projectName: projectName,
                    defaultCwd: defaultCwd,
                    danger: UIColor(tokens.danger),
                    mode: mode,
                    launcher: launcher
                )
            } else {
                ProgressView()
                    .tint(.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            guard !launcherReady else { return }
            // Coalesces with any refresh already running. A failure still
            // launches (with the last known flags) — the box decides if the CLI
            // can start.
            await sessionStore.refreshLaunchers()
            launcherReady = true
        }
        .background(Color.black.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        .onChange(of: isRunning) { running in
            terminal.isRunning = running
        }
        .onAppear { terminal.isRunning = isRunning }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("terminal-screen")
    }

    // MARK: - Header (§9.2 Chrome)

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

            VStack(alignment: .leading, spacing: Metrics.spacing.spPx) {
                Text(windowName)
                    .font(.manta(size: Metrics.type.chatTitle, weight: mantaFontWeight(Metrics.type.semibold)))
                    .kerning(Metrics.type.chatTitleTracking * Metrics.type.chatTitle)
                    .foregroundColor(tokens.tx1)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(subtitle)
                    .font(.manta(size: Metrics.type.xs, weight: .medium, design: .monospaced))
                    .foregroundColor(tokens.tx4)
            }

            Spacer(minLength: 0)

            // Trailing slot: the mode menu (back to Chat, or another AI CLI) and
            // the quick switcher — only for a window that has a chat session; an
            // adopted window has nothing to switch to.
            if let sessionID {
                SessionModeMenu(
                    current: mode,
                    launchers: sessionStore.launchers,
                    catalog: sessionStore.launcherCatalog,
                    onSelect: { next in
                        guard next != mode else { return }
                        navigator.switchMode(
                            windowKey: SessionRouteLogic.windowKey(project: projectName, windowIndex: windowIndex),
                            sessionID: sessionID,
                            to: next
                        )
                    },
                    onRetry: { Task { await sessionStore.refreshLaunchers() } }
                )
                .font(.system(size: Metrics.type.body, weight: .semibold))
                .foregroundColor(tokens.tx1)
                .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
                .background(.ultraThinMaterial, in: Circle())

                Button {
                    navigator.presentSwitcher()
                } label: {
                    Image(systemName: "rectangle.stack")
                        .font(.system(size: Metrics.type.body, weight: .semibold))
                        .foregroundColor(tokens.tx1)
                        .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
                        .background(.ultraThinMaterial, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Switch session")
            } else {
                Color.clear
                    .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
            }
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
        .background {
            Rectangle().fill(.ultraThinMaterial).ignoresSafeArea()
        }
    }
}
