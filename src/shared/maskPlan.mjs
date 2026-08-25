// maskPlan.mjs — PURE masking decision for the opencode optimizer plugin
// (BET-1344, Optimizer P2.2 "act"). This is the shared, testable copy of the
// decision logic that the plugin at docs/opencode-tools/manta-optimizer-plugin.ts
// INLINES (the plugin lives at ~/.config/opencode/plugins/ and cannot resolve
// this repo, exactly like the boxToken() helper). Keep the two copies in sync —
// each names the other as its source.
//
// PURE: no node:* imports, no Date.now(), no I/O — the clock arrives as an
// injected `now` so every decision is testable without a box. Nothing here
// touches `policy.enabled`: the scan computes the FULL counterfactual (what
// WOULD be trimmed) whether the switch is on or off, so the dashboard's
// observe line does not change shape when the switch flips.
//
// Constants are duplicated from src/shared/optimizerPolicy.mjs (the source of
// truth), matching the held DEFAULT_POLICY shape.

export const PLACEHOLDER_ARGS_MAX = 200;

// A masked part's replaced output always starts with this — it is the
// idempotency marker: a second transform over the same history skips it.
export const PLACEHOLDER_PREFIX = "[manta: trimmed";

export const DEFAULT_PLACEHOLDER_FORMAT =
  "[manta: trimmed — re-run `{tool}` with {args} to see this again]";

// Estimated token count from string length only (O(1), no copy). Never slice
// or concatenate part text during the scan — that would allocate.
export function estTokens(s) {
  return typeof s === "string" ? Math.ceil(s.length / 4) : 0;
}

// Render the placeholder that replaces a trimmed tool's output. Names the tool
// and a truncated digest of its arguments SO THE MODEL CAN RE-RUN IT — a bare
// "[trimmed]" would make the trim silently lossy.
//   {tool} → the tool name (or "tool" when absent)
//   {args} → JSON.stringify(input ?? {}) truncated to PLACEHOLDER_ARGS_MAX with
//            "…" appended when truncated; a JSON.stringify throw (circular) → "{}"
export function renderPlaceholder(tool, input, format) {
  const fmt =
    typeof format === "string" && format.length > 0 ? format : DEFAULT_PLACEHOLDER_FORMAT;
  let args;
  try {
    args = JSON.stringify(input ?? {});
  } catch {
    args = "{}"; // circular input — never let a render throw
  }
  if (typeof args !== "string") args = "{}";
  if (args.length > PLACEHOLDER_ARGS_MAX) {
    args = args.slice(0, PLACEHOLDER_ARGS_MAX) + "…";
  }
  return fmt
    .replaceAll("{tool}", typeof tool === "string" && tool ? tool : "tool")
    .replaceAll("{args}", args);
}

// The maximum `time.completed` over assistant messages in the history; 0 when
// there is no completed assistant turn. The plugin uses this for the prompt-
// cache freshness gate (cacheDead).
export function lastAssistantCompleted(messages) {
  let max = 0;
  for (const m of messages ?? []) {
    if (m?.info?.role !== "assistant") continue;
    const c = m?.info?.time?.completed;
    if (typeof c === "number" && Number.isFinite(c) && c > max) max = c;
  }
  return max;
}

// Total part count across all messages. Used by the bail-out gate.
export function countParts(messages) {
  let n = 0;
  for (const m of messages ?? []) n += m?.parts?.length ?? 0;
  return n;
}

// The zero-allocation eligibility scan. Walks parts newest-first using reverse
// INDEX loops (never `[...x].reverse()`, which copies every message's part
// array on every request), accumulating `tailTokens` and `toolUses` exactly as
// phase 1 did. Returns the FULL counterfactual:
//   { bailed, maskedTokens, maskedParts, eligible }
//   maskedTokens/maskedParts — what WOULD be trimmed, identical whether the
//     policy is enabled or not (this function never reads `policy.enabled`).
//   eligible — the parts to mask when applying: { m, i, tool, output, input }
//     where m/i index into messages[m].parts[i] (original, non-reversed).
//   bailed — "budget" when the wall-clock budget was exceeded mid-scan (only
//     checked when a `budget` is supplied); else null.
// A part is ELIGIBLE when ALL hold:
//   - type === "tool" and state.status === "completed"
//   - tailTokens > policy.protectTailTokens (the tail is protected)
//   - toolUses > policy.maskAfterUses (the newest completed uses are protected)
//   - not a skill part (tool starts with "skill") — never mask
//   - not already a manta placeholder (idempotency)
export function scanEligible(messages, policy, budget) {
  const protectTailTokens = policy.protectTailTokens;
  const maskAfterUses = policy.maskAfterUses;
  let tailTokens = 0;
  let toolUses = 0;
  let maskedTokens = 0;
  let maskedParts = 0;
  let partsSeen = 0;
  const eligible = [];
  // Optional wall-clock abort (the plugin passes `now`; tests may omit budget).
  const t0 = budget ? budget.t0 : 0;
  const budgetMs = budget ? budget.budgetMs : 0;
  const checkEvery = budget && budget.checkEvery > 0 ? budget.checkEvery : 0;
  for (let m = messages.length - 1; m >= 0; m--) {
    const parts = messages[m]?.parts ?? [];
    for (let i = parts.length - 1; i >= 0; i--) {
      partsSeen++;
      if (checkEvery > 0 && partsSeen % checkEvery === 0 && budget.now() - t0 > budgetMs) {
        return { bailed: "budget", maskedTokens, maskedParts, eligible };
      }
      const part = parts[i];
      const isTool = part?.type === "tool";
      const done = part?.state?.status === "completed";
      const out = typeof part?.state?.output === "string" ? part.state.output : "";
      tailTokens += estTokens(out) + estTokens(part?.text);
      if (isTool && done) toolUses++;
      const protectedByTail = tailTokens <= protectTailTokens;
      const protectedByRecency = toolUses <= maskAfterUses;
      const isSkill = typeof part?.tool === "string" && part.tool.startsWith("skill");
      const alreadyPlaceholder = out.startsWith(PLACEHOLDER_PREFIX);
      if (isTool && done && !isSkill && !alreadyPlaceholder && !protectedByTail && !protectedByRecency) {
        maskedTokens += estTokens(out);
        maskedParts++;
        eligible.push({
          m,
          i,
          tool: typeof part?.tool === "string" && part.tool ? part.tool : "tool",
          output: out,
          input: part?.state?.input,
        });
      }
    }
  }
  return { bailed: null, maskedTokens, maskedParts, eligible };
}

// The batch gate (prefix-invalidation coupling). Masking rewrites the prefix
// and invalidates the prompt cache from the edit point on, re-billing the whole
// prefix. Only apply when the reclaimed tokens clear the batch threshold, OR
// the cache is already dead (so rewriting no longer re-bills a live cache).
//   cacheDead = (now - lastAssistantCompletedMs) > cacheTtlMs; a 0/absent
//   lastAssistantCompletedMs means cacheDead is false.
// Returns { apply, cacheDead }.
export function decideApply({
  reclaimable,
  batchTokens,
  lastAssistantCompletedMs,
  cacheTtlMs,
  now,
}) {
  if (reclaimable >= batchTokens) return { apply: true, cacheDead: false };
  const cacheDead =
    lastAssistantCompletedMs > 0 && now - lastAssistantCompletedMs > cacheTtlMs;
  return { apply: cacheDead, cacheDead };
}

// The complete masking decision for one transform. Bail-outs run in order
// before any scan; the budget abort happens mid-scan. `now` is an injected
// clock (zero-arg fn) so the whole plan is pure/testable.
// Returns:
//   bailed — "parts" | "budget" | null
//   apply — whether the batch should be applied (eligible → mask)
//   maskedTokens / maskedParts — the full counterfactual (never gated on enabled)
//   eligible — the parts to mask
//   reclaimable — sum of estTokens(output) over eligible parts (== maskedTokens)
//   lastAssistantCompletedMs / cacheDead — why apply was (not) granted
// On any bail the history is handed on unmodified (apply:false).
export function planMask({ messages, policy, now = Date.now }) {
  if (countParts(messages) > policy.maxTransformParts) {
    return {
      bailed: "parts",
      apply: false,
      maskedTokens: 0,
      maskedParts: 0,
      eligible: [],
      reclaimable: 0,
      cacheDead: false,
      lastAssistantCompletedMs: 0,
    };
  }
  const t0 = now();
  const scan = scanEligible(messages, policy, {
    now,
    t0,
    budgetMs: policy.transformBudgetMs,
    checkEvery: 200,
  });
  if (scan.bailed === "budget") {
    return {
      bailed: "budget",
      apply: false,
      maskedTokens: 0,
      maskedParts: 0,
      eligible: [],
      reclaimable: 0,
      cacheDead: false,
      lastAssistantCompletedMs: 0,
    };
  }
  const lastAssistantCompletedMs = lastAssistantCompleted(messages);
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
  };
}
