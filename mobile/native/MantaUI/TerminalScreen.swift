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

    @ObservedObject var sessionStore: SessionListStore
    @StateObject private var terminal = TerminalSessionState()
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    init(window: MantaWindow, project: MantaProject, sessionStore: SessionListStore) {
        self.windowName = window.name
        self.projectName = project.tmuxSession
        self.sessionName = project.tmuxSession
        self.windowIndex = window.index
        self.defaultCwd = window.paneCurrentPath
        self._sessionStore = ObservedObject(wrappedValue: sessionStore)
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
            TerminalContainerView(
                state: terminal,
                sessionName: sessionName,
                windowIndex: windowIndex,
                windowName: windowName,
                projectName: projectName,
                defaultCwd: defaultCwd,
                danger: UIColor(tokens.danger)
            )
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
                Text(terminal.geometryText.isEmpty ? "—" : terminal.geometryText)
                    .font(.manta(size: Metrics.type.xs, weight: .medium, design: .monospaced))
                    .foregroundColor(tokens.tx4)
            }

            Spacer(minLength: 0)

            // Trailing slot keeps the header symmetric with the chat screen.
            Color.clear
                .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
        .background {
            Rectangle().fill(.ultraThinMaterial).ignoresSafeArea()
        }
    }
}
