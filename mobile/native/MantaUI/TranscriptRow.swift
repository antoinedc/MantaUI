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
// through UserBand / AssistantProse / StepGroupView. Only the container moved.
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
        case .steps(let content): return "s" + content.rows.map(\.id).joined(separator: "|")
        }
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

// MARK: - Cell

/// Renders ONE transcript block inside `TiledView`, reusing the same
/// `UserBand` / `AssistantProse` / `StepGroupView` components the rest of the
/// chat uses — this is not a parallel renderer.
///
/// The wall-clock timestamp gutter rides WITH the cell: an overlay parks it off
/// the trailing edge, and the `TranscriptGutterReveal` gesture (ported verbatim
/// from the legacy TranscriptView) slides the cell left to reveal it on a
/// leftward drag. Every TiledView surface shares this cell, so both the parent
/// chat and the subagent drill-in get the gutter with no per-screen code.
struct TranscriptBlockCell: TiledCellContent {
    typealias StateValue = Void

    let item: TranscriptRow
    let tokens: Tokens

    func body(context: CellContext<Void>) -> some View {
        TranscriptGutterReveal {
            transcriptBlockView(item.block, tokens: tokens)
                // The timestamp strip, drawn off-screen at rest (see
                // TranscriptComponents) and brought in by the reveal gesture.
                .overlay(alignment: .trailing) {
                    TimestampGutterLabel(
                        date: item.block.timestamp,
                        width: TranscriptGutter.gutterWidth,
                        tokens: tokens
                    )
                    .offset(x: TranscriptGutter.gutterWidth)
                    .allowsHitTesting(false)
                }
        }
    }
}

/// The ONE transcript block renderer, shared by every surface — the live
/// TiledView cell (`TranscriptBlockCell`) and the legacy `TranscriptView` the
/// capture fixture still uses. There is deliberately no second switch anywhere.
@ViewBuilder
func transcriptBlockView(_ block: TranscriptBlock, tokens: Tokens) -> some View {
    switch block {
    case .user(let text, _):
        UserBand(text: text, tokens: tokens)
            .padding(.bottom, Metrics.spacing.sp4)
    case .prose(let text, _):
        AssistantProse(text: text, tokens: tokens)
    case .steps(let content):
        // Machinery is inset to the same margin as prose. Only the USER
        // band is full-bleed (§8) — that edge-to-edge treatment is what
        // marks a turn boundary, so letting tool cards share it made every
        // step group read as a message.
        StepGroupView(content: content, tokens: tokens)
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.bottom, Metrics.spacing.sp3)
    }
}

/// Gutter geometry, defined ONCE and shared by the cell's reveal gesture and the
/// legacy TranscriptView (no duplicate constants).
enum TranscriptGutter {
    /// Width of the revealed timestamp strip / how far the cell slides.
    static let gutterWidth: CGFloat = 58
    /// Finger travel needed for a full reveal. Longer than the strip itself,
    /// so the strip arrives damped instead of slamming open on a flick.
    static let gutterTravel: CGFloat = 96
}

/// Applies the legacy swipe-to-reveal-timestamp gesture to a single cell,
/// ported VERBATIM from the old TranscriptView: same finger-travel threshold,
/// same offset math, same spring.
///
/// A wrapper View so the `@GestureState` lives in a SwiftUI-backed view — the
/// cell itself is a `TiledCellContent` (not a `View`), and `@GestureState`
/// needs real DynamicProperty storage. The gesture is simultaneous with the
/// scroll view's own pan and deliberately inert unless the movement is clearly
/// sideways and leftward, so neither gesture steals from the other.
struct TranscriptGutterReveal<Content: View>: View {
    private let content: Content

    /// Live drag offset, negative (leftward) and clamped to the strip width.
    /// `@GestureState` resets itself the instant the finger lifts, which is what
    /// springs the cell back with no release handler of our own.
    @GestureState private var gutterReveal: CGFloat = 0

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .offset(x: gutterReveal)
            .animation(.interactiveSpring(response: 0.28, dampingFraction: 0.86), value: gutterReveal)
            .simultaneousGesture(gutterGesture)
    }

    private var gutterGesture: some Gesture {
        DragGesture(minimumDistance: 16)
            .updating($gutterReveal) { value, state, _ in
                let dx = value.translation.width
                let dy = value.translation.height
                guard dx < 0, -dx > abs(dy) * 1.5 else {
                    state = 0
                    return
                }
                let progress = min(1, -dx / TranscriptGutter.gutterTravel)
                state = -TranscriptGutter.gutterWidth * progress
            }
    }
}
