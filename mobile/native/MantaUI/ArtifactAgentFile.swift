import SwiftUI
import UIKit
import os

// ===========================================================================
// WS07 F6 — the agent-sent file notice: store + view + UIKit presenter.
//
// The decisions live in `AgentFileNoticeMachine` (ArtifactAgentFileModel.swift,
// pure + unit-tested). This file only (1) feeds it arrivals from the box's
// `agentFile` bus event, (2) downloads / stages / deletes the temp files its
// effects ask for, and (3) presents the Files exporter or the share sheet from
// the top-most view controller.
// ===========================================================================

/// What the view must put on screen once a download has landed.
struct AgentFilePresentation: Equatable {
    let token: UInt64
    let opID: UInt64
    let op: AgentFileNotice.Op
    let fileURL: URL
}

@MainActor
final class ArtifactAgentFileStore: ObservableObject {
    @Published private(set) var machine = AgentFileNoticeMachine()

    /// Set by the view: present the exporter / share sheet. When nil (no view to
    /// present from) the operation ends as a cancelled presentation — the staged
    /// copy is removed and the notice is back to idle.
    var presenter: ((AgentFilePresentation) -> Void)?
    /// A new notice was accepted (not a duplicate) — the view announces it.
    var onArrival: ((AgentFileEvent) -> Void)?
    /// A save was confirmed by the Files exporter — the view fires the haptic.
    var onSaved: (() -> Void)?

    private let download: @Sendable (String) async throws -> Data
    private let tempRoot: URL
    private let sleep: @Sendable (Duration) async -> Void
    private var bound = false
    private static let log = Logger(subsystem: "com.antoinedc.mantaui", category: "agent-file")
    /// Parent directory name of every staged `<UUID>` folder; deletion is limited to it.
    static let stagingDirName = "manta-agentfile"

    init(
        download: @escaping @Sendable (String) async throws -> Data = { path in
            try await MantaAPIClient.live().downloadOutboxFile(path: path)
        },
        tempRoot: URL = FileManager.default.temporaryDirectory,
        sleep: @escaping @Sendable (Duration) async -> Void = { duration in
            _ = try? await Task.sleep(for: duration)
        }
    ) {
        self.download = download
        self.tempRoot = tempRoot
        self.sleep = sleep
    }

    /// Idempotent: a second call registers no second handler.
    func bind(eventStore: MantaEventStore) {
        guard !bound else { return }
        bound = true
        eventStore.addRawFrameHandler { [weak self] frame in
            guard let event = AgentFileEvent.from(frame) else { return }
            self?.receive(event)
        }
    }

    func receive(_ event: AgentFileEvent) {
        let before = machine
        machine.receive(event)
        if machine != before { onArrival?(event) }
    }

    func save() { start(.save) }
    func share() { start(.share) }

    func dismiss() {
        execute(machine.dismiss())
    }

    /// Called by the exporter / share-sheet delegate with the `(token, opID,
    /// fileURL)` it was presented with.
    func presentationFinished(token: UInt64, opID: UInt64, fileURL: URL, completed: Bool) {
        let effect = machine.presentationFinished(token: token, opID: opID, fileURL: fileURL, completed: completed)
        if case .scheduleSavedTimer = effect { onSaved?() }
        execute(effect)
    }

    // MARK: - Download

    private func start(_ op: AgentFileNotice.Op) {
        guard let begun = machine.begin(op), let event = machine.current?.event else { return }
        let download = self.download
        let root = tempRoot
        Task { [weak self] in
            let result: Result<URL, AgentFileFailure>
            do {
                let data = try await download(event.remotePath)
                result = .success(try Self.stage(data, name: event.name, root: root))
            } catch let failure as AgentFileFailure {
                result = .failure(failure)
            } catch {
                Self.log.error("download of an agent-sent file failed: \(error.localizedDescription, privacy: .public)")
                result = .failure(.download)
            }
            self?.downloadFinished(token: begun.token, opID: begun.opID, result: result)
        }
    }

    private func downloadFinished(token: UInt64, opID: UInt64, result: Result<URL, AgentFileFailure>) {
        let effect = machine.downloadFinished(token: token, opID: opID, result: result)
        execute(effect)
        guard case .success(let url) = result,
              let notice = machine.current, notice.token == token,
              case .presenting(let op, let runningID, _) = notice.phase, runningID == opID else { return }
        let presentation = AgentFilePresentation(token: token, opID: opID, op: op, fileURL: url)
        if let presenter {
            presenter(presentation)
        } else {
            presentationFinished(token: token, opID: opID, fileURL: url, completed: false)
        }
    }

    /// `tempRoot/manta-agentfile/<UUID>/<name>` — the real filename, so Files and
    /// the share sheet show it.
    private static func stage(_ data: Data, name: String, root: URL) throws -> URL {
        let safe = name.replacingOccurrences(of: "/", with: "_").trimmingCharacters(in: .whitespaces)
        let directory = root
            .appendingPathComponent(stagingDirName, isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(safe.isEmpty ? "file" : safe)
            try data.write(to: url)
            return url
        } catch {
            log.error("staging an agent-sent file failed: \(error.localizedDescription, privacy: .public)")
            throw AgentFileFailure.write
        }
    }

    // MARK: - Effects

    private func execute(_ effect: AgentFileEffect) {
        switch effect {
        case .none:
            break
        case .deleteTemp(let url):
            removeStaged(url)
        case .scheduleSavedTimer(let token, let opID):
            let sleep = self.sleep
            Task { [weak self] in
                await sleep(.seconds(2))
                self?.savedTimerFired(token: token, opID: opID)
            }
        }
    }

    func savedTimerFired(token: UInt64, opID: UInt64) {
        execute(machine.savedTimerFired(token: token, opID: opID))
    }

    /// Remove a staged file's `<UUID>` directory. Limited to folders this store
    /// created (their parent is `manta-agentfile`); an already-missing one is a no-op.
    private func removeStaged(_ url: URL) {
        let directory = url.deletingLastPathComponent()
        guard directory.deletingLastPathComponent().lastPathComponent == Self.stagingDirName,
              FileManager.default.fileExists(atPath: directory.path) else { return }
        do {
            try FileManager.default.removeItem(at: directory)
        } catch {
            Self.log.error("removing a staged agent file failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}

// MARK: - Presenting (UIKit)

/// Presents the Files exporter / share sheet from the top-most view controller —
/// a second SwiftUI presentation on the app root would collide with the session
/// list's own sheets.
@MainActor
enum ArtifactPresenter {
    static func topMost(from window: UIWindow?) -> UIViewController? {
        let resolved = window ?? UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }
        var top = resolved?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }

    /// `UIDocumentPickerViewController(forExporting:asCopy:)`. `onFinish(true)` when
    /// the user picked a destination, `false` when cancelled/dismissed.
    static func exportToFiles(url: URL, from top: UIViewController, onFinish: @escaping @MainActor (Bool) -> Void) {
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        picker.delegate = ExportDelegate(onFinish: onFinish)
        top.present(picker, animated: true)
    }

    /// `UIActivityViewController`. `onFinish(completed)` from its completion handler.
    static func share(url: URL, from top: UIViewController, onFinish: @escaping @MainActor (Bool) -> Void) {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.popoverPresentationController?.sourceView = top.view
        controller.popoverPresentationController?.sourceRect = CGRect(
            x: top.view.bounds.midX, y: top.view.bounds.maxY - 1, width: 1, height: 1)
        controller.completionWithItemsHandler = { _, completed, _, _ in
            Task { @MainActor in onFinish(completed) }
        }
        top.present(controller, animated: true)
    }

    /// One delegate per presentation. `UIDocumentPickerViewController.delegate` is
    /// weak, so the delegate keeps itself alive until the picker reports back.
    @MainActor
    private final class ExportDelegate: NSObject, UIDocumentPickerDelegate {
        private var keepAlive: ExportDelegate?
        private let onFinish: @MainActor (Bool) -> Void

        init(onFinish: @escaping @MainActor (Bool) -> Void) {
            self.onFinish = onFinish
            super.init()
            keepAlive = self
        }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            finish(!urls.isEmpty)
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            finish(false)
        }

        private func finish(_ completed: Bool) {
            let callback = onFinish
            keepAlive = nil
            callback(completed)
        }
    }
}

// MARK: - The notice

/// Holds the window the notice is drawn in, so the exporter / share sheet present
/// from the right scene.
@MainActor
private final class ArtifactWindowBox {
    weak var window: UIWindow?
}

private struct ArtifactWindowReader: UIViewRepresentable {
    let box: ArtifactWindowBox

    func makeUIView(context: Context) -> ReaderView {
        let view = ReaderView()
        view.isUserInteractionEnabled = false
        view.box = box
        return view
    }

    func updateUIView(_ view: ReaderView, context: Context) {
        view.box = box
        box.window = view.window
    }

    final class ReaderView: UIView {
        var box: ArtifactWindowBox?
        override func didMoveToWindow() {
            super.didMoveToWindow()
            box?.window = window
        }
    }
}

/// The bottom floating "AI sent you a file" card, mounted once over the paired root
/// (M-07-3). Visible over the session list and pushed chats; under a modal (Settings,
/// a chat sheet) the event is kept by the store and the notice is waiting, still
/// actionable, when the modal closes.
struct ArtifactAgentFileNotice: View {
    @EnvironmentObject private var eventStore: MantaEventStore
    @EnvironmentObject private var sessionStore: SessionListStore
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var store = ArtifactAgentFileStore()
    @State private var windowBox = ArtifactWindowBox()

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        ZStack(alignment: .bottom) {
            ArtifactWindowReader(box: windowBox)
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
            if let notice = store.machine.current {
                card(notice)
                    .padding(.horizontal, Metrics.spacing.sp3)
                    .padding(.bottom, Metrics.spacing.sp3)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: store.machine.current?.token)
        .task {
            store.presenter = { presentation in present(presentation) }
            store.onArrival = { event in
                UIAccessibility.post(
                    notification: .announcement,
                    argument: "AI sent you a file: \(AgentFileNoticeCopy.title(event))")
            }
            store.onSaved = { SessionHaptics.fire(.success, enabled: sessionStore.hapticsEnabled) }
            store.bind(eventStore: eventStore)
        }
    }

    // MARK: Card

    private func card(_ notice: AgentFileNotice) -> some View {
        let busy = Self.isBusy(notice.phase)
        return HStack(alignment: .top, spacing: Metrics.spacing.sp3) {
            Image(systemName: "arrow.down.doc")
                .font(.system(size: Metrics.type.body, weight: .semibold))
                .foregroundStyle(tokens.accent)
                .frame(width: Metrics.spacing.sp5)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                Text(headline(notice))
                    .font(.manta(size: Metrics.type.body, weight: .semibold))
                    .foregroundStyle(tokens.tx1)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(subline(notice))
                    .font(.manta(size: Metrics.type.xs))
                    .foregroundStyle(isFailed(notice.phase) ? tokens.danger : tokens.tx3)
                    .lineLimit(3)
                HStack(spacing: Metrics.spacing.sp2) {
                    actionButton("Save", busyTitle: "Saving…", systemImage: "square.and.arrow.down",
                                 op: .save, notice: notice, busy: busy)
                    actionButton("Share", busyTitle: "Preparing…", systemImage: "square.and.arrow.up",
                                 op: .share, notice: notice, busy: busy)
                    if let badge = AgentFileNoticeCopy.pendingBadge(store.machine.queued.count) {
                        Text(badge)
                            .font(.manta(size: Metrics.type.xs))
                            .foregroundStyle(tokens.tx3)
                    }
                }
                .padding(.top, Metrics.spacing.sp1)
            }
            Spacer(minLength: 0)
            Button {
                store.dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: Metrics.type.small, weight: .semibold))
                    .foregroundStyle(tokens.tx3)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(isPresenting(notice.phase))
            .accessibilityLabel("Dismiss")
        }
        .padding(Metrics.spacing.sp3)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: Metrics.radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Metrics.radius.lg).stroke(tokens.border))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("agent-file-notice")
    }

    private func actionButton(_ title: String, busyTitle: String, systemImage: String,
                              op: AgentFileNotice.Op, notice: AgentFileNotice, busy: Bool) -> some View {
        let working: Bool = {
            if case .downloading(let running, _) = notice.phase { return running == op }
            return false
        }()
        return Button {
            switch op {
            case .save: store.save()
            case .share: store.share()
            }
        } label: {
            HStack(spacing: 6) {
                if working {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: systemImage)
                }
                Text(working ? busyTitle : title)
            }
            .font(.manta(size: Metrics.type.small, weight: .semibold))
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(busy)
    }

    private func headline(_ notice: AgentFileNotice) -> String {
        if case .saved = notice.phase { return AgentFileNoticeCopy.savedTitle(notice.event) }
        return AgentFileNoticeCopy.title(notice.event)
    }

    private func subline(_ notice: AgentFileNotice) -> String {
        if case .failed(let message) = notice.phase { return message }
        let title = notice.event.sessionID.flatMap { sessionStore.window(forSessionID: $0)?.window.name }
        return AgentFileNoticeCopy.detail(notice.event, sessionTitle: title)
    }

    /// Both buttons are disabled for every phase except idle / failed (a retry after a
    /// failure is safe — the download is non-destructive).
    private static func isBusy(_ phase: AgentFileNotice.Phase) -> Bool {
        switch phase {
        case .idle, .failed: return false
        case .downloading, .presenting, .saved: return true
        }
    }

    private func isPresenting(_ phase: AgentFileNotice.Phase) -> Bool {
        if case .presenting = phase { return true }
        return false
    }

    private func isFailed(_ phase: AgentFileNotice.Phase) -> Bool {
        if case .failed = phase { return true }
        return false
    }

    // MARK: Presenting

    private func present(_ presentation: AgentFilePresentation) {
        let finish: @MainActor (Bool) -> Void = { [store] completed in
            store.presentationFinished(token: presentation.token, opID: presentation.opID,
                                       fileURL: presentation.fileURL, completed: completed)
        }
        guard let top = ArtifactPresenter.topMost(from: windowBox.window) else {
            finish(false)
            return
        }
        switch presentation.op {
        case .save: ArtifactPresenter.exportToFiles(url: presentation.fileURL, from: top, onFinish: finish)
        case .share: ArtifactPresenter.share(url: presentation.fileURL, from: top, onFinish: finish)
        }
    }
}
