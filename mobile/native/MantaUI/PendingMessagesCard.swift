import SwiftUI

// ===========================================================================
// The pending-messages card (OpenCode V2 next spec, Stage A-iOS).
//
// Pinned just above the composer while the box holds messages the user sent
// during a turn. One row per pending message: a badge — "Now" (the agent reads
// it at its next step) or "After this turn" — the text on a single line, and
// the row's actions: Wait / Send now (move it between the two) and × (cancel).
// Visual reference: docs/superpowers/specs/2026-10-23-opencode-v2-next/
// pending-messages-mockup.html, adapted to a phone: the badge, caption and
// actions share the first line so the message text keeps a whole line of its
// own.
//
// All content decisions (badge, caption, which actions, the stopped-agent
// footer) come from `PendingCardLogic` (pure, tested); this file only draws.
// ===========================================================================

struct PendingMessagesCard: View {
    let items: [InboxItem]
    let running: Bool
    /// Messages with an action in flight — their buttons are disabled.
    let busyIDs: Set<String>
    let tokens: Tokens
    let onSendNow: (String) -> Void
    let onWait: (String) -> Void
    let onCancel: (String) -> Void

    var body: some View {
        let rows = PendingCardLogic.rows(items: items, running: running)
        VStack(alignment: .leading, spacing: 0) {
            Text(PendingCardLogic.header(count: rows.count))
                .font(.manta(size: Metrics.type.xs, weight: .semibold))
                .foregroundColor(tokens.tx3)
                .padding(.horizontal, Metrics.spacing.sp3)
                .padding(.vertical, Metrics.spacing.sp2)
                .accessibilityIdentifier("pending-card-header")
            ForEach(rows) { row in
                Rectangle().fill(tokens.borderSubtle).frame(height: Metrics.spacing.spPx)
                rowView(row)
            }
            if PendingCardLogic.showsStoppedFooter(items: items, running: running) {
                Rectangle().fill(tokens.borderSubtle).frame(height: Metrics.spacing.spPx)
                Text(PendingCardLogic.stoppedFooter)
                    .font(.manta(size: Metrics.type.twoXS))
                    .foregroundColor(tokens.warn)
                    .padding(.horizontal, Metrics.spacing.sp3)
                    .padding(.vertical, Metrics.spacing.sp2)
                    .accessibilityIdentifier("pending-card-footer")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tokens.card, in: RoundedRectangle(cornerRadius: Metrics.radius.lg, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.radius.lg, style: .continuous)
                .stroke(tokens.border, lineWidth: Metrics.spacing.spPx)
        )
        .clipShape(RoundedRectangle(cornerRadius: Metrics.radius.lg, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pending-card")
    }

    private func rowView(_ row: PendingRowModel) -> some View {
        let busy = busyIDs.contains(row.id)
        return VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            HStack(spacing: Metrics.spacing.sp2) {
                badge(row.badge)
                if let caption = row.caption {
                    Text(caption)
                        .font(.manta(size: Metrics.type.twoXS))
                        .foregroundColor(tokens.tx4)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if row.offersWait {
                    Button { onWait(row.id) } label: {
                        Text("Wait")
                            .font(.manta(size: Metrics.type.xs))
                            .foregroundColor(tokens.tx3)
                            .padding(.horizontal, Metrics.spacing.sp2)
                            .padding(.vertical, Metrics.spacing.sp1)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Wait — send after this turn")
                    .accessibilityIdentifier("pending-wait")
                }
                if row.offersSendNow {
                    Button { onSendNow(row.id) } label: {
                        Text("Send now")
                            .font(.manta(size: Metrics.type.xs, weight: .semibold))
                            .foregroundColor(tokens.accentTx)
                            .padding(.horizontal, Metrics.spacing.sp2)
                            .padding(.vertical, Metrics.spacing.sp1)
                            .background(tokens.accentSoft, in: Capsule())
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("pending-send-now")
                }
                Button { onCancel(row.id) } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: Metrics.type.xs, weight: .semibold))
                        .foregroundColor(tokens.tx4)
                        .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Cancel this message")
                .accessibilityIdentifier("pending-cancel")
            }
            HStack(spacing: Metrics.spacing.sp1) {
                Text(row.text.isEmpty ? " " : row.text)
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx1)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if row.attachmentCount > 0 {
                    Image(systemName: "paperclip")
                        .font(.system(size: Metrics.type.xs))
                        .foregroundColor(tokens.tx4)
                    Text("\(row.attachmentCount)")
                        .font(.manta(size: Metrics.type.twoXS))
                        .foregroundColor(tokens.tx4)
                }
            }
        }
        .padding(.leading, Metrics.spacing.sp3)
        .padding(.trailing, Metrics.spacing.sp1)
        .padding(.vertical, Metrics.spacing.sp1)
        .opacity(busy ? 0.5 : 1)
        .disabled(busy)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pending-row-\(row.id)")
    }

    @ViewBuilder
    private func badge(_ badge: PendingRowModel.Badge) -> some View {
        switch badge {
        case .now:
            Text("Now")
                .font(.manta(size: Metrics.type.twoXS, weight: .semibold))
                .foregroundColor(tokens.accentTx)
                .padding(.horizontal, Metrics.spacing.sp2)
                .padding(.vertical, 1)
                .background(tokens.accentSoft, in: Capsule())
        case .afterThisTurn:
            neutralBadge("After this turn")
        case .other(let raw):
            neutralBadge(raw.isEmpty ? "Pending" : raw)
        }
    }

    private func neutralBadge(_ label: String) -> some View {
        Text(label)
            .font(.manta(size: Metrics.type.twoXS, weight: .semibold))
            .foregroundColor(tokens.tx3)
            .padding(.horizontal, Metrics.spacing.sp2)
            .padding(.vertical, 1)
            .background(tokens.fill, in: Capsule())
            .overlay(Capsule().stroke(tokens.border, lineWidth: Metrics.spacing.spPx))
    }
}
