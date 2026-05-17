// local.mjs — implements the "local" IPC channels for the mobile server.
//
// On the desktop (Electron), many of these channels talk to the user's Mac:
// clipboard, drag-drop file paths, shell.openExternal, SSH for git/fs, etc.
// On the mobile server we ARE the remote Linux box, so git/fs run natively,
// config persists to a JSON file, and desktop-only concepts (Mac clipboard,
// drag-drop local paths, peek-remote-file-then-open-in-Mac-app, mosh transport)
// are no-ops documented below.

import { run } from "./tmux.mjs";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// ============================================================
// Config persistence (real implementation — renderer depends on it)
// ============================================================
//
// store.ts reads cfg.host (gating tmuxList/transportInfo/tmuxConfigStatus calls),
// cfg.chatAutoAllow (toggleable from Settings), cfg.uploadCleanupHours, and
// cfg.transport. Settings.tsx calls configUpdate({chatAutoAllow}).
// If all of these return empty stubs the UI would gate on cfg.host="" and never
// render projects. We therefore implement a real JSON-file-backed store.
//
// Shape mirrors src/main/config.ts DEFAULT_CONFIG + AppConfig from shared/types.ts:
//   { host, user?, identityFile?, projects, transport?, uploadCleanupHours?,
//     opencodePort?, chatAutoAllow? }
//
// On the mobile server the "host" is the local box — callers can set it if they
// want (some renderers may write it), but it defaults to "" which causes store.ts
// to skip the SSH-only calls (tmuxList is still served via its own channel).
// However, since mobile server IS local, we pre-populate host to "localhost"
// in DEFAULT_CONFIG so store.ts proceeds to call tmuxList / transportInfo /
// tmuxConfigStatus after boot.

const CONFIG_PATH = join(homedir(), ".bui-mobile", "config.json");

const DEFAULT_CONFIG = {
  host: "localhost", // triggers store.refresh() to call tmuxList / transportInfo
  projects: [],
  uploadCleanupHours: 1,
  chatAutoAllow: false,
};

let _config = null;

async function getConfig() {
  if (_config) return _config;
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = await readFile(CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      // Migrate old project shape (id/name) → { tmuxSession, defaultCwd }
      if (parsed.projects) {
        parsed.projects = parsed.projects.map((p) => {
          if (p.tmuxSession) return p;
          return { tmuxSession: p.name ?? "untitled", defaultCwd: p.defaultCwd ?? "~" };
        });
      }
      _config = { ...DEFAULT_CONFIG, ...parsed };
    } else {
      _config = { ...DEFAULT_CONFIG };
    }
  } catch {
    _config = { ...DEFAULT_CONFIG };
  }
  return _config;
}

async function saveConfig(cfg) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
  _config = cfg;
}

export async function configGet() {
  return getConfig();
}

// configUpdate(patch) — merge patch, persist, return full config.
// preload: ipcRenderer.invoke(IPC.configUpdate, patch) → args[0] = patch
export async function configUpdate(patch) {
  const current = await getConfig();
  const next = { ...current, ...patch };
  await saveConfig(next);
  return next;
}

// projectMetaUpsert(meta: ProjectMeta) → AppConfig
// preload: ipcRenderer.invoke(IPC.projectMetaUpsert, meta) → args[0] = meta
// meta shape: { tmuxSession: string; defaultCwd: string }
export async function projectMetaUpsert(meta) {
  const cfg = await getConfig();
  const projects = cfg.projects.filter((p) => p.tmuxSession !== meta.tmuxSession);
  projects.push(meta);
  const next = { ...cfg, projects };
  await saveConfig(next);
  return next;
}

// projectMetaDelete(tmuxSession: string) → AppConfig
// preload: ipcRenderer.invoke(IPC.projectMetaDelete, tmuxSession) → args[0] = tmuxSession
export async function projectMetaDelete(tmuxSession) {
  const cfg = await getConfig();
  const next = { ...cfg, projects: cfg.projects.filter((p) => p.tmuxSession !== tmuxSession) };
  await saveConfig(next);
  return next;
}

// ============================================================
// Transport info (real but mobile-appropriate values)
// ============================================================
//
// On mobile the server IS the Linux box — there is no SSH/mosh hop between the
// HTTP client (WebView on phone) and tmux. We return effective:"ssh" (most
// conservative), preference from stored config, mosh flags false.
// The renderer only reads this for display in Settings; it does not gate any
// core functionality on the effective transport.
//
// TransportInfo shape from shared/types.ts:
//   { effective: "mosh"|"ssh"; preference: "auto"|"mosh"|"ssh";
//     moshLocal: boolean; moshRemote: boolean }

export async function transportInfo() {
  const cfg = await getConfig();
  return {
    effective: "ssh",
    preference: cfg.transport ?? "auto",
    moshLocal: false,
    moshRemote: false,
  };
}

// ============================================================
// Git: list worktrees (real implementation)
// ============================================================
//
// Parses the porcelain output of `git worktree list --porcelain`.
// Exported for direct unit-testing without spawning a process.
//
// WorktreeInfo shape from shared/types.ts:
//   { path, head, branch: string|null, bare, detached }

export function parseWorktrees(porcelain) {
  const result = [];
  for (const block of porcelain.split(/\n\n+/)) {
    if (!block.trim()) continue;
    let path = "";
    let head = "";
    let branch = null;
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

// gitListWorktrees(cwd: string) → WorktreeInfo[]
// preload: ipcRenderer.invoke(IPC.gitListWorktrees, cwd) → args[0] = cwd
export async function gitListWorktrees(cwd) {
  if (!cwd || !cwd.trim()) return [];
  const { stdout } = await run("git", ["-C", cwd, "worktree", "list", "--porcelain"])
    .catch(() => ({ stdout: "" }));
  return parseWorktrees(stdout);
}

// ============================================================
// FS: directory autocomplete (real implementation)
// ============================================================
//
// Desktop: runs `ls -1Ap` over SSH and filters for dirs, filtering by prefix.
// Mobile: same semantics but local fs via readdir.
//
// Caller passes "partial path"; we split on the last "/".
// ~ and "" expand to $HOME. Returns up to 20 matches.
// Matches the desktop contract: input="~/foo" → returns ["~/foo/bar", ...] style
// (full paths so the path picker can display them).
//
// fsListDirs(partial: string) → string[]
// preload: ipcRenderer.invoke(IPC.fsListDirs, partial) → args[0] = partial

export async function fsListDirs(partial) {
  let lookup = (partial ?? "").trim();
  if (!lookup) return [];
  // Expand leading ~ to $HOME
  if (lookup === "~") lookup = homedir() + "/";
  else if (lookup.startsWith("~/")) lookup = homedir() + lookup.slice(1);

  // Split into parent dir + typed prefix to filter with.
  const m = /^(.*\/)([^/]*)$/.exec(lookup);
  if (!m) return [];
  const [, parent, prefix] = m;

  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.isDirectory() && (!prefix || e.name.startsWith(prefix)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 20)
    .map((e) => parent + e.name);
}

// ============================================================
// tmux config status / setup / restore (real implementation)
// ============================================================
//
// Desktop: shells to the remote over SSH with runSshOnce().
// Mobile: we ARE the box, so run the same shell logic locally.
// This is low-risk (read-only for status; setup/restore touch ~/.tmux.conf
// which the user can revert — same risk as on desktop).
//
// TmuxConfigStatus shape from shared/types.ts:
//   { buiManaged: boolean; backupExists: boolean }

const BUI_BEGIN = "# --- bui begin ---";
const BUI_END   = "# --- bui end ---";

const BUI_BLOCK_BODY = [
  "set -g status off",
  "set -g escape-time 10",
  "set -g focus-events on",
].join("\n");

const BUI_BLOCK = `\n${BUI_BEGIN}\n${BUI_BLOCK_BODY}\n${BUI_END}\n`;

export async function tmuxConfigStatus() {
  // Read ~/.tmux.conf and ~/.tmux.conf.pre-bui directly — no SSH needed.
  const tmuxConf = join(homedir(), ".tmux.conf");
  const tmuxConfBak = join(homedir(), ".tmux.conf.pre-bui");
  let buiManaged = false;
  let backupExists = false;
  try {
    const content = await readFile(tmuxConf, "utf-8");
    buiManaged = content.includes(BUI_BEGIN);
  } catch {
    buiManaged = false;
  }
  backupExists = existsSync(tmuxConfBak);
  return { buiManaged, backupExists };
}

export async function tmuxSetupConfig() {
  const tmuxConf = join(homedir(), ".tmux.conf");
  const tmuxConfBak = join(homedir(), ".tmux.conf.pre-bui");

  // Read current config (may not exist)
  let current = "";
  try { current = await readFile(tmuxConf, "utf-8"); } catch { current = ""; }

  if (!current.includes(BUI_BEGIN)) {
    // Backup original if not already backed up
    if (current && !existsSync(tmuxConfBak)) {
      await writeFile(tmuxConfBak, current, "utf-8");
    }
    // Append bui block
    await writeFile(tmuxConf, current + BUI_BLOCK, "utf-8");
    // Try to source it into the live tmux server (best-effort)
    await run("tmux", ["source-file", tmuxConf]).catch(() => {});
  }

  return tmuxConfigStatus();
}

export async function tmuxRestoreConfig() {
  const tmuxConf = join(homedir(), ".tmux.conf");
  const tmuxConfBak = join(homedir(), ".tmux.conf.pre-bui");

  if (existsSync(tmuxConfBak)) {
    // Restore original backup
    const original = await readFile(tmuxConfBak, "utf-8");
    await writeFile(tmuxConf, original, "utf-8");
  } else {
    // Strip bui block in place
    try {
      const content = await readFile(tmuxConf, "utf-8");
      // Remove from BUI_BEGIN line to BUI_END line (inclusive)
      const stripped = content.replace(
        new RegExp(`\\n?${escapeRegex(BUI_BEGIN)}[\\s\\S]*?${escapeRegex(BUI_END)}\\n?`, "g"),
        "",
      );
      await writeFile(tmuxConf, stripped, "utf-8");
    } catch { /* no config to restore */ }
  }

  // Unset the live server options (best-effort)
  await run("tmux", ["set-option", "-gu", "status"]).catch(() => {});
  await run("tmux", ["set-option", "-gu", "escape-time"]).catch(() => {});
  await run("tmux", ["set-option", "-gu", "focus-events"]).catch(() => {});
  await run("tmux", ["source-file", tmuxConf]).catch(() => {});

  return tmuxConfigStatus();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================
// STUBS — desktop-only concepts with no server-side equivalent
// ============================================================

// clipboardWriteText — on desktop: Electron clipboard.writeText(text).
// On mobile: the terminal's OSC 52 clipboard write goes directly to the
// device's WebView; there is no server-side clipboard. Safe no-op.
export async function clipboardWriteText() {}

// clipboardReadImage — on desktop: read Mac clipboard PNG → ArrayBuffer.
// On mobile: screenshot detection is driven by the device camera/share-sheet
// in Capacitor, not the server clipboard. Returning null means the renderer
// sees no clipboard image, which is correct. Safe no-op returning null.
export async function clipboardReadImage() {
  return null;
}

// openExternal — on desktop: shell.openExternal(url) opens Mac browser.
// On mobile: the Capacitor app handles deep links / URL opening natively.
// Links in ChatPanel are rendered as <a href> tags; this channel is only
// called on explicit "open in browser" actions from Electron menus.
// A no-op is safe — mobile users tap the link directly.
export async function openExternal() {}

// peekRemoteFile — on desktop: scp a remote file to a Mac tmp dir + open
// in the Mac default viewer. On mobile we ARE the remote, and there is no
// "open in default app" concept. A no-op means the file just isn't previewed,
// which degrades gracefully (no crash, no error toast in the renderer).
export async function peekRemoteFile() {}

// uploadFiles — on desktop: scps local Mac paths to the remote box.
// preload: uploadFiles({ projectName, localPaths }) → string[]
// On mobile: localPaths are paths that live on the CLIENT device, not on the
// server. The mobile client uses uploadBuffer (/api/upload) for file attachments
// instead (see ChatPanel.tsx — uploadBuffer path handles base64/ArrayBuffer).
// Returning [] means "no paths uploaded" — the caller falls back gracefully.
// Safe stub: confirmed by grepping ChatPanel.tsx where drag-drop local-path flow
// is the Desktop watcher path (screenshot from Mac Desktop) not the mobile path.
export async function uploadFiles() {
  return [];
}
