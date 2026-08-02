import SwiftUI

/// Application shell for the native MantaUI client.
///
/// This stage (S4a / BET-557) renders a spec-fixture transcript scene that
/// exercises the three §8 transcript atoms — the full-bleed user band, the
/// assistant prose, and the grouped step rows (with the roll-up for three or
/// more consecutive steps). It is the input to the S3b capture harness: the
/// accessibility hierarchy leg reads its geometry/text per element, and the
/// screenshot leg covers colour/typography/radius.
///
/// Every value resolves through the GENERATED tokens — `Tokens.scheme(_:)`
/// (colours from tokens.css data-theme blocks) and `Metrics`
/// (spacing/radius/type from tokens.css :root). No colour, spacing, radius,
/// size, weight or leading literal appears in app code.
struct RootView: View {
    @Environment(\.colorScheme) private var colorScheme

    private var tokens: Tokens {
        Tokens.scheme(colorScheme)
    }

    var body: some View {
        ZStack {
            tokens.canvas.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 0, content: fixtureBlocks)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("transcript-fixture")
    }

    @ViewBuilder
    private func fixtureBlocks() -> some View {
        UserBand(text: "check bet-520 and see if it's blocked correctly", tokens: tokens)
            .padding(.bottom, Metrics.spacing.sp4)
        AssistantProse(text: "Checking its metadata and the blocker chain.", tokens: tokens)
        StepGroupView(
            content: .rows([
                ToolStep(verb: "Ran", target: "multica issue get BET-520", duration: "0.4s", status: .done, output: nil),
            ]),
            tokens: tokens
        )
        .padding(.bottom, Metrics.spacing.sp3)
        AssistantProse(text: "Blocked correctly — waiting_on names both PoC issues, so the sweep clears it once they land.", tokens: tokens)
        UserBand(text: "now check pr 429", tokens: tokens)
            .padding(.bottom, Metrics.spacing.sp4)
        AssistantProse(text: "That PR is +551/−42 across 18 files.", tokens: tokens)
        StepGroupView(
            content: .rollup(
                summary: "▸ 4 steps · read 3 files, 1 search",
                rows: [
                    ToolStep(verb: "Read", target: "pr-body.md", duration: "0.2s", status: .done, output: nil),
                    ToolStep(verb: "Read", target: "src/main/auth.ts", duration: "0.2s", status: .done, output: nil),
                    ToolStep(verb: "Read", target: "src/renderer/mobile/setupLogic.ts", duration: "0.2s", status: .done, output: nil),
                    ToolStep(verb: "Search", target: "gh pr view 429 --json files", duration: "0.9s", status: .running, output: nil),
                ]
            ),
            tokens: tokens
        )
        .padding(.top, Metrics.spacing.sp3)
        Spacer(minLength: 0)
    }
}

#Preview {
    RootView()
}
