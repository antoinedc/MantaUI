import { describe, it, expect } from "vitest";
import {
  DEFAULT_POLICY,
  MASK_AFTER_TOOL_USES,
  MIN_BATCH_TOKENS,
  PROTECT_TAIL_TOKENS,
  resolvePolicy,
  validateRepoTable,
  optimizerCacheTtlMs,
} from "./optimizerPolicy.mjs";

describe("DEFAULT_POLICY", () => {
  it("is fail-open (enabled: false)", () => {
    expect(DEFAULT_POLICY.enabled).toBe(false);
  });
});

describe("resolvePolicy — global config", () => {
  it("optimizerEnabled: true → enabled:true", () => {
    const p = resolvePolicy({ config: { optimizerEnabled: true } });
    expect(p.enabled).toBe(true);
  });

  it("strict: 'true', 1, and undefined → enabled:false", () => {
    expect(resolvePolicy({ config: { optimizerEnabled: "true" } }).enabled).toBe(false);
    expect(resolvePolicy({ config: { optimizerEnabled: 1 } }).enabled).toBe(false);
    expect(resolvePolicy({ config: {} }).enabled).toBe(false);
    expect(resolvePolicy({ config: undefined }).enabled).toBe(false);
  });
});

describe("resolvePolicy — per-repo tuner table", () => {
  it("a repo entry overrides maskAfterUses only; other fields keep defaults", () => {
    const p = resolvePolicy({
      config: {},
      repoTable: { repos: { "/repo": { maskAfterUses: 4 } } },
      directory: "/repo",
    });
    expect(p.maskAfterUses).toBe(4);
    expect(p.batchTokens).toBe(MIN_BATCH_TOKENS);
    expect(p.protectTailTokens).toBe(PROTECT_TAIL_TOKENS);
    expect(p.enabled).toBe(false);
  });

  it("an unknown key in a repo entry is dropped, not merged", () => {
    // `placeholderFormat` is not a tuner key — feeding it (as a malformed raw
    // table would) must be ignored, never merged into the policy.
    const p = resolvePolicy({
      config: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repoTable: { repos: { "/repo": { maskAfterUses: 3, placeholderFormat: "HACKED" } } } as any,
      directory: "/repo",
    });
    expect(p.maskAfterUses).toBe(3);
    expect(p.placeholderFormat).toBe(DEFAULT_POLICY.placeholderFormat);
  });

  it("non-finite / non-positive repo numerics fall back to the default", () => {
    for (const bad of [0, -5, "20k", NaN]) {
      const p = resolvePolicy({
        config: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        repoTable: { repos: { "/repo": { batchTokens: bad } } } as any,
        directory: "/repo",
      });
      expect(p.batchTokens).toBe(MIN_BATCH_TOKENS);
    }
  });

  it("directory absent → repo overrides ignored, no throw", () => {
    const p = resolvePolicy({
      config: {},
      repoTable: { repos: { "/repo": { maskAfterUses: 2 } } },
      directory: undefined,
    });
    expect(p.maskAfterUses).toBe(MASK_AFTER_TOOL_USES);
  });
});

describe("resolvePolicy — cacheTtlMs", () => {
  it("cacheTtlMs supplied → used", () => {
    const p = resolvePolicy({ config: {}, cacheTtlMs: 123_456 });
    expect(p.cacheTtlMs).toBe(123_456);
  });

  it("cacheTtlMs absent → 300_000 default", () => {
    const p = resolvePolicy({ config: {} });
    expect(p.cacheTtlMs).toBe(300_000);
  });

  it("an invalid cacheTtlMs is ignored", () => {
    expect(resolvePolicy({ config: {}, cacheTtlMs: 0 }).cacheTtlMs).toBe(300_000);
    expect(resolvePolicy({ config: {}, cacheTtlMs: -5 }).cacheTtlMs).toBe(300_000);
  });
});

describe("resolvePolicy — never returns null / never throws", () => {
  it("nil inputs resolve to a full default policy", () => {
    const p = resolvePolicy();
    expect(p).toMatchObject(DEFAULT_POLICY);
  });
});

describe("validateRepoTable", () => {
  it("null / [] / {repos:'x'} → {repos:{}}", () => {
    expect(validateRepoTable(null)).toEqual({ repos: {} });
    expect(validateRepoTable([])).toEqual({ repos: {} });
    expect(validateRepoTable({ repos: "x" })).toEqual({ repos: {} });
  });

  it("keeps only positive finite numerics and drops unknown keys", () => {
    const out = validateRepoTable({
      repos: {
        "/a": { maskAfterUses: 5, batchTokens: 0, protectTailTokens: -1, placeholderFormat: "x", junk: 1 },
        "/b": { batchTokens: 50_000 },
      },
    });
    expect(out.repos["/a"]).toEqual({ maskAfterUses: 5 });
    expect(out.repos["/b"]).toEqual({ batchTokens: 50_000 });
  });
});

describe("optimizerCacheTtlMs (TTL-preference helper)", () => {
  it("prefers measuredMs when confidence is 'measured'", () => {
    expect(optimizerCacheTtlMs({ confidence: "measured", measuredMs: 61_000, configuredMs: null })).toBe(61_000);
  });

  it("falls back to configuredMs when confidence is not 'measured'", () => {
    expect(optimizerCacheTtlMs({ confidence: "low", measuredMs: 61_000, configuredMs: 300_000 })).toBe(300_000);
    expect(optimizerCacheTtlMs({ confidence: "measured", configuredMs: 300_000 })).toBe(300_000);
    expect(optimizerCacheTtlMs({ confidence: "low", measuredMs: 61_000, configuredMs: 180_000 })).toBe(180_000);
  });

  it("defaults to 300_000 with no usable ttl", () => {
    expect(optimizerCacheTtlMs(undefined)).toBe(300_000);
    expect(optimizerCacheTtlMs(null)).toBe(300_000);
    expect(optimizerCacheTtlMs({})).toBe(300_000);
  });

  it("ignores a non-positive measured value even when confidence is measured", () => {
    expect(optimizerCacheTtlMs({ confidence: "measured", measuredMs: 0, configuredMs: 180_000 })).toBe(180_000);
  });
});
