import SwiftUI
import UIKit

// ===========================================================================
// WS08 — one saved custom endpoint inside Settings → Accounts: its name and
// state, its base URL, one on/off switch per model (each writes at once and
// shows what the box actually has afterwards), and a menu with Refresh model
// list / Send probe / Remove endpoint.
//
// Every action ends in a banner (success or failure). An endpoint whose last
// write could not be confirmed disables its switches and offers Refresh — no
// rollback is ever claimed.
// ===========================================================================

struct ProviderEndpointSection: View {
    let endpoint: ProviderEndpoint
    @ObservedObject var store: ProviderConnectionsStore
    let tokens: Tokens

    @State private var confirmRemove = false
    @State private var copiedURL = false

    private var isWriting: Bool { store.writing.contains(endpoint.id) }
    private var isUnconfirmed: Bool { store.unconfirmed.contains(endpoint.id) }

    var body: some View {
        Group {
            titleRow
            Text(endpoint.baseURL)
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .contextMenu {
                    Button(copiedURL ? "Copied" : "Copy URL", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = endpoint.baseURL
                        copiedURL = true
                    }
                }
            if isUnconfirmed { unconfirmedRow }
            ForEach(store.endpointRows(endpoint), id: \.self) { model in
                modelRow(model)
            }
            if endpoint.enabledModels.isEmpty {
                Text(ProviderEndpointModels.noneInPicker)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Title + menu

    private var titleRow: some View {
        HStack(alignment: .top, spacing: Metrics.spacing.sp2) {
            VStack(alignment: .leading, spacing: 2) {
                Text(endpoint.name)
                    .font(.body.weight(.semibold))
                Text(store.registerLine(endpoint) ?? "Custom endpoint")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if isWriting && store.pendingModel[endpoint.id] == nil {
                ProgressView()
            }
            Menu {
                Button("Refresh model list", systemImage: "arrow.clockwise") {
                    Task { await store.refreshModels(endpoint) }
                }
                if store.probeKey(endpoint) != nil {
                    Button("Send probe", systemImage: "waveform.path.ecg") {
                        Task { await store.sendProbe(endpoint) }
                    }
                }
                Button("Remove endpoint…", systemImage: "trash", role: .destructive) {
                    confirmRemove = true
                }
            } label: {
                Image(systemName: "ellipsis.circle").font(.title3)
            }
            .disabled(isWriting)
            .accessibilityLabel("Endpoint actions")
        }
        .confirmActionSheet(
            isPresented: $confirmRemove,
            title: ProviderEndpointCopy.removeTitle(name: endpoint.name),
            message: ProviderEndpointCopy.removeMessage,
            destructiveTitle: ProviderEndpointCopy.removeDestructive,
            destructiveAction: {
                Task { await store.remove(endpoint) }
            }
        )
    }

    private var unconfirmedRow: some View {
        HStack(spacing: Metrics.spacing.sp2) {
            Text(ProviderEndpointCopy.unconfirmedNote(name: endpoint.name))
                .font(.footnote)
                .foregroundColor(tokens.warn)
            Spacer(minLength: 0)
            Button("Refresh") {
                Task { await store.refreshUnconfirmed(endpoint) }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(isWriting)
        }
    }

    // MARK: One model

    private func modelRow(_ model: String) -> some View {
        let isOn = endpoint.enabledModels.contains(model)
        return HStack(alignment: .center, spacing: Metrics.spacing.sp2) {
            VStack(alignment: .leading, spacing: 2) {
                Text(model)
                    .font(.system(.body, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let line = store.modelStateLine(endpoint, model: model) {
                    Text(line)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            if store.pendingModel[endpoint.id] == model {
                ProgressView()
            }
            Toggle("", isOn: Binding(
                get: { isOn },
                set: { newValue in
                    Task { await store.toggle(endpoint, model: model, on: newValue) }
                }
            ))
            .labelsHidden()
            .disabled(isWriting || isUnconfirmed)
        }
    }
}
