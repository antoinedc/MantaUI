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

/// The partially-filled band-coloured ring used by the composer dot, the
/// usage-sheet rows and the weekly banner. 13pt / 2.5pt stroke by default;
/// the filled fraction matches the meter's percentage drawn over a muted
/// track. Colour + fraction only — no number, no label, ever.
struct MeterRing: View {
    /// 0-100. Clamped: a provider can report over 100.
    let pct: Double
    let color: Color
    var diameter: CGFloat = 13
    var lineWidth: CGFloat = 2.5
    /// The muted full-circle track drawn underneath the filled fraction.
    let track: Color

    var body: some View {
        let clamped = Self.clamp(pct)
        // At/over 100 the fraction would be a full ring identical to 99% —
        // so it becomes a solid disc instead. That state must be unmistakable.
        if Self.isFull(clamped) {
            Circle()
                .fill(color)
                .frame(width: diameter, height: diameter)
        } else {
            ZStack {
                Circle()
                    .stroke(track, lineWidth: lineWidth)
                Circle()
                    .trim(from: 0, to: clamped / 100)
                    .stroke(color, lineWidth: lineWidth)
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: diameter, height: diameter)
        }
    }

    static func tint(_ band: MeterBand, _ tokens: Tokens) -> Color {
        switch band {
        case .ok: return tokens.ok
        case .warn: return tokens.warn
        case .danger: return tokens.danger
        }
    }

    /// Clamp a 0-100 percentage (providers can report over 100).
    static func clamp(_ pct: Double) -> Double {
        min(max(pct, 0), 100)
    }

    /// Whether the (already-clamped) percentage is at/over 100 — the
    /// solid-disc state. Pure so the ≥100 boundary is unit-testable.
    static func isFull(_ pct: Double) -> Bool {
        pct >= 100
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

    @State private var confirmingClear = false
    @State private var confirmingCompact = false

    var body: some View {
        // A List, not a VStack: the list supplies the card backgrounds, the
        // insets and the platform text sizes. A fixed-height detent around a
        // centred VStack splits the leftover height into dead space above and
        // below the content.
        NavigationStack {
            List {
                Section(footer: staleLine) {
                    header
                    segmentedMeter
                }
                Section {
                    actionRow("Compact session", systemImage: "arrow.triangle.2.circlepath", onTap: { confirmingCompact = true })
                    actionRow("Clear session", systemImage: "plus.circle", onTap: { confirmingClear = true })
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Context")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .confirmActionSheet(isPresented: $confirmingClear, copy: SessionConfirmCopy.clear) {
            dismiss(); onClear()
        }
        .confirmActionSheet(isPresented: $confirmingCompact, copy: SessionConfirmCopy.compact) {
            dismiss(); onCompact()
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }

    /// Big percentage in the band colour + "824k of 1M · Opus 4.7"; for a
    /// model with no known max context, a "No max context info" line instead
    /// — never a fabricated % or `of <limit>`.
    @ViewBuilder
    private var header: some View {
        if context.hasLimit {
            HStack(alignment: .firstTextBaseline, spacing: Metrics.spacing.sp2) {
                Group {
                    Text("\(Int(context.pct.rounded()))")
                        .font(.system(size: Metrics.type.display, weight: .bold))
                    Text("%")
                        .font(.manta(size: Metrics.type.body, weight: .bold))
                }
                .foregroundColor(bandColor)
                Text("\(UsageMeters.formatTokens(context.totalInput)) of \(UsageMeters.formatTokens(limit)) · \(modelName)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: Metrics.spacing.sp2) {
                Text("No max context info for this model")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
        }
    }

    /// The segmented meter: fresh input (accent), cache-written (warn),
    /// cache-read (info) — the box-computed per-segment percentages, whose
    /// sum is the overall fill. For the unknown state (no max context) only
    /// the fresh/written/cached token stats are shown, with no bar.
    private var segmentedMeter: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            if context.hasLimit {
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
            }
            HStack(spacing: Metrics.spacing.sp2) {
                legend("fresh", UsageMeters.formatTokens(context.freshInput), color: tokens.accent)
                legend("written", UsageMeters.formatTokens(context.cacheWrite), color: tokens.warn)
                legend("cached", UsageMeters.formatTokens(context.cacheRead), color: tokens.info)
                Spacer(minLength: 0)
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
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

    /// "Idle 1h12m — the cache has gone cold. Clearing now saves re-billing
    /// 584k tokens." — driven by idleMs + staleTokens. The warn colour IS the
    /// warning, so it is kept; the font is the platform's footnote.
    @ViewBuilder
    private var staleLine: some View {
        if let cache, cache.isStale {
            Text("Idle \(idleText(cache.idleMs)) — the cache has gone cold. Clearing now saves re-billing \(UsageMeters.formatTokens(cache.staleTokens)) tokens.")
                .font(.footnote)
                .foregroundColor(tokens.warn)
        }
    }

    /// A plain row in the list's action section: compact the session, or clear
    /// it. Both arm a confirm sheet (sheet-on-sheet) rather than firing the
    /// destructive action directly — a blind tap must not reach the store. The
    /// list styles the row and the system tints the label.
    private func actionRow(_ title: String, systemImage: String, onTap: @escaping () -> Void) -> some View {
        Button(action: onTap) {
            Label(title, systemImage: systemImage)
        }
    }

    private func idleText(_ ms: Double) -> String {
        // Canonical compact timer form ("2h57m"/"57m"/"45s"), shared with the
        // running row and the desktop — pass ms/1000 since `compact` takes seconds.
        SessionTimerFormat.compact(ms / 1000)
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
        // A List, not a VStack: the list supplies the card backgrounds, the
        // insets and the platform text sizes. A fixed-height detent around a
        // centred VStack splits the leftover height into dead space above and
        // below the content.
        NavigationStack {
            List {
                Section(footer: footer) {
                    if let session = UsageMeters.sessionWindow(snapshots) {
                        UsageWindowRow(window: session, tokens: tokens)
                    }
                    if let weekly = UsageMeters.weeklyWindow(snapshots) {
                        UsageWindowRow(window: weekly, tokens: tokens)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(planTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }

    /// "2m ago" from `lastFetch`; "just now" when missing or fresh.
    private var updatedAgo: String {
        guard let lastFetch else { return "just now" }
        let minutes = Int(Date().timeIntervalSince(lastFetch) / 60)
        if minutes < 1 { return "just now" }
        return "\(minutes)m ago"
    }

    /// The sheet's title — the provider whose snapshot the sheet shows,
    /// mapped the same way the desktop dial names providers (claude →
    /// "Claude", codex → "OpenAI", kimi → "Kimi", else capitalised id).
    private var planTitle: String {
        UsageMeters.providerLabel(primarySnapshot?.provider)
    }

    /// The snapshot that drives the sheet — the one holding the primary (dot)
    /// window, falling back to the first snapshot when none does.
    private var primarySnapshot: UsageSnapshot? {
        snapshots.first { $0.windows.contains { $0.kind == "session" } } ?? snapshots.first
    }

    /// "Updated 2m ago · the dot tracks 5h." The window the dot actually tracks
    /// is the session (primary, first) window — named from its own `label`, so
    /// the footer never asserts a fixed 5-hour window.
    private var footer: Text {
        let windowLabel = UsageMeters.sessionWindow(snapshots)?.label ?? ""
        return Text("Updated \(updatedAgo) · the dot tracks \(windowLabel).")
    }
}

/// One window row in the usage sheet: band ring, the server's window `label`,
/// percentage, meter, and the reset countdown/date. The list draws the row's
/// surface, so there is no hand-rolled card here.
private struct UsageWindowRow: View {
    let window: UsageWindow
    let tokens: Tokens

    var body: some View {
        let band = UsageMeters.band(window.pct)
        let tint = MeterRing.tint(band, tokens)
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            HStack(spacing: Metrics.spacing.sp1) {
                MeterRing(pct: window.pct, color: tint, diameter: 11, lineWidth: 2.5, track: tokens.borderSubtle)
                Text(window.label ?? "")
                    .font(.body)
                Spacer(minLength: 0)
                Text("\(Int(window.pct.rounded()))%")
                    .font(.body.weight(.semibold))
                    .foregroundColor(tint)
            }
            Gauge(value: window.pct, in: 0...100) { EmptyView() }
                .gaugeStyle(.accessoryLinearCapacity)
                .tint(tint)
                .frame(height: 5)
            if let resetsAt = window.resetsAt {
                Text("resets \(UsageMeters.formatReset(Date(timeIntervalSince1970: resetsAt / 1000), now: Date()))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
