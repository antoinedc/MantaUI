import SwiftUI

// ===========================================================================
// BET-824 — the two meter sheets + the shared band ring.
//
// Each meter's control opens the sheet for the thing it represents — never a
// combined sheet: a context strip that opened a plan sheet would put a
// "Compact" button in front of someone who tapped a quota indicator. The
// context sheet is one subject (this conversation + its two remedies); the
// usage sheet is the other (the plan, whose only remedy is time, so it offers
// no action).
// ===========================================================================

/// The bare band-coloured ring used by the composer dot, the usage-sheet rows
/// and the weekly banner. 13pt / 2.5pt stroke by default; colour only — no
/// percentage, no label, ever.
struct MeterRing: View {
    let color: Color
    var diameter: CGFloat = 13
    var lineWidth: CGFloat = 2.5

    var body: some View {
        Circle()
            .stroke(color, lineWidth: lineWidth)
            .frame(width: diameter, height: diameter)
    }

    static func tint(_ band: MeterBand, _ tokens: Tokens) -> Color {
        switch band {
        case .ok: return tokens.ok
        case .warn: return tokens.warn
        case .danger: return tokens.danger
        }
    }
}

// MARK: - Context sheet

/// The sheet behind the context strip: this conversation's fill, the segmented
/// breakdown the box already sends, the stale-cache warning, and the two
/// remedies that actually apply (compact / clear). Nothing about the
/// subscription appears here.
struct ContextSheet: View {
    let context: StreamContextPayload
    let cache: StreamCachePayload?
    let limit: Double?
    let modelName: String
    let bandColor: Color
    let tokens: Tokens
    let onCompact: () -> Void
    let onClear: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
            header
            segmentedMeter
            if cache?.isStale == true {
                staleLine
            }
            actions
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp4)
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }

    /// Big percentage in the band colour + "824k of 1M · Opus 4.7".
    private var header: some View {
        HStack(alignment: .baseline, spacing: Metrics.spacing.sp2) {
            Group {
                Text("\(Int(context.pct.rounded()))")
                    .font(.system(size: Metrics.type.display, weight: .bold))
                Text("%")
                    .font(.manta(size: Metrics.type.body, weight: .bold))
            }
            .foregroundColor(bandColor)
            Text("\(UsageMeters.formatTokens(context.totalInput)) of \(UsageMeters.formatTokens(limit)) · \(modelName)")
                .font(.manta(size: Metrics.type.xs))
                .foregroundColor(tokens.tx4)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    /// The segmented meter: fresh input (accent), cache-written (warn),
    /// cache-read (info) — the box-computed per-segment percentages, whose
    /// sum is the overall fill.
    private var segmentedMeter: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            GeometryReader { geo in
                let w = geo.size.width
                HStack(spacing: 0) {
                    segment(tokens.accent, pct: segmentPct("fresh"), width: w)
                    segment(tokens.warn, pct: segmentPct("cacheWrite"), width: w)
                    segment(tokens.info, pct: segmentPct("cacheRead"), width: w)
                    Spacer(minLength: 0)
                }
                .frame(height: 8)
                .background(tokens.fill, in: RoundedRectangle(cornerRadius: Metrics.radius.full))
            }
            .frame(height: 8)
            HStack(spacing: Metrics.spacing.sp2) {
                legend("fresh", UsageMeters.formatTokens(context.freshInput), color: tokens.accent)
                legend("written", UsageMeters.formatTokens(context.cacheWrite), color: tokens.warn)
                legend("cached", UsageMeters.formatTokens(context.cacheRead), color: tokens.info)
                Spacer(minLength: 0)
            }
            .font(.manta(size: Metrics.type.twoXS))
            .foregroundColor(tokens.tx4)
        }
    }

    private func segment(_ color: Color, pct: Double, width: CGFloat) -> some View {
        Rectangle()
            .fill(color)
            .frame(width: max(0, width * (pct / 100)))
    }

    private func legend(_ label: String, _ tokensText: String, color: Color) -> some View {
        HStack(spacing: Metrics.spacing.sp1) {
            Text("■")
                .font(.system(size: Metrics.type.twoXS, weight: .bold))
                .foregroundColor(color)
            Text("\(label) \(tokensText)")
        }
    }

    private func segmentPct(_ kind: String) -> Double {
        context.segments.first { $0.kind == kind }?.pct ?? 0
    }

    /// "Idle 1h 12m — the cache has gone cold. Clearing now saves re-billing
    /// 584k tokens." — driven by idleMs + staleTokens.
    @ViewBuilder
    private var staleLine: some View {
        if let cache, cache.isStale {
            Text("Idle \(idleText(cache.idleMs)) — the cache has gone cold. Clearing now saves re-billing \(UsageMeters.formatTokens(cache.staleTokens)) tokens.")
                .font(.manta(size: Metrics.type.xs))
                .foregroundColor(tokens.warn)
        }
    }

    /// The two remedies: compact the conversation, or start a fresh session.
    /// Both wire to existing session plumbing — nothing new.
    private var actions: some View {
        VStack(spacing: 0) {
            actionRow("Compact conversation", systemImage: "arrow.triangle.2.circlepath", onTap: onCompact)
            Divider()
            actionRow("Start a fresh session", systemImage: "plus.circle", onTap: onClear)
        }
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.radius.lg)
                .stroke(tokens.borderSubtle, lineWidth: Metrics.spacing.spPx)
        )
    }

    private func actionRow(_ title: String, systemImage: String, onTap: @escaping () -> Void) -> some View {
        Button(action: { dismiss(); onTap() }) {
            HStack(spacing: Metrics.spacing.sp2) {
                Image(systemName: systemImage)
                    .font(.system(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.accentTx)
                Text(title)
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.tx1)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: Metrics.type.xs))
                    .foregroundColor(tokens.tx4)
            }
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.vertical, Metrics.spacing.sp3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func idleText(_ ms: Double) -> String {
        let total = Int(ms / 1000)
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        if hours >= 1 { return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h" }
        return "\(max(1, minutes))m"
    }
}

// MARK: - Usage sheet

/// The sheet behind the usage dot: the plan, two windows, session first. No
/// actions — the only remedy is time, so offering a button would be a lie.
struct UsageSheet: View {
    let snapshots: [UsageSnapshot]
    let lastFetch: Date?
    let tokens: Tokens

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
            HStack {
                Text("Claude plan")
                    .font(.manta(size: Metrics.type.body, weight: .bold))
                    .foregroundColor(tokens.tx1)
                Spacer(minLength: 0)
                Button("Done") { dismiss() }
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.accentTx)
            }
            .padding(.bottom, Metrics.spacing.sp1)
            if let session = UsageMeters.sessionWindow(snapshots) {
                UsageWindowRow(window: session, name: "Session", caption: "5-hour window", tokens: tokens)
            }
            if let weekly = UsageMeters.weeklyWindow(snapshots) {
                UsageWindowRow(window: weekly, name: "Weekly", caption: "7-day window", tokens: tokens)
            }
            footer
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp4)
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }

    private var footer: some View {
        Text("Updated \(updatedAgo) · the dot tracks the 5-hour window.")
            .font(.manta(size: Metrics.type.twoXS))
            .foregroundColor(tokens.tx4)
    }

    /// "2m ago" from `lastFetch`; "just now" when missing or fresh.
    private var updatedAgo: String {
        guard let lastFetch else { return "just now" }
        let minutes = Int(Date().timeIntervalSince(lastFetch) / 60)
        if minutes < 1 { return "just now" }
        return "\(minutes)m ago"
    }
}

/// One window row in the usage sheet: band ring, name, window-length caption,
/// percentage, meter, and the reset countdown/date.
private struct UsageWindowRow: View {
    let window: UsageWindow
    let name: String
    let caption: String
    let tokens: Tokens

    var body: some View {
        let band = UsageMeters.band(window.pct)
        let tint = MeterRing.tint(band, tokens)
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            HStack(spacing: Metrics.spacing.sp1) {
                MeterRing(color: tint, diameter: 11, lineWidth: 2.5)
                Text(name)
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.tx1)
                Text(caption)
                    .font(.manta(size: Metrics.type.twoXS))
                    .foregroundColor(tokens.tx4)
                Spacer(minLength: 0)
                Text("\(Int(window.pct.rounded()))%")
                    .font(.manta(size: Metrics.type.small, weight: .bold))
                    .foregroundColor(tint)
            }
            Gauge(value: window.pct, in: 0...100) { EmptyView() }
                .gaugeStyle(.accessoryLinearCapacity)
                .tint(tint)
                .frame(height: 5)
            if let resetsAt = window.resetsAt {
                Text("resets \(UsageMeters.formatReset(Date(timeIntervalSince1970: resetsAt / 1000), now: Date()))")
                    .font(.manta(size: Metrics.type.twoXS))
                    .foregroundColor(tokens.tx4)
            }
        }
        .padding(Metrics.spacing.sp3)
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.radius.md)
                .stroke(tokens.borderSubtle, lineWidth: Metrics.spacing.spPx)
        )
    }
}
