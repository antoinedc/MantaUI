// sshResolved.ts — parse `ssh -G <alias>` output.
//
// `ssh -G` is OpenSSH's "dry-run config resolution": it prints the effective
// connection settings for an alias, AFTER Includes / Match / defaults are
// applied. We use it as the single source of truth for what to actually pass
// to `ssh <alias> install.sh` so the desktop never needs to re-implement the
// user's ssh_config parser for connection settings (only for listing aliases,
// which is sshConfig.ts's narrower job).
//
// `ssh -G` emits key=value pairs, one per line, lowercased keys. The full set
// is documented in ssh_config(5); we read the ones we need and ignore the
// rest. The fields we extract:
//
//   hostname      — the actual host (DNS / IP) to connect to
//   user          — SSH login user (defaults to the local user)
//   port          — TCP port (defaults to 22)
//   identityfile  — one per line, multiple lines possible (we keep the first
//                   non-empty — PuTTY keys and agent-only setups are not
//                   representable in this list, see preflight.ts)
//   stricthostkeychecking — useful for the batch-mode reachability probe
//   userknownhostsfile — needed for the same reason
//
// Pure: takes the captured stdout string, returns the parsed fields. The
// caller shells out to `ssh -G` and passes the result in. Tested in
// sshResolved.test.ts.

export type ResolvedSshConnection = {
  hostname: string | null;
  user: string | null;
  port: number | null;
  identityFiles: string[];
};

const HOSTNAME_RE = /^hostname\s+(.+)$/;
const USER_RE = /^user\s+(.+)$/;
const PORT_RE = /^port\s+(\d+)$/;
const IDENTITY_RE = /^identityfile\s+(.+)$/;

/**
 * Parse `ssh -G` output into the connection fields we need. Unknown lines are
 * silently ignored — `ssh -G` emits ~20 fields and we read four. Empty / null
 * input → all fields null.
 */
export function parseSshG(stdout: string): ResolvedSshConnection {
  const result: ResolvedSshConnection = {
    hostname: null,
    user: null,
    port: null,
    identityFiles: [],
  };
  if (typeof stdout !== "string" || stdout === "") return result;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === "") continue;
    let m: RegExpExecArray | null;
    if ((m = HOSTNAME_RE.exec(line))) {
      result.hostname = m[1].trim();
    } else if ((m = USER_RE.exec(line))) {
      result.user = m[1].trim();
    } else if ((m = PORT_RE.exec(line))) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) result.port = n;
    } else if ((m = IDENTITY_RE.exec(line))) {
      const v = m[1].trim();
      if (v !== "") result.identityFiles.push(v);
    }
  }
  return result;
}
