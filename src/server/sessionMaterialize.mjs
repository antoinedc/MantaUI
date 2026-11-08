import { stat } from "node:fs/promises";
import { expandTilde } from "../shared/paths.mjs";
import { withSessionLock } from "./delegate.mjs";

const messages = {
  handoff: "A handoff of this conversation is in progress — try again in a moment.",
  "no-project": "No workspace owns this session.",
  "not-found": "This session no longer exists.",
  failed: "Couldn't open this session.",
};

const passThrough = (_sid, fn) => fn();

/**
 * The user typed into a session: a viewer window showing it becomes the user's own (the box never closes it).
 * Awaited before the send is forwarded; a failure is logged and never blocks the send.
 *
 * The decision is never taken from a cached list: the window stamps are read LIVE first (cheap, and no lock), and only
 * a live viewer window of the session's chain takes the exclusions. Those are ordered like `sessions:materialize` and
 * the viewer-window closer — the handoff chain exclusion outer, the session resource lock inner, the canonical identity
 * resolved inside the exclusion after a fresh session list — and the stamps are read live AGAIN right before any restamp.
 */
export async function promoteViewWindows(sessionId, {
  listProjects, stampOwner, chainOf = () => [], canonicalSessionOf = (sid) => sid,
  withChainExclusive = passThrough, sessionLock = withSessionLock, refresh, warn = console.warn,
}) {
  if (typeof sessionId !== "string" || !sessionId) return 0;
  const viewWindows = async () => {
    const ids = new Set([sessionId, ...(chainOf(sessionId) ?? [])].filter((s) => typeof s === "string" && s));
    const found = [];
    for (const p of (await listProjects()) ?? []) {
      for (const w of p.windows ?? []) if (w.owner === "view" && ids.has(w.opencodeSessionId)) found.push({ project: p.tmuxSession, index: w.index });
    }
    return found;
  };
  try {
    if (!(await viewWindows()).length) return 0;
    return await withChainExclusive(sessionId, async () => {
      try {
        await refresh?.();
      } catch (e) {
        warn("[sessions] refresh before promoting a viewer window failed:", e?.message ?? e);
      }
      return sessionLock(canonicalSessionOf(sessionId), async () => {
        let promoted = 0;
        for (const w of await viewWindows()) {
          try {
            await stampOwner(w.project, w.index, "user");
            promoted += 1;
          } catch (e) {
            warn(`[sessions] could not keep the window ${w.project}:${w.index} open after a send:`, e?.message ?? e);
          }
        }
        return promoted;
      });
    });
  } catch (e) {
    warn("[sessions] could not look for viewer windows before a send:", e?.message ?? e);
    return 0;
  }
}

/**
 * The armer behind sessionStatus's `armViewWindow`: a viewer window is armed (stamped `@manta-view-armed`) only if,
 * under the same ordering as the closer (chain exclusion, then the session lock, canonical identity resolved inside),
 * a LIVE read shows that window index is still a viewer window stamped with that session or a member of its chain. A
 * tmux window index can be reused by another window between the decision and the stamp.
 */
export function createViewWindowArmer({
  listProjects, stampViewArmed, refresh,
  chainOf = (sid) => [sid], canonicalSessionOf = (sid) => sid,
  withChainExclusive = passThrough, sessionLock = withSessionLock, warn = console.warn,
}) {
  return async function armViewWindow({ project, windowIndex, sessionId }) {
    return withChainExclusive(sessionId, async () => {
      try {
        await refresh?.();
      } catch (e) {
        warn("[sessions] refresh before arming a viewer window failed:", e?.message ?? e);
      }
      return sessionLock(canonicalSessionOf(sessionId), async () => {
        const w = ((await listProjects()) ?? []).find((p) => p.tmuxSession === project)?.windows?.find((x) => x.index === windowIndex);
        if (!w || w.owner !== "view") return { armed: false, reason: "changed" };
        if (w.opencodeSessionId !== sessionId && !(chainOf(sessionId) ?? []).includes(w.opencodeSessionId)) return { armed: false, reason: "changed" };
        await stampViewArmed(project, windowIndex);
        return { armed: true };
      });
    });
  };
}

/**
 * The closer behind sessionStatus's `closeViewWindow`. Same ordering as `sessions:materialize`: chain exclusion outer,
 * session resource lock inner, canonical identity resolved inside the exclusion after a fresh session list; then the
 * window is read LIVE and killed only if it is STILL a viewer window of that same session, still armed, and the session
 * (any member of its handoff chain) is still not running. Anything unreadable leaves the window open.
 */
export function createViewWindowCloser({
  listProjects, listActiveSessionIds, killWindow, refresh,
  chainOf = (sid) => [sid], canonicalSessionOf = (sid) => sid,
  withChainExclusive = passThrough, sessionLock = withSessionLock, warn = console.warn,
}) {
  return async function closeViewWindow({ project, windowIndex, sessionId }) {
    try {
      return await withChainExclusive(sessionId, async () => {
        try {
          await refresh?.();
        } catch (e) {
          warn("[sessions] refresh before closing a viewer window failed:", e?.message ?? e);
        }
        return sessionLock(canonicalSessionOf(sessionId), async () => {
          const w = ((await listProjects()) ?? []).find((p) => p.tmuxSession === project)?.windows?.find((x) => x.index === windowIndex);
          if (!w || w.owner !== "view" || w.opencodeSessionId !== sessionId) return { closed: false, reason: "changed" };
          if (w.viewArmed !== true) return { closed: false, reason: "unarmed" };
          const active = new Set(await listActiveSessionIds());
          if ([sessionId, ...chainOf(sessionId)].some((sid) => active.has(sid))) return { closed: false, reason: "running" };
          await killWindow({ sessionName: project, windowIndex });
          try {
            await refresh?.();
          } catch (e) {
            warn("[sessions] refresh after closing a viewer window failed:", e?.message ?? e);
          }
          return { closed: true };
        });
      });
    } catch (e) {
      warn(`[sessions] could not close the viewer window ${project}:${windowIndex}:`, e?.message ?? e);
      return { closed: false, reason: "failed" };
    }
  };
}

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
          // Opened to look at a session: the box closes it again once the session has finished, until the
          // user types into it (rpc promotes it to "user").
          await tmux.stampOwner(placement.project, windowIndex, "view");
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
