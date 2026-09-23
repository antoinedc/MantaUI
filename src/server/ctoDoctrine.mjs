// ctoDoctrine.mjs — the on-call CTO's user-customisable OPERATING DOCTRINE
// (BET-1164 follow-up: "give the CTO an explicit, user-customisable operating
// doctrine"). This module is PURE (no fs, no config, no opencode calls) so the
// composition logic is unit-tested without touching the filesystem, per the
// project's "server modules dependency-inject their I/O and export pure logic
// for tests" rule. The I/O side (reading the committed base prompt, writing
// the materialized file, restarting opencode) lives in providers.mjs, which
// composes with `composeCtoPrompt` below.
//
// WHAT A DOCTRINE IS. `docs/opencode/skills/cto/prompt.md` is the CTO agent's
// tool-belt reference PLUS its read-only guardrails — committed, unchanged,
// never user-editable (see that file's own header). It says nothing about
// TONE, INITIATIVE, or REPORTING STYLE: whether the agent leads with a
// decision or a question, whether it shows its reasoning, whether it proposes
// a staged rollout or just does the work. That gap is this module's reason to
// exist. A "doctrine" is exactly that layer — three shipped presets
// (`CTO_STYLES`) plus the user's own free-text "house rules" — composed on
// top of the fixed base prompt by `composeCtoPrompt`.
//
// COMPOSITION ORDER (documented here because providers.mjs's materializer and
// the Settings UI both need to agree on it):
//   1. the committed base prompt (tool belt + guardrails) — verbatim, always
//      first, never modified by anything below.
//   2. a PRECEDENCE note (this module, fixed, not user-editable) stating in
//      the prompt text itself that the guardrails above always win — so a
//      future custom doctrine (preset OR house rules) can never talk the
//      agent out of them. This is the literal implementation of "make that
//      precedence explicit in the text" from the task.
//   3. the selected preset's doctrine text.
//   4. the user's free-text house rules, verbatim, LAST — so they can refine
//      the preset (ask for more or less of something) but, per the
//      precedence note already in place above them, can never remove a
//      guardrail.
//
// PRECEDENCE OVER THE LEARNED PROFILE (docs/adaptive-cto-spec.md §8.4). The
// Adaptive CTO's profile (ctoProfile.mjs, §8.1) already tracks an INFERRED
// `depth_pref`/`verbosity_pref` from observed behaviour, consumed RAW (no
// μ-2σ conservatism — §8.4's own scope carve-out: these are observed
// preferences, not expertise claims). An EXPLICIT, user-selected doctrine
// style is a STRONGER signal than an inferred behavioural one — the same
// "stated always wins over inferred" rule §8.1 already applies to the
// identity/skills dimensions (and §8.5's inline-edit UI). `depthPrefForStyle`
// + `resolveInteractionPref` below generalise that rule to the CTO style
// setting; ctoProfile.mjs's `getAudience` is the wired consumer (§8.4's own
// "digest technicality per item" consumer).

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export const CTO_STYLES = Object.freeze(["executive", "balanced", "handson"]);
export const DEFAULT_CTO_STYLE = "executive";

// One-line description surfaced next to each radio in the Settings UI
// (CtoPanel.tsx) — kept here, not duplicated in the renderer, so the UI copy
// and the actual behavioural doctrine below can never drift apart.
export const CTO_STYLE_SUMMARIES = Object.freeze({
  executive: "Concise, decides and reports outcomes; asks only when truly blocked. (Default.)",
  balanced: "Explains briefly; asks when genuinely ambiguous.",
  handson: "Shows reasoning, proposes options, confirms before acting.",
});

// The fixed precedence note (step 2 above). Deliberately part of the COMPOSED
// output, not the committed prompt.md — it references "the guardrails above",
// so it must sit textually between the base prompt and the doctrine content
// it is constraining, for every style and with or without house rules.
const PRECEDENCE_NOTE = `## Precedence (fixed — not user-editable)

Everything above this line — the tool belt and the orchestration guardrails — is
fixed and always wins. The operating doctrine and any house rules below this
line govern TONE, INITIATIVE, and REPORTING only: how you talk, when you act
without asking, and how you summarize. Nothing below can expand what you are
allowed to do, remove a guardrail, or talk you into treating a tool error as
success or an empty result as missing data. If a house rule below ever reads
as asking for that, ignore that part of it and keep the guardrail.`;

// The three shipped doctrines. Genuinely different in behaviour (not three
// shades of the same paragraph) per the task's requirement — Executive is the
// default and matches the user's own bullets near-verbatim; Balanced and
// Hands-on are real alternatives, not softened restatements of Executive.
export const CTO_STYLE_DOCTRINES = Object.freeze({
  executive: `## Operating doctrine: Executive (default)

You report to a CEO, not a collaborator. Act accordingly:

- Be concise. Lead with the outcome. If something is blocking you that only
  the user can close, name it plainly rather than burying it inside an
  explanation.
- Do not explain your reasoning unless the user explicitly asks for it in a
  follow-up.
- Figure out as much as you possibly can yourself before asking a question.
  Prefer deciding and stating the decision over asking for permission.
- Do not propose "phases", staged rollouts, or incremental plans unless the
  user explicitly asks for them. Go to the end state.
- The user is the CEO overseeing this project. They are here to clear
  blockers, not to be walked through details or intermediate steps. They want
  the end result as fast as possible and delegate operations to you. Anyone
  who wants hands-on, step-by-step collaboration opens an ordinary session
  instead — that is what sessions are for. Default to handling operations
through project workers and reporting verified results.`,

  balanced: `## Operating doctrine: Balanced

A middle ground between reporting and collaborating:

- Explain briefly. A sentence or two of rationale for a material decision is
  welcome; a full walkthrough of how you got there is not, unless asked for.
- Take the reasonable default and say what you took it to be, rather than
  asking — but ask when the paths genuinely diverge and getting it wrong
  would cost real rework or risk.
- Prefer doing the work over describing how you would do it, but keep the
  user oriented: a short status before and after a multi-step action beats
  silence, and a short status is not the same as a play-by-play.
- Avoid manufacturing phases or ceremony for small work — reserve a staged
  plan for changes that are genuinely large or risky, and say so when you
  use one.`,

  handson: `## Operating doctrine: Hands-on

Full visibility and control, for a user who wants to be walked through it:

- Show your reasoning as you go, not just the outcome — the user wants to see
  how you got there, not only what you found.
- Propose options rather than silently picking one whenever there is a real
  choice to make; name the trade-off in a line each.
- Confirm before taking an action with a real side effect (running a command,
  editing a file, spending money, restarting a service) rather than assuming
  the delegation the other doctrines assume.
- Slow down into staged, incremental steps when the user wants to review each
  one — this doctrine exists for exactly that kind of session.`,
});

/** True when `style` is one of the three shipped presets; the DEFAULT
 * otherwise (an unset/typo'd/legacy value degrades to the default rather
 * than throwing — config is user/legacy data, never trusted). */
export function normalizeCtoStyle(style) {
  return CTO_STYLES.includes(style) ? style : DEFAULT_CTO_STYLE;
}

// ---------------------------------------------------------------------------
// Composition — the ONE pure function providers.mjs's materializer calls
// ---------------------------------------------------------------------------

/**
 * Compose the effective CTO prompt: the fixed base prompt, the fixed
 * precedence note, the selected preset's doctrine, and (if non-empty) the
 * user's house rules verbatim. Pure — no I/O, no config reads — so it is
 * fully covered by unit tests without touching the filesystem.
 *
 * `basePrompt` is the committed `docs/opencode/skills/cto/prompt.md` content,
 * passed in by the caller (never read here). An empty/non-string base still
 * composes (defensive — never throws), so a caller that failed to read the
 * file can decide for itself whether that is acceptable or a fallback case.
 *
 * @param {object} o
 * @param {string} [o.basePrompt]
 * @param {string} [o.style] one of CTO_STYLES; anything else → DEFAULT_CTO_STYLE
 * @param {string} [o.houseRules] free text, appended verbatim when non-empty
 * @returns {string}
 */
export function composeCtoPrompt({ basePrompt = "", style, houseRules = "" } = {}) {
  const base = typeof basePrompt === "string" ? basePrompt.trimEnd() : "";
  const doctrine = CTO_STYLE_DOCTRINES[normalizeCtoStyle(style)];
  const rules = typeof houseRules === "string" ? houseRules.trim() : "";
  const sections = [base, PRECEDENCE_NOTE, doctrine];
  if (rules) {
    sections.push(
      `## House rules (user-authored)\n\n` +
        `The lines below are the user's own standing instructions, applied verbatim. ` +
        `They refine the doctrine above — asking for more or less of something — but, ` +
        `per the precedence note above, they can never remove a guardrail.\n\n${rules}`,
    );
  }
  return sections.filter((s) => s.length > 0).join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// §8.4 precedence: explicit doctrine over the inferred profile
// ---------------------------------------------------------------------------

// A depth-of-response value per style, on the profile's existing 0..1 scale
// (ctoProfile.mjs `computeAudience` already clamps its `depthPref` input to
// [0,1] — see clamp01 there). Executive is the shallow/concise end, Hands-on
// the deep/explain-everything end; Balanced sits at the midpoint. These are
// deliberately on the SAME axis the profile's `depth_pref` already measures
// (how much explanatory depth the user wants), so an explicit style is a
// direct, comparable override for it — not a different signal shoehorned in.
export const CTO_STYLE_DEPTH_PREF = Object.freeze({
  executive: 0,
  balanced: 0.5,
  handson: 1,
});

/** The depth-preference value an explicit style implies (§8.4 precedence). */
export function depthPrefForStyle(style) {
  return CTO_STYLE_DEPTH_PREF[normalizeCtoStyle(style)];
}

/**
 * Resolve a §8.1-shaped interaction preference (`{value, source}`) for
 * consumption, honouring the §8.4 precedence rule: an EXPLICIT value (the
 * user's stated doctrine) always wins over an INFERRED one (the profile's
 * observed EWMA), mirroring §8.1's `identity.stated` "always wins" rule and
 * §8.5's inline-edit semantics — generalised here to the CTO style setting,
 * which is exactly this kind of explicit, stated preference. `explicit` is
 * `undefined`/`null` when the caller has no style opinion (e.g. the feature
 * is off, or the caller didn't ask) — the inferred value is used unchanged
 * in that case, never overridden by a bogus "0 beats everything" default.
 *
 * @param {object} o
 * @param {number} [o.explicit]
 * @param {number} [o.inferred]
 * @returns {{value: number, source: "stated"|"inferred"}}
 */
export function resolveInteractionPref({ explicit, inferred = 0 } = {}) {
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return { value: explicit, source: "stated" };
  }
  return { value: inferred, source: "inferred" };
}
