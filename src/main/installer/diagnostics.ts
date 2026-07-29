// diagnostics.ts — build a single "copy diagnostics" string the user can paste
// into a bug report. Redacts anything credential-shaped (tokens, pairing
// codes, paths with ~/.ssh/id_*, host fingerprints) so a stray paste doesn't
// leak a secret.
//
// WHAT THE USER CANNOT READ WITHOUT THIS: preflight verdict (which branch
// failed), install stage reached, tail of the install log. All three are
// required for a useful bug report. The renderer calls
// `buildDiagnostics(preflight, stageState, logTail)` and copies the result
// to the clipboard.
//
// Pure: takes structured input, returns a single string. No I/O — the
// caller copies the result to the clipboard. Tested in diagnostics.test.ts.

import type { PreflightResult } from "./preflight.js";
import type { InstallStageId } from "./stageMapper.js";

export type DiagnosticsInput = {
  /** The structured preflight verdict (with probes + failures + warnings). */
  preflight: PreflightResult;
  /** The current install stage at the moment the user clicked "copy". */
  stage: InstallStageId;
  /** Tail of the install log (most recent N lines). */
  logTail: string[];
  /** Optional: box host / alias the install was running against. */
  alias?: string;
};

// Redaction patterns. Each matches one specific shape, not generic English.
// Every replacement is a stable token (the user can see WHAT was redacted
// without seeing the value).

const PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // Bearer tokens / Authorization headers MUST run first — a bearer is
  // almost always a 32-hex token, and we want to label it as a bearer (more
  // diagnostic-relevance) rather than a generic "32hex" redaction. After
  // this runs, the token is "[REDACTED:bearer-token]" — no longer 32 hex.
  {
    re: /(Bearer\s+)[A-Za-z0-9._~+/=-]+/g,
    replacement: "$1[REDACTED:bearer-token]",
  },
  // 32-hex box_id / box_token (matching the auth.mjs / transport.mjs shape).
  // Case-insensitive so an uppercase hex token still gets caught.
  {
    re: /\b[0-9a-f]{32}\b/gi,
    replacement: "[REDACTED:32hex]",
  },
  // 6-digit pairing code (auth.mjs `isValidPairingCode`).
  // Anchored as a standalone token so we don't mangle other 6-digit numbers
  // (timestamps like "123456" wouldn't appear here, but be safe).
  {
    re: /\b\d{6}\b/g,
    replacement: "[REDACTED:pairing-code]",
  },
  // SSH identity file paths — strip the private-key path; keep the basename
  // shape ("id_ed25519") for diagnostics usefulness.
  {
    re: /(?:\/Users\/[^\s]+\/|\/home\/[^\s]+\/|\/root\/|\/\.ssh\/)[\w.-]+(?=[\s'"`]|$)/g,
    replacement: "[REDACTED:ssh-key-path]",
  },
  // host fingerprint lines (`SHA256:base64…` is what ssh-keyscan / known_hosts
  // carry). The base64 is opaque so we drop the whole tail.
  {
    re: /SHA256:[A-Za-z0-9+/=]+/g,
    replacement: "[REDACTED:host-fingerprint]",
  },
];

/**
 * Apply every redaction pattern to a single line. Returns the sanitised
 * string. Order doesn't matter — the patterns are non-overlapping in
 * practice.
 */
export function redactLine(line: string): string {
  if (typeof line !== "string" || line === "") return "";
  let out = line;
  for (const { re, replacement } of PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * Build the diagnostics string. The shape is intentional:
 *
 *   ## MantaUI installer diagnostics
 *   alias: <alias or "n/a">
 *   stage: <InstallStageId>
 *   ## Preflight
 *   ok: <true|false>
 *   ingressMode: <IngressMode>
 *   failures:
 *     - cause: <text>
 *       action: <text>
 *   warnings:
 *     - <text>
 *   probes:
 *     reachability: <…>
 *     os: linux/x64 release=…
 *     passwordlessSudo: …
 *     tailscale: running=false ipv4=null
 *     clockSkewSeconds: …
 *     alreadyInstalled: …
 *   ## Install log (tail)
 *   <sanitised line 1>
 *   <sanitised line 2>
 *   …
 *
 * Pure: takes the structured input, returns the markdown-ish blob. Caller
 * copies to clipboard. The shape is a deliberately-flat key=value per line
 * so it survives being pasted into Slack / GitHub / a Notion page without
 * rendering as a code block.
 */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const out: string[] = [];
  out.push("## MantaUI installer diagnostics");
  out.push(`alias: ${input.alias ?? "n/a"}`);
  out.push(`stage: ${input.stage}`);
  out.push("## Preflight");
  const p = input.preflight;
  out.push(`ok: ${p.ok ? "true" : "false"}`);
  out.push(`ingressMode: ${p.ingressMode}`);
  if (p.failures.length > 0) {
    out.push("failures:");
    for (const f of p.failures) {
      out.push(`  - cause: ${redactLine(f.cause)}`);
      out.push(`    action: ${redactLine(f.action)}`);
    }
  } else {
    out.push("failures: []");
  }
  if (p.warnings.length > 0) {
    out.push("warnings:");
    for (const w of p.warnings) {
      out.push(`  - ${redactLine(w.message)}`);
    }
  } else {
    out.push("warnings: []");
  }
  const probes = p.probes;
  out.push(
    `probes: reachability=${probes.reachability} os=${probes.os.id}/${probes.os.arch} release=${probes.os.release ?? "unknown"} passwordlessSudo=${probes.passwordlessSudo} tailscale=running=${probes.tailscale.running} ipv4=${probes.tailscale.ipv4 ?? "null"} clockSkewSeconds=${probes.clockSkewSeconds} alreadyInstalled=${probes.alreadyInstalled}`,
  );
  out.push("## Install log (tail)");
  if (input.logTail.length === 0) {
    out.push("(empty)");
  } else {
    for (const line of input.logTail) {
      out.push(redactLine(line));
    }
  }
  return out.join("\n");
}
