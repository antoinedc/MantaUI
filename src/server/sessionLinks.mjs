import { statePath } from "../shared/paths.mjs";
import { createMutex, readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";

/** Durable, single-writer explicit edges. Publish only after the atomic write succeeds. */
export function createSessionLinks({
  path = statePath("session-links.json"),
  load = () => readJsonSync(path, {}),
  save = (v) => writeJsonAtomic(path, JSON.stringify(v)),
  changed = () => {},
  now = Date.now,
} = {}) {
  let entries = load();
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) entries = {};
  entries = Object.fromEntries(Object.entries(entries).filter(([, e]) => e && (e.parent === null || typeof e.parent === "string") && typeof e.by === "string" && Number.isFinite(e.at)));
  let lastAt = Math.max(0, ...Object.values(entries).map((e) => e.at));
  const lock = createMutex();
  const write = async (next) => {
    await save(next);
    entries = next;
    changed();
  };
  const link = ({ child, parent, by }) => lock.runExclusive(() => {
    lastAt = Math.max(now(), lastAt + 1);
    return write({ ...entries, [child]: { parent, by, at: lastAt } });
  });
  return {
    linkOf: (sid) => entries[sid] ? { ...entries[sid] } : undefined,
    endpoints: () => [...new Set(Object.entries(entries).flatMap(([child, e]) => e.parent ? [child, e.parent] : [child]))],
    link,
    unlink: ({ child, by }) => link({ child, parent: null, by }),
    prune: (exists) => lock.runExclusive(async () => {
      const next = {};
      for (const [child, e] of Object.entries(entries)) {
        if (await exists(child) && (e.parent === null || await exists(e.parent))) next[child] = e;
      }
      if (Object.keys(next).length !== Object.keys(entries).length) await write(next);
    }),
  };
}

/** Serialise validation with writes too: opposite simultaneous links cannot both pass the cycle check. */
export function createSessionLinkActions({ store, readSession, sessionStatus }) {
  const lock = createMutex();
  return (input) => lock.runExclusive(async () => {
    const { action, sessionID, target } = input ?? {};
    const fail = (error) => ({ ok: false, error });
    if (!["link", "unlink"].includes(action)) return fail('Use action "link" or "unlink".');
    if (typeof sessionID !== "string" || !sessionID || typeof target !== "string" || !target) return fail("Both sessionID and target are required.");
    if (!await sessionStatus.refreshJobs()) return fail("Couldn't verify the job ownership; try again.");
    if (!await sessionStatus.resolveAncestry(sessionID) || !await sessionStatus.resolveAncestry(target)) return fail("Couldn't verify the session ancestry; try again.");
    const parent = sessionStatus.canonicalSessionOf(sessionID);
    const child = sessionStatus.canonicalSessionOf(target);
    for (const sid of new Set([parent, child])) {
      const rs = await readSession(sid);
      if (rs?.state !== "found") return fail(rs?.state === "missing" ? `Unknown session: ${sid}.` : `Couldn't read session ${sid}; try again.`);
    }
    if (action === "link") {
      if (child === parent) return fail("A conversation cannot be linked to itself.");
      if (sessionStatus.authoritativeParentOf(child)) return fail("This session already has an authoritative parent (a job caller or opencode parent); it cannot be re-linked.");
      if (sessionStatus.ancestorsOf(parent).includes(child)) return fail("This link would create a cycle; choose a different parent.");
      await store.link({ child, parent, by: sessionID });
    } else {
      await store.unlink({ child, by: sessionID });
    }
    return { ok: true };
  });
}
