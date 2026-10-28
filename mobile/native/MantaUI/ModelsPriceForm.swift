import SwiftUI

// ===========================================================================
// WS09 F5 — "No prices": models whose price the optimizer cannot find, grouped by
// provider (`optimizer:prices.unpricedByProvider`), each with a "Set prices" form
// that sends the four strings AS TYPED to `models:set-price`. The box validates
// (with the desktop's sentences), writes, and returns the refreshed groups.
// ===========================================================================

@MainActor
final class ModelsPriceStore: ObservableObject {
    enum Phase: Equatable {
        case loading
        case loaded([UnpricedGroupWire])
        /// An older box: `optimizer:prices` has no `unpricedByProvider`.
        case updateYourBox
        /// The read failed — the section stays hidden (no noise for a side feature).
        case hidden
    }

    struct Notice: Equatable, Identifiable {
        let id = UUID()
        let modelID: String
        let message: String
        let warning: String?
    }

    @Published private(set) var phase: Phase = .loading
    /// Confirmations kept until the screen is left.
    @Published private(set) var notices: [Notice] = []
    @Published private(set) var saving = false

    private let api: MantaAPIClient

    init(api: MantaAPIClient = .live()) {
        self.api = api
    }

    func start() {
        Task { await refresh() }
    }

    func refresh() async {
        do {
            let prices = try await api.optimizerPrices()
            if let groups = prices.unpricedByProvider {
                phase = .loaded(groups)
            } else if prices.supported == false {
                phase = .hidden
            } else {
                phase = .updateYourBox
            }
        } catch {
            phase = BoxCapabilities.isUnknownChannel(error) ? .updateYourBox : .hidden
        }
    }

    /// The box's verdict, or nil when the call itself failed (then `error` says why).
    func save(providerID: String, modelID: String, input: String, output: String,
              cacheRead: String, cacheWrite: String) async -> (reply: ModelsSetPriceReply?, error: String?) {
        guard !saving else { return (nil, nil) }
        saving = true
        defer { saving = false }
        do {
            let reply = try await api.modelsSetPrice(providerID: providerID, modelID: modelID, input: input,
                                                     output: output, cacheRead: cacheRead, cacheWrite: cacheWrite)
            if reply.ok {
                if let groups = reply.unpricedByProvider { phase = .loaded(groups) } else { await refresh() }
                notices.append(Notice(modelID: modelID, message: reply.message, warning: reply.warning))
            }
            return (reply, nil)
        } catch {
            // The box may have written before the connection dropped: re-read what
            // is unpriced (keeping the list on a failed re-read) and say so plainly.
            if let prices = try? await api.optimizerPrices(), let groups = prices.unpricedByProvider {
                phase = .loaded(groups)
            }
            return (nil, "Couldn't confirm the save — \(ModelsCapability.reason(error)). Pull to refresh to check.")
        }
    }
}

struct ModelsPriceSection: View {
    @ObservedObject var store: ModelsPriceStore

    var body: some View {
        switch store.phase {
        case .loading, .hidden:
            EmptyView()
        case .updateYourBox:
            Section("No prices") { Text(ModelsCapability.updateYourBox).foregroundStyle(.secondary) }
        case .loaded(let groups):
            if !groups.isEmpty || !store.notices.isEmpty {
                Section {
                    ForEach(store.notices) { notice in
                        VStack(alignment: .leading, spacing: 2) {
                            Label("\(notice.modelID) · \(notice.message)", systemImage: "checkmark.circle.fill")
                                .font(.footnote)
                            if let warning = notice.warning {
                                Text(warning).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    ForEach(groups) { group in
                        DisclosureGroup("\(UsageMeters.providerLabel(group.providerID)) · \(group.models.count) \(group.models.count == 1 ? "model" : "models")") {
                            ForEach(group.models, id: \.self) { modelID in
                                NavigationLink("Set prices — \(modelID)") {
                                    ModelsPriceEditor(store: store, providerID: group.providerID, modelID: modelID)
                                }
                            }
                        }
                    }
                } header: {
                    Text("No prices")
                } footer: {
                    Text("The optimizer won't trim a model it can't price.")
                }
            }
        }
    }
}

struct ModelsPriceEditor: View {
    @ObservedObject var store: ModelsPriceStore
    let providerID: String
    let modelID: String
    @Environment(\.dismiss) private var dismiss

    @State private var input = ""
    @State private var output = ""
    @State private var cacheRead = ""
    @State private var cacheWrite = ""
    @State private var fieldError: (field: String, message: String)?
    @State private var formError: String?

    var body: some View {
        Form {
            Section {
                field("Input", placeholder: "e.g. 3", text: $input, key: "input")
                field("Output", placeholder: "e.g. 15", text: $output, key: "output")
                field("Cache read", placeholder: "e.g. 0.3", text: $cacheRead, key: "cacheRead")
                field("Cache write (optional)", placeholder: "e.g. 3.75", text: $cacheWrite, key: "cacheWrite")
            } footer: {
                Text("Dollars per million tokens. Input, output and cache read are required. Leave cache write empty if the provider charges nothing extra to cache.")
            }
            if let formError {
                Section { Text(formError).font(.footnote).foregroundStyle(.red) }
            }
        }
        .navigationTitle(modelID)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if store.saving {
                    HStack(spacing: Metrics.spacing.sp1) {
                        ProgressView()
                        Text("Saving…").font(.footnote)
                    }
                } else {
                    Button("Save") { Task { await save() } }
                }
            }
        }
    }

    private func field(_ title: String, placeholder: String, text: Binding<String>, key: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            LabeledContent(title) {
                TextField(placeholder, text: text)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
            }
            if let error = fieldError, error.field == key {
                Text(error.message).font(.footnote).foregroundStyle(.red)
            }
        }
    }

    private func save() async {
        fieldError = nil
        formError = nil
        let result = await store.save(providerID: providerID, modelID: modelID, input: input, output: output,
                                      cacheRead: cacheRead, cacheWrite: cacheWrite)
        if let error = result.error {
            formError = error
        } else if let reply = result.reply {
            if reply.ok {
                dismiss()
            } else if let field = reply.field {
                fieldError = (field, reply.message)
            } else {
                formError = reply.message
            }
        }
    }
}
