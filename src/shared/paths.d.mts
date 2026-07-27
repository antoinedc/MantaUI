// Hand-written type declarations for paths.mjs. Implementation is plain JS
// so both the renderer tsconfig and the main tsconfig import it without
// crossing the process boundary. Keep in sync with src/shared/paths.mjs.

export const STATE_DIRNAME: string;
export const UPLOAD_DIRNAME: string;
export const OUTBOX_DIRNAME: string;
export const SECRETS_DIRNAME: string;

// Leading `~` → os.homedir(); `~/foo` → `<homedir>/foo`. Other strings pass
// through unchanged. Pure: passes through anything that isn't a non-empty
// string starting with `~`.
export function expandTilde(p: string): string;
export function expandTilde(p: null): null;
export function expandTilde(p: undefined): undefined;
export function expandTilde(p: number): number;
export function expandTilde(p: unknown): unknown;
