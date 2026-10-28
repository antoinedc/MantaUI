import SwiftUI

// ===========================================================================
// WS04 §2 — the Mode choice (Chat / Terminal / installed AI CLI).
//
// `SessionModeRows` is the section pair the chat overflow sheet mounts (M-04-2);
// `SessionModeMenu` is the same choice as a `Menu` for the terminal header. Both
// are driven by the same inputs: the current mode, the last good launcher list
// and the catalog's state — a failed or pending check never reads as "no CLIs".
// ===========================================================================

/// What the "AI CLI" part should show. One decision, used by both presentations.
enum SessionModeCLIState: Equatable {
    /// An installed-CLI list (possibly stale after a failed refresh).
    case list([AvailableLauncher])
    case checking
    case failed
    /// An authoritative, empty list: nothing to offer.
    case none

    static func make(launchers: [AvailableLauncher], catalog: SessionLauncherCatalog) -> SessionModeCLIState {
        if !launchers.isEmpty { return .list(launchers) }
        switch catalog {
        case .loading: return .checking
        case .failed(_, let lastGood): return lastGood == nil ? .failed : .none
        case .loaded: return .none
        }
    }
}

struct SessionModeRows: View {
    let current: SessionMode
    let launchers: [AvailableLauncher]
    let catalog: SessionLauncherCatalog
    let onSelect: (SessionMode) -> Void
    let onRetry: () -> Void

    var body: some View {
        Section("Mode") {
            modeRow("Chat", systemImage: "bubble.left", mode: .chat)
            modeRow("Terminal", systemImage: "terminal", mode: .terminal)
        }
        switch SessionModeCLIState.make(launchers: launchers, catalog: catalog) {
        case .list(let list):
            Section("AI CLI") {
                ForEach(list) { launcher in
                    modeRow(launcher.label, systemImage: "cpu", mode: .cli(launcherID: launcher.id))
                }
            }
        case .checking:
            Section("AI CLI") {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Checking…").foregroundStyle(.secondary)
                }
            }
        case .failed:
            Section("AI CLI") {
                Button {
                    onRetry()
                } label: {
                    Label("Couldn't load AI CLIs — Try again", systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        case .none:
            EmptyView()
        }
    }

    private func modeRow(_ title: String, systemImage: String, mode: SessionMode) -> some View {
        Button {
            onSelect(mode)
        } label: {
            HStack {
                Label(title, systemImage: systemImage)
                Spacer(minLength: 8)
                if mode == current {
                    Image(systemName: "checkmark")
                        .foregroundStyle(.tint)
                        .accessibilityLabel("Current mode")
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The same choice as a `Menu` (terminal header). A `Picker` inside a `Menu`
/// renders as a checkmarked choice, so the current mode is always visible.
struct SessionModeMenu: View {
    let current: SessionMode
    let launchers: [AvailableLauncher]
    let catalog: SessionLauncherCatalog
    let onSelect: (SessionMode) -> Void
    let onRetry: () -> Void

    var body: some View {
        Menu {
            Picker("Mode", selection: Binding(get: { current }, set: { onSelect($0) })) {
                Label("Chat", systemImage: "bubble.left").tag(SessionMode.chat)
                Label("Terminal", systemImage: "terminal").tag(SessionMode.terminal)
                if case .list(let list) = SessionModeCLIState.make(launchers: launchers, catalog: catalog) {
                    ForEach(list) { launcher in
                        Label(launcher.label, systemImage: "cpu").tag(SessionMode.cli(launcherID: launcher.id))
                    }
                }
            }
            switch SessionModeCLIState.make(launchers: launchers, catalog: catalog) {
            case .checking:
                Text("Checking which AI CLIs are installed…")
            case .failed:
                Button("Couldn't load AI CLIs — Try again", action: onRetry)
            case .list, .none:
                EmptyView()
            }
        } label: {
            Image(systemName: "rectangle.on.rectangle.angled")
        }
        .accessibilityLabel("Session mode")
    }
}
