import SwiftUI

// ===========================================================================
// WS08 — the "Connect <provider>" sheet (Claude / Codex / Kimi). One phase per
// screen, the same copy as the Mac app. Cancel awaits the box and reports a
// failed cleanup in the Accounts banner; while a sign-in is in progress the
// sheet cannot be swiped away.
// ===========================================================================

struct ProviderConnectSheet: View {
    @StateObject private var flow: ProviderConnectFlow
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openURL) private var openURL

    init(status: SubscriptionStatus, accounts: AccountsStore, connections: ProviderConnectionsStore) {
        _flow = StateObject(wrappedValue: ProviderConnectFlow(status: status, accounts: accounts, connections: connections))
    }

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
                    Text(flow.phaseLabel)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                    content
                }
                .padding(Metrics.spacing.sp3)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(flow.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        Task { await flow.cancel() }
                    }
                    .disabled(flow.cancelling)
                }
            }
        }
        .interactiveDismissDisabled(flow.isOpen)
        .task { flow.begin() }
        .onChange(of: flow.shouldDismiss) { _, shouldDismiss in
            if shouldDismiss { dismiss() }
        }
        .onDisappear { flow.abandonIfOpen() }
    }

    // MARK: Phases

    @ViewBuilder
    private var content: some View {
        switch flow.phase {
        case .starting:
            VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                HStack(spacing: Metrics.spacing.sp2) {
                    ProgressView()
                    Text(flow.waitingForPrevious ? "Closing the previous sign-in…" : "Connecting…")
                        .foregroundStyle(.secondary)
                }
            }

        case .waiting(let url, let instructions):
            DeviceCodeBlock(url: url, instructions: instructions, startedAt: flow.waitStartedAt, messageSource: flow.deviceMessageSource)

        case .needsCode(_, let url, let instructions, let error):
            VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
                Text("Open the page below, sign in, then paste the code it shows you here.")
                    .font(.subheadline)
                if !url.isEmpty, let link = URL(string: url) {
                    SignInLinkRow(url: link)
                }
                if !instructions.isEmpty {
                    Text(instructions)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                TextField("Code from the page", text: $flow.codeDraft)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.body, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(flow.submitting)
                fieldError(flow.fieldError ?? error)
                Button {
                    Task { await flow.submitCode() }
                } label: {
                    submitLabel("Submit")
                }
                .buttonStyle(.borderedProminent)
                .disabled(flow.submitting || flow.codeDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

        case .needsKey(let consoleURL, let error):
            VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
                Text("Paste your \(flow.status.displayName) API key. It is stored on your box and never shown again.")
                    .font(.subheadline)
                if let consoleURL, let link = URL(string: consoleURL) {
                    Button("Get a key") { openURL(link) }
                        .buttonStyle(.bordered)
                }
                SecureField("API key", text: $flow.keyDraft)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(flow.submitting)
                fieldError(flow.fieldError ?? error)
                Button {
                    Task { await flow.submitKey() }
                } label: {
                    submitLabel("Save")
                }
                .buttonStyle(.borderedProminent)
                .disabled(flow.submitting || flow.keyDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

        case .needsClaudeLogin:
            if let session = flow.claudeSession {
                ClaudeSignInBlock(session: session)
            } else {
                HStack(spacing: Metrics.spacing.sp2) {
                    ProgressView()
                    Text("Preparing sign-in…").foregroundStyle(.secondary)
                }
            }

        case .installingClaudeCli:
            VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                HStack(spacing: Metrics.spacing.sp2) {
                    ProgressView()
                    Text("Installing…").foregroundStyle(.secondary)
                }
                Text(ProviderConnectCopy.installing)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

        case .applying:
            HStack(spacing: Metrics.spacing.sp2) {
                ProgressView()
                Text("Waiting for \(flow.status.displayName) to come online…")
                    .foregroundStyle(.secondary)
            }

        case .done:
            Label(ProviderConnectCopy.connected(label: flow.status.displayName), systemImage: "checkmark.circle.fill")
                .foregroundColor(tokens.ok)

        case .failed(let message, let claudeInstall):
            VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
                Text(message)
                    .foregroundColor(tokens.danger)
                HStack(spacing: Metrics.spacing.sp2) {
                    Button("Retry") { flow.retry() }
                        .buttonStyle(.borderedProminent)
                    if claudeInstall, let manual = URL(string: ProviderConnectCopy.installManuallyURL) {
                        Button("Install manually") { openURL(manual) }
                            .buttonStyle(.bordered)
                    }
                    Button(claudeInstall ? "Use a different model" : "Close") {
                        Task { await flow.cancel() }
                    }
                    .buttonStyle(.bordered)
                    .disabled(flow.cancelling)
                }
            }
        }
    }

    @ViewBuilder
    private func fieldError(_ text: String?) -> some View {
        if let text {
            Text(text)
                .font(.footnote)
                .foregroundColor(tokens.danger)
        }
    }

    @ViewBuilder
    private func submitLabel(_ title: String) -> some View {
        if flow.submitting {
            HStack(spacing: Metrics.spacing.sp2) {
                ProgressView()
                Text("Saving…")
            }
        } else {
            Text(title)
        }
    }
}
