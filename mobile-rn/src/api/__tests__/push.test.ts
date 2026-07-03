// push.test.ts (api) — the registration scaffold's observable behavior with an
// INJECTED fake expo-notifications provider + fetch, so the whole flow is proven
// WITHOUT a live APNs backend or a device:
//   • permission-denied path,
//   • token-obtained (unconfigured) path — registerPushToken is a no-op,
//   • registerPushToken no-op when unconfigured (no fetch), and POST when
//     configured.

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PUSH_CONFIG,
  registerForPushNotifications,
  registerPushToken,
  type NotificationsProvider,
} from "../push";

/** A fake expo-notifications provider with configurable outcomes. */
function fakeNotifications(opts: {
  existing?: string;
  requested?: string;
  token?: string | (() => never);
}): NotificationsProvider {
  return {
    getPermissionsAsync: async () => ({ status: opts.existing ?? "undetermined" }),
    requestPermissionsAsync: async () => ({ status: opts.requested ?? "denied" }),
    getExpoPushTokenAsync: async () => {
      if (typeof opts.token === "function") opts.token();
      return { data: (opts.token as string) ?? "ExponentPushToken[xyz]" };
    },
  };
}

describe("registerPushToken (the stub/no-op interface)", () => {
  it("is a no-op (no fetch) when the backend is unconfigured", async () => {
    const fetchFn = vi.fn();
    const posted = await registerPushToken("tok", {
      boxId: "box1",
      platform: "ios",
      config: DEFAULT_PUSH_CONFIG,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(posted).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("POSTs the token body when the backend is configured", async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) => ({ ok: true }) as Response,
    );
    const posted = await registerPushToken("tok", {
      boxId: "box1",
      platform: "android",
      config: { endpoint: "https://relay/push" },
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(posted).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://relay/push");
    expect(JSON.parse((init?.body ?? "{}") as string)).toEqual({
      token: "tok",
      boxId: "box1",
      platform: "android",
    });
  });

  it("returns false (not posted) on a transport error", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("offline");
    });
    const posted = await registerPushToken("tok", {
      boxId: "box1",
      platform: "ios",
      config: { endpoint: "https://relay/push" },
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(posted).toBe(false);
  });
});

describe("registerForPushNotifications (full flow, injected deps)", () => {
  it("permission-denied when the OS refuses", async () => {
    const result = await registerForPushNotifications({
      boxId: "box1",
      platform: "ios",
      notifications: fakeNotifications({ existing: "undetermined", requested: "denied" }),
    });
    expect(result).toEqual({ kind: "permission-denied" });
  });

  it("token-obtained → unconfigured (no-op) when granted but no backend", async () => {
    const fetchFn = vi.fn();
    const result = await registerForPushNotifications({
      boxId: "box1",
      platform: "ios",
      notifications: fakeNotifications({ existing: "granted", token: "ExponentPushToken[abc]" }),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({ kind: "unconfigured", token: "ExponentPushToken[abc]" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("registers when granted + token + configured backend", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true }) as Response);
    const result = await registerForPushNotifications({
      boxId: "box1",
      platform: "ios",
      config: { endpoint: "https://relay/push" },
      notifications: fakeNotifications({ existing: "granted", token: "tok" }),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({ kind: "registered", token: "tok" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("requests permission when undetermined, then proceeds on grant", async () => {
    const result = await registerForPushNotifications({
      boxId: "box1",
      platform: "ios",
      notifications: fakeNotifications({
        existing: "undetermined",
        requested: "granted",
        token: "tok",
      }),
    });
    expect(result).toEqual({ kind: "unconfigured", token: "tok" });
  });

  it("errors when granted but no token can be obtained", async () => {
    const result = await registerForPushNotifications({
      boxId: "box1",
      platform: "ios",
      notifications: fakeNotifications({
        existing: "granted",
        token: () => {
          throw new Error("no token");
        },
      }),
    });
    expect(result.kind).toBe("error");
  });
});
