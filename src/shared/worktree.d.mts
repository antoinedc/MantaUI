export function deriveWorktree(input: {
  repoRoot: string;
  name: string;
  dirExists: (p: string) => boolean;
  branchExists: (b: string) => boolean;
}): { path: string; branch: string };

export function isWorktreeDirtyError(stderr: string | null | undefined): boolean;
