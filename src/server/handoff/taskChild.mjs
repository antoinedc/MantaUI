// handoff/taskChild.mjs — which sessions must never hand off into a successor.
//
// A `task` subagent is addressed by its parent through the SESSION ID (the parent resumes it with
// `task({sessionID})`), so a successor would never be spoken to and the original would keep working:
// the sidebar's conversation node would point at an idle session. Pure; shared by the live policy
// (auto trigger + the agent tool) and the one-time repair of links made before the policy existed.

/**
 * Who reports a job's result. Mirrors `completionOwnerOf` in delegate.mjs (kept local so the handoff engine does not
 * import the delegate engine and its dependencies); a test pins the two together.
 */
export const jobCompletionOwner = (job) => job?.completionOwner ?? (job?.origin === "subagent" ? "opencode" : "manta");

/**
 * A *task child*: the session has an opencode parent AND is not the own session of a job record Manta completes
 * (a `delegate` launch or a wrapped command — those are repointed at a handoff commit and keep working).
 * @param {{ session?: { id?: string, parentID?: string } | null, jobs?: any[] | null }} p
 */
export function isTaskChild({ session, jobs }) {
  const parentID = session?.parentID;
  if (typeof parentID !== "string" || !parentID) return false;
  const own = (Array.isArray(jobs) ? jobs : []).some((j) => j?.childSessionID === session.id && jobCompletionOwner(j) === "manta");
  return !own;
}

export const SUBAGENT_HANDOFF_MESSAGE =
  "This session is a subagent: its parent addresses it by this session id, so a handoff would orphan the new session. " +
  "Don't hand off. Finish your task and report back; opencode compacts this session itself if it runs out of room.";
