// settings.mjs — the user-controlled Knowledge settings (spec §4).
//
// Stored in `~/.manta/config.json` under `knowledge`, written ONLY by `set()`
// (`knowledge:settings-set`); rpc.mjs strips the key from `config:update`.
//
//   enabled      master switch: capture, curator, briefing, tools
//   (dailyCapUsd is NOT a knowledge setting any more: the daily cap for pay-per-token keys is the one shared
//   background-work setting `backgroundWork.dailyCapUsd`. A patch key `dailyCapUsd` is still accepted and writes
//   that; the settings read mirrors it, so an older desktop's cap input keeps working — spec
//   2026-11-17-background-work-budget §9, §17.18.)
//   repoRules    default "box-only" | "pull-request" | "direct"
//   sharing      default "share-and-read" | "read-only" | "private"
//   observeOnly  hidden (not in the UI, only returned when true): capture + detection only
//   projects     { <slug>: { repoRules?, sharing? } }
//
// Outward repo modes are only effective where the box has a forge login and the
// forge says the user can push and the repo is not a fork (§4.1) — otherwise the
// project behaves as `box-only` and `outwardReason` says why.

import { repoKeyParts } from "../../shared/forge.mjs";
import { KnowledgeError } from "./errors.mjs";
import { SLUG_RE } from "./identity.mjs";
import { createMutex } from "../jsonStore.mjs";
import { readBackgroundWork, validateAndMergeBackgroundWork } from "../backgroundBudget.mjs";

export const REPO_RULES = Object.freeze(["box-only", "pull-request", "direct"]);
export const SHARING = Object.freeze(["share-and-read", "read-only", "private"]);
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  repoRules: "box-only",
  sharing: "share-and-read",
  observeOnly: false,
  projects: Object.freeze({}),
});
const ACCESS_TTL_MS = 10 * 60_000;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isOutward = (v) => v === "pull-request" || v === "direct";

/** Complete settings from whatever is stored (invalid or missing values fall back to defaults). */
export function normalizeSettings(raw) {
  const r = isObj(raw) ? raw : {};
  const projects = {};
  if (isObj(r.projects)) {
    for (const [slug, p] of Object.entries(r.projects)) {
      if (!SLUG_RE.test(slug) || !isObj(p)) continue;
      const entry = {};
      if (REPO_RULES.includes(p.repoRules)) entry.repoRules = p.repoRules;
      if (SHARING.includes(p.sharing)) entry.sharing = p.sharing;
      if (Object.keys(entry).length) projects[slug] = entry;
    }
  }
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_SETTINGS.enabled,
    repoRules: REPO_RULES.includes(r.repoRules) ? r.repoRules : DEFAULT_SETTINGS.repoRules,
    sharing: SHARING.includes(r.sharing) ? r.sharing : DEFAULT_SETTINGS.sharing,
    observeOnly: r.observeOnly === true,
    projects,
  };
}

const bad = (message) => new KnowledgeError("invalid-setting", message, { status: 400 });

/**
 * Validate a `knowledge:settings-set` patch against `current`; returns the next
 * complete settings. Unknown keys/values → 400 `invalid-setting`.
 * `isKnownSlug(slug)` and `outwardCheck(slug)` (→ {allowed, reason}) are injected.
 * `dailyCapUsd` is the legacy cap key: it is validated against the stored `backgroundWork` (`backgroundWork`) and the
 * merged value is handed back in `effects.backgroundWork` for the caller to write — it is not part of the result.
 */
export async function applyPatch(current, patch, { isKnownSlug = () => true, outwardCheck = async () => ({ allowed: true }), backgroundWork, effects = {} } = {}) {
  if (!isObj(patch)) throw bad("The settings patch must be an object.");
  const next = normalizeSettings(current);
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case "enabled":
      case "observeOnly":
        if (typeof value !== "boolean") throw bad(`${key} must be true or false.`);
        next[key] = value;
        break;
      case "dailyCapUsd":
        {
          const merged = validateAndMergeBackgroundWork(backgroundWork, { dailyCapUsd: value });
          if (!merged.ok) throw bad(merged.error);
          effects.backgroundWork = merged.value;
        }
        break;
      case "repoRules":
        if (!REPO_RULES.includes(value)) throw bad(`repoRules must be one of ${REPO_RULES.join(", ")}.`);
        next.repoRules = value;
        break;
      case "sharing":
        if (!SHARING.includes(value)) throw bad(`sharing must be one of ${SHARING.join(", ")}.`);
        next.sharing = value;
        break;
      case "projects": {
        if (!isObj(value)) throw bad("projects must be an object keyed by project slug.");
        for (const [slug, p] of Object.entries(value)) {
          if (!SLUG_RE.test(slug) || !(await isKnownSlug(slug))) throw bad(`Unknown project "${slug}".`);
          if (p === null) {
            delete next.projects[slug];
            continue;
          }
          if (!isObj(p)) throw bad(`projects.${slug} must be an object or null.`);
          const entry = { ...(next.projects[slug] ?? {}) };
          for (const [k, v] of Object.entries(p)) {
            if (k === "repoRules") {
              if (v === null) delete entry.repoRules;
              else if (!REPO_RULES.includes(v)) throw bad(`projects.${slug}.repoRules must be one of ${REPO_RULES.join(", ")}.`);
              else {
                if (isOutward(v)) {
                  const c = await outwardCheck(slug);
                  if (!c.allowed) throw bad(`Repository writes aren't available for this project: ${c.reason}`);
                }
                entry.repoRules = v;
              }
            } else if (k === "sharing") {
              if (v === null) delete entry.sharing;
              else if (!SHARING.includes(v)) throw bad(`projects.${slug}.sharing must be one of ${SHARING.join(", ")}.`);
              else entry.sharing = v;
            } else throw bad(`Unknown project setting "${k}".`);
          }
          if (Object.keys(entry).length) next.projects[slug] = entry;
          else delete next.projects[slug];
        }
        break;
      }
      default:
        throw bad(`Unknown setting "${key}".`);
    }
  }
  return next;
}

/** The effective values for one project: its override, else the default. */
export function effectiveFor(settings, slug) {
  const s = normalizeSettings(settings);
  const o = (slug && s.projects[slug]) || {};
  return {
    enabled: s.enabled,
    observeOnly: s.observeOnly,
    repoRules: o.repoRules ?? s.repoRules,
    sharing: o.sharing ?? s.sharing,
  };
}

/**
 * deps: config {get(), update(patch)}, registry (list/get), getRepoAccess({kind, host, owner, repo}) →
 * {canPush, isFork, defaultBranch}, hasForgeLogin(kind, host) → boolean, now.
 */
export function createSettings({ config, registry, getRepoAccess, hasForgeLogin, now = Date.now } = {}) {
  const accessCache = new Map(); // canonicalId → {at, value}
  const setLock = createMutex();

  async function load() {
    return normalizeSettings((await config.get())?.knowledge);
  }

  /** `{allowed, reason?}` for a project's outward repo modes (§4.1). */
  async function outward(slug) {
    const project = await registry.get(slug);
    if (!project) return { allowed: false, reason: "Unknown project." };
    const parts = repoKeyParts(project.canonicalId);
    if (!parts) return { allowed: false, reason: "Repository writes need a GitHub or GitLab remote." };
    if (!getRepoAccess || !hasForgeLogin) return { allowed: false, reason: "Repository access can't be checked on this box." };
    let login = false;
    try {
      login = (await hasForgeLogin(parts.kind, parts.host)) === true;
    } catch {
      login = false;
    }
    if (!login) return { allowed: false, reason: `No ${parts.kind === "github" ? "GitHub" : "GitLab"} login on this box.` };
    const t = now();
    let hit = accessCache.get(project.canonicalId);
    if (!hit || t - hit.at > ACCESS_TTL_MS) {
      let value = null;
      try {
        value = await getRepoAccess({ kind: parts.kind, host: parts.host, owner: parts.owner, repo: parts.repo });
      } catch {
        value = null;
      }
      hit = { at: t, value };
      // A failed check is not remembered: a flaky network must not keep outward modes off for 10 minutes.
      if (value) accessCache.set(project.canonicalId, hit);
    }
    const a = hit.value;
    if (!a) return { allowed: false, reason: "Couldn't check your access to this repository." };
    if (a.isFork) return { allowed: false, reason: "This repository is a fork." };
    if (!a.canPush) return { allowed: false, reason: "You can't push to this repository." };
    return { allowed: true, defaultBranch: a.defaultBranch };
  }

  return {
    get: load,
    async effective(slug) {
      return effectiveFor(await load(), slug);
    },
    /** The repoRules value that actually applies (outward → box-only when its conditions are gone). */
    async effectiveRepoRules(slug) {
      const e = effectiveFor(await load(), slug);
      if (!isOutward(e.repoRules)) return { repoRules: e.repoRules, reason: null };
      const o = await outward(slug);
      return o.allowed ? { repoRules: e.repoRules, reason: null } : { repoRules: "box-only", reason: o.reason };
    },
    outward,
    // Serialized: load → patch → write is a read-modify-write, so two concurrent patches must not lose an update.
    set: (patch) =>
      setLock.runExclusive(async () => {
        const cfg = await config.get();
        const current = normalizeSettings(cfg?.knowledge);
        const effects = {};
        const next = await applyPatch(current, patch, { isKnownSlug: async (s) => (await registry.get(s)) !== null, outwardCheck: outward, backgroundWork: cfg?.backgroundWork, effects });
        const stored = { ...next };
        if (!stored.observeOnly) delete stored.observeOnly;
        // One write: the knowledge settings and, for the legacy cap key, the shared background-work setting.
        await config.update({ knowledge: stored, ...(effects.backgroundWork ? { backgroundWork: effects.backgroundWork } : {}) });
        return next;
      }),
    /** The `knowledge:settings-get` answer: settings + one row per detected project. */
    async view() {
      const cfg = await config.get();
      const s = normalizeSettings(cfg?.knowledge);
      const rows = [];
      const projects = await registry.list();
      const outs = new Map();
      let i = 0;
      const workers = Array.from({ length: Math.min(4, projects.length) }, async () => {
        while (i < projects.length) {
          const p = projects[i++];
          outs.set(p.slug, await outward(p.slug));
        }
      });
      await Promise.all(workers);
      for (const p of projects.sort((a, b) => a.displayName.localeCompare(b.displayName))) {
        const e = effectiveFor(s, p.slug);
        const o = outs.get(p.slug);
        const row = {
          slug: p.slug,
          displayName: p.displayName,
          canonicalId: p.canonicalId,
          repoRules: e.repoRules,
          sharing: e.sharing,
          repoRulesOverride: s.projects[p.slug]?.repoRules !== undefined,
          sharingOverride: s.projects[p.slug]?.sharing !== undefined,
          outwardAllowed: o.allowed,
        };
        if (!o.allowed) row.outwardReason = o.reason;
        if (isOutward(e.repoRules) && !o.allowed) row.repoRulesEffective = "box-only";
        rows.push(row);
      }
      // `dailyCapUsd` mirrors the shared cap for pay-per-token keys, so an older desktop's card still renders and edits it.
      const out = { enabled: s.enabled, dailyCapUsd: readBackgroundWork(cfg?.backgroundWork).dailyCapUsd, repoRules: s.repoRules, sharing: s.sharing, projects: rows };
      if (s.observeOnly) out.observeOnly = true;
      return out;
    },
  };
}
