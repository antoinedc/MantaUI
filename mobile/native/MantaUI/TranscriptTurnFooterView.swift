import SwiftUI

// ===========================================================================
// WS01 F4 + F6 — the footer under a finished turn.
//
//   <mark> Pondered for 1m44s · 12.4k tokens   ⚠ truncated (output limit)   ⋯
//
// The summary and the truncation pill are F4 (desktop `MessageRow` footer). The
// trailing "⋯" is the turn's reply menu (F6): Quote, Quote in new session and
// Select text…. A tap opens it, so long-press and native text selection are
// untouched. Only a footer with `isTurnEnd == true` has the menu — a
// warning-only footer (a mid-turn warning, or a turn still running) has no
// reply text to act on.
// ===========================================================================

struct TranscriptTurnFooterView: View {
    let footer: TranscriptTurnFooter
    let tokens: Tokens
    /// nil on a surface that cannot quote (the subagent drill-in).
    let onQuote: ((String, QuoteDestination) -> Void)?

    @State private var showHint = false
    @State private var showSelect = false

    private var menuItems: [TranscriptReplyMenuModel.Item] {
        guard footer.isTurnEnd else { return [] }
        return TranscriptReplyMenuModel.items(canQuote: onQuote != nil, turnText: footer.turnText)
    }

    var body: some View {
        let items = menuItems
        HStack(spacing: Metrics.spacing.sp2) {
            if let summary = footer.summary {
                MantaLogoMark(size: 12)
                    .accessibilityHidden(true)
                Text(summary)
                    .font(.manta(size: Metrics.type.xs))
                    .foregroundColor(tokens.tx3)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            if let kind = footer.truncation {
                if footer.summary != nil {
                    Text("\u{00B7}")
                        .font(.manta(size: Metrics.type.xs))
                        .foregroundColor(tokens.tx3)
                }
                truncationPill(kind)
            }
            Spacer(minLength: 0)
            if !items.isEmpty {
                replyMenu(items)
            }
        }
        // Never a zero-height cell (a degenerate size in a self-sizing list).
        .frame(minHeight: items.isEmpty ? 1 : 44)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("transcript-turn-footer")
        .sheet(isPresented: $showSelect) {
            TranscriptSelectTextSheet(text: footer.turnText, tokens: tokens, onQuote: onQuote)
        }
    }

    /// The warning pill. It never truncates; a tap explains what to do.
    private func truncationPill(_ kind: TranscriptTruncationKind) -> some View {
        let description = TranscriptTruncation.describe(kind)
        return Button { showHint = true } label: {
            HStack(spacing: Metrics.spacing.sp1) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: Metrics.type.twoXS))
                Text(description.label)
                    .font(.manta(size: Metrics.type.xs))
                    .lineLimit(1)
                    .fixedSize()
            }
            .foregroundColor(tokens.warn)
            .padding(.horizontal, Metrics.spacing.sp2)
            .padding(.vertical, Metrics.spacing.sp1)
            .background(tokens.warn.opacity(0.12), in: RoundedRectangle(cornerRadius: Metrics.radius.xs))
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.radius.xs)
                    .stroke(tokens.warn.opacity(0.33), lineWidth: Metrics.spacing.spPx)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(description.label)
        .accessibilityHint("Shows what to do")
        .popover(isPresented: $showHint) {
            Text(description.hint)
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.tx1)
                .padding(Metrics.spacing.sp3)
                .frame(maxWidth: 320, alignment: .leading)
                .presentationCompactAdaptation(.popover)
        }
    }

    private func replyMenu(_ items: [TranscriptReplyMenuModel.Item]) -> some View {
        Menu {
            ForEach(items, id: \.self) { item in
                Button(title(of: item), systemImage: icon(of: item)) { perform(item) }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: Metrics.type.small, weight: .medium))
                .foregroundColor(tokens.tx4)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Reply actions")
        .accessibilityIdentifier("transcript-reply-menu")
    }

    private func title(of item: TranscriptReplyMenuModel.Item) -> String {
        switch item {
        case .quote: return "Quote"
        case .quoteNewSession: return "Quote in new session"
        case .selectText: return "Select text…"
        }
    }

    private func icon(of item: TranscriptReplyMenuModel.Item) -> String {
        switch item {
        case .quote: return "text.quote"
        case .quoteNewSession: return "plus.bubble"
        case .selectText: return "selection.pin.in.out"
        }
    }

    private func perform(_ item: TranscriptReplyMenuModel.Item) {
        switch item {
        case .quote: onQuote?(footer.turnText, .thisSession)
        case .quoteNewSession: onQuote?(footer.turnText, .newSession)
        case .selectText: showSelect = true
        }
    }
}
