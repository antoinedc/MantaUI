// The three ways the agent screens open a chat with Manta (agent screens spec §2.2, §2.4). Each opens a new-session draft
// in a project, prefilled; nothing is created or sent until the user sends it. Used by the sidebar's "New agent", the
// Fleet page, and the agent profile's "Change via Manta" / "Mention in a chat".

import { useStore } from "./store";

type OpenDraft = { project: string | null; folder: string | null };

function activeProject(): OpenDraft {
  const s = useStore.getState();
  const p = s.activeProjectName ? s.projects.find((x) => x.tmuxSession === s.activeProjectName) : undefined;
  return { project: p?.tmuxSession ?? null, folder: p?.defaultCwd ?? null };
}

/** The open project that owns this folder (its own folder, or where one of its windows sits). */
function projectOwning(folder: string): string | null {
  const p = useStore.getState().projects.find((x) => x.defaultCwd === folder || x.windows.some((w) => w.paneCurrentPath === folder));
  return p?.tmuxSession ?? null;
}

function openDraft({ project, folder }: OpenDraft, input: string): void {
  const s = useStore.getState();
  // No project to put the chat in (nothing open yet): the new-project draft takes the text instead.
  const id = s.createDraft(project ? { projectName: project } : "new-project");
  s.updateDraft(id, { input, ...(project && folder ? { cwd: folder } : {}) });
}

/** "New agent": a chat with Manta in the active project, "Create an agent that " typed. */
export function openNewAgentDraft(): void {
  openDraft(activeProject(), "Create an agent that ");
}

/** "Change via Manta": the same chat, "Change @slug: " typed. */
export function openChangeAgentDraft(slug: string): void {
  openDraft(activeProject(), `Change @${slug}: `);
}

/**
 * "Mention in a chat": a chat with "@slug " typed, in the project that owns `folder` (the agent's first seat's folder),
 * else in the active project — with `folder` as its folder when one is given.
 */
export function openMentionDraft(slug: string, folder: string | null | undefined): void {
  const active = activeProject();
  const owner = folder ? projectOwning(folder) : null;
  openDraft({ project: owner ?? active.project, folder: folder || active.folder }, `@${slug} `);
}
