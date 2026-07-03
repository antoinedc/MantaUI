import { describe, it, expect } from "vitest";
import {
  repairCorruptDirectory,
  _getForwardAgent,
  discardBody,
} from "./opencode";

// Regression: opencode persists `/home/<user>/~/...` when a session is created
// with a tilde directory — it joins its cwd ($HOME) with the literal `~/...`.
// The resulting path does not exist on disk, so every prompt scoped to it
// hangs. repairCorruptDirectory collapses the `/~/` segment back to a real
// absolute path.
describe("repairCorruptDirectory", () => {
  it("repairs the known /home/<user>/~/ corruption", () => {
    expect(repairCorruptDirectory("/home/dev/~/projects/better-ui")).toBe(
      "/home/dev/projects/better-ui",
    );
  });

  it("repairs corruption regardless of username", () => {
    expect(repairCorruptDirectory("/Users/antoine/~/code/x")).toBe(
      "/Users/antoine/code/x",
    );
  });

  it("leaves a clean absolute path untouched", () => {
    expect(repairCorruptDirectory("/home/dev/projects/better-ui")).toBe(
      "/home/dev/projects/better-ui",
    );
  });

  it("leaves a path with a trailing slash untouched", () => {
    expect(repairCorruptDirectory("/home/dev/projects/")).toBe(
      "/home/dev/projects/",
    );
  });

  it("does not touch a tilde that is not a standalone /~/ segment", () => {
    // A component merely containing ~ is not the corruption shape.
    expect(repairCorruptDirectory("/home/dev/proj~ect/x")).toBe(
      "/home/dev/proj~ect/x",
    );
  });

  it("repairs only the first /~/ segment (corruption produces exactly one)", () => {
    expect(repairCorruptDirectory("/home/dev/~/a/~/b")).toBe(
      "/home/dev/a/~/b",
    );
  });

  it("handles an empty string", () => {
    expect(repairCorruptDirectory("")).toBe("");
  });
});

// BET-65: forwardFetch routes through a shared keep-alive http.Agent so it
// reuses a bounded socket pool instead of opening a fresh 127.0.0.1 socket per
// call (each of which lingered in TIME_WAIT and exhausted the loopback
// ephemeral-port range → EADDRNOTAVAIL). These guard the pool config and the
// body-drain helper that keeps a pooled socket from being pinned open.
describe("forwardFetch connection pool", () => {
  // FORWARD_FETCH_MAX_CONCURRENCY is 16 (the semaphore cap); the pool must stay
  // aligned with it so the two mechanisms don't fight and the pool can't
  // silently outgrow the concurrency ceiling.
  const EXPECTED_MAX = 16;

  it("uses a single module-scope agent instance (referential stability)", () => {
    expect(_getForwardAgent()).toBe(_getForwardAgent());
  });

  it("is keep-alive and capped at the semaphore concurrency (16)", () => {
    const agent = _getForwardAgent();
    expect(agent.keepAlive).toBe(true);
    expect(agent.maxSockets).toBe(EXPECTED_MAX);
    expect(agent.maxFreeSockets).toBe(EXPECTED_MAX);
  });
});

describe("discardBody", () => {
  it("cancels an unread body so the pooled socket is freed", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const res = new Response(body, { status: 500 });
    await discardBody(res);
    expect(cancelled).toBe(true);
  });

  it("is a no-op on a bodyless response (does not throw)", async () => {
    const res = new Response(null, { status: 204 });
    await expect(discardBody(res)).resolves.toBeUndefined();
  });

  it("swallows errors on an already-consumed body", async () => {
    const res = new Response("read me", { status: 500 });
    await res.text(); // consume
    await expect(discardBody(res)).resolves.toBeUndefined();
  });
});
