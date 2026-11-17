// store.mjs — the git-backed knowledge store at `~/.manta/knowledge/` (spec §3.2, §6.3).
//
// A plain git repository, box-local, never inside a product repo. Pages are
// Markdown; this module owns:
//   • init: repo, `.gitignore` (state.sqlite, .queue/, .repos/, .briefings/),
//     `tombstones.json`, an initial commit.
//   • ONE store-wide apply lock: model calls run outside it, applying decisions
//     takes it (`withLock`). Everything that writes goes through a tx handed out
//     by the lock; the top-level helpers are `withLock(tx => tx.<same>)`.
//   • Dirty tree → user commit: uncommitted changes (hand edits, which win) are
//     first committed as a user commit before any curator commit.
//   • `commit({files|path+content, message, body, trailers})` — one commit per
//     decision, secret-scanned (a hit throws `secret-detected`, nothing written),
//     `Manta-Decision:` / `Manta-Batch:` trailers.
//   • `revert(sha)` — `git revert`, returning a conflict error that names the
//     later commit that conflicts (nothing half-applied).
//
// All git goes through an injected runner (`run(args, {cwd, env})`, see
// gitRunner.mjs; simple-git in production).

import { mkdir, readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createMutex } from "../jsonStore.mjs";
import { KnowledgeError } from "./errors.mjs";

export const CURATOR = Object.freeze({ name: "Manta curator", email: "curator@manta.invalid" });
export const USER_FALLBACK = Object.freeze({ name: "User", email: "user@manta.invalid" });
export const GITIGNORE = ".queue/\n.repos/\n.briefings/\nstate.sqlite\nstate.sqlite-wal\nstate.sqlite-shm\nstate.sqlite-journal\n";
const EMPTY_TOMBSTONES = `${JSON.stringify({ version: 1, tombstones: [] }, null, 2)}\n`;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const SEP = "\x1f";
const REC = "\x1e";

const envFor = ({ name, email }) => ({
  GIT_AUTHOR_NAME: name,
  GIT_AUTHOR_EMAIL: email,
  GIT_COMMITTER_NAME: name,
  GIT_COMMITTER_EMAIL: email,
});

/** `Key: value` trailers appended after a blank line. */
export function formatMessage({ message, body, trailers }) {
  const subject = String(message ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "Update knowledge";
  const parts = [subject];
  if (body && String(body).trim()) parts.push(String(body).trim());
  const t = Object.entries(trailers ?? {}).filter(([, v]) => v !== undefined && v !== null && String(v) !== "");
  if (t.length) parts.push(t.map(([k, v]) => `${k}: ${String(v).replace(/\s+/g, " ")}`).join("\n"));
  return parts.join("\n\n");
}

/** Parse the trailing `Key: value` block of a commit body. */
export function parseTrailers(body) {
  const lines = String(body ?? "").trimEnd().split("\n");
  const out = {};
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^([A-Za-z][A-Za-z0-9-]*): (.*)$/.exec(lines[i]);
    if (!m) break;
    out[m[1]] = m[2];
  }
  return out;
}

function parseLog(out) {
  return String(out ?? "")
    .split(REC)
    .map((r) => r.replace(/^\n+/, ""))
    .filter((r) => r.trim() !== "")
    .map((r) => {
      const [sha, author, at, subject, body = ""] = r.split(SEP);
      return { sha, author, at: Number(at) * 1000, subject, body: body.trim(), trailers: parseTrailers(body) };
    });
}
const LOG_FORMAT = `--format=%H${SEP}%an${SEP}%at${SEP}%s${SEP}%b${REC}`;

/**
 * deps: dir, git (runner), scan (secret scanner, optional), now.
 */
export function createKnowledgeStore({ dir, git, scan, now = Date.now, log = console.warn } = {}) {
  const mutex = createMutex();
  const commitHooks = [];

  const inside = (rel) => {
    if (typeof rel !== "string" || rel === "" || rel.includes("\0")) throw new KnowledgeError("invalid-path", "Invalid store path.");
    const abs = resolve(dir, rel);
    if (abs !== resolve(dir) && !abs.startsWith(resolve(dir) + sep)) throw new KnowledgeError("invalid-path", "Path escapes the knowledge store.");
    if (rel.split("/").some((p) => p === ".git")) throw new KnowledgeError("invalid-path", "Path inside .git.");
    return abs;
  };
  const run = (args, env) => git.run(args, { cwd: dir, env });
  const tryRun = async (args, env) => {
    try {
      return await run(args, env);
    } catch {
      return null;
    }
  };

  async function userIdentity() {
    const name = ((await tryRun(["config", "--get", "user.name"])) ?? "").trim();
    const email = ((await tryRun(["config", "--get", "user.email"])) ?? "").trim();
    return name && email ? { name, email } : { ...USER_FALLBACK };
  }

  async function head() {
    const out = await tryRun(["rev-parse", "--verify", "-q", "HEAD"]);
    return out && out.trim() ? out.trim() : null;
  }

  // Exit codes are not reliable through every runner (simple-git does not throw on a bare
  // exit 1), so "anything staged?" is answered from the output, never from the status.
  async function hasStaged() {
    return ((await tryRun(["diff", "--cached", "--name-only"])) ?? "").trim() !== "";
  }

  async function dirtyPaths() {
    const out = (await tryRun(["status", "--porcelain", "-z", "--untracked-files=all"])) ?? "";
    return out
      .split("\0")
      .filter(Boolean)
      .map((l) => l.slice(3));
  }

  async function writeBaseline() {
    await mkdir(dir, { recursive: true });
    let changed = false;
    const ig = join(dir, ".gitignore");
    const cur = existsSync(ig) ? await readFile(ig, "utf8") : "";
    const missing = GITIGNORE.split("\n").filter((l) => l && !cur.split("\n").includes(l));
    if (missing.length) {
      await writeFile(ig, `${cur}${cur === "" || cur.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`);
      changed = true;
    }
    if (!existsSync(join(dir, "tombstones.json"))) {
      await writeFile(join(dir, "tombstones.json"), EMPTY_TOMBSTONES);
      changed = true;
    }
    return changed;
  }

  const tx = {
    dir,
    head,
    userIdentity,
    async init() {
      await mkdir(dir, { recursive: true });
      if (!existsSync(join(dir, ".git"))) {
        await run(["init"]);
        await tryRun(["symbolic-ref", "HEAD", "refs/heads/main"]);
      }
      const changed = await writeBaseline();
      if (changed || (await head()) === null) {
        await run(["add", "-A"]);
        if ((await hasStaged()) || (await head()) === null) {
          await run(["commit", "--allow-empty", "-m", formatMessage({ message: "Initialise knowledge store" })], envFor(CURATOR));
        }
      }
      return { head: await head() };
    },
    async read(rel) {
      try {
        return await readFile(inside(rel), "utf8");
      } catch (e) {
        if (e?.code === "ENOENT" || e?.code === "EISDIR") return null;
        throw e;
      }
    },
    async exists(rel) {
      try {
        await stat(inside(rel));
        return true;
      } catch {
        return false;
      }
    },
    /** The last commit that touched `rel` (a decision's base commit), or null. */
    async lastCommitFor(rel) {
      inside(rel);
      const out = await tryRun(["log", "-1", "--format=%H", "--", rel]);
      return out && out.trim() ? out.trim() : null;
    },
    async dirty() {
      return dirtyPaths();
    },
    /** Commit uncommitted changes as the box user's own commit. Returns the sha or null. */
    async commitDirtyAsUser() {
      const paths = await dirtyPaths();
      if (paths.length === 0) return null;
      await run(["add", "-A"]);
      const who = await userIdentity();
      const list = paths.slice(0, 5).join(", ") + (paths.length > 5 ? ` and ${paths.length - 5} more` : "");
      await run(["commit", "-m", formatMessage({ message: `User edits: ${list}`.slice(0, 118) })], envFor(who));
      const sha = await head();
      notify({ sha, paths, by: "user" });
      return sha;
    },
    /**
     * One commit. `files`: `[{path, content}|{path, delete: true}]` (or the
     * `path`+`content` shorthand). Throws `secret-detected` before writing when
     * the content, message or body contain a secret. Returns `{sha, changed}`.
     */
    async commit({ files, path, content, message, body, trailers, author = CURATOR } = {}) {
      const list = files ?? (path ? [{ path, content }] : []);
      if (list.length === 0) throw new KnowledgeError("invalid-commit", "A commit needs at least one file.");
      for (const f of list) inside(f.path);
      if (scan) {
        const texts = [message ?? "", body ?? "", ...list.filter((f) => !f.delete).map((f) => f.content ?? "")];
        for (const t of texts) {
          const r = await scan(t);
          if (!r.clean) throw new KnowledgeError("secret-detected", r.unavailable ? "The secret scanner is unavailable; nothing was written." : "A secret was found in the change; it was not written.", { status: 422 });
        }
      }
      await tx.commitDirtyAsUser();
      for (const f of list) {
        const abs = inside(f.path);
        if (f.delete) await rm(abs, { force: true });
        else {
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, f.content ?? "");
        }
      }
      await run(["add", "-A", "--", ...list.map((f) => f.path)]);
      if (!(await hasStaged())) return { sha: await head(), changed: false };
      await run(["commit", "-m", formatMessage({ message, body, trailers })], envFor(author));
      const sha = await head();
      notify({ sha, paths: list.map((f) => f.path), by: "curator" });
      return { sha, changed: true };
    },
    /**
     * `git revert` of `sha`. `{ok:true, sha}` | `{ok:false, reason:"conflict",
     * conflictWith:{sha, subject}}` | `{ok:false, reason:"nothing-to-revert"|"unknown-commit"}`.
     * A conflict leaves the tree exactly as it was.
     */
    async revert(sha, { trailers, author = CURATOR } = {}) {
      if (!SHA_RE.test(String(sha ?? ""))) return { ok: false, reason: "unknown-commit" };
      const info = await tryRun(["log", "-1", LOG_FORMAT, sha]);
      if (!info) return { ok: false, reason: "unknown-commit" };
      const original = parseLog(info)[0];
      await tx.commitDirtyAsUser();
      const files = ((await tryRun(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha])) ?? "").split("\n").filter(Boolean);
      let failure = null;
      try {
        await run(["revert", "--no-commit", sha], envFor(author));
      } catch (e) {
        failure = e;
      }
      const conflicted = ((await tryRun(["diff", "--name-only", "--diff-filter=U"])) ?? "").trim();
      if (failure || conflicted) {
        await tryRun(["reset", "--hard", "HEAD"]);
        if (!conflicted) return { ok: false, reason: "revert-failed", message: String(failure?.stderr ?? failure?.message ?? failure).slice(0, 300) };
        const later = parseLog((await tryRun(["log", LOG_FORMAT, `${sha}..HEAD`, "--", ...files])) ?? "")[0];
        return { ok: false, reason: "conflict", conflictWith: later ? { sha: later.sha, subject: later.subject } : null };
      }
      if (!(await hasStaged())) {
        await tryRun(["reset", "--hard", "HEAD"]);
        return { ok: false, reason: "nothing-to-revert" };
      }
      await run(["commit", "-m", formatMessage({ message: `Revert: ${original.subject}`, body: `Reverts ${original.sha.slice(0, 10)}.`, trailers: { ...(trailers ?? {}), "Manta-Revert": original.sha } })], envFor(author));
      const out = await head();
      notify({ sha: out, paths: files, by: "curator" });
      return { ok: true, sha: out };
    },
    /** Commits newest-first: `[{sha, author, at, subject, body, trailers}]`. */
    async log({ path, limit = 50 } = {}) {
      const args = ["log", LOG_FORMAT, "-n", String(Math.max(1, Math.min(500, limit)))];
      if (path) args.push("--", path);
      return parseLog((await tryRun(args)) ?? "");
    },
    async showCommit(sha) {
      if (!SHA_RE.test(String(sha ?? ""))) return null;
      const out = await tryRun(["log", "-1", LOG_FORMAT, sha]);
      if (!out) return null;
      const c = parseLog(out)[0];
      const files = ((await tryRun(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha])) ?? "").split("\n").filter(Boolean);
      return { ...c, files };
    },
    /** Every Markdown page on disk (committed or not): store-relative paths, sorted. */
    async listPages() {
      const out = [];
      async function walk(rel) {
        let entries;
        try {
          entries = await readdir(join(dir, rel), { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.name.startsWith(".")) continue;
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(r);
          else if (e.isFile() && e.name.endsWith(".md")) out.push(r);
        }
      }
      for (const top of ["user", "commons", "projects"]) await walk(top);
      return out.sort();
    },
  };

  function notify(evt) {
    for (const cb of commitHooks) {
      try {
        void Promise.resolve(cb(evt)).catch((e) => log("[knowledge] commit hook failed:", e?.message ?? e));
      } catch (e) {
        log("[knowledge] commit hook failed:", e?.message ?? e);
      }
    }
  }

  const withLock = (fn) => mutex.runExclusive(() => fn(tx));

  return {
    dir,
    withLock,
    /** Register a callback run after every commit (user or curator): `({sha, paths, by})`. */
    onCommit(cb) {
      commitHooks.push(cb);
      return () => {
        const i = commitHooks.indexOf(cb);
        if (i >= 0) commitHooks.splice(i, 1);
      };
    },
    init: () => withLock((t) => t.init()),
    head: () => head(),
    read: (rel) => tx.read(rel),
    exists: (rel) => tx.exists(rel),
    lastCommitFor: (rel) => tx.lastCommitFor(rel),
    commit: (spec) => withLock((t) => t.commit(spec)),
    commitDirtyAsUser: () => withLock((t) => t.commitDirtyAsUser()),
    revert: (sha, opts) => withLock((t) => t.revert(sha, opts)),
    log: (opts) => tx.log(opts),
    showCommit: (sha) => tx.showCommit(sha),
    listPages: () => tx.listPages(),
    dirty: () => tx.dirty(),
  };
}
