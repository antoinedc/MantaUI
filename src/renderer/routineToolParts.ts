// ===== Routine tool parts — recognition (no React, no deps) =====
//
// The transcript draws a COMPLETED `routine_create` / `routine_update` /
// `routine_report` tool call as a card instead of the generic tool card. This
// module only recognises those parts (toolActivity.ts and ToolCall.tsx share
// it, like the handoff tool's `isHandoffToolPart`); the cards live in
// RoutineRunParts.tsx.


const ROUTINE_TOOL_RE = /^(?:manta[_-])?routine[_-](create|update|report)$/i;

/** Which routine tool a transcript tool part is, when it has COMPLETED (the cards replace the generic tool card only then). */
export function routineToolKind(part: { type?: string; tool?: unknown; state?: unknown }): "create" | "update" | "report" | null {
  if (part.type !== "tool") return null;
  const m = ROUTINE_TOOL_RE.exec(String(part.tool ?? ""));
  if (!m) return null;
  const status = (part.state as { status?: string } | undefined)?.status;
  return status === "completed" ? (m[1].toLowerCase() as "create" | "update" | "report") : null;
}

/** The routine id a `routine_create` / `routine_update` tool part names, if recoverable from its metadata / output / input. */
export function routineIdOfToolPart(part: { state?: unknown }): string | null {
  const st = (part.state ?? {}) as {
    metadata?: Record<string, unknown>;
    output?: unknown;
    input?: Record<string, unknown>;
  };
  const meta = st.metadata?.routineId ?? st.metadata?.routine_id ?? st.metadata?.id;
  if (typeof meta === "string" && /^[0-9a-f]{8}$/i.test(meta)) return meta;
  const out = typeof st.output === "string" ? st.output : "";
  const marked = /manta-routine:([0-9a-f]{8})/i.exec(out) ?? /\b(?:routine\s+)?id[:=\s]+`?([0-9a-f]{8})\b/i.exec(out) ?? /\b([0-9a-f]{8})\b/.exec(out);
  if (marked) return marked[1];
  const inId = st.input?.id;
  return typeof inId === "string" && /^[0-9a-f]{8}$/i.test(inId) ? inId : null;
}
