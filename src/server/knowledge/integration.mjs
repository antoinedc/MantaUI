// integration.mjs — the adapters between the knowledge engine's injected seams and the
// rest of manta-server (spec §4.1, §6.7, §9.2). Pure functions over injected collaborators,
// so each is testable without a live box; index.mjs supplies the real ones.

import { homedir } from "node:os";
import { join } from "node:path";
import { parsePartId } from "../opencodeDb.mjs";

const MSG_REF = /^(msg|part):([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/;

/**
 * `isUserAuthoredRef(ref, {sessionID})` for the note queue (§9.2): a `msg:`/`part:` ref is
 * user-authored only when a `user` origin was recorded for its message at the one prompt
 * chokepoint. A `part:` ref resolves to its message(s). Everything else — no record, a
 * non-message ref, a message from before the upgrade — is NOT user-authored (fail closed).
 *
 * @param {{ isUserAuthored(messageID: string): boolean }} promptOrigins
 */
export function createIsUserAuthoredRef(promptOrigins) {
  return function isUserAuthoredRef(ref) {
    const m = MSG_REF.exec(typeof ref === "string" ? ref.trim() : "");
    if (!m) return false;
    const [, type, , id] = m;
    const messageIDs = type === "msg" ? [id] : (parsePartId(id)?.messageIds ?? []);
    try {
      return messageIDs.some((mid) => promptOrigins.isUserAuthored(mid) === true);
    } catch {
      return false;
    }
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
 * @param {{ runEphemeral: Function, oc: object, configGet: Function }} o
 */
export function createKnowledgeRunner({ runEphemeral, oc, configGet }) {
  return (args = {}) => runEphemeral({ ...args, deps: { oc, configGet, ...(args.deps ?? {}) } });
}
