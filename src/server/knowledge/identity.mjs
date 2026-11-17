// identity.mjs — project identity (spec §3.1): canonical id, slug, and the
// committed project registry (`projects.json`) with aliases.
//
//   canonical id   origin remote, else the alphabetically first remote, parsed
//                  with detectForge + repoKey into `host/owner/repo`; another
//                  host is normalised the same way (scheme, credentials and
//                  `.git` stripped, host lowercased) into `host/path`; no
//                  remote → `path:<realpath of the main worktree>`; a directory
//                  outside any repo → the pseudo-project `box`.
//   slug           `<name>-<h>` — pinned in `slugFor`.
//
// Pure functions + a resolver/registry over an injected git runner and fs.

import { createHash } from "node:crypto";
import { realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
import { basename } from "node:path";
import { detectForge, repoKey } from "../../shared/forge.mjs";

export const BOX_ID = "box";
export const SLUG_RE = /^[a-z0-9-]{1,40}-[0-9a-f]{10}$/;

const sha256hex = (s) => createHash("sha256").update(String(s)).digest("hex");

/** Lowercase, non-[a-z0-9] runs → `-`, trimmed of `-`, cut to 40; empty → "project". */
export function slugName(name) {
  const base = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base === "" ? "project" : base;
}

/** `<name>-<first 10 hex of sha256(canonicalId)>`; matches SLUG_RE, no dots. */
export function slugFor(canonicalId, name) {
  return `${slugName(name)}-${sha256hex(canonicalId).slice(0, 10)}`;
}

/**
 * A git remote URL → `{ id, name }` or null (a local-path remote, a non-URL, an
 * empty string). GitHub/GitLab go through detectForge + repoKey so ssh and https
 * forms of one repository agree; any other host is `host/path` lowercased host,
 * credentials, scheme, `.git` and slashes stripped, path case kept.
 */
export function normalizeRemote(remoteUrl) {
  if (typeof remoteUrl !== "string") return null;
  const input = remoteUrl.trim();
  if (input === "") return null;
  const forge = detectForge(input);
  if (forge) return { id: repoKey(forge), name: forge.repo };

  let host;
  let path;
  const scp = input.match(/^[^@\s/]+@([^:\s/]+):(?!\/\/)(.+)$/);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    let url;
    try {
      url = new URL(input);
    } catch {
      return null;
    }
    if (url.protocol === "file:") return null;
    host = url.hostname;
    path = url.pathname;
  } else {
    return null; // an absolute/relative path or a bare word
  }
  host = String(host).toLowerCase();
  path = String(path).replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").replace(/\/+$/g, "");
  if (host === "" || path === "") return null;
  const name = path.split("/").pop();
  return { id: `${host}/${path}`, name };
}

/** origin, else the alphabetically first remote name; null when there is none. */
export function pickRemoteName(names) {
  const list = [...new Set((names ?? []).map((n) => String(n).trim()).filter(Boolean))].sort();
  if (list.length === 0) return null;
  return list.includes("origin") ? "origin" : list[0];
}

/** First `worktree <path>` of `git worktree list --porcelain` = the main worktree. */
export function parseMainWorktree(porcelain) {
  for (const line of String(porcelain ?? "").split("\n")) {
    if (line.startsWith("worktree ")) return line.slice("worktree ".length).trim();
  }
  return null;
}

const BOX_PROJECT = Object.freeze({ canonicalId: BOX_ID, name: "Box", repoRoot: null, kind: "box" });

/**
 * Resolve a directory to its project identity.
 * deps: git (a gitRunner), realpath, isDirectory, now, cacheMs.
 * `resolve(dir)` → `{ canonicalId, name, repoRoot, kind: "remote"|"path"|"box" }`
 * or null when the directory no longer exists / cannot be read.
 */
export function createIdentityResolver({ git, realpath = fsRealpath, isDirectory, now = Date.now, cacheMs = 5 * 60_000 } = {}) {
  const isDir =
    isDirectory ??
    (async (p) => {
      try {
        return (await fsStat(p)).isDirectory();
      } catch {
        return false;
      }
    });
  const cache = new Map(); // dir → { at, value }

  async function gitOut(cwd, args) {
    try {
      return await git.run(args, { cwd });
    } catch {
      return null;
    }
  }

  async function resolveUncached(directory) {
    if (!(await isDir(directory))) return null;
    let dir;
    try {
      dir = await realpath(directory);
    } catch {
      return null;
    }
    const top = await gitOut(dir, ["rev-parse", "--show-toplevel"]);
    if (top === null || top.trim() === "") return { ...BOX_PROJECT };
    const wt = parseMainWorktree(await gitOut(dir, ["worktree", "list", "--porcelain"]));
    let root = wt ?? top.trim();
    try {
      root = await realpath(root);
    } catch {
      /* keep as reported */
    }
    const names = (await gitOut(dir, ["remote"])) ?? "";
    const remoteName = pickRemoteName(names.split("\n"));
    if (remoteName) {
      const url = await gitOut(dir, ["remote", "get-url", remoteName]);
      const parsed = normalizeRemote(url ?? "");
      if (parsed) return { canonicalId: parsed.id, name: parsed.name, repoRoot: root, kind: "remote", pathId: `path:${root}` };
    }
    return { canonicalId: `path:${root}`, name: basename(root), repoRoot: root, kind: "path", pathId: `path:${root}` };
  }

  return {
    async resolve(directory) {
      if (typeof directory !== "string" || directory === "") return null;
      const t = now();
      const hit = cache.get(directory);
      if (hit && t - hit.at < cacheMs) return hit.value;
      const value = await resolveUncached(directory);
      cache.set(directory, { at: t, value });
      if (cache.size > 2000) cache.delete(cache.keys().next().value);
      return value;
    },
    invalidate(directory) {
      if (directory === undefined) cache.clear();
      else cache.delete(directory);
    },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const emptyRegistry = () => ({ version: 1, projects: {} });

/**
 * The committed project registry (`projects.json`):
 * `{ version: 1, projects: { <slug>: { canonicalId, slug, displayName, aliases[], paths[] } } }`.
 * `paths` are the main-worktree real paths seen for the project; they are how a
 * changed id (a remote added later, a remote renamed) finds its project again.
 * deps: resolver, load() → doc, save(doc, message) (persists + commits).
 */
export function createProjectRegistry({ resolver, load, save, now = Date.now } = {}) {
  let doc = null;
  const ensure = async () => {
    if (doc) return doc;
    const loaded = await load();
    doc = loaded && typeof loaded === "object" && loaded.projects && typeof loaded.projects === "object" ? loaded : emptyRegistry();
    return doc;
  };
  const byId = (d, id) => Object.values(d.projects).find((p) => p.canonicalId === id || p.aliases.includes(id));
  const addUnique = (arr, v) => {
    if (v && !arr.includes(v)) arr.push(v);
  };

  async function persist(message) {
    await save(doc, message);
  }

  return {
    async list() {
      return Object.values((await ensure()).projects).map((p) => ({ ...p, aliases: [...p.aliases], paths: [...p.paths] }));
    },
    async get(slug) {
      const p = (await ensure()).projects[slug];
      return p ? { ...p, aliases: [...p.aliases], paths: [...p.paths] } : null;
    },
    async findById(id) {
      const p = byId(await ensure(), id);
      return p ? { ...p } : null;
    },
    /**
     * Resolve `directory` to its registered project, registering it on first
     * sight. `movedFrom` (an old directory) lets a caller that knows a
     * directory moved carry the project across the move. Returns
     * `{ slug, canonicalId, displayName, created, changed }` or null when the
     * directory cannot be resolved.
     */
    async identify(directory, { movedFrom } = {}) {
      const r = await resolver.resolve(directory);
      if (!r) return null;
      const d = await ensure();
      let project = byId(d, r.canonicalId);
      let changed = false;
      let created = false;
      let message = "";

      if (!project) {
        // The id changed (remote added/renamed, directory moved): find the project by the
        // path it lived at, or by the old directory the caller names.
        let oldRoot = r.repoRoot;
        if (movedFrom) {
          const prev = await resolver.resolve(movedFrom);
          oldRoot = prev?.repoRoot ?? movedFrom;
        }
        const candidates = [r.pathId, oldRoot ? `path:${oldRoot}` : null].filter(Boolean);
        project =
          Object.values(d.projects).find((p) => oldRoot && p.paths.includes(oldRoot)) ??
          candidates.map((id) => byId(d, id)).find(Boolean);
        if (project && project.canonicalId !== r.canonicalId) {
          addUnique(project.aliases, project.canonicalId);
          project.canonicalId = r.canonicalId;
          changed = true;
          message = `Re-identify ${project.slug}`;
        }
      }
      if (!project) {
        const slug = slugFor(r.canonicalId, r.name);
        project = { canonicalId: r.canonicalId, slug, displayName: r.name, aliases: [], paths: [] };
        d.projects[slug] = project;
        created = true;
        changed = true;
        message = `Register project ${slug}`;
      }
      if (r.repoRoot && !project.paths.includes(r.repoRoot)) {
        project.paths.push(r.repoRoot);
        if (project.paths.length > 8) project.paths.shift();
        changed = true;
        message ||= `Record path for ${project.slug}`;
      }
      if (r.kind !== "box" && project.displayName !== r.name && created === false && r.kind === "remote") {
        project.displayName = r.name;
        changed = true;
        message ||= `Rename ${project.slug}`;
      }
      if (changed) await persist(message);
      return { slug: project.slug, canonicalId: project.canonicalId, displayName: project.displayName, created, changed, at: now() };
    },
  };
}
