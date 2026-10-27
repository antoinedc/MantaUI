// The "Manta-internal" session marker. Every server-side creator of a session
// that is NOT meant to be a user-visible window or a background job stamps
// `metadata.manta.internal = true`, so the active-session reconciler
// (delegate.mjs) never adopts such a helper session as an observed job.
//
// The stamp is MERGED into whatever metadata the creator already passes (the CTO
// binding's identity marker must survive untouched).

/** Agents opencode runs its own housekeeping sessions on. */
export const INTERNAL_AGENTS = new Set(["title", "compaction", "summary"]);

/** `metadata` with `manta.internal = true` merged in; the input is never mutated. */
export function withInternalMarker(metadata) {
  const base = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
  const manta = base.manta && typeof base.manta === "object" && !Array.isArray(base.manta) ? base.manta : {};
  return { ...base, manta: { ...manta, internal: true } };
}

/** Is this session record one Manta created for its own purposes (or one of opencode's housekeeping agents)? */
export function isMarkedInternal(session) {
  if (!session || typeof session !== "object") return false;
  if (session.metadata?.manta?.internal === true) return true;
  return typeof session.agent === "string" && INTERNAL_AGENTS.has(session.agent);
}
