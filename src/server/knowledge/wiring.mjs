// wiring.mjs — builds the knowledge parts that sit on top of the engine's foundation and wires them
// to each other (spec §5, §6.6, §8): capture, correction detector, repository writer, skill trial +
// learned skills, blackboard import, CTO mirror and the weekly notice.
//
// The engine calls `createKnowledgeParts(ctx, d)` once, from `init()`, with the foundation handles
// (`ctx`: state, store, registry, sessionMap, queue, budget, changes, scanner, settings, git, dir, now, log,
// isKnowledgeRunActive). `d` is everything that comes from the rest of manta-server (opencode client, forge,
// db worker, notifications). It returns what the engine needs:
//   layerDeps      handed to the curator layer as `deps.corrections | repoWriter | skills`
//   observeRaw(ev) fed every raw opencode event (capture activity, trial completion)
//   maintain()     one pass from the maintenance poller (capture tick, blackboard import, weekly notice)
//   mirrorCtoFact  the live `cto_fact` mirror (§5.4)
//   capabilities() what is on, for `status().parts`
//
// Each part is OFF when its collaborators are absent (reported, never a crash). No part is built when `d`
// carries nothing: the engine core keeps working on its own.

import { createCapture, createCaptureMessageSource, makeReportCost } from "./capture.mjs";
import { createCorrectionDetector, createUserMessageReader } from "./corrections.mjs";
import { createBlackboardImport, createKeyResolver } from "./blackboardImport.mjs";
import { createCtoMirror } from "./ctoMirror.mjs";
import { createWeeklyNotice } from "./weeklyNotice.mjs";
import { forgeFindOpenPullRequest, forgeGetPullRequest } from "../forge/index.mjs";
import { createRepoWriter } from "./repoWriter.mjs";
import { createTrial } from "./trial.mjs";
import { createSkills } from "./skills.mjs";
import { createSkillLoadReader, createSingleMessageReader, createToolCallReader, createTrialResultReader, createUserRequestLister } from "./readers.mjs";
import { createTombstones } from "./tombstones.mjs";
import { parsePage } from "./pages.mjs";
import { feedsShared } from "./sharing.mjs";

const EVIDENCE_WINDOW_MS = 30 * 24 * 3600 * 1000;
const EVIDENCE_KEEP_MS = 60 * 24 * 3600 * 1000;
const NETWORK_VERBS = new Set(["clone", "fetch", "push", "ls-remote", "pull"]);

/** Basic-auth header value for a forge token (GitLab wants `oauth2`, GitHub `x-access-token`). */
export const forgeBasicAuth = (host, token) => Buffer.from(`${/gitlab/i.test(String(host)) ? "oauth2" : "x-access-token"}:${token}`).toString("base64");

const hostOfUrl = (url) => {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * A git runner for the repository writer's independent clones: network commands get the forge credential for that
 * one command through git's environment config (`GIT_CONFIG_COUNT/KEY_0/VALUE_0` → `http.extraheader`), so no token
 * is ever on a command line (visible in /proc), in the clone's `.git/config` or in its remote URL. Everything else
 * passes through untouched.
 *
 * @param {{ run(args: string[], o?: object): Promise<string> }} git
 * @param {(host: string) => Promise<{token: string} | string | null>} resolveToken
 */
export function createAuthedGit(git, resolveToken) {
  async function hostFor(args, opts) {
    const urlArg = args.find((a, i) => i > 0 && /^(https?:)\/\//.test(a));
    if (urlArg) return hostOfUrl(urlArg);
    try {
      return hostOfUrl(String(await git.run(["remote", "get-url", "origin"], opts)).trim());
    } catch {
      return null;
    }
  }
  return {
    async run(args, opts = {}) {
      if (!resolveToken || !NETWORK_VERBS.has(args[0])) return git.run(args, opts);
      let env = opts.env;
      try {
        const host = await hostFor(args, opts);
        const t = host ? await resolveToken(host) : null;
        const token = typeof t === "string" ? t : t?.token;
        if (token) {
          const n = Number.parseInt(env?.GIT_CONFIG_COUNT ?? "0", 10) || 0;
          env = {
            ...(env ?? {}),
            GIT_CONFIG_COUNT: String(n + 1),
            [`GIT_CONFIG_KEY_${n}`]: "http.extraheader",
            [`GIT_CONFIG_VALUE_${n}`]: `Authorization: Basic ${forgeBasicAuth(host, token)}`,
          };
        }
      } catch {
        env = opts.env; // no credential: the command runs as-is and git reports what it can't reach
      }
      return git.run(args, env === opts.env ? opts : { ...opts, env });
    },
  };
}

/**
 * The detection evidence for skills: the capture notes of the last 30 days (they are consumed from the queue by the
 * curator, so a copy is kept here) plus the runbook pages of every project that shares. `queue` is wrapped so every
 * ACCEPTED capture note leaves a row behind.
 */
export function createSkillEvidence({ state, queue, store, settings, now = Date.now, log = console.warn }) {
  state.migrate(
    "skill-evidence-1",
    `CREATE TABLE IF NOT EXISTS skill_evidence (
       id TEXT PRIMARY KEY, slug TEXT NOT NULL, session_id TEXT, text TEXT NOT NULL, at INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS skill_evidence_at ON skill_evidence(at);`,
  );
  const db = state.db;
  const wrapped = {
    ...queue,
    enqueue: async (note) => {
      const r = await queue.enqueue(note);
      try {
        if (r?.accepted && note?.origin === "capture") {
          db.prepare("INSERT OR IGNORE INTO skill_evidence (id, slug, session_id, text, at) VALUES (?, ?, ?, ?, ?)").run(r.id, note.slug, note.sessionID ?? null, String(note.text ?? "").slice(0, 600), now());
          db.prepare("DELETE FROM skill_evidence WHERE at < ?").run(now() - EVIDENCE_KEEP_MS);
        }
      } catch (e) {
        log("[knowledge] skill evidence not recorded:", e?.message ?? e);
      }
      return r;
    },
  };
  async function loadEvidence() {
    const sharing = new Map();
    const shares = async (slug) => {
      if (!sharing.has(slug)) sharing.set(slug, feedsShared((await settings.effective(slug)).sharing));
      return sharing.get(slug);
    };
    const notes = [];
    for (const r of db.prepare("SELECT id, slug, session_id, text, at FROM skill_evidence WHERE at >= ? ORDER BY at DESC LIMIT 200").all(now() - EVIDENCE_WINDOW_MS)) {
      if (notes.length >= 60) break;
      if (await shares(r.slug)) notes.push({ id: r.id, slug: r.slug, sessionID: r.session_id, text: r.text, at: r.at });
    }
    const runbooks = [];
    for (const path of await store.listPages()) {
      const m = /^projects\/([^/]+)\/runbooks\/[^/]+\.md$/.exec(path);
      if (!m || runbooks.length >= 12 || !(await shares(m[1]))) continue;
      const src = await store.read(path);
      if (src === null) continue;
      const page = parsePage(src);
      runbooks.push({ slug: m[1], path, title: page.frontMatter?.title ?? path.split("/").pop().replace(/\.md$/, ""), body: page.body });
    }
    return { notes, runbooks };
  }
  return { queue: wrapped, loadEvidence };
}

/**
 * @param {object} ctx  foundation handles (see the header)
 * @param {object} d    collaborators from manta-server:
 *   runEphemeral, resolveModelForClass, configGet,
 *   oc {listMessages, createSession, sendPrompt, abortSession, deleteSessionRaw?}, local {gitAddWorktree, gitRemoveWorktree},
 *   runDbTask, listTmuxProjects, isUserAuthored(messageID), getSession, isCtoSession,
 *   forge {findOpenPullRequest, createPullRequest, updatePullRequest, repoAccess?, getPullRequest?}, resolveToken,
 *   fireNotify, skillsDir, factsDir?, remoteUrlFor?
 */
export function createKnowledgeParts(ctx, d = {}) {
  const { state, store, registry, sessionMap, queue, budget, changes, scanner, settings, git, dir, now = Date.now, log = console.warn } = ctx;
  const layerDeps = {};
  const caps = {};
  const listMessages = d.oc?.listMessages ? (sessionID) => d.oc.listMessages(sessionID) : null;
  const isUserAuthored = d.isUserAuthored ?? (() => false);
  const runEphemeral = d.runEphemeral;
  const off = (why) => `off: ${why}`;

  // ---- capture (§5.2) --------------------------------------------------------------------------
  const evidence = createSkillEvidence({ state, queue, store, settings, now, log });
  let capture = null;
  if (runEphemeral && listMessages) {
    capture = createCapture({
      state,
      sessionMap,
      queue: evidence.queue,
      budget,
      settings,
      runEphemeral,
      readMessages: createCaptureMessageSource({ listMessages }),
      isUserAuthored,
      getSession: d.getSession,
      isCtoSession: d.isCtoSession,
      now,
      log,
    });
    caps.capture = "on";
  } else caps.capture = off(runEphemeral ? "no transcript reader" : "no model runner");

  // ---- corrections (§5.3): run weekly by the tidy-up (it calls runWeekly itself) --------------------
  if (runEphemeral && d.runDbTask) {
    layerDeps.corrections = createCorrectionDetector({
      state,
      sessionMap,
      budget,
      settings,
      runEphemeral,
      readUserMessages: createUserMessageReader({ state, runDbTask: d.runDbTask, log }),
      isUserAuthored,
      scanner,
      now,
      log,
    });
  }

  // ---- repository writes (§4.1) ------------------------------------------------------------------
  if (d.forge && git) {
    layerDeps.repoWriter = createRepoWriter({
      dir,
      git: createAuthedGit(git, d.resolveToken),
      registry,
      settings,
      state,
      scanner,
      // The real forge in use → ask it how a PR ended (the repo-writer's git-based guess is only the fallback).
      forge: d.forge.getPullRequest || d.forge.findOpenPullRequest !== forgeFindOpenPullRequest ? d.forge : { ...d.forge, getPullRequest: forgeGetPullRequest },
      fireNotify: d.fireNotify,
      remoteUrlFor: d.remoteUrlFor,
      recentDirectories: (slug) =>
        state.db.prepare("SELECT directory FROM session_project WHERE slug = ? AND directory IS NOT NULL GROUP BY directory ORDER BY MAX(pinned_at) DESC LIMIT 10").all(slug).map((r) => r.directory),
      now,
      log,
    });
  }

  // ---- trial + learned skills (§6.6) ---------------------------------------------------------------
  let trial = null;
  if (d.oc?.createSession && d.oc?.sendPrompt && d.oc?.abortSession && d.local?.gitAddWorktree && d.resolveModelForClass && listMessages) {
    trial = createTrial({
      oc: d.oc,
      local: d.local,
      state,
      budget,
      resolveModelForClass: d.resolveModelForClass,
      configGet: d.configGet,
      readResult: createTrialResultReader({ listMessages }),
      isKnowledgeRunActive: ctx.isKnowledgeRunActive,
      now,
      log,
    });
    caps.trial = "on";
  } else caps.trial = off("no session client");
  if (runEphemeral && listMessages) {
    const tombstones = createTombstones({ store, now, log });
    const skills = createSkills({
      state,
      settings,
      sessionMap,
      scanner,
      trial,
      runEphemeral,
      budget,
      reportCost: makeReportCost(budget),
      loadEvidence: evidence.loadEvidence,
      listUserRequests: createUserRequestLister({ listMessages }),
      readToolCalls: createToolCallReader({ listMessages }),
      readMessage: createSingleMessageReader({ listMessages }),
      isUserAuthored,
      lastLoads: d.runDbTask ? createSkillLoadReader({ runDbTask: d.runDbTask, now, log }) : undefined,
      isTombstoned: async ({ key, name, sources }) => {
        const target = `skill:${name?.startsWith("learned-") ? name : `learned-${name}`}`;
        return (await tombstones.match({ kind: "skill", target, claim: name?.startsWith("learned-") ? name : `learned-${name}`, sources })) !== null;
      },
      changesLog: changes,
      skillsDir: d.skillsDir,
      now,
      log,
    });
    layerDeps.skills = skills;
  }

  // ---- blackboard import + live CTO mirror (§5.4, §6.1) ----------------------------------------------
  let blackboard = null;
  let mirror = null;
  if (d.listTmuxProjects) {
    const resolver = createKeyResolver({ listTmuxProjects: d.listTmuxProjects, registry, sessionMap, now });
    blackboard = createBlackboardImport({ state, queue, changesLog: changes, resolver, factsDir: d.factsDir, now, log });
    mirror = createCtoMirror({ resolver, queue, settings, log });
    caps.blackboardImport = "on";
    caps.ctoMirror = "on";
  } else {
    caps.blackboardImport = off("no tmux project list");
    caps.ctoMirror = off("no tmux project list");
  }

  // ---- the ONE weekly summary notification (the curator and the tidy-up send none) ------------------------
  let weekly = null;
  if (d.fireNotify) {
    weekly = createWeeklyNotice({ state, changesLog: changes, settings, fireNotify: d.fireNotify, now, log });
    caps.weeklyNotice = "on";
  } else caps.weeklyNotice = off("no notifier");

  return {
    layerDeps,
    handles: { capture, trial, blackboard, mirror, weekly, skills: layerDeps.skills, corrections: layerDeps.corrections, repoWriter: layerDeps.repoWriter },
    /** Raw opencode events (any `session.*`): capture's activity tracking and the trial's completion. */
    observeRaw(ev) {
      capture?.observeRaw(ev);
      trial?.observeRaw(ev);
    },
    /** One maintenance pass; each step is isolated. */
    async maintain() {
      const steps = [
        ["capture", () => capture?.tick()],
        ["blackboard import", async () => (blackboard && !blackboard.isDone() ? blackboard.run({ budgetMs: 2_000 }) : null)],
        ["weekly notice", () => weekly?.tick()],
      ];
      for (const [name, fn] of steps) {
        try {
          await fn();
        } catch (e) {
          log(`[knowledge] maintenance step "${name}" failed:`, e?.message ?? e);
        }
      }
    },
    /** `cto_fact` → note (fire-and-forget at the call site). */
    mirrorCtoFact: (fact) => (mirror ? mirror.mirrorCtoFact(fact) : Promise.resolve({ enqueued: false, reason: "off" })),
    capabilities: () => ({
      ...caps,
      corrections: layerDeps.corrections ? "on" : off("no model runner or db worker"),
      repoWriter: layerDeps.repoWriter ? "on" : off("no forge"),
      skills: layerDeps.skills ? "on" : off("no model runner"),
    }),
  };
}
