// Hand-written type declarations for paths.mjs. Implementation is plain JS
// so both the renderer tsconfig and the main tsconfig import it without
// crossing the process boundary. Keep in sync with src/shared/paths.mjs.

export const STATE_DIRNAME: string;
export const UPLOAD_DIRNAME: string;
export const OUTBOX_DIRNAME: string;
export const SECRETS_DIRNAME: string;

// Base directory the state dirs hang off: `$MANTA_STATE_HOME` when set to a
// non-blank value, else `os.homedir()`. The override is a TEST-ISOLATION seam
// (the runners point it at a throwaway dir so an un-injected test can't write
// the live box's stores) — production never sets it.
export function stateHome(): string;

// `<stateHome>/.manta/<...parts>` — the box's own state files (auth, secrets,
// schedules, webhooks, cap jobs, …). No args → the `.manta` dir itself.
export function statePath(...parts: string[]): string;

// The three roots that sit NEXT to `.manta` rather than inside it.
export function uploadRoot(): string;
export function outboxRoot(): string;
export function secretsRoot(): string;

// macOS-only PATH prefix used by `patchPath`. Single source of truth for
// the desktop plugin runner (src/main/capExecutor.ts) and the box server's
// Claude credential refresh (src/server/opencode.mjs).
export const DARWIN_PATH_PREFIX: readonly string[];

// Leading `~` → os.homedir(); `~/foo` → `<homedir>/foo`. Other strings pass
// through unchanged. Pure: passes through anything that isn't a non-empty
// string starting with `~`.
export function expandTilde(p: string): string;
export function expandTilde(p: null): null;
export function expandTilde(p: undefined): undefined;
export function expandTilde(p: number): number;
export function expandTilde(p: unknown): unknown;

// Returns a copy of `baseEnv` with the macOS Homebrew PATH prefix
// prepended. On every non-darwin platform the env is returned
// byte-identical (no new `PATH` key written when one was missing).
export function patchPath(
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv;
