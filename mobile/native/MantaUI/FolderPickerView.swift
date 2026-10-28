import SwiftUI

// ===========================================================================
// S3 — folder picker (BET-595 §create). Full-height sheet backed by the
// existing `fs:list-dirs` RPC (the desktop FolderPickerModal.tsx is the
// behavioural reference) with §7-ported helpers from folderPicker.ts. Ports
// the retired `MobileFolderPicker.tsx` to SwiftUI; all values resolve through
// the generated tokens.
// ===========================================================================

struct FolderPickerView: View {
    let initialPath: String
    /// The header title ("Choose folder" by default).
    let title: String
    /// Offer "one session per worktree" when the chosen folder has several.
    /// Off when the choice is only a location (a scratch root).
    let allowsFanOut: Bool
    let onSelect: (String) -> Void
    let onFanOut: (String, [MantaWorktree]) -> Void
    let onCancel: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    @State private var path: String
    @State private var rows: [FolderRow] = []
    @State private var loading = false
    @State private var error: String?
    @State private var worktreeCounts: [String: [MantaWorktree]?] = [:]
    @State private var fanOut: (cwd: String, worktrees: [MantaWorktree])?

    private let api = MantaAPIClient.live()

    struct FolderRow: Identifiable, Equatable {
        let name: String
        let full: String
        var id: String { full }
    }

    init(initialPath: String, title: String = "Choose folder", allowsFanOut: Bool = true,
         onSelect: @escaping (String) -> Void,
         onFanOut: @escaping (String, [MantaWorktree]) -> Void,
         onCancel: @escaping () -> Void) {
        self.initialPath = initialPath
        self.title = title
        self.allowsFanOut = allowsFanOut
        self.onSelect = onSelect
        self.onFanOut = onFanOut
        self.onCancel = onCancel
        _path = State(initialValue: initialPath)
    }

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        VStack(spacing: 0) {
            header
            pathField
            list
        }
        .background(tokens.canvas.ignoresSafeArea())
        .overlay(alignment: .bottom) { fanOutSheet }
        .task(id: path) {
            await listDirectory(current(of: path))
        }
    }

    private var header: some View {
        HStack(spacing: Metrics.spacing.sp3) {
            Button(action: onCancel) {
                Image(systemName: "xmark")
                    .font(.system(size: Metrics.type.body, weight: .regular))
                    .foregroundColor(tokens.tx2)
            }
            .accessibilityLabel("Close")
            Text(title)
                .font(.manta(size: Metrics.type.body, weight: .semibold))
                .foregroundColor(tokens.tx1)
            Spacer()
            Button {
                selectCurrent()
            } label: {
                Text("Select")
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.onAccent)
                    .padding(.horizontal, Metrics.spacing.sp3)
                    .padding(.vertical, Metrics.spacing.sp1)
                    .background(tokens.accentSolid, in: RoundedRectangle(cornerRadius: Metrics.radius.sm))
            }
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
    }

    private var pathField: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            TextField("path", text: $path)
                .font(.manta(size: Metrics.type.small, design: .monospaced))
                .foregroundColor(tokens.tx1)
                .padding(.horizontal, Metrics.spacing.sp3)
                .padding(.vertical, Metrics.spacing.sp2)
                .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)

            HStack(spacing: 2) {
                Button {
                    path = parent(of: path)
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: Metrics.type.twoXS, weight: .regular))
                        .foregroundColor(tokens.tx3)
                        .padding(.horizontal, Metrics.spacing.sp1)
                        .padding(.vertical, Metrics.spacing.spPx)
                }
                .accessibilityLabel("Go up")
                ForEach(FolderPath.breadcrumbs(path), id: \.self) { crumb in
                    Button {
                        path = crumb
                    } label: {
                        Text(FolderPath.crumbLabel(crumb))
                            .font(.manta(size: Metrics.type.twoXS, design: .monospaced))
                            .foregroundColor(crumb == path ? tokens.tx1 : tokens.tx3)
                            .padding(.horizontal, Metrics.spacing.sp1)
                            .padding(.vertical, Metrics.spacing.spPx)
                    }
                    if crumb != FolderPath.breadcrumbs(path).last {
                        Image(systemName: "chevron.right")
                            .font(.system(size: Metrics.type.twoXS))
                            .foregroundColor(tokens.tx4)
                    }
                }
            }
            .padding(.horizontal, Metrics.spacing.spPx)
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
        .background(tokens.panel)
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                Button {
                    path = parent(of: path)
                } label: {
                    rowContent(name: "..", monospaced: true, color: tokens.tx2, icon: "arrow.up")
                }
                .padding(.horizontal, Metrics.spacing.sp3)
                .frame(minHeight: Metrics.type.listRowMinH)
                .contentShape(Rectangle())

                ForEach(rows) { row in
                    let dimmed = FolderPath.isDimmed(row.name)
                    Button {
                        let next = row.full.hasSuffix("/") ? row.full : row.full + "/"
                        path = next
                    } label: {
                        rowContent(
                            name: row.name,
                            monospaced: true,
                            color: dimmed ? tokens.tx4 : tokens.tx1,
                            icon: "folder.fill",
                            trailing: WorktreeInfoLogic.badge(worktreeCounts[row.full] ?? nil)
                        )
                    }
                    .padding(.horizontal, Metrics.spacing.sp3)
                    .frame(minHeight: Metrics.type.listRowMinH)
                    .contentShape(Rectangle())
                    .task { await probeWorktrees(row.full) }
                }
            }
            .padding(.vertical, Metrics.spacing.sp2)
        }
        .overlay {
            if loading {
                VStack(spacing: Metrics.spacing.sp2) {
                    ProgressView()
                    Text("Loading…")
                        .font(.manta(size: Metrics.type.small))
                        .foregroundColor(tokens.tx4)
                }
            } else if let error {
                Text(error)
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.danger)
                    .padding(Metrics.spacing.sp3)
            } else if rows.isEmpty {
                Text("No subfolders")
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx4)
            }
        }
    }

    @ViewBuilder
    private func rowContent(name: String, monospaced: Bool, color: Color, icon: String, trailing: String = "") -> some View {
        HStack(spacing: Metrics.spacing.sp3) {
            Image(systemName: icon)
                .font(.system(size: Metrics.type.small))
                .foregroundColor(tokens.tx3)
                .frame(width: 16)
            Text(name)
                .font(monospaced
                    ? .manta(size: Metrics.type.body, design: .monospaced)
                    : .manta(size: Metrics.type.body))
                .foregroundColor(color)
                .lineLimit(1)
            Spacer()
            if !trailing.isEmpty {
                Text(trailing)
                    .font(.manta(size: Metrics.type.xs))
                    .foregroundColor(tokens.accentTx)
            }
        }
    }

    private func parent(of p: String) -> String {
        FolderPath.parentPath(p.hasSuffix("/") ? String(p.dropLast()) : p)
    }

    /// The folder whose sub-folders are listed: the path itself, without a
    /// trailing slash (`/` and `~` stay as they are).
    private func current(of p: String) -> String {
        let trimmed = p.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "~" }
        if trimmed.count > 1 && trimmed.hasSuffix("/") { return String(trimmed.dropLast()) }
        return trimmed
    }

    /// `fs:list-dirs` answers `{dir, entries:[{name, path, hidden}]}` (B1: this
    /// used to be decoded as `[String]`, which never succeeded, so every folder
    /// read "Couldn't list folder"). Dot-folders are filtered out, as on desktop,
    /// and each row's absolute `path` is what is browsed into / selected.
    private func listDirectory(_ dir: String) async {
        loading = true
        error = nil
        // A superseded (cancelled) listing must not clear the spinner of the one
        // that replaced it.
        defer { if !Task.isCancelled { loading = false } }
        do {
            let listing = try await api.fsListDirectory(dir)
            guard !Task.isCancelled else { return }
            rows = listing.visibleEntries.map { FolderRow(name: $0.name, full: $0.path) }
            worktreeCounts = [:]
        } catch {
            guard !Task.isCancelled else { return }
            self.error = SessionActionError.message("list this folder", error: error)
            rows = []
        }
    }

    private func probeWorktrees(_ full: String) async {
        guard worktreeCounts[full] == nil else { return }
        let wt = try? await api.listWorktrees(full)
        worktreeCounts[full] = wt
    }

    private func selectCurrent() {
        let chosen = path.hasSuffix("/") && path.count > 1 ? String(path.dropLast()) : path
        guard allowsFanOut else {
            onSelect(chosen)
            return
        }
        Task {
            // A failed probe is "just this folder" — the picker never blocks a
            // choice on an optional hint.
            let wts = (try? await api.listWorktrees(chosen)) ?? []
            if WorktreeInfoLogic.hasFanOut(wts) {
                fanOut = (chosen, wts)
            } else {
                onSelect(chosen)
            }
        }
    }

    @ViewBuilder
    private var fanOutSheet: some View {
        if let fanOut {
            VStack(spacing: Metrics.spacing.sp2) {
                Text("Detected \(fanOut.worktrees.count) git worktrees. Open a session for each?")
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx2)
                    .multilineTextAlignment(.center)
                ScrollView {
                    VStack(alignment: .leading, spacing: Metrics.spacing.spPx) {
                        ForEach(fanOut.worktrees, id: \.path) { w in
                            HStack {
                                Text(WorktreeInfoLogic.name(w))
                                    .font(.manta(size: Metrics.type.xs, design: .monospaced))
                                    .foregroundColor(tokens.tx1)
                                Spacer()
                                Text(w.path)
                                    .font(.manta(size: Metrics.type.xs, design: .monospaced))
                                    .foregroundColor(tokens.tx4)
                                    .lineLimit(1)
                            }
                        }
                    }
                }
                .frame(maxHeight: 160)
                Button {
                    onFanOut(fanOut.cwd, fanOut.worktrees)
                } label: {
                    confirmLabel("Yes, one per worktree", filled: true)
                }
                Button {
                    onSelect(fanOut.cwd)
                } label: {
                    confirmLabel("Just this folder", filled: false)
                }
                Button {
                    self.fanOut = nil
                } label: {
                    Text("Cancel")
                        .font(.manta(size: Metrics.type.small, weight: .medium))
                        .foregroundColor(tokens.tx3)
                        .padding(Metrics.spacing.sp1)
                }
            }
            .padding(Metrics.spacing.sp3)
            .frame(maxWidth: .infinity)
            .background(tokens.card, in: RoundedRectangle(cornerRadius: Metrics.type.listRowRadius))
            .padding(Metrics.spacing.sp3)
        }
    }

    @ViewBuilder
    private func confirmLabel(_ text: String, filled: Bool) -> some View {
        Text(text)
            .font(.manta(size: Metrics.type.small, weight: .semibold))
            .foregroundColor(filled ? tokens.onAccent : tokens.tx2)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Metrics.spacing.sp3)
            .background(filled ? AnyShapeStyle(tokens.accentSolid) : AnyShapeStyle(tokens.panel),
                        in: RoundedRectangle(cornerRadius: Metrics.radius.md))
    }
}
