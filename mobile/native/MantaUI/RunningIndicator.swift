import SwiftUI

// ===========================================================================
// BET-630 — the running-state working row (D1, build-order row 5).
//
// Ports the desktop RunningIndicator (src/renderer/MessageRow.tsx): the app's
// own loader + verb + live elapsed, shown while a turn runs. It draws the
// inline MantaLoader rather than a system ProgressView, so a running turn looks
// like the same "waiting on the box" object as a session load, just smaller.
//
// It sits in the screen's bottom safe-area inset, on its own line directly
// above the composer — it no longer floats over the transcript (that was the
// old overlay chrome; the inset reserves real space instead). It is
// deliberately distinct from the ambient refetch sweep on the composer's top
// divider (the transcript-syncing indicator) — the two mean different things
// and never share an indicator. The header subtitle (`running · 2m · 8%`)
// stays the at-a-glance status; this row is the wait affordance the user is
// actually looking at.
//
// Mounted by ChatScreen only while `store.running`, so @State (verb + `now`)
// reinitializes fresh each time a turn starts; the view leaves the hierarchy
// when the turn ends.
// ===========================================================================

struct RunningIndicator: View {
    @ObservedObject var store: ChatSessionStore
    /// Open the Activity sheet for the trailing run (by run id). nil on a surface
    /// that cannot present it: the line is then plain text, not a button.
    var onOpenActivity: ((String) -> Void)? = nil
    @Environment(\.colorScheme) private var colorScheme

    /// The rotation the working row cycles, mirroring the desktop SPINNER_VERBS.
    private static let verbs = [
        "Cogitating", "Ruminating", "Pondering", "Reflecting",
        "Considering", "Deliberating", "Musing", "Contemplating",
    ]

    /// Picked once per mount so the verb doesn't shuffle between ticks.
    @State private var verb = RunningIndicator.verbs[Int.random(in: RunningIndicator.verbs.indices)]
    /// 1s tick reference; read in the body so the elapsed label re-renders.
    @State private var now = Date()

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        let run = store.trailingRun
        Group {
            if let run, let onOpenActivity {
                Button { onOpenActivity(run.id) } label: { line(run.summary) }
                    .buttonStyle(.plain)
                    .accessibilityHint("Shows the tool calls")
            } else {
                line(run?.summary)
            }
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
        // Plain text, deliberately no glass / material backdrop: this row is
        // pinned to the bottom of the transcript as ordinary content, not a
        // floating chrome element.
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("running-indicator")
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { _ in
            now = Date()
        }
    }

    /// What the line says (spec §1.4):
    ///  - a tool is running   → "<running label>…", then "· N tools · elapsed"
    ///  - between tools       → "<verb>…", then "· <run summary> · elapsed"
    ///  - no tool run yet     → "<verb>… (elapsed)", as before
    /// A red failed count rides along whenever the run has one.
    @MainActor
    private func line(_ summary: GroupSummary?) -> some View {
        HStack(spacing: Metrics.spacing.sp2) {
            MantaLoader(tokens: tokens, size: .inline)
            if let summary {
                Text(summary.workingLineHeadline(verb: verb))
                    .font(.manta(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
                    .foregroundColor(tokens.tx1)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .layoutPriority(1)
                let meta = summary.workingLineMeta(elapsed: knownElapsed)
                if !meta.isEmpty {
                    Text(meta)
                        .font(.manta(size: Metrics.type.small))
                        .foregroundColor(tokens.tx4)
                        .lineLimit(1)
                }
                if summary.failed > 0 {
                    Text("· \(summary.failed) failed")
                        .font(.manta(size: Metrics.type.small))
                        .foregroundColor(tokens.danger)
                        .lineLimit(1)
                        .fixedSize()
                }
                if onOpenActivity != nil {
                    Image(systemName: "chevron.right")
                        .font(.manta(size: Metrics.type.xs))
                        .foregroundColor(tokens.tx4)
                }
            } else {
                Text("\(verb)…")
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx1)
                Text("(\(SessionTimerFormat.elapsed(elapsed)))")
                    .font(.manta(size: Metrics.type.small, design: .monospaced))
                    .foregroundColor(tokens.tx4)
            }
            Spacer(minLength: 0)
        }
    }

    /// The elapsed label, or nil when the turn's start is unknown (a relaunch
    /// mid-turn): no timer is more honest than one that restarts from zero.
    private var knownElapsed: String? {
        store.runningStart == nil ? nil : SessionTimerFormat.elapsed(elapsed)
    }

    private var elapsed: TimeInterval {
        guard let start = store.runningStart else { return 0 }
        return now.timeIntervalSince(start)
    }
}
