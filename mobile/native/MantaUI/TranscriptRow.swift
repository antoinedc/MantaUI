import SwiftUI
import MessagingUI

// ===========================================================================
// MessagingUI transcript surface (TiledView).
//
// The chat transcript's SCROLL layer used to be hand-rolled — ScrollViewReader +
// LazyVStack + two onGeometryChange observers + keyboard notifications + a
// "don't fight the user" landing flag. That was the source of the device-only
// blank-on-open, the keyboard snap, and the disappear-on-scroll bugs. This file
// is the replacement: it adapts the transcript to MessagingUI's `TiledView` (a
// UICollectionView-backed chat container) which owns smooth bottom-follow,
// keyboard/safe-area handling, and prepend-without-jump for us.
//
// The CONTENT rendering is deliberately unchanged: each block still renders
// through UserBand / MantaProse / StepGroupView. Only the container moved.
// ===========================================================================

/// A transcript block wrapped with a STABLE identity for `TiledView`.
///
/// `TiledView` needs `Identifiable` items with stable ids to recycle cells and
/// follow the tail without jumping. `ChatSessionStore` recomputes its blocks at
/// every turn boundary — the canonical blocks from a refetch plus a streaming
/// `.prose` tail — so the id must survive that recompute.
struct TranscriptRow: Identifiable, Equatable {
    let id: String
    let block: TranscriptBlock
}

extension TranscriptBlock {
    /// A content-stable id.
    ///
    /// A completed block's content never changes after its turn, so this id
    /// survives a refetch unchanged. The STREAMING tail is different: its text
    /// grows every delta, so `ChatSessionStore` gives it a store-owned id
    /// instead of this one (see `streamingTailID`).
    var stableScrollID: String {
        switch self {
        case .user(let text, let at):
            // `text.hashValue` is process-stable, which is all scroll identity
            // needs — embedding the whole text made ids huge for long prose and
            // let two identical texts sharing a timestamp collide.
            return "u\(text.hashValue)@\(at?.timeIntervalSince1970 ?? 0)"
        case .prose(let text, let at):
            return "p\(text.hashValue)@\(at?.timeIntervalSince1970 ?? 0)"
        case .file(let attachment):
            return "f" + attachmentIdentity(attachment)
        // The FIRST row's id, not all of them joined. A step group grows by APPENDING
        // rows, so the first row's id is fixed for the life of the group while a
        // concatenation changes on every new step — which made the diff see a
        // different row and delete + re-insert the whole group per tool call. Same
        // stable-identity treatment `ToolStep.id` already gets (see the comment on
        // `ToolStep.id`), applied to the group that contains them.
        //
        // Two step groups can never collide: a row id is a tool callID (or the
        // part id), unique per call. An empty group falls back to a constant, and
        // `uniqueTranscriptRows` suffixes any duplicate anyway.
        case .steps(let content): return "s" + (content.rows.first?.id ?? "empty")
        case .notice(let text, let kind): return "n\(kind)\(text.hashValue)"
        case .queuedPrompt(let prompt): return "pending-\(prompt.id)"
        // Cards key on the REQUEST id — stable and unique. Do NOT hash content:
        // a card whose text is edited mid-flight would change identity and cause
        // a delete+insert in the list. The prefixes are distinct so a question
        // and a plan-exit question carrying the same id never collide (BET-1214).
        case .permission(let p): return "pm" + p.id
        case .planExit(let q): return "px" + q.id
        case .question(let q): return "qq" + q.id
        }
    }
}

/// A content-stable identity for an attachment block, unique across the
/// attachment kinds. Used by `stableScrollID` so a `.file` row survives a
/// refetch unchanged.
private func attachmentIdentity(_ attachment: TranscriptAttachment) -> String {
    switch attachment.kind {
    case .voiceNote(let note): return "voice:\(note.id)"
    }
}

/// Wraps blocks in rows whose ids are GUARANTEED unique within the array.
///
/// `stableScrollID` is content-derived, and wire content is allowed to repeat:
/// two identical prose parts completing at the same message timestamp, two
/// identical user prompts with a missing `time.created`, a re-emitted tool
/// callID — all yield the same id. MessagingUI's `ListDataSource.apply` builds
/// `Dictionary(uniqueKeysWithValues:)` over row ids on its diff path, which
/// TRAPS on a duplicate. The first fetch takes the no-check replace shortcut,
/// so duplicates living in older history only enter the diff when
/// `loadEarlier()` widens the window — i.e. the app crashed exactly when
/// scrolling up after loading previous messages.
///
/// Dedup is positional: the first occurrence keeps the bare id, later ones get
/// an occurrence suffix. Deterministic for a given block order, so a refetch of
/// the same window reproduces the same ids and the diff stays stable.
func uniqueTranscriptRows(_ blocks: [TranscriptBlock]) -> [TranscriptRow] {
    var seen: [String: Int] = [:]
    return blocks.map { block in
        let base = block.stableScrollID
        let occurrence = seen[base, default: 0]
        seen[base] = occurrence + 1
        return TranscriptRow(id: occurrence == 0 ? base : "\(base)#dup\(occurrence)", block: block)
    }
}

extension StepGroupContent {
    /// The rows of a step group, whether plain or rolled up. Used only to
    /// derive a stable id from the rows' own stable ids.
    var rows: [StepGroupRow] {
        switch self {
        case .rows(let r): return r
        case .rollup(_, let r): return r
        }
    }
}

/// The callbacks + context the blocking cards need when they render inside the
/// transcript tail (BET-1214). The cards' behaviour, copy and callbacks are
/// unchanged from the pinned-above-composer era — only their LOCATION moved, so
/// this type carries the same closures ChatScreen used to hand the cards
/// directly.
///
/// A `@MainActor final class` (not a struct): it holds main-actor-bound closures
/// that touch a `@MainActor` store, and the transcript cell's `body(context:)`
/// is required by `TiledCellContent` to be `nonisolated`, so the card actions
/// are delivered through the SwiftUI environment — an actor-isolated reference
/// type is implicitly `Sendable`, which is exactly what an `EnvironmentKey`
/// `static` default and a cross-view round-trip need, while everything reads the
/// closures on the main actor only.
@MainActor
final class TranscriptCardActions {
    /// The raw transcript the plan card's exact derivation reads.
    let messages: [OpencodeMessage]
    /// The session's BUILD-model name for the plan card's subtitle.
    let buildModelName: String
    /// The deterministic plan-page URL (nil when no usable slug can be formed).
    let planURL: String?
    let onPermissionReply: (PermissionRequest, PermissionReply) -> Void
    let onQuestionSubmit: (QuestionRequest, [[String]]) -> Void
    let onQuestionReject: (QuestionRequest) -> Void
    let onBuildHere: (QuestionRequest, String) -> Void
    let onKeepPlanning: (QuestionRequest, String) -> Void
    let onOpenPage: () -> Void

    init(
        messages: [OpencodeMessage],
        buildModelName: String,
        planURL: String?,
        onPermissionReply: @escaping (PermissionRequest, PermissionReply) -> Void,
        onQuestionSubmit: @escaping (QuestionRequest, [[String]]) -> Void,
        onQuestionReject: @escaping (QuestionRequest) -> Void,
        onBuildHere: @escaping (QuestionRequest, String) -> Void,
        onKeepPlanning: @escaping (QuestionRequest, String) -> Void,
        onOpenPage: @escaping () -> Void
    ) {
        self.messages = messages
        self.buildModelName = buildModelName
        self.planURL = planURL
        self.onPermissionReply = onPermissionReply
        self.onQuestionSubmit = onQuestionSubmit
        self.onQuestionReject = onQuestionReject
        self.onBuildHere = onBuildHere
        self.onKeepPlanning = onKeepPlanning
        self.onOpenPage = onOpenPage
    }
}

/// The environment key carrying the blocking-card actions into transcript cells.
private struct TranscriptCardActionsKey: EnvironmentKey {
    static let defaultValue: TranscriptCardActions? = nil
}

extension EnvironmentValues {
    /// The blocking-card callbacks for the current transcript surface, or nil
    /// on read-only surfaces (subagent drill-in, capture fixture) where cards
    /// render inert.
    var transcriptCardActions: TranscriptCardActions? {
        get { self[TranscriptCardActionsKey.self] }
        set { self[TranscriptCardActionsKey.self] = newValue }
    }
}

// MARK: - Cell

/// Renders ONE transcript block inside `TiledView`, reusing the same
/// `UserBand` / `MantaProse` / `StepGroupView` components the rest of the
/// chat uses — this is not a parallel renderer.
///
/// The wall-clock timestamp gutter rides WITH the cell: an overlay parks it off
/// the trailing edge, and MessagingUI's own reveal offset (driven off the cell's
/// `context.cellReveal`, from the library's pan recogniser integrated with the
/// scroll pan) slides the cell left to reveal it on a leftward drag. Every
/// TiledView surface shares this cell, so both the parent chat and the subagent
/// drill-in get the gutter with no per-screen code.
struct TranscriptBlockCell: TiledCellContent {
    typealias StateValue = Void

    let item: TranscriptRow
    let tokens: Tokens
    /// User-initiated retry of a failed pending prompt, threaded down from the
    /// store-owning transcript surface. `@MainActor` (hence Sendable) so it can
    /// cross the cell's nonisolated `body` legally; invoked only on the main
    /// actor (inside `TranscriptCellReveal.body`).
    let onRetry: @MainActor (String) -> Void

    func body(context: CellContext<Void>) -> some View {
        // The reveal offset now comes from MessagingUI's OWN pan recogniser, which
        // is installed on the collection view and declares simultaneous recognition
        // with its scroll pan. The SwiftUI DragGesture this replaces did not, and
        // competed with the scroll view for the initiating touch — the "transcript
        // needs a second swipe" bug.
        //
        // `CellReveal` is @MainActor-isolated and `body(context:)` here must stay
        // nonisolated (Swift 6 rejects main-actor isolation on a nonisolated
        // protocol conformance as a data-race), so the main-actor reveal state is
        // passed down to `TranscriptCellReveal`, whose own `View.body` runs on the
        // main actor and can read `rubberbandedOffset(max:)`.
        //
        // The blocking-card actions are NOT threaded through this nonisolated
        // body — a closure-carrying value can't cross it. They arrive via the
        // SwiftUI environment and are read inside `TranscriptCellReveal.body`
        // (main actor) (BET-1214).
        TranscriptCellReveal(
            cellReveal: context.cellReveal,
            item: item,
            tokens: tokens,
            onRetry: onRetry
        )
    }
}

/// Applies MessagingUI's reveal offset to a transcript cell. A plain `View`
/// (NOT `@MainActor`-declared, so its init stays nonisolated and callable from
/// the cell's nonisolated `body`) whose `body` reads the main-actor reveal
/// state legally — SwiftUI's `View.body` is `@MainActor`.
private struct TranscriptCellReveal: View {
    let cellReveal: CellReveal?
    let item: TranscriptRow
    let tokens: Tokens
    /// User-initiated retry of a failed pending prompt; `@MainActor` (Sendable)
    /// so it crosses the nonisolated cell boundary, read only on the main actor
    /// here.
    let onRetry: @MainActor (String) -> Void
    /// The blocking-card callbacks, injected by the enclosing chat screen via
    /// `.environment(\.transcriptCardActions, …)` — read only on the main actor
    /// here, so it never crosses the nonisolated cell boundary. Nil on
    /// read-only surfaces (subagent drill-in, capture fixture).
    @Environment(\.transcriptCardActions) private var cardActions

    var body: some View {
        let reveal = cellReveal?.rubberbandedOffset(max: TranscriptGutter.gutterWidth) ?? 0

        return cellContent
            .offset(x: -reveal)
            .overlay(alignment: .trailing) {
                TimestampGutterLabel(
                    date: item.block.timestamp,
                    width: TranscriptGutter.gutterWidth,
                    tokens: tokens
                )
                .offset(x: TranscriptGutter.gutterWidth - reveal)
                .allowsHitTesting(false)
            }
            // A stable per-row accessibility handle so a UI test can drive the
            // reveal gesture on ONE specific row (and observe the timestamp
            // strip). This only groups the row for accessibility — it does not
            // add, disable or otherwise alter MessagingUI's reveal recogniser
            // and does not change TranscriptGutter.gutterWidth.
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(TranscriptGutter.rowAccessibilityID)
    }

    @MainActor
    @ViewBuilder
    private var cellContent: some View {
        if case .prose(let text, nil) = item.block {
            LiveProseTail(text: text, tokens: tokens)
        } else {
            transcriptBlockView(item.block, tokens: tokens, cards: cardActions, onRetry: onRetry)
        }
    }
}

/// The ONE transcript block renderer, shared by every surface — the live
/// TiledView cell (`TranscriptBlockCell`) and the legacy `TranscriptView` the
/// capture fixture still uses. There is deliberately no second switch anywhere.
///
/// `@MainActor`: the blocking cards are main-actor views whose callbacks touch a
/// `@MainActor` store, and the cards' closures are not `Sendable` — so this
/// function must run on the main actor (both callers are `@MainActor`
/// `View.body`s). The card actions come from `cards` (nil on read-only
/// surfaces → the cards render inert, never wiring to a live store).
@MainActor
@ViewBuilder
func transcriptBlockView(_ block: TranscriptBlock, tokens: Tokens, cards: TranscriptCardActions? = nil, onRetry: @escaping @MainActor (String) -> Void = { _ in }) -> some View {
    // The inert action set a read-only surface falls back to: every card
    // renders harmlessly but no closure reaches a live store.
    let actions = cards ?? TranscriptCardActions(
        messages: [],
        buildModelName: "",
        planURL: nil,
        onPermissionReply: { _, _ in },
        onQuestionSubmit: { _, _ in },
        onQuestionReject: { _ in },
        onBuildHere: { _, _ in },
        onKeepPlanning: { _, _ in },
        onOpenPage: {}
    )
    switch block {
    case .user(let text, _):
        UserBand(text: text, tokens: tokens)
            .padding(.bottom, Metrics.spacing.sp4)
    case .prose(let text, _):
        MantaProse(text: text, tokens: tokens)
    case .file(let attachment):
        // The voice-note player sits directly under the user band it belongs
        // to: 12px horizontal, 14px below. Image and generic-file rendering are
        // deliberately not implemented yet — the `.file` case only renders the
        // voice-note flavour (see `attachmentView`).
        attachmentView(attachment, tokens: tokens)
    case .steps(let content):
        // Machinery is inset to the same margin as prose. Only the USER
        // band is full-bleed (§8) — that edge-to-edge treatment is what
        // marks a turn boundary, so letting tool cards share it made every
        // step group read as a message.
        StepGroupView(content: content, tokens: tokens)
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.bottom, Metrics.spacing.sp3)
    case .notice(let text, let kind):
        SystemNoticeView(text: text, kind: kind, tokens: tokens)
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.bottom, Metrics.spacing.sp3)
    case .queuedPrompt(let prompt):
        // A dim ghost user bubble while the send is waiting/sending (the
        // message will land here once delivered) — flipped to a full-strength
        // bubble with a tap-to-retry beneath once the send has failed.
        switch prompt.state {
        case .waiting, .sending:
            UserBand(text: prompt.text, tokens: tokens)
                .opacity(0.45)
                .padding(.bottom, Metrics.spacing.sp4)
        case .failed:
            VStack(alignment: .leading, spacing: 0) {
                UserBand(text: prompt.text, tokens: tokens)
                Button {
                    onRetry(prompt.id)
                } label: {
                    HStack(spacing: Metrics.spacing.sp2) {
                        Image(systemName: "arrow.clockwise")
                        Text("Couldn't send — tap to retry")
                    }
                    .font(.manta(size: Metrics.type.twoXS))
                    .foregroundColor(tokens.danger)
                }
                .buttonStyle(.plain)
                .padding(.horizontal, Metrics.spacing.sp3)
                .padding(.bottom, Metrics.spacing.sp4)
                .accessibilityIdentifier("pending-prompt-retry")
            }
        }
    case .permission(let permission):
        PermissionCard(permission: permission, tokens: tokens) { reply in
            actions.onPermissionReply(permission, reply)
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.bottom, Metrics.spacing.sp3)
    case .planExit(let question):
        PlanCard(
            question: question,
            messages: actions.messages,
            buildModelName: actions.buildModelName,
            planURL: actions.planURL,
            tokens: tokens,
            onBuildHere: { feedback in actions.onBuildHere(question, feedback) },
            onKeepPlanning: { feedback in actions.onKeepPlanning(question, feedback) },
            onOpenPage: actions.onOpenPage
        )
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.bottom, Metrics.spacing.sp3)
    case .question(let question):
        QuestionCard(question: question, tokens: tokens) { answers in
            actions.onQuestionSubmit(question, answers)
        } onReject: {
            actions.onQuestionReject(question)
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.bottom, Metrics.spacing.sp3)
    }
}

/// Render a `.file` attachment block. ONLY the voice-note flavour renders — an
/// image or generic-file part is deliberately NOT implemented yet (BET-1029);
/// it would return nothing here, exactly as it did before this case existed.
@ViewBuilder
private func attachmentView(_ attachment: TranscriptAttachment, tokens: Tokens) -> some View {
    switch attachment.kind {
    case .voiceNote(let note):
        VoiceNotePlayerRow(note: note, tokens: tokens)
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.bottom, Metrics.spacing.sp4)
    }
}

/// A system notice (session error / truncation) inline at the end of the turn
/// it belongs to. It scrolls WITH that turn — replacing the pinned notice row
/// that used to float above the composer and detach from the turn.
struct SystemNoticeView: View {
    let text: String
    let kind: SystemNotice
    let tokens: Tokens

    var body: some View {
        let color = kind == .error ? tokens.danger : tokens.warn
        HStack(spacing: Metrics.spacing.sp2) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: Metrics.type.xs, weight: .semibold))
                .foregroundColor(color)
            Text(text)
                .font(.manta(size: Metrics.type.xs))
                .foregroundColor(color)
                .lineLimit(3)
            Spacer(minLength: 0)
        }
        .padding(Metrics.spacing.sp2)
        .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("system-notice")
    }
}

/// Gutter geometry, defined ONCE and shared by the cell's reveal offset and the
/// legacy TranscriptView (no duplicate constants).
enum TranscriptGutter {
    /// Width of the revealed timestamp strip / how far the cell slides.
    static let gutterWidth: CGFloat = 58
    /// Finger travel needed for a full reveal. Longer than the strip itself,
    /// so the strip arrives damped instead of slamming open on a flick.
    static let gutterTravel: CGFloat = 96
    /// Accessibility id on every transcript row, exposed so a gesture-driving
    /// UI test can target one row (and read its timestamp strip) deterministically.
    static let rowAccessibilityID = "transcript-row"
}
