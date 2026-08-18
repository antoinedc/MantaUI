// Hand-written type declarations for cliCatalog.mjs. Implementation is plain
// JS so both the renderer tsconfig and the server-side .mjs import it natively.
// Keep in sync with src/shared/cliCatalog.mjs.

export interface CliCatalogEntry {
  id: string;
  label: string;
  bin: string;
  latest: { kind: "npm"; pkg: string } | { kind: "github"; repo: string };
  npmPackage: string | null;
  upgrade: string[];
  manualUrl: string;
  disruption: string;
}

export const CLI_CATALOG: CliCatalogEntry[];

/**
 * Which command upgrades this CLI, given where its binary actually is.
 * Returns null = "we cannot upgrade this safely" → the UI shows a manual link.
 * Precedence: npm-managed → `npm install -g <pkg>@latest`; Homebrew-managed →
 * null; entry.upgrade verbatim; else null.
 *
 * `entry` is loosely typed because the function reads only `npmPackage` and
 * `upgrade`.
 */
export function resolveUpgradeCommand(
  entry:
    | Partial<CliCatalogEntry>
    | { npmPackage?: string | null; upgrade?: string[] | null }
    | null
    | undefined,
  resolvedPath: string | null | undefined,
  npmGlobalRoot: string | null | undefined,
): string[] | null;
