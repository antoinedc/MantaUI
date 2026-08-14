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
    /// a multi-day lockout the user did not see coming.
    static func shouldShowWeeklyBanner(_ weekly: UsageWindow?, alreadyShown: Bool) -> Bool {
        guard let weekly, !alreadyShown else { return false }
        return weekly.pct >= 90
    }

    /// Compact reset label under 24h ("in 4h 12m"); absolute weekday + time
    /// ("Thursday 09:00") at 24h and beyond — the format the sheet and the
    /// banner both use, the caller supplying cap/case.
    static func formatReset(_ resetsAt: Date, now: Date) -> String {
        let seconds = Int(resetsAt.timeIntervalSince(now))
        if seconds > 0 && seconds < 24 * 3600 {
            let hours = seconds / 3600
            let minutes = (seconds % 3600) / 60
            if hours >= 1 {
                return minutes > 0 ? "in \(hours)h \(minutes)m" : "in \(hours)h"
            }
            return "in \(max(1, minutes))m"
        }
        return Self.weekdayTime.string(from: resetsAt)
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

    /// "Thursday 09:00" — absolute, so a multi-day reset reads as a calendar
    /// anchor rather than an arithmetic exercise.
    private static let weekdayTime: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "EEEE HH:mm"
        return f
    }()
}
