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
struct TranscriptBlockCell: TiledCellContent {
    typealias StateValue = Void

    let item: TranscriptRow
    let tokens: Tokens

    func body(context: CellContext<Void>) -> some View {
        blockView(item.block)
            // The wall-clock timestamp gutter, exactly as the previous
            // TranscriptView drew it per block (see TranscriptComponents).
            .overlay(alignment: .trailing) {
                TimestampGutterLabel(
                    date: item.block.timestamp,
                    width: TranscriptBlockCell.gutterWidth,
                    tokens: tokens
                )
                .offset(x: TranscriptBlockCell.gutterWidth)
                .allowsHitTesting(false)
            }
    }

    @ViewBuilder
    private func blockView(_ block: TranscriptBlock) -> some View {
        switch block {
        case .user(let text, _):
            UserBand(text: text, tokens: tokens)
                .padding(.bottom, Metrics.spacing.sp4)
        case .prose(let text, _):
            AssistantProse(text: text, tokens: tokens)
        case .steps(let content):
            StepGroupView(content: content, tokens: tokens)
                .padding(.horizontal, Metrics.spacing.sp3)
                .padding(.bottom, Metrics.spacing.sp3)
        }
    }

    /// How far the timestamp strip reaches, matching the old TranscriptView.
    private static let gutterWidth: CGFloat = 58
}
