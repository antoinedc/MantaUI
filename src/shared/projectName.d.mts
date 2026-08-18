export function generateProjectName(rand?: () => number): string;

export function slugifyProjectName(input: string | null | undefined): string;

export function projectDirFor(root: string, name: string): string;

export function deriveProjectName(cwd: string | null | undefined): string;

export function uniqueSessionName(base: string, taken: Set<string>): string;

export function promptWindowName(input: string | null | undefined): string;
