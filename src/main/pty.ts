import { spawn as ptySpawnNative, type IPty } from "node-pty";
import { spawn as cpSpawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join as pathJoin, basename as pathBasename } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
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
import {
  ensureRunning as ensureOpencodeRunning,
  createSession as createOpencodeSession,
  BUI_OPENCODE_TMUX_SESSION,
  OPENCODE_SID_OPT,
} from "./opencode.js";

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

// CLAUDE_CODE_NO_FLICKER=1 silences the TUI's full-screen redraw on every
// status-line update — without it the alt-screen flashes a few times per
// second under high tool-call traffic. Scoped to the `claude` invocation
// only, not the fallback `bash -i`, so a user dropping into the shell
// doesn't carry the env var into anything else.
const REMOTE_CLAUDE_CMD =
  `bash -lc 'CLAUDE_CODE_NO_FLICKER=1 claude; code=$?; printf "\\n[claude exited %d — dropping into shell]\\n" $code; exec bash -i'`;

// Chat-mode windows don't run a TUI — bui renders its own React panel into
// the slot. The tmux pane just holds the window alive so the existing
// project/window model still works. `sleep infinity` exits cleanly when the
// window is killed (no zombies) and consumes no CPU.
const REMOTE_CHAT_HOLDER_CMD = `bash -c 'exec sleep infinity'`;

// Per-window options applied to OUR rendered windows only — never `-g`.
// `opencodeSessionId` is set for chat-mode windows; stamping it as a tmux
// user-option lets tmuxList recover it later (survives renames, server restarts).
//
// IMPORTANT: tmux `set-option` defaults to SESSION scope even when the target
// is `sess:window`. Use `set-window-option` (or `set-option -w`) for true
// window-scoped user-options — otherwise every window in the same tmux
// session inherits the option value via `#{@bui-session-id}` lookups.
function perWindowOptsCmd(target: string, opencodeSessionId?: string): string {
  const ops = [
    `set-window-option -t ${shellQuote(target)} status off`,
    `set-window-option -t ${shellQuote(target)} aggressive-resize on`,
  ];
  if (opencodeSessionId) {
    ops.push(
      `set-window-option -t ${shellQuote(target)} ${OPENCODE_SID_OPT} ${shellQuote(opencodeSessionId)}`,
    );
  }
  return ops.join(" \\; ");
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
  // 6th column is `@bui-session-id` — set on chat-mode windows when bui
  // creates them. Empty for claude-TUI windows. Presence of this id is the
  // signal that the renderer should show ChatPanel instead of Terminal.
  const winFmt =
    `#{session_name}${FS}#{window_index}${FS}#{window_name}${FS}` +
    `#{?window_active,1,0}${FS}#{pane_current_path}${FS}#{${OPENCODE_SID_OPT}}`;
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
    const [sessionName, idxStr, name, activeStr, paneCurrentPath, sidRaw] = parts;
    // Hide bui's internal opencode server session from the sidebar.
    if (sessionName === BUI_OPENCODE_TMUX_SESSION) continue;
    const arr = winsBySession.get(sessionName) ?? [];
    arr.push({
      index: Number(idxStr),
      name,
      active: activeStr === "1",
      paneCurrentPath,
      opencodeSessionId: sidRaw ? sidRaw : null,
    });
    winsBySession.set(sessionName, arr);
  }

  const sessions: TmuxSession[] = [];
  for (const line of sessRes.stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split(FS);
    if (parts.length < 2) continue;
    const [name, attachedStr] = parts;
    if (name === BUI_OPENCODE_TMUX_SESSION) continue;
    sessions.push({
      name,
      attached: attachedStr === "1",
      windows: (winsBySession.get(name) ?? []).sort((a, b) => a.index - b.index),
    });
  }
  return sessions.sort((a, b) => a.name.localeCompare(b.name));
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

// For chat-mode: create opencode session via HTTP, return its id. For claude
// mode this is a no-op. Centralised here so the per-window/per-session paths
// stay aligned. When `existingSessionId` is provided, skip creation and stamp
// that id onto the tmux window — used by the fork flow where the new opencode
// session already exists.
async function maybeCreateChatSession(
  config: AppConfig,
  chatMode: boolean,
  cwd: string,
  title: string,
  existingSessionId?: string,
): Promise<string | null> {
  if (!chatMode) return null;
  if (existingSessionId) return existingSessionId;
  await ensureOpencodeRunning(config);
  const absoluteCwd = await expandRemotePath(config, cwd);
  const sess = await createOpencodeSession(config, absoluteCwd, title);
  return sess.id;
}

// Session-level survivability options. Applied to bui-created sessions only —
// never `-g`, so user-created tmux sessions outside bui keep tmux's defaults.
//
// - `exit-empty off`: THE primary teeth of this fix. Default ON makes the
//   tmux SERVER self-terminate when there are no sessions left. Failure
//   flow this blocks: user's claude TUI exits → bash fallback also exits →
//   window closes (default `remain-on-exit off`) → session has 0 windows
//   → session dies → server has 0 sessions → with `exit-empty on`, server
//   exits. Next bui call: cold-starts a new server and "can't find session:
//   <project>" is the user-visible symptom.
//
// - `destroy-unattached off`: defensive only. Tmux's CURRENT default is
//   already `off` (the man page: "leave the session orphaned"), so this is
//   a no-op against today's tmux. Set explicitly to (a) survive any future
//   default flip, and (b) override a user `~/.tmux.conf` that set
//   `destroy-unattached on` globally — without this override, every detach
//   (close bui, wifi drop with mosh) would tear the session down. The
//   tmuxNewWindow auto-heal recovers either way, but the session-pin
//   preserves window history, pane state, and `@bui-session-id` stamps.
function sessionSurvivabilityCmd(name: string): string {
  const target = shellQuote(name);
  return (
    `set-option -t ${target} exit-empty off \\; ` +
    `set-option -t ${target} destroy-unattached off`
  );
}

export async function tmuxNewSession(
  config: AppConfig,
  name: string,
  cwd: string,
  windowName: string = "default",
  chatMode: boolean = false,
): Promise<void> {
  const sid = await maybeCreateChatSession(config, chatMode, cwd, `${name} / ${windowName}`);
  const launchCmd = chatMode ? REMOTE_CHAT_HOLDER_CMD : REMOTE_CLAUDE_CMD;
  const cmd =
    `tmux new-session -d -s ${shellQuote(name)} -n ${shellQuote(windowName)} ` +
    `-c ${pathQuote(cwd)} ${shellQuote(launchCmd)} \\; ` +
    sessionSurvivabilityCmd(name) + ` \\; ` +
    perWindowOptsCmd(`${name}:${windowName}`, sid ?? undefined);
  await runSshOnce(config, cmd);
}

// True iff err's message matches tmux's "can't find session: X" stderr line.
// tmux emits this exact phrasing (libgit-style apostrophe) when a target
// session has been destroyed between the user's last interaction and the
// next bui call. Pure + exported so the auto-heal branch in tmuxNewWindow
// is covered by a unit test without spawning ssh.
export function isMissingSessionError(err: unknown, sessionName: string): boolean {
  if (!(err instanceof Error)) return false;
  // Tmux: `can't find session: <name>` (lowercase, straight apostrophe).
  // Match generously so a future locale or punctuation tweak still triggers
  // the heal — false positives just cost an extra new-session call.
  if (/can.?t find session/i.test(err.message)) return true;
  // Belt-and-braces: tmux 3.x sometimes prefixes with the session name when
  // the command form was `tmux -t NAME` rather than passing it in args.
  if (err.message.includes(`session not found: ${sessionName}`)) return true;
  return false;
}

export async function tmuxNewWindow(
  config: AppConfig,
  sessionName: string,
  windowName: string,
  cwd: string,
  chatMode: boolean = false,
  existingSessionId?: string,
): Promise<void> {
  const sid = await maybeCreateChatSession(
    config,
    chatMode,
    cwd,
    `${sessionName} / ${windowName}`,
    existingSessionId,
  );
  const launchCmd = chatMode ? REMOTE_CHAT_HOLDER_CMD : REMOTE_CLAUDE_CMD;
  // Use `-a -t session:{end}` to force insertion after the last existing
  // window. Without `-a`, tmux picks the lowest unused index ≥ base-index,
  // which can fail with "index N in use" if user-side hooks (e.g. a
  // `after-new-window` hook in ~/.tmux.conf) re-target the insertion.
  // `{end}` is tmux's "after the last window" target; combined with `-a`
  // this is the canonical "append a new window" idiom and is deterministic
  // regardless of holes from killed windows or `renumber-windows` setting.
  const target = `${sessionName}:${windowName}`;
  const cmd =
    `tmux new-window -a -t ${shellQuote(`${sessionName}:{end}`)} -n ${shellQuote(windowName)} ` +
    `-c ${pathQuote(cwd)} ${shellQuote(launchCmd)} \\; ` +
    perWindowOptsCmd(target, sid ?? undefined);
  try {
    await runSshOnce(config, cmd);
  } catch (err) {
    // Auto-heal: the project's tmux session was destroyed (server restart,
    // last window manually killed, etc.). Recreate it with this window as
    // its FIRST window — same effect as new-window, no data lost (there
    // were no other windows to lose). Without this branch the user sees
    // `ssh exited 1: can't find session: <project>` and has to recreate
    // the project from the sidebar.
    //
    // Note: we DON'T retry maybeCreateChatSession — `sid` is already
    // resolved (and any opencode session it created is reusable as the
    // new window's `@bui-session-id` stamp).
    if (!isMissingSessionError(err, sessionName)) throw err;
    const healCmd =
      `tmux new-session -d -s ${shellQuote(sessionName)} -n ${shellQuote(windowName)} ` +
      `-c ${pathQuote(cwd)} ${shellQuote(launchCmd)} \\; ` +
      sessionSurvivabilityCmd(sessionName) + ` \\; ` +
      perWindowOptsCmd(target, sid ?? undefined);
    await runSshOnce(config, healCmd);
  }
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

// Replace the @bui-session-id user-option on a chat-mode tmux window. Used by
// /clear which creates a new opencode session in place and needs the existing
// window to point at the new id (so the renderer reload sees a different
// session and unmounts/remounts ChatPanel).
export async function tmuxRestampSessionId(
  config: AppConfig,
  sessionName: string,
  windowIndex: number,
  sessionId: string,
): Promise<void> {
  const target = `${sessionName}:${windowIndex}`;
  await runSshOnce(
    config,
    `tmux set-window-option -t ${shellQuote(target)} ${OPENCODE_SID_OPT} ${shellQuote(sessionId)}`,
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

// Clipboard-paste upload: caller passes raw bytes (e.g. a PNG from the Mac
// clipboard). We write them to a local temp file, scp the temp file to the
// same ~/.bui-uploads/<session>/<ts>/<filename> layout as uploadFiles, then
// delete the temp file. Returns the single remote absolute path.
export async function uploadBuffer(
  config: AppConfig,
  projectName: string,
  filename: string,
  buffer: Buffer,
): Promise<string> {
  if (!config.host) throw new Error("No host configured");
  const tmpPath = pathJoin(tmpdir(), `bui-paste-${Date.now()}-${filename}`);
  writeFileSync(tmpPath, buffer);
  try {
    const results = await uploadFiles(config, projectName, [tmpPath]);
    // uploadFiles names the remote file after the local basename, which is the
    // bui-paste-... name. Rename it to the original filename on the remote.
    const uploadedPath = results[0];
    if (!uploadedPath) throw new Error("Upload returned no path");
    const remoteDir = uploadedPath.replace(/\/[^/]+$/, "");
    const remotePath = `${remoteDir}/${filename}`;
    await runSshOnce(config, `mv ${shellQuote(uploadedPath)} ${shellQuote(remotePath)}`);
    return remotePath;
  } finally {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }
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

// Current branch for a remote cwd, via SSH `git branch --show-current`.
//
// We DO NOT use opencode's `GET /vcs?directory=<cwd>` for this anymore.
// opencode caches the branch per-worker and only refreshes via its own
// internal watcher; a `git checkout` performed in the user's terminal does
// NOT invalidate that cache, so `/vcs` returns stale data ("main" forever)
// and `vcs.branch.updated` never fires. Going direct to `git` is
// authoritative and cheap over the warm ControlMaster (~30ms).
//
// Returns null for: no host, empty cwd, non-git dir, detached HEAD, or any
// failure. Detached HEAD is intentionally null — the footer indicator only
// makes sense as a branch name; we'd rather show nothing than `HEAD`.
// Per-cwd cache + in-flight coalescer for the branch poll. Every mounted
// ChatPanel polls `getBranch` for its own cwd every 5 s (ChatPanel.tsx
// fetchBranch). Without coalescing, N panels open on the same project →
// N concurrent ssh procs every tick, and any slowness on the remote sshd
// (MaxStartups throttling, OOM-recovery) leaves them stacking up locally
// in SN state until the warm ControlMaster also stalls and unrelated
// IPC (`tmux:select-window`) starts failing with `Session open refused by
// peer`. TTL is just under one poll tick so a fresh checkout still
// surfaces within ~5 s. In-flight dedupe collapses any concurrent panels
// onto a single ssh.
const BRANCH_CACHE_TTL_MS = 4_000;
const branchCache = new Map<string, { value: string | null; at: number }>();
const branchInFlight = new Map<string, Promise<string | null>>();

export async function getBranch(
  config: AppConfig,
  cwd: string,
): Promise<string | null> {
  if (!config.host) return null;
  const key = cwd.trim();
  if (!key) return null;
  const cached = branchCache.get(key);
  if (cached && Date.now() - cached.at < BRANCH_CACHE_TTL_MS) return cached.value;
  const inflight = branchInFlight.get(key);
  if (inflight) return inflight;
  // `git -C <dir> branch --show-current` prints the branch name or empty
  // (detached HEAD); errors go to stderr. `|| true` keeps the SSH exit zero
  // on non-repo so the catch path is reserved for real transport failures.
  const cmd =
    `git -C ${pathQuote(key)} branch --show-current 2>/dev/null || true`;
  // 8 s cap on the branch ssh specifically: the call is "instant" over a
  // warm mux (~30 ms) and the poller refires every 5 s; waiting longer
  // than the next tick adds nothing and just gives the wedge room to grow.
  const p = runSshOnce(config, cmd, { timeoutMs: 8_000 })
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null)
    .then((value) => {
      branchCache.set(key, { value, at: Date.now() });
      branchInFlight.delete(key);
      return value;
    });
  branchInFlight.set(key, p);
  return p;
}

// ===== Directory autocomplete =====
//
// `ls -1Ap <parent>` lists entries with `/` appended to directories. We keep
// only those, filter by the typed prefix, and prepend the parent so callers
// get full paths back. Bash on the remote handles `~` / `$HOME` expansion
// because pathQuote rewrites `~` to `$HOME`.
//
// Caller passes a "partial path"; we split on the last `/`. Anything without
// a slash returns [] (don't speculatively crawl `/`).

export async function listPathCompletions(
  config: AppConfig,
  partial: string,
): Promise<string[]> {
  if (!config.host) return [];
  let lookup = partial.trim();
  if (!lookup) return [];
  if (lookup === "~") lookup = "~/";
  const m = /^(.*\/)([^/]*)$/.exec(lookup);
  if (!m) return [];
  const [, parent, prefix] = m;
  const cmd = `ls -1Ap ${pathQuote(parent)} 2>/dev/null | grep '/$' || true`;
  const { stdout } = await runSshOnce(config, cmd).catch(() => ({ stdout: "" }));
  return stdout
    .split("\n")
    .map((s) => s.replace(/\/$/, ""))
    .filter((name) => name && (!prefix || name.startsWith(prefix)))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 20)
    .map((name) => parent + name);
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
  // If a pty already exists for this project, do NOT tear it down — the
  // disconnect+respawn was creating the [disconnected from X: 0] noise on
  // every window click. The renderer should call tmuxSelectWindow to switch
  // windows; the underlying mosh/ssh stays connected.
  if (ptys.has(opts.projectName)) return;

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
