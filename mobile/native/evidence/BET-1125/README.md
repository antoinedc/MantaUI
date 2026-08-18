# BET-1125 on-device verification evidence (macos)

Build: BET-1125 branch `multica/BET-1125-preserve-hydrated-transcript` @ `b9a1c262`
(one commit: "never clobber a hydrated transcript with an empty racing refetch"),
plus a re-verification on the BET-1105 head + BET-1125 fix combined (see below).

Test box: `https://1b41876333f84c8dcf0dd6363dd0a0a1.boxes.mantaui.com`
(provisioning host `135.181.255.249`). Simulator: iPhone 17 Pro (iOS 26.5).
App paired via the onboarding UI (MantaPairingDriverUITests) against that box.

## Box health (Check-1 scenario data present)

The `default` window maps to opencode session `ses_fec1489baffeCIwPdkjy2RgxFL`,
which is registered under its project dir and holds **6 persisted messages**:

```
$ curl -s "http://127.0.0.1:4096/session?directory=/root/projects/stepper"
[{"id":"ses_fec1489baffeCIwPdkjy2RgxFL", ... "title":"stepper / default",
  "model":{"id":"claude-sonnet-4-6","providerID":"anthropic"} }]

$ curl -s "http://127.0.0.1:4096/session/ses_fec1489baffeCIwPdkjy2RgxFL/message"
count= 6   (3 user + 3 assistant)
```

## Store-level verdict: the BET-1125 fix stops the clobber — CONFIRMED

Temporary `NSLog` instrumentation was added inside
`ChatSessionStore.fetchTranscript`'s `MainActor.run` (reverted before commit)
to log every fetch: sessionId, `isFirstLoad`, `loaded.count`,
`transcript.count` before the update, whether the empty-clobber guard blocked
it, and the failure flag.

Instrumented build, open the `default` session on the box:

```
BET1125-VERIFY fetchTranscript sid=jy2RgxFL firstLoad=1 loaded=6 transcriptBefore=0 willBlockEmpty=NO didFail=0
```

`firstLoad=1 loaded=6` — the persisted history **hydrates to 6 rows**. Only ONE
fetch is issued: there is **no ~1.4s-later empty refetch** and therefore no
`rows 6 → 0` reset on open. The specific blank-chat mechanism BET-1125
targets (a racing empty `opencode:messages` overwriting a hydrated
`transcript`) does not occur with the fix in place.

## On-screen verdict: transcript still renders BLANK cells on open — NOT green

The store-level fix is necessary but not sufficient for Check-1. Opening the
`default` session renders a visually empty transcript, on BOTH:

1. this BET-1125 branch alone (main base), and
2. the combined BET-1105 head (`2c884994`) + the BET-1125 store fix applied.

In both, `chat-screen` mounts, the store hydrates 6 rows (single fetch above),
but the accessibility tree and a screenshot both show the transcript area as
blank cells (no message text). XCUITest sampling across the ~4s refetch window:

```
BET1125 opened row=default
BET1125 sample[t0] chat-screen=1 user-band=0 assistant-prose=0 agent-row=0 step-rows=0
BET1125 sample[t1] chat-screen=1 user-band=0 assistant-prose=0 agent-row=0 step-rows=0
BET1125 verdict user-band=0->0 assistant-prose=0->0
```

OCR of the on-screen screenshot (`bet1125-combined-open-screen.png`) returns
only the chrome (nav title `default`, branch `main`, context pill, composer
placeholder) — no message text in the transcript region.

## Interpretation

`store.rows` is correct (6, un-clobbered) but the MessagingUI `TiledView`
does not draw the hydrated rows on open. That residual blank lives in the
**transcript render/view path**, which is BET-1105's scope (its current head
`2c884994` "drop the local-mirror feed" is where it bites), not the
`ChatSessionStore` clobber BET-1125 fixes. BET-1125 is verified at its own
boundary; BET-1105's Check-1 "opens AND RENDERS its messages" is still NOT
green and needs the view path resolved there.
