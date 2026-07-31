import { describe, it, expect, vi } from "vitest";
import {
  VERIFY_PROBE_TEXT,
  VERIFY_DIRECTORY,
  verifyStageLabels,
  verifyOnboarding,
  hasConnectedProvider,
  pickVerifyLabels,
  type VerifyApi,
} from "./onboardingVerify";

function makeApi(over: Partial<VerifyApi> = {}): VerifyApi {
  return {
    opencodeCreateEphemeralSession: vi.fn(async () => ({
      ok: true,
      sessionId: "eph-1",
    })),
    opencodeDeleteSessionRaw: vi.fn(async () => ({ ok: true })),
    opencodePrompt: vi.fn(async () => ({ ok: true })),
    opencodeMessages: vi.fn(async () => []),
    opencodeProviderAuth: vi.fn(async () => ({ action: "status", providers: [] })),
    ...over,
  };
}

// A completed assistant message that appears after the probe prompt. The
// first poll returns [] (baseline + first tick), the second returns the
// completed reply — mirroring the real opencode message timeline.
function messagesSequence() {
  const calls: unknown[][] = [];
  const steps: unknown[] = [[], [{ info: { id: "a1", role: "assistant", time: { completed: 123 } } }]];
  const fn = vi.fn(async (sid: string) => {
    calls.push([sid]);
    return steps[Math.min(calls.length - 1, steps.length - 1)];
  });
  return fn;
}

describe("verifyStageLabels", () => {
  it("builds the three named stages with provider and model", () => {
    expect(verifyStageLabels("Claude", "claude-sonnet-4")).toEqual([
      "Reached opencode on your box",
      "Claude credentials accepted",
      "Getting a reply from claude-sonnet-4",
    ]);
  });

  it("falls back to 'the model' when no model label is supplied", () => {
    expect(verifyStageLabels("Codex")[2]).toBe("Getting a reply from the model");
  });
});

describe("verifyOnboarding", () => {
  it("reports stage progress and deletes the ephemeral session on success", async () => {
    const api = makeApi({ opencodeMessages: messagesSequence() });
    const progress: string[] = [];
    const out = await verifyOnboarding({
      api,
      providerLabel: "Claude",
      modelLabel: "claude-sonnet-4",
      timeoutMs: 5_000,
      pollIntervalMs: 1,
      now: () => 0,
      onProgress: (p) => progress.push(`${p.stage}:${p.status}`),
    });
    expect(out).toEqual({ ok: true });
    expect(progress).toEqual(["0:running", "1:running", "2:running", "2:done"]);
    expect(api.opencodeCreateEphemeralSession).toHaveBeenCalledWith({
      directory: VERIFY_DIRECTORY,
      title: "manta-verify",
    });
    expect(api.opencodePrompt).toHaveBeenCalledWith("eph-1", VERIFY_PROBE_TEXT);
    // The ephemeral session is always deleted.
    expect(api.opencodeDeleteSessionRaw).toHaveBeenCalledWith("eph-1");
  });

  it("fails at stage 0 when opencode is unreachable, and still cleans up", async () => {
    const api = makeApi({
      opencodeCreateEphemeralSession: vi.fn(async () => ({ ok: false, error: "ECONNREFUSED" })),
    });
    const out = await verifyOnboarding({
      api,
      providerLabel: "Claude",
      timeoutMs: 5_000,
      pollIntervalMs: 1,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.failedStage).toBe(0);
      expect(out.message).toContain("ECONNREFUSED");
    }
    // No session was created, so no delete call.
    expect(api.opencodeDeleteSessionRaw).not.toHaveBeenCalled();
  });

  it("fails at stage 1 when the prompt is rejected, and deletes the session", async () => {
    const api = makeApi({
      opencodePrompt: vi.fn(async () => ({ ok: false, error: "unauthorized" })),
    });
    const out = await verifyOnboarding({
      api,
      providerLabel: "Codex",
      timeoutMs: 5_000,
      pollIntervalMs: 1,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.failedStage).toBe(1);
      expect(out.message).toContain("Codex");
    }
    expect(api.opencodeDeleteSessionRaw).toHaveBeenCalledWith("eph-1");
  });

  it("fails at stage 2 on timeout (no reply), and deletes the session", async () => {
    const api = makeApi({ opencodeMessages: vi.fn(async () => []) });
    // now() jumps past the deadline on the first poll so the loop exits fast.
    let t = 0;
    const out = await verifyOnboarding({
      api,
      providerLabel: "Kimi",
      timeoutMs: 1_000,
      pollIntervalMs: 1,
      now: () => (t += 10_000),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.failedStage).toBe(2);
      expect(out.message).toContain("didn't reply");
    }
    expect(api.opencodeDeleteSessionRaw).toHaveBeenCalledWith("eph-1");
  });

  it("does not count a pre-existing assistant message as the reply", async () => {
    // Baseline already has a completed assistant message; the poll returns
    // the SAME message — the verifier must keep waiting (and time out).
    const pre = [{ info: { id: "old", role: "assistant", time: { completed: 1 } } }];
    const api = makeApi({ opencodeMessages: vi.fn(async () => pre) });
    let t = 0;
    const out = await verifyOnboarding({
      api,
      providerLabel: "Claude",
      timeoutMs: 1_000,
      pollIntervalMs: 1,
      now: () => (t += 10_000),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failedStage).toBe(2);
  });
});

describe("hasConnectedProvider", () => {
  it("returns true when at least one provider is connected", async () => {
    const api = makeApi({
      opencodeProviderAuth: vi.fn(async () => ({
        action: "status",
        providers: [{ id: "anthropic", connected: false }, { id: "openai", connected: true }],
      })),
    });
    expect(await hasConnectedProvider(api)).toBe(true);
  });

  it("returns false when nothing is connected", async () => {
    const api = makeApi({
      opencodeProviderAuth: vi.fn(async () => ({
        action: "status",
        providers: [{ id: "anthropic", connected: false }],
      })),
    });
    expect(await hasConnectedProvider(api)).toBe(false);
  });
});

describe("pickVerifyLabels", () => {
  it("returns the first connected provider label + the default model", () => {
    const res = pickVerifyLabels(
      { providers: [{ id: "anthropic", label: "Claude", connected: true }] },
      { providerID: "anthropic", modelID: "claude-sonnet-4" },
    );
    expect(res).toEqual({ providerLabel: "Claude", modelLabel: "claude-sonnet-4" });
  });

  it("returns null when nothing is connected", () => {
    expect(pickVerifyLabels({ providers: [{ connected: false }] })).toBeNull();
  });
});
