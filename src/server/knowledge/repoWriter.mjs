// repoWriter.mjs — the curator's outward repository writes (spec §4.1).
//
// ONLY ever writes the managed block (repoBlock.mjs) into a repository's AGENTS.md, from an
// independent clone at `<store>/.repos/<slug>` — never a worktree of a user clone. Modes:
//   box-only      never touches the repo (the default, and what every unmet condition degrades to)
//   direct        commits on a detached `origin/<default>` and pushes `HEAD:<default>`; a rejected
//                 push falls back to a pull request for that change (`fellBackTo`)
//   pull-request  commits on `manta/knowledge`, pushes it, opens the PR once and refreshes its body
//
// Everything written (block, commit message, PR title/body) is scanned for secrets first; a hit
// drops the write and reports it. The hand-edit baseline (`lastWrittenHash` / `lastSeenDefaultHash`)
// lives in state.sqlite's kv table under `repo.<slug>.*`.
//
// createRepoWriter(deps) → { applyRules(slug, rules), sync(slug), revert(change), status(slug) }
//   deps: dir (store dir), git (runner {run(args,{cwd})}), registry {get(slug)}, settings
//         {effectiveRepoRules, outward}, state {kvGet,kvSet,kvDelete}, scanner {scan},
//         forge {findOpenPullRequest, createPullRequest, updatePullRequest, repoAccess?, getPullRequest?},
//         fireNotify?, recentDirectories?(slug) → string[] (the project's clones, most recent first; the default clone
//         URL is the origin of the first one that still is that repo), remoteUrlFor?(project, parts) → url, now?, log?

import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repoKeyParts } from "../../shared/forge.mjs";
import { normalizeRemote } from "./identity.mjs";
import { applyBlock, findBlock, hashBlock, parseBlockRules, renderBlock } from "./repoBlock.mjs";

export const PR_BRANCH = "manta/knowledge";
const AGENTS = "AGENTS.md";
const CURATOR_EMAIL = "curator@manta.invalid";
const IDENTITY = ["-c", "user.name=Manta curator", "-c", `user.email=${CURATOR_EMAIL}`, "-c", "commit.gpgsign=false"];
const HISTORY_CAP = 40;
const NONE = "none";
const isOutward = (m) => m === "pull-request" || m === "direct";
const errText = (e) => String(e?.stderr || e?.message || e).trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300);
const hashKey = (h) => h ?? NONE;
const blockHashOf = (text) => {
  const f = findBlock(text);
  return hashKey(f.status === "found" ? hashBlock(f.text) : null);
};

class WriteStop extends Error {
  constructor(result) {
    super(result.error ?? "stopped");
    this.result = result;
  }
}

export function createRepoWriter({ dir, git, registry, settings, state, scanner, forge = {}, fireNotify, remoteUrlFor, recentDirectories, now = Date.now, log = console.warn } = {}) {
  if (!dir || !git || !registry || !settings || !state || !scanner) throw new Error("createRepoWriter: dir, git, registry, settings, state and scanner are required");
  const reposDir = join(dir, ".repos");
  const locks = new Map();

  const serial = (slug, fn) => {
    const prev = locks.get(slug) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    locks.set(slug, next);
    next
      .finally(() => {
        if (locks.get(slug) === next) locks.delete(slug);
      })
      .catch(() => {});
    return next;
  };

  // ---- per-repo bookkeeping (state.sqlite kv) ------------------------------------------
  const key = (slug, k) => `repo.${slug}.${k}`;
  const kvGet = (slug, k) => state.kvGet(key(slug, k));
  const kvSet = (slug, k, v) => (v === null || v === undefined ? state.kvDelete(key(slug, k)) : state.kvSet(key(slug, k), v));
  const kvJson = (slug, k, fallback) => {
    const raw = kvGet(slug, k);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  };
  const setJson = (slug, k, v) => kvSet(slug, k, v === null ? null : JSON.stringify(v));
  const history = (slug) => kvJson(slug, "history", []);
  const pushHistory = (slug, entry) => setJson(slug, "history", [...history(slug), entry].slice(-HISTORY_CAP));
  const patchHistory = (slug, sha, patch) => setJson(slug, "history", history(slug).map((e) => (e.sha === sha ? { ...e, ...patch } : e)));
  const markHistory = (slug, pred, patch) => setJson(slug, "history", history(slug).map((e) => (pred(e) ? { ...e, ...patch } : e)));

  // ---- git plumbing ----------------------------------------------------------------------
  const G = (cwd) => ({
    cwd,
    run: async (args) => String(await git.run(args, { cwd })).trim(),
    raw: async (args) => String(await git.run(args, { cwd })),
    try: async (args) => {
      try {
        return String(await git.run(args, { cwd })).trim();
      } catch {
        return null;
      }
    },
    ok: async (args) => {
      try {
        await git.run(args, { cwd });
        return true;
      } catch {
        return false;
      }
    },
  });

  /**
   * Where to clone from: the origin of the project's most recently used clone (so ssh/https matches the credentials the
   * user already has on this box), as long as it still names the same repository; else https.
   */
  async function defaultRemoteUrl(project, parts, slug) {
    for (const d of (recentDirectories?.(slug) ?? []).slice(0, 5)) {
      let url = null;
      try {
        url = String(await git.run(["remote", "get-url", "origin"], { cwd: d })).trim();
      } catch {
        continue;
      }
      const id = normalizeRemote(url)?.id;
      if (url && id === project.canonicalId) return url;
    }
    return `https://${parts.host}/${parts.owner}/${parts.repo}.git`;
  }

  async function context(slug) {
    const project = await registry.get(slug);
    if (!project) return null;
    const parts = repoKeyParts(project.canonicalId);
    if (!parts) return { project, parts: null };
    const remoteUrl = remoteUrlFor ? await remoteUrlFor(project, parts) : await defaultRemoteUrl(project, parts, slug);
    return { project, parts, remoteUrl, target: { repoKey: project.canonicalId }, path: join(reposDir, slug) };
  }

  async function ensureClone(ctx) {
    await mkdir(reposDir, { recursive: true });
    if (!existsSync(join(ctx.path, ".git"))) {
      await rm(ctx.path, { recursive: true, force: true });
      await git.run(["clone", "--filter=blob:none", "--quiet", "--", ctx.remoteUrl, ctx.path], { cwd: reposDir });
    }
    const g = G(ctx.path);
    if ((await g.try(["remote", "get-url", "origin"])) !== ctx.remoteUrl) await g.run(["remote", "set-url", "origin", ctx.remoteUrl]);
    await g.run(["fetch", "--prune", "--quiet", "origin"]);
    return g;
  }

  async function defaultBranchOf(g, hint) {
    if (hint) return hint;
    const head = await g.try(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (head) return head.replace(/^origin\//, "");
    for (const b of ["main", "master"]) if (await g.ok(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`])) return b;
    throw new Error("Couldn't tell the repository's default branch.");
  }

  /** AGENTS.md as committed at `ref`: {exists, symlink, text}. */
  async function readAt(g, ref) {
    const row = await g.try(["ls-tree", ref, "--", AGENTS]);
    if (!row) return { exists: false, symlink: false, text: "" };
    if (row.split(/\s+/)[0] === "120000") return { exists: true, symlink: true, text: "" };
    return { exists: true, symlink: false, text: await g.raw(["show", `${ref}:${AGENTS}`]) };
  }

  async function readWork(path) {
    const file = join(path, AGENTS);
    let st;
    try {
      st = await lstat(file);
    } catch {
      return { exists: false, symlink: false, text: "" };
    }
    if (st.isSymbolicLink()) return { exists: true, symlink: true, text: "" };
    return { exists: true, symlink: false, text: await readFile(file, "utf8") };
  }

  const checkout = async (g, args) => {
    await g.run(["checkout", "--quiet", "--force", ...args]);
    await g.run(["clean", "-fdq"]);
  };

  // ---- mode and safety ---------------------------------------------------------------------
  /** The mode that actually applies RIGHT NOW (re-checked at write time, §4.1). */
  async function resolveMode(slug, ctx) {
    const eff = await settings.effectiveRepoRules(slug);
    let mode = eff.repoRules;
    let reason = eff.reason ?? null;
    let defaultBranch = null;
    if (isOutward(mode)) {
      const out = await settings.outward(slug);
      if (!out.allowed) {
        mode = "box-only";
        reason = out.reason ?? "Repository writes aren't available for this project.";
      } else defaultBranch = out.defaultBranch ?? null;
    }
    if (isOutward(mode) && forge.repoAccess) {
      const a = await forge.repoAccess(ctx.target);
      if (!a?.ok) {
        mode = "box-only";
        reason = a?.message ?? "Couldn't check your access to this repository.";
      } else if (a.isFork) {
        mode = "box-only";
        reason = "This repository is a fork.";
      } else if (!a.canPush) {
        mode = "box-only";
        reason = "You can't push to this repository.";
      } else defaultBranch = a.defaultBranch || defaultBranch;
    }
    return { mode, reason, defaultBranch };
  }

  async function secretProblem(label, text) {
    const r = await scanner.scan(text);
    if (r.clean) return null;
    return r.unavailable ? `The secret scanner is unavailable, so the ${label} wasn't written.` : `The ${label} looked like it contained a secret, so it wasn't written.`;
  }

  /** The first outward action on a repo notifies at once; recorded only after the notification really went out. */
  async function notifyFirst(slug, ctx, how) {
    if (!fireNotify || kvGet(slug, "notified") === "1") return;
    try {
      await fireNotify({
        title: "Manta changed a repository",
        message: `Manta ${how} for ${ctx.parts.owner}/${ctx.parts.repo}: shared project rules in AGENTS.md. Open Settings → Knowledge to review or undo it.`,
        tag: `knowledge-outward-${slug}`,
      });
      kvSet(slug, "notified", "1");
    } catch (e) {
      log("[knowledge] outward notification failed:", e?.message ?? e);
    }
  }

  // ---- hand-edit baseline ----------------------------------------------------------------------
  /** The block currently on the default branch, and whether it counts as a hand edit (§4.1). */
  function classifyDefault(slug, defaultText) {
    const f = findBlock(defaultText);
    const text = f.status === "found" ? f.text : null;
    const h = hashKey(hashBlock(text));
    const written = kvGet(slug, "lastWrittenHash");
    const seen = kvGet(slug, "lastSeenDefaultHash");
    // No baseline yet: an existing block that Manta never wrote is somebody's, so adopt it first.
    const handEdit = seen === null ? text !== null : h !== seen && h !== written;
    return { text, h, handEdit, corrupt: f.status === "corrupt" ? f.reason : null };
  }

  /**
   * Never overwrite a person's edit of the block on the default branch. `{block: result}` refuses the write (and records the
   * edit so `sync` hands it to the curator to adopt); `{cls}` says it is safe to go on.
   */
  async function guardDefault(slug, g, defaultBranch, mode) {
    const def = await readAt(g, `origin/${defaultBranch}`);
    if (def.symlink) return { block: { ok: false, mode, error: "AGENTS.md in this repository is a symlink, so it was left alone." } };
    const cls = classifyDefault(slug, def.text);
    if (cls.corrupt) return { block: { ok: false, mode, error: `AGENTS.md has a damaged managed block (${cls.corrupt}), so it was left alone.` } };
    const pending = kvGet(slug, "pendingHandEdit");
    if (pending !== null || cls.handEdit) {
      if (pending === null && kvJson(slug, "pr", null) === null) kvSet(slug, "pendingHandEdit", cls.text ?? "");
      return { block: { ok: false, mode, error: "A person edited the managed block; Manta adopts their version first.", handEdit: pending ?? cls.text ?? "" } };
    }
    return { cls };
  }

  /** The block on the PR branch when a reviewer changed it since Manta last pushed (compared with `prBlockHash`), else null. */
  async function branchEdit(slug, g) {
    const prHash = kvGet(slug, "prBlockHash");
    if (prHash === null || !(await g.ok(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${PR_BRANCH}`]))) return null;
    const at = await readAt(g, `origin/${PR_BRANCH}`);
    if (at.symlink) return null;
    const f = findBlock(at.text);
    if (f.status === "corrupt") return null;
    const h = hashKey(f.status === "found" ? hashBlock(f.text) : null);
    return h === prHash ? null : { text: f.status === "found" ? f.text : "", h };
  }

  /** Every commit in default..branch was made by Manta's curator identity (so rebuilding the branch loses no person's work). */
  async function branchIsOurs(g, defaultBranch) {
    const rows = await g.try(["log", "--format=%ae%n%ce", `origin/${defaultBranch}..origin/${PR_BRANCH}`]);
    if (rows === null) return false;
    return rows.split("\n").filter(Boolean).every((e) => e.trim() === CURATOR_EMAIL);
  }

  // ---- the change itself -------------------------------------------------------------------------
  const commitMessage = (n) => `Update Manta knowledge rules in AGENTS.md\n\nThe managed block now lists ${n} rule${n === 1 ? "" : "s"}.`;
  const prTitle = "Update project rules from Manta";
  const prBody = (rules) =>
    [
      "Manta keeps these standing rules for the project, from corrections made in separate sessions:",
      "",
      ...(rules.length ? rules.map((r) => `- ${r}`) : ["(none)"]),
      "",
      "This pull request only changes the managed block in `AGENTS.md`. Merge it to share the rules with everyone working on the repo; close it and Manta stops proposing them.",
    ].join("\n");

  /** Edit AGENTS.md in the clone to carry `block`. Throws WriteStop for a symlink / damaged block. */
  async function stage(ctx, mode, block) {
    const cur = await readWork(ctx.path);
    if (cur.symlink) throw new WriteStop({ ok: false, mode, error: "AGENTS.md in this repository is a symlink, so it was left alone." });
    const f = findBlock(cur.text);
    if (f.status === "corrupt") throw new WriteStop({ ok: false, mode, error: `AGENTS.md has a damaged managed block (${f.reason}), so it was left alone.` });
    const next = applyBlock(cur.text, block);
    const prevText = f.status === "found" ? f.text : null;
    if (next === cur.text) return { changed: false, prevText };
    // The block was all the file held (the curator created it): remove the file rather than leave an empty one.
    if (next.trim() === "" && block === null) await rm(join(ctx.path, AGENTS), { force: true });
    else await writeFile(join(ctx.path, AGENTS), next);
    return { changed: true, prevText };
  }

  async function commitStaged(g, message) {
    await g.run(["add", "--", AGENTS]);
    await g.run([...IDENTITY, "commit", "--quiet", "-m", message]);
    return g.run(["rev-parse", "HEAD"]);
  }

  async function ensurePullRequest(ctx, defaultBranch, rules) {
    const found = await forge.findOpenPullRequest(ctx.target, PR_BRANCH);
    if (!found?.ok) return { error: found?.message ?? "Couldn't look for the pull request." };
    const body = prBody(rules);
    const problem = await secretProblem("pull request text", `${prTitle}\n${body}`);
    if (problem) return { error: problem };
    let pr = found.pr;
    if (pr) {
      const upd = await forge.updatePullRequest(ctx.target, { number: pr.number, body });
      if (!upd?.ok) return { error: upd?.message ?? "Couldn't update the pull request.", pr: prRef(pr) };
      pr = upd.pr ?? pr;
    } else {
      const made = await forge.createPullRequest(ctx.target, { title: prTitle, head: PR_BRANCH, base: defaultBranch, body });
      if (!made?.ok) return { error: made?.message ?? "Couldn't open the pull request." };
      pr = made.pr;
    }
    return { pr: prRef(pr) };
  }
  const prRef = (pr) => ({ number: pr.number, url: pr.url ?? pr.html_url ?? "" });

  async function writeDirect(slug, ctx, g, defaultBranch, rendered) {
    const mode = "direct";
    const message = commitMessage(rendered.rules.length);
    const problem = await secretProblem("commit message", message);
    if (problem) return { ok: false, mode, error: problem };
    for (let attempt = 0; attempt < 2; attempt++) {
      await checkout(g, ["--detach", `origin/${defaultBranch}`]);
      const st = await stage(ctx, mode, rendered.block);
      const h = hashKey(hashBlock(rendered.block));
      if (!st.changed) {
        kvSet(slug, "lastWrittenHash", h);
        kvSet(slug, "lastSeenDefaultHash", h);
        return { ok: true, mode, sha: await g.run(["rev-parse", "HEAD"]), changed: false };
      }
      const sha = await commitStaged(g, message);
      try {
        await g.run(["push", "--quiet", "origin", `HEAD:${defaultBranch}`]);
      } catch (e) {
        if (attempt === 0 && /non-fast-forward|fetch first|stale info|rejected/i.test(String(e?.stderr || e?.message || e))) {
          await g.run(["fetch", "--prune", "--quiet", "origin"]);
          // Someone pushed while we were committing: look at what is there NOW before re-staging on top of it.
          const again = await guardDefault(slug, g, defaultBranch, mode);
          if (again.block) return again.block;
          continue;
        }
        log(`[knowledge] direct push rejected for ${slug}: ${errText(e)}`);
        const via = await writePullRequest(slug, ctx, g, defaultBranch, rendered);
        return { ...via, fellBackTo: "pull-request", directError: errText(e) };
      }
      kvSet(slug, "lastWrittenHash", h);
      kvSet(slug, "lastSeenDefaultHash", h);
      pushHistory(slug, { sha, mode, prev: st.prevText, next: rendered.block, at: now() });
      await notifyFirst(slug, ctx, "committed to the default branch");
      return { ok: true, mode, sha, changed: true };
    }
    return { ok: false, mode, error: "The default branch kept moving; try again later." };
  }

  async function writePullRequest(slug, ctx, g, defaultBranch, rendered) {
    const mode = "pull-request";
    const message = commitMessage(rendered.rules.length);
    const problem = await secretProblem("commit message", message);
    if (problem) return { ok: false, mode, error: problem };
    const remoteRef = `origin/${PR_BRANCH}`;
    const remoteTip = await g.try(["rev-parse", "--verify", "--quiet", `refs/remotes/${remoteRef}`]);
    let lease = null;
    let rebuilt = false;
    if (remoteTip) {
      const edited = await branchEdit(slug, g);
      if (edited) {
        return { ok: false, mode, error: `A reviewer edited the managed block on ${PR_BRANCH}; Manta adopts their version first.`, handEdit: edited.text };
      }
      await checkout(g, ["-B", PR_BRANCH, remoteRef]);
      if (!(await g.ok(["merge-base", "--is-ancestor", `origin/${defaultBranch}`, "HEAD"]))) {
        const merged = await g.ok([...IDENTITY, "merge", "--quiet", "--no-edit", `origin/${defaultBranch}`]);
        if (!merged) {
          await g.ok(["merge", "--abort"]);
          if (!(await branchIsOurs(g, defaultBranch))) {
            return { ok: false, mode, error: `${PR_BRANCH} has commits from people and no longer merges with the default branch, so Manta left it alone.` };
          }
          // The default branch moved under the block and the branch holds only Manta's commits: rebuild it (one new commit).
          await checkout(g, ["-B", PR_BRANCH, `origin/${defaultBranch}`]);
          lease = remoteTip;
          rebuilt = true;
        }
      }
    } else await checkout(g, ["-B", PR_BRANCH, `origin/${defaultBranch}`]);

    const st = await stage(ctx, mode, rendered.block);
    let sha = await g.run(["rev-parse", "HEAD"]);
    if (st.changed) sha = await commitStaged(g, message);
    const written = hashKey(hashBlock(rendered.block));
    if (await g.ok(["diff", "--quiet", `origin/${defaultBranch}`, "HEAD", "--", AGENTS])) {
      // Nothing to propose: the default branch already carries exactly this block.
      kvSet(slug, "lastWrittenHash", written);
      return { ok: true, mode, sha, changed: false };
    }
    if (st.changed || rebuilt || !remoteTip) {
      try {
        await g.run(["push", "--quiet", ...(lease ? [`--force-with-lease=${PR_BRANCH}:${lease}`] : []), "origin", `HEAD:refs/heads/${PR_BRANCH}`]);
        kvSet(slug, "blocked", null);
      } catch (e) {
        const msg = `Pushing ${PR_BRANCH} was rejected: ${errText(e)}`;
        kvSet(slug, "blocked", msg);
        log(`[knowledge] ${msg} (${slug})`);
        return { ok: false, mode: "box-only", error: msg };
      }
    }
    if (st.changed) {
      if (rebuilt) markHistory(slug, (e) => e.mode === "pull-request" && !e.merged && !e.reverted, { superseded: true });
      pushHistory(slug, { sha, mode, prev: st.prevText, next: rendered.block, at: now() });
    }
    kvSet(slug, "lastWrittenHash", written);
    kvSet(slug, "prBlockHash", written);
    setJson(slug, "prRules", rendered.rules);
    const pr = await ensurePullRequest(ctx, defaultBranch, rendered.rules);
    if (pr.pr) setJson(slug, "pr", { ...pr.pr, head: PR_BRANCH, openedAt: kvJson(slug, "pr", null)?.openedAt ?? now(), baselineHash: kvJson(slug, "pr", null)?.baselineHash ?? kvGet(slug, "lastSeenDefaultHash") });
    await notifyFirst(slug, ctx, pr.pr ? "opened a pull request" : `pushed the ${PR_BRANCH} branch (the pull request couldn't be opened)`);
    if (pr.error) return { ok: false, mode, sha, changed: st.changed, error: `Pushed ${PR_BRANCH}, but ${pr.error}`, ...(pr.pr ? { pr: pr.pr } : {}) };
    return { ok: true, mode, sha, changed: st.changed, pr: pr.pr };
  }

  // ---- applyRules -------------------------------------------------------------------------------------
  async function applyRulesLocked(slug, rules) {
    const ctx = await context(slug);
    if (!ctx) return { ok: false, mode: "box-only", error: "Unknown project." };
    if (!ctx.parts) return { ok: true, mode: "box-only", reason: "Repository writes need a GitHub or GitLab remote." };
    const m = await resolveMode(slug, ctx);
    if (!isOutward(m.mode)) return { ok: true, mode: "box-only", ...(m.reason ? { reason: m.reason } : {}) };

    const rendered = renderBlock(rules);
    if (rendered.block) {
      const problem = await secretProblem("rules block", rendered.block);
      if (problem) return { ok: false, mode: m.mode, error: problem };
    }
    try {
      const g = await ensureClone(ctx);
      const defaultBranch = await defaultBranchOf(g, m.defaultBranch);
      kvSet(slug, "defaultBranch", defaultBranch);
      const guard = await guardDefault(slug, g, defaultBranch, m.mode);
      if (guard.block) return guard.block;
      const { cls } = guard;
      if (rendered.block === null && cls.text === null && kvJson(slug, "pr", null) === null) return { ok: true, mode: m.mode, changed: false };
      return m.mode === "direct" ? await writeDirect(slug, ctx, g, defaultBranch, rendered) : await writePullRequest(slug, ctx, g, defaultBranch, rendered);
    } catch (e) {
      if (e instanceof WriteStop) return e.result;
      log(`[knowledge] repository write failed for ${slug}:`, errText(e));
      return { ok: false, mode: m.mode, error: errText(e) || "The repository write failed." };
    }
  }

  const applyRules = (slug, rules) => serial(slug, () => applyRulesLocked(slug, Array.isArray(rules) ? rules : []));

  // ---- sync -------------------------------------------------------------------------------------------
  /** How the recorded PR ended: from the forge when it can say, inferred from git only when that call fails. */
  async function prLifecycle(slug, ctx, g, defaultBranch, pr, cls) {
    let ended = null; // null = still open
    let answered = false;
    let callError = null;
    if (forge.getPullRequest) {
      try {
        const r = await forge.getPullRequest(ctx.target, pr.number);
        if (r?.ok) {
          answered = true;
          const st = String(r.pr?.state ?? "");
          if (r.pr?.merged === true || st === "merged") ended = "merged";
          else if (st === "closed") ended = "closed";
        } else callError = r?.message ?? "Couldn't check the pull request.";
      } catch (e) {
        callError = errText(e);
      }
    }
    if (!answered) {
      const found = await forge.findOpenPullRequest(ctx.target, pr.head ?? PR_BRANCH);
      if (!found?.ok) return { state: "open", error: found?.message ?? callError ?? "Couldn't check the pull request." };
      if (!found.pr) ended = "unknown";
    }
    if (ended === null) {
      const hasBranch = await g.ok(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${PR_BRANCH}`]);
      return { state: hasBranch ? "open" : "branch-deleted" };
    }
    const mergedKind = () => (cls.h === kvGet(slug, "prBlockHash") ? "merged" : "merged-edited");
    if (ended === "merged") return { state: mergedKind() };
    if (ended === "closed") return { state: "closed" };
    if (cls.h === kvGet(slug, "prBlockHash")) return { state: "merged" };
    const tip = await g.try(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${PR_BRANCH}`]);
    if (tip && (await g.ok(["merge-base", "--is-ancestor", tip, `origin/${defaultBranch}`]))) return { state: mergedKind() };
    // Squash-merged with edits looks like a closed PR plus a hand edit; a block that still carries the PR's
    // rules and differs from the pre-PR baseline is read as the merge (a forge `getPullRequest` removes the guess).
    const baseline = pr.baselineHash ?? kvGet(slug, "lastSeenDefaultHash");
    if (cls.text !== null && cls.h !== baseline) {
      const mine = kvJson(slug, "prRules", []).map((r) => r.toLowerCase());
      const theirs = parseBlockRules(cls.text).map((r) => r.toLowerCase());
      if (theirs.some((t) => mine.some((m) => t.includes(m) || m.includes(t)))) return { state: "merged-edited" };
    }
    return { state: "closed" };
  }

  async function syncLocked(slug) {
    const ctx = await context(slug);
    if (!ctx?.parts) return { handEdit: null, prState: "none" };
    const hasClone = existsSync(join(ctx.path, ".git"));
    let hint = kvGet(slug, "defaultBranch");
    if (!hasClone) {
      const m = await resolveMode(slug, ctx);
      if (!isOutward(m.mode)) return { handEdit: null, prState: "none" };
      hint = m.defaultBranch ?? hint;
    }
    const pr = kvJson(slug, "pr", null);
    let g;
    let defaultBranch;
    try {
      g = await ensureClone(ctx);
      defaultBranch = await defaultBranchOf(g, hint);
      kvSet(slug, "defaultBranch", defaultBranch);
    } catch (e) {
      return { handEdit: null, prState: pr ? "open" : "none", error: errText(e) };
    }
    const def = await readAt(g, `origin/${defaultBranch}`);
    const cls = def.symlink ? { text: null, h: NONE, handEdit: false, corrupt: null } : classifyDefault(slug, def.text);
    const out = { handEdit: null, prState: "none" };

    if (pr) {
      const life = await prLifecycle(slug, ctx, g, defaultBranch, pr, cls);
      out.prState = life.state;
      if (life.error) out.error = life.error;
      if (life.state === "merged" || life.state === "merged-edited") {
        if (life.state === "merged-edited") out.mergedText = cls.text ?? "";
        setJson(slug, "pr", null);
        kvSet(slug, "prBlockHash", null);
        kvSet(slug, "prRules", null);
        kvSet(slug, "pendingHandEdit", null);
        kvSet(slug, "lastSeenDefaultHash", cls.h);
        kvSet(slug, "lastWrittenHash", cls.h);
        markHistory(slug, (e) => e.mode === "pull-request" && !e.superseded && !e.reverted, { merged: true });
        return out;
      }
      if (life.state === "open") {
        const edited = await branchEdit(slug, g);
        if (edited) {
          // A reviewer changed the block on the PR branch: adopt it as truth and build on top of it.
          out.handEdit = edited.text;
          kvSet(slug, "prBlockHash", edited.h);
          kvSet(slug, "lastWrittenHash", edited.h);
          setJson(slug, "prRules", edited.text ? parseBlockRules(edited.text) : []);
        }
      }
      if (life.state === "closed") {
        // Closed unmerged: the block on the default branch is back to what it was; later edits still count.
        setJson(slug, "pr", null);
        kvSet(slug, "prBlockHash", null);
        kvSet(slug, "prRules", null);
        kvSet(slug, "lastWrittenHash", kvGet(slug, "lastSeenDefaultHash"));
        markHistory(slug, (e) => e.mode === "pull-request" && !e.merged && !e.reverted, { closed: true });
        const redo = classifyDefault(slug, def.text);
        cls.handEdit = redo.handEdit;
      }
    }

    const pending = kvGet(slug, "pendingHandEdit");
    if (pending !== null) {
      out.handEdit ??= pending;
      kvSet(slug, "pendingHandEdit", null);
    } else if (cls.handEdit && !cls.corrupt) out.handEdit ??= cls.text ?? "";
    if (!cls.corrupt) kvSet(slug, "lastSeenDefaultHash", cls.h);
    return out;
  }

  const sync = (slug) => serial(slug, () => syncLocked(slug));

  // ---- revert -------------------------------------------------------------------------------------------
  async function conflictWith(g, sha, ref) {
    const row = await g.try(["log", "-n1", "--format=%h%x09%s", `${sha}..${ref}`, "--", AGENTS]);
    if (!row) return undefined;
    const [short, ...subject] = row.split("\t");
    return { sha: short, subject: subject.join("\t") };
  }

  /** Revert `sha` onto the checked-out `ref`; commits the result. */
  async function revertCommit(g, sha, ref, message) {
    if (!(await g.ok(["revert", "--no-commit", sha]))) {
      await g.ok(["revert", "--abort"]);
      await g.ok(["reset", "--hard", "--quiet", ref]);
      return { ok: false, conflict: await conflictWith(g, sha, ref) };
    }
    if (await g.ok(["diff", "--cached", "--quiet"])) return { ok: true, noop: true, sha: await g.run(["rev-parse", "HEAD"]) };
    const problem = await secretProblem("commit message", message);
    if (problem) {
      await g.ok(["reset", "--hard", "--quiet", ref]);
      return { ok: false, error: problem };
    }
    await g.run([...IDENTITY, "commit", "--quiet", "-m", message]);
    return { ok: true, sha: await g.run(["rev-parse", "HEAD"]) };
  }

  async function revertViaPullRequest(slug, ctx, g, defaultBranch, entry, how) {
    const branch = `${PR_BRANCH}-revert-${entry.sha.slice(0, 7)}`;
    const base = `origin/${defaultBranch}`;
    await checkout(g, ["-B", branch, base]);
    const message = `Revert Manta knowledge rules update ${entry.sha.slice(0, 7)}`;
    let result;
    if (how === "commit") result = await revertCommit(g, entry.sha, base, message);
    else {
      const cur = await readWork(ctx.path);
      const f = findBlock(cur.text);
      if (cur.symlink || f.status === "corrupt") return { ok: false, reason: "AGENTS.md can't be edited safely." };
      if (blockHashOf(cur.text) !== hashKey(hashBlock(entry.next))) {
        return { ok: false, reason: "The managed block changed after that update, so it can't be reverted cleanly.", conflictWith: { sha: "", subject: "a later change to the managed block" } };
      }
      const problem = await secretProblem("commit message", message);
      if (problem) return { ok: false, reason: problem };
      await writeFile(join(ctx.path, AGENTS), applyBlock(cur.text, entry.prev ?? null));
      result = { ok: true, sha: await commitStaged(g, message) };
    }
    if (!result.ok) return { ok: false, reason: result.error ?? "That update can't be reverted cleanly.", ...(result.conflict ? { conflictWith: result.conflict } : {}) };
    if (result.noop) return { ok: true, reason: "Nothing left to revert." };
    try {
      await g.run(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
    } catch (e) {
      return { ok: false, reason: `Pushing the revert branch was rejected: ${errText(e)}` };
    }
    const title = "Revert Manta knowledge rules update";
    const body = "Manta is reverting an earlier update to the managed block in `AGENTS.md`, at your request.";
    const problem = await secretProblem("pull request text", `${title}\n${body}`);
    if (problem) return { ok: false, reason: problem };
    const found = await forge.findOpenPullRequest(ctx.target, branch);
    let pr = found?.ok ? found.pr : null;
    if (!pr) {
      const made = await forge.createPullRequest(ctx.target, { title, head: branch, base: defaultBranch, body });
      if (!made?.ok) return { ok: false, reason: made?.message ?? "Couldn't open the revert pull request." };
      pr = made.pr;
    }
    // The expected state once the revert PR merges, so that merge isn't mistaken for a hand edit.
    kvSet(slug, "lastWrittenHash", blockHashOf((await readWork(ctx.path)).text));
    patchHistory(slug, entry.sha, { reverted: true });
    pushHistory(slug, { sha: result.sha, mode: "pull-request", reverts: entry.sha, prev: entry.next, next: entry.prev ?? null, at: now(), branch });
    return { ok: true, pr: prRef(pr) };
  }

  const changeRef = (change) => {
    const meta = change?.data?.repo ?? change?.data ?? change ?? {};
    return { slug: change?.slug ?? meta.slug, sha: meta.sha ?? meta.commitSha };
  };

  async function revertLocked(change) {
    const { slug, sha } = changeRef(change);
    if (!slug || !sha) return { ok: false, reason: "That change doesn't record a repository commit." };
    const entry = history(slug).find((e) => e.sha === sha);
    if (!entry) return { ok: false, reason: "Manta no longer has a record of that repository change." };
    if (entry.reverted) return { ok: false, reason: "That repository change was already reverted." };
    const ctx = await context(slug);
    if (!ctx?.parts) return { ok: false, reason: "Unknown project." };
    try {
      const g = await ensureClone(ctx);
      const defaultBranch = await defaultBranchOf(g, kvGet(slug, "defaultBranch"));
      const base = `origin/${defaultBranch}`;
      const message = `Revert Manta knowledge rules update ${sha.slice(0, 7)}`;
      const exists = await g.ok(["cat-file", "-e", `${sha}^{commit}`]);
      const onDefault = exists && (await g.ok(["merge-base", "--is-ancestor", sha, base]));

      if (onDefault && entry.mode === "direct") {
        await checkout(g, ["--detach", base]);
        const r = await revertCommit(g, sha, base, message);
        if (!r.ok) return { ok: false, reason: r.error ?? "A later change touches the same rules, so this can't be reverted cleanly.", ...(r.conflict ? { conflictWith: r.conflict } : {}) };
        if (r.noop) return { ok: true, reason: "Nothing left to revert." };
        try {
          await g.run(["push", "--quiet", "origin", `HEAD:${defaultBranch}`]);
        } catch (e) {
          log(`[knowledge] direct revert push rejected for ${slug}: ${errText(e)}`);
          return await revertViaPullRequest(slug, ctx, g, defaultBranch, entry, "commit");
        }
        const h = blockHashOf((await readWork(ctx.path)).text);
        kvSet(slug, "lastWrittenHash", h);
        kvSet(slug, "lastSeenDefaultHash", h);
        patchHistory(slug, sha, { reverted: true });
        pushHistory(slug, { sha: r.sha, mode: "direct", reverts: sha, prev: entry.next, next: entry.prev ?? null, at: now() });
        return { ok: true, sha: r.sha };
      }
      if (onDefault) return await revertViaPullRequest(slug, ctx, g, defaultBranch, entry, "commit");

      const branchRef = `origin/${PR_BRANCH}`;
      if (entry.mode === "pull-request" && exists && (await g.ok(["merge-base", "--is-ancestor", sha, branchRef]))) {
        // Unmerged: take the change out of the PR branch.
        await checkout(g, ["-B", PR_BRANCH, branchRef]);
        const r = await revertCommit(g, sha, branchRef, message);
        if (!r.ok) return { ok: false, reason: r.error ?? "A later change to the pull request touches the same rules, so this can't be reverted cleanly.", ...(r.conflict ? { conflictWith: r.conflict } : {}) };
        if (r.noop) return { ok: true, reason: "Nothing left to revert." };
        try {
          await g.run(["push", "--quiet", "origin", `HEAD:refs/heads/${PR_BRANCH}`]);
        } catch (e) {
          return { ok: false, reason: `Pushing ${PR_BRANCH} was rejected: ${errText(e)}` };
        }
        const text = (await readWork(ctx.path)).text;
        const h = blockHashOf(text);
        kvSet(slug, "lastWrittenHash", h);
        kvSet(slug, "prBlockHash", h);
        patchHistory(slug, sha, { reverted: true });
        pushHistory(slug, { sha: r.sha, mode: "pull-request", reverts: sha, prev: entry.next, next: entry.prev ?? null, at: now() });
        const pr = kvJson(slug, "pr", null);
        if (pr) {
          const f = findBlock(text);
          const body = prBody(f.status === "found" ? parseBlockRules(f.text) : []);
          if (!(await secretProblem("pull request text", body))) await forge.updatePullRequest(ctx.target, { number: pr.number, body });
        }
        return { ok: true, sha: r.sha };
      }

      // The commit is on no ref: squash-merged, or its PR was closed and the branch deleted.
      const def = await readAt(g, base);
      const current = def.symlink ? NONE : blockHashOf(def.text);
      if (current === hashKey(hashBlock(entry.next))) {
        await checkout(g, ["--detach", base]);
        return await revertViaPullRequest(slug, ctx, g, defaultBranch, entry, "block");
      }
      if (entry.mode === "direct") return { ok: false, reason: "That commit is no longer in the branch history and the managed block has changed since.", conflictWith: { sha: "", subject: "a later change to the managed block" } };
      patchHistory(slug, sha, { reverted: true });
      return { ok: true, reason: "That update never reached the default branch, so there is nothing to revert." };
    } catch (e) {
      log(`[knowledge] repository revert failed for ${slug}:`, errText(e));
      return { ok: false, reason: errText(e) || "The repository revert failed." };
    }
  }

  const revert = (change) => serial(changeRef(change).slug ?? "_", () => revertLocked(change));

  /** What the Knowledge card can show for a repo: why outward writes are blocked, the open PR, the baseline. */
  function status(slug) {
    return {
      blocked: kvGet(slug, "blocked"),
      pr: kvJson(slug, "pr", null),
      pendingHandEdit: kvGet(slug, "pendingHandEdit") !== null,
      lastWrittenHash: kvGet(slug, "lastWrittenHash"),
      lastSeenDefaultHash: kvGet(slug, "lastSeenDefaultHash"),
    };
  }

  return { applyRules, sync, revert, status };
}
