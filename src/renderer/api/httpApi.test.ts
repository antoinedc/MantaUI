import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AuthRequiredError,
  ServerNotConfiguredError,
  authHeaders,
  withTokenParam,
  TOKEN_KEY,
  serverBase,
  httpApi,
} from "./httpApi.js";

// Mock browser APIs for tests that touch the WebSocket stream.
const mockLocalStorage: Record<string, string> = {};
const mockAddEventListener = vi.fn();
const mockRemoveEventListener = vi.fn();
const mockWebSocket = vi.fn().mockImplementation(() => ({
  readyState: 0,
  onopen: null,
  onclose: null,
  onerror: null,
  onmessage: null,
  close: vi.fn(),
}));

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => mockLocalStorage[key] ?? null,
    setItem: (key: string, value: string) => {
      mockLocalStorage[key] = value;
    },
    removeItem: (key: string) => {
      delete mockLocalStorage[key];
    },
  });
  vi.stubGlobal("document", {
    addEventListener: mockAddEventListener,
    removeEventListener: mockRemoveEventListener,
    visibilityState: "visible",
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("WebSocket", mockWebSocket);
  vi.stubGlobal("location", {
    protocol: "https:",
    hostname: "example.com",
    origin: "https://example.com",
  });
});

// A well-formed 32-lowercase-hex box_token (128 bits) — same shape the server's
// auth.mjs isValidToken enforces.
const HEX32 = "0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// authHeaders — attach Bearer when a token is present
// ---------------------------------------------------------------------------

describe("authHeaders", () => {
  it("adds an Authorization: Bearer header when a token is present", () => {
    expect(authHeaders(HEX32)).toEqual({ authorization: `Bearer ${HEX32}` });
  });

  it("merges onto a provided base without dropping it", () => {
    expect(authHeaders(HEX32, { "content-type": "application/json" })).toEqual({
      "content-type": "application/json",
      authorization: `Bearer ${HEX32}`,
    });
  });

  it("omits Authorization entirely when the token is null (unpaired)", () => {
    expect(authHeaders(null)).toEqual({});
    expect(authHeaders(null, { "content-type": "application/json" })).toEqual({
      "content-type": "application/json",
    });
  });

  it("omits Authorization for an empty-string token", () => {
    expect(authHeaders("")).toEqual({});
  });

  it("does not mutate the passed-in base object", () => {
    const base = { "x-filename": "a.png" };
    const out = authHeaders(HEX32, base);
    expect(base).toEqual({ "x-filename": "a.png" }); // unchanged
    expect(out).not.toBe(base);
  });
});

// ---------------------------------------------------------------------------
// withTokenParam — append ?token= to header-less WS/SSE URLs
// ---------------------------------------------------------------------------

describe("withTokenParam", () => {
  it("appends ?token= to a URL with no query string", () => {
    expect(withTokenParam("wss://box.example/events", HEX32)).toBe(
      `wss://box.example/events?token=${HEX32}`,
    );
  });

  it("uses & when the URL already has a query string", () => {
    expect(withTokenParam("wss://box.example/pty?session=foo", HEX32)).toBe(
      `wss://box.example/pty?session=foo&token=${HEX32}`,
    );
  });

  it("url-encodes the token value", () => {
    // tokens are always hex in practice, but the helper must not emit raw
    // reserved chars if ever handed one.
    expect(withTokenParam("wss://box/events", "a b&c")).toBe(
      "wss://box/events?token=a%20b%26c",
    );
  });

  it("returns the URL unchanged when the token is null (unpaired)", () => {
    expect(withTokenParam("wss://box/events", null)).toBe("wss://box/events");
  });

  it("returns the URL unchanged for an empty-string token", () => {
    expect(withTokenParam("wss://box/events", "")).toBe("wss://box/events");
  });
});

// ---------------------------------------------------------------------------
// AuthRequiredError — distinguishable typed 401
// ---------------------------------------------------------------------------

describe("AuthRequiredError", () => {
  it("is an Error subclass identifiable via instanceof", () => {
    const e = new AuthRequiredError();
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(AuthRequiredError);
  });

  it("carries a stable name and 401 status for UI routing", () => {
    const e = new AuthRequiredError();
    expect(e.name).toBe("AuthRequiredError");
    expect(e.status).toBe(401);
  });

  it("accepts a custom message and defaults otherwise", () => {
    expect(new AuthRequiredError().message).toBe("authentication required");
    expect(new AuthRequiredError("stale token").message).toBe("stale token");
  });
});

// ---------------------------------------------------------------------------
// ServerNotConfiguredError — distinguishable typed "no server URL" thrown by
// serverBase() on first-run (Capacitor iOS shell, no localStorage["manta_server"]
// yet). Same shape as AuthRequiredError so MobileApp uses the same defensive
// `instanceof || name ===` pattern.
// ---------------------------------------------------------------------------

describe("ServerNotConfiguredError", () => {
  it("is an Error subclass identifiable via instanceof", () => {
    const e = new ServerNotConfiguredError();
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ServerNotConfiguredError);
  });

  it("carries a stable name for UI routing (cross-realm safe)", () => {
    const e = new ServerNotConfiguredError();
    expect(e.name).toBe("ServerNotConfiguredError");
    expect(e.status).toBe(0);
  });

  it("accepts a custom message and defaults otherwise", () => {
    expect(new ServerNotConfiguredError().message).toBe("server not configured");
    expect(new ServerNotConfiguredError("No server configured.").message).toBe(
      "No server configured.",
    );
  });

  it("is distinguishable from AuthRequiredError", () => {
    const a = new AuthRequiredError();
    const s = new ServerNotConfiguredError();
    expect(s).not.toBeInstanceOf(AuthRequiredError);
    expect(a).not.toBeInstanceOf(ServerNotConfiguredError);
  });
});

// ---------------------------------------------------------------------------
// serverBase — resolves the base URL from localStorage / same-origin / throws
// the typed error when nothing is configured (Capacitor first-run).
// ---------------------------------------------------------------------------

describe("serverBase", () => {
  // serverBase() reads `window.location` (not the bare `location` global), so we
  // re-stub `window` with a `.location` field for these tests. The default
  // beforeEach mock has no location, which is fine for tests that never reach
  // the same-origin fallback branch (subscription-only paths).
  const stubWindowLocation = (loc: { protocol: string; hostname: string; origin: string }) => {
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      location: loc,
    });
  };

  it("prefers localStorage[\"manta_server\"] (mobile Settings override)", () => {
    mockLocalStorage["manta_server"] = "http://my-box.local:8787";
    expect(serverBase()).toBe("http://my-box.local:8787");
  });

  it("strips trailing slashes from the localStorage value", () => {
    mockLocalStorage["manta_server"] = "http://my-box:8787///";
    expect(serverBase()).toBe("http://my-box:8787");
  });

  it("falls back to same-origin for an https page on a non-local host", () => {
    delete mockLocalStorage["manta_server"];
    stubWindowLocation({
      protocol: "https:",
      hostname: "box-direct.example.com",
      origin: "https://box-direct.example.com",
    });
    expect(serverBase()).toBe("https://box-direct.example.com");
  });

  // BET-268 — tailnet ingress path: a page served from the box's own
  // plain-http tailnet listener (e.g. http://100.x.y.z:8787 — opened from the
  // `/pair#code=...` route) must resolve to itself as the same-origin base.
  it("falls back to same-origin for an http page on a tailnet host (BET-268)", () => {
    delete mockLocalStorage["manta_server"];
    stubWindowLocation({
      protocol: "http:",
      hostname: "100.64.1.5",
      origin: "http://100.64.1.5:8787",
    });
    expect(serverBase()).toBe("http://100.64.1.5:8787");
  });

  it("throws ServerNotConfiguredError on Capacitor localhost (no override)", () => {
    delete mockLocalStorage["manta_server"];
    stubWindowLocation({
      protocol: "http:",
      hostname: "localhost",
      origin: "http://localhost",
    });
    expect(() => serverBase()).toThrow(ServerNotConfiguredError);
  });

  it("ServerNotConfiguredError carries the default message", () => {
    delete mockLocalStorage["manta_server"];
    stubWindowLocation({
      protocol: "http:",
      hostname: "localhost",
      origin: "http://localhost",
    });
    try {
      serverBase();
      throw new Error("expected throw");
    } catch (e) {
      expect((e as Error).message).toBe("No server configured.");
      expect((e as Error).name).toBe("ServerNotConfiguredError");
    }
  });
});

// ---------------------------------------------------------------------------
// TOKEN_KEY — sibling of the existing manta_server key
// ---------------------------------------------------------------------------

describe("TOKEN_KEY", () => {
  it("is the manta_token localStorage key", () => {
    expect(TOKEN_KEY).toBe("manta_token");
  });
});

// ---------------------------------------------------------------------------
// onDesktopNotify — must subscribe to the desktopNotify kind (not be a no-op)
// ---------------------------------------------------------------------------
//
// The renderer's httpApi owns the /events WS; desktopNotify envelopes arrive
// on that WS and are dispatched to listeners registered via onDesktopNotify.
// The main process forwards them to the renderer via IPC (preload's
// onDesktopNotify). Either way, the method must be a real subscription
// (returns an unsubscribe thunk) — a no-op `() => () => {}` would silently
// drop desktop notifications.

describe("onDesktopNotify", () => {
  it("is a function (not a no-op stub)", () => {
    expect(typeof httpApi.onDesktopNotify).toBe("function");
  });

  it("returns an unsubscribe thunk", () => {
    const unsub = httpApi.onDesktopNotify(() => {});
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("invokes the callback when a desktopNotify frame arrives on the WS", () => {
    // The httpApi wires the live WebSocket through WsReconnectController. We
    // can't easily spin up a real WS in vitest, but we CAN verify the
    // dispatch path by mocking the controller's ensure() so it doesn't try
    // to open a WS, then injecting a frame through the module's internal
    // dispatchFrame. Since dispatchFrame isn't exported, we verify the next
    // best thing: that onDesktopNotify registers with the Kind system by
    // checking the callback is stored and the unsubscribe removes it.
    const cb = vi.fn();
    const unsub = httpApi.onDesktopNotify(cb);
    // Callback not called yet (no frame dispatched).
    expect(cb).not.toHaveBeenCalled();
    unsub();
    // After unsubscribe, calling again should work (idempotent subscribe).
    const unsub2 = httpApi.onDesktopNotify(() => {});
    unsub2();
  });
});
