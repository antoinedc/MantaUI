import SwiftUI

// ===========================================================================
// WS02 — the chat cards: retry, compaction, blocked, send-error, background-job
// approval, the read-only job bar and the "can't confirm this session" line.
//
// Presentation only. Every sentence that is a rule comes from the box (retry
// headline, job bar lines, approval refusals); the views draw it. No colour /
// spacing / radius literal: everything resolves through the generated tokens.
// ===========================================================================

private extension View {
    /// The shared card surface (same recipe as the weekly banner / PermissionCard).
    func chatCardSurface(_ tokens: Tokens, tint: Color? = nil, identifier: String) -> some View {
        self
            .padding(Metrics.spacing.sp3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
            .background((tint ?? .clear).opacity(0.10), in: RoundedRectangle(cornerRadius: Metrics.radius.md))
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.radius.md)
                    .stroke((tint ?? tokens.borderSubtle).opacity(tint == nil ? 1 : 0.45), lineWidth: Metrics.spacing.spPx)
            )
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(identifier)
    }
}

// MARK: - Inline markdown

/// Inline markdown (code, emphasis, links) for a card body; the plain text when it
/// does not parse. App target only: Foundation on Linux has no markdown parser,
/// so this cannot live in the pure logic file.
enum ChatCardMarkdown {
    static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

// MARK: - Retry

struct ChatCardRetry: View {
    let retry: StreamRetryPayload
    let tokens: Tokens

    var body: some View {
        // The box's copy; an older box sends none, so a fixed label + the raw message.
        let headline = retry.headline ?? "Retrying…"
        let body = retry.body ?? retry.message
        VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            HStack(spacing: Metrics.spacing.sp2) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.accent)
                Text(headline)
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.tx1)
                if let caption = retry.caption, !caption.isEmpty {
                    Text("· \(caption)")
                        .font(.manta(size: Metrics.type.xs))
                        .foregroundColor(tokens.tx4)
                }
            }
            if !body.isEmpty {
                Text(body)
                    .font(.manta(size: Metrics.type.xs))
                    .foregroundColor(tokens.tx3)
                    .lineLimit(3)
            }
            if let link = retry.action?.link, let url = URL(string: link) {
                Link(retry.action?.label ?? "Open", destination: url)
                    .font(.manta(size: Metrics.type.xs, weight: .semibold))
                    .foregroundColor(tokens.accentTx)
            }
        }
        .chatCardSurface(tokens, identifier: "retry-card")
    }
}

// MARK: - Compaction

struct ChatCardCompaction: View {
    let state: ChatCardCompactionState
    let tokens: Tokens

    var body: some View {
        let running = state.phase == .running
        VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            HStack(spacing: Metrics.spacing.sp2) {
                Image(systemName: "sparkles")
                    .font(.system(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.accent)
                    .symbolEffect(.pulse, isActive: running)
                Text(running ? "Compacting…" : "Compacted")
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.tx1)
                if !state.reason.isEmpty {
                    Text("· \(state.reason)")
                        .font(.manta(size: Metrics.type.xs))
                        .foregroundColor(tokens.tx4)
                }
            }
            if running {
                if !state.text.isEmpty {
                    Text(state.text)
                        .font(.manta(size: Metrics.type.xs, design: .monospaced))
                        .foregroundColor(tokens.tx3)
                        .lineLimit(3)
                }
            } else if let line = state.firstLine, !line.isEmpty {
                Text(line)
                    .font(.manta(size: Metrics.type.xs, design: .monospaced))
                    .foregroundColor(tokens.tx3)
                    .lineLimit(2)
            }
        }
        .chatCardSurface(tokens, identifier: "compaction-card")
    }
}

/// The quiet "Compacted while you were away" line — the box's own text.
struct ChatCardCompactionNoticeView: View {
    let notice: ChatCardCompactionNotice
    let tokens: Tokens

    var body: some View {
        Text(notice.text)
            .font(.manta(size: Metrics.type.xs))
            .foregroundColor(tokens.tx4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Metrics.spacing.sp1)
            .accessibilityIdentifier("compaction-notice")
    }
}

// MARK: - Blocked — needs a decision

struct ChatCardBlocked: View {
    let progress: MantaProgress
    let tokens: Tokens

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            HStack(spacing: Metrics.spacing.sp2) {
                Circle().fill(tokens.warn).frame(width: Metrics.spacing.sp2, height: Metrics.spacing.sp2)
                Text("Blocked — needs a decision")
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.tx1)
            }
            if !progress.detail.isEmpty {
                Text(ChatCardMarkdown.inline(progress.detail))
                    .font(.manta(size: Metrics.type.xs))
                    .foregroundColor(tokens.tx3)
            }
        }
        .chatCardSurface(tokens, tint: tokens.warn, identifier: "blocked-card")
    }
}

// MARK: - Send error with a Reconnect

/// The pinned line for a credential failure: "Claude needs to be reconnected." with
/// Reconnect (opens Accounts focused on that provider) and × (hides THIS error).
struct ChatCardSendErrorLine: View {
    let text: String
    let tokens: Tokens
    let onReconnect: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: Metrics.spacing.sp2) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: Metrics.type.small))
                .foregroundColor(tokens.danger)
            Text(text)
                .font(.manta(size: Metrics.type.xs, weight: .semibold))
                .foregroundColor(tokens.danger)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: onReconnect) {
                Text("Reconnect")
                    .font(.manta(size: Metrics.type.xs, weight: .semibold))
                    .foregroundColor(tokens.accentTx)
                    .padding(.horizontal, Metrics.spacing.sp2)
                    .padding(.vertical, Metrics.spacing.sp1)
                    .background(tokens.accentSoft, in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("send-error-reconnect")
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: Metrics.type.xs, weight: .semibold))
                    .foregroundColor(tokens.tx4)
                    .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss error")
            .accessibilityIdentifier("send-error-dismiss")
        }
        .chatCardSurface(tokens, tint: tokens.danger, identifier: "send-error-line")
    }
}

// MARK: - Background-job approval

struct ChatCardApprovalCard: View {
    let approval: ChatCardApproval
    let busy: Bool
    /// The box refused the rules (or couldn't be reached).
    let error: String?
    let tokens: Tokens
    let onApprove: ([ChatCardApprovalTool]) -> Void
    let onDecline: () -> Void

    /// One editable rule with a stable identity, so removing a middle row does not
    /// hand its text field (focus, in-progress edit) to the row below it.
    private struct RuleRow: Identifiable {
        let id = UUID()
        var tool: ChatCardApprovalTool
    }

    @State private var editing = false
    @State private var rows: [RuleRow]

    private var tools: [ChatCardApprovalTool] { rows.map(\.tool) }

    init(approval: ChatCardApproval, busy: Bool, error: String?, tokens: Tokens,
         onApprove: @escaping ([ChatCardApprovalTool]) -> Void, onDecline: @escaping () -> Void) {
        self.approval = approval
        self.busy = busy
        self.error = error
        self.tokens = tokens
        self.onApprove = onApprove
        self.onDecline = onDecline
        _rows = State(initialValue: approval.tools.map { RuleRow(tool: $0) })
    }

    var body: some View {
        let footnote = ChatCardApprovalLogic.footnote(tools: tools)
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            HStack(spacing: Metrics.spacing.sp2) {
                Image(systemName: "cpu")
                    .font(.system(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.accent)
                Text("Background job approval")
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.tx1)
                if !approval.name.isEmpty {
                    Text("· \(approval.name)")
                        .font(.manta(size: Metrics.type.xs))
                        .foregroundColor(tokens.tx4)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Button(action: onDecline) {
                    Image(systemName: "xmark")
                        .font(.system(size: Metrics.type.xs, weight: .semibold))
                        .foregroundColor(tokens.tx4)
                        .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(busy)
                .accessibilityLabel("Not now")
            }
            if !approval.prompt.isEmpty {
                Text(approval.prompt)
                    .font(.manta(size: Metrics.type.xs))
                    .foregroundColor(tokens.tx3)
                    .lineLimit(2)
            }
            Text("Will be allowed to:")
                .font(.manta(size: Metrics.type.xs))
                .foregroundColor(tokens.tx4)
            if tools.isEmpty && !editing {
                Text("No tools declared.")
                    .font(.manta(size: Metrics.type.xs))
                    .foregroundColor(tokens.tx4)
            }
            ForEach(rows) { row in
                if editing {
                    ruleEditor(id: row.id)
                } else {
                    Text(ChatCardApprovalLogic.ruleLabel(row.tool))
                        .font(.manta(size: Metrics.type.xs, design: .monospaced))
                        .foregroundColor(tokens.tx2)
                        .padding(.horizontal, Metrics.spacing.sp2)
                        .padding(.vertical, Metrics.spacing.sp1)
                        .background(tokens.fill, in: Capsule())
                }
            }
            if editing {
                Button { rows.append(RuleRow(tool: ChatCardApprovalTool(permission: "bash", pattern: ""))) } label: {
                    Label("Add rule", systemImage: "plus")
                        .font(.manta(size: Metrics.type.xs, weight: .semibold))
                        .foregroundColor(tokens.accentTx)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("approval-add-rule")
            }
            Text("Anything not listed is denied (the job will not ask again).")
                .font(.manta(size: Metrics.type.twoXS))
                .foregroundColor(tokens.tx4)
            if let footnote {
                Text(footnote)
                    .font(.manta(size: Metrics.type.twoXS, weight: .semibold))
                    .foregroundColor(tokens.warn)
                    .accessibilityIdentifier("approval-footnote")
            }
            if let error {
                Text(error)
                    .font(.manta(size: Metrics.type.xs, weight: .semibold))
                    .foregroundColor(tokens.danger)
                    .accessibilityIdentifier("approval-error")
            }
            HStack(spacing: Metrics.spacing.sp2) {
                Button { onApprove(tools) } label: {
                    Text("Start job")
                        .font(.manta(size: Metrics.type.small, weight: .semibold))
                        .foregroundColor(footnote == nil && !busy ? tokens.onAccent : tokens.tx4)
                        .padding(.horizontal, Metrics.spacing.sp3)
                        .padding(.vertical, Metrics.spacing.sp2)
                        .background(footnote == nil && !busy ? AnyShapeStyle(tokens.accentSolid) : AnyShapeStyle(tokens.inset), in: Capsule())
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(footnote != nil || busy)
                .accessibilityIdentifier("approval-start")
                Button { editing.toggle() } label: {
                    Text(editing ? "Done editing" : "Edit access")
                        .font(.manta(size: Metrics.type.small, weight: .semibold))
                        .foregroundColor(tokens.accentTx)
                        .padding(.horizontal, Metrics.spacing.sp3)
                        .padding(.vertical, Metrics.spacing.sp2)
                        .background(tokens.accentSoft, in: Capsule())
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(busy)
                Spacer(minLength: 0)
                Button(action: onDecline) {
                    Text("Not now")
                        .font(.manta(size: Metrics.type.small, weight: .medium))
                        .foregroundColor(tokens.tx3)
                        .padding(.horizontal, Metrics.spacing.sp2)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(busy)
                .accessibilityIdentifier("approval-decline")
            }
        }
        .chatCardSurface(tokens, identifier: "approval-card")
        // A different approval starts with its own rules and a closed editor.
        .onChange(of: approval.id) { _, _ in
            rows = approval.tools.map { RuleRow(tool: $0) }
            editing = false
        }
    }

    private func ruleEditor(id: UUID) -> some View {
        HStack(spacing: Metrics.spacing.sp2) {
            TextField("permission", text: binding(id, \.permission))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("pattern", text: binding(id, \.pattern))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button { rows.removeAll { $0.id == id } } label: {
                Image(systemName: "trash")
                    .font(.system(size: Metrics.type.xs))
                    .foregroundColor(tokens.danger)
                    .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove rule")
        }
        .font(.manta(size: Metrics.type.xs, design: .monospaced))
        .foregroundColor(tokens.tx1)
        .padding(.horizontal, Metrics.spacing.sp2)
        .padding(.vertical, Metrics.spacing.sp1)
        .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
    }

    private func binding(_ id: UUID, _ keyPath: WritableKeyPath<ChatCardApprovalTool, String>) -> Binding<String> {
        Binding(
            get: { rows.first { $0.id == id }?.tool[keyPath: keyPath] ?? "" },
            set: { value in
                if let index = rows.firstIndex(where: { $0.id == id }) { rows[index].tool[keyPath: keyPath] = value }
            }
        )
    }
}

// MARK: - Read-only background job

/// Replaces the composer for a background job's session. Content = the box's view,
/// verbatim. Stop confirms first ("Stop this job?").
struct ChatCardReadOnlyJobBar: View {
    let job: ChatCardJobView
    let stopping: Bool
    let tokens: Tokens
    let onGoToParent: () -> Void
    let onStop: () -> Void

    @State private var confirmingStop = false

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            HStack(alignment: .top, spacing: Metrics.spacing.sp2) {
                Image(systemName: "cpu")
                    .font(.system(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.accent)
                VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                    Text(job.headline)
                        .font(.manta(size: Metrics.type.small, weight: .semibold))
                        .foregroundColor(tokens.tx1)
                    Text(job.parentLine)
                        .font(.manta(size: Metrics.type.xs))
                        .foregroundColor(tokens.tx4)
                    Text(job.statusLine)
                        .font(.manta(size: Metrics.type.xs))
                        .foregroundColor(tokens.tx3)
                        .accessibilityIdentifier("read-only-job-status")
                }
            }
            HStack(spacing: Metrics.spacing.sp2) {
                if job.parent != nil {
                    Button(action: onGoToParent) {
                        Label("Go to parent", systemImage: "arrow.left")
                            .font(.manta(size: Metrics.type.small, weight: .semibold))
                            .foregroundColor(tokens.accentTx)
                            .padding(.horizontal, Metrics.spacing.sp3)
                            .padding(.vertical, Metrics.spacing.sp2)
                            .background(tokens.accentSoft, in: Capsule())
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("job-bar-go-to-parent")
                }
                if job.stoppable {
                    Button { confirmingStop = true } label: {
                        Label("Stop", systemImage: "stop.fill")
                            .font(.manta(size: Metrics.type.small, weight: .semibold))
                            .foregroundColor(stopping ? tokens.tx4 : tokens.danger)
                            .padding(.horizontal, Metrics.spacing.sp3)
                            .padding(.vertical, Metrics.spacing.sp2)
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(stopping)
                    .accessibilityIdentifier("job-bar-stop")
                }
            }
        }
        .padding(Metrics.spacing.sp3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.radius.md)
                .stroke(tokens.borderSubtle, lineWidth: Metrics.spacing.spPx)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("read-only-job-bar")
        .confirmActionSheet(
            isPresented: $confirmingStop,
            title: "Stop this job?",
            message: "The job stops and its window stays open.",
            destructiveTitle: "Stop job",
            destructiveAction: onStop
        )
    }
}

// MARK: - Can't confirm this session

/// Shown only while the box could not say whether this session is a background
/// job (`.resolving` after a failed lookup): sends are held until it does.
struct ChatCardResolvingLine: View {
    let retrying: Bool
    let tokens: Tokens
    let onRetry: () -> Void

    var body: some View {
        HStack(spacing: Metrics.spacing.sp2) {
            Text("Can't confirm this session yet — messages you send will wait")
                .font(.manta(size: Metrics.type.xs))
                .foregroundColor(tokens.tx3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: onRetry) {
                Text("Retry")
                    .font(.manta(size: Metrics.type.xs, weight: .semibold))
                    .foregroundColor(retrying ? tokens.tx4 : tokens.accentTx)
                    .padding(.horizontal, Metrics.spacing.sp2)
                    .padding(.vertical, Metrics.spacing.sp1)
                    .background(tokens.accentSoft, in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(retrying)
            .accessibilityIdentifier("resolving-retry")
        }
        .chatCardSurface(tokens, identifier: "resolving-line")
    }
}

// MARK: - Jump to a message

/// "Finding message…" / "Showing an earlier message · Jump to latest".
struct ChatCardFocusChip: View {
    let phase: ChatCardFocusPhase
    let tokens: Tokens
    let onJumpToLatest: () -> Void

    var body: some View {
        switch phase {
        case .none, .failed:
            EmptyView()
        case .locating:
            chip {
                ProgressView().controlSize(.mini)
                Text("Finding message…")
            }
        case .presented:
            chip {
                Text("Showing an earlier message")
                Button(action: onJumpToLatest) {
                    Text("Jump to latest")
                        .font(.manta(size: Metrics.type.xs, weight: .semibold))
                        .foregroundColor(tokens.accentTx)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("focus-jump-to-latest")
            }
        }
    }

    private func chip<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: Metrics.spacing.sp2) { content() }
            .font(.manta(size: Metrics.type.xs))
            .foregroundColor(tokens.tx3)
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.vertical, Metrics.spacing.sp1)
            .background(tokens.panel, in: Capsule())
            .overlay(Capsule().stroke(tokens.borderSubtle, lineWidth: Metrics.spacing.spPx))
            .accessibilityIdentifier("focus-chip")
    }
}
