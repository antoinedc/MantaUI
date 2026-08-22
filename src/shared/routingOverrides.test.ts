import { describe, it, expect } from "vitest";
import {
  applyRoutingOverrides,
  resolveNowOverride,
  resolveHealthOverride,
} from "./routingOverrides.mjs";

type Endpoint = { providerID: string; id?: string; modelID?: string };
type Applied = { services: Record<string, unknown>; catalog: Endpoint[] };

// Helper shapes mirroring the live sources (src/server/routingServices.mjs and
// opencode.mjs listRoutableModels) — providerID/id routes, not hand-won.
const ep = (providerID: string, id: string): Endpoint => ({ providerID, id });
const keyOf = (c: Endpoint): string => `${c.providerID}/${c.id ?? c.modelID ?? ""}`;

const apply = (o: unknown): Applied => o as Applied;

describe("applyRoutingOverrides (BET-1276 12a)", () => {
  it("passes inputs through untouched when gated off", () => {
    const services = { accounts: { a: 1 } };
    const catalog = [ep("p1", "m1"), ep("p2", "m2")];
    const out = apply(
      applyRoutingOverrides({
        services,
        catalog,
        surface: "main",
        overrides: {
          accounts: { b: 2 },
          health: { p1: "out-of-credit" },
          enabledMain: ["p1/m1"],
          nowMs: 0,
        },
        gated: false,
      }),
    );
    expect(out.services).toBe(services);
    expect(out.catalog).toBe(catalog);
  });

  it("replaces accounts and health, filtering the main pool by enabledMain", () => {
    const services = { accounts: { a: 1 }, health: { p1: "ok" } };
    const catalog = [ep("p1", "m1"), ep("p2", "m2")];
    const out = apply(
      applyRoutingOverrides({
        services,
        catalog,
        surface: "main",
        overrides: {
          accounts: { b: 2 },
          health: { p1: "out-of-credit" },
          enabledMain: ["p2/m2"],
        },
        gated: true,
      }),
    );
    expect(out.services.accounts).toEqual({ b: 2 });
    expect(out.services.health).toEqual({ p1: "out-of-credit" });
    expect(out.services).not.toBe(services);
    expect(out.catalog.map(keyOf)).toEqual(["p2/m2"]);
  });

  it("applies enabledSub to the sub surface and enabledMain to main independently", () => {
    const catalog = [ep("p1", "m1"), ep("p2", "m2")];
    for (const surface of ["main", "sub"] as const) {
      const sub = apply(
        applyRoutingOverrides({
          services: {},
          catalog,
          surface,
          overrides: { enabledSub: ["p2/m2"], enabledMain: [] },
          gated: true,
        }),
      );
      if (surface === "main") expect(sub.catalog).toHaveLength(0);
      else expect(sub.catalog.map(keyOf)).toEqual(["p2/m2"]);
    }
  });

  it("an empty provided list means an empty pool (present-but-empty, not absent)", () => {
    const catalog = [ep("p1", "m1"), ep("p2", "m2")];
    const out = apply(
      applyRoutingOverrides({
        services: {},
        catalog,
        surface: "main",
        overrides: { enabledMain: [] },
        gated: true,
      }),
    );
    expect(out.catalog).toHaveLength(0);
  });

  it("no restriction when the list is absent", () => {
    const catalog = [ep("p1", "m1"), ep("p2", "m2")];
    const out = apply(
      applyRoutingOverrides({
        services: {},
        catalog,
        surface: "main",
        overrides: { accounts: {} },
        gated: true,
      }),
    );
    expect(out.catalog).toHaveLength(2);
  });

  it("matches endpoint keys by providerID/modelID (both id and modelID spellings)", () => {
    const a: Endpoint = { providerID: "p1", id: "m1" };
    const b: Endpoint = { providerID: "p1", modelID: "m2" };
    const out = apply(
      applyRoutingOverrides({
        services: {},
        catalog: [a, b],
        surface: "main",
        overrides: { enabledMain: ["p1/m2"] },
        gated: true,
      }),
    );
    expect(out.catalog).toEqual([b]);
  });
});

describe("resolveNowOverride (12a injected clock)", () => {
  it("honours a finite nowMs when gated on", () => {
    expect(resolveNowOverride({ nowMs: 123 }, true, 456)).toBe(123);
  });
  it("falls back when gated off", () => {
    expect(resolveNowOverride({ nowMs: 123 }, false, 456)).toBe(456);
  });
  it("falls back when nowMs is missing or non-finite", () => {
    expect(resolveNowOverride({}, true, 456)).toBe(456);
    expect(resolveNowOverride({ nowMs: "x" }, true, 456)).toBe(456);
  });
});

describe("resolveHealthOverride (12a incumbent-health report)", () => {
  it("returns the health map when gated on and present", () => {
    expect(resolveHealthOverride({ health: { p1: "failing" } }, true)).toEqual({ p1: "failing" });
  });
  it("returns null when gated off or absent", () => {
    expect(resolveHealthOverride({ health: { p1: "failing" } }, false)).toBeNull();
    expect(resolveHealthOverride({}, true)).toBeNull();
  });
});
