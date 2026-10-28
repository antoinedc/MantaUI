import SwiftUI
import UIKit

// ===========================================================================
// WS08 — the sign-in sheet (add a seat / re-sign a seat) and the two blocks the
// connect flow reuses: the Claude link + code block and the device-code block.
//
// Every control does something and SAYS so: Open reports a link that would not
// open, Copy flips to "Copied", Submit shows "Saving…" until the flow settles,
// Cancel awaits the box and reports both outcomes in the Accounts banner. While
// a sign-in is open on the box the sheet cannot be swiped away.
// ===========================================================================

// MARK: - Link row

/// A link the user opens in Safari, with a Copy button. The box's link is shown
/// without its scheme so the long query stays readable.
struct SignInLinkRow: View {
    let url: URL

    @Environment(\.openURL) private var openURL
    @State private var copied = false
    @State private var openFailed = false

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            Text(url.absoluteString.replacingOccurrences(of: "https://", with: ""))
                .font(.system(.footnote, design: .monospaced))
                .lineLimit(3)
                .truncationMode(.middle)
                .textSelection(.enabled)
            HStack(spacing: Metrics.spacing.sp2) {
                Button("Open") {
                    openFailed = false
                    openURL(url) { accepted in
                        if !accepted { openFailed = true }
                    }
                }
                .buttonStyle(.borderedProminent)
                Button(copied ? "Copied" : "Copy link") {
                    UIPasteboard.general.string = url.absoluteString
                    copied = true
                }
                .buttonStyle(.bordered)
            }
            if openFailed {
                Text("Couldn't open the link — copy it and open it in your browser.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - Claude: link + code

struct ClaudeSignInBlock: View {
    @ObservedObject var session: ClaudeLoginSession

    @State private var code = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
            if let url = session.url {
                Text("Open the link below in your browser, then paste the code Claude shows you here.")
                    .font(.subheadline)
                SignInLinkRow(url: url)
                TextField("Paste the code", text: $code)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.body, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(session.submitting)
                if let error = session.inputError {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
                Button {
                    let value = code
                    Task {
                        await session.submit(value)
                        if session.inputError == nil { code = "" }
                    }
                } label: {
                    if session.submitting {
                        HStack(spacing: Metrics.spacing.sp2) {
                            ProgressView()
                            Text("Saving…")
                        }
                    } else {
                        Text("Submit")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(session.submitting || code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } else {
                HStack(spacing: Metrics.spacing.sp2) {
                    ProgressView()
                    Text("Waiting for the sign-in link…")
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

// MARK: - Device code

struct DeviceCodeBlock: View {
    let url: String
    let instructions: String
    let startedAt: Date
    /// Who wrote the instructions ("ChatGPT"), for the verbatim-message disclosure.
    let messageSource: String

    @State private var copiedCode = false
    @State private var autoCopied = false

    var body: some View {
        let code = DeviceCode.parse(instructions)
        VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
            Text("Step 1 — open this link")
                .font(.subheadline.weight(.semibold))
            if !url.isEmpty, let link = URL(string: url) {
                SignInLinkRow(url: link)
            } else {
                Text("The sign-in link is missing — close this and start again.")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }

            Text("Step 2 — enter the code")
                .font(.subheadline.weight(.semibold))
            if let code {
                HStack(spacing: Metrics.spacing.sp2) {
                    Text(code)
                        .font(.system(.title, design: .monospaced).weight(.semibold))
                        .textSelection(.enabled)
                    Spacer(minLength: 0)
                    Button(copiedCode ? "Copied" : "Copy") {
                        UIPasteboard.general.string = code
                        copiedCode = true
                    }
                    .buttonStyle(.bordered)
                }
                if autoCopied {
                    Text("copied to clipboard")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } else if let hint = DeviceCode.fallback(instructions) {
                Text(hint)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                DisclosureGroup("Message from \(messageSource)") {
                    Text(instructions)
                        .font(.footnote)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            TimelineView(.periodic(from: startedAt, by: 1)) { context in
                Text(formatRemaining(startedAt: startedAt, now: context.date, limit: SignInClock.serverLoginLimit))
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: Metrics.spacing.sp2) {
                ProgressView()
                Text("Waiting for you to approve it…")
                    .foregroundStyle(.secondary)
            }
        }
        .onAppear {
            if let code, !autoCopied {
                UIPasteboard.general.string = code
                autoCopied = true
            }
        }
    }
}

// MARK: - Sheet

struct AccountsSignInSheet: View {
    @StateObject private var controller: AccountsSeatSignIn
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    init(request: AccountsSignInRequest, store: AccountsStore) {
        _controller = StateObject(wrappedValue: AccountsSeatSignIn(request: request, accounts: store))
    }

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
                    header
                    content
                }
                .padding(Metrics.spacing.sp3)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(controller.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        Task { await controller.cancel() }
                    }
                    .disabled(controller.cancelling)
                }
            }
        }
        .interactiveDismissDisabled(controller.isOpen)
        .task { controller.begin() }
        .onChange(of: controller.shouldDismiss) { _, shouldDismiss in
            if shouldDismiss { dismiss() }
        }
        .onDisappear { controller.abandonIfOpen() }
    }

    // MARK: Header (re-sign only)

    @ViewBuilder
    private var header: some View {
        if let subtitle = controller.subtitle {
            VStack(alignment: .leading, spacing: 4) {
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let lead = controller.lead, showsLead {
                    Text(lead)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var showsLead: Bool {
        switch controller.phase {
        case .starting, .claude, .device: return true
        case .tosNote, .differentOrg, .done, .failed: return false
        }
    }

    // MARK: Phases

    @ViewBuilder
    private var content: some View {
        switch controller.phase {
        case .tosNote:
            tosNote
        case .starting:
            HStack(spacing: Metrics.spacing.sp2) {
                ProgressView()
                Text("Preparing sign-in…").foregroundStyle(.secondary)
            }
        case .claude:
            if let session = controller.claudeSession {
                ClaudeSignInBlock(session: session)
            } else {
                HStack(spacing: Metrics.spacing.sp2) {
                    ProgressView()
                    Text("Preparing sign-in…").foregroundStyle(.secondary)
                }
            }
        case .device(let url, let instructions, let startedAt):
            DeviceCodeBlock(url: url, instructions: instructions, startedAt: startedAt, messageSource: controller.deviceMessageSource)
        case .differentOrg(let orgName, let busy):
            differentOrg(orgName: orgName, busy: busy)
        case .done(let message):
            Label(message, systemImage: "checkmark.circle.fill")
                .foregroundColor(tokens.ok)
                .accessibilityIdentifier("signin-done")
        case .failed(let message):
            VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
                Text(message)
                    .foregroundColor(tokens.danger)
                HStack(spacing: Metrics.spacing.sp2) {
                    Button("Try again") { controller.retry() }
                        .buttonStyle(.borderedProminent)
                    Button("Close") {
                        Task { await controller.cancel() }
                    }
                    .buttonStyle(.bordered)
                    .disabled(controller.cancelling)
                }
            }
        }
    }

    private var tosNote: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
            Text(AccountsSignInCopy.termsNote)
                .font(.subheadline)
            Button(AccountsSignInCopy.termsAcknowledge) { controller.acknowledgeTerms() }
                .buttonStyle(.borderedProminent)
        }
    }

    private func differentOrg(orgName: String?, busy: Bool) -> some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
            Text(AccountsSignInCopy.differentOrgPrompt(orgName: orgName, accountLabel: controller.targetAccountLabel))
                .foregroundColor(tokens.warn)
            if let error = controller.inlineError {
                Text(error)
                    .font(.footnote)
                    .foregroundColor(tokens.danger)
            }
            HStack(spacing: Metrics.spacing.sp2) {
                Button {
                    Task { await controller.createNewAccount() }
                } label: {
                    if busy {
                        HStack(spacing: Metrics.spacing.sp2) {
                            ProgressView()
                            Text("Creating…")
                        }
                    } else {
                        Text("Create new account")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
                Button("Cancel") {
                    Task { await controller.cancel() }
                }
                .buttonStyle(.bordered)
                .disabled(busy || controller.cancelling)
            }
        }
    }
}
