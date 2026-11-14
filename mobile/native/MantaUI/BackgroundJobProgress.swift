import Foundation

// ===========================================================================
// Background job liveness + progress (spec 2026-11-14 §5.3, B4, B6).
//
// Foundation-only on purpose: decoding, the rev rule, the client clock and every
// string the rows / detail sheet show are plain functions, so they run in the
// Linux package view (Package.swift) as well as in the app.
//
// The box computes a `view` per job. Every time in it is a box-epoch ANCHOR, never
// an age; the client derives ages from `asOf` (skew) and ticks them locally.
// ===========================================================================

/// One job's progress as the box computes it (`DelegateJob.view`, TypeScript
/// `DelegateJobProgressView`). Decoded leniently by `init(json:)`: a view that is
/// missing its identity (`rev`, `asOf`, a known `state`) is nil, and every other
/// field that is absent or of the wrong type just drops out. An older box sends
/// no view at all, and rows then look exactly as they did before.
struct DelegateJobProgressView: Codable, Equatable, Sendable {
    /// `epoch` is the box process start (ms), `n` a per-job counter. A view is
    /// applied only when its rev is newer than the last one applied.
    struct Rev: Codable, Equatable, Sendable {
        var epoch: Double
        var n: Double

        func isNewer(than other: Rev) -> Bool {
            epoch > other.epoch || (epoch == other.epoch && n > other.n)
        }
    }

    enum State: String, Codable, Sendable {
        case working
        case needsDecision = "needs-decision"
        case done
        case failed
        case stopped
        case paused
    }

    struct StepItem: Codable, Equatable, Sendable {
        enum Status: String, Codable, Sendable { case done, current, pending }
        var text: String
        var status: Status
    }

    struct Steps: Codable, Equatable, Sendable {
        var done: Int
        var total: Int
        var current: String? = nil
        /// Empty for reported (non-checklist) steps.
        var items: [StepItem] = []
        var grewAt: Double? = nil
    }

    struct Live: Codable, Equatable, Sendable {
        var tool: String
        var target: String
        var startedAt: Double
    }

    struct Milestone: Codable, Equatable, Sendable {
        var at: Double
        var text: String
    }

    struct Files: Codable, Equatable, Sendable {
        /// nil = unknown (never 0 by mistake).
        var changed: Int?
    }

    struct Usage: Codable, Equatable, Sendable {
        var tokens: Double
        var costUsd: Double? = nil
        var costPartial: Bool = false
    }

    var rev: Rev
    var asOf: Double
    var state: State
    var headline: String = ""
    var steps: Steps? = nil
    var bar: Double? = nil
    var live: Live? = nil
    var startedAt: Double? = nil
    var endedAt: Double? = nil
    var lastProgressAt: Double? = nil
    var ceilingAt: Double? = nil
    /// Newest first.
    var milestones: [Milestone] = []
    var files: Files? = nil
    var usage: Usage? = nil
    var model: String? = nil

    /// Still working: the box sets `endedAt` only once the job paused or finished.
    var isRunning: Bool {
        endedAt == nil && (state == .working || state == .needsDecision)
    }

    /// The model asked for a decision — either while running, or the job ended
    /// that way (`done` + `endedBlocked` maps to this state on the box).
    var needsDecision: Bool { state == .needsDecision }
}

// MARK: - Lenient decoding

extension DelegateJobProgressView {
    /// Strict-looking `Decodable` for completeness; the app decodes through
    /// `init(json:)` (see `DelegateJob.init(from:)`), which never throws.
    init(from decoder: Decoder) throws {
        let json = try JSONValue(from: decoder)
        guard let view = Self(json: json) else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "not a job progress view")
            )
        }
        self = view
    }

    /// nil when `json` is not an object carrying a usable `rev`, `asOf` and a
    /// known `state` — an unknown state means a newer box, and an old-looking
    /// row is better than a wrong one.
    init?(json: JSONValue?) {
        guard let o = ChatJSON.object(json),
              let rev = Rev(json: o["rev"]),
              let asOf = Self.millis(o["asOf"]),
              let stateRaw = ChatJSON.string(o["state"]),
              let state = State(rawValue: stateRaw)
        else { return nil }
        self.init(
            rev: rev,
            asOf: asOf,
            state: state,
            headline: BackgroundJobProgressFormat.line(ChatJSON.string(o["headline"]) ?? "", limit: 120),
            steps: Steps(json: o["steps"]),
            bar: Self.unitFraction(o["bar"]),
            live: Live(json: o["live"]),
            startedAt: Self.millis(o["startedAt"]),
            endedAt: Self.millis(o["endedAt"]),
            lastProgressAt: Self.millis(o["lastProgressAt"]),
            ceilingAt: Self.millis(o["ceilingAt"]),
            milestones: (ChatJSON.array(o["milestones"]) ?? []).prefix(8).compactMap { Milestone(json: $0) },
            files: Files(json: o["files"]),
            usage: Usage(json: o["usage"]),
            model: Self.modelName(o["model"])
        )
    }

    fileprivate static func modelName(_ v: JSONValue?) -> String? {
        guard let raw = ChatJSON.string(v) else { return nil }
        let text = BackgroundJobProgressFormat.line(raw, limit: 80)
        return text.isEmpty ? nil : text
    }

    fileprivate static func millis(_ v: JSONValue?) -> Double? {
        guard let d = ChatJSON.number(v), d.isFinite else { return nil }
        return d
    }

    fileprivate static func unitFraction(_ v: JSONValue?) -> Double? {
        guard let d = ChatJSON.number(v), d.isFinite else { return nil }
        return min(1, max(0, d))
    }

    fileprivate static func count(_ v: JSONValue?) -> Int? {
        guard let d = ChatJSON.number(v), d.isFinite, d >= 0, d < 1_000_000_000 else { return nil }
        return Int(d)
    }
}

extension DelegateJobProgressView.Rev {
    init?(json: JSONValue?) {
        guard let o = ChatJSON.object(json),
              let epoch = DelegateJobProgressView.millis(o["epoch"]),
              let n = DelegateJobProgressView.millis(o["n"])
        else { return nil }
        self.init(epoch: epoch, n: n)
    }
}

extension DelegateJobProgressView.StepItem {
    init?(json: JSONValue?) {
        guard let o = ChatJSON.object(json),
              let raw = ChatJSON.string(o["text"]),
              let status = Status(rawValue: ChatJSON.string(o["status"]) ?? "")
        else { return nil }
        let text = BackgroundJobProgressFormat.line(raw, limit: 120)
        guard !text.isEmpty else { return nil }
        self.init(text: text, status: status)
    }
}

extension DelegateJobProgressView.Steps {
    init?(json: JSONValue?) {
        guard let o = ChatJSON.object(json),
              let total = DelegateJobProgressView.count(o["total"]), total >= 1,
              let done = DelegateJobProgressView.count(o["done"])
        else { return nil }
        let current = ChatJSON.string(o["current"]).map { BackgroundJobProgressFormat.line($0, limit: 120) }
        self.init(
            done: min(done, total),
            total: total,
            current: (current?.isEmpty ?? true) ? nil : current,
            items: (ChatJSON.array(o["items"]) ?? []).prefix(30).compactMap { DelegateJobProgressView.StepItem(json: $0) },
            grewAt: DelegateJobProgressView.millis(o["grewAt"])
        )
    }
}

extension DelegateJobProgressView.Live {
    init?(json: JSONValue?) {
        guard let o = ChatJSON.object(json),
              let tool = ChatJSON.string(o["tool"]),
              let startedAt = DelegateJobProgressView.millis(o["startedAt"])
        else { return nil }
        let name = BackgroundJobProgressFormat.line(tool, limit: 60)
        guard !name.isEmpty else { return nil }
        self.init(
            tool: name,
            target: BackgroundJobProgressFormat.line(ChatJSON.string(o["target"]) ?? "", limit: 120),
            startedAt: startedAt
        )
    }
}

extension DelegateJobProgressView.Milestone {
    init?(json: JSONValue?) {
        guard let o = ChatJSON.object(json),
              let at = DelegateJobProgressView.millis(o["at"]),
              let raw = ChatJSON.string(o["text"])
        else { return nil }
        let text = BackgroundJobProgressFormat.line(raw, limit: 160)
        guard !text.isEmpty else { return nil }
        self.init(at: at, text: text)
    }
}

extension DelegateJobProgressView.Files {
    /// An object whose `changed` is null/invalid is "unknown", not absent.
    init?(json: JSONValue?) {
        guard let o = ChatJSON.object(json) else { return nil }
        self.init(changed: DelegateJobProgressView.count(o["changed"]))
    }
}

extension DelegateJobProgressView.Usage {
    init?(json: JSONValue?) {
        guard let o = ChatJSON.object(json),
              let tokens = ChatJSON.number(o["tokens"]), tokens.isFinite, tokens >= 0
        else { return nil }
        var cost = ChatJSON.number(o["costUsd"])
        if let c = cost, !(c.isFinite && c >= 0) { cost = nil }
        var partial = false
        if case .bool(let b)? = o["costPartial"] { partial = b }
        self.init(tokens: tokens, costUsd: cost, costPartial: partial)
    }
}

// MARK: - Client clock (§5.3)

/// `skew = asOf − localNow` taken when a view is received; box-now is
/// `localNow + skew`. Elapsed, quiet time, time left and tool age are all derived
/// from it and tick locally — no view is needed for a second to pass.
struct JobViewClock: Equatable, Sendable {
    var skewMs: Double

    init(skewMs: Double) { self.skewMs = skewMs }

    init(asOf: Double, localNow: Date) {
        skewMs = asOf - localNow.timeIntervalSince1970 * 1000
    }

    func boxNowMs(_ localNow: Date) -> Double {
        localNow.timeIntervalSince1970 * 1000 + skewMs
    }
}

extension DelegateJobProgressView {
    /// Shown quiet-for only from this long without progress while running.
    static let quietThresholdMs: Double = 3 * 60_000
    /// Shown time-left only inside this window before the ceiling while running.
    static let timeLeftWindowMs: Double = 30 * 60_000
    /// "Plan grew" lasts this long after `steps.grewAt`.
    static let planGrewWindowMs: Double = 120_000

    /// `(endedAt ?? boxNow) − startedAt`, frozen at `endedAt`.
    func elapsedMs(_ clock: JobViewClock, now: Date) -> Double? {
        guard let startedAt else { return nil }
        return max(0, (endedAt ?? clock.boxNowMs(now)) - startedAt)
    }

    /// `boxNow − lastProgressAt`, only while running and ≥ 3 min.
    func quietMs(_ clock: JobViewClock, now: Date) -> Double? {
        guard isRunning, let lastProgressAt else { return nil }
        let quiet = clock.boxNowMs(now) - lastProgressAt
        return quiet >= Self.quietThresholdMs ? quiet : nil
    }

    /// `max(0, ceilingAt − boxNow)`, only while running and < 30 min.
    func timeLeftMs(_ clock: JobViewClock, now: Date) -> Double? {
        guard isRunning, let ceilingAt else { return nil }
        let left = max(0, ceilingAt - clock.boxNowMs(now))
        return left < Self.timeLeftWindowMs ? left : nil
    }

    func toolAgeMs(_ clock: JobViewClock, now: Date) -> Double? {
        guard let live else { return nil }
        return max(0, clock.boxNowMs(now) - live.startedAt)
    }

    func planGrew(_ clock: JobViewClock, now: Date) -> Bool {
        guard let grewAt = steps?.grewAt else { return false }
        return clock.boxNowMs(now) - grewAt < Self.planGrewWindowMs
    }
}

// MARK: - Text

enum BackgroundJobProgressFormat {
    /// Model text is plain text: first non-empty line only, trimmed, truncated
    /// with an ellipsis. No Markdown or HTML is interpreted anywhere it is shown.
    static func line(_ text: String, limit: Int) -> String {
        let first = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let trimmed = first.trimmingCharacters(in: .whitespaces)
        guard trimmed.count > limit else { return trimmed }
        return String(trimmed.prefix(max(0, limit - 1))) + "…"
    }

    /// "3/7".
    static func chip(_ steps: DelegateJobProgressView.Steps) -> String {
        "\(steps.done)/\(steps.total)"
    }

    /// The row's second text line: the model's headline, with the amber
    /// "Needs a decision" lead when the job is waiting on a person (running, or
    /// finished that way). nil → the caller shows the legacy `activity` line.
    struct HeadlineLine: Equatable, Sendable {
        var text: String
        var needsDecision: Bool
    }

    static func headlineLine(_ view: DelegateJobProgressView) -> HeadlineLine? {
        if view.needsDecision {
            let text = view.headline.isEmpty ? "Needs a decision" : "Needs a decision: \(view.headline)"
            return HeadlineLine(text: text, needsDecision: true)
        }
        guard !view.headline.isEmpty else { return nil }
        return HeadlineLine(text: view.headline, needsDecision: false)
    }

    /// The bar's fill: the box's `bar` when it sent one, else done/total; nil
    /// without steps (no bar is drawn).
    static func barFraction(_ view: DelegateJobProgressView) -> Double? {
        guard let steps = view.steps else { return nil }
        let fraction = view.bar ?? Double(steps.done) / Double(steps.total)
        return min(1, max(0, fraction))
    }

    static func duration(ms: Double) -> String {
        SessionTimerFormat.compact(max(0, ms) / 1000)
    }

    /// "now" → "just now"; otherwise "5m ago".
    static func ago(ms: Double) -> String {
        let age = SessionTimerFormat.age(max(0, ms) / 1000)
        return age == "now" ? "just now" : "\(age) ago"
    }

    static func filesChanged(_ files: DelegateJobProgressView.Files?) -> String? {
        guard let changed = files?.changed else { return nil }
        return changed == 1 ? "1 file changed" : "\(changed) files changed"
    }

    /// "12.4k tokens · $0.42". A cost marked partial is a lower bound ("$0.42+").
    static func usage(_ usage: DelegateJobProgressView.Usage?) -> String? {
        guard let usage else { return nil }
        var parts: [String] = []
        if usage.tokens > 0 { parts.append(TranscriptTurnFormat.tokens(usage.tokens)) }
        if let cost = usage.costUsd {
            var text = cost > 0 && cost < 0.01 ? "<$0.01" : "$" + String(format: "%.2f", cost)
            if usage.costPartial { text += "+" }
            parts.append(text)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    static func stateLabel(_ state: DelegateJobProgressView.State) -> String {
        switch state {
        case .working: return "Working"
        case .needsDecision: return "Needs a decision"
        case .done: return "Done"
        case .failed: return "Failed"
        case .stopped: return "Stopped"
        case .paused: return "Paused"
        }
    }
}

/// Everything the detail sheet shows, derived for one instant of the local clock.
struct BackgroundJobProgressDetail: Equatable, Sendable {
    struct MilestoneLine: Equatable, Sendable {
        var text: String
        var ago: String
    }

    var elapsed: String?
    var quiet: String?
    var timeLeft: String?
    var tool: String?
    var planGrew: Bool
    var files: String?
    var usage: String?
    var milestones: [MilestoneLine]

    init(view: DelegateJobProgressView, clock: JobViewClock, now: Date) {
        elapsed = view.elapsedMs(clock, now: now).map(BackgroundJobProgressFormat.duration(ms:))
        quiet = view.quietMs(clock, now: now).map { "Quiet for \(BackgroundJobProgressFormat.duration(ms: $0))" }
        timeLeft = view.timeLeftMs(clock, now: now).map(BackgroundJobProgressFormat.duration(ms:))
        if let live = view.live {
            let name = live.target.isEmpty ? live.tool : "\(live.tool): \(live.target)"
            let age = view.toolAgeMs(clock, now: now).map { " · \(BackgroundJobProgressFormat.duration(ms: $0))" } ?? ""
            tool = name + age
        } else {
            tool = nil
        }
        planGrew = view.planGrew(clock, now: now)
        files = BackgroundJobProgressFormat.filesChanged(view.files)
        usage = BackgroundJobProgressFormat.usage(view.usage)
        let boxNow = clock.boxNowMs(now)
        milestones = view.milestones.map {
            MilestoneLine(text: $0.text, ago: BackgroundJobProgressFormat.ago(ms: boxNow - $0.at))
        }
    }
}

// MARK: - Bus frame + rev rule (B4)

/// A `delegate.updated` frame: `{id, status, activity, view}`. Everything is
/// optional — an older box sends only `id` and `status`.
struct BackgroundJobUpdate: Equatable, Sendable {
    var id: String?
    var status: String?
    var activity: String?
    var view: DelegateJobProgressView?

    init(id: String? = nil, status: String? = nil, activity: String? = nil, view: DelegateJobProgressView? = nil) {
        self.id = id
        self.status = status
        self.activity = activity
        self.view = view
    }

    init(payload: JSONValue?) {
        let o = ChatJSON.object(payload)
        let id = ChatJSON.string(o?["id"])
        self.init(
            id: (id?.isEmpty ?? true) ? nil : id,
            status: ChatJSON.string(o?["status"]),
            activity: ChatJSON.string(o?["activity"]),
            view: DelegateJobProgressView(json: o?["view"])
        )
    }
}

/// Applying views to the job list: a view (from an event or a list response) is
/// taken only when its rev is newer than the one the job already holds; a late
/// or replayed one is ignored. The 10 s poll heals anything a patch missed.
enum BackgroundJobViewMerge {
    static func accepts(_ incoming: DelegateJobProgressView, over current: DelegateJobProgressView?) -> Bool {
        guard let current else { return true }
        return incoming.rev.isNewer(than: current.rev)
    }

    struct Merged: Equatable {
        var jobs: [DelegateJob]
        /// Jobs whose view was taken from the fetch (their clock must be re-based).
        var applied: Set<String>
    }

    /// A list response replaces the jobs; each keeps the view it already had when
    /// the fetched one is not newer. A fetched job with no view takes none (an
    /// older box, or the box no longer computes one).
    static func merge(existing: [DelegateJob], fetched: [DelegateJob]) -> Merged {
        let current = Dictionary(existing.map { ($0.id, $0.view) }, uniquingKeysWith: { _, last in last })
        var applied: Set<String> = []
        let jobs = fetched.map { job -> DelegateJob in
            guard let incoming = job.view else { return job }
            let held = current[job.id] ?? nil
            if accepts(incoming, over: held) {
                applied.insert(job.id)
                return job
            }
            var kept = job
            kept.view = held
            return kept
        }
        return Merged(jobs: jobs, applied: applied)
    }

    struct Patched: Equatable {
        var jobs: [DelegateJob]
        var appliedID: String?
        /// The list must be re-read: the id is unknown, the status changed
        /// (nesting may change), or the box sent no view to patch with.
        var needsRefetch: Bool
    }

    static func patch(_ jobs: [DelegateJob], with update: BackgroundJobUpdate) -> Patched {
        guard let id = update.id, let index = jobs.firstIndex(where: { $0.id == id }) else {
            return Patched(jobs: jobs, appliedID: nil, needsRefetch: true)
        }
        guard let view = update.view else {
            return Patched(jobs: jobs, appliedID: nil, needsRefetch: true)
        }
        var job = jobs[index]
        let statusChanged = update.status.map { $0 != job.status } ?? false
        guard accepts(view, over: job.view) else {
            return Patched(jobs: jobs, appliedID: nil, needsRefetch: statusChanged)
        }
        job.view = view
        if let activity = update.activity { job.activity = activity }
        var next = jobs
        next[index] = job
        return Patched(jobs: next, appliedID: id, needsRefetch: statusChanged)
    }
}
