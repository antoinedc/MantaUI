// Hand-written type declarations for updateError.mjs. Implementation is plain
// JS so both the renderer tsconfig and the main-process TS import it natively.
// Keep in sync with src/shared/updateError.mjs.

/**
 * - "integrity"  — an update exists but failed verification; the user will
 *                  never receive it without intervention.
 * - "permission" — the updater can't replace the app bundle.
 * - "transient"  — offline / DNS / timeout / 5xx; resolves on its own.
 */
export type UpdateErrorKind = "integrity" | "permission" | "transient";

/** Classify an electron-updater error message. Unknown → "transient". */
export function classifyUpdateError(message: string | null | undefined): UpdateErrorKind;

/** True when the failure is terminal enough to show the user. */
export function shouldSurfaceUpdateError(message: string | null | undefined): boolean;

/** User-facing copy telling the user what to DO about a surfaced failure. */
export function describeUpdateError(message: string | null | undefined): string;
