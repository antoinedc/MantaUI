// Hand-written type declarations for planMode.mjs. Implementation is plain JS
// so both the renderer tsconfig and the server import it without crossing a
// process boundary. Keep in sync with src/shared/planMode.mjs.

/**
 * The plan-mode state a tool part asserts, or `null` if it asserts nothing.
 *
 * Only a COMPLETED plan_enter/plan_exit counts. An ERRORED one is a switch that
 * did NOT happen — most importantly the plan card's "Keep planning", which
 * answers the plan question "No" and so rejects the `plan_exit` tool. Reading
 * that as an exit dropped the session out of plan mode behind the user's back.
 * (This is why the drain's `isToolStepBoundary`, which accepts `error` on
 * purpose, must not be reused here.)
 */
export function planModeFromToolPart(part: unknown): boolean | null;

/**
 * Whether `name` is a plan-mode agent (`"plan"` or `"manta-plan"`). Non-strings
 * (undefined, null, numbers, objects) and empty strings are false.
 */
export function isPlanAgent(name: unknown): boolean;
