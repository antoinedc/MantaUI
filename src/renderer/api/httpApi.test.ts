import { describe, it, expect } from "vitest";
import {
  AuthRequiredError,
  authHeaders,
  withTokenParam,
  TOKEN_KEY,
} from "./httpApi.js";

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
// TOKEN_KEY — sibling of the existing bui_server key
// ---------------------------------------------------------------------------

describe("TOKEN_KEY", () => {
  it("is the bui_token localStorage key", () => {
    expect(TOKEN_KEY).toBe("bui_token");
  });
});
