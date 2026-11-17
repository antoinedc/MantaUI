// tombstones.mjs — what the user undid, so the curator never proposes it again (spec §6.3, §8).
//
// `tombstones.json` is committed to the store (`{version:1, tombstones:[…]}`). An entry's
// decision key is `sha256(kind + target + normalized claim)`. A later decision is dropped when
// it matches an undone one:
//   • by key                         (same kind, same target, same claim);
//   • by correction cluster          (rules and preferences: same `clusterId`);
//   • by source set                  (skills: the new sessions are all inside the undone set).
// The active tombstones for a target are also handed to the model as context, so it stops
// proposing them in the first place; the code check is the bar.

import { createHash } from "node:crypto";

export const TOMBSTONES_PATH = "tombstones.json";
export const MAX_TOMBSTONES = 2000;

const sha = (s) => createHash("sha256").update(s).digest("hex");
export const normClaim = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Decision type → tombstone kind. */
export function kindOf(type) {
  if (type === "rule.add" || type === "rule.change" || type === "rule.remove" || type === "rule") return "rule";
  if (type === "preference.set" || type === "preference") return "preference";
  if (type === "skill.propose" || type === "skill") return "skill";
  return "page";
}

/** A stable string for a decision target. */
export function targetKey(target = {}) {
  return [target.area ?? "", target.slug ?? "", target.path ?? "", target.section ?? ""].join(":");
}

/** `sha256(kind + target + normalized claim)`. */
export function decisionKey({ kind, target, claim }) {
  return sha(`${kind}\n${typeof target === "string" ? target : targetKey(target)}\n${normClaim(claim)}`);
}

/** deps: store (read, withLock), now, log. */
export function createTombstones({ store, now = Date.now, log = console.warn } = {}) {
  async function load(reader = store) {
    const raw = await reader.read(TOMBSTONES_PATH);
    if (!raw) return { version: 1, tombstones: [] };
    try {
      const doc = JSON.parse(raw);
      return { version: 1, tombstones: Array.isArray(doc?.tombstones) ? doc.tombstones : [] };
    } catch {
      log("[knowledge] tombstones.json is not valid JSON; treating it as empty");
      return { version: 1, tombstones: [] };
    }
  }

  const list = async () => (await load()).tombstones;

  /** Active tombstones for a target (the model's context). */
  async function forTarget({ kind, target } = {}) {
    const key = typeof target === "string" ? target : targetKey(target);
    return (await list())
      .filter((t) => (!kind || t.kind === kind) && (t.target === key || kind === "preference" || kind === "rule"))
      .slice(-30)
      .map((t) => ({ kind: t.kind, claim: t.claim, summary: t.summary }));
  }

  /** Active tombstones relevant to one project's curation (its pages, its rules, preferences, shared pages): the model's `undone_before`. */
  async function forProject(slug) {
    return (await list())
      .filter((t) => t.target.startsWith(`project:${slug}:`) || t.target.startsWith("commons:") || t.target.startsWith("user:") || t.kind === "preference")
      .slice(-40)
      .map((t) => ({ kind: t.kind, claim: t.claim, summary: t.summary }));
  }

  /**
   * The tombstone a decision matches, or null. `claim` is the decision's claim text, `clusterId` the
   * (code-attached) correction cluster, `sources` the session ids a skill draws on.
   */
  async function match({ kind, target, claim, clusterId, sources } = {}) {
    const all = await list();
    const key = decisionKey({ kind, target, claim });
    const mine = new Set((sources ?? []).filter(Boolean));
    for (const t of all) {
      if (t.key === key) return t;
      if (clusterId && t.clusterId && t.clusterId === clusterId && (kind === "rule" || kind === "preference") && t.kind === kind) return t;
      if (kind === "skill" && t.kind === "skill" && Array.isArray(t.sources) && mine.size > 0 && [...mine].every((s) => t.sources.includes(s))) return t;
    }
    return null;
  }

  /**
   * Record an undone decision. MUST be called with the store lock held (`tx` from `store.withLock`);
   * one commit. Returns the entry.
   */
  async function add(tx, { kind, target, claim, clusterId = null, sources = null, decisionId = null, summary = "" } = {}) {
    const doc = await load(tx);
    const entry = {
      key: decisionKey({ kind, target, claim }),
      kind,
      target: typeof target === "string" ? target : targetKey(target),
      claim: String(claim ?? "").slice(0, 300),
      ...(clusterId ? { clusterId } : {}),
      ...(sources ? { sources: [...new Set(sources)].sort() } : {}),
      ...(decisionId ? { decisionId } : {}),
      summary: String(summary ?? "").slice(0, 200),
      at: now(),
    };
    if (doc.tombstones.some((t) => t.key === entry.key)) return entry;
    doc.tombstones.push(entry);
    if (doc.tombstones.length > MAX_TOMBSTONES) doc.tombstones.splice(0, doc.tombstones.length - MAX_TOMBSTONES);
    await tx.commit({ path: TOMBSTONES_PATH, content: `${JSON.stringify(doc, null, 2)}\n`, message: `Tombstone: ${entry.summary || entry.claim}`.slice(0, 118), body: "The user undid this; the curator won't propose it again.", trailers: decisionId ? { "Manta-Decision": decisionId } : undefined });
    return entry;
  }

  return { load, list, forTarget, forProject, match, add };
}
