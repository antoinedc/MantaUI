// M527.chatMotion — the single entry animation for chat message appearance.
//
// There used to be three separate hand-rolled CSS keyframe animations
// (manta-bubble-in for the prompt, manta-part-in for cards, manta-streaming
// for per-block streamed text) plus a data-* gate. They were consolidated into
// ONE framer-motion animation, "variant A": every assistant reply, tool card
// and user prompt that arrives while the user is watching performs the same
// short rise with a slight scale overshoot (spring physics), so message
// appearance reads as one consistent "pop" — iMessage/WhatsApp style — instead
// of each surface having its own bespoke motion.
//
// The gate that decides WHAT animates still lives in `updateEntryMotion`
// (chatUtils.ts): only messages that arrive LIVE are marked `entering`, and a
// transcript the user merely loads passes `entering=false`, for which the
// consuming components render the IDLE props so nothing moves. See the
// `entering` prop docs on MessageBubble / AssistantPart. The single source of
// the animation values lives here so the bubble and the streaming reply cannot
// drift apart again.
//
// NOTE on typing: the ENTER/IDLE split exists for the compiler as much as the
// runtime. framer-motion's `initial`/`animate` prop types are a deep recursive
// union, and a JSX ternary like `{...(entering ? hidden : visible)}` forces TS
// to normalize `false | TargetAndTransition`, which exceeds its union
// complexity limit (TS2590). Spreading two fully-typed `Pick<MotionProps,…>`
// objects sidesteps that — each branch is already the exact prop shape.

import type { MotionProps } from "framer-motion";

type EntryMotionProps = Pick<MotionProps, "initial" | "animate" | "transition">;

/**
 * The "pop": a 14px rise with a scale 0.9 -> 1.02 -> 1 overshoot driven by
 * spring physics. Applied identically to the user bubble, the streaming AI
 * reply, and tool cards when their message arrived live. The overshoot is the
 * point — a hard snap would be a static stamp; the spring makes it a single
 * "pop" the text lands in.
 */
export const MESSAGE_IN_ENTER: EntryMotionProps = {
  initial: { opacity: 0, y: 14, scale: 0.9 },
  animate: { opacity: 1, y: 0, scale: 1 },
  transition: { type: "spring", stiffness: 380, damping: 26, mass: 0.8 },
};

/**
 * No motion (history): `initial={false}` renders at the shown state with zero
 * animation, so a transcript the user merely loads stays perfectly still.
 */
export const MESSAGE_IN_IDLE: EntryMotionProps = {
  initial: false,
  animate: undefined,
  transition: undefined,
};
