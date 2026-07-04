import { spawn as cpSpawn } from "node:child_process";
import { join as pathJoin } from "node:path";
import type { AppConfig } from "../shared/types.js";

// ===== ssh helpers =====

function sshTarget(config: AppConfig): string {
  return config.user ? `${config.user}@${config.host}` : config.host;
}

// SSH ControlMaster: reuse a single underlying SSH connection across all
// side-channel calls. Without it, every tmuxList / save-buffer / etc spawns a
// fresh SSH (TCP+kex, ~200-400ms). With it, the first call establishes a
// master and subsequent calls are sub-50ms — critical for the on-mouseup
// clipboard fetch where latency is user-visible.
//
// The ControlPath socket has a ~104-byte sun_path limit; %C is a 16-char hash
// and ssh appends a ~17-char random suffix while establishing the master.
// macOS `tmpdir()` is `/var/folders/<...>/T/` (~50 chars) which blows the
// limit, so anchor the socket in a short fixed dir instead.
const CONTROL_DIR = "/tmp";
const CONTROL_PATH = pathJoin(CONTROL_DIR, "bui-cm-%C");

function sshBaseArgs(config: AppConfig): string[] {
  const args: string[] = [
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${CONTROL_PATH}`,
    "-o", "ControlPersist=10m",
  ];
  if (config.identityFile) args.push("-i", config.identityFile);
  return args;
}

// Hard timeout for one-shot ssh calls. Without this, an ssh process that
// blocks on the remote (mux wedge, remote sshd at MaxStartups, network
// blackhole) sits forever in SN state. Per-tick pollers (footer branch,
// auto-refresh) then pile up dozens of wedged ssh procs locally while the
// remote sshd hits its connection-rate cap → the user sees random
// "Connection reset by peer" / "Session open refused by peer" errors on
// otherwise-fine actions like tmux:select-window. 60 s is generous for any
// real ssh side-channel call (tmuxList, branch, dir checks); anything
// longer is the wedge.
const DEFAULT_SSH_TIMEOUT_MS = 60_000;

export function runSshOnce(
  config: AppConfig,
  remoteCmd: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (!config.host) return reject(new Error("No host configured"));
    const args = [...sshBaseArgs(config), sshTarget(config), remoteCmd];
    const proc = cpSpawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // SIGKILL: the proc is wedged in a network wait — SIGTERM may not
      // dislodge it before the next poll tick spawns another one.
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      reject(new Error(`ssh timed out after ${timeoutMs}ms: ${remoteCmd.slice(0, 80)}`));
    }, timeoutMs);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.stderr.on("data", (b) => (stderr += b.toString()));
    proc.on("error", (err) => finish(() => reject(err)));
    proc.on("exit", (code) => {
      finish(() => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`ssh exited ${code}: ${stderr.trim() || stdout.trim()}`));
      });
    });
  });
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Quote a remote path so leading `~` expands. Single-quoting suppresses tilde
// expansion, which silently makes tmux fall back to $HOME when -c can't chdir.
function pathQuote(s: string): string {
  let p = s;
  if (p === "~") p = "$HOME";
  else if (p.startsWith("~/")) p = "$HOME/" + p.slice(2);
  return `"${p.replace(/(["\\`])/g, "\\$1")}"`;
}

// Resolve `~` and `~/foo` to absolute paths via the remote shell — opencode's
// session.create wants an absolute directory. Tilde forms work for tmux's -c.
// Exported because opencode.ts:createSession must expand too: opencode
// resolves a tilde-relative directory against its OWN remote cwd ($HOME),
// silently persisting `/home/dev/~/projects/x`. Expanding at every
// session-create boundary makes that corruption unreachable.
export async function expandRemotePath(config: AppConfig, p: string): Promise<string> {
  if (p && !p.startsWith("~") && p.startsWith("/")) return p;
  const { stdout } = await runSshOnce(
    config,
    `cd ${pathQuote(p || "~")} && pwd`,
  );
  return stdout.trim() || p;
}
