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
        HStack(spacing: Metrics.spacing.sp2) {
            MantaLoader(tokens: tokens, size: .inline)
            Text("\(verb)…")
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.tx1)
            Text("(\(SessionTimerFormat.elapsed(elapsed)))")
                .font(.manta(size: Metrics.type.small, design: .monospaced))
                .foregroundColor(tokens.tx4)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
        // Plain text, deliberately no glass / material backdrop: this row is
        // pinned to the bottom of the transcript as ordinary content, not a
        // floating chrome element.
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("running-indicator")
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { _ in
            now = Date()
        }
    }

    private var elapsed: TimeInterval {
        guard let start = store.runningStart else { return 0 }
        return now.timeIntervalSince(start)
    }
}
