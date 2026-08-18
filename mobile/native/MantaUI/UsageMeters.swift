import Foundation

// ===========================================================================
// BET-824 — plan + context meter decisions, pure and view-free.
//
// Two meters, kept apart by placement not colour: the CONTEXT strip (how full
// this conversation is) under the navigation bar, and the PLAN-USAGE dot (how
// much of the subscription is spent) beside the model name. Both band at
// Anthropic's published breakpoints (70 / 90) — never invent others.
//
// This file holds ONLY the decisions (band, which window, banner gate, reset
// format) so they are unit-testable with plain values and
// no SwiftUI hierarchy, mirroring `BranchFreshnessPolicy` in ChatScreen.swift.
// Missing values are expressed with Swift optionals rather than a bespoke
// enum: a nil session window hides the dot; a nil context percentage hides
// the context strip. A missing value renders nothing — never a confident 0%.
// ===========================================================================

/// The severity band of a meter reading, from a percentage at the 70/90
/// breakpoints. A gate must never band a missing value — see `band` below.
enum MeterBand: Equatable {
    case ok
    case warn
    case danger
}

/// Pure decisions behind the two meters.
enum UsageMeters {

    /// Band a 0-100 percentage at Anthropic's published breakpoints: < 70
    /// green, 70–89 amber, ≥ 90 red. Callers pass only a real percentage; a
    /// missing value must render nothing upstream, never a confident `ok`.
    static func band(_ pct: Double) -> MeterBand {
        if pct >= 90 { return .danger }
        if pct >= 70 { return .warn }
        return .ok
    }

    /// Whether the context meter should render at all.
    ///
    /// Above zero only: a fresh session with no billed turn reports 0% and a
    /// "Context 0%" row is noise. `nil` (unknown) and non-finite values never
    /// render.
    static func shouldShowContext(pct: Double?) -> Bool {
        guard let pct, pct.isFinite else { return false }
        return pct > 0
    }

    /// The 5-hour session window across all snapshots, or nil. `nil` is the
    /// signal that hides the usage dot — e.g. a snapshot set
    /// holding only a weekly window.
    static func sessionWindow(_ snapshots: [UsageSnapshot]) -> UsageWindow? {
        first(whereKind: "session", in: snapshots)
    }

    /// The 7-day weekly window across all snapshots, or nil.
    static func weeklyWindow(_ snapshots: [UsageSnapshot]) -> UsageWindow? {
        first(whereKind: "weekly", in: snapshots)
    }

    private static func first(whereKind kind: String, in snapshots: [UsageSnapshot]) -> UsageWindow? {
        for snapshot in snapshots {
            if let window = snapshot.windows.first(where: { $0.kind == kind }) {
                return window
            }
        }
        return nil
    }

    /// Whether the one-per-session weekly warning banner should show: the
    /// weekly window exists AND is ≥ 90% AND has not already been shown this
    /// session. It is the only thing standing between a green 5-hour dot and
    /// a multi-day lockout the user did not see coming. A STALE window (whose
    /// reset instant has already passed) never raises the ≥90% banner — the
    /// numbers still belong to a window that has ended.
    static func shouldShowWeeklyBanner(_ weekly: UsageWindow?, alreadyShown: Bool) -> Bool {
        guard let weekly, !alreadyShown else { return false }
        if weekly.stale == true { return false }
        return weekly.pct >= 90
    }

    /// The relative "how far away" reset distance, floored to at most two
    /// units — "45m" / "2h10m" / "2d4h". Mirrors the desktop
    /// `formatResetDistance` one-to-one so both clients print the same string
    /// for the same input. Pure arithmetic — no locale involvement.
    static func resetDistance(_ seconds: Int) -> String {
        if seconds <= 0 { return "now" }
        if seconds < 60 { return "under a minute" }
        let m = seconds / 60
        if seconds < 3600 { return "\(m)m" }
        let h = m / 60
        let mm = m % 60
        if seconds < 86400 {
            return mm == 0 ? "\(h)h" : "\(h)h\(mm)m"
        }
        let d = seconds / 86400
        let hh = (seconds % 86400) / 3600
        return hh == 0 ? "\(d)d" : "\(d)d\(hh)h"
    }

    /// The absolute anchor: "09:00" (same local calendar day), "Thu 09:00"
    /// (< 7 days away), or "Thu 21 Aug 09:00" otherwise — device locale, never
    /// a hardcoded pattern. Mirrors the desktop `formatResetAt`.
    static func resetAt(_ resetsAt: Date, now: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDate(resetsAt, inSameDayAs: now) {
            return Self.resetTimeFmt.string(from: resetsAt)
        }
        if resetsAt.timeIntervalSince(now) < 7 * 86400 {
            return Self.resetDayTimeFmt.string(from: resetsAt)
        }
        return Self.resetDateTimeFmt.string(from: resetsAt)
    }

    /// The sheet/banner reset line (the caller already supplies the "resets "
    /// prefix): "in 2h10m", with an absolute anchor appended only when the
    /// reset is NOT on the same local calendar day. A reset instant that has
    /// already passed reads "resetting…" — the dot carries the old number
    /// forward while the provider catches up (BET-965/967). Mirrors the
    /// desktop `formatWindowReset`.
    static func formatReset(_ resetsAt: Date, now: Date) -> String {
        let seconds = Int(resetsAt.timeIntervalSince(now))
        if seconds <= 0 { return "resetting…" }
        let line = "in " + resetDistance(seconds)
        if Calendar.current.isDate(resetsAt, inSameDayAs: now) {
            return line
        }
        return line + " (" + resetAt(resetsAt, now: now) + ")"
    }

    /// "824k" / "1M" / "148k" — the compact token-count display for the
    /// context sheet's "824k of 1M · Opus 4.7" and its legend. Nil / non-
    /// finite reads as "0"; a sub-1000 count prints whole; thousands get a
    /// "k", millions an "M".
    static func formatTokens(_ tokens: Double?) -> String {
        guard let tokens, tokens.isFinite, tokens > 0 else { return "0" }
        if tokens < 1_000 { return String(Int(tokens)) }
        if tokens < 1_000_000 { return "\(Int((tokens / 1000).rounded()))k" }
        return "\(Int((tokens / 1_000_000).rounded()))M"
    }

    /// The desktop's `providerLabel` lookup (`providerLabel` in
    /// src/renderer/UsageDial.tsx), shared verbatim so the iOS usage sheet and
    /// the desktop dial/popover never disagree about a provider's name: claude
    /// → "Claude", codex → "OpenAI", kimi → "Kimi", otherwise the adapter id
    /// capitalised (first character upper, rest unchanged — a 4th adapter needs
    /// no client change). Empty/missing → "".
    static func providerLabel(_ provider: String?) -> String {
        guard let provider, !provider.isEmpty else { return "" }
        switch provider {
        case "claude": return "Claude"
        case "codex": return "OpenAI"
        case "kimi": return "Kimi"
        default: return provider.prefix(1).uppercased() + provider.dropFirst()
        }
    }

    /// "344k cold" when the box has flagged the prompt cache stale, nil
    /// otherwise. Pure, so the label is unit-testable and the view renders
    /// whatever comes back — the staleness DECISION belongs to the box
    /// (`computeStaleCache`), never to the client.
    static func staleChipLabel(_ cache: StreamCachePayload?) -> String? {
        guard let cache, cache.isStale else { return nil }
        return "\(formatTokens(cache.staleTokens)) cold"
    }

    /// Re-derive a context breakdown against the model the user has SELECTED.
    ///
    /// The box computes `pct` and `segments` against the model that produced
    /// the last reply — it cannot know the client's per-session override, which
    /// is local state sent only at submit time. So the derived fields go stale
    /// the moment the user switches model. The raw token counts do not, and the
    /// selected model's window is in the catalogue, so the honest number is
    /// always derivable here. Mirrors the desktop's `computeContextBreakdown`
    /// (src/shared/streamInterpretation.mjs) so both clients agree.
    static func recompute(_ ctx: StreamContextPayload, limit: Double?) -> StreamContextPayload {
        // Unknown selected-model window (nil, non-positive, non-finite) —
        // mirror the shared `computeContextBreakdown` (BET-1137/1138): signal
        // "no max context" via hasLimit:false and carry ONLY the raw token
        // totals. Never fabricate a % against a made-up 200k window.
        guard let limit, limit.isFinite, limit > 0 else {
            return StreamContextPayload(
                freshInput: ctx.freshInput,
                cacheRead: ctx.cacheRead,
                cacheWrite: ctx.cacheWrite,
                totalInput: ctx.totalInput,
                pct: 0,
                hasLimit: false,
                segments: []
            )
        }

        // Guard the raw counts: the payload arrives from the box already
        // rounded and non-negative, but a bad value must never produce NaN or
        // a negative width. Clamp to [0, ∞) per bucket for the arithmetic only;
        // the raw fields are copied through unchanged.
        let fresh  = ctx.freshInput.isFinite  ? max(0, ctx.freshInput)  : 0
        let read   = ctx.cacheRead.isFinite   ? max(0, ctx.cacheRead)   : 0
        let write  = ctx.cacheWrite.isFinite  ? max(0, ctx.cacheWrite)  : 0
        let total  = ctx.totalInput.isFinite  ? max(0, ctx.totalInput)  : 0

        let rawPct = (total / limit) * 100
        // Rounded, clamped to 0...100 (mirrors `Math.min(100, Math.round(...))`).
        let pct = min(100, max(0, rawPct.rounded()))

        // Each segment is its bucket over the SELECTED limit, in cost-decreasing
        // order fresh → cacheWrite → cacheRead, matching the desktop's order.
        var segments = [
            StreamContextSegment(kind: "fresh", pct: (fresh / limit) * 100),
            StreamContextSegment(kind: "cacheWrite", pct: (write / limit) * 100),
            StreamContextSegment(kind: "cacheRead", pct: (read / limit) * 100),
        ]
        // Rescale segments that would sum past 100 the same way the desktop
        // does (streamInterpretation.mjs), so an over-context payload never
        // renders widths whose sum exceeds 100.
        let sum = segments.reduce(0) { $0 + $1.pct }
        if sum > 100 && sum > 0 {
            let scale = 100 / sum
            for i in segments.indices { segments[i].pct *= scale }
        }

        return StreamContextPayload(
            freshInput: ctx.freshInput,
            cacheRead: ctx.cacheRead,
            cacheWrite: ctx.cacheWrite,
            totalInput: ctx.totalInput,
            pct: pct,
            hasLimit: true,
            segments: segments
        )
    }

    // MARK: - Reset-time absolute formatters (BET-967)

    // OS locale on purpose (autoupdatingCurrent), and the TEMPLATE chooses
    // 12- vs 24-hour from the device — never a literal "HH:mm" pattern and
    // never a fixed POSIX locale. That single rule is what stops iOS
    // contradicting the desktop reset line.
    private static let resetTimeFmt: DateFormatter = Self.makeFmt(template: "jmm")
    private static let resetDayTimeFmt: DateFormatter = Self.makeFmt(template: "Ejmm")
    private static let resetDateTimeFmt: DateFormatter = Self.makeFmt(template: "EMMMdjmm")

    private static func makeFmt(template: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale.autoupdatingCurrent
        f.setLocalizedDateFormatFromTemplate(template)
        return f
    }
}
