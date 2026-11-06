import { stat } from "node:fs/promises";
import { expandTilde } from "../shared/paths.mjs";
import { withSessionLock } from "./delegate.mjs";

const messages = {
  handoff: "A handoff of this conversation is in progress — try again in a moment.",
  "no-project": "No workspace owns this session.",
  "not-found": "This session no longer exists.",
  failed: "Couldn't open this session.",
};

/** Expected refusals are values, and all unexpected failures use class-1 copy. */
export async function materializeSession(input, {
  handoff, sessionStatus, tmux, readSession, refresh,
  configGet = async () => ({}),
  directoryExists = async (p) => stat(p).then((s) => s.isDirectory(), () => false),
  sessionLock = withSessionLock,
  warn = console.warn,
}) {
  const sessionId = input?.sessionId;
  const refuse = (reason) => ({ ok: false, reason, message: messages[reason] });
  if (typeof sessionId !== "string" || !sessionId) return refuse("not-found");
  try {
    if (!handoff || !sessionStatus) return refuse("failed");
    return await handoff.withChainExclusive(sessionId, async () => {
      const chain = handoff.chainOf(sessionId);
      if (chain.some((sid) => handoff.hasPendingSend(sid))) return refuse("handoff");
      // A commit may have just restamped the window while the sync snapshot still names its predecessor.
      // Choose the resource-lock key from a fresh session list (through the normal refresh, so the served
      // tree signature and the `sessions.nesting` frame stay consistent), then re-read inside that lock too.
      await refresh();
      const canonical = sessionStatus.canonicalSessionOf(sessionId);
      return sessionLock(canonical, async () => {
        // A fresh tree projection under both exclusions, not the last client snapshot.
        await refresh();
        const projects = await tmux.listProjects();
        const placement = sessionStatus.placementOf(sessionId);
        if (!placement) return refuse("no-project");
        const sid = placement.canonicalSessionId;
        const rs = await readSession(sid);
        if (rs?.state === "missing") return refuse("not-found");
        if (rs?.state !== "found") return refuse("failed");
        const project = projects.find((p) => p.tmuxSession === placement.project);
        const existing = project?.windows?.filter((w) => w.opencodeSessionId === sid).sort((a, b) => a.index - b.index)[0];
        let windowIndex = existing?.index;
        if (windowIndex == null) {
          const config = await configGet();
          const fallback = config?.projects?.find((p) => p.tmuxSession === placement.project)?.defaultCwd;
          let cwd;
          for (const dir of [rs.session?.directory, placement.rootPath, placement.defaultCwd, fallback]) {
            if (dir && await directoryExists(expandTilde(dir))) { cwd = expandTilde(dir); break; }
          }
          if (!cwd) return refuse("failed");
          const made = await tmux.newWindow({ sessionName: placement.project, windowName: rs.session?.title?.trim() || "Session", cwd, chatMode: true, existingSessionId: sid });
          windowIndex = made.windowIndex;
          await tmux.stampOwner(placement.project, windowIndex, "user");
        }
        await refresh();
        return { ok: true, project: placement.project, windowIndex, sessionId: sid };
      });
    });
  } catch (e) {
    warn("[sessions:materialize] opening session failed:", e);
    return refuse("failed");
  }
}
