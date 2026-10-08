// The optimizer plugin ships to EVERY box (sync_opencode_plugins), so what it
// does with the switch at its default matters: it must be OBSERVE-ONLY — report
// what it would trim, never touch the history — until the policy says enabled.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const BIG = "x".repeat(40_000); // ≈10k tokens per tool output

function history() {
  const messages: any[] = [];
  for (let i = 0; i < 30; i++) {
    messages.push({
      info: { sessionID: "ses_test", role: "assistant", time: { created: i, completed: Date.now() } },
      parts: [{ type: "tool", tool: "bash", state: { status: "completed", input: { n: i }, output: BIG } }],
    });
  }
  return messages;
}
const outputs = (ms: any[]) => ms.map((m) => m.parts[0].state.output);

describe("manta-optimizer plugin: default policy is observe-only", () => {
  let reports: any[];
  let policyBody: any;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    reports = [];
    policyBody = null; // null → the policy endpoint is unreachable
    globalThis.fetch = (async (url: any, init: any) => {
      const u = String(url);
      if (u.includes("/api/optimizer/counterfactual")) {
        reports.push(JSON.parse(init.body));
        return new Response("{}", { status: 200 });
      }
      if (u.includes("/api/optimizer/policy")) {
        return policyBody ? new Response(JSON.stringify(policyBody), { status: 200 }) : new Response("{}", { status: 503 });
      }
      return new Response("{}", { status: 404 });
    }) as any;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function transform() {
    const mod = await import("./manta-optimizer");
    const hooks: any = await (mod as any).MantaOptimizerMask({});
    return async (messages: any[]) => {
      await hooks["experimental.chat.messages.transform"]({}, { messages });
      await new Promise((r) => setTimeout(r, 20)); // let the un-awaited reports/refreshes land
    };
  }

  it("a cold policy cache (server not asked yet / unreachable): the history is untouched, the counterfactual is reported as observe", async () => {
    const run = await transform();
    const messages = history();
    const before = outputs(messages);
    await run(messages);
    expect(outputs(messages)).toEqual(before);
    expect(reports).toHaveLength(1);
    expect(reports[0].mode).toBe("observe");
    expect(reports[0].applied).toBe(false);
    expect(reports[0].maskedTokens).toBeGreaterThan(0);
  });

  it("a policy that says enabled:false stays observe-only", async () => {
    policyBody = { enabled: false, maskAfterUses: 12, batchTokens: 20_000, protectTailTokens: 40_000, cacheTtlMs: 300_000, maxTransformParts: 4000, transformBudgetMs: 25 };
    const run = await transform();
    const messages = history();
    const before = outputs(messages);
    await run(messages);
    await run(messages); // the second call sees the fetched policy
    expect(outputs(messages)).toEqual(before);
    expect(reports.every((r) => r.mode === "observe" && r.applied === false)).toBe(true);
  });

  it("only an explicit enabled:true makes it act (control: the same history IS trimmed)", async () => {
    policyBody = { enabled: true, maskAfterUses: 12, batchTokens: 20_000, protectTailTokens: 40_000, placeholderFormat: "[manta: trimmed — {tool} {args}]", cacheTtlMs: 300_000, maxTransformParts: 4000, transformBudgetMs: 25 };
    const run = await transform();
    const messages = history();
    await run(messages); // cold → observe, kicks off the refresh
    expect(reports[0].mode).toBe("observe");
    await run(messages); // warm → act
    expect(outputs(messages).some((o) => o.startsWith("[manta: trimmed"))).toBe(true);
    expect(reports.at(-1).mode).toBe("act");
  });
});
