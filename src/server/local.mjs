// local.mjs — implements the "local" IPC channels for the mobile server.
//
// On the desktop (Electron), many of these channels talk to the user's Mac:
// clipboard, drag-drop file paths, shell.openExternal, SSH for git/fs, etc.
// On the mobile server we ARE the remote Linux box, so git/fs run natively,
// config persists to a JSON file, and desktop-only concepts (Mac clipboard,
// drag-drop local paths, peek-remote-file-then-open-in-Mac-app, mosh transport)
// are no-ops documented below.

import { run } from "./tmux.mjs";
import { spawn as nodeSpawn } from "node:child_process";
import { readdir, readFile, stat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { statePath, expandTilde } from "../shared/paths.mjs";
import { deriveWorktree, isWorktreeDirtyError } from "../shared/worktree.mjs";
import { detectForge, repoKey } from "../shared/forge.mjs";
import { runLoginShell } from "./launchers.mjs";
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";

// ============================================================
// Config persistence (real implementation — renderer depends on it)
// ============================================================
//
// store.ts reads cfg.chatAutoAllow (toggleable from Settings).
// If chatAutoAllow returns a falsy value the UI renders fine (it's just off).
//
// Shape mirrors src/main/config.ts DEFAULT_CONFIG + AppConfig from shared/types.ts:
//   { projects, chatAutoAllow }
//
// On the mobile server we ARE the remote Linux box, so git/fs run natively
// and desktop-only concepts (Mac clipboard, drag-drop local paths, peek-remote-file)
// are no-ops documented below.

const CONFIG_PATH = statePath("config.json");

// atomic writes route through jsonStore.mjs (single source of truth for the
// temp-file-then-rename dance). `writeJsonAtomic` takes already-serialized
// bytes, so it works for the config JSON and the plain-text ~/.tmux.conf
// rewrites alike.

const DEFAULT_CONFIG = {
  projects: [],
  chatAutoAllow: false,
  // BET-246: per-session worktree defaults (settings-only — read via the
  // generic configGet/configUpdate channel like every other AppConfig field).
  worktreePerSession: false,
  worktreeCleanOnClose: false,
  // BET-427: hours an upload batch dir survives before the hourly sweep in
  // uploads.mjs deletes it. 0 disables cleanup. Default 24h (more forgiving
  // than the old 1h so a file survives a long session).
  uploadCleanupHours: 24,
  // BET-834: hours a voice note's audio survives before the voiceNotes.mjs
  // sweep deletes the file (transcript + waveform are kept forever). 0 = keep
  // forever. Default 168 (7 days).
  voiceNoteTtlHours: 168,
  // BET-799: user-configured self-hosted forge hosts — `[{ host, kind, apiBase? }]`.
  // Lets a self-hosted GitHub/GitLab instance (which `detectForge` deliberately
  // rejects) resolve to its forge + API root. `kind` is "github" | "gitlab".
  forgeHosts: [],
};

let _config = null;

async function getConfig() {
  if (_config) return _config;
  const parsed = readJsonSync(CONFIG_PATH, null);
  if (parsed) {
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
  return _config;
}

async function saveConfig(cfg) {
  await writeJsonAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2));
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

// gitAddWorktree({ cwd, name }) → { path, branch }
// preload: ipcRenderer.invoke(IPC.gitAddWorktree, { cwd, name }) → args[0] = { cwd, name }
// Resolve repoRoot via `git -C <cwd> rev-parse --show-toplevel`; pick a
// non-colliding sibling path + branch via the pure deriveWorktree helper;
// then run `git worktree add -b <branch> <path>` from the repo root. Errors
// propagate (fail-closed) so the renderer's createSession can surface them
// without falling back to the shared dir. Pure naming + collision logic
// lives in src/shared/worktree.mjs — keep all string-shape work there.
export async function gitAddWorktree({ cwd, name }) {
  if (!cwd || !cwd.trim()) throw new Error("cwd is required");
  if (!name || !name.trim()) throw new Error("name is required");
  const { stdout: repoRootRaw } = await run("git", [
    "-C", cwd, "rev-parse", "--show-toplevel",
  ]);
  const repoRoot = (repoRootRaw ?? "").trim();
  if (!repoRoot) throw new Error("not a git repository");
  // Pre-resolve the full branch set so deriveWorktree's collision check
  // matches reality in a single pass (avoids a per-candidate git fork).
  const { stdout: branchesRaw } = await run("git", [
    "-C", repoRoot, "for-each-ref", "--format=%(refname:short)", "refs/heads",
  ]);
  const branchSet = new Set(
    (branchesRaw ?? "").split("\n").map((b) => b.trim()).filter(Boolean),
  );
  const { path, branch } = deriveWorktree({
    repoRoot,
    name,
    dirExists: (p) => existsSync(p),
    branchExists: (b) => branchSet.has(b),
  });
  try {
    await run("git", ["-C", repoRoot, "worktree", "add", "-b", branch, path]);
  } catch (err) {
    // Re-throw with the git stderr in the message so the renderer can show
    // it without having to inspect the raw error object.
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg);
  }
  return { path, branch };
}

// gitRemoveWorktree({ path, force }) → { removed, reason? }
// preload: ipcRenderer.invoke(IPC.gitRemoveWorktree, { path, force }) → args[0] = { path, force }
// Safe-first remove; on git's "dirty checkout" refusal, return
// { removed:false, reason:"dirty" } so the renderer can confirm before
// retrying with --force. Any OTHER error rethrows so the renderer can show
// it verbatim. The renderer MUST NOT string-match git output — all of it
// lives in isWorktreeDirtyError (src/shared/worktree.mjs).
export async function gitRemoveWorktree({ path: wtPath, force }) {
  if (!wtPath || !wtPath.trim()) throw new Error("path is required");
  // Resolve branch BEFORE removal: after `worktree remove` the worktree
  // directory is gone and `git -C <wt>` would fail. Best-effort branch
  // delete — a non-clean branch with `-d` will refuse, and that's fine
  // (the renderer chose not to force the worktree, so we don't force
  // the branch either).
  let branch = "";
  let parentRepo = "";
  try {
    const { stdout } = await run("git", [
      "-C", wtPath, "rev-parse", "--abbrev-ref", "HEAD",
    ]);
    branch = (stdout ?? "").trim();
    const { stdout: commonDir } = await run("git", [
      "-C", wtPath, "rev-parse", "--path-format=absolute", "--git-common-dir",
    ]);
    // git-common-dir is the shared .git dir; the repo root for branch
    // commands is its grandparent (or the same dir for non-linked worktrees).
    parentRepo = dirname((commonDir ?? "").trim() || wtPath);
  } catch {
    // branch resolution failed → skip the branch delete (best-effort).
  }
  let removeErr = null;
  try {
    const args = ["worktree", "remove", ...(force ? ["--force"] : []), wtPath];
    await run("git", ["-C", wtPath, ...args]);
  } catch (err) {
    removeErr = err;
  }
  if (removeErr) {
    // run()'s rejection message already embeds the stderr ("<cmd> exited N: <stderr>"),
    // so feed err.message straight into the classifier — no separate stderr field.
    const msg = removeErr instanceof Error ? removeErr.message : String(removeErr);
    if (!force && isWorktreeDirtyError(msg)) {
      return { removed: false, reason: "dirty" };
    }
    throw new Error(msg);
  }
  if (branch && parentRepo) {
    try {
      await run("git", [
        "-C", parentRepo, "branch", force ? "-D" : "-d", branch,
      ]);
    } catch {
      // Best-effort: an unmerged branch will refuse -d; that's fine.
    }
  }
  return { removed: true };
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
  const raw = (partial ?? "").trim();
  if (!raw) return [];
  // Remember whether the caller asked in tilde-form so the returned paths
  // match the form they typed. Without this, typing `~/pro` returned
  // absolute `/home/dev/projects`, which the renderer's `m.startsWith(value)`
  // filter (Sidebar.tsx / MobileCreateSheet.tsx) rejected — autocomplete went
  // dead for every `~` path.
  const isTilde = raw === "~" || raw.startsWith("~/");
  // Expand leading ~ to $HOME — `expandTilde` lives in src/shared/paths.mjs
  // and is the single source of truth.
  let lookup = isTilde ? expandTilde(raw) : raw;
  // Special case: a bare `~` must list the HOME directory's children, NOT
  // `/home`'s. The general split would yield parent=`/home/`, prefix=`dev`
  // and start listing `/home`'s entries. Force a trailing slash so the
  // parent/prefix split lands on `homedir() + "/"` and the prefix is empty.
  if (raw === "~") lookup = homedir() + "/";

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

  const home = homedir();
  return entries
    .filter((e) => e.isDirectory() && (!prefix || e.name.startsWith(prefix)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 20)
    .map((e) => {
      const abs = parent + e.name;
      // Translate back to tilde-form if the input was tilde-form, so the
      // renderer's `startsWith(value)` filter and the ghost-text suggestion
      // both work.
      return isTilde && abs.startsWith(home) ? "~" + abs.slice(home.length) : abs;
    });
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
//   { mantaManaged: boolean; backupExists: boolean }

const MANTA_BEGIN = "# --- manta begin ---";
const MANTA_END   = "# --- manta end ---";

const MANTA_BLOCK_BODY = [
  "set -g status off",
  "set -g escape-time 10",
  "set -g focus-events on",
].join("\n");

const MANTA_BLOCK = `\n${MANTA_BEGIN}\n${MANTA_BLOCK_BODY}\n${MANTA_END}\n`;

export async function tmuxConfigStatus() {
  // Read ~/.tmux.conf and ~/.tmux.conf.pre-manta directly — no SSH needed.
  const tmuxConf = join(homedir(), ".tmux.conf");
  const tmuxConfBak = join(homedir(), ".tmux.conf.pre-manta");
  let mantaManaged = false;
  let backupExists = false;
  try {
    const content = await readFile(tmuxConf, "utf-8");
    mantaManaged = content.includes(MANTA_BEGIN);
  } catch {
    mantaManaged = false;
  }
  backupExists = existsSync(tmuxConfBak);
  return { mantaManaged, backupExists };
}

export async function tmuxSetupConfig() {
  const tmuxConf = join(homedir(), ".tmux.conf");
  const tmuxConfBak = join(homedir(), ".tmux.conf.pre-manta");

  // Read current config (may not exist)
  let current = "";
  try { current = await readFile(tmuxConf, "utf-8"); } catch { current = ""; }

  if (!current.includes(MANTA_BEGIN)) {
    // Backup original if not already backed up
    if (current && !existsSync(tmuxConfBak)) {
      await writeJsonAtomic(tmuxConfBak, current);
    }
    // Append manta block (full-file rewrite — atomic to avoid blank tmux.conf on crash)
    await writeJsonAtomic(tmuxConf, current + MANTA_BLOCK);
    // Try to source it into the live tmux server (best-effort)
    await run("tmux", ["source-file", tmuxConf]).catch(() => {});
  }

  return tmuxConfigStatus();
}

export async function tmuxRestoreConfig() {
  const tmuxConf = join(homedir(), ".tmux.conf");
  const tmuxConfBak = join(homedir(), ".tmux.conf.pre-manta");

  if (existsSync(tmuxConfBak)) {
    // Restore original backup (full-file rewrite — atomic to avoid blank tmux.conf on crash)
    const original = await readFile(tmuxConfBak, "utf-8");
    await writeJsonAtomic(tmuxConf, original);
  } else {
    // Strip manta block in place (full-file rewrite — atomic)
    try {
      const content = await readFile(tmuxConf, "utf-8");
      // Remove from MANTA_BEGIN line to MANTA_END line (inclusive)
      const stripped = content.replace(
        new RegExp(`\\n?${escapeRegex(MANTA_BEGIN)}[\\s\\S]*?${escapeRegex(MANTA_END)}\\n?`, "g"),
        "",
      );
      await writeJsonAtomic(tmuxConf, stripped);
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
// Repo probe — scan the box for git repos + read origins + gh CLI (BET-786)
// ============================================================
//
// First-run affordance (spec §7): ask "what repos do you already have?" without
// the user typing a path. Pure scanning/detection logic is exported for tests;
// the walk + git spawns stay here. Server-side only, ships no UI.

// gitRemoteOrigin(cwd) → string | null
// Returns `git -C <cwd> remote get-url origin` trimmed, or null on any failure
// (no remote, not a repo, git missing). Never throws.
export async function gitRemoteOrigin(cwd) {
  try {
    const { stdout } = await run("git", ["-C", cwd, "remote", "get-url", "origin"]);
    const url = (stdout ?? "").trim();
    return url || null;
  } catch {
    return null;
  }
}

// Network git gets its OWN path (BET-794 §2, BET-796 §3).
//
// The shared `run()` helper in tmux.mjs kills at 10s, which is tuned for local
// commands and WILL kill a real push or a cold clone (both routinely exceed
// it). This ONE shared spawn helper (`spawnGitLong`) carries the long
// timeout + streamed progress for every network-git operation — push (ship)
// and clone (fresh-box) share it. Do NOT raise the shared helper's timeout —
// that would silently change every local git call in the server.
//
// `onProgress(chunk)` receives incremental stdout/stderr lines as they arrive
// (best-effort; a throwing callback is swallowed). Arguments are an argv array
// under a fixed `cwd` — never an interpolated shell string. `signal` aborts
// the child (used by clone cancel).
const GIT_NET_TIMEOUT_MS = 120_000;

export function spawnGitLong(
  { cwd, args, timeoutMs = GIT_NET_TIMEOUT_MS, spawn = nodeSpawn, onProgress, signal },
  { errorPrefix = "git" } = {},
) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let p;
    try {
      p = spawn("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch { /* already gone */ }
      settled = true;
      reject(new Error(`${errorPrefix} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    timer.unref();
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { p.kill("SIGKILL"); } catch { /* already gone */ }
      const e = new Error("cancelled");
      e.cancelled = true;
      reject(e);
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const finish = () => { if (!settled) { settled = true; clearTimeout(timer); } };
    const emit = (chunk) => {
      if (typeof onProgress !== "function") return;
      try { onProgress(chunk); } catch { /* progress is best-effort */ }
    };
    p.stdout.on("data", (b) => { const s = b.toString(); stdout += s; emit(s); });
    p.stderr.on("data", (b) => { const s = b.toString(); stderr += s; emit(s); });
    p.on("error", (e) => { finish(); reject(e); });
    p.on("close", (code) => {
      finish();
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const e = new Error(`${errorPrefix} exited ${code}: ${stderr.trim() || stdout.trim()}`);
        e.status = code;
        reject(e);
      }
    });
  });
}

// gitPush — push a branch (BET-794). Reuses spawnGitLong (the one long-timeout
// network-git path). `onProgress(line)` streams raw output; errors reject with
// a message embedding git's stderr (same shape as run()'s rejection).
export function gitPush(
  { cwd, branch, setUpstream = false, onProgress } = {},
  { timeoutMs = GIT_NET_TIMEOUT_MS, spawn = nodeSpawn } = {},
) {
  return spawnGitLong(
    {
      cwd,
      args: ["push", ...(setUpstream ? ["-u"] : []), ...(branch ? [branch] : [])],
      onProgress,
      timeoutMs,
      spawn,
    },
    { errorPrefix: "git push" },
  );
}

// parseCloneProgress(line) → { percent, bytes } | null
// Parse a `git clone --progress` stderr line for the determinate progress bar
// (§4.3: git reports real byte counts against a known total — the ONE place a
// determinate bar is correct). Only "Receiving objects" / "Checking out files"
// lines are parsed; `remote:` lines that also contain `100%` must NOT fire an
// early full bar, and lines with no percentage (e.g. "Cloning into 'x'...")
// fall through to null. `bytes` is a best-effort parse of the transferred size.
export function parseCloneProgress(line) {
  if (typeof line !== "string") return null;
  const m = /^\s*(?:Receiving objects|Checking out files):\s+(\d{1,3})%/.exec(line);
  if (!m) return null;
  const percent = Math.max(0, Math.min(100, parseInt(m[1], 10)));
  const b = /\b([\d.]+)\s*(GiB|MiB|KiB|B)\b/.exec(line);
  let bytes = 0;
  if (b) {
    const v = parseFloat(b[1]);
    const unit = b[2];
    const mult = unit === "GiB" ? 1024 ** 3 : unit === "MiB" ? 1024 ** 2 : unit === "KiB" ? 1024 : 1;
    bytes = Math.round(v * mult);
  }
  return { percent, bytes };
}

// gitClone — clone a remote repo with real progress (BET-796 §3). Uses the
// shared long-timeout spawn: a cold clone of a large repo is not fast, and the
// shared 10s `run()` would kill it. `--progress` is asserted so stderr carries
// the byte-count lines parseCloneProgress reads. `onProgress` receives a
// `{ percent, bytes }` snapshot (the latest parseable state) as chunks arrive.
// An optional `token` is injected as an HTTP extraheader (`git -c
// http.extraheader`) so private-repo clones authenticate without the token
// ever appearing in the displayed URL. Injected `spawn`/`parse` seam for tests.
export async function gitClone(
  { url, dest, onProgress, timeoutMs = GIT_NET_TIMEOUT_MS, signal, token } = {},
  { spawn = nodeSpawn, parse = parseCloneProgress } = {},
) {
  let progress = { percent: 0, bytes: 0 };
  const emit =
    typeof onProgress === "function"
      ? (chunk) => {
          for (const line of String(chunk).split("\n")) {
            const parsed = parse(line);
            if (parsed) progress = parsed;
          }
          try { onProgress(progress); } catch { /* progress is best-effort */ }
        }
      : undefined;
  const authArgs = token
    ? ["-c", `http.extraheader=Authorization: Bearer ${token}`]
    : [];
  return spawnGitLong(
    {
      cwd: "/",
      args: ["clone", "--progress", ...authArgs, url, ...(dest ? [dest] : [])],
      onProgress: emit,
      timeoutMs,
      spawn,
      signal,
    },
    { errorPrefix: "git clone" },
  );
}

// Directories we never descend into during a scan (in addition to anything
// whose name starts with `.`).
const SKIP_DIR = new Set(["node_modules", "vendor", "target", "dist", "build"]);

// shouldSkipDir(name) → boolean — helper for the scanner; pure, and the test
// pins the skip list (dotfiles + the five heavy/build dirs).
export function shouldSkipDir(name) {
  if (typeof name !== "string" || name === "") return true;
  if (name.startsWith(".")) return true;
  return SKIP_DIR.has(name);
}

// dedupeRepoHits(hits) → RepoHit[] — drop hits whose resolved real path we've
// already seen. `_realPath` is stamped by the scanner (node:fs realpath) so a
// symlinked root does not report the same repo twice; falls back to `path`.
export function dedupeRepoHits(hits) {
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const real = h._realPath ?? h.path;
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(h);
  }
  return out;
}

// sortRepoHits(hits) → RepoHit[] — recency order (most recent lastCommitAt
// first), and hits with a repoKey sort above hits without (forge-known repos
// lead the list). Pure copy — does not mutate the input.
export function sortRepoHits(hits) {
  return [...hits].sort((a, b) => {
    const aKey = a.repoKey ? 1 : 0;
    const bKey = b.repoKey ? 1 : 0;
    if (aKey !== bKey) return bKey - aKey;
    return (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0);
  });
}

// parseGhAuthStatus(text) → string | null — best-effort extraction of the
// login name from `gh auth status` output. Returns null for "not logged in"
// output, multi-host text with no logged-in account, garbage, and any value
// that looks like a token (never return a secret). Pure.
export function parseGhAuthStatus(text) {
  if (typeof text !== "string") return null;
  // Legacy gh: "Logged in to github.com as octocat (…)". Modern gh no longer
  // emits the "as …" phrasing — it prints "account octocat (…)" instead
  // ("Logged in to github.com account octocat"). Accept both forms.
  const m = /(?:as |account )([^()\n]+?)\s*\(/.exec(text);
  if (!m) return null;
  const login = m[1].trim();
  if (!login) return null;
  if (isTokenLike(login)) return null;
  return login;
}

function isTokenLike(s) {
  return (
    /^gh[pousr]_/.test(s) ||
    /^github_pat_/.test(s) ||
    /^[0-9a-f]{40}$/.test(s) ||
    /^[0-9a-f]{64}$/.test(s)
  );
}

// detectForgeCli() → { installed, authenticated, login }
// Runs `gh auth status` through a login shell (gh lives in ~/.local/bin or a
// Homebrew prefix that a bare spawn PATH cannot see — same trap launchers.mjs
// already learned). Reports presence and identity only; never reads or returns
// the token itself.
export async function detectForgeCli() {
  let text = "";
  try {
    const { stdout } = await runLoginShell("gh auth status", { timeoutMs: 8000 });
    text = stdout ?? "";
  } catch (err) {
    // `gh auth status` exits non-zero when not logged in but still prints the
    // "not logged in" report; only a missing binary leaves stdout empty.
    const stdout = err?.stdout;
    if (typeof stdout !== "string" || stdout === "") {
      return { installed: false, authenticated: false, login: null };
    }
    text = stdout;
  }
  const login = parseGhAuthStatus(text);
  if (login !== null) return { installed: true, authenticated: true, login };
  return { installed: true, authenticated: false, login: null };
}

// Default roots for a scan: $HOME plus its common code dirs. Project defaultCwds
// (from configGet().projects) are added on top by forgeProbe — an existing
// user's known paths are free and authoritative.
const DEFAULT_SUBDIRS = ["projects", "code", "src", "dev", "work", "repos", "git"];

export function buildRoots(projectCwds = [], home = homedir()) {
  const roots = new Set([home]);
  for (const sub of DEFAULT_SUBDIRS) roots.add(join(home, sub));
  for (const cwd of projectCwds) {
    if (!cwd || typeof cwd !== "string") continue;
    roots.add(cwd === "~" ? home : expandTilde(cwd));
  }
  return [...roots];
}

// scanRepos({ roots, maxDepth, maxResults, timeoutMs }) → { repos, partial }
// A bounded walk. maxDepth (2), maxResults (50), timeoutMs (4000) are fixed
// server-side and NOT exposable from the renderer (spec: a renderer-supplied
// depth is a DoS on the user's own box). On timeout / cap, returns what it has
// so far — a partial result is correct and expected, never an error.
export async function scanRepos({
  roots,
  maxDepth = 2,
  maxResults = 50,
  timeoutMs = 4000,
  readdir: readdirImpl = readdir,
  realpath: realpathImpl = realpath,
  stat: statImpl = stat,
  gitRun = run,
  home = homedir(),
} = {}) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  const hits = [];
  const seenReal = new Set();

  const rootList = await dedupeHitsByReal(roots ?? buildRoots([], home));
  for (const root of rootList) {
    if (hits.length >= maxResults) break;
    await walkRoot(root, 0, {
      maxDepth,
      maxResults,
      deadline,
      hits,
      seenReal,
      readdir: readdirImpl,
      realpath: realpathImpl,
      stat: statImpl,
      gitRun,
      home,
    });
  }

  const partial = hits.length >= maxResults || Date.now() >= deadline;
  const repoHits = dedupeRepoHits(hits).map(({ _realPath, ...rest }) => rest);
  return { repos: sortRepoHits(repoHits), partial };

  async function dedupeHitsByReal(paths) {
    const seen = new Set();
    const out = [];
    for (const p of paths) {
      if (!p || typeof p !== "string") continue;
      const expanded = p === "~" ? home : expandTilde(p);
      let real;
      try {
        real = await realpathImpl(expanded);
      } catch {
        real = expanded;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      out.push(expanded);
    }
    return out;
  }
}

async function walkRoot(dir, depth, ctx) {
  if (ctx.hits.length >= ctx.maxResults || Date.now() >= ctx.deadline) return;
  let entries;
  try {
    entries = await ctx.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable / missing — skip quietly
  }
  // A directory containing a .git entry is a repo. Detect by readdir, NOT by
  // spawning git, and do not descend into it — the outermost repo wins.
  if (entries.some((e) => e.name === ".git")) {
    await recordRepo(dir, ctx);
    return;
  }
  if (depth >= ctx.maxDepth) return;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (shouldSkipDir(e.name)) continue;
    await walkRoot(join(dir, e.name), depth + 1, ctx);
    if (ctx.hits.length >= ctx.maxResults || Date.now() >= ctx.deadline) return;
  }
}

async function recordRepo(dir, ctx) {
  // Dedupe by resolved real path first (a symlinked root must not double-report).
  let real;
  try {
    real = await ctx.realpath(dir);
  } catch {
    real = dir;
  }
  if (ctx.seenReal.has(real)) return;
  ctx.seenReal.add(real);

  // Spawn git only for confirmed repos — two calls each.
  let branch = null;
  try {
    const { stdout } = await ctx.gitRun("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
    const b = (stdout ?? "").trim();
    if (b && b !== "HEAD") branch = b;
  } catch { /* detached or not a branch */ }

  let originUrl = null;
  try {
    const { stdout } = await ctx.gitRun("git", ["-C", dir, "remote", "get-url", "origin"]);
    originUrl = (stdout ?? "").trim() || null;
  } catch { /* no origin */ }

  const forge = originUrl ? detectForge(originUrl) : null;
  const key = forge ? repoKey(forge) : null;

  // lastCommitAt: prefer the mtime of .git/HEAD (cheap, no spawn) — used only
  // for sort order, so approximate is fine.
  let lastCommitAt = null;
  try {
    const st = await ctx.stat(join(dir, ".git", "HEAD"));
    lastCommitAt = typeof st.mtimeMs === "number" ? st.mtimeMs : null;
  } catch { /* ignore */ }

  ctx.hits.push({
    path: dir,
    name: basename(dir),
    branch,
    originUrl,
    forge: forge ? forge.kind : null,
    repoKey: key,
    lastCommitAt,
    _realPath: real,
  });
}

// forgeProbe() → { repos: RepoHit[], cli, partial }
// The single RPC channel behind the probe. Cached in server memory for 60s
// (one box, keyed by nothing) — the renderer calls this on every zero-state
// mount and a repeat filesystem walk per mount is waste.
const FORGE_PROBE_TTL_MS = 60_000;
let _forgeCache = null;

export async function forgeProbe() {
  const now = Date.now();
  if (_forgeCache && now - _forgeCache.at < FORGE_PROBE_TTL_MS) {
    return _forgeCache.result;
  }
  const cfg = await getConfig();
  const projectCwds = (cfg.projects ?? []).map((p) => p.defaultCwd).filter(Boolean);
  const { repos, partial } = await scanRepos({ roots: buildRoots(projectCwds) });
  const cli = await detectForgeCli();
  const result = { repos, cli, partial, homeDir: homedir() };
  _forgeCache = { at: now, result };
  return result;
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
// STUB: no server-side URL opener. KNOWN LIMITATION: because the shim still
// defines openExternal, ChatPanel's link handler calls e.preventDefault() then
// this no-op, so chat markdown links don't open on mobile. Proper fix is
// shim-layer (httpApi omit openExternal so native <a target=_blank> works, or
// Capacitor Browser.open). Tracked as a follow-up.
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
