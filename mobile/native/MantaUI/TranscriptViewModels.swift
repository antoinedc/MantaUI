import Foundation

// ===========================================================================
// WS11 D8–D11 — what the BOX says a transcript means.
//
// `opencode:messages` / `opencode:message` called with `view: true` carry
// `message.view` (and, from D9/D11, `part.view`): the finished turn's footer, a
// truncation warning, canonical media entries, tool-run wording. The phone no
// longer derives any of it; it decodes and shows it.
//
// FOUNDATION-ONLY ON PURPOSE (D19): compiled by the Linux `swift test` view.
//
// Decoding is LENIENT by construction: a malformed or newer-than-us `view` must
// never fail the message it rides on (the message is the transcript; the view is
// decoration), so every field is `try?` and a non-object decodes to "empty".
// ===========================================================================

/// The kinds of truncation the box words (`kind` on the wire). Used only to decide whether a LIVE frame names a kind
/// worth a badge — the words themselves are the box's.
enum TranscriptTruncationKind: String, Equatable, Sendable {
    case outputCap = "output-cap"
    case contextWall = "context-wall"
    case toolCutoff = "tool-cutoff"
}

/// A finished turn, as the box decided it (`view.turn`): duration (nil when it has none), output+reasoning tokens
/// (nil when zero) and the id the footer verb is seeded from.
struct TranscriptTurnView: Codable, Equatable, Sendable {
    var durationMs: Double?
    var tokens: Double?
    var verbSeedId: String

    init(durationMs: Double? = nil, tokens: Double? = nil, verbSeedId: String) {
        self.durationMs = durationMs
        self.tokens = tokens
        self.verbSeedId = verbSeedId
    }

    private enum CodingKeys: String, CodingKey { case durationMs, tokens, verbSeedId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        durationMs = (try? c.decodeIfPresent(Double.self, forKey: .durationMs)) ?? nil
        tokens = (try? c.decodeIfPresent(Double.self, forKey: .tokens)) ?? nil
        verbSeedId = try c.decode(String.self, forKey: .verbSeedId)
    }
}

/// A truncation as the box words it: the pill text is `label`; the explanation (`hint`) exists only when the box sent
/// one (an older box's live frame carries none — the pill then has no explain action).
struct TranscriptTruncationView: Codable, Equatable, Sendable {
    var kind: String
    var label: String
    var hint: String?

    init(kind: String, label: String, hint: String? = nil) {
        self.kind = kind
        self.label = label
        self.hint = (hint?.isEmpty == false) ? hint : nil
    }

    private enum CodingKeys: String, CodingKey { case kind, label, hint }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(String.self, forKey: .kind)
        label = try c.decode(String.self, forKey: .label)
        let raw = (try? c.decodeIfPresent(String.self, forKey: .hint)) ?? nil
        hint = (raw?.isEmpty == false) ? raw : nil
    }
}

/// One canonical inline-media entry the box reconstructed (`view.media`, D9). `id` is the identity rule
/// (`media:h:<handle>` / `media:s:<messageId>:<path>`); `aspectRatio` / `count` are the begin's reserved box.
struct TranscriptMediaView: Codable, Equatable, Sendable {
    var id: String
    var kind: String
    var path: String?
    var mime: String?
    var width: Double?
    var height: Double?
    var aspectRatio: Double?
    var count: Int?
    var size: Int64?
    var title: String?
    var handle: String?

    private enum CodingKeys: String, CodingKey { case id, kind, path, mime, width, height, aspectRatio, count, size, title, handle }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "image"
        path = (try? c.decodeIfPresent(String.self, forKey: .path)) ?? nil
        mime = (try? c.decodeIfPresent(String.self, forKey: .mime)) ?? nil
        width = (try? c.decodeIfPresent(Double.self, forKey: .width)) ?? nil
        height = (try? c.decodeIfPresent(Double.self, forKey: .height)) ?? nil
        aspectRatio = (try? c.decodeIfPresent(Double.self, forKey: .aspectRatio)) ?? nil
        count = (try? c.decodeIfPresent(Int.self, forKey: .count)) ?? nil
        size = (try? c.decodeIfPresent(Int64.self, forKey: .size)) ?? nil
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? nil
        handle = (try? c.decodeIfPresent(String.self, forKey: .handle)) ?? nil
    }

    init(id: String, kind: String = "image", path: String? = nil, mime: String? = nil, width: Double? = nil,
         height: Double? = nil, aspectRatio: Double? = nil, count: Int? = nil, size: Int64? = nil,
         title: String? = nil, handle: String? = nil) {
        self.id = id
        self.kind = kind
        self.path = path
        self.mime = mime
        self.width = width
        self.height = height
        self.aspectRatio = aspectRatio
        self.count = count
        self.size = size
        self.title = title
        self.handle = handle
    }
}

/// `message.view`.
struct TranscriptMessageView: Codable, Equatable, Sendable {
    var turn: TranscriptTurnView?
    var truncation: TranscriptTruncationView?
    /// Ready media this message OWNS, in first-sight order. A malformed entry is skipped, never the whole list.
    var media: [TranscriptMediaView]
    /// The runs of tool calls this message touches (D11): the full view on the run's placement message, a reference
    /// elsewhere. A malformed entry is skipped, never the whole list.
    var runs: [TranscriptRunEntry]

    init(turn: TranscriptTurnView? = nil, truncation: TranscriptTruncationView? = nil, media: [TranscriptMediaView] = [],
         runs: [TranscriptRunEntry] = []) {
        self.turn = turn
        self.truncation = truncation
        self.media = media
        self.runs = runs
    }

    private enum CodingKeys: String, CodingKey { case turn, truncation, media, runs }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else {
            turn = nil
            truncation = nil
            media = []
            runs = []
            return
        }
        turn = (try? c.decodeIfPresent(TranscriptTurnView.self, forKey: .turn)) ?? nil
        truncation = (try? c.decodeIfPresent(TranscriptTruncationView.self, forKey: .truncation)) ?? nil
        media = ((try? c.decodeIfPresent(LossyList<TranscriptMediaView>.self, forKey: .media)) ?? nil)?.items ?? []
        runs = ((try? c.decodeIfPresent(LossyList<TranscriptRunEntry>.self, forKey: .runs)) ?? nil)?.items ?? []
    }
}

/// A list that drops the elements it cannot decode instead of failing as a whole.
struct LossyList<Element: Decodable>: Decodable {
    var items: [Element]

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var out: [Element] = []
        while !container.isAtEnd {
            if let element = try? container.decode(Element.self) {
                out.append(element)
            } else {
                _ = try? container.decode(DiscardedValue.self)
            }
        }
        items = out
    }

    private struct DiscardedValue: Decodable {}
}

// MARK: - Canonical media → entries (D9)

enum TranscriptViewMedia {
    /// Every message's `view.media`, as the entries the media card draws: ready, owned by that message, `seq` = the
    /// index in transcript order (the box already ordered them by first sight). Replaces the phone's own parsing of
    /// `media_begin` / `media_show` tool output.
    static func entries(_ messages: [OpencodeMessage]) -> [TranscriptMediaEntry] {
        var out: [TranscriptMediaEntry] = []
        for message in messages {
            for view in message.view?.media ?? [] {
                out.append(TranscriptMediaEntry(
                    id: view.id,
                    ownerMessageID: message.info.id,
                    seq: out.count,
                    state: .ready,
                    kind: view.kind == "video" ? .video : .image,
                    reserved: TranscriptMediaGeometryInput(
                        width: positive(view.width), height: positive(view.height), aspectRatio: positive(view.aspectRatio)
                    ),
                    count: view.count,
                    title: (view.title?.isEmpty == false) ? view.title : nil,
                    path: view.path,
                    mime: view.mime,
                    size: view.size,
                    beganAt: nil,
                    handle: (view.handle?.isEmpty == false) ? view.handle : nil
                ))
            }
        }
        return out
    }

    private static func positive(_ n: Double?) -> Double? {
        guard let n, n.isFinite, n > 0 else { return nil }
        return n
    }
}


// MARK: - Plan question (D10)

/// The plan card's data for a plan_exit question, decided on the box (`question.plan`).
struct PlanQuestionView: Codable, Equatable, Sendable {
    var title: String
    var text: String
    var steps: Int
    var files: Int
    /// The `.opencode/plans/*.md` file, nil when none was found.
    var path: String?
    /// The shareable plan page, nil when the box has no public base URL.
    var pageUrl: String?

    init(title: String, text: String, steps: Int = 0, files: Int = 0, path: String? = nil, pageUrl: String? = nil) {
        self.title = title
        self.text = text
        self.steps = steps
        self.files = files
        self.path = path
        self.pageUrl = pageUrl
    }

    private enum CodingKeys: String, CodingKey { case title, text, steps, files, path, pageUrl }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decode(String.self, forKey: .title)
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        steps = ((try? c.decodeIfPresent(Int.self, forKey: .steps)) ?? nil) ?? 0
        files = ((try? c.decodeIfPresent(Int.self, forKey: .files)) ?? nil) ?? 0
        path = (try? c.decodeIfPresent(String.self, forKey: .path)) ?? nil
        pageUrl = (try? c.decodeIfPresent(String.self, forKey: .pageUrl)) ?? nil
    }
}

// ===========================================================================
// MARK: - Tool activity + runs (WS11 D11)
//
// What a tool call SAYS ("Edited Transcript.tsx"), what a run of calls says ("Read 3 files, ran a command"), where a run
// begins and ends, and the run's revision are all the BOX's (src/server/transcriptRuns.mjs). The phone decodes them
// (`part.view`, `message.view.runs`, the live `toolRuns` frame), keeps the newest value of each run, and lays the
// blocks out. No wording, no summary and no run membership is computed here.
// ===========================================================================

/// The category a tool call belongs to (decoded; the box words it). An unknown kind from a newer box reads `.other`.
enum ActivityKind: String, Codable, Equatable, Sendable {
    case read, edit, write, bash, search, list, fetch, websearch, task, delegate, skill, question, other, patch

    init(from decoder: Decoder) throws {
        let raw = (try? decoder.singleValueContainer().decode(String.self)) ?? ""
        self = ActivityKind(rawValue: raw) ?? .other
    }
}

enum ActivityStatus: String, Codable, Equatable, Sendable {
    case pending, running, completed, error

    /// opencode's `state.status` onto the four states; anything unrecognised is `pending`.
    static func normalize(_ raw: String?) -> ActivityStatus {
        switch raw {
        case "completed": return .completed
        case "error": return .error
        case "running": return .running
        default: return .pending
        }
    }

    init(from decoder: Decoder) throws {
        self = Self.normalize(try? decoder.singleValueContainer().decode(String.self))
    }
}

/// A run's dot tone: running while a call is unfinished, warn if any failed, else ok (decoded).
enum GroupTone: String, Codable, Equatable, Sendable {
    case ok, warn, running

    init(from decoder: Decoder) throws {
        let raw = (try? decoder.singleValueContainer().decode(String.self)) ?? ""
        self = GroupTone(rawValue: raw) ?? .ok
    }
}

/// `part.view.activity`: one tool/patch call's wording, as the box decided it.
struct TranscriptActivityView: Codable, Equatable, Sendable {
    var kind: ActivityKind
    var status: ActivityStatus
    /// The label for the call's current status.
    var label: String
    /// The full path / command / pattern / url the call acted on, "" when none.
    var target: String
    /// False for file-save patches: they join a run but are not a "tool".
    var counted: Bool

    init(kind: ActivityKind, status: ActivityStatus, label: String, target: String = "", counted: Bool = true) {
        self.kind = kind
        self.status = status
        self.label = label
        self.target = target
        self.counted = counted
    }

    private enum CodingKeys: String, CodingKey { case kind, status, label, target, counted }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = ((try? c.decodeIfPresent(ActivityKind.self, forKey: .kind)) ?? nil) ?? .other
        status = ((try? c.decodeIfPresent(ActivityStatus.self, forKey: .status)) ?? nil) ?? .pending
        label = ((try? c.decodeIfPresent(String.self, forKey: .label)) ?? nil) ?? ""
        target = ((try? c.decodeIfPresent(String.self, forKey: .target)) ?? nil) ?? ""
        counted = ((try? c.decodeIfPresent(Bool.self, forKey: .counted)) ?? nil) ?? true
    }
}

/// The latest unfinished call of a run, present tense.
struct TranscriptLiveActivity: Codable, Equatable, Sendable {
    var kind: ActivityKind
    var label: String

    init(kind: ActivityKind, label: String) {
        self.kind = kind
        self.label = label
    }

    private enum CodingKeys: String, CodingKey { case kind, label }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = ((try? c.decodeIfPresent(ActivityKind.self, forKey: .kind)) ?? nil) ?? .other
        label = ((try? c.decodeIfPresent(String.self, forKey: .label)) ?? nil) ?? ""
    }
}

/// What the box says a run (or one segment of it) IS: the one-line label, the call counts, the dot tone and the call in
/// flight. Decoded as it arrives — never recomputed.
struct TranscriptRunSummary: Codable, Equatable, Sendable {
    var label: String
    var calls: Int
    var failed: Int
    var tone: GroupTone
    var live: TranscriptLiveActivity?

    init(label: String, calls: Int = 0, failed: Int = 0, tone: GroupTone = .ok, live: TranscriptLiveActivity? = nil) {
        self.label = label
        self.calls = calls
        self.failed = failed
        self.tone = tone
        self.live = live
    }

    /// True while any call is unfinished (the box's tone says so).
    var running: Bool { tone == .running }

    private enum CodingKeys: String, CodingKey { case label, calls, failed, tone, live }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = ((try? c.decodeIfPresent(String.self, forKey: .label)) ?? nil) ?? ""
        calls = ((try? c.decodeIfPresent(Int.self, forKey: .calls)) ?? nil) ?? 0
        failed = ((try? c.decodeIfPresent(Int.self, forKey: .failed)) ?? nil) ?? 0
        tone = ((try? c.decodeIfPresent(GroupTone.self, forKey: .tone)) ?? nil) ?? .ok
        live = (try? c.decodeIfPresent(TranscriptLiveActivity.self, forKey: .live)) ?? nil
    }
}

/// `{epoch, gen, seq}`: the interpreter process, the ledger's membership generation, a per-session change counter.
struct TranscriptRunRev: Codable, Equatable, Sendable {
    var epoch: String
    var gen: Int
    var seq: Int

    init(epoch: String, gen: Int = 1, seq: Int = 0) {
        self.epoch = epoch
        self.gen = gen
        self.seq = seq
    }
}

/// One segment of a run that reasoning split (a client showing reasoning draws one row per segment).
struct TranscriptRunSegment: Codable, Equatable, Sendable {
    var id: String
    var summary: TranscriptRunSummary

    init(id: String, summary: TranscriptRunSummary) {
        self.id = id
        self.summary = summary
    }

    private enum CodingKeys: String, CodingKey { case id }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        summary = try TranscriptRunSummary(from: decoder)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try summary.encode(to: encoder)
    }
}

/// A run, in full: its id (the FIRST part's id), the message it began in, its revision and its summary.
struct TranscriptRunView: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var ownerMessageId: String
    var rev: TranscriptRunRev
    var summary: TranscriptRunSummary
    /// Only when reasoning split the run.
    var segments: [TranscriptRunSegment]

    init(id: String, ownerMessageId: String = "", rev: TranscriptRunRev, summary: TranscriptRunSummary,
         segments: [TranscriptRunSegment] = []) {
        self.id = id
        self.ownerMessageId = ownerMessageId
        self.rev = rev
        self.summary = summary
        self.segments = segments
    }

    private enum CodingKeys: String, CodingKey { case id, ownerMessageId, rev, segments }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        ownerMessageId = ((try? c.decodeIfPresent(String.self, forKey: .ownerMessageId)) ?? nil) ?? ""
        rev = try c.decode(TranscriptRunRev.self, forKey: .rev)
        summary = try TranscriptRunSummary(from: decoder)
        segments = ((try? c.decodeIfPresent(LossyList<TranscriptRunSegment>.self, forKey: .segments)) ?? nil)?.items ?? []
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(ownerMessageId, forKey: .ownerMessageId)
        try c.encode(rev, forKey: .rev)
        try c.encode(segments, forKey: .segments)
        try summary.encode(to: encoder)
    }

    /// The summary a block draws: the whole run, or — when reasoning is shown and the run split — this segment's.
    func summary(forSegment segmentID: String?) -> TranscriptRunSummary {
        guard let segmentID, let seg = segments.first(where: { $0.id == segmentID }) else { return summary }
        return seg.summary
    }
}

/// A run named on a message that does not carry its full view (the full view rides on the placement message).
struct TranscriptRunRef: Codable, Equatable, Sendable {
    var id: String
    var rev: TranscriptRunRev
}

/// `message.view.runs[i]`: the full view or a reference.
enum TranscriptRunEntry: Codable, Equatable, Sendable {
    case view(TranscriptRunView)
    case ref(TranscriptRunRef)

    private enum ProbeKeys: String, CodingKey { case ref }

    init(from decoder: Decoder) throws {
        let probe = try decoder.container(keyedBy: ProbeKeys.self)
        if ((try? probe.decodeIfPresent(Bool.self, forKey: .ref)) ?? nil) == true {
            self = .ref(try TranscriptRunRef(from: decoder))
        } else {
            self = .view(try TranscriptRunView(from: decoder))
        }
    }

    func encode(to encoder: Encoder) throws {
        switch self {
        case .view(let v): try v.encode(to: encoder)
        case .ref(let r):
            var c = encoder.container(keyedBy: ProbeKeys.self)
            try c.encode(true, forKey: .ref)
            try r.encode(to: encoder)
        }
    }
}

/// `part.view`, read from a part's extras: its activity, the run (and segment) it belongs to and the membership generation.
struct TranscriptPartView: Equatable, Sendable {
    var activity: TranscriptActivityView?
    var runId: String?
    var segmentId: String?
    var gen: Int?

    /// nil when the part carries no `view` (an older box, or a part the box does not describe).
    static func of(_ part: OpencodePart) -> TranscriptPartView? {
        guard let view = ChatJSON.object(part.extra["view"]) else { return nil }
        var activity: TranscriptActivityView?
        if let a = ChatJSON.object(view["activity"]) {
            activity = TranscriptActivityView(
                kind: ActivityKind(rawValue: ChatJSON.string(a["kind"]) ?? "") ?? .other,
                status: ActivityStatus.normalize(ChatJSON.string(a["status"])),
                label: ChatJSON.string(a["label"]) ?? "",
                target: ChatJSON.string(a["target"]) ?? "",
                counted: { if case .bool(let b)? = a["counted"] { return b } else { return true } }()
            )
        }
        let runId = ChatJSON.string(view["runId"])
        let segmentId = ChatJSON.string(view["segmentId"])
        let gen = ChatJSON.number(view["gen"]).flatMap { Int(exactly: $0) }
        if activity == nil, runId == nil, segmentId == nil, gen == nil { return nil }
        return TranscriptPartView(activity: activity, runId: (runId?.isEmpty == false) ? runId : nil,
                                  segmentId: (segmentId?.isEmpty == false) ? segmentId : nil, gen: gen)
    }

    /// A part's `view`, as extras (for the synthetic tool parts the live tail builds from ledger entries).
    static func extra(activity: TranscriptActivityView, runId: String, segmentId: String?, gen: Int?) -> JSONValue {
        var view: [String: JSONValue] = [
            "activity": .object([
                "kind": .string(activity.kind.rawValue),
                "status": .string(activity.status.rawValue),
                "label": .string(activity.label),
                "target": .string(activity.target),
                "counted": .bool(activity.counted),
            ]),
            "runId": .string(runId),
        ]
        if let segmentId { view["segmentId"] = .string(segmentId) }
        if let gen { view["gen"] = .number(Double(gen)) }
        return .object(view)
    }
}

// MARK: Run store (the revision rules)

/// What a value or an answer must be judged against: the epoch of the LATEST events connection (nil until its `runningSet`
/// arrives), the connection counter now, and — for an RPC answer — the counter it was ISSUED under.
struct TranscriptRunContext: Equatable, Sendable {
    var currentEpoch: String?
    var connGen: Int
    var issuedConnGen: Int?

    init(currentEpoch: String?, connGen: Int, issuedConnGen: Int? = nil) {
        self.currentEpoch = currentEpoch
        self.connGen = connGen
        self.issuedConnGen = issuedConnGen
    }
}

/// The newest value of each run, whatever order the answers arrive in (spec "Run revisions"): a value of another epoch is
/// rejected; an RPC answer issued under an older connection is discarded; before the epoch is known writes queue; within
/// the epoch a value wins iff its `gen` is higher, or equal with `seq >=`; anything older than `minGen` is a retired
/// membership; references never overwrite. Value type: every operation returns a new store.
struct TranscriptRunStore: Equatable, Sendable {
    private struct Queued: Equatable, Sendable {
        var values: [TranscriptRunEntry]
        var issuedConnGen: Int?
    }

    private(set) var epoch: String?
    private(set) var runs: [String: TranscriptRunView]
    /// The highest `gen` seen in the current epoch.
    private(set) var minGen: Int
    /// The run ids a rebuild retired in the current epoch. Only a part of one of THESE runs is a stale membership when its
    /// `gen` is below `minGen`: history a rebuild never touched keeps its rows.
    private(set) var retired: Set<String>
    private var queue: [Queued]

    init() {
        epoch = nil
        runs = [:]
        minGen = 0
        retired = []
        queue = []
    }

    private init(epoch: String?, runs: [String: TranscriptRunView], minGen: Int, retired: Set<String> = [], queue: [Queued]) {
        self.epoch = epoch
        self.runs = runs
        self.minGen = minGen
        self.retired = retired
        self.queue = queue
    }

    static let empty = TranscriptRunStore()

    /// The connection's epoch became known / changed: runs of another epoch are dropped, queued writes apply.
    func settingEpoch(_ newEpoch: String?, connGen: Int) -> TranscriptRunStore {
        if newEpoch == epoch {
            // A reconnect to the SAME box process: nothing is dropped, but whatever was queued while the new connection's
            // epoch was unknown applies now (the connection counter still discards answers issued before the reconnect).
            guard newEpoch != nil, !queue.isEmpty else { return self }
            var next = TranscriptRunStore(epoch: epoch, runs: runs, minGen: minGen, retired: retired, queue: [])
            for q in queue {
                next = next.merging(q.values, context: TranscriptRunContext(currentEpoch: newEpoch, connGen: connGen, issuedConnGen: q.issuedConnGen))
            }
            return next
        }
        var next = TranscriptRunStore(epoch: newEpoch, runs: [:], minGen: 0, queue: [])
        if newEpoch != nil {
            for q in queue {
                next = next.merging(q.values, context: TranscriptRunContext(currentEpoch: newEpoch, connGen: connGen, issuedConnGen: q.issuedConnGen))
            }
        }
        return next
    }

    func merging(_ incoming: [TranscriptRunEntry], context: TranscriptRunContext) -> TranscriptRunStore {
        if let issued = context.issuedConnGen, issued < context.connGen { return self }
        guard let current = context.currentEpoch else {
            if incoming.isEmpty { return self }
            var next = self
            next.queue.append(Queued(values: incoming, issuedConnGen: context.issuedConnGen))
            return next
        }
        var base = self
        if epoch != current { base = TranscriptRunStore(epoch: current, runs: [:], minGen: 0, queue: queue) }
        var runs = base.runs
        var minGen = base.minGen
        var changed = base.epoch != epoch
        for entry in incoming {
            guard case .view(let v) = entry else { continue }
            if v.rev.epoch != current || v.rev.gen < minGen { continue }
            if let cur = runs[v.id], v.rev.gen < cur.rev.gen || (v.rev.gen == cur.rev.gen && v.rev.seq < cur.rev.seq) { continue }
            runs[v.id] = v
            changed = true
            if v.rev.gen > minGen { minGen = v.rev.gen }
        }
        if !changed { return self }
        return TranscriptRunStore(epoch: base.epoch, runs: runs, minGen: minGen, retired: base.retired, queue: base.queue)
    }

    /// A canonical rebuild (`rebuilt:true`): delete the retired ids, remember them (so only THEIR old membership reads as
    /// stale) and raise `minGen`.
    func retiring(_ ids: [String], gen: Int) -> TranscriptRunStore {
        var runs = self.runs
        for id in ids { runs[id] = nil }
        return TranscriptRunStore(epoch: epoch, runs: runs, minGen: max(minGen, gen), retired: retired.union(ids), queue: queue)
    }

    /// The runs no loaded message references and the current turn does not hold are forgotten (a refetch's housekeeping:
    /// the map must not grow with every run a session ever saw). A retired id is remembered only while something still
    /// references it.
    func pruning(keeping ids: Set<String>) -> TranscriptRunStore {
        let kept = runs.filter { ids.contains($0.key) }
        let stillRetired = retired.intersection(ids)
        if kept.count == runs.count && stillRetired.count == retired.count { return self }
        return TranscriptRunStore(epoch: epoch, runs: kept, minGen: minGen, retired: stillRetired, queue: queue)
    }

    /// The full (non-reference) run views a transcript carries, in message order.
    static func entries(of messages: [OpencodeMessage]) -> [TranscriptRunEntry] {
        messages.flatMap { $0.view?.runs ?? [] }
    }

    /// True when a message's parts carry a RETIRED run's old membership (a splice or read issued before a rebuild): a part
    /// whose `gen` is below `minGen` AND whose run a rebuild retired. Everything else is still right.
    static func hasStaleMembership(_ messages: [OpencodeMessage], minGen: Int, retired: Set<String>) -> Bool {
        guard minGen > 0, !retired.isEmpty else { return false }
        return messages.contains { m in
            m.parts.contains { isStale(TranscriptPartView.of($0), minGen: minGen, retired: retired) }
        }
    }

    /// One part's membership is stale when it names a retired run under a generation below `minGen`.
    static func isStale(_ view: TranscriptPartView?, minGen: Int, retired: Set<String>) -> Bool {
        guard let view, let runID = view.runId, let gen = view.gen else { return false }
        return gen < minGen && retired.contains(runID)
    }

    /// The run ids a set of messages references (parts and `message.view.runs`, full views and references alike).
    static func referencedRunIDs(in messages: [OpencodeMessage]) -> Set<String> {
        var out = Set<String>()
        for message in messages {
            for part in message.parts {
                if let id = TranscriptPartView.of(part)?.runId { out.insert(id) }
            }
            for entry in message.view?.runs ?? [] {
                switch entry {
                case .view(let v): out.insert(v.id)
                case .ref(let r): out.insert(r.id)
                }
            }
        }
        return out
    }
}

// MARK: Live frames

/// One entry of the live turn's ORDERED layout (`toolRuns.layout`).
enum LiveBlock: Codable, Equatable, Sendable {
    /// One entry per SEGMENT of a run (the first segment's id is the run id).
    case run(id: String, segmentId: String)
    case text(partID: String, messageID: String)
    case reasoning(partID: String, messageID: String)

    private enum CodingKeys: String, CodingKey { case kind, id, segmentId, partID, messageID }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "run":
            let id = try c.decode(String.self, forKey: .id)
            self = .run(id: id, segmentId: ((try? c.decodeIfPresent(String.self, forKey: .segmentId)) ?? nil) ?? id)
        case "text":
            self = .text(partID: try c.decode(String.self, forKey: .partID), messageID: ((try? c.decodeIfPresent(String.self, forKey: .messageID)) ?? nil) ?? "")
        case "reasoning":
            self = .reasoning(partID: try c.decode(String.self, forKey: .partID), messageID: ((try? c.decodeIfPresent(String.self, forKey: .messageID)) ?? nil) ?? "")
        default:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown live block")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .run(let id, let segmentId):
            try c.encode("run", forKey: .kind)
            try c.encode(id, forKey: .id)
            try c.encode(segmentId, forKey: .segmentId)
        case .text(let partID, let messageID):
            try c.encode("text", forKey: .kind)
            try c.encode(partID, forKey: .partID)
            try c.encode(messageID, forKey: .messageID)
        case .reasoning(let partID, let messageID):
            try c.encode("reasoning", forKey: .kind)
            try c.encode(partID, forKey: .partID)
            try c.encode(messageID, forKey: .messageID)
        }
    }
}

/// A tool call of the live turn, as the ledger reports it (`toolRuns.parts[i]`). Output is never in the frame; the tail
/// of a running call's stdout stays on the `toolOutput` frames, joined by part id.
struct LiveRunPart: Codable, Equatable, Sendable {
    var id: String
    var callID: String
    var messageID: String
    var runId: String
    var segmentId: String?
    var tool: String
    var status: String
    var childSessionId: String?
    var activity: TranscriptActivityView

    private enum CodingKeys: String, CodingKey { case id, callID, messageID, runId, segmentId, tool, status, childSessionId, activity }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        callID = ((try? c.decodeIfPresent(String.self, forKey: .callID)) ?? nil) ?? id
        messageID = ((try? c.decodeIfPresent(String.self, forKey: .messageID)) ?? nil) ?? ""
        runId = ((try? c.decodeIfPresent(String.self, forKey: .runId)) ?? nil) ?? ""
        segmentId = (try? c.decodeIfPresent(String.self, forKey: .segmentId)) ?? nil
        tool = ((try? c.decodeIfPresent(String.self, forKey: .tool)) ?? nil) ?? ""
        status = ((try? c.decodeIfPresent(String.self, forKey: .status)) ?? nil) ?? "pending"
        childSessionId = (try? c.decodeIfPresent(String.self, forKey: .childSessionId)) ?? nil
        activity = ((try? c.decodeIfPresent(TranscriptActivityView.self, forKey: .activity)) ?? nil)
            ?? TranscriptActivityView(kind: .other, status: ActivityStatus.normalize(status), label: tool)
    }

    init(id: String, callID: String? = nil, messageID: String = "", runId: String, segmentId: String? = nil, tool: String,
         status: String, childSessionId: String? = nil, activity: TranscriptActivityView) {
        self.id = id
        self.callID = callID ?? id
        self.messageID = messageID
        self.runId = runId
        self.segmentId = segmentId
        self.tool = tool
        self.status = status
        self.childSessionId = childSessionId
        self.activity = activity
    }
}

/// `sub: "toolRuns"`.
struct StreamToolRunsPayload: Decodable, Equatable, Sendable {
    var epoch: String
    var full: Bool
    var gen: Int
    var rebuilt: Bool
    var retired: [String]
    var layout: [LiveBlock]
    var runs: [TranscriptRunView]
    var closed: [String]
    var parts: [LiveRunPart]

    init(epoch: String, full: Bool = false, gen: Int = 1, rebuilt: Bool = false, retired: [String] = [],
         layout: [LiveBlock] = [], runs: [TranscriptRunView] = [], closed: [String] = [], parts: [LiveRunPart] = []) {
        self.epoch = epoch
        self.full = full
        self.gen = gen
        self.rebuilt = rebuilt
        self.retired = retired
        self.layout = layout
        self.runs = runs
        self.closed = closed
        self.parts = parts
    }

    private enum CodingKeys: String, CodingKey { case epoch, full, gen, rebuilt, retired, layout, runs, closed, parts }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        epoch = try c.decode(String.self, forKey: .epoch)
        full = ((try? c.decodeIfPresent(Bool.self, forKey: .full)) ?? nil) ?? false
        gen = ((try? c.decodeIfPresent(Int.self, forKey: .gen)) ?? nil) ?? 1
        rebuilt = ((try? c.decodeIfPresent(Bool.self, forKey: .rebuilt)) ?? nil) ?? false
        retired = ((try? c.decodeIfPresent([String].self, forKey: .retired)) ?? nil) ?? []
        layout = ((try? c.decodeIfPresent(LossyList<LiveBlock>.self, forKey: .layout)) ?? nil)?.items ?? []
        runs = ((try? c.decodeIfPresent(LossyList<TranscriptRunView>.self, forKey: .runs)) ?? nil)?.items ?? []
        closed = ((try? c.decodeIfPresent([String].self, forKey: .closed)) ?? nil) ?? []
        parts = ((try? c.decodeIfPresent(LossyList<LiveRunPart>.self, forKey: .parts)) ?? nil)?.items ?? []
    }
}

/// The live turn's ledger as the phone holds it: the ordered layout, the calls, which runs have closed, and the run values
/// (merged by revision). Applied from `toolRuns` frames by `MantaStreamRouter`; read by the chat store's live-tail builder.
struct TranscriptLiveRunsState: Equatable, Sendable {
    var layout: [LiveBlock] = []
    /// The turn's calls in the order the ledger first reported them.
    var parts: [LiveRunPart] = []
    var closed: Set<String> = []
    var store = TranscriptRunStore()
    /// The epoch of the frames held (layout / parts / closed); a different connection epoch drops them.
    var liveEpoch: String?
    /// Bumped on every `rebuilt` frame; the chat store retires `lastRetired` from its own values and refetches once.
    var rebuildSeq = 0
    var lastRetired: [String] = []
    var lastGen = 0

    var isEmpty: Bool { layout.isEmpty && parts.isEmpty }

    /// The run ids the live turn holds (its layout and its calls): never pruned from the run store.
    var heldRunIDs: Set<String> {
        var out = Set(parts.map(\.runId))
        for case .run(let id, _) in layout { out.insert(id) }
        return out
    }

    /// The connection's epoch became known: another epoch's layout/parts/closed and runs are dropped.
    func settingEpoch(_ epoch: String?, connGen: Int) -> TranscriptLiveRunsState {
        var next = self
        next.store = store.settingEpoch(epoch, connGen: connGen)
        if let epoch, let held = liveEpoch, held != epoch {
            next.layout = []
            next.parts = []
            next.closed = []
            next.liveEpoch = nil
        }
        return next
    }

    func applying(_ payload: StreamToolRunsPayload, context: TranscriptRunContext) -> TranscriptLiveRunsState {
        // A frame of another epoch than the current connection's is a retired process's word: rejected like any value.
        if let current = context.currentEpoch, payload.epoch != current { return self }
        var next = self
        next.store = store.merging(payload.runs.map { .view($0) }, context: context)
        if payload.full {
            next.parts = []
            next.closed = []
        }
        next.liveEpoch = payload.epoch
        next.layout = payload.layout
        for part in payload.parts {
            if let i = next.parts.firstIndex(where: { $0.id == part.id }) { next.parts[i] = part } else { next.parts.append(part) }
        }
        next.closed.formUnion(payload.closed)
        if payload.rebuilt {
            next.store = next.store.retiring(payload.retired, gen: payload.gen)
            let incomingIDs = Set(payload.parts.map(\.id))
            next.parts.removeAll { payload.retired.contains($0.runId) && !incomingIDs.contains($0.id) }
            next.closed.subtract(payload.retired)
            next.rebuildSeq += 1
            next.lastRetired = payload.retired
            next.lastGen = payload.gen
        }
        return next
    }

    /// The turn is over and the canonical transcript covers every block of the layout: forget it (the run VALUES stay, merged
    /// by revision, so a later canonical answer can never regress them).
    func clearingLayout() -> TranscriptLiveRunsState {
        var next = self
        next.layout = []
        next.parts = []
        next.closed = []
        return next
    }
}

// MARK: Live tail plan (the placement rule)

/// One block of the live tail, before it is given content: what the ordered layout draws, under the one placement rule
/// both clients use (spec "Ordered layout").
enum LiveTailItem: Equatable, Sendable {
    /// A run (or segment) block. `rowID` is `"run-" + segmentId` with reasoning shown, `"run-" + runId` otherwise.
    case run(rowID: String, runID: String, segmentID: String?)
    case text(partID: String)
    case reasoning(partID: String)
}

enum TranscriptLiveTailPlan {
    /// - reasoning SHOWN: every run entry draws its own block (the segment's summary) and reasoning entries draw between
    ///   them;
    /// - reasoning HIDDEN: reasoning draws nothing, and consecutive run entries with the SAME run id collapse into ONE block
    ///   at the first entry. The first segment's id equals the run id, so toggling keeps the first row's id.
    static func items(layout: [LiveBlock], showReasoning: Bool) -> [LiveTailItem] {
        var out: [LiveTailItem] = []
        for block in layout {
            switch block {
            case .run(let id, let segmentId):
                if showReasoning {
                    out.append(.run(rowID: "run-" + segmentId, runID: id, segmentID: segmentId))
                } else if case .run(_, let previousRun, _)? = out.last, previousRun == id {
                    continue
                } else {
                    out.append(.run(rowID: "run-" + id, runID: id, segmentID: nil))
                }
            case .text(let partID, _):
                out.append(.text(partID: partID))
            case .reasoning(let partID, _):
                if showReasoning { out.append(.reasoning(partID: partID)) }
            }
        }
        return out
    }
}

// MARK: Older-box note (the Activity sheet)

enum ActivityFallbackNote {
    /// What the Activity sheet says above a neutral (fallback) line. The "update your box" advice is for a box that
    /// verifiably lacks `transcript-runs-1` (`hasRuns == false`); on a current box a fallback line is transient (a rebuild's
    /// repair, or a first read made before the capabilities resolved), so it says the details are loading; with the
    /// capabilities not known yet it says nothing. nil for a line that is not a fallback.
    static func text(isFallback: Bool, hasRuns: Bool?) -> String? {
        guard isFallback, let hasRuns else { return nil }
        return hasRuns ? "Loading tool details\u{2026}" : "Update your box to see tool details"
    }
}
