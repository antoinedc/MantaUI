// The masking decision, as PURE functions over what OpenCode V2 hands the
// `context` hook. Ported from V1 `docs/opencode-plugins/manta-optimizer.ts`
// (itself a copy of src/shared/maskPlan.mjs); the algorithm and every constant
// are unchanged — only the message shape is new.
//
// Two shapes are understood, because both are V2:
//
//   LOWERED (what the `context` hook really delivers, observed on 2.0.30):
//     { role: "user" | "assistant" | "tool", content: Part[] }
//       text         { type:"text", text }
//       tool-call    { type:"tool-call", id, name, input }
//       tool-result  { type:"tool-result", id, name, result:{type:"text", value} }
//   TIMELINE (the typed session timeline the REST reads return):
//     { type:"user", text } | { type:"assistant", content: Part[], time }
//       tool         { type:"tool", name, state:{status:"completed", input, content:[{type:"text", text}]} }
//
// PURE: no Date.now()/I/O; the clock arrives as `now`.

export interface Policy {
  enabled: boolean;
  maskAfterUses: number;
  batchTokens: number;
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
  protectTailTokens: 40_000,
  placeholderFormat: "[manta: trimmed — re-run `{tool}` with {args} to see this again]",
  cacheTtlMs: 300_000,
  maxTransformParts: 4_000,
  transformBudgetMs: 25,
});

const PLACEHOLDER_ARGS_MAX = 200;
export const PLACEHOLDER_PREFIX = "[manta: trimmed";
const DEFAULT_PLACEHOLDER_FORMAT = "[manta: trimmed — re-run `{tool}` with {args} to see this again]";

export const estTokens = (s: unknown): number => (typeof s === "string" ? Math.ceil(s.length / 4) : 0);

export function renderPlaceholder(tool: unknown, input: unknown, format?: unknown): string {
  const fmt = typeof format === "string" && format.length > 0 ? format : DEFAULT_PLACEHOLDER_FORMAT;
  let args: string;
  try {
    args = JSON.stringify(input ?? {});
  } catch {
    args = "{}"; // circular input — never let a render throw
  }
  if (typeof args !== "string") args = "{}";
  if (args.length > PLACEHOLDER_ARGS_MAX) args = args.slice(0, PLACEHOLDER_ARGS_MAX) + "…";
  return fmt
    .replaceAll("{tool}", typeof tool === "string" && tool ? tool : "tool")
    .replaceAll("{args}", args);
}

/** One maskable tool output, plus the means to replace it in place. */
export interface Eligible {
  tool: string;
  input: unknown;
  output: string;
  replace(text: string): void;
}

/** A scan unit: what a part contributes to the tail, and (when a completed tool output) how to mask it. */
interface Unit {
  /** Text this part adds to the protected tail (message text + tool output). */
  tailText: string;
  /** Present only for a COMPLETED tool part. */
  tool?: { name: string; input: unknown; output: string; replace(text: string): void };
}

/** Joined text of a timeline tool part's `state.content` (text blocks only). */
function timelineOutput(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((c: any) => (c?.type === "text" && typeof c.text === "string" ? c.text : "")).join("");
}

/** Walk every part in REVERSE transcript order, yielding scan units. */
function* unitsReversed(messages: any[]): Generator<Unit> {
  // tool-call inputs by id, for the lowered shape (the result part carries no input)
  const inputs = new Map<string, unknown>();
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const p of m.content) if (p?.type === "tool-call" && typeof p.id === "string") inputs.set(p.id, p.input);
  }
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const m = messages[mi];
    const parts: any[] = Array.isArray(m?.content) ? m.content : [];
    if (m?.type === "user" && typeof m.text === "string") yield { tailText: m.text };
    for (let pi = parts.length - 1; pi >= 0; pi--) {
      const p = parts[pi];
      if (p?.type === "tool-result") {
        // LOWERED: only a plain-text result can be masked
        const r = p.result;
        if (r?.type === "text" && typeof r.value === "string") {
          yield {
            tailText: r.value,
            tool: {
              name: typeof p.name === "string" && p.name ? p.name : "tool",
              input: inputs.get(p.id),
              output: r.value,
              replace: (text) => {
                p.result = { ...r, value: text };
              },
            },
          };
        } else yield { tailText: "" };
      } else if (p?.type === "tool" && p.state) {
        // TIMELINE
        const out = timelineOutput(p.state.content);
        yield {
          tailText: out,
          ...(p.state.status === "completed"
            ? {
                tool: {
                  name: typeof p.name === "string" && p.name ? p.name : "tool",
                  input: p.state.input,
                  output: out,
                  replace: (text: string) => {
                    p.state.content = [{ type: "text", text }];
                  },
                },
              }
            : {}),
        };
      } else {
        yield { tailText: typeof p?.text === "string" ? p.text : "" };
      }
    }
  }
}

export function countParts(messages: any[]): number {
  let n = 0;
  for (const m of messages ?? []) n += (Array.isArray(m?.content) ? m.content.length : 0) + (m?.type === "user" ? 1 : 0);
  return n;
}

/** When the last assistant turn finished, if the messages say (timeline shape only). */
export function lastAssistantCompleted(messages: any[]): number {
  let max = 0;
  for (const m of messages ?? []) {
    if (m?.type !== "assistant") continue;
    const c = m?.time?.completed;
    if (typeof c === "number" && Number.isFinite(c) && c > max) max = c;
  }
  return max;
}

interface Scan {
  bailed: "budget" | null;
  maskedTokens: number;
  maskedParts: number;
  eligible: Eligible[];
  maxTailAtMask: number;
}

export function scanEligible(
  messages: any[],
  policy: Policy,
  budget?: { now: () => number; t0: number; budgetMs: number; checkEvery: number },
): Scan {
  let tailTokens = 0;
  let toolUses = 0;
  let maskedTokens = 0;
  let maskedParts = 0;
  let partsSeen = 0;
  let maxTailAtMask = 0;
  const eligible: Eligible[] = [];
  const checkEvery = budget && budget.checkEvery > 0 ? budget.checkEvery : 0;
  for (const unit of unitsReversed(messages)) {
    partsSeen++;
    if (checkEvery > 0 && partsSeen % checkEvery === 0 && budget!.now() - budget!.t0 > budget!.budgetMs) {
      return { bailed: "budget", maskedTokens, maskedParts, eligible, maxTailAtMask };
    }
    const t = unit.tool;
    tailTokens += estTokens(unit.tailText);
    if (t) toolUses++;
    const protectedByTail = tailTokens <= policy.protectTailTokens;
    const protectedByRecency = toolUses <= policy.maskAfterUses;
    if (
      t &&
      !t.name.startsWith("skill") &&
      !t.output.startsWith(PLACEHOLDER_PREFIX) &&
      !protectedByTail &&
      !protectedByRecency
    ) {
      maskedTokens += estTokens(t.output);
      maskedParts++;
      // The spot this mask is inserted rewrites the cache for everything AFTER it —
      // track the largest tail re-warmed by any mask, for the re-warm cost.
      if (tailTokens > maxTailAtMask) maxTailAtMask = tailTokens;
      eligible.push({ tool: t.name, input: t.input, output: t.output, replace: t.replace });
    }
  }
  return { bailed: null, maskedTokens, maskedParts, eligible, maxTailAtMask };
}

export function decideApply(a: {
  reclaimable: number;
  batchTokens: number;
  lastAssistantCompletedMs: number;
  cacheTtlMs: number;
  now: number;
}): { apply: boolean; cacheDead: boolean } {
  if (a.reclaimable >= a.batchTokens) return { apply: true, cacheDead: false };
  const cacheDead = a.lastAssistantCompletedMs > 0 && a.now - a.lastAssistantCompletedMs > a.cacheTtlMs;
  return { apply: cacheDead, cacheDead };
}

export interface Plan {
  bailed: "parts" | "budget" | null;
  apply: boolean;
  cacheDead: boolean;
  lastAssistantCompletedMs: number;
  maskedTokens: number;
  maskedParts: number;
  eligible: Eligible[];
  reclaimable: number;
  rewarmTokens: number;
}

const BAILED: Omit<Plan, "bailed"> = {
  apply: false,
  cacheDead: false,
  lastAssistantCompletedMs: 0,
  maskedTokens: 0,
  maskedParts: 0,
  eligible: [],
  reclaimable: 0,
  rewarmTokens: 0,
};

/**
 * @param lastActivityMs when the session last finished a model step, as the
 *   caller knows it (the lowered shape carries no timestamps); the timeline
 *   shape's own `time.completed` wins when present.
 */
export function planMask(a: { messages: any[]; policy: Policy; now?: () => number; lastActivityMs?: number }): Plan {
  const { messages, policy } = a;
  const now = a.now ?? Date.now;
  if (countParts(messages) > policy.maxTransformParts) return { bailed: "parts", ...BAILED };
  const t0 = now();
  const scan = scanEligible(messages, policy, { now, t0, budgetMs: policy.transformBudgetMs, checkEvery: 200 });
  if (scan.bailed === "budget") return { bailed: "budget", ...BAILED };
  const lastAssistantCompletedMs = lastAssistantCompleted(messages) || a.lastActivityMs || 0;
  const { apply, cacheDead } = decideApply({
    reclaimable: scan.maskedTokens,
    batchTokens: policy.batchTokens,
    lastAssistantCompletedMs,
    cacheTtlMs: policy.cacheTtlMs,
    now: now(),
  });
  return {
    bailed: null,
    apply,
    cacheDead,
    lastAssistantCompletedMs,
    maskedTokens: scan.maskedTokens,
    maskedParts: scan.maskedParts,
    eligible: scan.eligible,
    reclaimable: scan.maskedTokens,
    // A dead cache means that tail was being re-written ANYWAY: no NEW re-warm to charge.
    rewarmTokens: cacheDead ? 0 : scan.maxTailAtMask,
  };
}

/** Replace each eligible tool output with its placeholder, in place; never reorders or deletes parts. */
export function applyMask(eligible: Eligible[], format: string): void {
  for (const e of eligible ?? []) e.replace(renderPlaceholder(e.tool, e.input, format));
}
