# Manta Mobile 2.0 — decisions record

**Status:** design settled; stack settled (Swift — §2); logic location settled (§17). Nothing implemented.
**Date:** 2026-07-31
**Visual companion:** [`mockup.html`](./mockup.html) in this directory —
interactive, light/dark toggle, every screen and every failure state. Also
served at
`https://0d5784a7a43451f4ad70dd3d9ee5cf72.boxes.mantaui.com/pages/manta-mobile-2`
(no expiry). **The file in this directory is the source of truth**; the served
copy is a convenience and may lag.

---

## How to use this document

This is the cache. It exists so a fresh session can pick the work up without
re-deriving four rounds of argument, and without re-running the research.

- **§1–§12 are settled decisions.** They do not change if the stack decision
  changes. Do not re-open them; if you think one is wrong, say so explicitly
  and get a human decision rather than quietly designing around it.
- **§13 is what we rejected, with reasons.** Read it before proposing anything
  that feels obvious — it probably already got considered and killed.
- **§14 is the load-bearing research.** Facts with dates. Do not re-research
  these; do re-verify anything marked as time-sensitive if a year has passed.
- **§15 is genuinely open.** §15.1 is now closed; §15.4 is being measured.
- **§17 is the newest decision** and supersedes half of §1.10.
- **§16 is what to file, and when.**

**The stack is settled: Swift** (§2, decided 2026-08-01). **Where the chat logic
lives is settled** (§17). What remains open before the implementation epic can
be written is tracked by **BET-475** — chiefly §15.4, which is a measurement,
not a decision.

---

## 1. Strategy and scope

| # | Decision | Notes |
|---|---|---|
| 1.1 | **The mobile client is rebuilt natively.** The current React-web-in-a-webview client is replaced, not improved. | |
| 1.2 | **Full replacement. No transition period.** The existing client is deleted rather than migrated. | We are in internal testing; there is no user base to protect. |
| 1.3 | **Box setup stays on desktop.** SSH, install, provisioning — none of it appears on mobile, now or later. | A phone cannot usefully drive an SSH install, and the desktop flow already exists. |
| 1.4 | **iOS first. Android later.** | Android is not cancelled, but nothing in this document is designed for it except where noted. The permission-priming screen is the one place the two platforms provably diverge (§5.6). |
| 1.5 | **Terminal mode is first class.** | Full spec in §9. It is a webview under every stack (§14.3), and that is fine. |
| 1.6 | **The PWA is retired entirely.** | Consequences in §12. |
| 1.7 | **No Capacitor upgrade.** Capacitor 6 is out of support (extended support ended 2026-01-20, current is 8.4.2) but we are deleting it, so the upgrade is wasted work. | The upgrade only made sense to keep a shipping app healthy during a transition that no longer exists. |
| 1.8 | **Distribution: TestFlight internally now, App Store eventually.** Every install assumption in this document is written against an App Store end state. | So universal links, App Clips and deferred install all behave as specified. |
| 1.9 | **No over-the-air JS updates.** | We currently get them free via the box's self-update; the native replacement gives that up rather than adopting a per-user-billed service. TestFlight is sufficient for internal testing. |
| 1.10 | **Design once, build twice is accepted.** Desktop stays web; mobile is native. Every surface is designed once and built twice. | Accepted explicitly by the human. The mitigation is structural — not process. **Corrected 2026-08-01:** this originally read "a shared logic layer and a shared token module". BET-433 measured that shared logic layer against a non-web runtime and it did not survive, so half the stated mitigation was void. The shared *token* module stands (BET-453 builds it). The shared *logic* layer is replaced by §17: the box becomes the single interpreter and both clients consume it. |
| 1.11 | **Retiring Web Push narrows notification delivery to the native app only. This is deliberate.** | Confirmed explicitly. With TestFlight-only distribution it is a real if temporary narrowing. |
| 1.12 | **The target metric is time to session list.** | Today: four screens plus a hidden disclosure. Target: one scan and two taps (§5). |

---

## 2. The stack decision — SETTLED: Swift

**Verdict: Swift/SwiftUI.** Reported 2026-08-01 by BET-431; the full record is
`docs/spike-rn-vs-swift.md` and the evidence trail is the never-merged
`spike/rn-ios` branch.

The spike stopped at its own pre-registered gate. Q3 — whether React Native
could import the shared logic layer unmodified — came back **FAIL**: the HTTP
client and the pure utilities ported cleanly, but three modules read the
Electron renderer bridge off `window` and the transcript's scroll logic is
welded to the web renderer's DOM. That is a rewrite, not a missing global. With
the reuse argument gone, React Native had no compensating advantage left.

The fidelity leg (Q1/Q2, the eight hard cases) was **never run** — stopping at a
failed gate is the designed behaviour. So this document must not be read as
saying SwiftUI renders better than React Native; it says the one decisive
argument for React Native did not survive measurement.

**Consequences:** §11 is discarded (see its header). §15.1 is closed. §1.10's
mitigation is corrected. §17 is new and follows from the same finding.

The original text of this section — the three questions and the pre-registered
pass/fail criteria — is preserved in the spike report rather than here.

### The three questions it answers

1. **Fidelity** — can React Native render Liquid Glass indistinguishably from
   SwiftUI on our two screens, side by side on one device?
2. **The transcript** — does a streaming transcript work under a glass header:
   scroll-edge effect intact, position maintained at the bottom while text grows?
3. **Reuse** — does the shared logic layer import into React Native and run
   **unmodified**?

### Why question 3 decides it

The shared layer is ~6,700 lines of behaviour-critical TypeScript with ~10,100
lines of tests:

| Module | Lines |
|---|---|
| `src/renderer/chatUtils.ts` | 2,462 |
| `src/renderer/api/httpApi.ts` | 1,059 |
| `src/renderer/store.ts` | 964 |
| `src/renderer/hooks/*` (five hooks) | 2,180 |

React Native imports it verbatim. Swift reimplements it and then maintains it
in parallel forever — every protocol change twice, every fix twice. It is not
ordinary code either: it holds the SSE fan-out with per-directory streams, the
delta buffering and flush boundaries, the queued-message drain and its abort
semantics, and the pin-to-bottom algorithm on its fourth iteration. `AGENTS.md`
carries "do not regress this" notes on most of it, from bugs found through
incidents.

**If it does not import cleanly, the main argument for React Native collapses
and the answer is Swift.** BET-433 is the gate.

### The state of the argument as of 2026-07-31

The case narrowed once "iOS first" was decided, because React Native's headline
advantage — one codebase, two platforms — is deferred and uncertain. Set
against that:

- **For Swift:** SwiftUI renders Liquid Glass completely and natively on day
  one. React Native reaches it through `expo-glass-effect` and native
  components that were still in alpha ten months after iOS 26 shipped (§14.2).
- **For React Native:** the logic layer above, plus a shared markdown parser
  (only the renderer differs), plus one language across desktop, server, tools
  and mobile.
- **Neutral:** the terminal is a webview either way (§14.3).

Most of the documented React Native seams cluster around **native tab bars**,
which this design does not use — the session list uses a floating capsule, not
tabs. The seam that does bite is that scroll-edge effects require the scroll
view be the direct child, which constrains the transcript.

**Recorded recommendation going into the spike: React Native, with two
conditions (§11.1, §11.2). Confidence: moderate, not high. The spike exists
because it is close.**

---

## 3. Design language

### 3.1 Direction D — native glass. Chosen.

The app adopts Apple's current design language (Liquid Glass, iOS 26+) rather
than a custom design system. Three alternatives were built and rejected (§13.1).

**The reason this matters more than taste:** Liquid Glass is an OS-rendered
material, not a style. A webview can imitate a frosted blur; it cannot do
lensing, adaptive shadow, the light/dark flip against background luminance, the
scroll edge effect, or the fingertip glow. Adopting the platform language is
therefore also the strongest justification for going native at all.

### 3.2 The rules that fall out — all binding

| # | Rule | Consequence for us |
|---|---|---|
| 3.2.1 | **Two-layer model: content vs controls.** Content is edge-to-edge and scrolls under everything. Controls float above and are made of glass. | Transcript, rows, cards and code blocks are content and use plain fills. Glass is only bars, sheets, menus, and the floating composer capsule. |
| 3.2.2 | **The content layer never uses glass.** | Explicit Apple rule. Applying glass to content "causes unnecessary complexity and a confusing visual hierarchy". |
| 3.2.3 | **Never glass on glass.** | Anything sitting on a bar uses transparency and vibrancy, not a second pane. This kills the "card inside a sheet" pattern. |
| 3.2.4 | **Bars have no background and no divider.** | Legibility comes from the system scroll-edge effect. **Never draw a gradient to imitate it** — if it does not appear, that is a bug to fix or a finding to record, not something to fake. |
| 3.2.5 | **One tinted action per view.** | Accent goes on the primary button, the running status dot, and the selected tab. Everything else is monochrome and takes colour from the material. Apple: "when every element is tinted, nothing stands out." |
| 3.2.6 | **Brand colour lives in the content layer, in the scroll view.** | So the glass picks it up dynamically as content moves under it. Replaces the old pattern of a solid coloured top bar. |
| 3.2.7 | **Buttons are capsules by default.** | |
| 3.2.8 | **Concentric radii: inner radius = parent radius − padding.** | Apple ships `ConcentricRectangle` so this is not hard-coded. Getting it wrong reads as "pinched" or "flared" corners and is a large part of why a UI looks subtly cheap. |
| 3.2.9 | **Section headers are Title Case at body size, not uppercase micro-caps.** | iOS 26 changed this. Every uppercase label in the current app is a dated tell. |
| 3.2.10 | **Onboarding and alert typography is bolder and left-aligned.** | Apple refined this specifically for "alerts and onboarding". Centred alert copy is out. |
| 3.2.11 | **Ship dark variants even for light-only surfaces.** | The material itself flips dark under bright content. We already have both palettes. |
| 3.2.12 | **Must be legible at both ends of the iOS 27 glass slider.** | iOS 27 made glass a continuous user preference from ultra-clear to fully tinted. Practically: never rely on the material for contrast. |
| 3.2.13 | **Test Reduce Transparency, Increase Contrast and Reduce Motion.** | Free if we use system components. The transcript is ours, so it is the one that must be checked. |
| 3.2.14 | **Search and primary actions go at the bottom, in thumb reach.** | Apple: "place search at the bottom if there's room." Settings, Mail and Notes all do. |

### 3.3 Where desktop/mobile consistency lives

**Not in identical chrome.** Desktop cannot have a floating glass tab bar and
should not try. Consistency lives in:

- the same colour tokens (§4)
- the same lucide icon set
- the same status vocabulary — running / needs you / idle
- the same session-header contents
- the same transcript anatomy

This is also what every Apple Design Award winner does: unmistakable brand in
the content layer, stock platform chrome around it. Apple's guidance is to
spend custom-component effort on **one hero surface**; ours is the transcript.

### 3.4 Icons

**Lucide, the same set as desktop.** Stroked, `currentColor`, 16px at 2px
stroke as the default, 20px standalone, 14px inline with text.

**No emoji anywhere in the chrome.** Emoji stay where they are content — a
user's message, a commit body. The current mobile client has more emoji-as-icon
than desktop did.

---

## 4. Design tokens

Inherited verbatim from BET-406 (BET-407 / BET-409). **Mobile does not invent a
palette.** If mobile re-declared colours the two clients would drift within a
month — which is exactly what `mobile.css` does today.

### 4.1 Dark

```
canvas       #0B1020    panel        #0F1526    card         #151C33
raised       #1C2440    inset        #070B16
borderSubtle #222C49    border       #33406B    borderStrong #5E6C9B
tx1          #F2F5FA    tx2          #BDC7DB    tx3          #939FB8    tx4 #6B7690
accent       #5A88FF    accentTx     #7BA0FF    accentSolid  #5A88FF    onAccent #0B1020
ok           #3DD9A4    warn         #F0A934    danger       #FF6B7A    info #49D7F5
okBg         #3DD9A41f  warnBg       #F0A9341f  dangerBg     #FF6B7A1f  accentBg #5A88FF1f
fill         rgba(255,255,255,.04)
fillHover    rgba(255,255,255,.07)
fillActive   rgba(255,255,255,.10)
```

### 4.2 Light

```
canvas       #FAF9F7    panel        #F2F0EC    card         #FFFFFF
raised       #EAE7E1    inset        #F5F3EF
borderSubtle #E8E4DD    border       #DAD5CC    borderStrong #857C6E
tx1          #1A1815    tx2          #48433C    tx3          #665F55    tx4 #8A8275
accent       #2E6BFF    accentTx     #1F55D6    accentSolid  #1F55D6    onAccent #FFFFFF
ok           #0A7A53    warn         #8A5A08    danger       #BE2F3C    info #0B6E85
okBg         #0A7A5314  warnBg       #8A5A0814  dangerBg     #BE2F3C14  accentBg #2E6BFF14
fill         rgba(26,24,21,.035)
fillHover    rgba(26,24,21,.06)
fillActive   rgba(26,24,21,.09)
```

**The governing colour rule:** neutrals change temperature between themes (warm
light, cool dark); **the accent hue never does**. `accentSolid` exists
specifically for filled controls — white on `#2E6BFF` scored 4.50:1, passing by
0.00; `#1F55D6` takes it to 6.00:1.

**System rule:** anything placed on a filled surface derives from
`currentColor`, never from canvas-relative tokens.

### 4.3 Spacing, radii, easing

Inherited from BET-406. Spacing is a 4px grid, nine steps: 4, 8, 12, 16, 20,
24, 32, 40, 48. Radii: 4, 6, 8, 12, 16, plus full. Easing token
`cubic-bezier(.22,1,.36,1)`.

**Mobile deviates on radii** per §3.2.7 and §3.2.8 — capsules for buttons and
bars, 20–28 for cards and sheets, and concentric derivation for nesting.
Apple publishes no numeric radius values for iOS; derive rather than pick.

### 4.4 Typography

**The desktop type scale does not carry over.** Mobile uses iOS Dynamic Type.

| Style | Weight | Size | Leading |
|---|---|---|---|
| Large Title | Regular | 34 | 41 |
| Title 1 | Regular | 28 | 34 |
| Title 2 | Regular | 22 | 28 |
| Title 3 | Regular | 20 | 25 |
| Headline | Semibold | 17 | 22 |
| Body | Regular | 17 | 22 |
| Callout | Regular | 16 | 21 |
| Subhead | Regular | 15 | 20 |
| Footnote | Regular | 13 | 18 |
| Caption 1 | Regular | 12 | 16 |
| Caption 2 | Regular | 11 | 13 |

Range: xSmall Body 14/19 → AX5 Body 53/62. The scale did **not** change in iOS
26 — only its application did (§3.2.10).

**Two typefaces, as desktop:** Inter for language, JetBrains Mono for code,
paths, IDs, timers and token counts. Tracking is negative and increasingly so
as size grows.

**The 72ch measure cap does not apply.** A phone is ~38ch at 17pt. The
constraint moves to line-length-under-Dynamic-Type instead (§10.2).

---

## 5. Onboarding

**Shape: one scan, two taps, in.** Everything that could be removed was.

### 5.1 The flow

| Step | User action | Why it cannot be removed |
|---|---|---|
| Scan | Point the camera at the desktop | The entry point. Zero taps in the app. |
| Link | **One tap**, after matching four characters | Without it, a QR from a message or web page can link the phone to someone else's machine (§6.2). |
| Notifications | **One tap** | Being told when the agent stops *is* the mobile product. Asking later means the first time it matters, it does not work. |
| Session list | — | — |

### 5.2 Decisions

| # | Decision | Reasoning |
|---|---|---|
| 5.2.1 | **The QR encodes a universal link**, `https://app.mantaui.com/p/<nonce>`, not `manta://`. | A custom scheme has exactly one outcome and no ownership verification — any app can claim it. A universal link falls back to a real page when the app is not installed. Three good outcomes instead of one. |
| 5.2.2 | **The link navigates to a confirmation screen. It never completes a pairing.** | Apple's own universal-link guidance: limit link-reachable actions to those that do not risk user data. |
| 5.2.3 | **Nothing is tunnelled through the App Store install.** The desktop code stays live and rotating; the fallback page says "scan it again". | Nothing survives an App Store install except an App Clip (§14.4). One extra scan, 100% reliable, no SDK, no pasteboard banner, no tracking consent. |
| 5.2.4 | **The model-connection step is cut.** | Desktop onboarding makes a model a hard gate, and mobile cannot exist without desktop, so a paired box always has one. **Refinement:** that is true at setup time, not forever — credentials expire and get revoked. So it becomes an **error state inside the app**, surfaced when a turn fails, not a question at first run. |
| 5.2.5 | **The notification permission ask is in onboarding**, not deferred. | Apple explicitly permits integrating a permission request into onboarding when the app needs it to function, and this one does. |
| 5.2.6 | **No icon or badge at the top of any step header.** | Matches Apple's refinement of onboarding typography toward bolder, left-aligned text with no decorative lead-in. |
| 5.2.7 | **The box name never appears in a headline.** It appears as data inside the confirmation card, where it is load-bearing for security, and nowhere else. | No "dev is linked", no "your box is ready — dev". |
| 5.2.8 | **No completion screen.** After notifications, the user lands directly on the session list. | No "you're all set", no celebration, no final button. |
| 5.2.9 | **Manual entry asks for six digits only.** The 32-hex box ID is gone — the code identifies the box and the server resolves it. | Today this screen demands 38 typed characters on a phone keyboard, and it is the screen people reach when the happy path has already failed. |
| 5.2.10 | **A desktop-free path must always exist.** | App Store guideline 4.2.3(i): "your app should work on its own without requiring installation of another app to function." The desktop QR is an accelerator, never a dependency. |

### 5.3 Screens and copy

All copy is final. Mockup has every state rendered.

**Scan (desktop side).** Header "Add a phone". Body: "Point your phone's camera
at this code. It refreshes on its own every five minutes." Below the QR:
"Verification code" + the four characters, then "Your phone will show the same
four characters. Only tap Link if they match." Pills: "expires in 4:41" and
"already installed? scan again".

**Link.** Heading "Link this phone?" Sub: "It'll be able to run commands on the
machine below." Card: status dot, "Your box", the host address in mono. Divider.
"Match the code on your desktop" + the four characters. Primary button "Link
this phone". Text link "Codes don't match".

**Linking (progress).** Heading "Linking". Sub "A couple of seconds." Stage
list: "Reached your box" / "Verified the code" / "Saving credentials". Footer:
"Credentials stay on this phone and on your box."

**Notifications.** Heading "Know when it needs you". Sub: "Agents stop for
permission, ask questions, and finish while you're somewhere else. This is the
point of having Manta on your phone." Card lists three rows: "Permission needed
to run a command" (warn shield), "A question is blocking the turn" (accent
alert), "A long turn finished" (ok check). Button "Continue" (iOS) /
"Turn on notifications" + "Not now" (Android).

**Not installed (web fallback page).** Heading "Get the app to finish". Sub:
"Your box is waiting. Install Manta, then scan the code on your desktop again."
Button "Get Manta". Card: "Prefer to type it?" + the six digits + "expires in
4:12".

**Manual.** Heading "Enter the code". Sub: "Read the six digits off your
desktop, or run `manta pair` on the box." Six-cell OTP. Resolved-box card:
"Box found" + host + check. Button "Continue". Link "My box isn't reachable
from the internet" (reveals the server URL field — the tailnet escape hatch).

### 5.4 Failure states

The house style is the desktop preflight card: **`{cause, action}` pairs, never
one generic "something went wrong"**, and always a sentence saying nothing
changed.

**Expired.** "That code expired" / "Codes last five minutes. **Nothing was
linked and nothing changed.**" Card: "Your desktop already has a new one — it
refreshes on its own. Scan it again." Buttons: "Scan again", "Enter a code
instead".

**Codes don't match.** "Don't link this" / "If your desktop doesn't show K7 Q2,
this code didn't come from your machine." Danger card: "Someone may have sent
you a code that links your phone to their machine — or theirs to yours. Only
ever scan a code you can see on your own screen." Buttons: "Cancel", "Let me
look again". **Reachable only from the link on the confirm screen — never
auto-triggered, because the app cannot know what the desktop shows. The human is
the comparator.**

**Unreachable.** "Can't reach your box" / "The code is valid but nothing
answered. **Nothing was linked.**" Two `{cause, action}` rows: "It may be
asleep — check it's powered on and the server is running"; "Or this network
blocks it — try cellular instead of Wi-Fi." Buttons: "Try again", "Copy
diagnostics".

**"Nothing was linked and nothing changed" is the most valuable sentence in a
failure screen.** Without it a failed pair reads as a broken box and the user
goes looking for a problem that does not exist.

### 5.5 Zero state

**The composer is the zero state.** No sessions yet → heading "No sessions
yet", sub "Pick a folder on your box and say what you want to do", and a
floating composer with a folder picker row above the input. You do not create a
session; you write the first message and one appears. Same decision as desktop.

### 5.6 The notification screen forks per platform — the only one that does

| | iOS | Android |
|---|---|---|
| Buttons | **Exactly one**, and it opens the system alert | Primary **plus a cancel** |
| Label | Must **not** be "Allow". Use "Continue" | "Turn on notifications" / "Not now" |
| Escape | **None.** No dismiss, no cancel, no way out | Required |

Apple: a custom screen that "takes advantage of such behaviors to influence
choices **will lead to rejection by App Store review**." Google: "always provide
the option to cancel an educational UI flow." These are directly opposed.
**A shared component with a cancel on iOS is a rejection; without one on
Android it violates Google's stated principle.**

**Hard constraint either way — guideline 5.1.2(i):** no functionality may be
gated on granting a system permission. Denying notifications must land the user
in the session list exactly as accepting does. The only difference is a quiet,
dismissible reminder in Settings.

**Provisional authorization is the wrong tool here** and was considered and
rejected: it grants silently with no prompt, but the notifications never make a
sound and never appear on the lock screen — useless for a blocked agent. Keep
it as a possible second chance after an explicit denial, never the first ask.

---

## 6. Pairing and device security

### 6.1 Already correct today

- The payload is a short-lived single-use nonce, not a bearer token.
- The code is generated by the **already-authenticated** side (desktop) and
  claimed by the joiner. This is structurally safer than Signal's, where the QR
  *grants* access.

### 6.2 The threat model — this is why the confirm screen exists

In February 2025 Google's threat-intelligence group published a campaign in
which Russia-aligned actors abused **Signal's linked-devices feature** at scale.
Fake "group invite" pages replaced the normal redirect with a device-linking URL
pointing at an attacker-controlled instance, so **the victim's own device
performs the link**. Malicious QRs were disguised as group invites, security
alerts, and Signal's own pairing instructions. It was also used as a
close-access technique on captured phones.

Their assessment of why it worked: *"a low-signature form of initial access due
to the lack of centralized, technology-driven detections and defenses… when
successful, there is a high risk that a compromise can go unnoticed for extended
periods."*

### 6.3 What we add

| Their recommended mitigation | Our implementation |
|---|---|
| Two-factor confirmation when linking a new device | A four-character code shown identically on both screens; the user confirms they match. The attacker controls the phone's view, never the desktop's. |
| Show what is being linked, in human terms | The confirm screen names the machine and the access being granted |
| Audit linked devices regularly | A linked-device list with last-seen and one-tap revoke, plus a push to existing devices on every new pairing. The push pipeline already exists. |
| Short-lived, single-use provisioning | Five-minute TTL, invalidated on first claim, auto-rotating while the panel is open |

### 6.4 Lifetimes

| Thing | Value |
|---|---|
| Pairing nonce TTL | 5 minutes, single use, invalidated on first claim |
| Desktop QR rotation | Automatic on expiry while the panel is open |
| Device token idle expiry | 90 days unused → revoked (Home Assistant's default) |
| Revocation | Immediate, from any linked device or the desktop |

### 6.5 Optional hardening — recommended, not yet committed

Have the QR carry a **phone-generated public key** so the box encrypts the token
*to that phone*. An intercepted or photographed QR then grants nothing at all,
and the code comparison becomes belt-and-braces rather than the only defence.
This is Signal's own `pub_key` provisioning shape.

**Worth noting the strongest possible position:** Syncthing's device ID is
deliberately public — "the IDs are not sensitive" — because pairing requires
*both* devices to add each other. Our desktop-confirms-the-phone step gets most
of the way there.

### 6.6 App Clips — agreed, deferred by necessity

An App Clip is a slice of the app under 15 MB that iOS runs **without installing
anything**, launched from a QR. It pairs for real, writes the token to a shared
keychain (iOS 15.4+) or App Group container — which Apple documents for exactly
this case — and the full app reads it on first launch and opens straight to the
session list. **No second scan.** It is the only Apple-sanctioned way to carry a
credential through an App Store install.

**It cannot be built before the app is live on the App Store** — default and
demo App Clip links can only be tested once the app and clip have passed review.
So it is a follow-up by necessity, not preference.

Constraints to carry into that issue:

- **15 MB uncompressed.** The 100 MB tier explicitly forbids App Clip Codes, QR
  codes and NFC — physical invocations — which is the entire use case.
- Needs an **advanced App Clip experience** plus a per-domain
  `apple-app-site-association` carrying the `appclips` key. That service is the
  one that **cannot use a wildcard subdomain**.
- A random 128-bit nonce is **hostile to the App Clip Code encoder**. Use short
  opaque IDs from a compact alphabet, or a plain QR — plain QR works with
  advanced experiences and has no encoding limit.
- No background activity, no BSD sockets, no Face ID, IDFA and IDFV both return
  empty strings. None of these bite for a pairing screen.
- **Android has no equivalent** — Google shut down Instant Apps. The web
  fallback page must exist regardless.

---

## 7. Session list and actions

### 7.1 List anatomy

- **Group** = project (the tmux session). Header in Title Case, 15px/600,
  tracking −0.015em, colour `tx2`, 22px above / 6px below, padding-left 12.
- **Row** = window. Min height 62, padding 0 12, radius 20, margin-bottom 2.
  Slots: `[status dot] [name + optional subtitle] [timer]`.
  - dot 8×8: running → `accent`, needs-you → `warn`, idle → `tx4`
  - name 15.5px/500, tracking −0.01em, `tx1`, one line, ellipsis
  - subtitle 12px/500 `tx4`, only when present ("running · opus 4.8", "needs you")
  - timer 11px/500 mono `tx4`, tabular figures
- **No divider lines.** The most recently active row gets background `fill`;
  selection is carried by elevation and fill, not by a rule.
- Large title "Sessions" that collapses into the glass header on scroll.
- Floating glass capsule at the bottom: search placeholder + a filled accent
  circular "+" button.

### 7.2 Actions — final

| Gesture | Does | Reasoning |
|---|---|---|
| **Tap** | Open | — |
| **Swipe left** (trailing) | **Delete.** Full-swipe commits. | Trailing is the destructive side by iOS convention. |
| **Swipe right** (leading) | **Pin / Unpin.** Full-swipe commits. | Leading is the positive side. Pin is already a concept desktop introduced in the same redesign, so it costs nothing new, and it is the action most taken after opening. |
| **Long-press** | Native context menu: **Rename · Pin · Fork**, separator, **Delete** | Apple: "always make context menu items available in the main interface too." Destructive goes at the **end** of a context menu — the opposite of an action sheet, where it goes at the top. |

### 7.3 Delete behaviour

- **Idle session → delete immediately with a 5-second undo.** The RPC is held
  and only fires when the toast expires. A confirm dialog on every delete makes
  the common case slow to punish the rare one; undo is the reverse, and it also
  makes a full-swipe safe to commit.
- **Running session → confirm.** Deleting a running session kills a live turn
  and the work in it; that is not recoverable by holding an RPC. The confirm
  names what is being interrupted: "this will stop a turn that's been running 4
  minutes".

### 7.4 Haptics

Per Apple's taxonomy, and sparingly — "the best haptic experience is one people
may not be conscious of, but miss when it's turned off":

- light **impact** when a swipe passes the commit threshold
- **warning** notification when the destructive confirm appears for a running session
- **success** notification when a delete finally lands
- **selection** tick only where a value crosses discrete steps

Must be user-disableable.

### 7.5 Explicitly not in the list row

- **Mute notifications — CUT.** Verified 2026-07-31: `src/server/push.mjs` has
  no per-session suppression of any kind. Routing is `classifyPushEvent` →
  `routeNotification` → device presence, with no session-level filter. It would
  be a new server concept; out of scope.
- **Copy path — CUT.** Low value on a phone.
- **Compact and Clear** stay in the chat screen's overflow menu, where you can
  see what you are compacting.

### 7.6 Accessibility constraint on gestures

**Every swipe action must also exist somewhere non-swipe** — WCAG 2.5.7
Dragging Movements, AA, new in 2.2. The context menu is that path, which is why
it carries everything rather than a subset.

---

## 8. Chat screen

- Native header, transparent, no large title. Custom two-line centred title:
  session name 14.5px/600 tracking −0.01em `tx1` with ellipsis; below it
  11px/500 `tx4` of the form "running · 2m · 8%", with the word "running" in
  `accentTx` when busy, falling back to "idle".
- Leading and trailing 38×38 circular glass buttons: ChevronLeft, MoreHorizontal.
- **Session status lives in the header subtitle** — which is exactly where
  BET-406 phase 7 is moving it on desktop. The two clients converge.
- **Transcript is full-bleed** to both edges and behind both bars.
- **User message**: right-aligned, background `accentSolid`, text `onAccent`,
  15px/1.5, padding 11/15, max-width 82%, margin-bottom 22, asymmetric radii
  22/22/6/22.
- **Assistant text**: full width, `tx1`, 15px/1.6, margin-bottom 12.
- **Tool row**: background `fill`, radius 12, padding 11/13, mono 12.5px `tx2`,
  leading 12px icon — Check in `ok` when complete, spinner in `accentTx` while
  running.
- **Composer is a floating glass capsule**, not a docked strip: left 14, right
  14, bottom 12, height 56, radius 28. Paperclip, placeholder "Message", mic,
  and a 40×40 filled accent circle with Send. The transcript keeps its full
  height and the last message is visible through the capsule.
- The overflow sheet is a real sheet: rests at half height, drags to full,
  flicks away, dims the screen behind proportionally, grabber functional.
  Contents: Attach photo or file · Scheduled tasks (with live count) · Secrets ·
  Fork session · Open terminal · Delete session (destructive).

**Native alerts and action sheets replace `window.confirm`.** The webview
stamps "app.mantaui.com says:" on every dialog and there is no way to remove it
— the single loudest tell in the current app. Apple's rule is also a decision
procedure: **an alert is for the unexpected; an action sheet is the consequence
of something the user just chose.** Clear-session is an action sheet.
Destructive item at the **top** of an action sheet, Cancel detached at the
bottom.

---

## 9. Terminal mode

**First class, per explicit decision.** It is a webview under every stack, and
this is the one screen where that genuinely does not matter — a terminal is
full-bleed with no navigation chrome, so there is nothing for the platform to
render differently. The native work is everything *around* the text.

### 9.1 What is missing today

| Gap | Consequence |
|---|---|
| **No modifier keys** | **Ctrl-C is unreachable. You cannot interrupt a running process from the phone at all.** This alone makes terminal mode unusable for its main job. |
| No tab, no arrows in terminal mode | No completion, no history, no navigating a TUI |
| The keyboard bar is chat-only | Terminal falls back to the raw system keyboard |
| No font size control | A fixed size that is either unreadable or wastes half the columns |
| Landscape untested | Which is the orientation you would actually use for 80 columns |
| No hardware keyboard handling | An iPad with a Magic Keyboard is the best case for this feature and it is unhandled |

### 9.2 Spec

| Item | Behaviour |
|---|---|
| **Key row** | Native, not in the webview — so it is a real keyboard accessory view and tracks the keyboard's own animation exactly. First row: `esc · ctrl · tab · ↑ ↓ ← →`. Second row, horizontally scrollable: `\| ~ / - _ : $` — the characters buried three taps deep on the iOS keyboard and constant in a shell. |
| **Sticky modifiers** | `ctrl` latches on tap, lights up, applies to the next keypress, then releases. Double-tap to lock. Same for `alt` if added. |
| **esc** | Tinted red while a process is running, matching the chat bar. It is the interrupt. |
| **Keyboard closed** | The key row collapses to a floating glass bar with four controls: interrupt, paste, show keyboard, dictate. |
| **Pinch to zoom** | Changes font size and re-fits columns. Persisted per device, not per session. Announce the resulting size briefly. |
| **Selection and copy** | Long-press enters selection with native handles; copy to the system clipboard. Paste from the floating bar, the key row, and the system menu. |
| **Hardware keyboard** | Full pass-through including modifiers. The key row hides itself when one is attached. |
| **Landscape** | Key row moves to the trailing edge so it does not eat rows. Locking portrait would also be a straight WCAG 1.3.4 failure. |
| **Reattach** | The pane is a tmux window, so backgrounding loses nothing. On foreground, reattach and repaint rather than reconnecting from scratch. |
| **Chrome** | Header shows the window name and the live geometry (`80×24`) — the number you need when a TUI renders wrong, currently invisible everywhere. |

---

## 10. Accessibility

### 10.1 Touch targets

**House rule: 48×48 minimum hit area.** Clears WCAG 2.5.8 AA (24×24 CSS px)
with margin, clears Apple's 44pt recommendation, equals Google's 48dp, and sits
inside the 7–10mm physical band.

Reference points:
- WCAG **2.5.8** (AA, new in 2.2): 24×24 CSS px, **with a spacing exception** —
  an undersized target passes if a 24px-diameter circle centred on it does not
  intersect another. In practice: a 20×20 icon button is fine at ≥24px
  centre-to-centre.
- WCAG **2.5.5** (AAA): 44×44, no spacing exception.
- Apple: 44×44pt recommended, 28×28pt documented minimum. "Consider spacing
  between controls as important as size."
- Google: 48×48dp, ≥8dp between targets.

**The fix is fewer controls, not bigger ones.** The icon stays 20px; the hit
area is 48. Those are different things and only one is visible. Today's header
has three 36px targets 2px apart — schedules and secrets move into the overflow
sheet where they already live, leaving two targets with room around them.

**Caveat:** W3C's *WCAG2Mobile* lists SC 2.5.8 as "Placeholder — Work In
Progress" and is itself a Group Draft Note. There is no W3C-normative CSS-pixel
→ native-unit mapping. Use the platform numbers; do not over-claim conformance.

### 10.2 Text size — the policy

**We design at 17pt. We do not design at 53pt.** That number is the user's own
OS setting at maximum and almost nobody sets it there. The requirement is that
the layout does not break if someone chooses it.

| | Policy |
|---|---|
| Design size | 17pt body |
| What scales | The user's setting multiplies it. On React Native this is on by default. |
| Design work | Three things: no fixed row heights, names wrap instead of truncating, rows grow taller. |
| **Caps** | **List rows and chrome cap at 1.4×. The header caps at 1.2×. The transcript is uncapped** — reading the agent's output is the one place someone genuinely wants it as large as they asked for. |
| Realistic case | One or two steps up, not AX5. AX5 is a stress test checked on a PR, not a design target. |

Body ranges 17pt → 53pt, a 3.1× range. Nobody supports 3.1× on a navigation
bar; capping is what quality apps do. Today the client ignores the setting
entirely.

### 10.3 The streaming transcript — the highest-risk surface

Failure modes in severity order, with the correct pattern:

1. **Token-level streaming inside a live region.** Text mutating every ~30ms
   produces a firehose of partial words on `polite`; on `assertive` it is
   catastrophic, because by definition each token clears the queue of the one
   before — the user hears the last fragment of a 900-word answer and nothing
   else.
   **Correct:** the streaming node is **not** a live region. Stream into a
   container marked busy; on completion clear busy and announce a short
   *summary* in a separate polite region — "Assistant replied, three
   paragraphs." The body stays readable by normal navigation.
2. **Re-announcing the whole transcript** when atomic is set or inherited.
   **Correct:** atomic false, relevant = additions only.
3. **Focus stolen by auto-scroll.** WCAG 4.1.3 requires status be conveyed
   *without* receiving focus. **Scroll the viewport; never move focus.**
4. **Authorship conveyed only by alignment and colour.** Right-aligned accent
   bubbles are exactly that. **Each turn needs a programmatic speaker label.**
5. **Per-tick spinner announcements** — worse than silence. Announce state
   *transitions* only: idle → generating → complete/error, debounced.
6. **Long code lines forcing horizontal page scroll.** WCAG 1.4.10 — a code
   block is not on the exemption list. Scope horizontal scroll to the block.
7. **No bypass** from the top of a 200-message transcript. WCAG 2.4.1 — provide
   a skip-to-composer path.

### 10.4 The rest of the floor

| Criterion | Level | Meaning here |
|---|---|---|
| 1.4.12 Text Spacing | AA | Survive line-height 1.5×, paragraph 2×, letter 0.12×, word 0.16×. A **resilience** test, not a styling spec. Fixed-height containers with clipped overflow are the standard failure. |
| 1.3.4 Orientation | AA | **Do not lock portrait.** Not essential for a chat app, and it matters for users who mount a device in fixed landscape for motor-accessibility reasons. |
| 2.5.7 Dragging Movements | AA (new in 2.2) | Every drag needs a single-pointer alternative — swipe-to-delete, drag-to-reorder, **drag-to-resize a sheet**. A native sheet inherits the user-agent exception; a hand-rolled one does not. |
| 2.4.11 Focus Not Obscured | AA (new in 2.2) | The keyboard must not fully cover the focused field. |
| 3.3.8 Accessible Authentication | AA (new in 2.2) | **Blocking paste in the OTP field is a failure.** Keep one-time-code autofill. |
| 1.4.11 Non-text Contrast | AA | 3:1 for input borders, toggle tracks, icon-only buttons, status dots. Styling our own inputs forfeits the user-agent exception. |
| 2.5.3 Label in Name | A | The accessible name must contain the visible label, or Voice Control ("tap Send") fails. |
| 2.5.4 Motion Actuation | A | Two obligations if shake gestures are ever added: an on-screen equivalent **and** a way to disable. |

Using system components covers Reduce Transparency, Increase Contrast and
Reduce Motion for free. **The transcript is ours, so it is the one that must be
checked.**

---

## 11. Build decisions — DISCARDED (React Native only)

> **This section is dead.** The spike returned Swift (§2), and §15.1 prescribed
> that §11 is discarded in that case. It is kept, unedited, only so a reader who
> finds a reference to it elsewhere can see what it said and why it no longer
> applies. **Nothing below is in force.** Do not implement, cite or re-open it.

### Original text — React Native only, not in force

| # | Decision | Reasoning |
|---|---|---|
| 11.1 | **No NativeWind.** A shared token module feeds a typed theme; styles are plain objects. | NativeWind stable pins Tailwind v3, and v4 support has sat in a preview marked not-for-production since September 2025. It also bakes colour opacity statically, which fights variable-driven theming. Avoiding it also sidesteps the Reanimated memory regression, since we only pull that in if needed. |
| 11.2 | **Write our own markdown renderer.** Parsing is shared with desktop; only rendering differs. | The leading RN markdown library has not published to npm since December 2023; the leading syntax highlighter died in 2019. But we do not need a general one — **we control the markdown the agent emits.** A purpose-built renderer streams by block without re-parsing the document, and makes tool cards, diffs and todo lists first-class node types instead of HTML we style afterwards. |
| 11.3 | **One token source of truth** emitting the palette, type scale, spacing and radii as CSS variables for desktop *and* a typed theme object for native. | Kills the drift where mobile re-declares colours. Valuable on its own merits even if nothing else happens. |
| 11.4 | **The logic layer is shared and the view layer forks — enforced, not aspirational.** The test is mechanical: **the native view layer imports zero DOM.** | Most of it already passes. Finishing the extraction turns "rewrite the chat" into "write a second view for an existing engine". |
| 11.5 | **Syntax highlighting** via a shared TypeScript tokenizer rendering styled text runs. | One theme, one grammar set, both platforms. |
| 11.6 | **Keep the chrome stock and shallow.** | Two screens deep, no tab bar. Most documented RN glass seams cluster around native tab bars, which this design does not use. |
| 11.7 | **Use platform colour objects rather than computing contrast.** | There is no callback when the glass material inverts icon colours; computing it is not possible. |

### 11.8 Known RN seams to design around

- You **cannot measure the tab bar height**. (We have no tab bar.)
- **No callback** when glass inverts icon/label colour — use `DynamicColorIOS` /
  `PlatformColor`.
- `FlatList` breaks scroll-to-top, minimize-on-scroll and scroll-edge detection
  under native chrome. **Use FlashList.**
- Scroll-edge effects only work if the scroll view is the **literal first
  child**; otherwise mark the wrapper non-collapsable.
- `expo-glass-effect`: `opacity: 0` on the view **or any parent** kills the
  effect entirely. Animate `glassEffectStyle` instead.
- Importing `react-native-reanimated` raises memory 25–30% even if unused, under
  Hermes V1 on RN 0.85/0.86.
- Glass morphing between arbitrary views (button → sheet) is not a documented
  general RN capability.

---

## 12. What gets deleted

| Goes | Consequence |
|---|---|
| The Capacitor wrapper — Android and iOS shells, plugins, config | No Capacitor 6→8 upgrade needed |
| The mobile web client — shell screens, settings, create sheet, keyboard bar, connecting and pairing screens (~3,400 lines) | Rewritten natively. This is the part that *should* be rewritten — every native-feel gap lives here. |
| **`src/renderer/mobile/mobile.css` (450 lines)** | **The quiet win.** It reshapes shared desktop components through named hooks and two fragile positional selectors that match on Tailwind class substrings. It disappears entirely, which **discharges the top-severity risk in BET-406's own risk table by deletion rather than by contract** — the hook-class list that epic owed mobile and never wrote is no longer needed. |
| The six window-level CustomEvent channels between the mobile shell and the shared chat panel | They exist only because mobile cannot pass props into a component it mounts opaquely. Natively they are ordinary props. |
| The mobile bundle build, the CI publish workflow, the release-host tarball, and the box's self-update fetch of it | The box stops serving a web client. One fewer deploy path, one fewer thing that can be stale on a device. |
| The PWA — service worker, manifest, install instructions, Web Push registration | Push moves entirely to APNs through the native app. One delivery path instead of two. |

**What survives untouched:** the whole logic layer — transport and HTTP client,
SSE fan-out and per-directory stream handling, delta buffering and flush
boundaries, the queued-message drain, todo/permission/question state, token
accounting, the store, and the shared pure helpers.

---

## 13. Rejected — do not re-litigate

### 13.1 Visual directions

| Direction | Why rejected |
|---|---|
| **A · Framed** — 1px borders, 8–12px radii, 23px display, bordered cards everywhere | This was BET-406's desktop language ported literally. Correct for iOS 16, dated now: opaque bars, hard dividers, uppercase micro-labels, rounded-rect buttons. Reads as a settings form. |
| **B · Elevated** — no borders, soft glow, 29px display, 22px radii, blurred chrome | A coherent modern custom system, and the best one I could draw. Rejected because it is a system we would own and keep in step with a platform that moves under us, and because its blurred header is an *imitation* of a material the OS renders natively. |
| **C · Editorial** — 33px display, hairlines only, accent as a thin marker, maximum air | Beautiful on a single-decision screen, thin on a dense list (loses a row per screen), and carries authorship by alignment and a coloured rule — a WCAG 1.3.3 / 1.4.1 problem unless each turn also carries a programmatic speaker label. |

### 13.2 Product and platform

| Rejected | Why |
|---|---|
| **PWA / Add to Home Screen as a product** | Dropped by decision. Going native removes it as a concept anyway. |
| **Keeping Web Push** | Deliberately narrowed to the native app only. |
| **Capacitor 6 → 8 upgrade** | Only made sense to keep a shipping app healthy during a transition that no longer exists. |
| **A transition period / phased migration** | Explicitly rejected — we are in internal testing and can afford to nuke the existing client. |
| **RN shell with the chat in a WebView** (the "Blink architecture") | Considered as both a destination and a waypoint. As a destination it is the worst of both: native edges around a web middle, plus a bridge, plus a third rendering to maintain — and the chat transcript is where every scroll, selection and tap lands. As a waypoint it was viable, but the no-transition decision removed the need for one. |
| **Model-connection step in mobile onboarding** | A paired box always has a model, because desktop onboarding gates on it. Became an in-app error state instead. |
| **Per-session mute** | No server routing exists (verified 2026-07-31). Out of scope. |
| **Copy path in the row context menu** | Low value on a phone. |
| **A completion / "you're all set" screen** | Removed to shorten time to session list. |
| **Deferred deep linking via pasteboard, or an attribution SDK** | Pasteboard shows a user-visible "pasted from" banner since iOS 14. Attribution SDKs need tracking consent post-ATT and put a third party inside the trust boundary of a self-hosted product. **Re-scan instead.** |
| **Custom Product Pages as a payload carrier** | The deep-link destination is static per page, not per user. Fine for marketing, useless for pairing. |
| **TestFlight as an onboarding channel** | Needs the TestFlight app installed first, builds expire after 90 days, external testing needs Beta App Review, and no documented way to carry a payload. It is a pre-release channel, not an onboarding answer. |
| **Ad-hoc / Enterprise / EU Web Distribution** | Ad-hoc needs per-device UDID registration; Enterprise is employees-only and misuse risks program termination; EU Web Distribution is EU-only, iOS 17.5+, needs Apple authorization plus notarization plus a Settings-level trust step — **more** friction than the App Store, not less. |
| **Provisional notification authorization as the first ask** | Grants silently but delivers quietly — never a sound, never on the lock screen. Useless for a blocked agent. Possible second chance after an explicit denial only. |
| **Confirm dialog on every session delete** | Replaced by delete-with-undo, except for running sessions. |
| **`manta://` custom scheme as the primary pairing entry** | One outcome, no ownership verification, dead-ends when the app is not installed. Keep it registered as a silent legacy fallback only. |

---

## 14. Load-bearing research — do not re-derive

Facts with dates. Re-verify anything time-sensitive if a year has passed.

### 14.1 Apple's current design language

- **Liquid Glass** shipped in **iOS 26, September 2025**. HIG pages carry
  revisions dated 2025-06-09, 2025-09-09, **2025-12-16** ("Updated guidance for
  Liquid Glass" — a mid-cycle correction across colour, buttons, toolbars,
  typography) and **2026-06-08** (WWDC26).
- It is a **light-refraction model, not a blur**. Apple's term is **lensing** —
  edge distortion of underlying content. Composited layers: specular highlights
  that track geometry and respond to gyro; **adaptive shadow** that darkens over
  text; the refraction layer; a tint/dynamic-range layer; and illumination that
  spreads from the fingertip onto neighbouring glass.
- **Regular vs Clear.** Regular for almost everything, especially anything
  text-heavy. Clear only over media, and only with a **35% opacity dark scrim**.
  **Never mix the two in one interface.**
- **Small elements flip wholesale light/dark** against background luminance;
  large ones (sidebars, menus) adapt but do not flip.
- **Navigation bars no longer exist as a separate concept** — the HIG page
  redirects to Toolbars.
- **Apple publishes no numeric values for iOS**: no corner radius, bar height,
  control height, blur radius or spacing scale. Radius is derived
  (`ConcentricRectangle`), not a token. The only published numbers are hit
  regions (44×44pt, min 28×28), default text size 17pt / min 11pt, and the 35%
  Clear scrim.
- **iOS 27** is real (confirmed via apple.com and WWDC26 session catalogue) and
  is an **AI release, not a design release** — no design-language session at
  all. Three design changes, verbatim from Apple: more uniform refraction and
  improved contrast; **a Settings slider letting users tune Liquid Glass from
  ultra-clear to fully tinted**; sharper app icons.
- **Escape hatch:** `UIDesignRequiresCompatibility` in Info.plist keeps the
  pre-iOS-26 appearance. Expo notes Apple removes it in iOS 27.

### 14.2 React Native / Expo capability

- **Expo SDK 57** (2026-06-30), React Native **0.86**, React 19.2. New
  Architecture has been mandatory since RN 0.82 (2025-10-08) — the opt-out is
  ignored.
- **`expo-glass-effect`** is first-party, shipped SDK 54 (2025-09-10), wraps
  `UIVisualEffectView`. Exposes `GlassView`, `GlassContainer`,
  `isLiquidGlassAvailable()`. iOS 26+ only.
- **Navigation chrome adopts Liquid Glass automatically.** Expo's docs:
  headers "adopt the system's Liquid Glass effect by default — **it cannot be
  disabled per screen**." Form sheets adopt it with no code changes. **Opting
  out is the hard part.**
- **`@expo/ui`** (real SwiftUI interop) went stable in SDK 56 (2026-05-21).
  `Host` is a `UIHostingController`; ~45 SwiftUI components exposed. **Yoga is
  not available inside the SwiftUI context.**
- **Native tabs** (`expo-router/unstable-native-tabs`) still **alpha**;
  `react-native-screens` Stack v5 at **5.0.0-alpha.1** (2026-07-24). A SwiftUI
  app got all of this on day one.
- **FlashList v2** (`@shopify/flash-list@2.3.2`) removed size estimates
  entirely, has `maintainVisibleContentPosition` **on by default**, plus
  `autoscrollToBottomThreshold`, `startRenderingFromBottom`, and `useLayoutState`
  for "this item resized" — the streaming-text case. Its docs' own example is a
  chat transcript. **Open P1 bug #2018:** jump/glitch when *prepending*
  variable-height items (our "load older messages" path).

### 14.3 The terminal

**No React Native terminal emulator exists.** `react-native-xterm` is not on
npm. `react-native-ssh-sftp` is transport-only and last published June 2022.
**Blink Shell** — native Swift, the reference professional iOS terminal — renders
through **Chromium's HTerm, a JavaScript emulator in a webview**, by choice, for
rendering fidelity and speed. The terminal is a webview under every plan, and a
native emulator is a separate multi-quarter project with its own justification.

### 14.4 Distribution and install

- **App Store review: "on average, 90% of submissions are reviewed in less than
  24 hours."** The work is preparation, not waiting.
- **Nothing carries a per-user secret through an App Store install except an
  App Clip's shared container.** Verified against Custom Product Pages,
  `SKOverlay`, Smart App Banner `app-argument`, pasteboard handoff and
  attribution SDKs.
- **Universal links:** `apple-app-site-association` must be at
  `/.well-known/`, no extension, HTTPS, **no redirects**. Since iOS 14 Apple's
  CDN fetches it and devices **re-check about weekly**. Every subdomain needs
  its own entitlement entry and its own file; the `appclips` service **cannot
  use a wildcard**.
- **Android App Links:** `assetlinks.json`, `autoVerify`, wait ≥20s after
  install to test. **Android ≤14 only picks up changes at install/update;
  Android 15+ takes up to seven days.** Get the file right before shipping.
- **Google shut down Instant Apps** — there is no Android App Clip equivalent.

### 14.5 App Store review risks for this app shape

| Guideline | Risk | Mitigation |
|---|---|---|
| **2.1 App Completeness** | Highest. Apple's own page: **over 40% of unresolved review issues are 2.1.** An app needing a paired self-hosted server is unusable to a reviewer. | Apple's checklist literally names the answer: provide *"login credentials or **a sample QR code**"*. Stand up a **permanent demo box**, attach a live pairing QR + box ID + long-lived demo code to the review notes, keep the backend running through review, record a demo video. |
| **4.2 Minimum Functionality** | "Beyond a repackaged website." | Going native largely answers this. Enumerate the native surface in review notes: push, share sheet, file handling, App Intents, **a Live Activity for a running session**, camera QR pairing, microphone, haptics. |
| **4.2.3(i) Works on its own** | "Should work without requiring installation of another app." | Keep the manual-code path and a pairing page served by the box. The desktop QR is an accelerator, never a dependency. |
| **4.2.7 Remote Desktop Clients** | High, and least obvious. Requires host and client **on the same LAN** — fatal to a tunnelled architecture *if applied*. | **Pre-empt the mental model in the review notes before the reviewer forms it:** this is not a mirror; it is a first-party client rendering our own UI against our own server's HTTP API, like an email, Home Assistant, Plex or Jellyfin client. Note that 4.2.7(c) — "all account creation and management must be initiated from the host device" — is **satisfied** by the desktop-QR flow. |
| **2.5.2 Self-contained code** | The product's point is running commands. | State plainly: the app downloads and executes nothing. The agent runs on the user's own server and streams text back. |
| **4.7 Mini apps / plug-ins** | Attaches content-filtering, reporting and age-gating obligations. | **Do not frame it as a platform for third-party software.** It is a client for the user's own machine. |
| **5.1.2(i)** | No functionality may be gated on a system permission. | Onboarding must complete cleanly with notifications denied. |

Also cheap: set `ITSAppUsesNonExemptEncryption=false` in `Info.plist` (HTTPS-only
usage is exempt) to stop the per-build export-compliance prompt; privacy policy
link in both App Store Connect and in-app.

### 14.6 What a well-designed 2026 iOS app looks like

The pattern every Apple Design Award winner shares: **native chrome, bespoke
content.** Tab bars, toolbars, sheets and menus are stock and uncustomised; all
personality lives in the content layer. Slack and Gentler Streak are instantly
recognisable brands running entirely default navigation. Colour migrated from
the bars into the scroll view. Two or three winners a year are a data app with
**one hero custom component** and standard everything else. A logo, if present,
appears once and fades on scroll.

Also verified from design-system sources: optical font weights (450/550/650)
rather than 400/500/600; negative tracking that grows more negative with size;
radii that grew *upward* (Material added 20/32/48dp in the Expressive cycle);
tonal surfaces plus hairline borders replacing drop shadows; springs replacing
durations; semantic colour tokens rather than hex.

---

## 15. Open questions

| # | Question | Notes |
|---|---|---|
| ~~15.1~~ | ~~**React Native or Swift?**~~ | **CLOSED 2026-08-01 — Swift.** See §2 and `docs/spike-rn-vs-swift.md`. §11 discarded as prescribed. |
| 15.2 | **Android timing and scope.** | Deferred, not cancelled. When it comes back: Material 3 Expressive is a different design language, the permission-priming screen forks (§5.6), and there is no App Clip equivalent. |
| 15.3 | **The optional public-key hardening on the pairing QR (§6.5).** | Recommended, not committed. |
| 15.4 | **Does SwiftUI hold scroll position under a streaming transcript?** | **Superseded, not answered.** The original wording asked this about FlashList v2 and died with the React Native spike. The question itself survives and is now the riskiest open assumption in the plan: §17 puts scroll position on the device, and the claim that a native scroll view handles it — where the web client needed four attempts — is **untested**. Being measured by BET-481. Do not assume the answer while it is open. |

---

## 16. Follow-ups to file, and when

| What | When | Notes |
|---|---|---|
| **The implementation epic** | **After BET-475 closes.** BET-431 has reported (§2). | Written against the winning stack. §1–§12 plus §17 are the input. The decomposition is **no longer purely mechanical**: §17 puts a server-side migration ahead of the app, and §15.4 is an open measurement that can change the device-side scope. BET-475 exists to close those before the epic is written. |
| **The pairing rework** (universal link, `apple-app-site-association`, the pairing web page, the two-sided code on both screens, device list with revoke, TTL and rotation, push to existing devices) | **Being decomposed now — BET-484.** | Almost entirely **server and desktop** work. Needed identically under either stack. It is the security spine of onboarding and it de-risks the flow that matters most. |
| **App Clip** | **After the app is live on the App Store.** | Physically cannot be built before then (§6.6). |
| **Retire the mobile web client, the CI bundle publish and the self-update fetch** | **When the native replacement is ready**, not before. | §12. |
| **Per-session notification mute** | Only if it comes back as a product requirement. | Needs new server-side routing (§7.5). |

---

## 17. Where the chat logic lives

**Settled 2026-08-01 (BET-469).** This section replaces the "shared logic layer"
half of §1.10, which BET-433 invalidated.

### The decision

**The box is the single interpreter of the session stream. Both clients consume
what it produces.** The web client migrates to it too — it is not a mobile-only
path.

### The criterion — use this, not "is it hard to port"

Judge each piece of logic by one question: **would moving it to the box add a
network round trip, or does it ride one that already happens?**

This is the criterion because the box is a *remote* machine reached over
cellular, not a local process. That single fact is what makes the box cheap for
some work and disqualifying for other work, and it is what a generic
client-versus-server argument gets wrong.

### The partition

| Kind | Examples | Home |
|---|---|---|
| **Stream interpretation** — roughly 60% of `chatUtils.ts` | truncation classification, delta flush boundaries, context arithmetic, cache staleness, todo state, subagent tracking, question hydration, turn-complete detection, auto-rename | **Box** |
| **Interaction** — ~15 functions | scroll pinning, command filtering, input history, question form state, queued-drain abort | **Device** |
| **Formatting** | token counts, durations, clock times, stage colours | **Device** — one line each, trivial in any language |

The heavy, subtle, well-tested logic is nearly all box-side. The device-side set
is small and is the part that should be native anyway.

### Why the web client migrates too

The tempting alternative — box interprets for mobile, web keeps its local copy —
is rejected. It produces two implementations of delta flushing and context
arithmetic in two languages, guaranteed to drift, with the box copy exercised
only by the newer and less-used client. That trades "build twice" for
"interpret twice", which is worse because it is invisible: two renderers
disagreeing about whether a turn was truncated looks like a bug in one of them,
not like a missing decision.

### Sequencing — this ordering is the point, not an implementation detail

1. Move interpretation to the box, behind the existing event stream.
2. **Migrate the web client first.** It can be tested today, with the existing
   suite and the visual gates.
3. Build the Swift app against a server surface already proven in production.

If the Swift app were the first consumer of brand-new server logic, every bug
would be ambiguous — server or client? This ordering removes that ambiguity and
shrinks the mobile epic to the small device-side set plus UI.

**Step 2 is also the performance measurement — do not build a separate PoC for
it.** A standalone spike cannot answer the question before the server side
exists, and throughput is not in doubt anyway: the box emits flushed chunks at
roughly 4/sec where the raw stream is ~100/sec, so the phone does strictly less
work. The real risk is the opposite one — moving the flush decision to the box
adds a network hop *before text appears*.

So when step 2 lands, instrument **time from first token to rendered text** on
both paths. The threshold is pre-registered here so the result cannot be
rationalised after the fact:

> **Under 1 second is acceptable.** Above it, revisit §17's partition — the
> flush decision moves back to the device while interpretation stays on the box.

Pre-registering the number is the point. Measuring first and deciding afterwards
reliably produces "that seems fine".

**Accepted cost:** step 2 touches a shipping client for no user-visible benefit.
That is real work with real regression risk. It is accepted knowingly; the
mitigations are the existing test coverage on exactly these functions, plus the
visual gates.

### Breaking changes are allowed. There is no transition period.

Confirmed explicitly by the human. The product is in internal testing, so the
event stream may change shape without a compatibility layer, a version
negotiation, or a dual-path shim. **Do not build one.** This mirrors §1.2.

One consequence to be aware of rather than design around: the box self-updates
from `main` and the desktop auto-updates from its release feed, and the two are
not atomic. A user whose desktop lags a breaking box change sees a broken app
until it updates. Acceptable at this stage; it stops being acceptable at public
release, and that is when a compatibility story becomes required.

### Degraded mode — what still works when the box is unreachable

**Settled.** A phone loses connectivity constantly, and a client that shows a
spinner where a native app should feel alive is most of the perceived quality
gap between a native app and a webview.

Unaffected by an unreachable box:

- the composer — typing, editing and queueing a message never blocks
- scroll position and scrolling through the transcript
- every message already received

Only **new** interpretation stops. Nothing already delivered may be re-derived
on demand, because that would make previously-rendered content depend on the
link.

### Consequences for other sections

- §1.10's mitigation is corrected to point here
- §15.4 is the open risk this section depends on: scroll position is on the
  device, and whether SwiftUI holds it under streaming is being measured
  (BET-481) rather than assumed
- The Swift test strategy (BET-485) is downstream of this partition

---

## Appendix — where things live

| Thing | Path |
|---|---|
| This document | `docs/mobile-redesign/DECISIONS.md` |
| Visual companion | `docs/mobile-redesign/mockup.html` |
| Desktop redesign epic | BET-406, design record at `/pages/manta-redesign` |
| The stack spike | BET-431 (BET-432 … BET-438) |
| Current mobile client | `src/renderer/mobile/` |
| The CSS override layer that dies | `src/renderer/mobile/mobile.css` |
| Shared logic layer | `src/renderer/chatUtils.ts`, `api/httpApi.ts`, `store.ts`, `hooks/` |
| Push routing | `src/server/push.mjs` |
| Capacitor wrapper that dies | `mobile/` |
