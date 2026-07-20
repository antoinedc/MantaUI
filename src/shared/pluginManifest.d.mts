// Hand-written type declarations for pluginManifest.mjs. The implementation
// is plain JS so it can be imported by both Node-side modules (.mjs natively,
// .ts via Bundler resolution) and the renderer test suite (vitest .ts file).
// Keep this in sync with src/shared/pluginManifest.mjs.

export type PluginInputRow = {
  id: string;
  description: string;
  type: "string" | "number" | "boolean" | "enum";
  default?: unknown;
  values?: string[];
};

export type PluginStep = {
  name?: string;
  run: string;
  cwd?: string;
  env?: Record<string, string>;
  timeout?: string;
  if?: string;
  continue_on_error?: boolean;
};

export type PluginManifest = {
  name: string;
  description: string;
  host: "mac";
  inputs: PluginInputRow[];
  env: Record<string, string>;
  timeoutMs: number | null;
  steps: PluginStep[];
};

export type PluginManifestError = { path: string; message: string };

export const NAME_RE: RegExp;
export const INPUT_ID_RE: RegExp;
export const INPUT_TYPES: readonly string[];
export const PATH_PATCH: string;

export function parseManifest(
  yamlText: string,
):
  | { ok: true; manifest: PluginManifest; errors: undefined }
  | { ok: false; manifest: undefined; errors: PluginManifestError[] };

export function validateManifest(
  parsed: unknown,
): { errors: PluginManifestError[] };

export function evalIf(
  expr: string,
  inputs: Record<string, unknown>,
): boolean | { error: string };

export function buildEnv(
  manifest: PluginManifest,
  suppliedInputs: Record<string, unknown>,
  opts: { jobId?: string },
): Record<string, string>;

export function resolveCwd(
  cwd: string,
  env: Record<string, string>,
): string | { error: string };

export function validateSuppliedInputs(
  manifest: PluginManifest,
  supplied: Record<string, unknown>,
): { errors: PluginManifestError[] };

export function parseTimeout(s: string): number | { error: string };

export function expandTilde(p: string): string;
