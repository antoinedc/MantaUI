// sharing.mjs — the sharing matrix (spec §4.2) as pure functions.
//
//   mode             feeds commons/user/global skills   reads commons   its wiki/facts/transcripts
//                                                                       appear in other projects' search
//   share-and-read   yes                                yes             yes
//   read-only        no                                 yes             no
//   private          no                                 no              no
//
// The user wiki is readable by every session. A session with NO mapping is
// `private` for every decision (fail closed). A `private` project also doesn't
// READ other projects' knowledge (cross-project search is the same trust
// boundary as commons): `scope: "all"` collapses to its own project for it.
// Sharing controls what Manta shows and injects; it is not access control.

import { pageArea } from "./pages.mjs";

export const feedsShared = (mode) => mode === "share-and-read";
export const readsCommons = (mode) => mode === "share-and-read" || mode === "read-only";
export const visibleToOthers = (mode) => mode === "share-and-read";

/** The mode that applies when the session has no project (fail closed). */
export const modeOrPrivate = (mode) => mode ?? "private";

/**
 * Project slugs whose wiki, facts and transcripts the caller may see.
 * `scope: "project"` → just the caller's own; `"all"` obeys §4.2.
 */
export function readableProjects({ callerSlug, callerMode, scope = "project", allSlugs = [], modeOf }) {
  const out = new Set();
  if (callerSlug) out.add(callerSlug);
  if (scope !== "all" || !readsCommons(modeOrPrivate(callerMode))) return out;
  for (const s of allSlugs) if (visibleToOthers(modeOf(s))) out.add(s);
  return out;
}

/** May the caller read the page at `rel`? */
export function canReadPage(rel, { callerSlug, callerMode, modeOf }) {
  const a = pageArea(rel);
  if (!a) return false;
  if (a.area === "user") return true;
  if (a.area === "commons") return readsCommons(modeOrPrivate(callerMode));
  if (a.slug === callerSlug) return true;
  return readsCommons(modeOrPrivate(callerMode)) && visibleToOthers(modeOf(a.slug));
}

/** May the caller read a transcript of a session mapped to `sessionSlug` (null → unmapped → never)? */
export function canReadSessionOf(sessionSlug, { callerSlug, callerMode, modeOf }) {
  if (!sessionSlug) return false;
  if (sessionSlug === callerSlug) return true;
  return readsCommons(modeOrPrivate(callerMode)) && visibleToOthers(modeOf(sessionSlug));
}
