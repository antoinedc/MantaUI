# Chat entry animation (framer-motion)

This documents why and how the chat transcript's message-entry animation works,
and the two jitter bugs it shipped with and fixed. Read this before touching
`chatMotion.ts`, `MessageBubble.tsx`, `ToolCall.tsx`, `Transcript.tsx`, or the
working-indicator layout in `ChatPanel.tsx`.

## Motivation and decision

The chat UI used to animate message appearance with **three hand-rolled CSS
keyframe animations**:

- `manta-bubble-in` — the user prompt bubble "pop".
- `manta-part-in` — tool cards sliding in.

Each surface had its own bespoke motion (a different distance/easing), so a
turn didn't assemble in one visual language, and the code was hand-maintained
keyframes. After research (assistant-ui / CopilotKit / Motion), the decision was
to keep the existing custom transcript and add a **single, library-driven entry
animation**, using **framer-motion** (11.x, MIT). Everything that arrives while
the user is watching — the prompt, the streaming AI reply, and tool cards —
uses **one shared motion**, so appearance reads as one consistent "smooth
rise" rather than several different effects.

## Where things live

| File | Role |
|---|---|
| `src/renderer/chatMotion.ts` | **Single source of the animation.** Exports `MESSAGE_IN_ENTER` (the live-arrival motion) and `MESSAGE_IN_IDLE` (no motion for history). |
| `src/renderer/MessageBubble.tsx` | User prompt bubble — a `motion.div` using `MESSAGE_IN_ENTER`/`IDLE` based on `entering`. |
| `src/renderer/ToolCall.tsx` | Assistant parts (tool cards **and** streaming text) — wrapped in a `motion.div`; every live part uses the same motion as the prompt. |
| `src/renderer/Transcript.tsx` | Wraps the transcript in `MotionConfig reducedMotion="user"` so framer-motion honours `prefers-reduced-motion`. |
| `src/renderer/index.css` | The hand-rolled keyframes and the streaming caret were removed; chat entry animation is entirely framer-motion. |
| `src/renderer/ChatPanel.tsx` | The working indicator's constant-height slot (jitter fix #2). |

## The motion (`MESSAGE_IN_ENTER`)

```
translateY 12px -> 0   +   opacity 0 -> 1
transition: tween, 0.3s, cubic-bezier(0.22, 1, 0.36, 1)
```

**No spring, no scale.** See jitter fix #1 below for why.

## The one invariant that must never regress: history stays still

A transcript the user merely loads must **not** animate — otherwise every bubble
and card in an opened session would replay, and a session switch would replay
the whole logged conversation. The gate that decides "is this live?" lives in
**`updateEntryMotion` (chatUtils.ts)**, unchanged. Components receive an
`entering` boolean per message and:

- `entering=true`  → spread `MESSAGE_IN_ENTER` (animates in).
- `entering=false` → spread `MESSAGE_IN_IDLE` (`initial={false}` → renders at the
  shown state, zero animation).

Regression tests assert this through a `data-motion` attribute (`"bubble"` /
`"part"`, absent for history) on the wrappers — see `MessageBubble.test.tsx` and
`Transcript.test.tsx`. Do not swap this for a real CSS class or a whole-list
animation; the gate + per-message flag is what keeps loaded history still while
live adds still animate.

## Jitter fix #1 — the underdamped spring overshoot

The first version of `MESSAGE_IN_ENTER` used a spring:

```
transition: { type: "spring", stiffness: 380, damping: 26, mass: 0.8 }
initial:    { opacity: 0, y: 14, scale: 0.9 }
```

Critical damping for those values is ~34.9, so at damping 26 the spring is
**underdamped and overshoots**: `scale` bumped past 1 to ~1.02 and the `y` rise
bounced past its end point before settling. On a message at the **pinned bottom
of the auto-following transcript**, that push-down/pull-up visible wobble read
as vertical jitter — worst while the reply was still streaming (content being
re-measured mid-spring).

Fix: a **non-overshooting tween** (translateY + opacity, no scale, gentle ease).
A cubic-bezier ramp ends exactly at the endpoint with zero oscillation, and
transform-only means nothing to bounce.

## Jitter fix #2 — the working indicator reflow

On send, the ✻ **working indicator** appears/disappears right before the reply
streams. The indicator is the last row of the transcript flow but renders in the
**fixed composer stack BELOW** the transcript scroll container. It was only
mounted while `running`, so each time `running` toggled it mounted/unmounted and
**resized the flex-1 reading column** by its height — pushing the user's prompt
up/down (the "loading text appears/disappears/reappears" jitter).

Fix: the indicator is now **always rendered**, with the spinner toggled via
`visibility` (layout preserved) instead of mount/unmount. A constant-height slot
means toggling `running` never changes the transcript's layout size, so the
reading column and the prompt stay put.

This is a deliberate tradeoff: reserving the slot leaves a small hidden reserve
above the composer when idle, so the space never jumps.

## Verification

- `npm run typecheck` — clean.
- Renderer tests (`vitest`): the animation-related suites
  (`MessageBubble.test.tsx`, `Transcript.test.tsx`) assert the history-still
  gate, the live-pop, the re-render-storm stability, and the streaming caret.
  Full renderer suite: 1108 pass. Server suite: 1496 pass.
- `testHarness.tsx` adds jsdom shims (`ResizeObserver`, `matchMedia`) so
  framer-motion mounts in the test DOM.

## Related

- The interactive proposal that preceded this (a served design page with
  framer-motion variants) was a throwaway demonstration; the shipped constant
  is `MESSAGE_IN_ENTER` above.
