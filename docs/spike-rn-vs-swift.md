# Spike: React Native vs Swift for the iOS client

**Date:** 2026-08-01 · **Verdict:** Swift · **Decided by:** the evidence below

## What was built

Nothing from this epic ships. It was a throwaway experiment to decide which
native stack the mobile rewrite should use — React Native (Expo) or
Swift/SwiftUI — and its only artefact to reach `main` is this document. All
spike code lives on the never-merged `spike/rn-ios` branch, which is left in
place, unmerged, as the evidence trail behind this report.

The experiment's architecture was three legs, and only part of one ran:

- **Q3, the reuse gate (spike 02):** whether the existing shared logic layer
  (`src/renderer/` + `src/shared/`) imports into React Native and runs
  **unmodified**. This is the decisive question and the only one the epic
  prescribed a pre-registered PASS/MARGINAL/FAIL verdict for.
- **Q1/Q2, fidelity (spikes 03–06):** whether the two comparison screens
  (session list, live chat transcript) render Liquid Glass indistinguishably
  from SwiftUI, and whether the eight hard cases pass on a physical device.
- **The evidence trail:** a throwaway Expo app and a SwiftUI reference app,
  both under `spike/` on `spike/rn-ios`, never merged.

The Q3 gate ran to completion. The fidelity leg did not run at all.

## Why the epic stopped early

The parent epic pre-registered a stopping rule: *if spike 02 comes back FAIL,
stop the epic and report.* Spike 02 came back **FAIL**, and the owner
confirmed that the fidelity leg is not being run. Stopping is the designed
outcome, not a shortfall; the sections below that could only be answered by
the fidelity measurement are left open rather than filled in with argument.

## Q3 - can React Native reuse the shared logic layer?

**FAIL.** The verdict word is taken from spike 02 (BET-433), which measured
each shared module by importing it into the spike app and exercising it. The
module table, verbatim from that gate's closing record:

| Module | Result |
|---|---|
| `chatUtils.ts` | clean — pure TS, imports and runs |
| `api/httpApi.ts` | data path runs unmodified against the live box |
| `store.ts` | imports, but actions throw `window is not defined` |
| `useSseBus.ts` | cannot run without a rewrite |
| `useTranscriptState.ts` | cannot run without a rewrite — DOM-shaped core |
| `shared/transport.mjs` | clean |

The shape of the FAIL is the actual finding, so it is stated plainly. Two
failures were pre-authorised as MARGINAL-class from the start: `EventSource`
and `localStorage`, both absent from React Native and both given a
spike-local polyfill, each recorded, no shared file edited. The blockers were
a **third class** the epic had not anticipated: three shared modules read the
Electron renderer bridge off `window` (`httpApi`, `store`, the SSE bus), and
the transcript hook is structurally coupled to the web renderer's DOM — its
pin-to-bottom logic reads `scrollTop`/`clientHeight` off an
`HTMLDivElement`, and React Native's `ScrollView` exposes no equivalent.

That is a **rewrite**, not a missing global. The pure utility and transport
layers (two modules) port cleanly, and the `/rpc` data path of `httpApi`
genuinely ran against the live box unmodified. But the behaviour-critical
core — the transcript state and SSE hooks that power the chat panel — cannot
run without a rewrite against React Native's own API. That squarely meets the
pre-registered FAIL criterion ("any shared module needed its logic changed, or
any hook could not run without a rewrite"), so PASS and MARGINAL are both
disqualified. The result was not softened.

## Q1/Q2 - not measured

This is not a placeholder. The fidelity questions ask whether React Native
renders Apple's Liquid Glass language (iOS 26+) to a standard
indistinguishable from SwiftUI, side by side on one device. Answering them
required the two screens from spikes 03 and 04 and the SwiftUI reference from
spike 05. Because the Q3 gate returned FAIL and the stopping rule fired before
those screens were built, no side-by-side comparison exists and the questions
remain genuinely open. Nothing here — and nothing measured anywhere in this
spike — says anything one way or the other about how the two stacks would
compare visually.

## The eight hard cases - not exercised

Not a placeholder either. The eight cases (glass header with scroll-edge
effect, streaming transcript under a glass header, a detent sheet with
drag-to-dismiss, the follow-finger back gesture, concentric corner radius,
Dynamic Type at a 1.4× cap, light/dark flip of the glass material, and the
known `expo-glass-effect` opacity bug) each need a physical iPhone and, for
the React Native side, the screens that were never built. Because the epic
stopped at the Q3 gate, none of the eight was exercised and no device
evidence was captured. How the comparison would have turned out — including
whether the `expo-glass-effect` bug actually reproduces — is unknown, and this
report does not speculate on it.

## What surprised us

The one surprise worth recording came from the gate itself: the shared `/rpc`
data layer genuinely ran against the live box unmodified from a React
Native-shaped environment — projects, sessions and messages all came back with
no change to `src/`. The failure is narrower and sharper than "React Native
can't use our code": the HTTP client and the pure logic port cheaply, and what
breaks is the chat's state core, which is woven into the web renderer's DOM
and the Electron bridge. That separation — transport fine, behaviour-critical
state not — is what the gate actually measured, and it is what points the
recommendation.

## What this does not tell us

The fidelity question is unanswered, so nothing here says Swift renders better
than React Native — only that the reuse argument for React Native does not
hold. Terminal mode was not tested because it is a webview under both stacks
and cannot discriminate. Android was not considered. Onboarding, settings,
markdown rendering and notifications were not built. The Q3 verdict does not
weigh platform compile speed, team skill with either stack, or long-term
maintenance cost. A reader must not take this document as a full comparison of
the two stacks — it is a record that one specific, decisive argument for React
Native does not survive measurement.

## Recommendation

Swift. The single quantitative argument for React Native — that it could
reuse roughly 6,700 lines of tested TypeScript and ~10,100 lines of tests
untouched — fails measurement: the behaviour-critical chat core cannot run in
React Native without a rewrite, and on either stack that core would have to be
reimplemented. With the reuse value gone, Swift/SwiftUI is the platform-native
path to the Liquid Glass language the product targets, with no compensating
advantage for React Native left to point the other way. The evidence trail is
on the `spike/rn-ios` branch (never merged), which preserves the probe, the
recorded measurements, and the SwiftUI reference for anyone who wants to
re-examine the verdict.