// The V2 side of the sticky-trims machinery: the policy type + fail-open default,
// the adapter that turns what OpenCode V2's `context` hook delivers into the
// planner's normalized units (lib/plan.ts), and the replay of a committed trim map.
//
// WHAT THE `context` HOOK REALLY DELIVERS — the LOWERED shape, observed on
// OpenCode 2.0.30 against a real session (a scripted provider driving `shell`
// tool calls; see "pinned facts" in scripts/opencode-v2/optimizer.test.mjs):
//
//   { id: "msg_…",  role: "user",      content: [{type:"text", text}], metadata: {} }
//   { id: "msg_…",  role: "assistant", content: [{type:"tool-call", id, name, input, providerExecuted}] }
//   {               role: "tool",      content: [{type:"tool-result", id, name,
//                                                  result:{type:"text", value}, providerExecuted}] }
//
//   • IDENTITY = `tool-result.id`, which equals the paired `tool-call.id` and is the
//     SAME on every consecutive request (so a trim keyed on it sticks).
//   • user / assistant messages carry an `id`; the `role:"tool"` message carries
//     NONE — so the boundary key falls back to the tool-result call ids (unique per
//     session), then to a content hash (see messageKey).
//   • No message carries a timestamp: V2 is NEVER "known dead" (lastCompletedMs = 0).
// Only a plain-text tool result can be trimmed; anything else counts as nothing.

import type { Adapted } from "./types.ts";

export interface Policy {
  enabled: boolean;
  maskAfterUses: number;
  batchTokens: number;
  margin: number;
  protectTailTokens: number;
  placeholderFormat: string;
  cacheTtlMs: number;
  maxTransformParts: number;
  transformBudgetMs: number;
}

// DUPLICATED from src/shared/optimizerPolicy.mjs (single source of truth, BET-1343):
// an installed plugin cannot resolve the repo.
export const DEFAULT_POLICY: Readonly<Policy> = Object.freeze({
  enabled: false,
  maskAfterUses: 12,
  batchTokens: 20_000,
  margin: 1.5,
  protectTailTokens: 40_000,
  placeholderFormat: "[manta: trimmed — re-run `{tool}` with {args} to see this again]",
  cacheTtlMs: 300_000,
  maxTransformParts: 4_000,
  transformBudgetMs: 25,
});

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * A stable key for message `m`, equal across consecutive requests while the
 * message is unchanged (it is computed on the UNTOUCHED input, before any trim):
 *   1. its own `id` (user / assistant messages);
 *   2. `tool:` + the call ids of its tool-results (the `role:"tool"` message has no id);
 *   3. an FNV-1a hash of its serialized content.
 */
export function messageKey(m: any): string | null {
  if (typeof m?.id === "string" && m.id !== "") return m.id;
  const parts: any[] = Array.isArray(m?.content) ? m.content : [];
  const ids = parts.filter((p) => p?.type === "tool-result" && typeof p.id === "string" && p.id !== "").map((p) => p.id);
  if (ids.length > 0) return `tool:${ids.join(",")}`;
  try {
    const s = JSON.stringify(m?.content ?? null);
    return typeof s === "string" ? `h:${fnv1a(s)}` : null;
  } catch {
    return null;
  }
}

/** Normalize a lowered V2 history into the planner's units. */
export function adaptV2(messages: any[]): Adapted {
  const list: any[] = Array.isArray(messages) ? messages : [];
  // tool-call inputs by id: the result part carries none, and the placeholder names them
  const inputs = new Map<string, unknown>();
  for (const m of list) {
    if (!Array.isArray(m?.content)) continue;
    for (const p of m.content) if (p?.type === "tool-call" && typeof p.id === "string") inputs.set(p.id, p.input);
  }
  const units: any[] = [];
  let partCount = 0;
  let assistantCount = 0;
  for (let mi = 0; mi < list.length; mi++) {
    const m = list[mi];
    if (m?.role === "assistant") assistantCount++;
    const parts: any[] = Array.isArray(m?.content) ? m.content : [];
    for (const p of parts) {
      partCount++;
      if (p?.type === "tool-result") {
        const r = p.result;
        if (r?.type === "text" && typeof r.value === "string") {
          units.push({
            id: typeof p.id === "string" && p.id !== "" && p.id !== "__proto__" ? p.id : null,
            kind: "tool",
            tool: typeof p.name === "string" && p.name ? p.name : "tool",
            input: inputs.get(p.id), // for the placeholder; its tokens are counted on the tool-call part
            inTok: 0,
            text: r.value,
            msgIndex: mi,
            ref: p,
          });
        } else {
          units.push({ id: null, kind: "text", text: "", msgIndex: mi }); // non-text result: counts nothing
        }
      } else if (p?.type === "tool-call") {
        units.push({ id: null, kind: "text", input: p.input, text: "", msgIndex: mi });
      } else {
        units.push({ id: null, kind: "text", text: typeof p?.text === "string" ? p.text : "", msgIndex: mi });
      }
    }
  }
  return {
    units,
    messageCount: list.length,
    messageKeyAt: (i: number) => messageKey(list[i]),
    partCount,
    assistantCount,
    lastCompletedMs: 0, // V2: no completion times → never "known dead"
  };
}

/**
 * Replace every trimmable tool result whose call id is in the committed `real`
 * map with its STORED text. Two-phase (collect, then assign) so a throw while
 * collecting can never leave the request half-trimmed.
 */
export function applyReal(adapted: Adapted, real: Record<string, string>): number {
  const todo: Array<[any, string]> = [];
  for (const u of adapted.units) {
    if (u.kind === "tool" && u.id !== null && Object.prototype.hasOwnProperty.call(real, u.id) && u.ref) {
      todo.push([u.ref, real[u.id]]);
    }
  }
  for (const [part, text] of todo) part.result = { ...part.result, value: text };
  return todo.length;
}
