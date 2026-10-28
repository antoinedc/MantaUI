import SwiftUI

// ===========================================================================
// WS05 Features A–C — the row under the chat's navigation bar: the branch chip
// (a button when GitHub is in play), the checks chip beside it, and the one-line
// "Connect GitHub" offer. It replaces the plain branch label (M-05-1).
//
// The row owns its `GitForgeStore`: it polls the box every 5 s while the chat is
// on screen and the app is active (`.task(id: cwd)` stops it when the chat goes).
// ===========================================================================

/// Putting text into the chat's composer from a sheet. Built only when the chat
/// is writable — otherwise the callers get `nil` and render no "Send to agent".
struct GitComposerBridge {
    let insert: @MainActor (String) -> GitSendResult

    /// nil for a read-only chat, no controller, or a controller that takes no
    /// input (the three layers of the read-only rule). The closure re-checks at
    /// call time: a chat that turned read-only while a sheet was open inserts
    /// nothing and says so.
    @MainActor
    static func make(readOnly: Bool, controller: ComposerTextController?) -> GitComposerBridge? {
        guard let controller,
              GitComposerPolicy.canInsert(readOnly: readOnly, hasController: true, acceptsInput: controller.acceptsInput)
        else { return nil }
        return GitComposerBridge { text in
            guard controller.acceptsInput else { return .readOnly }
            return controller.insert(text: text, mode: .append) ? .added : .rejected
        }
    }
}

private enum GitHeaderSheet: String, Identifiable {
    case branch, checks, connect
    var id: String { rawValue }
}

struct GitSessionHeaderRow: View {
    let branch: String?
    let relPath: String?
    let cwd: String?
    let sessionId: String
    /// The chat's model OVERRIDE only (as the desktop) — the box drafts the PR
    /// title / body with it.
    let shipModel: OpencodeModelID?
    let readOnly: Bool
    let tokens: Tokens
    /// The chat's composer. Passed explicitly because the header is mounted in a
    /// safe-area bar; the environment value is the fallback.
    let composer: ComposerTextController?

    @StateObject private var store = GitForgeStore()
    @Environment(\.composerController) private var environmentComposer
    @Environment(\.scenePhase) private var scenePhase
    @State private var sheet: GitHeaderSheet?

    init(branch: String?, relPath: String?, cwd: String?, sessionId: String, shipModel: OpencodeModelID?,
         readOnly: Bool, tokens: Tokens, composer: ComposerTextController? = nil) {
        self.branch = branch
        self.relPath = relPath
        self.cwd = cwd
        self.sessionId = sessionId
        self.shipModel = shipModel
        self.readOnly = readOnly
        self.tokens = tokens
        self.composer = composer
    }

    private var composerController: ComposerTextController? { composer ?? environmentComposer }

    private var hasBranch: Bool { !(branch ?? "").isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            // Hosts the poll even when nothing else is visible (no branch yet, or
            // no offer): the offer itself depends on what the poll learns.
            Color.clear.frame(height: 0)
                .task(id: cwd ?? "") {
                    guard let cwd, !cwd.isEmpty else { return }
                    await store.run(cwd: cwd)
                }
            if hasBranch {
                HStack(spacing: Metrics.spacing.sp2) {
                    branchChip
                    if let chip = store.state.view?.checks.chip, store.branchIsInteractive {
                        checksChip(chip)
                    }
                }
            }
            if store.boxNeedsUpdate {
                Text(ReviewCopy.updateBoxForPullRequests)
                    .font(.manta(size: Metrics.type.xs))
                    .foregroundColor(tokens.tx4)
            }
            if store.showsConnectOffer {
                connectOffer
            }
        }
        .onChange(of: scenePhase) { _, phase in store.setSceneActive(phase == .active) }
        .sheet(item: $sheet, onDismiss: { store.releaseShipPreview() }) { which in
            sheetContent(which)
        }
    }

    // MARK: Chips

    private var branchTitle: String {
        guard let branch, !branch.isEmpty else { return "" }
        var text = BranchLabel.display(branch)
        if let path = relPath, !path.isEmpty { text += " · \(path)" }
        if store.branchIsInteractive, let number = store.state.pr?.number { text += " · #\(number)" }
        return text
    }

    @ViewBuilder
    private var branchChip: some View {
        let label = Label(branchTitle, systemImage: "arrow.triangle.branch")
            .labelStyle(.titleAndIcon)
            .font(.manta(size: Metrics.type.xs, weight: .semibold))
            .foregroundColor(tokens.tx4)
            .lineLimit(1)
        if store.branchIsInteractive {
            Button { sheet = .branch } label: {
                HStack(spacing: Metrics.spacing.sp1) {
                    label
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(tokens.tx4)
                }
                .padding(.vertical, 2)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(store.state.pr.map { "Pull request #\($0.number): \($0.title)" } ?? "Current branch: \(branch ?? "")")
            .accessibilityHint("Opens git actions")
        } else {
            label
        }
    }

    private func tint(_ tone: GitTone) -> Color {
        switch tone {
        case .ok: return tokens.ok
        case .warn, .running: return tokens.warn
        case .danger, .error: return tokens.danger
        case .muted, .other: return tokens.tx4
        }
    }

    private func checksChip(_ chip: GitChecksChip) -> some View {
        Button { sheet = .checks } label: {
            Text(chip.label)
                .font(.manta(size: Metrics.type.xs, weight: .semibold))
                .foregroundColor(tint(chip.tone))
                .padding(.horizontal, Metrics.spacing.sp2)
                .padding(.vertical, 2)
                .background(Capsule().fill(tint(chip.tone).opacity(0.14)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Checks: \(chip.label)")
        .accessibilityHint("Opens the list of checks")
    }

    // MARK: Connect offer

    private var connectOffer: some View {
        HStack(spacing: Metrics.spacing.sp2) {
            Text(GitConnectOffer.sentence)
                .font(.manta(size: Metrics.type.xs))
                .foregroundColor(tokens.tx3)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button("Connect") { sheet = .connect }
                .font(.manta(size: Metrics.type.xs, weight: .semibold))
                .buttonStyle(.bordered)
                .controlSize(.small)
            Button {
                store.dismissConnectOffer()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(tokens.tx4)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
    }

    // MARK: Sheets

    @ViewBuilder
    private func sheetContent(_ which: GitHeaderSheet) -> some View {
        switch which {
        case .branch:
            GitBranchSheet(
                store: store,
                cwd: cwd ?? "",
                sessionId: sessionId,
                shipModel: shipModel,
                branchName: branch ?? "",
                bridge: GitComposerBridge.make(readOnly: readOnly, controller: composerController)
            )
        case .checks:
            GitChecksSheet(
                checks: store.state.checks,
                view: store.state.view?.checks,
                bridge: GitComposerBridge.make(readOnly: readOnly, controller: composerController)
            )
        case .connect:
            NavigationStack {
                GitHubDeviceSignInView(
                    onConnected: {
                        sheet = nil
                        Task { await store.refreshNow() }
                    },
                    onCancel: { sheet = nil }
                )
            }
        }
    }
}
