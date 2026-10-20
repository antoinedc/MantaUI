// Reading credentials. NOTHING here writes a credential file or refreshes a
// token: a seat's file is rewritten by manta-server (`POST /api/accounts/refresh`)
// and the live login belongs to the `claude` CLI. The plugin only re-reads.
//
// No token travels over HTTP: manta-server names a seat's credential FILE, and
// the path is untrusted until it is absolute and — after resolving every
// symlink — inside `<state>/.manta-secrets/accounts/`.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

export type Provider = "claude" | "codex";

export interface SeatCredentials {
  accessToken: string;
  accountId?: string;
  expiresAt?: number;
}

export const EXPIRY_MARGIN_MS = 60_000;
const MAX_CACHE_ENTRIES = 500;

/** The one directory seat credentials may be read from. */
export function seatsRootDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.MANTA_STATE_HOME;
  const home = typeof override === "string" && override.trim() !== "" ? override : homedir();
  return join(home, ".manta-secrets", "accounts");
}

/** The user's single Claude login (`CLAUDE_CONFIG_DIR` honoured, like the CLI). */
export function liveClaudeCredentialsFile(env: Record<string, string | undefined> = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return join(dir ? dir : join(homedir(), ".claude"), ".credentials.json");
}

/** Real path of `file` iff it is an absolute regular file inside `root`; else null. */
export function allowedCredentialPath(file: unknown, root: string): string | null {
  if (typeof file !== "string" || !file || !isAbsolute(file)) return null;
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(file);
    if (!real.startsWith(realRoot + sep)) return null;
    if (!statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/** A credential file's contents for a provider, or null. Pure parse. */
export function parseSeatCredentials(provider: Provider, raw: string): SeatCredentials | null {
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (provider === "claude") {
    const o = j?.claudeAiOauth;
    if (typeof o?.accessToken !== "string" || !o.accessToken) return null;
    const out: SeatCredentials = { accessToken: o.accessToken };
    if (typeof o.expiresAt === "number" && Number.isFinite(o.expiresAt)) out.expiresAt = o.expiresAt;
    return out;
  }
  const e = j?.openai ?? (j?.access ? j : null);
  if (e?.type !== "oauth" || typeof e.access !== "string" || !e.access) return null;
  const out: SeatCredentials = { accessToken: e.access };
  if (typeof e.accountId === "string" && e.accountId) out.accountId = e.accountId;
  if (typeof e.expires === "number" && Number.isFinite(e.expires)) out.expiresAt = e.expires;
  return out;
}

export interface CredentialReader {
  /** A seat's credentials from a file manta-server named (validated). */
  readSeat(provider: Provider, file: string | undefined): SeatCredentials | null;
  /** The live Claude login. */
  readLive(): SeatCredentials | null;
  /** Forget a file's cached contents (after a refresh rewrote it). */
  invalidate(file: string | undefined): void;
}

/** Reads credential files, cached per file and keyed by mtime + size. */
export function createCredentialReader(
  opts: { rootDir?: () => string; liveFile?: () => string } = {},
): CredentialReader {
  const rootDir = opts.rootDir ?? (() => seatsRootDir());
  const liveFile = opts.liveFile ?? (() => liveClaudeCredentialsFile());
  const cache = new Map<string, { sig: string; creds: SeatCredentials | null }>();

  function readReal(provider: Provider, real: string): SeatCredentials | null {
    try {
      const st = statSync(real);
      const sig = `${provider}|${st.mtimeMs}|${st.size}`;
      const hit = cache.get(real);
      if (hit && hit.sig === sig) return hit.creds;
      const creds = parseSeatCredentials(provider, readFileSync(real, "utf-8"));
      cache.delete(real);
      cache.set(real, { sig, creds });
      if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
      return creds;
    } catch {
      return null;
    }
  }

  return {
    readSeat(provider, file) {
      const real = allowedCredentialPath(file, rootDir());
      return real ? readReal(provider, real) : null;
    },
    readLive() {
      return readReal("claude", liveFile());
    },
    invalidate(file) {
      if (typeof file !== "string") return;
      cache.delete(file);
      try {
        cache.delete(realpathSync(file));
      } catch {
        /* file gone — nothing cached under a real path either */
      }
    },
  };
}

/** Is a token with this expiry too close to it to send? Unknown expiry → no. */
export function expiresSoon(expiresAt: number | undefined, nowMs: number, marginMs = EXPIRY_MARGIN_MS): boolean {
  return typeof expiresAt === "number" && expiresAt - nowMs <= marginMs;
}
