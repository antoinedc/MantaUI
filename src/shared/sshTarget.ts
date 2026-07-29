// sshTarget.ts — resolve the host-picker's selection into the single value
// every install-path call site consumes (BET-384).
//
// WHY THIS LIVES IN src/shared/ (not src/main/installer/): the renderer must
// compute the resolved value BEFORE it crosses the IPC boundary — main never
// sees the raw form fields, only the resolved target — so this has to be
// importable from BOTH processes without pulling Electron or DOM types into
// either. Same reason installStages.ts lives here (BET-383): one source, not
// two copies that can drift.
//
// ~/.ssh/config is still never written to (decision #1). A custom selection
// configures ONE connection for this install only. The alias branch is
// completely unchanged — resolveInstallTarget returns the alias string
// verbatim, so every existing alias-based call site (execRemote, streamRemote,
// preflightBox, runInstall, mintAndClaim — all of which already accept a
// plain string) keeps working with zero changes for that branch. `SshTarget`
// widens what those call sites accept (string | CustomSshTarget) rather than
// adding a second parameter anywhere — see runner.ts's buildArgs, the actual
// argv-construction site, for how a CustomSshTarget becomes `-p` / `-i` flags
// plus a `[user@]host` destination.
//
// Pure: no fs, no ssh, no DOM. Tested in sshTarget.test.ts.

/** Sentinel `<select>` value that reveals the custom-host panel. */
export const CUSTOM_HOST_VALUE = "__custom__";

/**
 * A fully custom connection — never persisted, never written to
 * ~/.ssh/config. Every field but `host` is optional: an omitted field means
 * "let OpenSSH decide" (its own config / defaults apply), never a
 * substituted default from this module or the renderer.
 */
export type CustomSshTarget = {
  kind: "custom";
  host: string;
  port?: number;
  user?: string;
  identityFile?: string;
};

/**
 * The single value every install-path call site consumes. A plain string is
 * an ~/.ssh/config alias (the pre-existing, unchanged shape) — runner.ts
 * passes it straight through as the `ssh <alias> <command>` destination. A
 * `CustomSshTarget` is this-install-only connection info.
 */
export type SshTarget = string | CustomSshTarget;

/** The host-picker's raw form state — one shape covers both branches. */
export type HostFieldSelection = {
  /** The `<select>` value: a real alias, or CUSTOM_HOST_VALUE. */
  alias: string;
  host: string;
  port: string;
  user: string;
  identityFile: string;
};

export type ResolveInstallTargetResult =
  | { ok: true; target: SshTarget }
  | { ok: false; error: string };

/**
 * Resolve a host-picker selection into the value the install path consumes.
 *
 * Alias selection → the alias, unchanged.
 * Custom selection → the composed target; empty optional fields are omitted
 * (never defaulted) so "let OpenSSH decide" is a real absence, not a
 * substituted value this module invented.
 *
 * Validates: empty host → error; port (if given) must be 1-65535. Returns a
 * structured error for the caller to render inline — never throws.
 */
export function resolveInstallTarget(
  sel: HostFieldSelection,
): ResolveInstallTargetResult {
  if (sel.alias !== CUSTOM_HOST_VALUE) {
    const alias = sel.alias.trim();
    if (alias === "") return { ok: false, error: "Select a host." };
    return { ok: true, target: alias };
  }

  const host = sel.host.trim();
  if (host === "") return { ok: false, error: "Host or IP is required." };

  const target: CustomSshTarget = { kind: "custom", host };

  const portRaw = sel.port.trim();
  if (portRaw !== "") {
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: "Port must be between 1 and 65535." };
    }
    target.port = port;
  }

  const user = sel.user.trim();
  if (user !== "") target.user = user;

  const identityFile = sel.identityFile.trim();
  if (identityFile !== "") target.identityFile = identityFile;

  return { ok: true, target };
}

/**
 * True when a target has no meaningful destination — the empty-alias /
 * empty-host case every runner.ts entry point rejects before spawning ssh.
 */
export function isEmptySshTarget(target: SshTarget): boolean {
  if (typeof target === "string") return target.trim() === "";
  return target.host.trim() === "";
}

/**
 * The `[user@]hostname` ssh(1) destination argument. Port and identity file
 * are NOT part of the destination — OpenSSH takes them as separate `-p` /
 * `-i` flags, built by `sshTargetExtraArgs`.
 */
export function sshTargetDestination(target: SshTarget): string {
  if (typeof target === "string") return target.trim();
  const user = target.user ? `${target.user}@` : "";
  return `${user}${target.host}`;
}

/** The extra ssh(1) argv entries a custom target needs (`-p`, `-i`). An
 * alias needs none — the alias's own ~/.ssh/config block already carries
 * that connection detail. */
export function sshTargetExtraArgs(target: SshTarget): string[] {
  if (typeof target === "string") return [];
  const args: string[] = [];
  if (target.port !== undefined) args.push("-p", String(target.port));
  if (target.identityFile) args.push("-i", target.identityFile);
  return args;
}

/** Human-readable label for display (diagnostics, logs) — never fed back
 * into an ssh argv. */
export function sshTargetLabel(target: SshTarget): string {
  if (typeof target === "string") return target;
  const user = target.user ? `${target.user}@` : "";
  const port = target.port !== undefined ? `:${target.port}` : "";
  return `${user}${target.host}${port}`;
}
