import Foundation
import Combine

// ===========================================================================
// S4 — chat session store (BET-596).
//
// The live, observable session store the chat screen binds to, replacing the
// hardcoded `parentBlocks` fixture. It is fed from two sources:
//
//   1. The canonical `opencode:messages` transcript — the persisted source of
//      `.user` / completed `.prose` / `.steps` / subagent rows. Refetched at
//      each turn boundary so a finished turn's blocks land as real content.
//   2. The S1b `/events` stream state (MantaEventStore.sessionStates[sessionId])
//      — already interpreted by the box (§17): the running assistant text
//      (`stream:flush`), running/turnComplete, context/tokens, todos,
//      truncation, questions, and live subagent status.
//
// Permissions and questions both arrive on the interpreted stream (`sub:
// "permissions"` / `sub: "questions"`); `opencode:permissions` is only the
// seed/resync path (the 2.5s poll is gone). Both are answerable from the phone
// (S1a reply/reject RPCs). Parent and children are each their own store; a
// child store is read-only (§8a v1).
//
// Deliberately does NOT touch the event store's single-owner `rawFrameHandler`
// or `resyncHandler`; resync + attention are derived from the @Published stream
// state and a connectionState transition instead, so the session list's
// handlers (owned by SessionListStore) are never clobbered.
// ===========================================================================

// ===========================================================================
// Single-writer stream merge (BET-668).
//
// The chat screen has TWO writers for the same turn state — the optimistic
// LOCAL updates (`send()`, `replyQuestion`/`rejectQuestion`) and the incoming
// interpreted-stream frames — and the stream frame used to unconditionally
// clobber the optimistic value. All the merge decisions below are PURE so
// they are unit-testable; the store applies the returned state.
// ===========================================================================

/// The subset of turn state the stream-merge decisions own.
struct ChatStreamTurnState: Equatable {
    var running: Bool
    var turnComplete: Bool
    var streamingTailID: String
    var locallyAnsweredQuestionIDs: Set<String>
    var questions: [QuestionRequest]

    init(
        running: Bool = false,
        turnComplete: Bool = false,
        streamingTailID: String = "",
        locallyAnsweredQuestionIDs: Set<String> = [],
        questions: [QuestionRequest] = []
    ) {
        self.running = running
        self.turnComplete = turnComplete
        self.streamingTailID = streamingTailID
        self.locallyAnsweredQuestionIDs = locallyAnsweredQuestionIDs
        self.questions = questions
    }
}

enum ChatStreamMerge {
    /// Apply the per-frame lifecycle facts of one interpreted-stream frame to
    /// the turn state.
    ///
    /// - `frameTurnComplete`: non-nil ONLY when THIS frame carried a completion
    ///   flag (a genuine `turnComplete` frame). This is the only thing that
    ///   resets the streaming tail — never a bare `running == false` write and
    ///   never a STALE accumulated completion left over from a previous turn.
    /// - `frameStartedRunning`: true when THIS frame began a turn (a carrying
    ///   `running` frame whose value was true) — clears any stale completion
    ///   flag from a previous turn.
    ///
    /// `running`, `questions` and the streaming-tail MINT are NOT handled here:
    /// they are read straight from the accumulated snapshot / seeded in the
    /// store. The store mints a tail id whenever a running turn has none, which
    /// subsumes the old per-frame mint edge (BET-668 review cycle 3).
    static func applying(
        frameTurnComplete: Bool?,
        frameStartedRunning: Bool,
        to state: ChatStreamTurnState
    ) -> ChatStreamTurnState {
        var s = state
        if let t = frameTurnComplete { s.turnComplete = t }
        if frameStartedRunning { s.turnComplete = false }
        // Reset the tail identity only on a genuine completion edge.
        if frameTurnComplete == true {
            s.streamingTailID = ""
        }
        return s
    }

    /// State after a FAILED `send()`: the optimistic running/tail is rolled
    /// back so the UI doesn't sit on a forever-spinner. The user's prompt is
    /// NOT lost — the caller restores the input text — so this only clears the
    /// fake "in progress" flags, leaving the question tombstones untouched.
    static func afterSendFailure(to state: ChatStreamTurnState) -> ChatStreamTurnState {
        var s = state
        s.running = false
        s.turnComplete = false
        s.streamingTailID = ""
        return s
    }
}

/// Which per-frame lifecycle facts the most recently applied stream frame
/// carried, derived from the routing `sub` and whether it targeted this
/// session. Used to separate the frame's DELTA from the accumulated snapshot
/// (which is sticky across turns).
struct ChatStreamFrameCarried: Equatable {
    /// True when this frame carried a running value (the `running` or
    /// `turnComplete` sub).
    var running: Bool
    /// True when this frame carried a completion flag (the `turnComplete` sub).
    var turnComplete: Bool
}

enum ChatStreamDelta {
    /// The carried facts of the most recently applied frame. A non-carrying
    /// sub, or a frame aimed at a different session, yields neither flag —
    /// so a republish that isn't a genuine turn-state frame (e.g. a retire or
    /// a foreign-session frame) can't apply a stale value.
    static func carried(sessionIsTarget: Bool, sub: String?) -> ChatStreamFrameCarried {
        guard sessionIsTarget else {
            return ChatStreamFrameCarried(running: false, turnComplete: false)
        }
        switch sub {
        case "running", "turnComplete":
            return ChatStreamFrameCarried(running: true, turnComplete: sub == "turnComplete")
        default:
            return ChatStreamFrameCarried(running: false, turnComplete: false)
        }
    }
}

@MainActor
final class ChatSessionStore: ObservableObject {

    @Published private(set) var transcript: [TranscriptBlock] = []
    /// The voice notes recorded in this session (fetched on load + refreshed
    /// after a send). Their transcripts claim user messages via
    /// `buildVoiceNoteMap`, so a dictated note renders its player bubble in the
    /// transcript under the message it became (BET-1029).
    @Published private(set) var voiceNotes: [VoiceNote] = []
    /// The LAST fetched raw transcript (`opencode:messages`), kept alongside the
    /// rendered `transcript` blocks so the plan card can run its exact
    /// derivation (`isPlanExitQuestion` / `extractPlanData` need the raw tool
    /// parts — callID, state.input, patch files — which the blocks discard).
    /// Replaced wholesale on each fetch (loadEarlier refetches a larger tail,
    /// so `messages` is always a superset of prior values, never a stale mix).
    @Published private(set) var messages: [OpencodeMessage] = []
    @Published private(set) var inProgressText = ""
    @Published private(set) var blocks: [TranscriptBlock] = []
    /// The same transcript as `blocks`, but wrapped in `TranscriptRow` with a
    /// STABLE id (see `TranscriptRow`). This is the actual input the transcript
    /// surfaces (parent chat and subagent drill-in) feed to `TiledView`.
    /// It is intentionally NOT a `ListDataSource`: the data source is owned by
    /// each `TiledView` so its change log and the view's replay cursor share a
    /// lifetime. A store-owned one gets replayed from the beginning against a
    /// final snapshot every time a new view is created, which is the
    /// invalid-batch-updates / deque-out-of-bounds crash pair.
    @Published private(set) var rows: [TranscriptRow] = []
    @Published private(set) var running = false
    @Published private(set) var turnComplete = false
    @Published private(set) var context: StreamContextPayload?
    @Published private(set) var cache: StreamCachePayload?
    @Published private(set) var truncation: StreamTruncationPayload?
    @Published private(set) var sessionError: StreamSessionErrorPayload?
    @Published private(set) var todos: StreamTodosPayload?
    @Published private(set) var questions: [QuestionRequest] = []
    @Published private(set) var permissions: [PermissionRequest] = []
    @Published private(set) var planOn: Bool?
    @Published private(set) var subagents: [StreamSubagentPayload] = []
    /// The session's durable outbox rows, FIFO in submit order. A prompt a
    /// user committed but the box has not acknowledged — `waiting` while a turn
    /// runs (or after a relaunch), `sending` while its POST is in flight, and
    /// `failed` (tap-to-retry) when the POST did not land. Persisted through
    /// `PendingPromptStore`; drained one per idle edge — never POSTed while
    /// `running`, which is what used to implicitly abort the in-flight turn.
    @Published private(set) var pendingPrompts: [PendingPrompt] = []
    @Published private(set) var loading = false
    @Published private(set) var loadFailed = false
    /// True while the box was connected and the stream dropped (mirrors
    /// MantaEventStore.degraded). Drives the chat screen's "Connection lost —
    /// reconnecting…" banner so an offline hit does not read as "the model is
    /// quiet". Consumed only; reconnect machinery is owned by the event store.
    @Published private(set) var degraded = false
    /// A one-shot user-facing message bus for failed chat actions: views set it,
    /// the composer surfaces it through its existing hint capsule and clears it.
    /// It is deliberately settable from views because it is a bus, not store
    /// state — a failed abort/compact/clear/fork/delete must not fail silently.
    @Published var actionHint: String?
    /// True while a canonical transcript refetch (or the initial load) is in
    /// flight. Drives the ambient hairline sweep on the composer's top divider
    /// (BET-630, D1) — distinct from `running`, which drives the working row.
    @Published private(set) var refreshing = false
    /// True when the transcript on screen is a WINDOW onto a longer history —
    /// i.e. the box returned a full page, so older messages exist. Drives the
    /// "Load earlier messages" affordance at the top of the transcript.
    @Published private(set) var hasEarlier = false
    /// True while a `loadEarlier()` widening fetch is in flight.
    @Published private(set) var loadingEarlier = false

    /// How many of the most recent messages the first fetch asks for. A session
    /// open used to pull the ENTIRE history — hundreds of KB on a long session,
    /// almost all of it scrolled far out of view. One screenful is ~3-6 blocks,
    /// so 30 messages is several screens of headroom.
    static let initialMessageLimit = 30
    /// Each "load earlier" tap widens the window by this much. opencode has no
    /// working cursor on this endpoint (`before` is declared but 400s), so
    /// paging = re-asking for a bigger tail. Wasteful in principle, bounded and
    /// simple in practice — and it only happens when the user asks for it.
    static let earlierMessageStep = 50

    let sessionId: String
    let isReadOnly: Bool

    private let api: MantaAPIClient
    private let eventStore: MantaEventStore
    private var cancellables: Set<AnyCancellable> = []
    private var runningSince: Date?
    /// Stable id for the streaming `.prose` tail, fixed for the life of one
    /// turn. The tail's TEXT grows every delta, so a content-derived id would
    /// change each time and thrash TiledView; this id doesn't. Reset when the
    /// turn ends and the tail is absorbed into the canonical transcript.
    private(set) var streamingTailID: String = ""
    /// The row id the streaming tail actually ships in. Unlike `streamingTailID`
    /// (which the stream merge resets the moment a `turnComplete` frame lands),
    /// this id SURVIVES the settle until the canonical refetch absorbs the tail
    /// — so TiledView sees the tail row turn into the canonical prose block as
    /// an in-place UPDATE instead of a remove+insert blink at the turn boundary
    /// (BET-752 task 2, giving prose the stable-identity treatment BET-666 gave
    /// step rows — BET-666, `TranscriptComponents.swift`).
    private var liveTailRowID = ""
    /// True while the previous rebuild shipped a live tail, so the empty branch
    /// of `rebuildBlocks` knows a settle/absorption just replaced it (and can
    /// carry the tail id onto the new canonical row) rather than mistaking a
    /// fresh `send()`'s pre-stream emptiness for an absorption.
    private var wasRenderingTail = false
    /// Question ids the user answered/rejected on-device. The incoming stream
    /// keeps publishing an answered question until the box catches up, so this
    /// tombstone set filters it out locally in the meantime (BET-668); an id
    /// leaves the set once the box stops publishing it.
    private var locallyAnsweredQuestionIDs: Set<String> = []
    /// True between `send()` and the box's first running acknowledgment. While
    /// set, the snapshot's accumulated `running` (still the previous turn's
    /// `false`) must not clobber the optimistic `true` — but once the box
    /// reports running at all, the snapshot is authoritative.
    private var optimisticRunning = false
    /// The transcript-derived context breakdown (`opencode:context`), fetched
    /// on session open so an idle conversation shows its meter immediately.
    /// The live `stream/context` frame is the single preferred source; this is
    /// only the fallback that fills the gap while (or in place of) such a
    /// frame (BET-1030). nil when a brand-new/never-billed session returns
    /// null, or the RPC failed — the meter then stays blank, as before.
    private var transcriptContext: StreamContextPayload?
    /// The last `runningSetSeq` this store has folded into its running state. A
    /// change in it means the box has (re)stated the authoritative running set
    /// since `send()` stamped `optimisticRunning`, so the optimistic flag must
    /// yield (BET-922).
    private var lastRunningSetSeq = 0
    private var didRunOnce = false
    /// Test seams (internal, readable via `@testable`): count one-time vs
    /// resumable work so tests can assert the split without touching live
    /// timers or the network.
    private(set) var transcriptFetchCount = 0
    private var lastRunning: Bool?
    private var lastComplete: Bool?
    /// Monotonic count of FULL turned completions (BET-752 task 5). Increments
    /// at most once per turn: a multi-message turn emits a `turnComplete`
    /// frame per `message.updated`, so the raw `turnComplete` value flaps
    /// true repeatedly; the view used to fire a success haptic on every
    /// false→true edge. The store now coalesces those into ONE completion per
    /// turn, re-armed only when a genuinely new turn begins (a running start,
    /// or a `send()`). The view fires the haptic off this counter instead.
    @Published private(set) var turnCompletionCount = 0
    /// True until the current turn's completion has been counted once; re-armed
    /// when a new turn begins. Until a new turn, further `turnComplete` edges
    /// of the same turn are ignored (deduped per turn).
    private var completionArmed = true
    /// The permissions payload most recently folded into `permissions`. The
    /// accumulated snapshot is sticky and this sink fires on every stream change,
    /// so applying it unconditionally would clobber whatever `refreshPermissions()`
    /// (seed/resync) just wrote. Edge-triggering on the VALUE — rather than on the
    /// frame stamp, a single slot that a later frame or a transcript retirement can
    /// overwrite before this deferred sink reads it — applies every genuine
    /// permissions frame exactly once and nothing else.
    private var lastAppliedPermissions: StreamPermissionsPayload?
    /// How many recent messages the CURRENT window covers. Every refetch reuses
    /// it, so a turn-boundary refresh never silently collapses a window the
    /// user widened.
    private var messageLimit = ChatSessionStore.initialMessageLimit
    /// One transcript fetch at a time. Three independent triggers (first load,
    /// connection, turn boundary) used to fire concurrently on open and pull the
    /// same transcript three times over. `fetchPending` remembers that a trigger
    /// arrived mid-flight so the refresh still happens — exactly once — after.
    private var fetchInFlight = false
    private var fetchPending = false
    /// The message-id → voice-note association, recomputed whenever the message
    /// window or the notes change. Baked into `transcript` at mapping time
    /// (BET-1029).
    private var voiceNoteMap: [String: VoiceNote] = [:]
    /// The connection sink replays its CURRENT value on subscribe, so without
    /// this the store fired a "reconnect" refetch before `start()` had even run.
    /// Only a genuine drop→connect transition is a resync.
    private var wasConnected: Bool?

    init(
        sessionId: String,
        eventStore: MantaEventStore,
        api: MantaAPIClient,
        isReadOnly: Bool = false
    ) {
        self.sessionId = sessionId
        self.eventStore = eventStore
        self.api = api
        self.isReadOnly = isReadOnly

        // Per-session subscription (BET-672): sink on THIS session's state
        // alone, filtered to distinct values. The whole-dictionary sink used to
        // fire on every stream frame of ANY session — including backgrounded
        // ones — so every flush elsewhere in the box forced a full
        // `applyStreamState` → `rebuildBlocks` transcript re-map in the open
        // chat. `MantaSessionStreamState` is value-typed and derives
        // `Equatable`, so `removeDuplicates()` on the mapped per-session value
        // emits only when THIS session's state actually changes.
        eventStore.$sessionStates
            .receive(on: DispatchQueue.main)
            .compactMap { $0[sessionId] }
            .removeDuplicates()
            .sink { [weak self] _ in self?.applyStreamState() }
            .store(in: &cancellables)

        eventStore.$connectionState
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in self?.handleConnection(state) }
            .store(in: &cancellables)

        // Degraded state feeds the chat banner; distinct values only, so a
        // republished identical value does not re-render the banner.
        eventStore.$degraded
            .removeDuplicates()
            .sink { [weak self] d in self?.degraded = d }
            .store(in: &cancellables)
    }

    // MARK: - Lifecycle

    /// Begin loading the session. One-time setup is split from resumable work:
    /// the initial transcript fetch runs once under the `didRunOnce` guard, so
    /// a subagent push (`stop`) then pop (`start`) does not re-fetch.
    func start() {
        if !didRunOnce {
            didRunOnce = true
            load()
            refreshContextFromTranscript()
        }
        // Register as an observer so the event store knows a consumer is
        // attached (BET-672): a session it completes with NO observer has its
        // accumulated stream chunks evicted to bound memory.
        eventStore.registerSession(sessionId)
    }

    func stop() {
        // The session is leaving the screen: it is no longer a consumer of
        // this session's stream chunks. A push is not a dismissal — the child
        // subagent screen owns ITS OWN store (BET-1024), so nothing here
        // touches any child; this releases the parent's own resources only.
        eventStore.unregisterSession(sessionId)
    }

    func load() {
        guard !loading else { return }
        loading = true
        refreshing = true
        // Surface any prompts this session still has outstanding (a failed or
        // waiting send from a previous visit). The rows render from the outbox;
        // a relaunch has already migrated stale `waiting`/`sending` rows to
        // `.failed` via `PendingPromptStore.failStaleOnLaunch`.
        pendingPrompts = PendingPromptStore.prompts(for: sessionId, in: PendingPromptStore.load())
        Task {
            await fetchTranscript(isFirstLoad: true)
            // Cleared HERE, not inside the fetch: the fetch can return early
            // (a refetch already in flight serves this load), and every one of
            // those paths must still take the screen off its skeleton.
            await MainActor.run { loading = false }
            if !isReadOnly {
                await refreshPermissions()
                await refreshVoiceNotes()
            }
        }
    }

    /// Fetch the transcript-derived context breakdown (`opencode:context`) on
    /// session open so an idle conversation shows its context meter immediately
    /// (BET-1030). The box derives it from the persisted transcript and returns
    /// null when there is no billed assistant turn yet (or the RPC fails — a
    /// non-fatal no-op). Reconciliation lives in `applyStreamState` + here: the
    /// live `stream/context` frame wins when present; the RPC value is the
    /// idle/open fallback.
    private func refreshContextFromTranscript() {
        Task {
            let payload = try? await api.context(sessionId: sessionId)
            await MainActor.run {
                transcriptContext = payload
                // Only publish when the live frame has not already filled the
                // meter — the stream/context frame is the preferred source.
                if eventStore.sessionStates[sessionId]?.context == nil {
                    context = payload
                }
            }
        }
    }

    /// Widen the window by `earlierMessageStep` and re-render. No-op while a
    /// widening is already running or when the whole history is already shown.
    func loadEarlier() {
        guard hasEarlier, !loadingEarlier else { return }
        loadingEarlier = true
        messageLimit += ChatSessionStore.earlierMessageStep
        Task {
            await fetchTranscript(isFirstLoad: false)
            await MainActor.run { loadingEarlier = false }
        }
    }

    /// Run `work`, failing if it has not finished within `seconds`.
    private static func withTimeout<T: Sendable>(
        seconds: Double,
        _ work: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await work() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                throw MantaError.transport("timed out")
            }
            guard let first = try await group.next() else {
                throw MantaError.transport("no result")
            }
            group.cancelAll()
            return first
        }
    }

    // MARK: - Stream state application

    private func applyStreamState() {
        guard let s = eventStore.sessionStates[sessionId] else { return }

        inProgressText = s.liveText

        // Fields that are copied straight through from the latest frame (the
        // stream is the single writer for these — no optimistic value to
        // protect).
        // The live `stream/context` frame is the preferred source; the
        // transcript-derived `opencode:context` fallback (BET-1030) fills the
        // meter for an idle conversation on open, when no such frame has
        // arrived yet.
        context = s.context ?? transcriptContext
        if let c = s.cache { cache = c }
        truncation = s.truncation
        sessionError = s.sessionError
        todos = s.todos
        subagents = s.subagents
        planOn = s.planOn

        // Which frame (if any) just changed this session's stream state. The
        // `$sessionStates` sink fires on every republish, so the stamp only
        // counts when it names THIS session; retirement nulls it so a stale
        // frame never replays over optimistic state.
        let stamp = eventStore.lastStreamFrame
        let carried = ChatStreamDelta.carried(sessionIsTarget: stamp?.sessionId == sessionId, sub: stamp?.sub)

        // --- running: the accumulated snapshot is authoritative, seeded when
        // a session is opened (a mid-turn session shows its working indicator),
        // EXCEPT the optimistic `true` `send()` just set — which the snapshot's
        // stale previous-turn `false` must not clobber while the box hasn't yet
        // confirmed. Reading the snapshot (not a per-frame stamp) also makes
        // this robust to frames that coalesce between publishes.
        // The box's authoritative running set supersedes the optimistic stamp
        // `send()` set — without this, a send whose acknowledging frame was
        // missed leaves the working row lit forever (BET-922).
        let seq = eventStore.runningSetSeq
        if seq != lastRunningSetSeq {
            lastRunningSetSeq = seq
            optimisticRunning = false
        }
        if optimisticRunning, (carried.running || s.running == true) {
            optimisticRunning = false
        }
        running = optimisticRunning ? true : (s.running == true)

        // --- questions: the accumulated snapshot's pending questions, filtered
        // against the tombstone set (so an answered/rejected card is held until
        // the box catches up) and aged only when an actual payload exists.
        // Seeded on open — a session with a question already waiting shows its
        // card immediately.
        if let questionPayload = s.questions {
            let incoming = questionPayload.questions
            locallyAnsweredQuestionIDs.formIntersection(Set(incoming.map(\.id)))
            questions = incoming.filter { !locallyAnsweredQuestionIDs.contains($0.id) }
        }

        // --- permissions: live updates ride the interpreted stream. Unlike
        // questions there is no locally-answered tombstone filter — instead
        // the payload is edge-triggered against `lastAppliedPermissions`
        // (see its doc comment for why the frame stamp alone is not a safe
        // trigger). Applying it unconditionally would clobber whatever
        // `refreshPermissions()` just repaired on reconnect and briefly
        // resurrect an answered permission before its `permission.replied`
        // frame lands; gating on the stamp instead can silently DROP a
        // genuine permissions frame if a later frame or a transcript
        // retirement overwrites the stamp before this deferred sink reads
        // it. Edge-triggering on the value has neither failure mode.
        if let p = s.permissions, p != lastAppliedPermissions {
            lastAppliedPermissions = p
            permissions = p.permissions
        }

        // --- the turn lifecycle (`turnComplete` flag + streaming-tail RESET)
        // is per-frame: only a genuine `turnComplete` frame clears the tail.
        // `running` and `questions` are NOT touched by this merge (handled
        // above), and neither is the tail MINT (handled below).
        let frameStartedRunning = carried.running && (s.running == true)
        let merged = ChatStreamMerge.applying(
            frameTurnComplete: carried.turnComplete ? s.turnComplete : nil,
            frameStartedRunning: frameStartedRunning,
            to: ChatStreamTurnState(
                running: running,
                turnComplete: turnComplete,
                streamingTailID: streamingTailID,
                locallyAnsweredQuestionIDs: locallyAnsweredQuestionIDs,
                questions: questions
            )
        )
        turnComplete = merged.turnComplete
        streamingTailID = merged.streamingTailID
        // Seed a stable tail id whenever a running turn has none — however we
        // learned it is running: a fresh turn edge, a mid-turn session open
        // (seeded from the snapshot), or a stamp nulled between a running frame
        // and its deferred sink. A non-empty id is kept, so the streaming row
        // is never replaced mid-turn.
        if running, streamingTailID.isEmpty {
            streamingTailID = "live-\(sessionId)-\(UUID().uuidString)"
            liveTailRowID = streamingTailID
        }
        // Prefer the box's turn start; keep the optimistic stamp `send()` set
        // until the first frame confirms it, but never invent one. The box only
        // ever announces a running session together with the instant that turn
        // started, so an absent start means we genuinely do not know one — and
        // falling back to "now" is what made a force-quit relaunch restart the
        // timer from zero. An unknown start renders no timer, which is honest.
        runningSince = running ? (s.runningSince ?? runningSince) : nil

        // The session just went idle (stream fold set `running = false`): any
        // pending prompt may now be sent. Guard-based, so firing on whichever
        // path folded running down is harmless — a second call is a no-op while
        // running (the drain's deliver sets it optimistically) or an empty box.
        drainPendingPromptIfIdle()

        // Refetch the canonical transcript at turn boundaries so a finished
        // turn's blocks (steps/prose/subagents) land as real content. The fetch
        // itself retires the live text it now covers (see `fetchTranscript`) —
        // absorption is an explicit step, not something the refetch does for
        // free. Assuming it was free is what rendered every finished answer
        // twice (BET-655).
        //
        // The FIRST call here is not a transition, it is the initial snapshot:
        // `@Published` replays its current value the moment we subscribe, which
        // is before `start()` runs. Seeding without fetching is what stops a
        // session open from pulling the same transcript two extra times.
        let firstSnapshot = lastRunning == nil && lastComplete == nil
        let runningChanged = running != lastRunning
        let completeChanged = turnComplete != lastComplete
        lastRunning = running
        lastComplete = turnComplete
        if !firstSnapshot {
            if runningChanged && running { scheduleRefetch() }
            if completeChanged && turnComplete { scheduleRefetch() }
        }

        // --- once-per-turn completion signal (BET-752 task 5). A multi-message
        // turn emits a `turnComplete` frame per `message.updated`, so the raw
        // false→true edge flaps several times in one turn — and the chat screen
        // used to fire a success haptic on EVERY edge. Coalesce to ONE
        // completion per TURN: count a fresh completion edge only while the
        // latch is armed, then disarm. `send()` re-arms it (a user submit IS a
        // new turn); the latch also starts armed, so a session opened mid-turn
        // still counts its first completion. The view fires the haptic off
        // `turnCompletionCount` instead of the raw `turnComplete` value.
        if completeChanged && turnComplete && completionArmed {
            turnCompletionCount += 1
            completionArmed = false
        }

        rebuildBlocks()
    }

    private func handleConnection(_ state: MantaConnectionState) {
        // A healthy RECONNECT means missed state should be re-fetched, exactly
        // what resyncHandler would do — but derived here so we never steal the
        // event store's single-owner resync slot from the session list.
        //
        // Only a drop→connect transition counts. The sink replays the current
        // value on subscribe, so treating every `.connected` as a resync fired
        // a full transcript fetch at construction, racing the one `start()` was
        // about to make.
        let connected = state == .connected
        let wasDisconnected = wasConnected == false
        wasConnected = connected
        if connected && wasDisconnected { scheduleRefetch() }
    }

    // MARK: - Block assembly

    /// The rendered transcript = canonical blocks + the live in-progress prose
    /// tail (the streaming assistant text, §8). Keeping them separate makes the
    /// scroll `defaultScrollAnchor(.bottom)` cheap: only the tail mutates
    /// between turn boundaries.
    ///
    /// The two sources must never hold the same prose at once — that is a
    /// visible duplicate, not a harmless overlap. The tail is emptied by the
    /// retirement step in `fetchTranscript`; nothing else may append to it.
    private func rebuildBlocks() {
        // LIVE running tools, appended into THIS turn's step rail. They are not
        // canonical content, so they merge here (on every stream frame) rather
        // than in the mapper that feeds `transcript` — that keeps `transcript`
        // pristine while the live rows tail their output and vanish on
        // turnComplete (when the canonical refetch takes them over as steps).
        let liveTools = eventStore.sessionStates[sessionId]?.runningTools ?? []
        let liveTranscript = ChatTranscriptMapper.appendingLive(tools: liveTools, subagents: subagents, to: transcript)

        // Terminal state of the current turn, MOVED out of the pinned area into
        // the transcript, at the end of the turn it belongs to: session errors
        // and truncations scroll WITH their turn rather than hovering over the
        // composer. The blocking cards (permission / plan / question) join the
        // tail here too, in the agreed fixed order — notices first, then
        // permission, plan-exit, generic question, and the queued prompts LAST
        // (they represent what happens next). See `trailingBlocks` for the
        // pinned order.
        let trailing = Self.trailingBlocks(
            sessionError: sessionError,
            truncation: truncation,
            running: running,
            permission: newestPermission,
            planExitQuestion: newestPlanQuestion,
            question: newestQuestion,
            pendingPrompts: pendingPrompts
        )

        let newRows: [TranscriptRow]
        if inProgressText.isEmpty {
            // No live tail: the whole transcript is canonical. If the turn
            // that was streaming just settled and its refetch absorbed the
            // tail, carry the tail's STABLE id onto the canonical prose block
            // that replaced it — same-identity swap, so TiledView updates that
            // row in place instead of remove+insert-blinking at the boundary
            // (BET-752 task 2 — the prose analogue of BET-666's step rows).
            // Guarded on `wasRenderingTail`: `send()` mints `liveTailRowID`
            // before any text exists, and that optimistic no-tail state must
            // not rebadge the previous turn's last prose.
            var rows = uniqueTranscriptRows(liveTranscript)
            if wasRenderingTail,
               !liveTailRowID.isEmpty,
               let lastProse = rows.lastIndex(where: {
                   if case .prose = $0.block { return true } else { return false }
               }) {
                rows[lastProse] = TranscriptRow(id: liveTailRowID, block: rows[lastProse].block)
                liveTailRowID = ""
            }
            wasRenderingTail = false
            blocks = liveTranscript + trailing
            newRows = rows + uniqueTranscriptRows(trailing)
        } else {
            // The live tail has no completion time yet — it gets one when the
            // turn ends and the canonical refetch replaces this block. The row
            // keeps `liveTailRowID` across the settle so it never blinks.
            wasRenderingTail = true
            blocks = liveTranscript + [.prose(inProgressText, at: nil)] + trailing
            newRows = uniqueTranscriptRows(liveTranscript)
                + [TranscriptRow(id: liveTailRowID, block: .prose(inProgressText, at: nil))]
                + uniqueTranscriptRows(trailing)
        }
        rows = newRows
    }

    /// Build the transcript-TAIL block array in the ONE fixed order: system
    /// notices (session error, then truncation), the blocking cards (permission
    /// → plan-exit → generic question), then the queued prompts LAST — they
    /// represent what happens next and must stay at the very end. Pure and
    /// unit-tested so the ordering cannot drift between the two rebuild
    /// branches (BET-1214).
    /// `nonisolated`: pure (value-in, value-out, no main-actor state), so it is
    /// directly unit-testable from a nonisolated XCTest body.
    nonisolated static func trailingBlocks(
        sessionError: StreamSessionErrorPayload?,
        truncation: StreamTruncationPayload?,
        running: Bool,
        permission: PermissionRequest?,
        planExitQuestion: QuestionRequest?,
        question: QuestionRequest?,
        pendingPrompts: [PendingPrompt]
    ) -> [TranscriptBlock] {
        var trailing: [TranscriptBlock] = []
        if let err = sessionError {
            trailing.append(.notice(err.message, .error))
        }
        if let trunc = truncation, !running {
            trailing.append(.notice(trunc.label ?? "Response truncated", .warn))
        }
        if let permission {
            trailing.append(.permission(permission))
        }
        if let planQ = planExitQuestion {
            trailing.append(.planExit(planQ))
        }
        if let question {
            trailing.append(.question(question))
        }
        // Prompts accepted mid-turn render as dim ghost bubbles at the very
        // tail — where they will actually land once the current turn finishes.
        trailing.append(contentsOf: pendingPrompts.map { .queuedPrompt($0) })
        return trailing
    }

    // MARK: - Refetch

    private func scheduleRefetch() {
        Task { await refetch() }
    }

    func refetch() async {
        await fetchTranscript(isFirstLoad: false)
        if !isReadOnly { await refreshPermissions() }
    }

    /// The ONE place a transcript is fetched. Serialised: a trigger that
    /// arrives while a fetch is running sets `fetchPending` instead of starting
    /// a second identical request, and the in-flight one re-runs once when it
    /// finishes so nothing is missed.
    ///
    /// An EMPTY transcript is not a failure — a session you just cleared
    /// legitimately has no messages, and reporting that as "couldn't reach your
    /// box" was wrong. Only a thrown error is. The fetch is also bounded: an
    /// unreachable box can hang a request for the URLSession default (a minute
    /// or more), leaving the screen on its skeleton with no way out.
    private func fetchTranscript(isFirstLoad: Bool) async {
        transcriptFetchCount += 1
        if fetchInFlight {
            fetchPending = true
            return
        }
        fetchInFlight = true
        defer { fetchInFlight = false }

        repeat {
            fetchPending = false
            refreshing = true
            let limit = messageLimit
            var failed = false
            var messages: [OpencodeMessage] = []
            do {
                messages = try await Self.withTimeout(seconds: 12) {
                    try await self.api.messages(sessionId: self.sessionId, limit: limit, slim: true)
                }
            } catch {
                failed = true
            }
            let loaded = messages
            let didFail = failed
            await MainActor.run {
                if isFirstLoad { loadFailed = didFail }
                refreshing = false
                // A full page back means the window is a view onto more
                // history. A short page means we are looking at all of it. A
                // failed fetch says nothing either way — leave it alone.
                if !didFail { hasEarlier = loaded.count >= limit }
                if !didFail || isFirstLoad {
                    // BET-1125 — never let a racing EMPTY refetch clobber a
                    // just-hydrated transcript (the blank-chat-on-open bug). A
                    // pre-existing session's FIRST load hydrates its history
                    // (e.g. 6 rows); a ~1.4s-later refetch — from a connection
                    // sink or stream turn-boundary edge — can transiently return
                    // no tail, and overwriting with `[]` wiped the screen to
                    // blank. A NEWLY CREATED / CLEARED session is always a
                    // fresh store whose FIRST load returns empty, and that empty
                    // IS authoritative (transcript is still empty, or
                    // `isFirstLoad` is true) — so a populated `transcript` only
                    // ever reaches here when real history must be kept. A genuine
                    // clear never rebuilds against old data: it swaps the session
                    // id and rebuilds the store (ChatScreen.clearSession).
                    if loaded.isEmpty, !transcript.isEmpty, !isFirstLoad {
                        return
                    }
                    // Root cause of the blank-chat-on-open clobber (BET-1105 /
                    // BET-1125 follow-up): the local `var messages` in this
                    // function SHADOWED the `@Published messages` property, so
                    // `self.messages` was never populated here. `refreshVoiceNotes`
                    // reads `self.messages` and remaps `transcript` from it, so
                    // with the property empty it mapped 0 blocks and wiped a
                    // just-hydrated transcript to blank. Assign to the PROPERTY
                    // (self.messages), not the shadowed local.
                    self.messages = loaded
                    voiceNoteMap = ChatTranscriptMapper.buildVoiceNoteMap(messages: loaded, notes: voiceNotes)
                    transcript = ChatTranscriptMapper.blocks(from: loaded, voiceNotes: voiceNotes)
                    // The transcript now carries these messages, so any live
                    // copy of them is a duplicate — retire it BEFORE rebuilding
                    // or the finished answer renders twice, once from each
                    // source (BET-655). Read the pruned text back synchronously:
                    // the event-store sink lands on a later run-loop turn, too
                    // late for the rebuild happening right here.
                    //
                    // Cover ONLY completed messages: a chunk may be retired only
                    // once its message is COMPLETE, because ChatTranscriptMapper
                    // skips an assistant message that is still in flight
                    // (`time.completed == nil`). opencode:messages returns the
                    // in-flight message with no `time.completed`, so naming it
                    // here would delete the only copy of the running turn's text
                    // — the transcript refuses to draw it — leaving the screen
                    // silent until the turn finishes.
                    if !didFail {
                        eventStore.retireCoveredStreamText(
                            sessionId: sessionId,
                            covered: Set(loaded.filter { $0.info.time?.completed != nil }.map(\.info.id))
                        )
                        inProgressText = eventStore.sessionStates[sessionId]?.liveText ?? ""
                    }
                    rebuildBlocks()
                }
            }
        } while fetchPending
    }

    // MARK: - Permissions (S1a answerable)

    /// Seed + resync only — live updates arrive on the interpreted stream;
    /// the 2.5s poll is gone.
    func refreshPermissions() async {
        let perms = (try? await api.permissions(sessionId: sessionId)) ?? []
        await MainActor.run { permissions = perms }
    }

    // MARK: - Voice notes (BET-1029)

    /// Fetch this session's voice-note metadata, re-forge the message→note map
    /// and re-render the transcript so the dictation attachments appear. Called
    /// on session load and after a send (a dictated note's player bubble only
    /// exists once its matching user message does).
    func refreshVoiceNotes() async {
        let notes = (try? await api.voiceNotes(sessionId: sessionId)) ?? []
        await MainActor.run {
            let remapped = ChatTranscriptMapper.blocks(from: messages, voiceNotes: notes)
            voiceNotes = notes
            voiceNoteMap = ChatTranscriptMapper.buildVoiceNoteMap(messages: messages, notes: notes)
            // Defensive, mirrors BET-1125's fetch guard: never let a voice-notes
            // refresh replace an already-populated transcript with an empty
            // remap. A session that has voice-note metadata but (transiently)
            // no mapped messages must not blank the chat. The primary fix for
            // the blank-on-open clobber is the `self.messages = loaded` shadow
            // fix in `fetchTranscript`; this guard keeps `refreshVoiceNotes`
            // from ever being a second clobber path.
            if !(remapped.isEmpty && !transcript.isEmpty) {
                transcript = remapped
            }
            rebuildBlocks()
        }
    }

    // MARK: - Answers (wire from the phone, S1a)

    func replyPermission(_ request: PermissionRequest, reply: PermissionReply) {
        Task {
            try? await api.permissionReply(requestId: request.id, reply: reply, sessionId: sessionId)
            await refreshPermissions()
        }
    }

    func replyQuestion(_ request: QuestionRequest, answers: [[String]]) {
        // opencode's /question/{id}/reply|reject accept ONLY the `que_…`
        // requestId — NOT the stable card id (a tool callID). Sending the card
        // id makes the box return HTTP 400 and the question never clears, so
        // the blocked turn stays blocked and the session looks dead to the
        // user. A transcript-recovered question has no requestId and is
        // unanswerable — drop the card locally rather than erroring.
        guard let requestId = request.requestId else {
            questions.removeAll { $0.id == request.id }
            return
        }
        // Drop the card optimistically and tombstone its id so the incoming
        // stream can't flash it back before the box catches up; restore both
        // on failure so a real send error doesn't silently leave the question
        // gone while the box stays blocked on it ("can't send messages").
        questions.removeAll { $0.id == request.id }
        locallyAnsweredQuestionIDs.insert(request.id)
        Task {
            do {
                try await api.questionReply(requestId: requestId, answers: answers, sessionId: sessionId)
            } catch {
                locallyAnsweredQuestionIDs.remove(request.id)
                if !questions.contains(where: { $0.id == request.id }) {
                    questions.append(request)
                }
            }
        }
    }

    func rejectQuestion(_ request: QuestionRequest) {
        guard let requestId = request.requestId else {
            questions.removeAll { $0.id == request.id }
            return
        }
        questions.removeAll { $0.id == request.id }
        locallyAnsweredQuestionIDs.insert(request.id)
        Task {
            do {
                try await api.questionReject(requestId: requestId, sessionId: sessionId)
            } catch {
                locallyAnsweredQuestionIDs.remove(request.id)
                if !questions.contains(where: { $0.id == request.id }) {
                    questions.append(request)
                }
            }
        }
    }

    // MARK: - Plan card (BET-1026)

    /// The plan card's "Build here": answer the plan_exit question "Yes" (so
    /// opencode switches to the build agent), then re-send the plan text
    /// OURSELVES with the BUILD model and no agent.
    ///
    /// The re-send is necessary, not a convenience: opencode's own "yes" would
    /// stamp the injected build turn with the last user message's — i.e. the
    /// PLANNING — model. Re-sending explicitly with `buildModel` (nil = let
    /// opencode pick) is what makes the follow-up turn run on the build model.
    /// Ported from `ChatPanel.tsx` `buildHere` (lines 2505-2529): the caller
    /// has already flipped the local plan state off (through the model store,
    /// which re-reads the build model), so `buildModel` is the session's build
    /// model.
    func buildHere(question: QuestionRequest, planText: String, buildModel: SendPromptInput.Model?) {
        replyQuestion(question, answers: [["Yes"]])
        Task {
            await send(text: planText, attachments: [], model: buildModel, agent: nil)
        }
    }

    /// The plan card's "Keep planning": answer the plan_exit question "No"
    /// (which REJECTS plan_exit, leaving plan mode on by design). If the user
    /// asked for a change, hand that back to the plan agent so it refines the
    /// plan (still in plan mode — no edits). Ported from `ChatPanel.tsx`
    /// `keepPlanning` (lines 2531-2548).
    func keepPlanning(question: QuestionRequest, feedback: String) {
        replyQuestion(question, answers: [["No"]])
        let trimmed = feedback.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            Task {
                await send(text: trimmed, attachments: [], model: nil, agent: "plan")
            }
        }
    }

    // MARK: - Composer (S5 / BET-597)

    /// Send a prompt for this session. `text` needs no trimming here (the
    /// composer trims); attachments + model are optional and flow through the
    /// unchanged `opencode:prompt` surface.
    ///
    /// The prompt first enters the durable outbox as a `.waiting` row, then is
    /// delivered immediately if the session is idle (or picked up by the idle
    /// drain if a turn is running). Failure is surfaced by the pending row in
    /// the transcript with its own tap-to-retry — never retried automatically.
    func send(text: String, attachments: [SendPromptInput.Attachment], model: SendPromptInput.Model?, mentions: [SendPromptInput.Mention]? = nil, agent: String? = nil) async {
        let prompt = PendingPrompt(
            id: UUID().uuidString,
            sessionId: sessionId,
            text: text,
            attachments: attachments,
            model: model,
            mentions: mentions,
            agent: agent,
            state: .waiting
        )
        pendingPrompts = PendingPromptStore.upsert(prompt, into: pendingPrompts)
        PendingPromptStore.save(pendingPrompts)
        // A send while the turn runs must not reach opencode — it would abort
        // the in-flight turn implicitly. The idle drain picks it up.
        if running { return }
        await deliver(prompt)
    }

    /// POST one pending prompt now. Keyed on the prompt's stable id (minted
    /// once at submit and reused across a retry), so the row's identity never
    /// changes across `waiting → sending → failed → waiting` — TiledView
    /// updates it in place instead of remove+insert.
    private func deliver(_ prompt: PendingPrompt) async {
        mark(prompt, .sending)
        // Set up the optimistic turn state `send()` used to set inline. A user
        // submit is a genuinely new turn: re-arm the one-per-turn completion
        // latch, mint the streaming tail's stable id, and assume the turn is
        // running until the box confirms (the running frame, then the canonical
        // refetch of the real user message, land within a second).
        running = true
        optimisticRunning = true
        turnComplete = false
        completionArmed = true
        sessionError = nil
        if runningSince == nil {
            runningSince = Date()
            streamingTailID = "live-\(sessionId)-\(UUID().uuidString)"
            liveTailRowID = streamingTailID
        }
        do {
            try await api.sendPrompt(SendPromptInput(
                sessionId: sessionId,
                text: prompt.text,
                model: prompt.model,
                attachments: prompt.attachments.isEmpty ? nil : prompt.attachments,
                mentions: prompt.mentions,
                agent: prompt.agent
            ))
            // Success: nothing is outstanding any more. Drop the pending row;
            // the canonical refetch already carries the real user message.
            remove(prompt.id)
            // A dictated note's user message now exists on the box; refetch the
            // notes so its player bubble attaches under it (BET-1029).
            Task { await refreshVoiceNotes() }
        } catch {
            // Surface the failure instead of swallowing it: stop the running
            // state and clear the optimistic tail so the spinner doesn't stay
            // on forever. The failed row in the transcript is the error
            // surface — no separate `actionHint` for this flow.
            optimisticRunning = false
            let rolledBack = ChatStreamMerge.afterSendFailure(to: ChatStreamTurnState(
                running: running,
                turnComplete: turnComplete,
                streamingTailID: streamingTailID,
                locallyAnsweredQuestionIDs: locallyAnsweredQuestionIDs,
                questions: questions
            ))
            running = rolledBack.running
            turnComplete = rolledBack.turnComplete
            streamingTailID = rolledBack.streamingTailID
            mark(prompt, .failed)
        }
    }

    /// Drain ONE pending prompt now that the session is idle. One per idle
    /// edge: `deliver` sets `running = true` optimistically, so a second
    /// pending prompt waits for the next idle. Strict FIFO over `.waiting`
    /// rows (a `.failed`/`.sending` row is never auto-delivered).
    private func drainPendingPromptIfIdle() {
        guard !running else { return }
        guard let next = pendingPrompts.first(where: { $0.state == .waiting }) else { return }
        Task { @MainActor in await deliver(next) }
    }

    /// User-initiated retry of a failed prompt. The ONLY path out of `.failed`.
    /// Reuses the prompt's id — row identity survives the retry.
    func retry(promptID: String) {
        guard let index = pendingPrompts.firstIndex(where: { $0.id == promptID }),
              pendingPrompts[index].state == .failed else { return }
        var prompt = pendingPrompts[index]
        prompt.state = .waiting
        pendingPrompts[index] = prompt
        PendingPromptStore.save(pendingPrompts)
        if !running {
            Task { @MainActor in await deliver(prompt) }
        }
    }

    /// Set a pending row's state, persisting and publishing it.
    private func mark(_ prompt: PendingPrompt, _ state: PendingPrompt.State) {
        guard let index = pendingPrompts.firstIndex(where: { $0.id == prompt.id }) else { return }
        var updated = pendingPrompts[index]
        updated.state = state
        pendingPrompts[index] = updated
        PendingPromptStore.save(pendingPrompts)
    }

    /// Remove a pending row, persisting and publishing the result.
    private func remove(_ id: String) {
        pendingPrompts = PendingPromptStore.remove(id: id, from: pendingPrompts)
        PendingPromptStore.save(pendingPrompts)
    }

    /// Interrupt the running turn.
    func abort() {
        Task {
            do { try await api.abort(sessionId: sessionId) }
            catch { await MainActor.run { actionHint = "Couldn't stop the turn — check the connection" } }
        }
    }

    /// Compact the session to free context.
    ///
    /// Compact used to fire blind — no confirmation and no feedback that context
    /// was freed. Both the overflow action (now confirm-gated) and the compact
    /// route here, and both surface the outcome through the composer
    /// `actionHint` bus so a compact is never silent:
    /// - success surfaces "Compacted — context freed" and schedules the store's
    ///   standard refresh, so the next `context` frame the box pushes shows the
    ///   new headroom in the header pill (the `pct` arrives by push on
    ///   `session.next.step.ended`, so it reflects the freed context once the
    ///   conversation resumes);
    /// - failure surfaces "Compact failed — check the connection".
    func compact() {
        Task {
            do {
                try await api.compactSession(sessionId: sessionId)
                await MainActor.run {
                    actionHint = "Compacted — context freed"
                    scheduleRefetch()
                }
            } catch {
                await MainActor.run { actionHint = "Compact failed — check the connection" }
            }
        }
    }

    private func replyToLatestPermission(_ reply: PermissionReply) {
        guard let permission = newestPermission else { return }
        replyPermission(permission, reply: reply)
    }

    /// Answer the newest pending question from a spoken `choice`: a bare
    /// "yes"/"no" token, a numbered option (1..n), or an option label / free
    /// text. Returns a hint (non-nil) when no question is pending — the caller
    /// surfaces it; nil when answered.
    private func answerLatestQuestion(choice: String) -> String? {
        guard let question = newestQuestion, let first = question.questions.first else {
            return "No question waiting"
        }
        let trimmed = choice.trimmingCharacters(in: .whitespacesAndNewlines)
        let optionIndex: Int?
        if let asNumber = Int(trimmed), asNumber >= 1, asNumber <= first.options.count {
            optionIndex = asNumber - 1
        } else if let labelIndex = first.options.firstIndex(where: {
            $0.label.compare(trimmed, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
        }) {
            optionIndex = labelIndex
        } else {
            optionIndex = nil
        }
        var answers = [[String]]()
        for (index, q) in question.questions.enumerated() {
            if let optionIndex, q.options.indices.contains(optionIndex) {
                answers.append([q.options[optionIndex].label])
            } else if index == 0 {
                // Free-form answer applies to the spoken question (the first).
                answers.append([trimmed])
            } else {
                answers.append([])
            }
        }
        replyQuestion(question, answers: answers)
        return nil
    }

    // MARK: - Header

    /// The newest pending permission, if any (rendered as a tail card).
    var newestPermission: PermissionRequest? { permissions.last }

    /// Partition the pending questions into the plan-exit one and the generic
    /// remaining one. Pure and unit-tested so the plan card and the generic
    /// question card can never render for the same question — the split is by
    /// the exact tool callID (`PlanDerivation.isPlanExitQuestion`), never by
    /// wording.
    /// `nonisolated`: pure (value-in, value-out), so it is directly
    /// unit-testable from a nonisolated XCTest body.
    nonisolated static func splitQuestions(
        _ questions: [QuestionRequest],
        messages: [OpencodeMessage]
    ) -> (planExit: QuestionRequest?, generic: QuestionRequest?) {
        let planExit = questions.last(where: { PlanDerivation.isPlanExitQuestion($0, in: messages) })
        let generic = questions.last(where: { !PlanDerivation.isPlanExitQuestion($0, in: messages) })
        return (planExit, generic)
    }

    /// The newest pending question EXCLUDING the plan_exit question (which is
    /// rendered by the dedicated plan card).
    var newestQuestion: QuestionRequest? {
        Self.splitQuestions(questions, messages: messages).generic
    }

    /// The newest plan_exit question, when one is pending.
    var newestPlanQuestion: QuestionRequest? {
        Self.splitQuestions(questions, messages: messages).planExit
    }

    /// True when at least one blocking card (permission / plan / question) is
    /// present, driving the one-time scroll-to-bottom on arrival (BET-1214).
    var hasBlockingCard: Bool {
        newestPermission != nil || newestPlanQuestion != nil || newestQuestion != nil
    }

    /// The pure transition rule for the one-time auto-scroll when a blocking
    /// card arrives: scroll exactly on the no-card → card edge, never on a
    /// present→present rebuild or a card-leaving transition, and re-arm the
    /// guard the moment a card is present (so a later card re-arrival fires
    /// again). Unit-tested so "once per transition, not per rebuild" cannot
    /// drift (BET-1214).
    /// `nonisolated`: pure (value-in, value-out), so it is directly
    /// unit-testable from a nonisolated XCTest body.
    nonisolated static func shouldScrollForCardArrival(_ nowPresent: Bool, wasPresent: Bool) -> (scroll: Bool, present: Bool) {
        (scroll: nowPresent && !wasPresent, present: nowPresent)
    }

    /// When the current turn started (nil when idle). The running row measures
    /// live elapsed against its own 1s tick rather than stream-state changes
    /// (BET-630, D1).
    var runningStart: Date? { runningSince }
}
