import SwiftUI

// ===========================================================================
// WS09 F7 — the app-level usage banner (mounted as a top overlay at the app root,
// M-09-3). Shows the head of the box's alert queue: the box's text plus the
// client-formatted reset clause; a 90 % warning clears itself after 6 s (the store
// times it), a limit alert stays until closed or retired. The reminder / keep-going
// buttons hide the moment the reset instant passes (the box refuses the action
// then anyway), and a transient result line ("Reminder set for 17:00.") replaces
// the alert while it shows.
// ===========================================================================

struct UsageAlertBanner: View {
    @ObservedObject var store: UsageAlertsStore
    @EnvironmentObject private var sessionStore: SessionListStore
    @Environment(\.colorScheme) private var colorScheme

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        Group {
            if let notice = store.notice {
                noticeBanner(notice)
            } else if let alert = store.queue.first {
                alertBanner(alert)
            }
        }
        .animation(.default, value: store.queue.first?.id)
        .onChange(of: store.queue.first?.id) { _, _ in
            if store.queue.first?.level == "limit" {
                SessionHaptics.fire(.warning, enabled: sessionStore.hapticsEnabled)
            }
        }
    }

    private func noticeBanner(_ text: String) -> some View {
        HStack(spacing: Metrics.spacing.sp2) {
            Image(systemName: "bell.fill").foregroundStyle(tokens.accentTx)
            Text(text).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(Metrics.spacing.sp3)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: Metrics.radius.lg))
        .padding(.horizontal, Metrics.spacing.sp3)
        .accessibilityElement(children: .combine)
    }

    private func alertBanner(_ alert: UsageAlertWire) -> some View {
        let isLimit = alert.level == "limit"
        return TimelineView(.periodic(from: .now, by: 30)) { context in
            let now = context.date
            let upcoming = (alert.resetsAt ?? 0) > now.timeIntervalSince1970 * 1000
            VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                HStack(alignment: .top, spacing: Metrics.spacing.sp2) {
                    Image(systemName: isLimit ? "exclamationmark.octagon" : "gauge.with.dots.needle.67percent")
                        .foregroundStyle(isLimit ? tokens.danger : tokens.warn)
                    Text(UsageAlertText.line(alert: alert, now: now))
                        .font(.footnote.weight(.semibold))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button { store.dismiss(id: alert.id) } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                    .accessibilityLabel("Close")
                }
                if isLimit && upcoming && (alert.canRemind || alert.canKeepGoing) {
                    HStack(spacing: Metrics.spacing.sp3) {
                        if alert.canRemind && store.activeSessionId != nil {
                            Button("Remind me at reset") { Task { await store.remindAtReset(alert) } }
                        }
                        if alert.canKeepGoing {
                            Button("Keep going at reset") { store.keepGoing(alert) }
                        }
                    }
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.borderless)
                }
            }
            .padding(Metrics.spacing.sp3)
            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: Metrics.radius.lg))
            .padding(.horizontal, Metrics.spacing.sp3)
            .accessibilityElement(children: .contain)
        }
    }
}
