import SwiftUI

// ===========================================================================
// WS05 Feature B — the list behind the checks chip. The box orders the checks
// (failed → running → passed) and tones each one; this renders them in the order
// received. "Send failures to the agent" APPENDS the box's prompt to the composer
// (never sends it); it is not offered in a read-only chat.
// ===========================================================================

struct GitChecksSheet: View {
    let checks: [GitCheckRun]
    let view: GitChecksView?
    let prURL: String?
    /// nil in a read-only chat: no "Send failures to the agent".
    let bridge: GitComposerBridge?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.colorScheme) private var colorScheme
    @State private var sendMessage: String?

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        NavigationStack {
            List {
                ForEach(Array(checks.enumerated()), id: \.offset) { _, check in
                    row(check)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Checks (\(checks.count))")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) { bottomBar }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    // MARK: Rows

    @ViewBuilder
    private func row(_ check: GitCheckRun) -> some View {
        if let raw = check.url, let url = URL(string: raw) {
            Button { openURL(url) } label: { rowBody(check, linked: true) }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the log")
        } else {
            rowBody(check, linked: false)
        }
    }

    private func rowBody(_ check: GitCheckRun, linked: Bool) -> some View {
        HStack(spacing: Metrics.spacing.sp3) {
            Image(systemName: symbol(check.tone))
                .foregroundColor(color(check.tone))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(check.name)
                    .font(.manta(size: Metrics.type.body))
                    .foregroundColor(tokens.tx1)
                    .lineLimit(2)
                if let raw = check.rawState {
                    Text(raw.replacingOccurrences(of: "_", with: " "))
                        .font(.manta(size: Metrics.type.xs))
                        .foregroundColor(tokens.tx4)
                }
            }
            Spacer(minLength: 0)
            if linked {
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(tokens.tx4)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func symbol(_ tone: GitTone) -> String {
        switch tone {
        case .ok: return "checkmark.circle.fill"
        case .error, .danger: return "xmark.circle.fill"
        case .running, .warn: return "circle.dotted"
        case .muted, .other: return "circle"
        }
    }

    private func color(_ tone: GitTone) -> Color {
        switch tone {
        case .ok: return tokens.ok
        case .error, .danger: return tokens.danger
        case .running, .warn: return tokens.warn
        case .muted, .other: return tokens.tx4
        }
    }

    // MARK: Bottom bar

    @ViewBuilder
    private var bottomBar: some View {
        let prompt = view?.failuresPrompt
        let logs: URL? = view?.logsUrl.flatMap { URL(string: $0) }
        if (prompt != nil && bridge != nil) || logs != nil || sendMessage != nil {
            VStack(spacing: Metrics.spacing.sp2) {
                if let sendMessage {
                    Text(sendMessage)
                        .font(.manta(size: Metrics.type.xs))
                        .foregroundColor(tokens.danger)
                }
                HStack(spacing: Metrics.spacing.sp2) {
                    if let prompt, let bridge {
                        Button {
                            send(prompt, via: bridge)
                        } label: {
                            Label("Send failures to the agent", systemImage: "arrow.turn.down.right")
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    if let logs {
                        Button { openURL(logs) } label: {
                            Label("Open logs", systemImage: "arrow.up.right")
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }
            .padding(.horizontal, Metrics.spacing.sp4)
            .padding(.vertical, Metrics.spacing.sp3)
            .frame(maxWidth: .infinity)
            .background(.bar)
        }
    }

    private func send(_ prompt: String, via bridge: GitComposerBridge) {
        let result = bridge.insert(prompt)
        if let failure = result.failureMessage {
            sendMessage = failure
        } else {
            sendMessage = nil
            dismiss()
        }
    }
}
