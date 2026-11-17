// integration.mjs — the adapters between the knowledge engine's injected seams and the
// rest of manta-server (spec §4.1, §6.7, §9.2). Pure functions over injected collaborators,
// so each is testable without a live box; index.mjs supplies the real ones.

import { homedir } from "node:os";
import { join } from "node:path";
import { parsePartId } from "../opencodeDb.mjs";

const MSG_REF = /^(msg|part):([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/;

/**
 * `isUserAuthoredRef(ref, {sessionID})` for the note queue and the curator's bars (§9.2): a `msg:`/`part:`
 * ref is user-authored only when
 *   • a `user` origin was recorded for its message at the one prompt chokepoint, AND
 *   • that record belongs to the ref's own session (a record for the same id in another session proves nothing), AND
 *   • opencode's stored message in that session really has role "user" (defense in depth: an assistant
 *     message can never be user-authored, whatever was recorded).
 * A `part:` ref resolves to its message(s). Everything else — no record, a non-message ref, a message from
 * before the upgrade, a lookup that fails — is NOT user-authored (fail closed).
 *
 * @param {{ getRecord(messageID: string): ({origin: string, sessionID: string} | null) }} promptOrigins
 * @param {{ readRole?: (sessionID: string, messageID: string) => Promise<string | null> }} [deps]
 *   `readRole` answers the stored role of a message ("user" | "assistant" | …), null when unknown. Absent → the
 *   role check is skipped (tests of the record rules only); index.mjs always supplies it.
 */
export function createIsUserAuthoredRef(promptOrigins, { readRole } = {}) {
  return async function isUserAuthoredRef(ref) {
    const m = MSG_REF.exec(typeof ref === "string" ? ref.trim() : "");
    if (!m) return false;
    const [, type, sessionID, id] = m;
    const messageIDs = type === "msg" ? [id] : (parsePartId(id)?.messageIds ?? []);
    for (const mid of messageIDs) {
      try {
        const rec = promptOrigins.getRecord(mid);
        if (!rec || rec.origin !== "user" || rec.sessionID !== sessionID) continue;
        if (readRole && (await readRole(sessionID, mid)) !== "user") continue;
        return true;
      } catch {
        /* fail closed for this message */
      }
    }
    return false;
  };
}

/**
 * The `isUserAuthored(messageID, {sessionID?})` seam the capture, correction and skill layers take: the
 * recorded origin is `user` and, when the caller names a session, the record belongs to that session.
 * (Those callers already read the message's role from opencode.)
 */
export function createIsUserAuthored(promptOrigins) {
  return function isUserAuthored(messageID, { sessionID } = {}) {
    try {
      const rec = promptOrigins.getRecord(messageID);
      return !!rec && rec.origin === "user" && (sessionID === undefined || rec.sessionID === sessionID);
    } catch {
      return false;
    }
  };
}

/**
 * The `listMessages(sessionID, opts)` every knowledge reader takes. It FORWARDS `opts` (`{limit}` from capture's
 * bounded reads): a wrapper of the form `(sid) => oc.listMessages(sid)` silently drops them and reads whole transcripts.
 */
export const forwardListMessages = (oc) => (sessionID, opts) => oc.listMessages(sessionID, opts);

/**
 * `isManagedSession(sessionID)` for the session map: true when the session is the child session of a Manta-owned
 * `delegate` job record (any status, any origin Manta completes). Such a session carries its own directory and
 * never inherits its parent's project; a background `task` child (completion owner opencode, or a record only
 * observed) is not managed. A store that can't be read throws, which the session map treats as "unknown" (not mapped).
 *
 * @param {{ loadJobs: () => Promise<object[]>, completionOwnerOf: (job: object) => string }} deps  delegate's own `loadJobs` / `completionOwnerOf`
 */
export function createIsManagedSession({ loadJobs, completionOwnerOf }) {
  return async function isManagedSession(sessionID) {
    if (typeof sessionID !== "string" || sessionID === "") return false;
    const jobs = (await loadJobs()) ?? [];
    return jobs.some((j) => j?.childSessionID === sessionID && j.origin !== "observed" && completionOwnerOf(j) === "manta");
  };
}

/**
 * The two forge seams of the settings (§4.1): `getRepoAccess` and `hasForgeLogin`.
 *
 * @param {object} deps
 * @param {(target: string) => Promise<{ok: boolean, canPush?: boolean, isFork?: boolean, defaultBranch?: string}>} deps.forgeRepoAccess
 * @param {(host: string) => Promise<{token: string} | null>} deps.resolveToken  the box's one forge-credential ladder
 */
export function createForgeAdapters({ forgeRepoAccess, resolveToken }) {
  const defaultHost = (kind) => (kind === "gitlab" ? "gitlab.com" : "github.com");
  return {
    /** `{canPush, isFork, defaultBranch}`; any failure (not connected, rate limit, offline) is `null`. */
    async getRepoAccess({ host, owner, repo } = {}) {
      if (!host || !owner || !repo) return null;
      const r = await forgeRepoAccess(`${host}/${owner}/${repo}`);
      if (!r || r.ok !== true) return null;
      return { canPush: r.canPush === true, isFork: r.isFork === true, defaultBranch: r.defaultBranch };
    },
    /** Whether the box has a credential for the project's forge host (self-hosted hosts included). */
    async hasForgeLogin(kind, host) {
      try {
        return Boolean(await resolveToken(host || defaultHost(kind)));
      } catch {
        return false;
      }
    },
  };
}

/** `bandOf(providerID, modelID)` for pricing an unpriced model: the family's router band, else null. */
export const createBandOf = (describeModel) => (providerID, modelID) => describeModel(providerID, modelID)?.tier ?? null;

/** opencode's config folder: `OPENCODE_CONFIG_DIR` when set, else `~/.config/opencode`. */
export function knowledgeConfigDir({ env = process.env, home } = {}) {
  const dir = typeof env.OPENCODE_CONFIG_DIR === "string" ? env.OPENCODE_CONFIG_DIR.trim() : "";
  return dir || join(home ?? homedir(), ".config", "opencode");
}

/** The two files the knowledge system manages in that folder: the global `AGENTS.md` block and learned skills. */
export function knowledgePaths(opts) {
  const dir = knowledgeConfigDir(opts);
  return { globalAgentsPath: join(dir, "AGENTS.md"), skillsDir: join(dir, "skills") };
}

/**
 * The model runner every knowledge caller (curator, capture, corrections, skills) takes as `runEphemeral`.
 * They pass `{taskClass, operation, context, directory, deps: {reportCost, validate?}}`; this merges in the
 * runner's own collaborators (`oc`, `configGet`) UNDER the caller's, so the caller's hooks win and nothing else
 * has to know how the runner is built.
 *
 * It is also where the shared background budget (spec 2026-11-17-background-work-budget §7.1, §17) is wired:
 *   • `preflight` — asked by `runEphemeral` after it resolved the model and before EVERY dispatch attempt; a refusal
 *     ends the run `{ok:false, code:"budget", reason}` with no model call. It cannot be replaced by a caller.
 *   • real usage — booked on the shared budget after every run (`inLedger:false`: an ephemeral session is deleted,
 *     so the ledger never sees it). A run that could only estimate books its estimate (§17.4).
 * A caller may pass `workType` when the call's work type is not its task class (the weekly tidy-up runs as
 * "curator-rules" but is batch work "knowledge-tidy"); it is not forwarded to the runner.
 *
 * @param {{ runEphemeral: Function, oc: object, configGet: Function, backgroundBudget?: object }} o
 *   `backgroundBudget` absent → every run is refused (`unavailable`): fail closed.
 */
export function createKnowledgeRunner({ runEphemeral, oc, configGet, backgroundBudget = null }) {
  return (args = {}) => {
    const { workType: workTypeArg, ...runArgs } = args;
    const workType = typeof workTypeArg === "string" && workTypeArg ? workTypeArg : runArgs.taskClass;
    const callerCost = runArgs.deps?.reportCost;
    // The runner reports ONE token number (`tokens`) plus, when the ephemeral session recorded its spend, the
    // per-kind `usage` and `usd`. Knowledge callers price per component, so they get the usage object AS `tokens`
    // (and `usd` beside it); with no recorded usage they keep the estimate number.
    const reportCost = async (c) => {
      if (backgroundBudget) {
        await backgroundBudget.record({
          workType,
          model: c?.model ?? null,
          usage: c?.usage ?? c?.tokens,
          ...(typeof c?.usd === "number" ? { usd: c.usd } : {}),
          inLedger: false,
        });
      }
      if (callerCost) await callerCost(c?.usage ? { ...c, tokens: c.usage } : c);
    };
    const preflight = async ({ model } = {}) => {
      const d = backgroundBudget ? await backgroundBudget.check({ workType, model: model ?? null }) : { ok: false, reason: "unavailable" };
      return d?.ok ? { ok: true } : { ok: false, reason: d?.reason ?? "unavailable" };
    };
    return runEphemeral({ ...runArgs, deps: { oc, configGet, ...(runArgs.deps ?? {}), reportCost, preflight } });
  };
}
