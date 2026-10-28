export function proposeProjectName(input: { hint?: string; cwd?: string }, taken: Set<string>): string;
export function proposeScratchName(hint: string, takenFolders: Set<string>): { name: string; hint: string | null };
