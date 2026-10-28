import Foundation
import Combine

// ===========================================================================
// WS01 F1 — the box-wide owner of LIVE media state.
//
// The `media` bus kind (begin | show | fail) and the session's running edges are
// folded into one `TranscriptMediaSessionState` per session by the pure reducer
// (TranscriptMediaModel.swift). The store is in memory only, like the desktop's:
// after a relaunch the persisted `media_begin` / `media_show` tool parts bring
// the media back (`TranscriptMediaParse.canonicalEntries`).
//
// Bound once at the app root, next to `WidgetLiveStore`. A fresh instance exists
// only in tests.
//
// The turn counter comes from `MantaEventStore.sessionStates` — every turn, whoever
// started it (prompt, queued drain, background result, scheduled prompt), flips a
// session's `running`. No new server field and no input from another workstream.
// ===========================================================================

@MainActor
final class TranscriptMediaStore: ObservableObject {
    /// The app-wide instance, registered with the `/events` stream once at the
    /// app root (see `bind`).
    static let shared = TranscriptMediaStore()

    @Published private(set) var sessions: [String: TranscriptMediaSessionState] = [:]

    private var bound = false
    private var cancellables = Set<AnyCancellable>()
    /// The last `running` value seen per session, so the sink only reacts to an
    /// EDGE, not to every frame that republishes `sessionStates`.
    private var lastRunning: [String: Bool] = [:]

    /// Register as a consumer of `kind: "media"` frames and of every session's
    /// running state. Idempotent — safe to call repeatedly (it binds once).
    func bind(eventStore: MantaEventStore) {
        guard !bound else { return }
        bound = true
        eventStore.addRawFrameHandler { [weak self] frame in
            self?.handleFrame(frame)
        }
        eventStore.$sessionStates
            .receive(on: DispatchQueue.main)
            .sink { [weak self] states in
                guard let self else { return }
                for (sessionID, state) in states {
                    guard let running = state.running, self.lastRunning[sessionID] != running else { continue }
                    self.lastRunning[sessionID] = running
                    self.observeRunning(sessionID: sessionID, running: running)
                }
            }
            .store(in: &cancellables)
    }

    /// Route a raw `/events` frame into this store if it is a media frame.
    func handleFrame(_ frame: MantaStreamFrame) {
        guard frame.kind == "media", let sessionID = frame.sessionId, !sessionID.isEmpty else { return }
        guard let payload = try? frame.decodedPayload(TranscriptMediaFrame.self) else { return }
        let before = sessions[sessionID] ?? TranscriptMediaSessionState()
        var state = before
        state.apply(payload, now: Date())
        // An ignored frame changes nothing: do not republish.
        if state != before { sessions[sessionID] = state }
    }

    /// A session's `running` edge. Also the unit-test seam. `false` for a session
    /// the store has never seen changes nothing (no junk entry per idle session).
    func observeRunning(sessionID: String, running: Bool) {
        if running {
            var state = sessions[sessionID] ?? TranscriptMediaSessionState()
            state.observeRunning(true)
            sessions[sessionID] = state
        } else if var state = sessions[sessionID], state.turnOpen {
            state.observeRunning(false)
            sessions[sessionID] = state
        }
    }

    /// This session's live entries, in (seq, id) order with `inCurrentTurn` set.
    func entries(for sessionID: String) -> [TranscriptMediaEntry] {
        sessions[sessionID]?.vended() ?? []
    }
}
