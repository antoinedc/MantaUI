import Foundation
import Combine

// ===========================================================================
// S1b — observable event store + degraded mode (BET-593).
//
// The store is the SwiftUI-bindable layer over the /events stream:
//
//   - `connectionState` / `degraded` — the stream lifecycle. `degraded` is the
//     §17 spec: the box became unreachable, so only *new* interpretation stops
//     and NOTHING already delivered may be clear or re-derived.
//   - `sessionStates` — the interpreted per-session state the box publishes on
//     `kind:"stream"` frames, keyed by sessionId, so S4's views can bind.
//   - reconnect with backoff + re-fetch-on-reconnect (via `resyncHandler`) and
//     a heartbeat liveness watchdog (half-open socket detection) mirror
//     src/renderer/api/httpApi.ts.
//
// The device never interprets raw events — every `stream.*` payload here is
// already interpreted by the box (src/server/streamInterp.mjs).
// ===========================================================================

// MARK: - Per-session interpreted state

/// One part's accumulated live text, tagged with the message it belongs to.
///
/// The messageID is the load-bearing field: it is what lets a finished chunk be
/// RETIRED once the canonical transcript carries the same prose. Without it the
/// live copy has no expiry and the screen renders a finished answer twice —
/// once from the transcript, once from the still-live tail (BET-655).
struct StreamTextChunk: Equatable, Sendable {
    var partID: String
    var messageID: String
    var field: String
    var text: String
}

/// A tool call currently in flight (BET-753), keyed by its stable tool part id
/// (`idx`). The device renders it as a LIVE running-tool row (with the
/// accumulated bash tail) that converges to a canonical step row once the
/// turn-boundary refetch lands. Mirror of the server's `st.tools` record.
struct LiveTool: Equatable, Sendable {
    var idx: String
    /// The tool's stable call id — the SAME identity the canonical `ToolStep`
    /// row carries (see `ChatTranscriptMapper.stepIdentity`), so the live row
    /// and its completed canonical sibling share an id and replace in place.
    /// Falls back to `idx` when the box gave no callID.
    var callID: String
    var name: String?
    var presentationHint: String?
    var status: String?
    /// Accumulated incremental stdout tail, concatenated in arrival order.
    var tail: String = ""
    /// True once the `toolEnded` frame lands; an ended tool is no longer
    /// running, but the record is kept for the rest of the turn so the call
    /// still shows (completed, or failed when `ok` is false).
    var ended: Bool = false
    var ok: Bool = true
    var truncated: Bool = false
}

struct MantaSessionStreamState: Equatable, Sendable {
    var sessionId: String
    /// Accumulated flushed text, one entry per (part, field), in ARRIVAL order
    /// (the box already applied flush boundaries; the device just concatenates).
    ///
    /// Ordered on purpose: this used to be a dictionary, whose `values` have no
    /// defined order, so an answer streamed as several parts could reassemble
    /// with its paragraphs shuffled.
    var chunks: [StreamTextChunk] = []
    var running: Bool?
    /// When the running turn started, as reported by the box. Nil when idle.
    var runningSince: Date?
    var turnComplete: Bool?
    var context: StreamContextPayload?
    var cache: StreamCachePayload?
    var truncation: StreamTruncationPayload?
    var sessionError: StreamSessionErrorPayload?
    var todos: StreamTodosPayload?
    var questions: StreamQuestionsPayload?
    var permissions: StreamPermissionsPayload?
    /// The plan-mode state the box last reported for this session (BET-977).
    /// `nil` until a `planMode` frame arrives — mirrors opencode's local switch
    /// so the Plan chip turns itself off the moment the model exits planning.
    var planOn: Bool?
    var subagents: [StreamSubagentPayload] = []
    /// The box's per-window rollup (busy beneath, direct subagent count, stopped) — WS11 D7. Replayed in the connect
    /// snapshot for every windowed session and streamed on change; nil until the first frame (or on an older box).
    var windowStatus: StreamWindowStatusPayload?
    /// The live turn's tool-run ledger as the box reports it (`toolRuns` frames, WS11 D11): the ordered layout, the calls,
    /// which runs closed, and the run values merged by revision.
    var liveRuns = TranscriptLiveRunsState()
    // --- WS02 chat cards. All of it lives for the app's lifetime, so nothing here
    // is "cleared by a timer": transient cards are hidden by a latch in the chat
    // store, keyed by the generation / sequence numbers below.
    /// The provider retry in progress (`retry` frame; a null frame clears it).
    var retry: StreamRetryPayload?
    /// Bumped on every compaction `started`.
    var compactionGeneration = 0
    var compaction: ChatCardCompactionState?
    /// Bumped on every `transcriptStale` (the transcript changed wholesale).
    var transcriptStaleSeq = 0
    /// The box's "Compacted while you were away" line, and its sequence number.
    var compactionNotice: ChatCardCompactionNotice?
    var compactionNoticeSeq = 0
    /// Bumped on every `sessionError` frame: two identical errors are two events.
    var sessionErrorSeq = 0
    /// user message id → the `/command` that produced it (newest 200).
    var commands = ChatCardBoundedLog<StreamCommandExecutedPayload>(limit: 200)
    /// This TURN's live tools keyed by their stable tool part id (`idx`, which
    /// is the opencode part id), and the order they started in. A `toolEnded`
    /// keeps both the record (so the outcome can be reflected) and its place in
    /// the order: the canonical transcript is not refetched mid-turn and skips
    /// the in-progress step message, so until the turn completes these records
    /// are the ONLY source of the turn's finished calls. Both are cleared on
    /// `turnComplete`, when the turn's canonical refetch takes the tools over
    /// as step rows (BET-753).
    var tools: [String: LiveTool] = [:]
    var toolStartOrder: [String] = []

    init(sessionId: String) {
        self.sessionId = sessionId
    }

    /// The still-running tools, in start order — what a running-tool row
    /// renders (BET-753). Ended tools stay in `toolStartOrder` (see `turnTools`)
    /// but are not running.
    var runningTools: [LiveTool] {
        turnTools.filter { !$0.ended }
    }

    /// Every tool of the turn in flight — running AND ended — in start order.
    var turnTools: [LiveTool] {
        toolStartOrder.compactMap { tools[$0] }
    }

    /// partID -> accumulated text, for callers that only want a lookup.
    var textByPart: [String: String] {
        Dictionary(chunks.filter { $0.field != "reasoning" }.map { ($0.partID, $0.text) },
                   uniquingKeysWith: { _, latest in latest })
    }

    var reasoningByPart: [String: String] {
        Dictionary(chunks.filter { $0.field == "reasoning" }.map { ($0.partID, $0.text) },
                   uniquingKeysWith: { _, latest in latest })
    }

    /// The live assistant prose for the turn in flight, in arrival order. Empty
    /// once every chunk has been retired by a canonical transcript that covers
    /// it — which is what stops a finished answer rendering twice.
    ///
    /// Chunks are joined with a PARAGRAPH break (`\n\n`) rather than a single
    /// `\n`: separate step-narrations would otherwise render as a merged single
    /// line in the live tail and then "pop" into separate paragraphs when the
    /// canonical markdown refetch lands (BET-752 task 6).
    var liveText: String {
        chunks
            .filter { $0.field != "reasoning" && !$0.text.isEmpty }
            .map(\.text)
            .joined(separator: "\n\n")
    }

    /// Append a flushed chunk, extending the part's text when it is already
    /// known. Text and reasoning are tracked separately for the same part. A
    /// replay payload carries the whole text so far and replaces it instead.
    mutating func appending(_ payload: StreamFlushPayload) {
        if let i = chunks.firstIndex(where: { $0.partID == payload.partID && $0.field == payload.field }) {
            if payload.replay == true {
                chunks[i].text = payload.text
            } else {
                chunks[i].text += payload.text
            }
        } else {
            chunks.append(StreamTextChunk(
                partID: payload.partID,
                messageID: payload.messageID,
                field: payload.field,
                text: payload.text
            ))
        }
    }
}

// MARK: - Pure routing (box `stream.*` subs -> session state)

enum MantaStreamRouter {
    /// Box-reported start wins; an older box that omits it keeps whatever we
    /// already had, and only a turn we have never seen a start for falls back
    /// to the local clock.
    private static func resolveRunningSince(running: Bool, since: Double?, current: Date?) -> Date? {
        guard running else { return nil }
        if let since { return Date(timeIntervalSince1970: since / 1000) }
        return current ?? Date()
    }

    /// Apply one frame to a session's state. Pure so the mapping is testable.
    /// `epoch` / `connGen`: the connection state a `toolRuns` frame is judged against (the epoch of the LATEST events
    /// connection's `runningSet`, and the connection counter). A frame of another epoch is rejected.
    static func applying(
        _ frame: MantaStreamFrame,
        to state: MantaSessionStreamState?,
        epoch: String? = nil,
        connGen: Int = 0
    ) -> MantaSessionStreamState {
        var s = state ?? MantaSessionStreamState(sessionId: frame.sessionId ?? "")
        apply(frame, to: &s, epoch: epoch, connGen: connGen)
        return s
    }

    /// The same mapping, in place. The store uses this on a state it has taken OUT of its dictionary, so the
    /// streamed text is appended to a uniquely-owned buffer instead of copying everything streamed so far on
    /// every chunk.
    static func apply(
        _ frame: MantaStreamFrame,
        to s: inout MantaSessionStreamState,
        epoch: String? = nil,
        connGen: Int = 0
    ) {
        guard frame.kind == "stream", let sub = frame.sub else { return }
        switch sub {
        case "flush":
            if let p = try? frame.decodedPayload(StreamFlushPayload.self) {
                s.appending(p)
            }
        case "running":
            if let p = try? frame.decodedPayload(StreamRunningPayload.self) {
                s.running = p.running
                s.runningSince = resolveRunningSince(running: p.running, since: p.since, current: s.runningSince)
                // A new turn clears any stale error surfaced by the previous one.
                if p.running { s.sessionError = nil }
                if ChatCardStreamRules.clearsRetry(sub: sub, running: p.running, complete: nil) { s.retry = nil }
            }
        case "turnComplete":
            if let p = try? frame.decodedPayload(StreamTurnCompletePayload.self) {
                s.turnComplete = p.complete
                // The box only ever publishes `running:true` on the `running`
                // sub — the end of a turn is carried HERE, by turnComplete's own
                // `running` field (`session.idle` emits
                // turnComplete{complete:true, running:false} and no `running`
                // frame at all). Ignoring it left `running` latched true for the
                // life of the session, so the working row and session-list timer
                // never stopped.
                s.running = p.running
                s.runningSince = resolveRunningSince(running: p.running, since: p.since, current: s.runningSince)
                if ChatCardStreamRules.clearsRetry(sub: sub, running: nil, complete: p.complete) { s.retry = nil }
            }
            // A finished turn has no running tools; the canonical refetch now
            // owns them as step rows, so drop the live map to bound memory
            // (BET-753).
            s.tools.removeAll()
            s.toolStartOrder.removeAll()
        case "toolStarted":
            if let p = try? frame.decodedPayload(StreamToolStartedPayload.self) {
                let callID = p.callID.flatMap { $0.isEmpty ? nil : $0 } ?? p.idx
                s.tools[p.idx] = LiveTool(
                    idx: p.idx,
                    callID: callID,
                    name: p.toolName,
                    presentationHint: p.toolPresentationHint,
                    status: p.status
                )
                if !s.toolStartOrder.contains(p.idx) { s.toolStartOrder.append(p.idx) }
            }
        case "toolOutput":
            // Appended in place (never copy the tail out and back): a long bash run streams many chunks.
            if let p = try? frame.decodedPayload(StreamToolOutputPayload.self),
               s.tools[p.idx] != nil {
                s.tools[p.idx]?.tail += p.text
                s.tools[p.idx]?.status = "running"
            }
        case "toolEnded":
            if let p = try? frame.decodedPayload(StreamToolEndedPayload.self),
               var t = s.tools[p.idx] {
                t.ended = true
                t.ok = p.ok
                t.truncated = p.truncated ?? false
                s.tools[p.idx] = t
                // Stays in `toolStartOrder`: an ended call is still this turn's
                // (`runningTools` filters on `ended`).
            }
        case "truncation":
            s.truncation = try? frame.decodedPayload(StreamTruncationPayload.self)
        case "sessionError":
            if let p = try? frame.decodedPayload(StreamSessionErrorPayload.self) {
                s.sessionError = p
                s.sessionErrorSeq += 1
            }
        case "retry":
            // A `null` payload (the box clearing the card) fails to decode → nil.
            s.retry = try? frame.decodedPayload(StreamRetryPayload.self)
        case "compaction":
            if let p = try? frame.decodedPayload(StreamCompactionPayload.self) {
                if p.phase == "started" { s.compactionGeneration += 1 }
                s.compaction = ChatCardCompactionReducer.apply(p, to: s.compaction, generation: s.compactionGeneration)
            }
        case "transcriptStale":
            s.compaction = nil
            s.transcriptStaleSeq += 1
        case "optimizer.compacted":
            // An older box sends no `text`: nothing to show, nothing published.
            if let text = (try? frame.decodedPayload(StreamOptimizerCompactedPayload.self))?.text, !text.isEmpty {
                s.compactionNotice = ChatCardCompactionNotice(text: text)
                s.compactionNoticeSeq += 1
            }
        case "commandExecuted":
            if let p = try? frame.decodedPayload(StreamCommandExecutedPayload.self), !p.messageID.isEmpty {
                s.commands.set(p.messageID, p)
            }
        case "context":
            s.context = try? frame.decodedPayload(StreamContextPayload.self)
        case "cache":
            s.cache = try? frame.decodedPayload(StreamCachePayload.self)
        case "todos":
            s.todos = try? frame.decodedPayload(StreamTodosPayload.self)
        case "questions":
            s.questions = try? frame.decodedPayload(StreamQuestionsPayload.self)
        case "permissions":
            s.permissions = try? frame.decodedPayload(StreamPermissionsPayload.self)
        case "windowStatus":
            s.windowStatus = try? frame.decodedPayload(StreamWindowStatusPayload.self)
        case "toolRuns":
            if let p = try? frame.decodedPayload(StreamToolRunsPayload.self) {
                s.liveRuns = s.liveRuns.applying(p, context: TranscriptRunContext(currentEpoch: epoch, connGen: connGen))
            }
        case "planMode":
            s.planOn = try? frame.decodedPayload(StreamPlanModePayload.self)?.on
        case "subagent":
            if let p = try? frame.decodedPayload(StreamSubagentPayload.self) {
                // Upsert keyed by the subagent's child-session id (BET-672): a
                // subagent that goes running→done would otherwise leave BOTH
                // records, so the session list's running-count counts a stale
                // "running" and the array grows without bound. An incoming
                // payload replaces the record for its child, else appends.
                if let i = s.subagents.firstIndex(where: { $0.childSessionId == p.childSessionId }) {
                    s.subagents[i] = p
                } else {
                    s.subagents.append(p)
                }
            }
        case "subagent.child", "autoRename":
            break // registration / rename triggers consumed by later stages
        case "inbox":
            break // the pending list is not session stream state: see `MantaEventStore.inboxFrames`
        default:
            break
        }
    }

    /// Return the box's authoritative start for a running-set entry, or keep
    /// whatever we already had, and NEVER fabricate the local clock.
    ///
    /// `applyingRunningSet` is the reconnect snapshot of ALREADY-running
    /// sessions, so a running entry here is a PERSISTED turn that can predate
    /// the app launch by minutes. The live `stream/running` path may fall back
    /// to `Date()` (a live "just started" edge, pinned by
    /// `testRunningFrameWithoutSinceAndNoExistingFallsBackToNow`), but doing so
    /// here renders a force-quit turn's session-list timer as "0" — it counts
    /// up from the relaunch moment instead of the real box-reported start. So a
    /// running entry whose `since` is missing keeps an existing stamp (an older
    /// box may omit it) and, on a genuinely fresh state, leaves the start
    /// UNKNOWN (`nil`) rather than lying that it began at the launch moment.
    private static func resolveRunningSetSince(_ entry: StreamRunningSetPayload.Entry?, current: Date?) -> Date? {
        guard let entry else { return nil }
        if let since = entry.since { return Date(timeIntervalSince1970: since / 1000) }
        return current
    }

    /// Replace running state across ALL known sessions from the box's
    /// authoritative set. A session absent from the set is not running.
    /// `running` / `runningSince` are reconciled as authoritative, AND
    /// `questions` / `permissions` are cleared so the snapshot (which only
    /// re-emits non-empty lists) can reconcile pending cards (BET-1348).
    /// `turnComplete`, `chunks` and `tools` are deliberately left alone (turn
    /// retirement + tool rows are owned by the reconnect transcript refetch;
    /// synthesising `turnComplete` here would double-fire the completion haptic).
    static func applyingRunningSet(
        _ payload: StreamRunningSetPayload,
        to states: [String: MantaSessionStreamState]
    ) -> [String: MantaSessionStreamState] {
        var next = states
        let bySession = Dictionary(uniqueKeysWithValues: payload.sessions.map { ($0.sessionId, $0) })
        for (sid, var s) in next {
            let entry = bySession[sid]
            s.running = entry != nil
            s.runningSince = resolveRunningSetSince(entry, current: s.runningSince)
            // The box does not replay `retry`: a session that is no longer
            // running has no retry in progress.
            if entry == nil { s.retry = nil }
            // An authoritative replay starts here (BET-1348): the box's connect
            // snapshot only emits a `questions` / `permissions` frame for
            // sessions whose list is NON-empty, so a card answered while the
            // device was disconnected would otherwise stay latched forever.
            // Clearing both makes the snapshot authoritative for pending cards,
            // exactly as `running` is — the snapshot's own frames repopulate
            // whatever is still pending. Same-path, correctly-ordered marker.
            s.questions = nil
            s.permissions = nil
            // C4: the row's asks (its own and the ones beneath it) are replayed with the rest of the snapshot.
            s.windowStatus?.attention = nil
            s.windowStatus?.attentionBelow = nil
            next[sid] = s
        }
        // A session the device has never seen a frame for can still be running.
        for entry in payload.sessions where next[entry.sessionId] == nil {
            var s = MantaSessionStreamState(sessionId: entry.sessionId)
            s.running = true
            s.runningSince = resolveRunningSetSince(entry, current: nil)
            next[entry.sessionId] = s
        }
        return next
    }

    /// Retire the live chunks whose message the canonical transcript now
    /// carries. Pure so the retirement rule is testable without a socket.
    ///
    /// The contract is caller-enforced: `covered` names ONLY the message ids
    /// the canonical transcript actually renders — i.e. COMPLETED assistant
    /// messages (`ChatTranscriptMapper` skips any assistant message still in
    /// flight, and `opencode:messages` returns the running one with no
    /// `time.completed`). So a chunk is retired exactly when a second,
    /// permanent copy of its prose already exists in the transcript, and the
    /// still-streaming message is protected simply by never appearing in
    /// `covered`.
    ///
    /// This replaces a "keep the last chunk while running" guard that was wrong
    /// twice over: one turn is SEVERAL assistant messages (one per step), so
    /// the last chunk is frequently a completed step rather than the streaming
    /// one; and it read `running`, a flag that latches true (the box only ever
    /// publishes `running:true` on the `running` sub — see `applying`), so the
    /// guard fired against a stale value. Kept pure, same signature, idempotent.
    static func retiring(_ state: MantaSessionStreamState, covered: Set<String>) -> MantaSessionStreamState {
        var s = state
        s.chunks.removeAll { covered.contains($0.messageID) }
        return s
    }
}

// MARK: - Liveness policy (pure)

enum MantaLivenessPolicy {
    /// true when the socket reports connected but no frame (incl. heartbeats)
    /// has arrived within `staleMs` — a half-open path the OS didn't surface.
    static func shouldForceReconnect(state: MantaConnectionState, lastFrameAt: Date, now: Date, staleMs: Double) -> Bool {
        guard state.name == "connected" else { return false }
        return (now.timeIntervalSince(lastFrameAt) * 1000.0) > staleMs
    }
}

// MARK: - Stream control abstraction (injectable so the store is testable)

@MainActor
protocol MantaEventStreamControl: AnyObject {
    var onState: ((MantaConnectionState) -> Void)? { get set }
    var onMessage: ((String) -> Void)? { get set }
    var onReconnect: (() -> Void)? { get set }
    var onConfigError: ((Error) -> Void)? { get set }
    var hasConnectedOnce: Bool { get }
    var currentState: MantaConnectionState { get }
    func ensure()
    func markReconnectAndEnsure()
    func retryNow()
    func forceReconnect()
    func close(reason: String)
    /// Send one text message (the C1 `kinds` / `focus` messages) over the live socket. A control with no
    /// socket (the test fakes) ignores it.
    func send(_ text: String)
    /// The app moved to / from the background: only there does the controller give up reconnecting.
    func setBackground(_ background: Bool)
}

extension MantaEventStreamControl {
    func send(_ text: String) {}
    func setBackground(_ background: Bool) {}
}

/// A control whose socket parses frames off the main actor and delivers them already parsed.
@MainActor
protocol MantaPreparsedFrameSource: AnyObject {
    var onFrame: ((MantaStreamFrame) -> Void)? { get set }
}

extension MantaReconnectController: MantaEventStreamControl {}
extension MantaReconnectController: MantaPreparsedFrameSource {}

// MARK: - Raw-frame registrations (B6)

/// One raw-frame consumer and the envelope kinds it declares. The socket's `kinds=` subscription is the
/// union of every registration (plus what the store consumes itself), so what the box sends is derived from
/// who is listening, never kept by hand.
@MainActor
final class MantaRawFrameRegistration {
    let kinds: Set<String>
    fileprivate let handler: (MantaStreamFrame) -> Void

    fileprivate init(kinds: Set<String>, handler: @escaping (MantaStreamFrame) -> Void) {
        self.kinds = kinds
        self.handler = handler
    }
}

/// The subscription the connect URL is built from. A reference type so the controller's URL closure (made
/// before the store exists) reads the CURRENT union at every connect.
@MainActor
final class MantaEventSubscriptionState {
    var kinds: Set<String> = MantaEventKinds.storeOwned
}

// MARK: - The store

@MainActor
final class MantaEventStore: ObservableObject {

    @Published private(set) var connectionState: MantaConnectionState = .idle
    @Published private(set) var degraded = false
    /// The interpreted per-session state, keyed by sessionId. DELIBERATELY not `@Published`: a streamed chunk
    /// used to republish this whole dictionary, which redrew every view that observed the store. Views observe
    /// the per-session stores instead, and everything else reacts to `sessionChanges` / `rowStatusChanges`
    /// (edges only). Read it directly for the current value.
    private(set) var sessionStates: [String: MantaSessionStreamState] = [:]
    /// One value per real change of one session's state, sent AFTER the state is stored. Nothing is sent for a
    /// frame that changed nothing.
    let sessionChanges = PassthroughSubject<MantaSessionChange, Never>()
    /// Fires when what a session-list row shows (running, start, window rollup, pending asks) changes — never
    /// for streamed text.
    let rowStatusChanges = PassthroughSubject<Void, Never>()
    private var rowSignatures: [String: MantaRowSignature] = [:]
    /// Routing stamp of the MOST RECENT stream frame the store applied: which
    /// session it was for and which `sub` it carried. A consumer woken by `sessionChanges` can't tell from
    /// the ACCUMULATED snapshot which fields the frame just delivered; this is the per-frame delta the
    /// single-writer merge (BET-668) feeds off.
    private(set) var lastStreamFrame: StreamFrameStamp?

    /// Bumped on every authoritative running-set apply. A consumer holding
    /// optimistic local running state compares against this to know the box
    /// has since spoken definitively.
    private(set) var runningSetSeq: Int = 0

    /// The box's interpreter epoch, announced by the LATEST connection's `runningSet` (nil until it arrives, and on an
    /// older box that sends none). Run values of any other epoch are rejected (WS11 D11).
    @Published private(set) var connectionEpoch: String?
    /// Bumped on every transition to connected. An RPC answer issued under an older value is discarded for the run map.
    private(set) var connGen: Int = 0

    /// Which session the most recent stream frame targeted and the `sub` it
    /// carried. `sub == nil` for a non-routed frame (nothing turn-state-related
    /// changed).
    struct StreamFrameStamp: Equatable {
        var sessionId: String
        var sub: String?
    }
    /// Invoked on every healthy reconnect so the app re-fetches state that may
    /// have changed while disconnected (rather than assuming the stream
    /// resumed). S4 wires this to re-fetch sessions / messages / permissions /
    /// questions.
    var resyncHandler: (() -> Void)?

    /// Event frames we do NOT understand from the interpreted stream are still
    /// delivered here (`status`, `model-prefs.updated`, …) for consumers that want them. A MULTICAST list
    /// rather than a single closure — `SessionListStore` and the `ChatModelPrefs` cache each register once; a
    /// single-owner closure would let the second clobber the first (BET-1282). Each registration declares the
    /// kinds it consumes and only receives those.
    private var rawFrameHandlers: [MantaRawFrameRegistration] = []

    /// Fires once for every `delegate.updated` frame — a background job
    /// started, progressed, finished or was stopped. A `Subject` rather than
    /// another raw handler because its observers come and go (a Background jobs
    /// sheet lives only while it is on screen) and a handler list has no way to
    /// unsubscribe. The frame still reaches the raw handlers too.
    let delegateUpdates = PassthroughSubject<Void, Never>()

    /// The same `delegate.updated` frames, with their payload (`id`, `status`,
    /// `activity`, and the box's progress `view`), so the Background jobs store
    /// can patch one job in place instead of re-reading the whole list. Sent for
    /// every frame — an older box's payload simply carries no view.
    let delegateJobUpdates = PassthroughSubject<BackgroundJobUpdate, Never>()

    /// Fires for every `inbox` stream frame (the session's pending messages,
    /// K3). A `Subject`, not part of `sessionStates`: the pending list carries
    /// its own `(epoch, rev)` and is accepted or dropped by the observing
    /// session's `InboxTracker`, so a frame replayed from stored state could
    /// only ever be stale. Frames for a session nobody observes are dropped —
    /// the observer seeds itself with `opencode:inbox` when it opens.
    let inboxFrames = PassthroughSubject<InboxFrameEvent, Never>()

    /// Fires once for every `accounts.updated` / `accounts.moved` frame — a seat
    /// list, mode, active seat, status or assignment changed, or the box moved
    /// a conversation to another seat. A `Subject` for the same reason as
    /// `delegateUpdates`: its observers (the Accounts screen, a chat's seat
    /// view) come and go, and a handler list cannot unsubscribe. The frame still
    /// reaches the raw handlers too.
    let accountsUpdates = PassthroughSubject<AccountsBusEvent, Never>()

    /// Fires once for every `handoff` frame — a handoff record changed state
    /// (auto-handoff §11). A `Subject` for the same reason as `delegateUpdates`:
    /// its observers are per-chat stores that come and go, and the handler list
    /// cannot unsubscribe. The frame still reaches the raw handlers too.
    let handoffUpdates = PassthroughSubject<HandoffBusEvent, Never>()

    /// Fires for every `progress.updated` frame, with the session id: the model's
    /// own progress report changed (the "Blocked — needs a decision" card reads
    /// it). A `Subject` for the same reason as `delegateUpdates`.
    let progressUpdates = PassthroughSubject<String, Never>()

    /// Fires for every `delegate.approval.requested` frame: a background job is
    /// waiting for the user's go-ahead. The payload is not session-enveloped, so
    /// the observing chat filters on `parentSessionID`. The 3-second poll in the
    /// approval store is the safety net for a missed frame.
    let delegateApprovalRequests = PassthroughSubject<ChatCardApproval, Never>()

    /// Register a raw (non-`stream`, non-`runningSet`) frame observer for the envelope `kinds` it consumes.
    /// The `/events` subscription is the union of every registration, so a kind nobody asks for is never sent
    /// to this device. A registration made after connect updates the subscription at once. The returned token
    /// removes the registration again (`removeRawFrameHandler`); most consumers live as long as the app and
    /// ignore it.
    @discardableResult
    func addRawFrameHandler(kinds: Set<String>, _ handler: @escaping (MantaStreamFrame) -> Void) -> MantaRawFrameRegistration {
        let registration = MantaRawFrameRegistration(kinds: kinds, handler: handler)
        rawFrameHandlers.append(registration)
        refreshSubscription()
        return registration
    }

    func removeRawFrameHandler(_ registration: MantaRawFrameRegistration) {
        rawFrameHandlers.removeAll { $0 === registration }
        refreshSubscription()
    }

    /// The kinds this device currently asks the box for.
    var subscribedKinds: Set<String> { subscription.kinds }

    private func refreshSubscription() {
        let union = MantaEventKinds.union(registrations: rawFrameHandlers.map(\.kinds))
        guard union != subscription.kinds else { return }
        subscription.kinds = union
        if connectionState.name == "connected" { controller.send(MantaEventKinds.kindsMessage(union)) }
    }

    // MARK: Focus (C1)

    private var focus = MantaFocusSet()

    /// Ask the box for the heavy stream frames (`flush`, `toolOutput`, `messageChanged`) of `sessions`, on behalf
    /// of `owner` (a chat screen). The message goes out BEFORE the caller fetches the transcript, so no chunk
    /// can fall between the fetch and the focus taking effect (overlap is absorbed by the dedupe).
    func setFocus(owner: String, sessions: [String]) {
        if focus.set(owner: owner, sessions: sessions) { sendFocus() }
    }

    func clearFocus(owner: String) {
        if focus.remove(owner: owner) { sendFocus() }
    }

    /// Drop every owner's focus (the session list is back in front: no chat is open).
    func clearAllFocus() {
        let before = focus.sessions
        focus = MantaFocusSet()
        if !before.isEmpty { sendFocus() }
    }

    /// The union currently focused (test seam).
    var focusedSessions: [String] { focus.sessions }

    private func sendFocus() {
        guard connectionState.name == "connected" else { return }
        controller.send(MantaEventKinds.focusMessage(focus.sessions))
    }

    /// Both messages, after every (re)connect: the URL carried the kinds, but a registration may have landed
    /// since, and the box starts every connection with no focus.
    private func sendSubscription() {
        controller.send(MantaEventKinds.kindsMessage(subscription.kinds))
        controller.send(MantaEventKinds.focusMessage(focus.sessions))
    }

    private let controller: any MantaEventStreamControl
    private let subscription: MantaEventSubscriptionState
    /// The clock the background/foreground decisions read (injectable for tests).
    private let clock: () -> Date
    private var lastFrameAt: Date
    private var lastStateChangeAt = Date()
    private var watchdog: Timer?
    /// When the app went to the background, nil while in front.
    private var backgroundedAt: Date?
    private var backgroundCloseTask: Task<Void, Never>?
    /// Sessions that have a live observer attached (a `ChatSessionStore` that
    /// has `start()`ed and not yet `stop()`ed). The store clears a session's
    /// accumulated stream chunks when its turn completes while NO observer is
    /// attached — nothing would ever retire them, so they'd otherwise
    /// accumulate without bound (BET-672).
    private(set) var registeredSessionIDs: Set<String> = []
    /// No frame (heartbeats included) for this long means the socket is dead
    /// even if it claims otherwise. Shared by the watchdog and `resume()`.
    private let staleFrameMs: Double = 45_000

    init(
        stream: (any MantaEventStreamControl)? = nil,
        tokenProvider: @escaping () -> String? = { KeychainCredentialStore.shared.boxToken },
        serverProvider: @escaping () -> URL? = { KeychainCredentialStore.shared.serverURL },
        clock: @escaping () -> Date = { Date() }
    ) {
        self.lastFrameAt = Date()
        self.clock = clock
        let subscription = MantaEventSubscriptionState()
        self.subscription = subscription
        let controller = stream ?? Self.makeController(
            tokenProvider: tokenProvider,
            serverProvider: serverProvider,
            kinds: { subscription.kinds }
        )
        self.controller = controller
        controller.onState = { [weak self] state in self?.handleState(state) }
        controller.onMessage = { [weak self] text in self?.handleFrame(text) }
        controller.onReconnect = { [weak self] in self?.handleReconnect() }
        controller.onConfigError = { _ in }
        // The real socket parses frames off the main actor; only the decoded value comes here.
        if let source = controller as? any MantaPreparsedFrameSource {
            source.onFrame = { [weak self] frame in self?.handleParsedFrame(frame) }
        }
    }

    static func makeController(
        tokenProvider: @escaping () -> String?,
        serverProvider: @escaping () -> URL?,
        kinds: @escaping @MainActor () -> Set<String> = { MantaEventKinds.storeOwned }
    ) -> any MantaEventStreamControl {
        MantaReconnectController(
            url: { Self.eventsWebSocketURL(from: serverProvider(), kinds: kinds()) },
            makeSocket: { url in
                MantaURLSessionWebSocket(authHeader: Self.bearer(token: tokenProvider()))
            },
            // Retry from 1 s up to 30 s, with jitter, for as long as the app is in front; the give-up is a
            // background-only rule.
            backoff: ExponentialBackoff(base: 1000, max: 30_000),
            windowAppliesInForeground: false
        )
    }

    /// Connect the stream (idempotent) and arm the liveness watchdog.
    func start() {
        controller.ensure()
        startWatchdog()
    }

    /// The app left the foreground. The socket is closed after a short grace (a quick app switch keeps it);
    /// while it is down the controller's reconnect give-up applies.
    func enteredBackground() {
        guard backgroundedAt == nil else { return }
        backgroundedAt = clock()
        controller.setBackground(true)
        backgroundCloseTask?.cancel()
        backgroundCloseTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(MantaForegroundPolicy.backgroundCloseGraceSeconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.closeForBackground()
        }
    }

    func closeForBackground() {
        guard backgroundedAt != nil else { return }
        backgroundCloseTask = nil
        watchdog?.invalidate()
        watchdog = nil
        controller.close(reason: MantaCloseReason.background)
    }

    /// App foreground / resume: bring the stream back and re-fetch missed state.
    ///
    /// After at least the background grace away the socket is ALWAYS reopened — a fresh snapshot replay is
    /// worth more than trusting a socket the OS may have torn down while the process was suspended. After a
    /// shorter trip it is reopened unless demonstrably healthy: not `connected`, or no frame (heartbeats
    /// included) for longer than the watchdog's staleness bar. `ensure()` alone is not enough, since a dead
    /// socket can still report itself open.
    func resume() {
        backgroundCloseTask?.cancel()
        backgroundCloseTask = nil
        let away = backgroundedAt.map { clock().timeIntervalSince($0) }
        backgroundedAt = nil
        controller.setBackground(false)
        let stale = MantaLivenessPolicy.shouldForceReconnect(
            state: connectionState,
            lastFrameAt: lastFrameAt,
            now: Date(),
            staleMs: staleFrameMs
        )
        switch MantaForegroundPolicy.onForeground(
            awayFor: away,
            connected: connectionState.name == "connected",
            stale: stale
        ) {
        case .keep:
            controller.markReconnectAndEnsure()
        case .forceReconnect:
            controller.forceReconnect()
        }
        lastFrameAt = Date()
        lastStateChangeAt = Date()
        // Timers are suspended with the process; re-arm rather than assume the
        // watchdog survived the trip to the background.
        startWatchdog()
    }

    /// Permanent teardown.
    func stop() {
        backgroundCloseTask?.cancel()
        backgroundCloseTask = nil
        watchdog?.invalidate()
        watchdog = nil
        controller.close(reason: MantaCloseReason.storeStopped)
    }

    func restart() {
        controller.retryNow()
    }

    /// Tear down / stop scheduling — leaves delivered data intact.
    func leaveDegradedWithRetry() {
        restart()
    }

    // MARK: - Controller callbacks

    private func handleState(_ state: MantaConnectionState) {
        let wasConnected = connectionState.name == "connected"
        let nowConnected = state.name == "connected"
        // A new connection retires every answer issued before it, and its epoch is unknown until its `runningSet`.
        if nowConnected, !wasConnected {
            connGen += 1
            connectionEpoch = nil
        }
        if state.name != connectionState.name { lastStateChangeAt = Date() }
        connectionState = state
        // Closing the socket for the background on purpose is not an outage.
        if case .closed(let reason) = state, reason == MantaCloseReason.background {
            // keep `degraded` as it was
        } else {
            degraded = controller.hasConnectedOnce && state.isUnreachable
        }
        if nowConnected, !wasConnected { sendSubscription() }
    }

    /// A frame as text (a control without an off-main parser, and every test fake).
    private func handleFrame(_ text: String) {
        lastFrameAt = Date()
        guard let frame = try? MantaStreamFrame.parse(text) else { return }
        dispatch(frame)
    }

    /// A frame the socket already parsed off the main actor.
    private func handleParsedFrame(_ frame: MantaStreamFrame) {
        lastFrameAt = Date()
        dispatch(frame)
    }

    private func dispatch(_ frame: MantaStreamFrame) {
        if frame.isHeartbeat { return }
        if frame.kind == "runningSet" {
            applyRunningSet(frame)
        } else if frame.kind == "stream" {
            routeStream(frame)
        } else {
            if frame.kind == "delegate.updated" {
                delegateUpdates.send()
                delegateJobUpdates.send(BackgroundJobUpdate(payload: frame.payload))
            }
            if frame.kind == "progress.updated",
               let sid = ChatJSON.string(ChatJSON.object(frame.payload)?["sessionID"]), !sid.isEmpty {
                progressUpdates.send(sid)
            }
            if frame.kind == "delegate.approval.requested",
               let approval = try? frame.decodedPayload(ChatCardApproval.self) {
                delegateApprovalRequests.send(approval)
            }
            if let accountsEvent = AccountsBusEvent.from(frame) { accountsUpdates.send(accountsEvent) }
            if let handoffEvent = HandoffBusEvent.from(frame: frame) { handoffUpdates.send(handoffEvent) }
            for registration in rawFrameHandlers where registration.kinds.contains(frame.kind) {
                registration.handler(frame)
            }
        }
    }

    /// Store one session's changed state and tell whoever cares: the session's own observers always, the
    /// session list only when a row-visible field moved.
    private func announce(_ sid: String, sub: String?, state: MantaSessionStreamState) {
        sessionChanges.send(MantaSessionChange(sessionId: sid, sub: sub))
        // Streamed text and tool output never change a row.
        if sub == "flush" || sub == "toolOutput" { return }
        let signature = MantaRowSignature(state)
        if rowSignatures[sid] != signature {
            rowSignatures[sid] = signature
            rowStatusChanges.send()
        }
    }

    /// The box's authoritative running set, replayed on every (re)connect.
    /// Deliberately NOT behind `routeStream`'s `degraded` guard: a client that
    /// discarded frames while unreachable is exactly the client whose running
    /// state needs correcting the moment it hears from the box again.
    ///
    /// It is also the start of the box's replay (C4): every session's ask-derived state is cleared here and the
    /// frames that follow repopulate whatever still asks.
    private func applyRunningSet(_ frame: MantaStreamFrame) {
        guard let p = try? frame.decodedPayload(StreamRunningSetPayload.self) else { return }
        let before = sessionStates
        sessionStates = MantaStreamRouter.applyingRunningSet(p, to: sessionStates)
        runningSetSeq += 1
        // The connection's epoch: every session's run values of another epoch are dropped, queued writes apply.
        if connectionEpoch != p.epoch {
            connectionEpoch = p.epoch
            for (sid, var s) in sessionStates {
                let next = s.liveRuns.settingEpoch(p.epoch, connGen: connGen)
                if next != s.liveRuns {
                    s.liveRuns = next
                    sessionStates[sid] = s
                }
            }
        }
        for (sid, state) in sessionStates where before[sid] != state {
            announce(sid, sub: "runningSet", state: state)
        }
        sessionChanges.send(.runningSetApplied)
    }

    private func routeStream(_ frame: MantaStreamFrame) {
        if frame.sub == "inbox" {
            inboxFrames.send(InboxFrameEvent(sessionId: frame.sessionId ?? "", payload: frame.payload))
            return
        }
        // Degraded mode (§17): only *new* interpretation stops. Nothing already
        // delivered is cleared or re-derived; the composer stays usable and the
        // transcript + scroll are untouched because we simply don't mutate the
        // already-published state while unreachable.
        guard !degraded else { return }
        let sid = frame.sessionId ?? ""
        let sub = frame.sub
        let heavy = sub == "flush" || sub == "toolOutput"
        // Take the state OUT of the dictionary so the frame is applied to a uniquely-owned value: appending to
        // the streamed text is then an in-place append, not a copy of everything streamed so far.
        var next = sessionStates.removeValue(forKey: sid) ?? MantaSessionStreamState(sessionId: sid)
        let before: MantaSessionStreamState? = heavy ? nil : next
        MantaStreamRouter.apply(frame, to: &next, epoch: connectionEpoch, connGen: connGen)
        // A turn that COMPLETED with no observer attached has no one who will
        // retire its accumulated chunks (retirement lives in the observing
        // ChatSessionStore's refetch path). Clear them here so an unopened
        // session's stream text can't accumulate forever (BET-672). An OBSERVED
        // session is never cleared — its live text is load-bearing for the open
        // transcript.
        if next.turnComplete == true, !registeredSessionIDs.contains(sid) {
            next.chunks.removeAll()
        }
        // A text or tool-output chunk always changes the state; anything else is compared.
        let changed = heavy || before != next
        sessionStates[sid] = next
        lastStreamFrame = StreamFrameStamp(sessionId: sid, sub: sub)
        if changed { announce(sid, sub: sub, state: next) }
    }

    /// Fold the run views a canonical transcript answer carries into the session's run values, under the connection
    /// generation the request was ISSUED under (an answer from an older connection is discarded for the run map), then
    /// forget the runs nothing references any more: the answer is the whole loaded window, so a run no loaded message names
    /// and the live turn does not hold is dropped. Returns true when the answer carries a RETIRED run's old membership — a
    /// rebuild happened meanwhile, so the caller refetches once.
    @discardableResult
    func ingestRunViews(sessionId: String, messages: [OpencodeMessage], issuedConnGen: Int) -> Bool {
        let entries = TranscriptRunStore.entries(of: messages)
        var state = sessionStates[sessionId] ?? MantaSessionStreamState(sessionId: sessionId)
        var store = state.liveRuns.store
        if !entries.isEmpty {
            let context = TranscriptRunContext(currentEpoch: connectionEpoch, connGen: connGen, issuedConnGen: issuedConnGen)
            store = store.merging(entries, context: context)
        }
        // An answer issued before the latest reconnect says nothing about what is referenced now.
        let current = issuedConnGen >= connGen
        if current, !messages.isEmpty {
            store = store.pruning(keeping: TranscriptRunStore.referencedRunIDs(in: messages).union(state.liveRuns.heldRunIDs))
        }
        if store != state.liveRuns.store {
            state.liveRuns.store = store
            sessionStates[sessionId] = state
            lastStreamFrame = nil
            announce(sessionId, sub: nil, state: state)
        }
        return current && TranscriptRunStore.hasStaleMembership(messages, minGen: store.minGen, retired: store.retired)
    }

    /// The live turn is over and the canonical transcript covers its blocks: forget the ledger's layout and calls (the run
    /// VALUES stay, so a later canonical answer can never regress them).
    func clearLiveRunLayout(sessionId: String) {
        guard var state = sessionStates[sessionId], !state.liveRuns.isEmpty else { return }
        state.liveRuns = state.liveRuns.clearingLayout()
        sessionStates[sessionId] = state
        lastStreamFrame = nil
        announce(sessionId, sub: nil, state: state)
    }

    /// Mark a session as having a live observer. Only an observed session keeps
    /// its accumulated chunks past a completed turn (BET-672).
    func registerSession(_ sessionId: String) {
        registeredSessionIDs.insert(sessionId)
    }

    /// Mark a session as no longer observed. Its turn-complete chunks become
    /// eligible for eviction on the next routing pass.
    func unregisterSession(_ sessionId: String) {
        registeredSessionIDs.remove(sessionId)
    }

    /// Retire live stream text the canonical transcript now carries. A session
    /// store calls this straight after a successful refetch — the one moment
    /// the live copy turns from "the only copy" into a duplicate.
    ///
    /// Publishes only on a real change, so an already-clean state does not wake
    /// every subscriber (and cannot loop: retirement is idempotent).
    func retireCoveredStreamText(sessionId: String, covered: Set<String>) {
        guard let state = sessionStates[sessionId] else { return }
        let next = MantaStreamRouter.retiring(state, covered: covered)
        if next != state {
            sessionStates[sessionId] = next
            // This is a local republish, not a new stream frame — clear the
            // frame stamp so a consumer doesn't replay the PREVIOUS frame's
            // fields over a newer optimistic value (BET-668 review cycle 2).
            lastStreamFrame = nil
            announce(sessionId, sub: nil, state: next)
        }
    }

    private func handleReconnect() {
        // On reconnect, re-fetch rather than assuming the stream resumed.
        resyncHandler?()
    }

    // MARK: - Liveness watchdog

    private func startWatchdog() {
        watchdog?.invalidate()
        let timer = Timer(timeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.watchdogTick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        watchdog = timer
    }

    /// Runs while connected (a silent socket) AND while not (a stream stuck connecting, or closed for a reason the
    /// app did not choose): nothing may stay silently dead while the app is in front.
    private func watchdogTick() {
        guard backgroundedAt == nil else { return }
        let now = Date()
        if MantaLivenessPolicy.shouldForceReconnect(
            state: connectionState,
            lastFrameAt: lastFrameAt,
            now: now,
            staleMs: staleFrameMs
        ) || MantaLivenessPolicy.shouldRecoverFromDeadState(
            state: connectionState,
            since: lastStateChangeAt,
            now: now,
            staleMs: staleFrameMs
        ) {
            controller.forceReconnect()
        }
    }

    // MARK: - URL + auth helpers

    static func eventsWebSocketURL(from server: URL?, kinds: Set<String>? = nil) -> URL? {
        guard let server else { return nil }
        var comps = URLComponents(url: server, resolvingAgainstBaseURL: false)
        comps?.scheme = server.scheme == "https" ? "wss" : "ws"
        comps?.path = "/events"
        comps?.query = nil
        // The box ignores a longer list (and then sends everything): omit it rather than send one it would drop.
        if let kinds, !kinds.isEmpty, kinds.count <= MantaEventKinds.maxEntries {
            comps?.queryItems = [URLQueryItem(name: "kinds", value: MantaEventKinds.queryValue(kinds))]
        }
        return comps?.url
    }

    static func bearer(token: String?) -> String? {
        guard let token, !token.isEmpty else { return nil }
        return "Bearer \(token)"
    }
}
