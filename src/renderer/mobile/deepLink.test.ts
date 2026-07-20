import { describe, it, expect, vi } from "vitest";
import {
  getCapacitorApp,
  handlePairUrl,
  type DeepLinkDeps,
} from "./deepLink";
import { boxDirectUrl } from "../../shared/transport.mjs";
import type { ClaimOutcome } from "../../shared/claim.mjs";

// A canonical box-form URL the desktop Settings QR + `bui pair` terminal QR
// both emit. Round-trips through parsePairPayload so we know the deep-link
// handler is the only moving part under test.
const BOX = "0123456789abcdef0123456789abcdef"; // 32 hex
const BOX_URL = `manta://pair?box=${BOX}&code=847291`;
const DIRECT_URL = "manta://pair?server=http://box:8787&code=123456";

// A typed factory so each test can mutate just one field without rebuilding
// the full outcome shape. Returns a successful outcome by default — tests
// that want a failure override `outcome.ok = false`.
function okOutcome(): ClaimOutcome {
  return { ok: true, boxToken: "11112222333344445555666677778899", boxId: BOX };
}

function failOutcome(): ClaimOutcome {
  return { ok: false, kind: "wrong_code", message: "wrong code" };
}

// A minimal deps stub that records calls + lets each test override authClaim
// or persistServer per case. Default impl: claim succeeds, persist writes
// the resolved URL.
function makeDeps(overrides: Partial<DeepLinkDeps> = {}): DeepLinkDeps & {
  authClaimCalls: Array<{ serverUrl: string; code: string }>;
  persistCalls: string[];
} {
  const authClaimCalls: Array<{ serverUrl: string; code: string }> = [];
  const persistCalls: string[] = [];
  return {
    authClaimCalls,
    persistCalls,
    authClaim: overrides.authClaim ?? (async (input) => {
      authClaimCalls.push(input);
      return okOutcome();
    }),
    persistServer: overrides.persistServer ?? ((u) => {
      persistCalls.push(u);
    }),
  };
}

describe("getCapacitorApp", () => {
  it("returns the plugin handle when window.Capacitor.Plugins.App is present", () => {
    const plugin: unknown = {
      addListener: () => ({ remove: async () => {} }),
      getLaunchUrl: async () => ({ url: BOX_URL }),
    };
    const win = { Capacitor: { Plugins: { App: plugin } } };
    expect(getCapacitorApp(win)).toBe(plugin);
  });

  it("returns null on a plain browser window (no Capacitor bridge)", () => {
    expect(getCapacitorApp({})).toBeNull();
    expect(getCapacitorApp({ Capacitor: {} })).toBeNull();
    expect(getCapacitorApp({ Capacitor: { Plugins: {} } })).toBeNull();
  });

  it("returns null when the plugin is missing the required methods", () => {
    // Partial / mocked Capacitor App plugin — guard against an API drift.
    expect(getCapacitorApp({ Capacitor: { Plugins: { App: {} } } })).toBeNull();
    expect(
      getCapacitorApp({
        Capacitor: { Plugins: { App: { addListener: () => {} } } },
      }),
    ).toBeNull();
    expect(
      getCapacitorApp({
        Capacitor: { Plugins: { App: { getLaunchUrl: () => {} } } },
      }),
    ).toBeNull();
  });

  it("returns null on null / undefined / non-object windows", () => {
    expect(getCapacitorApp(null)).toBeNull();
    expect(getCapacitorApp(undefined)).toBeNull();
    expect(getCapacitorApp(42 as unknown)).toBeNull();
  });
});

describe("handlePairUrl — ignored / foreign / malformed", () => {
  it("returns 'ignored' on a non-manta URL (no claim, no persist)", async () => {
    const deps = makeDeps();
    const out = await handlePairUrl("https://example.com/something", deps);
    expect(out).toBe("ignored");
    expect(deps.authClaimCalls).toEqual([]);
    expect(deps.persistCalls).toEqual([]);
  });

  it("returns 'ignored' on a manta:// URL that fails parsePairPayload", async () => {
    const deps = makeDeps();
    // wrong host segment → parsePairPayload returns null
    const out = await handlePairUrl(
      "manta://connect?server=http://box:8787&code=123456",
      deps,
    );
    expect(out).toBe("ignored");
    expect(deps.authClaimCalls).toEqual([]);
    expect(deps.persistCalls).toEqual([]);
  });

  it("returns 'ignored' on a plain text payload", async () => {
    const deps = makeDeps();
    const out = await handlePairUrl("hello world", deps);
    expect(out).toBe("ignored");
    expect(deps.authClaimCalls).toEqual([]);
  });
});

describe("handlePairUrl — box form (direct hostname, BET-198)", () => {
  it("claims via authClaim with boxDirectUrl(boxId), then persists the same URL", async () => {
    const deps = makeDeps();
    const out = await handlePairUrl(BOX_URL, deps);
    expect(out).toBe("paired");
    // The claim URL is exactly boxDirectUrl(boxId) — single source of truth
    // shared with the desktop PairStep and the manual setup screen. The
    // body sent by httpApi.claimAgainst is `{pairing_code}` (sanity-checked
    // by the httpApi suite; this test pins the URL here).
    expect(deps.authClaimCalls).toEqual([
      { serverUrl: boxDirectUrl(BOX), code: "847291" },
    ]);
    expect(deps.persistCalls).toEqual([boxDirectUrl(BOX)]);
  });

  it("returns 'failed' when authClaim rejects with a classified failure (no persist)", async () => {
    const deps = makeDeps({
      authClaim: async () => failOutcome(),
    });
    const out = await handlePairUrl(BOX_URL, deps);
    expect(out).toBe("failed");
    expect(deps.persistCalls).toEqual([]);
  });

  it("returns 'failed' when authClaim throws unexpectedly", async () => {
    // The shared classifier never throws — defend against a buggy impl.
    const deps = makeDeps({
      authClaim: async () => {
        throw new Error("network blew up");
      },
    });
    const out = await handlePairUrl(BOX_URL, deps);
    expect(out).toBe("failed");
    expect(deps.persistCalls).toEqual([]);
  });
});

describe("handlePairUrl — direct form (serverUrl)", () => {
  it("claims via authClaim with serverUrl, then persists the payload's serverUrl", async () => {
    const deps = makeDeps();
    const out = await handlePairUrl(DIRECT_URL, deps);
    expect(out).toBe("paired");
    expect(deps.authClaimCalls).toEqual([
      { serverUrl: "http://box:8787", code: "123456" },
    ]);
    expect(deps.persistCalls).toEqual(["http://box:8787"]);
  });

  it("returns 'failed' on a classified failure (no persist)", async () => {
    const deps = makeDeps({
      authClaim: async () => failOutcome(),
    });
    const out = await handlePairUrl(DIRECT_URL, deps);
    expect(out).toBe("failed");
    expect(deps.persistCalls).toEqual([]);
  });
});

describe("handlePairUrl — claim wiring sanity", () => {
  it("never calls authClaim for ignored/foreign URLs (defends the box's rate limit)", async () => {
    // A foreign URL must NEVER reach the box's /auth/claim — the endpoint is
    // rate-limited (src/server/auth.mjs) and we don't want spam pairs to count
    // against the user's quota.
    const authClaim = vi.fn(async () => okOutcome());
    const deps = makeDeps({ authClaim });
    await handlePairUrl("https://google.com/", deps);
    await handlePairUrl("not even a url", deps);
    await handlePairUrl("manta://connect?x=1", deps);
    expect(authClaim.mock.calls.length).toBe(0);
  });
});
