export function previewClose(a: {
  project: string;
  windowIndex?: number;
  projects: unknown[];
  cleanOnClose: boolean;
  isRunning: (w: unknown, project: string) => boolean;
}): { title: string; body: string; confirmLabel: string; runningCount: number; worktreeLine: string | null; worktrees: { path: string; willRemove: boolean }[] };
export function closeSession(
  input: {
    project: string;
    windowIndex?: number;
    dirtyWorktree?: "remove" | "keep";
    deleteConversation?: boolean;
    expect?: { opencodeSessionId?: string | null; worktreePath?: string | null };
  },
  deps: {
    listProjects: () => Promise<unknown[]>;
    cleanOnClose: () => Promise<boolean>;
    deleteConversation?: (sessionId: string) => Promise<unknown>;
    removeWorktree: (a: { path: string; force: boolean }) => Promise<unknown>;
    killWindow: (a: { sessionName: string; windowIndex: number }) => Promise<unknown>;
    killSession: (n: string) => Promise<unknown>;
    projectMetaDelete: (n: string) => Promise<unknown>;
    refresh: () => Promise<unknown>;
    warn?: (m: string, e?: unknown) => void;
  },
): Promise<import("../shared/types").SessionCloseResult>;
