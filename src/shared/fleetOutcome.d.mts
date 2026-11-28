export function outcomeOfJob(job: { status?: string; error?: unknown; endReason?: unknown; endedBlocked?: unknown } | null | undefined): "done" | "didnt-finish" | "interrupted" | "stopped";
