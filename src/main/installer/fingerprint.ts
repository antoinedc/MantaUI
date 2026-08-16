// fingerprint.ts — pure parser for the OpenSSH "unknown host" stderr block.
//
// WHY THIS EXISTS (BET-361): runner.ts runs every ssh invocation with
// `BatchMode=yes`, which suppresses the interactive
// "Are you sure you want to continue connecting (yes/no)?" prompt. On a
// never-seen host ssh therefore prints the host-key fingerprint to stderr
// and then FAILS (exit 255, "Host key verification failed.") instead of
// waiting for input. The preflight reachability probe used to classify
// that as a generic `unreachable` (or `auth-failed`), so the user was told
// to "check the alias resolves" when what they actually wanted was to
// trust the host.
//
// This module turns that stderr block into a structured fingerprint the
// renderer can show next to a one-tap "Trust this host" button. Pure: it
// takes a string and returns a typed result — no I/O, no ssh. Tested in
// fingerprint.test.ts with the canonical OpenSSH snippets.
//
// NOTE (BET-1008): this parser is now the FALLBACK, not the primary path. On
// a NON-interactive connection OpenSSH prints ONLY "Host key verification
// failed." — the multi-line fingerprint block above appears only on a TTY, and
// a desktop app has none. So probeReachability's primary path is
// probeOfferedFingerprint (knownHosts.ts), which FETCHES the key with
// ssh-keyscan; parseFingerprint still wins when a build does print the block.
// Do not "simplify" by deleting the scan — the scan is what makes the trust
// flow work, this parser is what it falls back to.
//
// NOTE on the fingerprint vs. the host key: the SHA256 fingerprint is a
// HASH of the host's public key — it is NOT the key itself, so it cannot
// be written straight into ~/.ssh/known_hosts. knownHosts.ts fetches the
// real key with `ssh-keyscan` and verifies its fingerprint matches the one
// this parser extracted (and the user therefore trusted) before persisting
// the line. That closes the MITM gap: the key we add is provably the one
// whose fingerprint the user saw.

/** A parsed host-key fingerprint. `sha256` keeps the `SHA256:` prefix so it
 *  matches the wire format ssh prints (and what knownHosts.ts compares). */
export type HostFingerprint = {
  /** Normalized upper-case: "ED25519" | "ECDSA" | "RSA" | "DSA". */
  algo: string;
  /** The full `SHA256:<base64>` token exactly as ssh printed it. */
  sha256: string;
};

export type FingerprintParseResult =
  | { found: true; fingerprint: HostFingerprint }
  | { found: false };

// The four host-key algorithm families OpenSSH names in the prompt. Order
// is by frequency for the common case (ed25519 first).
const ALGO_RE = /\b(ED25519|ECDSA|RSA|DSA)\b/i;
// A SHA256 fingerprint token: `SHA256:` followed by standard base64 (may
// include `+`, `/`, `=` padding). We do not anchor the end so a trailing
// period (ssh prints `SHA256:….`) is tolerated.
const SHA256_RE = /SHA256:[A-Za-z0-9+/=]+/i;

/**
 * Scan an ssh stderr string for the host-key fingerprint line.
 *
 * Matches every shape OpenSSH has shipped:
 *   - `ED25519 key fingerprint is SHA256:base64.`        (modern default)
 *   - `ED25519 fingerprint: SHA256:base64`               (variant in BET-361)
 *   - `256 SHA256:base64 host (ED25519)`                 (ssh-keygen -l style)
 *
 * Returns `{ found: true, fingerprint }` for the first line that carries
 * both an algorithm name and a `SHA256:` token, `{ found: false }` for
 * unrelated stderr (Permission denied, Connection refused, etc.). The
 * algorithm is normalized to upper-case; `sha256` preserves the
 * `SHA256:` prefix verbatim.
 */
export function parseFingerprint(stderr: string): FingerprintParseResult {
  if (typeof stderr !== "string" || stderr === "") return { found: false };
  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const shaMatch = SHA256_RE.exec(line);
    if (!shaMatch) continue;
    const algoMatch = ALGO_RE.exec(line);
    if (!algoMatch) continue;
    return {
      found: true,
      fingerprint: {
        algo: algoMatch[1].toUpperCase(),
        sha256: shaMatch[0],
      },
    };
  }
  return { found: false };
}

/**
 * True when stderr indicates ssh refused the connection over a HOST KEY
 * (not auth, not network) — i.e. the "authenticity can't be established"
 * / "Host key verification failed" block. Used as a fallback for ssh builds
 * that fail without a parseable fingerprint line: those still belong to the
 * unknown-host family rather than `auth-failed` or `unreachable`.
 */
export function isHostKeyVerificationFailure(stderr: string): boolean {
  if (typeof stderr !== "string" || stderr === "") return false;
  return /Host key verification failed/i.test(stderr)
    || /authenticity of host/i.test(stderr);
}
