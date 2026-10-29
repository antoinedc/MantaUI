// sessionClose.mjs — the close flow, decided and run on the box (WS11 D6 / audit S10).
//
// `sessions:close-preview` words the confirm dialog; `sessions:close` runs the whole thing — worktree removal
// (non-fatal) → kill → project metadata (project close, non-fatal) → refresh — and reports what happened as
// data (`removed` / `kept` / `failed`, `warnings`, `notice`). Both clients render it; neither orchestrates.
//
// Pure apart from the injected deps.

const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);

const uniquePaths = (windows) => [...new Set((windows ?? []).map((w) => w.worktreePath).filter(Boolean))];

/**
 * The confirm copy and facts for closing one window (`windowIndex` given) or a whole project.
 * @param {{ project: string, windowIndex?: number, projects: object[], cleanOnClose: boolean, isRunning: (w: object, project: string) => boolean }} a
 */
export function previewClose({ project, windowIndex, projects, cleanOnClose, isRunning }) {
  const proj = (projects ?? []).find((p) => p.tmuxSession === project);
  if (windowIndex != null) {
    const w = proj?.windows?.find((x) => x.index === windowIndex);
    const running = Boolean(w && isRunning(w, project));
    const path = w?.worktreePath ?? null;
    const parts = ["Its tmux window will be killed on the server."];
    if (running) parts.push("A turn is currently running and will be stopped.");
    if (path && cleanOnClose) parts.push(`Its worktree at ${path} will be removed.`);
    return {
      title: `Close “${w?.name ?? ""}”?`,
      body: parts.join(" "),
      confirmLabel: "Close session",
      runningCount: running ? 1 : 0,
      worktrees: path ? [{ path, willRemove: cleanOnClose }] : [],
    };
  }
  const windows = proj?.windows ?? [];
  const sessionCount = windows.length;
  const runningCount = windows.filter((w) => isRunning(w, project)).length;
  const paths = uniquePaths(windows);
  const willRemove = cleanOnClose ? paths.length : 0;
  const parts = [
    sessionCount === 0
      ? "Its tmux session will be killed on the server."
      : `All ${sessionCount} tmux ${plural(sessionCount, "window")} will be killed on the server.`,
  ];
  if (runningCount > 0) {
    parts.push(`${runningCount} ${plural(runningCount, "session is", "sessions are")} mid-turn and will be stopped.`);
  }
  if (willRemove > 0) parts.push(`${willRemove} ${plural(willRemove, "worktree")} will be removed.`);
  return {
    title:
      sessionCount === 0
        ? `Close “${project}”?`
        : `Close “${project}” and its ${sessionCount} ${plural(sessionCount, "session")}?`,
    body: parts.join(" "),
    confirmLabel: "Close project",
    runningCount,
    worktrees: paths.map((path) => ({ path, willRemove: cleanOnClose })),
  };
}

const failedMessage = (path) => `Couldn't remove the worktree at ${path} — it was left in place.`;
export const METADATA_WARNING = "The project was closed, but its saved folder setting couldn't be cleared.";
export const CLOSE_FAILED = "Couldn't close it — the server couldn't stop it.";

function keptNotice(kept, { chose }) {
  if (kept.length === 0) return null;
  if (chose) return `Kept worktree at ${kept[0]}`;
  if (kept.length === 1) return `Kept worktree at ${kept[0]} — it has uncommitted changes.`;
  return `Kept ${kept.length} worktrees with uncommitted changes.`;
}

/**
 * Close one window or a project.
 * @param {{ project: string, windowIndex?: number, dirtyWorktree?: "remove"|"keep", deleteConversation?: boolean }} input
 *   `deleteConversation` (single window only) also deletes the window's opencode conversation — iOS's "delete".
 * @param {{
 *   listProjects: () => Promise<object[]>,
 *   cleanOnClose: () => Promise<boolean>,
 *   removeWorktree: (a: {path: string, force: boolean}) => Promise<{removed: boolean, reason?: string}>,
 *   deleteConversation?: (sessionId: string) => Promise<unknown>,
 *   killWindow: (a: {sessionName: string, windowIndex: number}) => Promise<unknown>,
 *   killSession: (name: string) => Promise<unknown>,
 *   projectMetaDelete: (name: string) => Promise<unknown>,
 *   refresh: () => Promise<unknown>,
 *   warn?: (msg: string, err?: unknown) => void,
 * }} d
 */
export async function closeSession(input, d) {
  const warn = d.warn ?? ((m, e) => console.warn(m, e?.message ?? e ?? ""));
  const { project, windowIndex, dirtyWorktree, deleteConversation } = input;
  const single = windowIndex != null;
  const clean = await d.cleanOnClose().catch(() => false);
  const projects = await d.listProjects().catch(() => []);
  const proj = projects.find((p) => p.tmuxSession === project);
  const removed = [];
  const kept = [];
  const failed = [];

  const paths = single
    ? [proj?.windows?.find((w) => w.index === windowIndex)?.worktreePath].filter(Boolean)
    : uniquePaths(proj?.windows);

  const chose = single && dirtyWorktree === "keep";
  if (clean) {
    for (const path of paths) {
      if (chose) {
        kept.push(path);
        continue;
      }
      const force = single && dirtyWorktree === "remove";
      try {
        const res = await d.removeWorktree({ path, force });
        if (res?.removed) removed.push(path);
        else if (res?.reason === "dirty") {
          // A single-window close asks first (nothing has been killed); a project close keeps dirty ones.
          if (single) {
            return {
              ok: false,
              needsConfirm: {
                kind: "worktree-dirty",
                path,
                title: "Uncommitted changes in this worktree",
                body: `${path} has uncommitted changes. Removing the worktree will permanently delete that work.`,
                removeLabel: "Remove worktree",
                keepLabel: "Keep worktree",
              },
            };
          }
          kept.push(path);
        } else {
          warn(`[close] worktree ${path} not removed (${res?.reason ?? "unknown"})`);
          failed.push({ path, message: failedMessage(path) });
        }
      } catch (e) {
        warn(`[close] removing worktree ${path} failed`, e);
        failed.push({ path, message: failedMessage(path) });
      }
    }
  }

  const warnings = failed.map((f) => f.message);
  try {
    const conversation = single && deleteConversation === true
      ? proj?.windows?.find((w) => w.index === windowIndex)?.opencodeSessionId
      : null;
    if (conversation && d.deleteConversation) await d.deleteConversation(conversation);
    if (single) await d.killWindow({ sessionName: project, windowIndex });
    else await d.killSession(project);
  } catch (e) {
    warn(`[close] kill failed for ${project}${single ? `:${windowIndex}` : ""}`, e);
    return { ok: false, error: CLOSE_FAILED };
  }
  if (!single) {
    try {
      await d.projectMetaDelete(project);
    } catch (e) {
      warn(`[close] project metadata for ${project} not cleared`, e);
      warnings.push(METADATA_WARNING);
    }
  }
  try {
    await d.refresh();
  } catch (e) {
    warn("[close] refresh failed", e);
  }
  return { ok: true, removed, kept, failed, warnings, notice: keptNotice(kept, { chose }) };
}
