import SwiftUI
import UIKit

// ===========================================================================
// WS07 F7 — the Webhooks card (chat overflow → Webhooks).
//
// Lists this session's inbound webhooks (`webhook:list`) and lets the user revoke
// one (`webhook:delete`). Creating one is the AI's job (the `webhook` tool), so
// there is no create form. Same stock-SwiftUI shape as SchedulesCard. Metadata
// only: the box never sends a signing secret or token.
// ===========================================================================

struct WebhooksCard: View {
    let sessionId: String
    let onClose: () -> Void
    private let api: MantaAPIClient

    @EnvironmentObject private var sessionStore: SessionListStore
    @State private var hooks: [WebhookMeta] = []
    @State private var loaded = false
    @State private var failed = false
    @State private var revokeError: String?
    /// The hook whose URL was just copied — its URL caption reads "Copied" for 1.5 s.
    @State private var copiedID: String?

    init(sessionId: String, onClose: @escaping () -> Void, api: MantaAPIClient = .live()) {
        self.sessionId = sessionId
        self.onClose = onClose
        self.api = api
    }

    var body: some View {
        NavigationStack {
            Group {
                if failed && !loaded {
                    failureState
                } else if loaded {
                    if hooks.isEmpty && revokeError == nil {
                        emptyState
                    } else {
                        list
                    }
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Webhooks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: onClose)
                }
            }
        }
        .task { await load() }
    }

    // MARK: States

    private var failureState: some View {
        VStack(spacing: Metrics.spacing.sp3) {
            Text("Couldn't load webhooks.")
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("webhooks-failed")
            Button("Retry") { Task { await load() } }
                .buttonStyle(.bordered)
        }
    }

    private var emptyState: some View {
        ContentUnavailableView(
            "No webhooks",
            systemImage: "point.3.connected.trianglepath.dotted",
            description: Text("Ask the agent to create one — for example, “have Multica ping this session when the task finishes”.")
        )
    }

    private var list: some View {
        List {
            if let revokeError {
                Section {
                    Text(revokeError)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("webhooks-error")
                }
            }
            ForEach(hooks) { hook in
                row(hook)
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task { await revoke(hook) }
                        } label: {
                            Label("Revoke", systemImage: "trash")
                        }
                    }
            }
        }
        .listStyle(.insetGrouped)
    }

    // MARK: Row

    /// A row with a delivery URL is a button (tap copies it); one without is plain
    /// content — it is not tappable, and its only action is the context menu / swipe.
    @ViewBuilder
    private func row(_ hook: WebhookMeta) -> some View {
        Group {
            if hook.url != nil {
                Button {
                    copy(hook)
                } label: {
                    rowContent(hook)
                }
                .buttonStyle(.plain)
            } else {
                rowContent(hook)
            }
        }
        .contextMenu {
            if hook.url != nil {
                Button {
                    copy(hook)
                } label: {
                    Label("Copy delivery URL", systemImage: "doc.on.doc")
                }
            }
            Button(role: .destructive) {
                Task { await revoke(hook) }
            } label: {
                Label("Revoke", systemImage: "trash")
            }
        }
    }

    private func rowContent(_ hook: WebhookMeta) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(WebhookFormat.title(hook))
                    .font(.body)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if hook.unsigned {
                    Text("Unsigned")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Color.red.opacity(0.15)))
                        .foregroundStyle(.red)
                        .accessibilityHint("No signature required — anyone with the URL can trigger this hook")
                }
            }
            Text(urlCaption(hook))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Text("Last delivery: \(WebhookFormat.lastDelivery(hook))")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    private func urlCaption(_ hook: WebhookMeta) -> String {
        if copiedID == hook.id { return "Copied" }
        return WebhookFormat.displayURL(hook.url) ?? "No delivery URL"
    }

    // MARK: Actions

    private func copy(_ hook: WebhookMeta) {
        guard let url = hook.url else { return }
        UIPasteboard.general.string = url
        copiedID = hook.id
        SessionHaptics.fire(.selection, enabled: sessionStore.hapticsEnabled)
        let id = hook.id
        Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if copiedID == id { copiedID = nil }
        }
    }

    private func load() async {
        do {
            hooks = try await api.listWebhooks(sessionId: sessionId)
            failed = false
        } catch {
            failed = true
        }
        loaded = loaded || !failed
    }

    /// Optimistic removal, then the box call, then a reload. A failure reloads (the
    /// hook comes back) and says so inline.
    private func revoke(_ hook: WebhookMeta) async {
        revokeError = nil
        hooks.removeAll { $0.id == hook.id }
        do {
            try await api.deleteWebhook(id: hook.id)
            await load()
        } catch {
            revokeError = "Couldn't revoke \(WebhookFormat.title(hook)) — \(Self.message(for: error))"
            await load()
        }
    }

    private static func message(for error: Error) -> String {
        switch error {
        case MantaError.server(let message): return message
        case MantaError.transport(let message): return message
        default: return error.localizedDescription
        }
    }
}
