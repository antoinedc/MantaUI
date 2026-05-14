import { spawn as ptySpawnNative, type IPty } from "node-pty";
import { spawn as cpSpawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join as pathJoin, basename as pathBasename } from "node:path";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { shell } from "electron";
import { BrowserWindow } from "electron";
import {
  IPC,
  type AppConfig,
  type PtyEvent,
  type SpawnOptions,
  type TmuxSession,
  type TmuxWindow,
  type WorktreeInfo,
} from "../shared/types.js";
import { info as transportInfo } from "./transport.js";

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
// The ControlPath socket has a ~104-byte limit; %C is a 16-char hash.
// `bui-cm-` + 16 hex = 23 chars under tmpdir, which fits comfortably even on
// macOS (`/var/folders/.../T/`).
const CONTROL_PATH = pathJoin(tmpdir(), "bui-cm-%C");

function sshBaseArgs(config: AppConfig): string[] {
  const args: string[] = [
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${CONTROL_PATH}`,
    "-o", "ControlPersist=10m",
  ];
  if (config.identityFile) args.push("-i", config.identityFile);
  return args;
}

export function runSshOnce(
  config: AppConfig,
  remoteCmd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (!config.host) return reject(new Error("No host configured"));
    const args = [...sshBaseArgs(config), sshTarget(config), remoteCmd];
    const proc = cpSpawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.stderr.on("data", (b) => (stderr += b.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`ssh exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function shellQuote(s: string): string {
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

// ===== tmux primitives =====
//
// Design notes for the "thin layer over tmux" model:
//   - Default socket. No -L. We share the tmux server with anything else
//     (clank, plain ssh users, etc).
//   - Don't set ANY global tmux options — it would leak into other tools.
//     Hide our per-window chrome via `set-window-option -t target status off`
//     applied right after window creation.
//   - claude runs via `bash -lc` so it picks up the user's PATH (~/.local/bin
//     etc). On error, the wrapper waits for a keypress so the user can read
//     the failure rather than seeing an instant disconnect.
//   - Mouse mode is left ON through the whole pipeline (tmux + claude), to
//     match how claude works in a native terminal: wheel scrolls claude's
//     conversation, drag-select goes to claude. Earlier experiments turned
//     mouse off to keep selection client-side in xterm.js; that broke
//     wheel-scroll in the claude TUI (xterm.js falls back to arrow keys,
//     which claude treats as prompt history). Native parity > custom UX.

const REMOTE_CLAUDE_CMD =
  `bash -lc 'claude || (printf "\\n[claude exited %d — press any key to close]" $?; read -n1)'`;

// Per-window options applied to OUR rendered windows only — never `-g`.
function perWindowOptsCmd(target: string): string {
  return [
    `set-window-option -t ${shellQuote(target)} status off`,
    `set-window-option -t ${shellQuote(target)} aggressive-resize on`,
  ].join(" \\; ");
}

// Field separator: a literal TAB (0x09). tmux ESCAPES every non-printable
// byte in its output to a 4-char backslash-octal sequence (SOH becomes
// the literal string `\001`), with tab being the one exception that
// passes through verbatim. The TAB char is embedded directly in the JS
// string — not the `\t` escape — so tmux receives an actual 0x09 byte
// in its format spec.
const FS = "	";

export async function tmuxList(config: AppConfig): Promise<TmuxSession[]> {
  if (!config.host) return [];
  const sessFmt = `#{session_name}${FS}#{?session_attached,1,0}`;
  const winFmt = `#{session_name}${FS}#{window_index}${FS}#{window_name}${FS}#{?window_active,1,0}${FS}#{pane_current_path}`;
  const paneFmt = `#{session_name}${FS}#{pane_current_command}`;

  // Don't swallow stderr — if tmux is broken on the remote we want to know.
  // `|| [ $? -eq 1 ]` lets the "no server" exit code (1) pass without erroring.
  const sessRes = await runSshOnce(
    config,
    `tmux list-sessions -F '${sessFmt}' || [ $? -eq 1 ]`,
  );
  if (!sessRes.stdout.trim()) return [];

  const [winRes, paneRes] = await Promise.all([
    runSshOnce(config, `tmux list-windows -a -F '${winFmt}' || [ $? -eq 1 ]`),
    runSshOnce(config, `tmux list-panes -a -F '${paneFmt}' || [ $? -eq 1 ]`),
  ]);

  // (clank-filter removed — bui no longer special-cases clank sessions.)
  void paneRes;

  const winsBySession = new Map<string, TmuxWindow[]>();
  for (const line of winRes.stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split(FS);
    if (parts.length < 5) continue;
    const [sessionName, idxStr, name, activeStr, paneCurrentPath] = parts;
    const arr = winsBySession.get(sessionName) ?? [];
    arr.push({
      index: Number(idxStr),
      name,
      active: activeStr === "1",
      paneCurrentPath,
    });
    winsBySession.set(sessionName, arr);
  }

  const sessions: TmuxSession[] = [];
  for (const line of sessRes.stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split(FS);
    if (parts.length < 2) continue;
    const [name, attachedStr] = parts;
    sessions.push({
      name,
      attached: attachedStr === "1",
      windows: (winsBySession.get(name) ?? []).sort((a, b) => a.index - b.index),
    });
  }
  return sessions.sort((a, b) => a.name.localeCompare(b.name));
}

export async function tmuxNewSession(
  config: AppConfig,
  name: string,
  cwd: string,
  windowName: string = "default",
): Promise<void> {
  // Detached create + per-window opts in one round trip.
  const cmd =
    `tmux new-session -d -s ${shellQuote(name)} -n ${shellQuote(windowName)} ` +
    `-c ${pathQuote(cwd)} ${shellQuote(REMOTE_CLAUDE_CMD)} \\; ` +
    perWindowOptsCmd(`${name}:${windowName}`);
  await runSshOnce(config, cmd);
}

export async function tmuxNewWindow(
  config: AppConfig,
  sessionName: string,
  windowName: string,
  cwd: string,
): Promise<void> {
  const target = `${sessionName}:${windowName}`;
  const cmd =
    `tmux new-window -t ${shellQuote(sessionName)} -n ${shellQuote(windowName)} ` +
    `-c ${pathQuote(cwd)} ${shellQuote(REMOTE_CLAUDE_CMD)} \\; ` +
    perWindowOptsCmd(target);
  await runSshOnce(config, cmd);
}

export async function tmuxRenameSession(
  config: AppConfig,
  oldName: string,
  newName: string,
): Promise<void> {
  await runSshOnce(
    config,
    `tmux rename-session -t ${shellQuote(oldName)} ${shellQuote(newName)}`,
  );
}

export async function tmuxRenameWindow(
  config: AppConfig,
  sessionName: string,
  windowIndex: number,
  newName: string,
): Promise<void> {
  await runSshOnce(
    config,
    `tmux rename-window -t ${shellQuote(`${sessionName}:${windowIndex}`)} ${shellQuote(newName)}`,
  );
}

export async function tmuxKillSession(config: AppConfig, name: string): Promise<void> {
  await runSshOnce(config, `tmux kill-session -t ${shellQuote(name)} || true`);
}

export async function tmuxKillWindow(
  config: AppConfig,
  sessionName: string,
  windowIndex: number,
): Promise<void> {
  await runSshOnce(
    config,
    `tmux kill-window -t ${shellQuote(`${sessionName}:${windowIndex}`)} || true`,
  );
}

export async function tmuxSelectWindow(
  config: AppConfig,
  sessionName: string,
  windowIndex: number,
): Promise<void> {
  await runSshOnce(
    config,
    `tmux select-window -t ${shellQuote(`${sessionName}:${windowIndex}`)}`,
  );
}

// ===== Remote tmux config management =====
//
// bui's setup is a small block of `set` lines appended to ~/.tmux.conf,
// fenced by markers. Anything outside the markers is the user's own config.
// "Setup" is idempotent: if markers already present, it's a no-op.
// "Restore" prefers the timestamped backup we made on first setup; falls
// back to stripping the block in place.

const BUI_BEGIN = "# >>> BUI BEGIN — managed by bui, do not edit between markers <<<";
const BUI_END = "# >>> BUI END <<<";

const BUI_BLOCK_BODY = [
  "set -g status off          # bui has its own chrome",
  "set -g mouse on            # wheel scroll, drag-select",
  "set -g allow-passthrough on    # required so OSC 52 from inner apps reaches xterm",
  "set -s set-clipboard external  # forward OSC 52 to outer terminal (off would drop it)",
  "set -sg escape-time 0      # snappy ESC for vim/claude",
  "set -g focus-events on",
].join("\n");

const BUI_BLOCK = `\n${BUI_BEGIN}\n${BUI_BLOCK_BODY}\n${BUI_END}\n`;

export type TmuxConfigStatus = { buiManaged: boolean; backupExists: boolean };

export async function tmuxConfigStatus(config: AppConfig): Promise<TmuxConfigStatus> {
  const cmd =
    `bui="false"; bk="false"; ` +
    `[ -f ~/.tmux.conf ] && grep -qF '${BUI_BEGIN}' ~/.tmux.conf && bui="true"; ` +
    `[ -f ~/.tmux.conf.pre-bui ] && bk="true"; ` +
    `echo "$bui $bk"`;
  const { stdout } = await runSshOnce(config, cmd);
  const [bui, bk] = stdout.trim().split(/\s+/);
  return { buiManaged: bui === "true", backupExists: bk === "true" };
}

export async function tmuxSetupConfig(config: AppConfig): Promise<void> {
  // 1. If first time (no markers), back up current config.
  // 2. Append the bui block (skipping if already present).
  // 3. Source-file so changes take effect immediately.
  const cmd = `
set -e
F=~/.tmux.conf
BU=~/.tmux.conf.pre-bui
if [ -f "$F" ] && grep -qF '${BUI_BEGIN}' "$F"; then
  : # already set up
else
  if [ -f "$F" ] && [ ! -e "$BU" ]; then
    cp -a "$F" "$BU"
  fi
  touch "$F"
  cat >> "$F" <<'BUI_EOF'
${BUI_BLOCK}BUI_EOF
fi
tmux source-file "$F" 2>/dev/null || true
`;
  await runSshOnce(config, cmd);
}

export async function tmuxRestoreConfig(config: AppConfig): Promise<void> {
  // Prefer the original backup; otherwise strip the bui block in place.
  // Then unset the running server's overrides so options fall back to whatever
  // the user's config (newly re-sourced) says — `source-file` doesn't reset
  // options that aren't explicitly in the file.
  const cmd = `
set -e
F=~/.tmux.conf
BU=~/.tmux.conf.pre-bui
if [ -e "$BU" ]; then
  cp -a "$BU" "$F"
elif [ -f "$F" ]; then
  sed -i '/^${BUI_BEGIN.replace(/[^A-Za-z0-9 ]/g, "[&]").replace(/\[ \]/g, " ")}/,/^${BUI_END.replace(/[^A-Za-z0-9 ]/g, "[&]").replace(/\[ \]/g, " ")}/d' "$F"
fi
tmux set-option -gu status 2>/dev/null || true
tmux set-option -gu escape-time 2>/dev/null || true
tmux set-option -gu focus-events 2>/dev/null || true
tmux source-file "$F" 2>/dev/null || true
`;
  await runSshOnce(config, cmd);
}

// ===== Drag-and-drop upload =====
//
// Uploads land in `$HOME/.bui-uploads/<session>/<ts>/` on the remote, scp'd
// over the same ControlMaster socket as everything else (so it's instant
// after the first connect). We resolve $HOME once per host so we can return
// absolute remote paths — Claude's Read tool wants absolute, not tilde.

let cachedRemoteHome: { host: string; user?: string; home: string } | null = null;

async function remoteHome(config: AppConfig): Promise<string> {
  if (
    cachedRemoteHome &&
    cachedRemoteHome.host === config.host &&
    cachedRemoteHome.user === config.user
  ) {
    return cachedRemoteHome.home;
  }
  const { stdout } = await runSshOnce(config, `printf %s "$HOME"`);
  const home = stdout.trim();
  if (!home) throw new Error("Could not resolve remote $HOME");
  cachedRemoteHome = { host: config.host, user: config.user, home };
  return home;
}

export async function uploadFiles(
  config: AppConfig,
  projectName: string,
  localPaths: string[],
): Promise<string[]> {
  if (!config.host) throw new Error("No host configured");
  if (localPaths.length === 0) return [];
  const home = await remoteHome(config);
  // Sanitize the session segment — tmux allows looser names than we want in a path.
  const safeProj = projectName.replace(/[^A-Za-z0-9._-]/g, "_") || "session";
  const ts = Date.now();
  const remoteDir = `${home}/.bui-uploads/${safeProj}/${ts}`;
  await runSshOnce(config, `mkdir -p ${shellQuote(remoteDir)}`);
  await scpUpload(config, localPaths, remoteDir);
  return localPaths.map((p) => `${remoteDir}/${pathBasename(p)}`);
}

// Click-to-peek: scp a remote file into a per-host cache dir and open it with
// the user's default app. Each click overwrites the cached copy so the user
// gets fresh content; we don't try to be clever about caching by mtime.
export async function peekRemoteFile(config: AppConfig, remotePath: string): Promise<void> {
  if (!config.host) throw new Error("No host configured");
  if (!remotePath) throw new Error("Empty path");
  const key = createHash("sha1")
    .update(`${config.host}|${config.user || ""}|${remotePath}`)
    .digest("hex")
    .slice(0, 16);
  const cacheDir = pathJoin(tmpdir(), "bui-peek", key);
  mkdirSync(cacheDir, { recursive: true });
  const localPath = pathJoin(cacheDir, pathBasename(remotePath) || "file");
  await scpDownload(config, remotePath, localPath);
  const err = await shell.openPath(localPath);
  if (err) throw new Error(err);
}

function scpDownload(
  config: AppConfig,
  remotePath: string,
  localPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args: string[] = [
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${CONTROL_PATH}`,
      "-o", "ControlPersist=10m",
      "-q",
    ];
    if (config.identityFile) args.push("-i", config.identityFile);
    // OpenSSH 9.0+ defaults to the SFTP transport, which passes the remote
    // path verbatim (no remote shell). Don't shell-quote — the quotes would
    // become part of the path. SFTP handles spaces / special chars natively.
    args.push(`${sshTarget(config)}:${remotePath}`, localPath);
    const proc = cpSpawn("scp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (b) => (stderr += b.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`scp exited ${code}: ${stderr.trim() || "download failed"}`));
    });
  });
}

// Sweep upload batches older than `hours`. Layout is
// $HOME/.bui-uploads/<session>/<ts>/<files>, so we delete whole `<ts>` dirs
// (each one is a single drop batch, so file ages within a batch are uniform)
// and then prune any session dirs left empty.
export async function cleanupUploads(config: AppConfig, hours: number): Promise<void> {
  if (!config.host) return;
  if (!Number.isFinite(hours) || hours <= 0) return;
  const home = await remoteHome(config).catch(() => null);
  if (!home) return;
  const root = `${home}/.bui-uploads`;
  const minutes = Math.max(1, Math.round(hours * 60));
  const cmd =
    `if [ -d ${shellQuote(root)} ]; then ` +
    `find ${shellQuote(root)} -mindepth 2 -maxdepth 2 -type d -mmin +${minutes} -exec rm -rf {} + 2>/dev/null; ` +
    `find ${shellQuote(root)} -mindepth 1 -type d -empty -delete 2>/dev/null; ` +
    `fi; true`;
  await runSshOnce(config, cmd).catch(() => {});
}

function scpUpload(
  config: AppConfig,
  localPaths: string[],
  remoteDir: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args: string[] = [
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${CONTROL_PATH}`,
      "-o", "ControlPersist=10m",
      "-q", // suppress progress meter
    ];
    if (config.identityFile) args.push("-i", config.identityFile);
    // remoteDir is built from a hostname-safe `$HOME` + sanitized segments —
    // no spaces or shell metachars — so we can pass it raw after the colon.
    args.push(...localPaths, `${sshTarget(config)}:${remoteDir}/`);
    const proc = cpSpawn("scp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (b) => (stderr += b.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`scp exited ${code}: ${stderr.trim() || "upload failed"}`));
    });
  });
}

// ===== Git worktrees =====
//
// `git worktree list --porcelain` from inside any worktree returns the full
// list (one block per worktree, blocks separated by blank lines). We run it
// via `cd` so `~` expands on the remote shell, and swallow non-zero exits
// (non-repo, no git, missing dir) — caller treats empty list as "nothing to
// auto-detect, proceed with one window".

export async function listWorktrees(
  config: AppConfig,
  cwd: string,
): Promise<WorktreeInfo[]> {
  if (!config.host) return [];
  if (!cwd.trim()) return [];
  const cmd =
    `cd ${pathQuote(cwd)} 2>/dev/null && ` +
    `git worktree list --porcelain 2>/dev/null || true`;
  const { stdout } = await runSshOnce(config, cmd).catch(() => ({ stdout: "" }));
  return parseWorktreePorcelain(stdout);
}

function parseWorktreePorcelain(out: string): WorktreeInfo[] {
  const result: WorktreeInfo[] = [];
  for (const block of out.split(/\n\n+/)) {
    if (!block.trim()) continue;
    let path = "";
    let head = "";
    let branch: string | null = null;
    let bare = false;
    let detached = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("HEAD ")) head = line.slice(5);
      else if (line.startsWith("branch ")) {
        const ref = line.slice(7);
        branch = ref.startsWith("refs/heads/") ? ref.slice(11) : ref;
      } else if (line === "bare") bare = true;
      else if (line === "detached") detached = true;
    }
    if (!path) continue;
    result.push({ path, head, branch, bare, detached });
  }
  return result;
}

export async function remoteDirExists(config: AppConfig, cwd: string): Promise<boolean> {
  try {
    await runSshOnce(config, `test -d ${pathQuote(cwd)}`);
    return true;
  } catch {
    return false;
  }
}

// ===== Long-lived attached PTYs (1 per project) =====

const ptys = new Map<string, IPty>();

function emit(win: BrowserWindow, event: PtyEvent): void {
  if (!win.isDestroyed()) win.webContents.send(IPC.ptyEvent, event);
}

export async function spawnPty(
  win: BrowserWindow,
  config: AppConfig,
  opts: SpawnOptions,
): Promise<void> {
  if (ptys.has(opts.projectName)) killPty(opts.projectName);

  // No per-session option overrides — bui's setup writes the options it
  // needs into the user's ~/.tmux.conf instead. Just attach.
  const target = shellQuote(opts.projectName);
  const remoteCmd = `tmux attach-session -t ${target}`;

  // Transport: mosh if available on both ends, else fall back to plain ssh.
  // Mosh tolerates wifi drops / sleep / IP changes (UDP + state-sync), but
  // requires the binary on the Mac and `mosh-server` on the remote.
  const t = await transportInfo(config);
  const targetHost = sshTarget(config);

  let cmd: string;
  let args: string[];
  if (t.effective === "mosh") {
    // mosh runs the post-`--` args via execvp (no shell), so wrap in
    // `bash -c` to preserve tmux's `\;` command-sequence syntax.
    cmd = "mosh";
    args = [];
    if (config.identityFile) args.push(`--ssh=ssh -i ${config.identityFile}`);
    args.push(targetHost, "--", "bash", "-c", remoteCmd);
  } else {
    cmd = "ssh";
    args = ["-tt", ...sshBaseArgs(config), targetHost, remoteCmd];
  }

  const pty = ptySpawnNative(cmd, args, {
    name: "xterm-256color",
    cols: opts.cols,
    rows: opts.rows,
    env: { ...process.env, TERM: "xterm-256color" },
  });
  ptys.set(opts.projectName, pty);

  pty.onData((data) =>
    emit(win, { kind: "data", projectName: opts.projectName, data }),
  );
  pty.onExit(({ exitCode }) => {
    emit(win, { kind: "exit", projectName: opts.projectName, code: exitCode });
    ptys.delete(opts.projectName);
  });
}

export function writePty(projectName: string, data: string): void {
  ptys.get(projectName)?.write(data);
}

export function resizePty(projectName: string, cols: number, rows: number): void {
  ptys.get(projectName)?.resize(cols, rows);
}

export function killPty(projectName: string): void {
  const p = ptys.get(projectName);
  if (!p) return;
  try { p.kill(); } catch { /* already gone */ }
  ptys.delete(projectName);
}

export function killAll(): void {
  for (const id of [...ptys.keys()]) killPty(id);
}

export function hasPty(projectName: string): boolean {
  return ptys.has(projectName);
}
