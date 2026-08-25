// Tests for src/shared/maskPlan.mjs — the pure masking decision (BET-1344).
// Vitest, like the sibling shared tests: no DOM, no fs, no network. The
// plugin (docs/opencode-tools/manta-optimizer-plugin.ts) inlines a copy of
// this module; the behavior pinned here is what the actuating transform must
// reproduce against a real opencode history.

import { describe, it, expect } from "vitest";
import {
  PLACEHOLDER_ARGS_MAX,
  PLACEHOLDER_PREFIX,
  renderPlaceholder,
  scanEligible,
  planMask,
  estTokens,
} from "./maskPlan.mjs";

const policy = {
  enabled: true,
  maskAfterUses: 12,
  batchTokens: 20_000,
  protectTailTokens: 40_000,
  placeholderFormat:
    "[manta: trimmed — re-run `{tool}` with {args} to see this again]",
  cacheTtlMs: 300_000,
  maxTransformParts: 4_000,
  transformBudgetMs: 25,
};

// Wall-clock for the pure plan: fixed so the cache-freshness gate is deterministic.
const NOW = 1_000_000_000_000;

type TestPart = {
  type: string;
  tool?: string;
  text?: string;
  state?: { status: string; input?: unknown; output: string };
};

function toolPart(tool: string, output: string, input?: unknown): TestPart {
  return { type: "tool", tool, state: { status: "completed", input, output } };
}

function textPart(text: string): TestPart {
  return { type: "text", text };
}

function msg(
  parts: TestPart[],
  opts: { role?: string; created?: number; completed?: number } = {},
) {
  const info: { role: string; time: { created: number; completed?: number } } = {
    role: opts.role ?? "user",
    time: { created: opts.created ?? 0 },
  };
  if (opts.completed !== undefined) info.time.completed = opts.completed;
  return { info, parts };
}

function assistantMsg(completed: number) {
  return msg([], { role: "assistant", completed });
}

describe("scanEligible — eligibility", () => {
  it("never marks a part inside the protected 40k tail as eligible (tail protection)", () => {
    // 13 completed tools, all tiny → tailTokens never exceeds 40k, so every
    // part is tail-protected even though toolUses (13) clears the recency gate.
    const parts = Array.from({ length: 13 }, (_, i) => toolPart(`bash${i}`, "tiny"));
    const messages = [msg(parts)];
    const plan = scanEligible(messages, policy);
    expect(plan.maskedTokens).toBe(0);
    expect(plan.eligible.length).toBe(0);
  });

  it("never marks the newest 12 completed tool uses as eligible (recency protection)", () => {
    // A 50k-token text after 11 small completed tools pushes every tool part
    // outside the tail (>40k), yet all 11 uses are within the newest 12, so
    // each one is recency-protected.
    const parts = [
      ...Array.from({ length: 11 }, (_, i) => toolPart(`bash${i}`, "out")),
      textPart("x".repeat(200_000)), // 50_000 tokens, newest
    ];
    const messages = [msg(parts)];
    const plan = scanEligible(messages, policy);
    expect(plan.eligible.length).toBe(0);
    expect(plan.maskedTokens).toBe(0);
  });

  it("never masks a skill part at any age", () => {
    // skillPart is older than 13 uses and past the tail (>40k tokens newer),
    // so only the isSkill rule keeps it out.
    const parts = [
      toolPart("skill-do-thing", "small", { a: 1 }),
      ...Array.from({ length: 13 }, (_, i) => toolPart(`bash${i}`, `out${i}`)),
      textPart("x".repeat(200_000)),
    ];
    const messages = [msg(parts)];
    const plan = scanEligible(messages, policy);
    expect(plan.eligible.some((e) => e.tool === "skill-do-thing")).toBe(false);
    // the non-skill bash parts ARE eligible — proving skill was the sole blocker
    expect(plan.eligible.some((e) => e.tool.startsWith("bash"))).toBe(true);
  });

  it("never re-masks an already-placeholder part (idempotency)", () => {
    const parts = [
      toolPart("bash-old", "[manta: trimmed — re-run `bash` with {} to see this again]", {}),
      ...Array.from({ length: 13 }, (_, i) => toolPart(`bash${i}`, `out${i}`)),
      textPart("x".repeat(200_000)),
    ];
    const messages = [msg(parts)];
    const plan = scanEligible(messages, policy);
    expect(plan.eligible.some((e) => e.output.startsWith(PLACEHOLDER_PREFIX))).toBe(false);
  });

  it("counterfactual totals are identical whether the policy is enabled or not", () => {
    const parts = [
      toolPart("bash0", "x".repeat(4000)), // 1000 tokens, eligible
      toolPart("bash1", "x".repeat(8000)), // 2000 tokens, eligible
      ...Array.from({ length: 12 }, (_, i) => toolPart(`t${i}`, "out")),
      textPart("x".repeat(200_000)),
    ];
    const messages = [msg(parts)];
    const on = scanEligible(messages, { ...policy, enabled: true });
    const off = scanEligible(messages, { ...policy, enabled: false });
    expect(on.maskedTokens).toBe(off.maskedTokens);
    expect(on.maskedParts).toBe(off.maskedParts);
    expect(on.maskedTokens).toBeGreaterThan(0);
  });
});

describe("planMask — bail-outs and the batch gate", () => {
  // A history with reclaimable = 3000 tokens (< batchTokens) and a recent
  // assistant completion (cache alive). The sole eligible part is bash0.
  function belowThresholdHistory() {
    const parts = [
      toolPart("bash0", "x".repeat(4000)), // after 14 uses + tail: eligible, 1000 tok
      toolPart("bash1", "x".repeat(8000)), // eligible, 2000 tok → reclaimable 3000
      ...Array.from({ length: 13 }, (_, i) => toolPart(`t${i}`, "out")),
      textPart("x".repeat(200_000)), // 50k tokens → tail cleared for the bash parts
    ];
    return [msg(parts), assistantMsg(NOW - 1_000)]; // cache alive (recent completion)
  }

  it("reclaimable < batchTokens and cache alive → apply:false", () => {
    const plan = planMask({ messages: belowThresholdHistory(), policy, now: () => NOW });
    expect(plan.bailed).toBeNull();
    expect(plan.apply).toBe(false);
    expect(plan.cacheDead).toBe(false);
    expect(plan.maskedTokens).toBeGreaterThan(0);
    expect(plan.maskedTokens).toBeLessThan(policy.batchTokens);
  });

  it("reclaimable < batchTokens and cacheDead → apply:true", () => {
    // Same reclaimable, but the assistant turn finished well past the cache TTL.
    const messages = belowThresholdHistory().map((m) =>
      m.info.role === "assistant" ? assistantMsg(NOW - 400_000) : m,
    );
    const plan = planMask({ messages, policy, now: () => NOW });
    expect(plan.bailed).toBeNull();
    expect(plan.cacheDead).toBe(true);
    expect(plan.apply).toBe(true);
  });

  it("reclaimable >= batchTokens and cache alive → apply:true", () => {
    const parts = [
      toolPart("bash0", "x".repeat(100_000)), // 25_000 tokens, eligible
      ...Array.from({ length: 13 }, (_, i) => toolPart(`t${i}`, "out")),
      textPart("x".repeat(200_000)),
    ];
    const messages = [msg(parts), assistantMsg(NOW - 1_000)];
    const plan = planMask({ messages, policy, now: () => NOW });
    expect(plan.bailed).toBeNull();
    expect(plan.apply).toBe(true);
    expect(plan.maskedTokens).toBeGreaterThanOrEqual(policy.batchTokens);
  });

  it("part count above maxTransformParts → {apply:false, bailed:'parts'}", () => {
    const messages = [msg(Array.from({ length: policy.maxTransformParts + 1 }, (_, i) => toolPart(`t${i}`, "out")))];
    const plan = planMask({ messages, policy, now: () => NOW });
    expect(plan.apply).toBe(false);
    expect(plan.bailed).toBe("parts");
  });

  it("bails out on the wall-clock budget during the scan", () => {
    // now reports an already-elapsed time (past the 25ms budget) the moment
    // the scan's first 200-part checkpoint is hit.
    const messages = [msg(Array.from({ length: 1500 }, (_, i) => toolPart(`t${i}`, "out")))];
    const scan = scanEligible(messages, policy, {
      now: () => NOW + 1_000, // over budget
      t0: NOW,
      budgetMs: 25,
      checkEvery: 200,
    });
    expect(scan.bailed).toBe("budget");
  });
});

describe("renderPlaceholder", () => {
  it("names the tool and its arguments in the default format", () => {
    const ph = renderPlaceholder("bash", { echo: "hi" }, policy.placeholderFormat);
    expect(ph).toBe('[manta: trimmed — re-run `bash` with {"echo":"hi"} to see this again]');
    expect(ph.startsWith(PLACEHOLDER_PREFIX)).toBe(true);
  });

  it("falls back to 'tool' when the tool name is absent", () => {
    const ph = renderPlaceholder(undefined, { a: 1 }, policy.placeholderFormat);
    expect(ph).toContain("`tool`");
  });

  it("truncates args at PLACEHOLDER_ARGS_MAX with an ellipsis", () => {
    const big = { payload: "a".repeat(PLACEHOLDER_ARGS_MAX * 3) };
    const ph = renderPlaceholder("bash", big, policy.placeholderFormat);
    expect(ph).toContain("…");
    // the args portion between the markers is exactly 200 + the ellipsis
    const args = ph.slice(
      ph.indexOf("`bash` with ") + "`bash` with ".length,
      ph.indexOf(" to see this again]"),
    );
    expect(args.length).toBe(PLACEHOLDER_ARGS_MAX + 1);
  });

  it("renders '{}' for a circular input instead of throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const ph = renderPlaceholder("bash", circular, policy.placeholderFormat);
    expect(ph).toContain(" with {}");
  });
});

describe("estTokens", () => {
  it("estimates tokens from string length only", () => {
    expect(estTokens("")).toBe(0);
    expect(estTokens("abcd")).toBe(1);
    expect(estTokens("x".repeat(10))).toBe(3); // ceil(10/4)
    expect(estTokens(42)).toBe(0);
    expect(estTokens(null)).toBe(0);
  });
});
