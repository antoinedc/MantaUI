// filePath.mjs — the ONE file-access policy for everything that reads a file on
// the box on a client's behalf: /api/peek, /api/download and the fs:* channels
// (docs/superpowers/specs/2026-11-02-file-explorer.md §Shared file-access policy,
// widened by 2026-11-03-explorer-followup.md §7a).
//
// Threat model: the client is authenticated as the box user, so any absolute
// path that user can read is allowed; the OS file permissions are the real
// limit. What stays: input checks, `~` expansion, realpath (`..` and symlinks
// resolve to their real target), regular-file / directory kind checks, and the
// open-time identity check (same dev/ino as the path we vetted, O_NOFOLLOW,
// regular files only), which closes the resolve→open race.
//
// All fs is injected so a test can drive this with real tmp directories and a
// fake home.

import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

function reasonFromErrno(e) {
  switch (e?.code) {
    case "ENOENT":
    case "ENOTDIR":
    case "ELOOP":
    case "ENAMETOOLONG":
      return "missing";
    case "EACCES":
    case "EPERM":
      return "permission";
    default:
      console.warn("[filePath] unexpected fs error:", e?.message ?? e);
      return "unavailable";
  }
}

export function createFilePath({
  homedir = osHomedir,
  realpath = fsp.realpath,
  stat = fsp.stat,
  open = fsp.open,
} = {}) {
  async function resolvePath(raw, { base } = {}) {
    if (typeof raw !== "string" || raw === "" || raw.includes("\0")) {
      return { ok: false, reason: "invalid_input" };
    }

    let abs;
    if (raw === "~") abs = resolve(homedir());
    else if (raw.startsWith("~/")) abs = resolve(join(homedir(), raw.slice(2)));
    else if (isAbsolute(raw)) abs = resolve(raw);
    else {
      if (typeof base !== "string") return { ok: false, reason: "invalid_input" };
      const b = await resolvePath(base);
      if (!b.ok) return b;
      if (!b.stat.isDirectory()) return { ok: false, reason: "not-file" };
      abs = resolve(b.abs, raw);
    }

    let canonical;
    try {
      canonical = await realpath(abs);
    } catch (e) {
      return { ok: false, reason: reasonFromErrno(e) };
    }
    let st;
    try {
      st = await stat(canonical);
    } catch (e) {
      return { ok: false, reason: reasonFromErrno(e) };
    }
    return { ok: true, abs, canonical, stat: st };
  }

  // Byte access. The caller owns the returned FileHandle and must close it
  // (a stream made with handle.createReadStream() closes it on end/destroy).
  async function openPath(raw, opts) {
    let lastReason = "changed";
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await resolvePath(raw, opts);
      if (!r.ok) return r;

      let handle;
      try {
        handle = await open(r.canonical, OPEN_FLAGS);
      } catch (e) {
        // ELOOP = the vetted path became a symlink between resolve and open.
        if (e?.code === "ELOOP") {
          lastReason = "changed";
          continue;
        }
        return { ok: false, reason: reasonFromErrno(e) };
      }

      let fst;
      try {
        fst = await handle.stat();
      } catch (e) {
        await handle.close().catch(() => {});
        return { ok: false, reason: reasonFromErrno(e) };
      }
      if (!fst.isFile()) {
        await handle.close().catch(() => {});
        return { ok: false, reason: "not-file" };
      }
      if (fst.dev !== r.stat.dev || fst.ino !== r.stat.ino) {
        await handle.close().catch(() => {});
        lastReason = "changed";
        continue;
      }
      return { ok: true, abs: r.abs, canonical: r.canonical, stat: fst, handle };
    }
    return { ok: false, reason: lastReason };
  }

  return { resolvePath, openPath };
}
