import SwiftUI
import UIKit
import os

// ===========================================================================
// WS04 §6 / D14 — the GitHub device sign-in: the ONE iOS implementation
// (WS05 reuses it unchanged). Store + view; the state machine is the pure
// `GitHubDeviceFlow` (CloneFromGitHubSignInLogic.swift).
//
// Lifecycle (binding, WS05 §C.3):
//   - ONE poll task (`pollTask`). `start()` cancels and replaces it; nothing
//     else creates one. It waits a full interval before the first poll.
//   - `generation` counts attempts. `start()` bumps it BEFORE awaiting the
//     server, and every await site proceeds only if its captured generation is
//     still current — so a late start reply (no grant yet) and a late poll reply
//     from a cancelled / restarted attempt are both dropped: they can never
//     connect, change the flow or reschedule.
//   - `cancel()` is awaited: bump generation, cancel the task, then (if a grant
//     is outstanding) await the server cancel. A failed server cancel is logged
//     by the live adapter and never blocks dismissal.
//   - Foreground: `sceneBecameActive()` expires the code if its time is up and
//     wakes the EXISTING loop; the loop polls at once only when a full interval
//     has passed. With no loop running the wake is a no-op.
// ===========================================================================

/// The seam the store talks to, so tests drive it with a fake.
protocol GitHubDeviceSignInAPI: Sendable {
    func start() async throws -> GitHubDeviceStart
    func poll(grantId: String) async throws -> GitHubDevicePoll
    /// Non-throwing for callers: the live adapter catches and logs.
    func cancel(grantId: String) async
}

/// The live adapter over `MantaAPIClient`.
struct ServerGitHubDeviceSignIn: GitHubDeviceSignInAPI {
    private let client: MantaAPIClient
    private static let log = Logger(subsystem: "com.antoinedc.mantaui", category: "github-device")

    init(client: MantaAPIClient = MantaAPIClient.live()) {
        self.client = client
    }

    func start() async throws -> GitHubDeviceStart {
        try await client.forgeDeviceStart()
    }

    func poll(grantId: String) async throws -> GitHubDevicePoll {
        try await client.forgeDevicePoll(grantId: grantId)
    }

    func cancel(grantId: String) async {
        do {
            try await client.forgeDeviceCancel(grantId: grantId)
        } catch {
            Self.log.error("github device cancel failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}

@MainActor
final class GitHubDeviceSignInStore: ObservableObject {
    @Published private(set) var flow = GitHubDeviceFlow()
    /// A transient "Copied" line under the code.
    @Published private(set) var note: String?

    private let api: GitHubDeviceSignInAPI
    private let now: () -> Date
    private let pasteboard: (String) -> Void

    /// Attempt counter. Bumped by `start()` before it awaits and by `cancel()`.
    private var generation = 0
    private var pollTask: Task<Void, Never>?
    private var timerTask: Task<Void, Never>?
    /// The loop's wake channel: a foreground event and the timer both land here,
    /// and the loop re-evaluates on either.
    private var wake: AsyncStream<Void>.Continuation?
    /// The grant the server still holds for us (cleared once it is spent).
    private var outstandingGrantID: String?
    private var noteToken = UUID()

    init(
        api: GitHubDeviceSignInAPI = ServerGitHubDeviceSignIn(),
        now: @escaping () -> Date = Date.init,
        pasteboard: @escaping (String) -> Void = { UIPasteboard.general.string = $0 }
    ) {
        self.api = api
        self.now = now
        self.pasteboard = pasteboard
    }

    // MARK: - Lifecycle

    /// Begin (or restart) the sign-in. The previous attempt's task and grant are
    /// dropped first.
    func start() {
        generation += 1
        let attempt = generation
        let stale = outstandingGrantID
        stopLoop()
        outstandingGrantID = nil
        note = nil
        flow = GitHubDeviceFlow()
        if let stale {
            let api = self.api
            Task { await api.cancel(grantId: stale) }
        }
        pollTask = Task { [weak self] in
            await self?.run(attempt: attempt)
        }
    }

    /// Stop everything and release the server-side grant. Awaited so a caller
    /// can dismiss after the cancel has completed.
    func cancel() async {
        generation += 1
        stopLoop()
        guard let grantID = outstandingGrantID else { return }
        outstandingGrantID = nil
        await api.cancel(grantId: grantID)
    }

    /// The app is foreground again (the user is usually back from Safari).
    func sceneBecameActive() {
        flow.tick(now: now())
        wake?.yield()
    }

    /// Called once a second by the countdown: expires the code with no request.
    func tick() {
        let before = flow.stage
        flow.tick(now: now())
        if flow.stage != before { wake?.yield() }
    }

    func copyCode() {
        guard let code = flow.grant?.userCode else { return }
        pasteboard(code)
        showNote("Code copied to clipboard")
    }

    func copyLink() {
        guard let uri = flow.grant?.verificationUri else { return }
        pasteboard(uri)
        showNote("Link copied")
    }

    // MARK: - The loop

    private func isCurrent(_ attempt: Int) -> Bool {
        attempt == generation && !Task.isCancelled
    }

    private func stopLoop() {
        pollTask?.cancel()
        pollTask = nil
        timerTask?.cancel()
        timerTask = nil
        wake?.finish()
        wake = nil
    }

    private func run(attempt: Int) async {
        let reply: GitHubDeviceStart
        do {
            reply = try await api.start()
        } catch {
            guard isCurrent(attempt) else { return }
            flow.startFailed()
            return
        }
        guard isCurrent(attempt) else {
            // A reply that arrived after we were dismissed: if it carried a
            // grant, the server is holding it for nobody.
            if let grantID = reply.grant?.grantId { await api.cancel(grantId: grantID) }
            return
        }
        flow.started(reply, now: now())
        guard flow.stage == .code, let grant = flow.grant else { return }
        outstandingGrantID = grant.grantId
        pasteboard(grant.userCode)
        showNote("Code copied to clipboard")

        let (stream, continuation) = AsyncStream<Void>.makeStream()
        wake = continuation
        scheduleTimer(attempt: attempt)
        for await _ in stream {
            guard isCurrent(attempt) else { break }
            let current = now()
            flow.tick(now: current)
            guard flow.stage == .code, let grantID = flow.grant?.grantId else { break }
            if GitHubDeviceFlow.shouldPollNow(lastPoll: flow.lastPoll, now: current, interval: flow.interval) {
                await pollOnce(attempt: attempt, grantID: grantID)
                guard isCurrent(attempt), flow.stage == .code else { break }
            }
            scheduleTimer(attempt: attempt)
        }
        if attempt == generation { releaseSpentGrant() }
    }

    private func pollOnce(attempt: Int, grantID: String) async {
        do {
            let reply = try await api.poll(grantId: grantID)
            guard isCurrent(attempt) else { return }
            flow.polled(reply, now: now())
        } catch {
            guard isCurrent(attempt) else { return }
            flow.pollThrew(now: now())
        }
    }

    /// One timer, aimed at the earlier of "next poll is due" and "the code
    /// expires", so expiry shows without a request.
    private func scheduleTimer(attempt: Int) {
        timerTask?.cancel()
        let current = now()
        var delay = TimeInterval(flow.interval)
        if let last = flow.lastPoll {
            delay = max(0, TimeInterval(flow.interval) - current.timeIntervalSince(last))
        }
        if let remaining = flow.remaining(now: current) {
            delay = min(delay, max(0, remaining))
        }
        timerTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(0.05, delay) * 1_000_000_000))
            guard !Task.isCancelled, let self, self.generation == attempt else { return }
            self.wake?.yield()
        }
    }

    /// The grant is spent once the flow ended in anything but a live code.
    private func releaseSpentGrant() {
        if flow.stage != .code { outstandingGrantID = nil }
    }

    private func showNote(_ text: String) {
        note = text
        let token = UUID()
        noteToken = token
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            guard let self, self.noteToken == token else { return }
            self.note = nil
        }
    }
}

// MARK: - View

struct GitHubDeviceSignInView: View {
    let onConnected: () -> Void
    let onCancel: () -> Void

    @StateObject private var store = GitHubDeviceSignInStore()
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @Environment(\.colorScheme) private var colorScheme
    @State private var started = false
    @State private var reportedConnected = false

    init(onConnected: @escaping () -> Void, onCancel: @escaping () -> Void) {
        self.onConnected = onConnected
        self.onCancel = onCancel
    }

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp4) {
            content
            Spacer(minLength: 0)
        }
        .padding(Metrics.spacing.sp4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(tokens.canvas.ignoresSafeArea())
        .navigationTitle("Connect GitHub")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            guard !started else { return }
            started = true
            store.start()
        }
        .onDisappear {
            // Swipe-down / parent navigation: release the grant, don't wait.
            Task { await store.cancel() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.sceneBecameActive() }
        }
        .onChange(of: store.flow.stage) { _, stage in
            guard stage == .connected, !reportedConnected else { return }
            reportedConnected = true
            onConnected()
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.flow.stage {
        case .starting:
            HStack(spacing: Metrics.spacing.sp3) {
                ProgressView()
                Text("Preparing sign-in…")
                    .foregroundColor(tokens.tx3)
            }
            cancelButton("Cancel")
        case .code:
            codeContent
        case .notConfigured:
            message("GitHub sign-in isn't configured on this server yet.")
            cancelButton("Back")
        case .expired:
            message("The sign-in code expired before it was entered.")
            HStack(spacing: Metrics.spacing.sp3) {
                Button("Try again") { store.start() }
                    .buttonStyle(.borderedProminent)
                cancelButton("Skip for now")
            }
        case .error(let text):
            message("Couldn't sign in: \(text)")
            HStack(spacing: Metrics.spacing.sp3) {
                Button("Try again") { store.start() }
                    .buttonStyle(.borderedProminent)
                cancelButton("Cancel")
            }
        case .connected:
            HStack(spacing: Metrics.spacing.sp3) {
                ProgressView()
                Text("Connected")
                    .foregroundColor(tokens.tx3)
            }
        }
    }

    private var codeContent: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp4) {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                Text("Connect GitHub")
                    .font(.title3.weight(.semibold))
                    .foregroundColor(tokens.tx1)
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text("Waiting for sign-in · \(countdown(at: context.date)) remaining")
                        .font(.footnote)
                        .foregroundColor(tokens.tx3)
                        .monospacedDigit()
                        .onChange(of: context.date) { _, _ in store.tick() }
                }
            }

            if let grant = store.flow.grant {
                step("1", "Open this link") {
                    HStack(spacing: Metrics.spacing.sp3) {
                        Button {
                            if let url = URL(string: grant.verificationUri) { openURL(url) }
                        } label: {
                            Text("Open \(GitHubDeviceFlow.displayURL(grant.verificationUri))")
                        }
                        .buttonStyle(.borderedProminent)
                        Button("Copy link") { store.copyLink() }
                            .buttonStyle(.bordered)
                    }
                }
                step("2", "Enter the code") {
                    HStack(spacing: Metrics.spacing.sp3) {
                        Text(grant.userCode)
                            .font(.system(size: 28, weight: .semibold, design: .monospaced))
                            .foregroundColor(tokens.tx1)
                            .textSelection(.enabled)
                        Button("Copy code") { store.copyCode() }
                            .buttonStyle(.bordered)
                    }
                }
            }

            Text(store.note ?? " ")
                .font(.footnote)
                .foregroundColor(tokens.ok)
                .opacity(store.note == nil ? 0 : 1)
                .accessibilityHidden(store.note == nil)

            cancelButton("Cancel")
        }
    }

    private func countdown(at date: Date) -> String {
        GitHubDeviceFlow.countdownLabel(remaining: store.flow.remaining(now: date) ?? 0)
    }

    private func step<Content: View>(_ number: String, _ title: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .top, spacing: Metrics.spacing.sp3) {
            Text(number)
                .font(.footnote.weight(.semibold))
                .foregroundColor(tokens.tx3)
                .frame(width: 22, height: 22)
                .background(tokens.fill, in: Circle())
            VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .foregroundColor(tokens.tx1)
                content()
            }
        }
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .font(.body)
            .foregroundColor(tokens.tx2)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Cancel / Back / Skip: the grant is released BEFORE the owner is told.
    private func cancelButton(_ title: String) -> some View {
        Button(title) {
            Task {
                await store.cancel()
                onCancel()
            }
        }
        .buttonStyle(.bordered)
    }
}
