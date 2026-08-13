import SwiftUI

/// Application shell for the native MantaUI client.
///
/// This stage (S4b / BET-558) extends the S4a transcript fixture with §8a's
/// subagent surface: an agent row lives inside the same grouped container as
/// the step rows, and tapping one PUSHES the child drill-in screen (its own
/// header + its own transcript, rendered through S4a's components). The parent
/// and every child share ONE transcript renderer (`TranscriptView`); there is
/// no second one.
///
/// Nav is a `NavigationStack` push (never an inline expansion or a sheet): the
/// parent stays in the stack, so its scroll position is untouched by a visit,
/// and a pushed child stays alive (the structural precondition for live
/// streaming, which is deferred until a real observable subagent store exists
/// — see `mobile/native/FINDINGS.md`). The child screen is read-only in v1 (no
/// composer / write affordance).
///
/// Every value resolves through the GENERATED tokens — `Tokens.scheme(_:)`
/// (colours, including `accentSoft` for the agent glyph) and `Metrics`
/// (spacing/radius/type). No colour, spacing, radius, size, weight or leading
/// literal appears in app code.
struct RootView: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var path: [SubagentSession] = []

    private var tokens: Tokens {
        Tokens.scheme(colorScheme)
    }

    /// Scene selector for the S3b capture harness ("child" → the drill-in
    /// screen). Prefers the launch environment; falls back to the app's
    /// UserDefaults, which is how the hierarchy leg's test-managed launch
    /// receives the same selection as the `simctl launch` screenshot leg.
    private var harnessScene: String? {
        if let s = ProcessInfo.processInfo.environment["MANTA_SCENE"], !s.isEmpty {
            return s
        }
        return UserDefaults.standard.string(forKey: "MantaScene")
    }

    var body: some View {
        NavigationStack(path: $path) {
            ZStack {
                tokens.canvas.ignoresSafeArea()
                ScrollView {
                    TranscriptView(blocks: parentBlocks, tokens: tokens)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("transcript-fixture")
            .navigationDestination(for: SubagentSession.self) { agent in
                SubagentScreen(agent: agent, tokens: tokens)
            }
            .toolbar(.hidden, for: .navigationBar)
            .onAppear {
                // Deterministic child-scene entry for the S3b capture harness.
                // `SCENE_MODE=child` (capture.sh) starts the stack already
                // pushed onto the running subagent so the drill-in screen can
                // be captured as its own stable scene. The scene is resolved
                // from BOTH launch env (the screenshot leg, via SIMCTL_CHILD_)
                // and UserDefaults (the hierarchy leg, whose app launcher is
                // the XCUITest runner and does not inherit that env) so the two
                // legs cannot disagree.
                if harnessScene == "child",
                   let running = firstRunningAgent {
                    path = [running]
                }
            }
        }
    }

    private var firstRunningAgent: SubagentSession? {
        for block in parentBlocks {
            if case .steps(let content) = block {
                if case .rows(let rows) = content {
                    for row in rows {
                        if case .subagent(let agent) = row, agent.status == .running {
                            return agent
                        }
                    }
                }
            }
        }
        return nil
    }

    // The parent fixture: the S4a §8 atoms plus §8a's agent rows inside the
    // same grouped container, and a step-group roll-up for machinery coverage.
    private var parentBlocks: [TranscriptBlock] {
        [
            .user("check bet-520 and see if it's blocked correctly", at: nil),
            .prose("Checking its metadata and the blocker chain.", at: nil),
            .steps(.rows([
                .step(ToolStep(id: "fixture-ran-1", verb: "Ran", target: "multica issue get BET-520", duration: "0.4s", status: .completed, output: nil)),
            ])),
            .prose("Blocked correctly — waiting_on names both PoC issues. Now fanning out to audit the three sweeps.", at: nil),
            .steps(.rows([
                .subagent(SubagentSession(taskName: "unblock sweep", status: .done, duration: nil, transcript: [])),
                .subagent(SubagentSession(taskName: "unstick sweep", status: .done, duration: nil, transcript: [])),
                .subagent(SubagentSession(taskName: "pr-closed sweep", status: .running, duration: "1m12s", transcript: childBlocks)),
            ])),
            .prose("Two are back. The third is still reading the close-on-merge workflow.", at: nil),
            .steps(.rollup(
                summary: "▸ 4 steps · read 3 files, 1 search",
                rows: [
                    .step(ToolStep(id: "fixture-read-1", verb: "Read", target: "pr-body.md", duration: "0.2s", status: .completed, output: nil)),
                    .step(ToolStep(id: "fixture-read-2", verb: "Read", target: "src/main/auth.ts", duration: "0.2s", status: .completed, output: nil)),
                    .step(ToolStep(id: "fixture-read-3", verb: "Read", target: "src/renderer/mobile/setupLogic.ts", duration: "0.2s", status: .completed, output: nil)),
                    .step(ToolStep(id: "fixture-search-1", verb: "Search", target: "gh pr view 429 --json files", duration: "0.9s", status: .running, output: nil)),
                ]
            )),
        ]
    }

    // The running subagent's own transcript — rendered with the SAME
    // components as the parent, not a copy (§8a).
    private var childBlocks: [TranscriptBlock] {
        [
            .prose("Reading the close-on-merge workflow and its CI posture.", at: nil),
            .steps(.rows([
                .step(ToolStep(id: "fixture-read-clm", verb: "Read", target: "multica-close-on-merge.yml", duration: "0.3s", status: .completed, output: nil)),
                .step(ToolStep(id: "fixture-ran-sweep", verb: "Ran", target: "node scripts/multica-unblock.mjs --dry-run", duration: "1.8s", status: .running, output: nil)),
            ])),
            .prose("The sweep flips a blocked issue to todo the moment its blockers clear.", at: nil),
        ]
    }
}

#Preview {
    RootView()
}
