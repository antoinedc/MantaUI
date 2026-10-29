import SwiftUI

// ===========================================================================
// WS04 §5 — the leading part of the create sheet in "New project" mode before a
// source is picked: the repository scan (or its degraded / fresh states), the
// found repositories as checkable rows, the three ways forward (Browse, Clone,
// Start from scratch) — and, once "Set up N workspaces" runs, per-row progress
// with a working Retry.
//
// Copy is the desktop's (`NewSessionScreen.tsx:1190-1365`). Returns `Section`s,
// so it must sit directly inside a `Form` / `List`.
// ===========================================================================

struct SessionRepoScanSection: View {
    @ObservedObject var setup: SessionSetupStore
    let onBrowse: () -> Void
    let onClone: () -> Void
    let onScratch: () -> Void
    /// false on a box that doesn't word clone results (no `forge-clone-view-1`): the action is disabled with the
    /// note, never a dead button (WS11 D5 / S8).
    var cloneEnabled = true

    @Environment(\.colorScheme) private var colorScheme
    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        if let batch = setup.batch {
            batchSection(batch)
        } else {
            switch setup.zeroState {
            case .scanning:
                Section {
                    HStack(spacing: Metrics.spacing.sp3) {
                        ProgressView()
                        Text("Looking for repositories on your server…")
                            .foregroundColor(tokens.tx3)
                    }
                } header: {
                    Text("What's up next?")
                }
                actions(showsClone: false)
            case .degraded:
                Section {
                    Text("Couldn't scan for repositories. Point Manta at a folder instead.")
                        .foregroundColor(tokens.tx3)
                } header: {
                    Text("What's up next?")
                }
                actions(showsClone: false)
            case .fresh:
                Section {
                    Text("No repositories found. Clone one from GitHub, or point Manta at a folder.")
                        .foregroundColor(tokens.tx3)
                } header: {
                    Text("Let's get some code on this server")
                }
                actions(showsClone: true)
            case .list:
                Section {
                    ForEach(setup.repos) { repo in
                        repoRow(repo)
                    }
                } header: {
                    Text("What's up next?")
                } footer: {
                    VStack(alignment: .leading, spacing: 2) {
                        let count = setup.repos.count
                        Text("Found \(count) \(count == 1 ? "repository" : "repositories") on your server.")
                        if let login = setup.cli?.login, setup.cli?.authenticated == true {
                            Text("GitHub connected as @\(login)")
                        }
                    }
                }
                actions(showsClone: true)
            }
        }
    }

    // MARK: - Found repositories

    private func repoRow(_ repo: RepoHit) -> some View {
        let isOn = setup.checked.contains(repo.path)
        return Button {
            setup.toggle(repo.path)
        } label: {
            HStack(spacing: Metrics.spacing.sp3) {
                Image(systemName: isOn ? "checkmark.circle.fill" : "circle")
                    .foregroundColor(isOn ? tokens.accent : tokens.tx4)
                VStack(alignment: .leading, spacing: 2) {
                    Text(repo.name)
                        .foregroundColor(tokens.tx1)
                        .lineLimit(1)
                    Text(RepoRowFormat.secondary(repo, homeDir: setup.homeDir))
                        .font(.footnote)
                        .foregroundColor(tokens.tx3)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
                if let when = repo.lastCommitAt {
                    Text(RepoRowFormat.age(ms: Date().timeIntervalSince1970 * 1000 - when))
                        .font(.caption.monospacedDigit())
                        .foregroundColor(tokens.tx4)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }

    // MARK: - Ways forward

    private func actions(showsClone: Bool) -> some View {
        Section {
            if showsClone {
                Button(action: onClone) {
                    Label("Clone from GitHub…", systemImage: "arrow.down.circle")
                }
                .disabled(!cloneEnabled)
                if !cloneEnabled {
                    Text(UpdateBoxNote.text)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Button(action: onBrowse) {
                Label("Browse for a folder…", systemImage: "folder")
            }
            Button(action: onScratch) {
                Label("Start from scratch", systemImage: "plus.square.dashed")
            }
        }
    }

    // MARK: - Batch progress

    private func batchSection(_ batch: SessionSetupBatch) -> some View {
        Section {
            ForEach(batch.rows, id: \.path) { row in
                batchRow(row)
            }
        } header: {
            Text("Setting up workspaces")
        }
    }

    private func batchRow(_ row: SessionSetupBatch.Row) -> some View {
        HStack(alignment: .top, spacing: Metrics.spacing.sp3) {
            statusMark(row.phase)
                .frame(width: 18, height: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name)
                    .foregroundColor(tokens.tx1)
                Text(rowCaption(row))
                    .font(.footnote)
                    .foregroundColor(row.phase == .failed ? tokens.danger : tokens.tx3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            if row.phase == .failed {
                Button("Retry") { setup.retry(path: row.path) }
                    .buttonStyle(.bordered)
                    .disabled(setup.batch?.isRunning == true)
            }
        }
    }

    @ViewBuilder
    private func statusMark(_ phase: SessionSetupRowPhase) -> some View {
        switch phase {
        case .queued:
            Circle().fill(tokens.tx4).frame(width: 8, height: 8)
        case .creating:
            ProgressView().controlSize(.small)
        case .ready:
            Image(systemName: "checkmark.circle.fill").foregroundColor(tokens.ok)
        case .failed:
            Image(systemName: "exclamationmark.circle.fill").foregroundColor(tokens.danger)
        }
    }

    private func rowCaption(_ row: SessionSetupBatch.Row) -> String {
        switch row.phase {
        case .queued: return "Queued"
        case .creating: return "Creating…"
        case .ready: return "Ready"
        case .failed: return row.error ?? "Couldn't create the workspace."
        }
    }
}
