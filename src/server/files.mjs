// files.mjs — the fs:resolve-paths / fs:list / fs:git-status channels behind the
// file explorer (docs/superpowers/specs/2026-11-02-file-explorer.md §Server
// channels). Wire types: src/shared/fsTypes.ts.
//
// Expected outcomes (missing, unreadable, not a git repo, timeout) are
// RETURNED as `{ ok:false, reason }`; an unexpected error is logged and thrown
// as a fixed safe message (class 1, BET-1460). Every path goes through the
// shared file-access policy (filePath.mjs). I/O is injected for tests:
//   runGit(args, { input?, timeout, maxBuffer }) → { code, stdout }
//     — resolves for any exit code; rejects with `.timedOut` on timeout.

import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createFilePath } from "./filePath.mjs";

export const FS_RESOLVE_MAX = 200;
export const FS_LIST_MAX = 2000;
export const GIT_TIMEOUT_MS = 3000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const STAT_CONCURRENCY = 64;

const SAFE_ERROR = "file system error";

function safeThrow(where, e) {
  console.warn(`[files] ${where} failed:`, e?.message ?? e);
  throw new Error(SAFE_ERROR);
}

export function defaultRunGit(args, { input, timeout, maxBuffer }) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        timeout,
        maxBuffer,
        encoding: "utf8",
        // Don't contend with the user's own git for the index lock; never prompt.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout) => {
        if (!err) return resolve({ code: 0, stdout });
        if (err.killed && err.signal) {
          const e = new Error("git timed out");
          e.timedOut = true;
          return reject(e);
        }
        if (typeof err.code === "number") return resolve({ code: err.code, stdout: stdout ?? "" });
        reject(err);
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}

function kindOfStat(st) {
  if (st.isFile()) return "file";
  if (st.isDirectory()) return "dir";
  return null;
}

export function createFiles({
  filePath = createFilePath(),
  runGit = defaultRunGit,
  readdir = fsp.readdir,
  lstat = fsp.lstat,
  realpath = fsp.realpath,
} = {}) {
  const { resolvePath } = filePath;

  async function resolvePaths({ base, paths } = {}) {
    if (typeof base !== "string" || !Array.isArray(paths)) throw new Error("invalid input");
    if (paths.length > FS_RESOLVE_MAX) throw new Error("too many paths");
    const results = await Promise.all(
      paths.map(async (input) => {
        if (typeof input !== "string") return { input, ok: false, reason: "invalid_input" };
        const r = await resolvePath(input, { base });
        if (!r.ok) return { input, ok: false, reason: r.reason };
        const kind = kindOfStat(r.stat);
        if (!kind) return { input, ok: false, reason: "not-file" };
        return { input, ok: true, abs: r.abs, kind, size: r.stat.size, mtimeMs: r.stat.mtimeMs };
      }),
    );
    return { results };
  }

  // One `git check-ignore` per listing; the git state of `canonical` decides.
  // Anything but a clean answer (non-git, timeout, git missing) = nothing ignored.
  async function ignoredNames(canonical, entries) {
    if (entries.length === 0) return new Set();
    const input = entries.map((e) => (e.kind === "dir" ? `${e.name}/` : e.name) + "\0").join("");
    let out;
    try {
      out = await runGit(["-C", canonical, "check-ignore", "--stdin", "-z"], {
        input,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      });
    } catch {
      return new Set();
    }
    if (out.code !== 0) return new Set();
    return new Set(out.stdout.split("\0").filter(Boolean).map((p) => p.replace(/\/$/, "")));
  }

  async function listDir({ dir, limit } = {}) {
    let cap = FS_LIST_MAX;
    if (limit !== undefined && limit !== null) {
      if (!Number.isFinite(limit) || limit < 1) return { ok: false, reason: "invalid_input" };
      cap = Math.min(Math.floor(limit), FS_LIST_MAX);
    }
    const r = await resolvePath(dir);
    if (!r.ok) return { ok: false, reason: r.reason };
    if (!r.stat.isDirectory()) return { ok: false, reason: "not-file" };

    let dirents;
    try {
      dirents = await readdir(r.canonical, { withFileTypes: true });
    } catch (e) {
      if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return { ok: false, reason: "missing" };
      if (e?.code === "EACCES" || e?.code === "EPERM") return { ok: false, reason: "permission" };
      return safeThrow("list", e);
    }

    // Classify every entry (needs the link target for symlinks, so sorting by
    // kind is possible before the cap). Broken links, sockets, FIFOs and
    // devices are skipped — nothing in the explorer could act on them.
    const classified = [];
    await Promise.all(
      dirents
        .filter((d) => d.name !== ".git")
        .map(async (d) => {
          const abs = join(r.abs, d.name);
          if (d.isDirectory()) classified.push({ name: d.name, abs, kind: "dir" });
          else if (d.isFile()) classified.push({ name: d.name, abs, kind: "file" });
          else if (d.isSymbolicLink()) {
            const link = await resolvePath(join(r.canonical, d.name));
            if (link.ok) {
              const kind = kindOfStat(link.stat);
              if (kind) classified.push({ name: d.name, abs, kind, stat: link.stat });
            }
          }
        }),
    );

    classified.sort((a, b) => {
      const ad = a.kind === "dir" ? 0 : 1;
      const bd = b.kind === "dir" ? 0 : 1;
      if (ad !== bd) return ad - bd;
      const c = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      if (c !== 0) return c;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    const total = classified.length;
    const shown = classified.slice(0, cap);

    // size/mtime for the shown rows only (symlinks to inside already have it).
    const withStat = [];
    for (let i = 0; i < shown.length; i += STAT_CONCURRENCY) {
      const chunk = await Promise.all(
        shown.slice(i, i + STAT_CONCURRENCY).map(async (e) => {
          let st = e.stat;
          if (!st) {
            try {
              st = await lstat(join(r.canonical, e.name));
            } catch {
              return null; // vanished since readdir
            }
          }
          return { ...e, size: st.size, mtimeMs: st.mtimeMs };
        }),
      );
      withStat.push(...chunk.filter(Boolean));
    }

    const ignored = await ignoredNames(r.canonical, withStat);
    const entries = withStat.map((e) => ({
      name: e.name,
      abs: e.abs,
      kind: e.kind,
      size: e.size,
      mtimeMs: e.mtimeMs,
      hidden: e.name.startsWith("."),
      ignored: ignored.has(e.name),
    }));
    return { ok: true, dir: r.abs, entries, total, truncated: total > shown.length };
  }

  function badgeFor(xy) {
    const x = xy[0];
    const y = xy[1];
    if (xy === "??") return "?";
    if (xy === "!!") return null;
    if (x === "U" || y === "U" || xy === "AA" || xy === "DD") return "!";
    if (x === "D" || y === "D") return null; // not on disk
    if (x === "A" || x === "R" || x === "C" || y === "A") return "A";
    if (x === "M" || y === "M" || x === "T" || y === "T") return "M";
    return null;
  }

  // Parse `status --porcelain=v1 -z`: `XY <path>\0`, and for renames/copies the
  // record is followed by an extra `<source path>\0` field.
  function parseStatus(stdout, prefix) {
    const changes = {};
    const records = stdout.split("\0");
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (rec.length < 4) continue;
      const xy = rec.slice(0, 2);
      let path = rec.slice(3);
      if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") i++;
      const badge = badgeFor(xy);
      if (!badge) continue;
      if (path.endsWith("/")) path = path.slice(0, -1); // untracked directory
      let rel = path;
      if (prefix) {
        if (!path.startsWith(prefix + "/")) continue;
        rel = path.slice(prefix.length + 1);
      }
      if (rel) changes[rel] = badge;
    }
    return changes;
  }

  async function gitStatus({ root } = {}) {
    const r = await resolvePath(root);
    if (!r.ok) return { ok: false, reason: r.reason };
    if (!r.stat.isDirectory()) return { ok: false, reason: "not-file" };
    const opts = { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER };
    try {
      const top = await runGit(["-C", r.canonical, "rev-parse", "--show-toplevel"], opts);
      if (top.code !== 0) return { ok: false, reason: "not-git" };
      let toplevel = top.stdout.replace(/\r?\n$/, "");
      try {
        toplevel = await realpath(toplevel);
      } catch {
        // keep git's own spelling
      }
      const prefix = relative(toplevel, r.canonical).split(sep).join("/");
      if (prefix.startsWith("..")) return { ok: false, reason: "not-git" };

      const st = await runGit(["-C", r.canonical, "status", "--porcelain=v1", "-z"], opts);
      if (st.code !== 0) return safeThrow("git-status", new Error(`git status exited ${st.code}`));
      return { ok: true, changes: parseStatus(st.stdout, prefix) };
    } catch (e) {
      if (e?.timedOut) return { ok: false, reason: "timeout" };
      if (e?.code === "ENOENT") return { ok: false, reason: "unavailable" };
      if (e?.message === SAFE_ERROR) throw e;
      return safeThrow("git-status", e);
    }
  }

  return { resolvePaths, listDir, gitStatus };
}
