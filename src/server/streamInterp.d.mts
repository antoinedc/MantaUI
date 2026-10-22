// Hand-written type declarations for streamInterp.mjs — only what the renderer's
// test harness (src/renderer/testHarness.tsx) imports, so it can replay raw V2
// opencode events through the REAL interpreter. Keep in sync with streamInterp.mjs.

export type StreamInterpreter = {
  interpret(evt: unknown): void;
  flushPending(): void;
  dispose(): void;
  snapshotState(): Array<Record<string, unknown>>;
};

export function createStreamInterpreter(opts: {
  publish: (env: unknown) => void;
  now?: () => number;
  contextLimitFor?: (providerID: unknown, modelID: unknown) => number | null;
  readCacheTtl?: () => Promise<string | null>;
  fetchShellOutput?: ((a: { shellID: string; cursor: number; directory?: string }) => Promise<{ output: string; cursor: number } | null>) | null;
  shellPollMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): StreamInterpreter;
