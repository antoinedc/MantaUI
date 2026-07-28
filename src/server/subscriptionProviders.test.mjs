// Tests for src/server/subscriptionProviders.mjs (BET-308, BET-309).
// Pure logic only — no process spawn, no network, no FS read.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SUBSCRIPTION_PROVIDERS,
  findSubscriptionProvider,
  resolveAuthMethod,
  describeConnectShape,
  subscriptionStatuses,
} from "./subscriptionProviders.mjs";

// Live snapshot of GET /provider/auth on the dev box, copied verbatim from
// BET-308 ("The finding this epic is built on"). Used by the headless-vs-
// browser and index-integrity tests — exact array, not a paraphrase, so
// the resolver is exercised against the real opencode shape.
const OPENAI_METHODS = [
  { type: "oauth", label: "ChatGPT Pro/Plus (browser)" },
  { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
  { type: "api", label: "Manually enter API Key" },
];

// Anthropic: only one OAuth row, no prompts. Trivial happy path.
const ANTHROPIC_METHODS = [
  { type: "oauth", label: "Switch Claude Code account", prompts: [] },
];

// GitHub Copilot-style: an oauth row with a prompts array (multi-step
// device flow). Out of scope for this epic — must be discarded.
const PROMPTS_METHODS = [
  { type: "oauth", label: "Login with GitHub Copilot", prompts: [{ key: "code" }] },
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("SUBSCRIPTION_PROVIDERS", () => {
  it("declares exactly the three providers the epic allows (no more, no less)", () => {
    assert.deepEqual(
      SUBSCRIPTION_PROVIDERS.map((p) => p.id),
      ["anthropic", "openai", "kimi-for-coding"],
    );
  });

  it("preserves the documented openai prefer order: headless first, browser second", () => {
    const openai = findSubscriptionProvider("openai");
    assert.equal(openai.prefer[0].match, "headless");
    assert.equal(openai.prefer[1].match, "chatgpt");
  });

  it("kimi has an empty prefer array — generic API-key path is the only route", () => {
    const kimi = findSubscriptionProvider("kimi-for-coding");
    assert.deepEqual(kimi.prefer, []);
  });
});

describe("findSubscriptionProvider", () => {
  it("returns the registry entry for a known id", () => {
    const p = findSubscriptionProvider("openai");
    assert.equal(p.id, "openai");
    assert.equal(p.label, "Codex");
  });

  it("returns null for an unknown id (mirror of findLauncher)", () => {
    assert.equal(findSubscriptionProvider("nonexistent"), null);
  });
});

// ---------------------------------------------------------------------------
// resolveAuthMethod — selection rules
// ---------------------------------------------------------------------------

describe("resolveAuthMethod", () => {
  it("picks the headless Codex method over the browser variant", () => {
    const openai = findSubscriptionProvider("openai");
    const r = resolveAuthMethod(openai, OPENAI_METHODS);
    assert.ok(r, "should resolve");
    assert.equal(r.index, 1, "headless row sits at index 1");
    assert.equal(r.method.label, "ChatGPT Pro/Plus (headless)");
  });

  it("falls through to chatgpt (browser) when headless is missing", () => {
    const openai = findSubscriptionProvider("openai");
    const noHeadless = OPENAI_METHODS.filter((m) => !/headless/i.test(m.label));
    const r = resolveAuthMethod(openai, noHeadless);
    assert.ok(r);
    assert.equal(r.index, 0);
    assert.equal(r.method.label, "ChatGPT Pro/Plus (browser)");
  });

  it("falls back to the api method when no prefer rule matches", () => {
    const openai = findSubscriptionProvider("openai");
    const onlyApi = [{ type: "api", label: "Manually enter API Key" }];
    const r = resolveAuthMethod(openai, onlyApi);
    assert.ok(r);
    assert.equal(r.index, 0);
    assert.equal(r.method.type, "api");
  });

  it("matches the claude-code-account label for anthropic", () => {
    const anthropic = findSubscriptionProvider("anthropic");
    const r = resolveAuthMethod(anthropic, ANTHROPIC_METHODS);
    assert.ok(r);
    assert.equal(r.index, 0);
    assert.equal(r.method.label, "Switch Claude Code account");
  });

  // The single most important test in this issue (per BET-308). A prompts-
  // bearing method sitting BEFORE the match shifts the FILTERED index; the
  // returned index MUST point at the right entry in the ORIGINAL array,
  // because that is what gets POSTed to opencode. If this test ever passes
  // against a value that doesn't match the corresponding opencode method,
  // hands the user a localhost:1455 URL on the day opencode reorders.
  it("returns the index into the ORIGINAL methods array, not the filtered one", () => {
    const openai = findSubscriptionProvider("openai");
    // Build a methods array where the headless match is at filtered index 0
    // but ORIGINAL index 2 (a prompts-bearing oauth row sits at index 1).
    const methods = [
      OPENAI_METHODS[0],                                          // index 0 — browser
      { type: "oauth", label: "Login with GitHub Copilot", prompts: [{ key: "code" }] }, // index 1 — discarded
      OPENAI_METHODS[1],                                          // index 2 — headless (target)
      OPENAI_METHODS[2],                                          // index 3 — api fallback
    ];
    const r = resolveAuthMethod(openai, methods);
    assert.ok(r, "should still resolve past the discarded row");
    assert.equal(r.index, 2, "must point at original index 2, not filtered 1");
    assert.equal(methods[r.index].label, "ChatGPT Pro/Plus (headless)");
  });

  it("returns null when methods is null", () => {
    assert.equal(resolveAuthMethod(findSubscriptionProvider("openai"), null), null);
  });

  it("returns null when methods is undefined", () => {
    assert.equal(resolveAuthMethod(findSubscriptionProvider("openai"), undefined), null);
  });

  it("returns null when methods is an empty array", () => {
    assert.equal(resolveAuthMethod(findSubscriptionProvider("openai"), []), null);
  });

  it("returns null when every method carries prompts (the GitHub Copilot case)", () => {
    assert.equal(resolveAuthMethod(findSubscriptionProvider("openai"), PROMPTS_METHODS), null);
  });

  it("discards a prompts-bearing oauth row but still resolves past it", () => {
    const openai = findSubscriptionProvider("openai");
    const methods = [...PROMPTS_METHODS, ...OPENAI_METHODS];
    const r = resolveAuthMethod(openai, methods);
    assert.ok(r);
    // Original index of headless in [...PROMPTS_METHODS, ...OPENAI_METHODS]
    // is 1 + 1 = 2 (the Copilot row sits at index 0, then browser at 1,
    // headless at 2).
    assert.equal(r.index, 2);
    assert.equal(r.method.label, "ChatGPT Pro/Plus (headless)");
  });

  it("treats an undefined prefer array as no rules (kimi-style) and falls back to api", () => {
    const entry = {
      id: "kimi-for-coding",
      prefer: [],
      detect: [],
    };
    const r = resolveAuthMethod(entry, [{ type: "api", label: "Manually enter API Key" }]);
    assert.ok(r);
    assert.equal(r.index, 0);
    assert.equal(r.method.type, "api");
  });
});

// ---------------------------------------------------------------------------
// describeConnectShape
// ---------------------------------------------------------------------------

describe("describeConnectShape", () => {
  it("returns 'api-key' when resolved is null", () => {
    assert.equal(describeConnectShape(null, undefined), "api-key");
    assert.equal(describeConnectShape(null, "auto"), "api-key");
    assert.equal(describeConnectShape(null, "code"), "api-key");
  });

  it("returns 'api-key' when the resolved method type is 'api'", () => {
    const r = { index: 0, method: { type: "api", label: "Manually enter API Key" } };
    assert.equal(describeConnectShape(r, undefined), "api-key");
    assert.equal(describeConnectShape(r, "auto"), "api-key");
  });

  it("returns 'oauth-code' when authorize method is 'code'", () => {
    const r = { index: 1, method: { type: "oauth", label: "ChatGPT Pro/Plus (headless)" } };
    assert.equal(describeConnectShape(r, { ok: true, url: "https://example.com", method: "code" }), "oauth-code");
  });

  it("returns 'oauth-auto' for every other oauth case", () => {
    const r = { index: 1, method: { type: "oauth", label: "ChatGPT Pro/Plus (headless)" } };
    assert.equal(describeConnectShape(r, "auto"), "oauth-auto");
    assert.equal(describeConnectShape(r, undefined), "oauth-auto");
    assert.equal(describeConnectShape(r, ""), "oauth-auto");
  });

  // BET-354: anthropic + oauth + empty URL → "claude-login".
  it("returns 'claude-login' when id is anthropic and authorize url is empty (BET-354)", () => {
    const r = { index: 0, method: { type: "oauth", label: "Switch Claude Code account" } };
    // Empty string url (opencode's actual anthropic authorize response)
    assert.equal(describeConnectShape(r, { ok: true, url: "", method: "auto" }, "anthropic"), "claude-login");
    // Undefined / missing url fields — same conclusion
    assert.equal(describeConnectShape(r, { ok: true, url: undefined }, "anthropic"), "claude-login");
    assert.equal(describeConnectShape(r, null, "anthropic"), "claude-login");
  });

  it("does NOT return 'claude-login' when id is NOT anthropic (BET-354)", () => {
    const r = { index: 0, method: { type: "oauth", label: "Some other OAuth" } };
    // Same empty-url response, but a different provider id — fall through to
    // the regular oauth shape, NOT the Claude-specific path.
    assert.equal(describeConnectShape(r, { ok: true, url: "", method: "auto" }, "openai"), "oauth-auto");
    assert.equal(describeConnectShape(r, { ok: true, url: "", method: "auto" }, "kimi-for-coding"), "oauth-auto");
  });

  it("does NOT return 'claude-login' when id is anthropic but the method is 'api' (BET-354)", () => {
    const r = { index: 0, method: { type: "api", label: "Manually enter API Key" } };
    assert.equal(describeConnectShape(r, { ok: true, url: "", method: "auto" }, "anthropic"), "api-key");
  });

  it("does NOT return 'claude-login' when id is anthropic and authorize returns a real URL (BET-354)", () => {
    // Hypothetical future where opencode DOES start returning a URL for
    // anthropic — we should fall through to the standard oauth flow.
    const r = { index: 0, method: { type: "oauth", label: "Switch Claude Code account" } };
    assert.equal(describeConnectShape(r, { ok: true, url: "https://example.com", method: "auto" }, "anthropic"), "oauth-auto");
  });
});

// ---------------------------------------------------------------------------
// subscriptionStatuses
// ---------------------------------------------------------------------------

describe("subscriptionStatuses", () => {
  it("returns one row per registry entry, in registry order", () => {
    const rows = subscriptionStatuses([]);
    assert.deepEqual(
      rows.map((r) => r.id),
      ["anthropic", "openai", "kimi-for-coding"],
    );
  });

  it("marks exactly the connected providers and leaves the others false", () => {
    const rows = subscriptionStatuses(["anthropic", "kimi-for-coding"]);
    assert.equal(rows.find((r) => r.id === "anthropic").connected, true);
    assert.equal(rows.find((r) => r.id === "openai").connected, false);
    assert.equal(rows.find((r) => r.id === "kimi-for-coding").connected, true);
  });

  it("tolerates a non-array connected (defensive — return all-disconnected)", () => {
    const rows = subscriptionStatuses(null);
    assert.equal(rows.every((r) => r.connected === false), true);
    const rows2 = subscriptionStatuses(undefined);
    assert.equal(rows2.every((r) => r.connected === false), true);
  });

  it("carries the human-facing fields the connect card needs", () => {
    const [anthropic, openai, kimi] = subscriptionStatuses([]);
    assert.equal(anthropic.label, "Claude");
    assert.equal(anthropic.plan, "Claude Pro / Max");
    assert.equal(anthropic.console, null);
    assert.equal(typeof anthropic.docs, "string");

    assert.equal(openai.label, "Codex");
    assert.equal(openai.plan, "ChatGPT Plus / Pro");

    assert.equal(kimi.label, "Kimi");
    assert.equal(kimi.plan, "Kimi For Coding");
    assert.equal(kimi.console, "https://www.kimi.com/code/console");
  });
});
