// Tests for src/shared/accountDescriptor.mjs — the pure descriptor validator
// and payload mapper at the heart of BET-1239. Mirrors pluginManifest.test.ts
// (vitest, no live fs / network / opencode). The sign conventions are the
// load-bearing part: a wrong balance sign silently turns a dead account into a
// cheap one, which is the exact failure this design guards against.

import { describe, it, expect } from "vitest";
import { validateDescriptor, readDescriptor } from "./accountDescriptor.mjs";

const base = {
  id: "samplecredits",
  providerIDs: ["samplecredits"],
  url: "https://example.com/credits",
  auth: "bearer",
  balance: { path: "account.balance", units: "dollars", sign: "positive-is-credit" },
};

const ok = (raw: Record<string, unknown>) => {
  const r = validateDescriptor(raw);
  if (!r.valid) throw new Error(`expected valid descriptor, got: ${r.errors.join("; ")}`);
  return r.descriptor;
};

describe("validateDescriptor", () => {
  it("accepts a well-formed descriptor and round-trips it", () => {
    const r = validateDescriptor(base);
    expect(r.valid).toBe(true);
    if (!r.valid) return;
    expect(r.descriptor).toEqual(base);
    // A validated descriptor is directly usable for reading.
    const snap = readDescriptor(r.descriptor, { account: { balance: 42 } }, 0);
    expect(snap.balance).toBe(42);
  });

  it("rejects an unknown top-level key and names it", () => {
    const r = validateDescriptor({ ...base, oops: 1 });
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.errors.join("; ")).toContain('"oops"');
  });

  it("rejects a missing required key and names it", () => {
    const { id, ...withoutId } = base;
    const r = validateDescriptor(withoutId);
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.errors.join("; ")).toContain('"id"');
  });

  it("rejects a missing balance object and names it", () => {
    const { balance, ...withoutBalance } = base;
    const r = validateDescriptor(withoutBalance);
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.errors.join("; ")).toContain('"balance"');
  });

  it("rejects an unknown balance.sign value", () => {
    const r = validateDescriptor({
      ...base,
      balance: { ...base.balance, sign: "positive-means-money" },
    });
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.errors.join("; ")).toContain("positive-is-credit");
  });
});

describe("readDescriptor", () => {
  it("maps a nested balance path correctly", () => {
    const snap = readDescriptor(ok(base), { account: { balance: 42 } }, 0);
    expect(snap.balance).toBe(42);
  });

  it("a negative balance under positive-is-credit sets exhausted and stays negative", () => {
    const snap = readDescriptor(ok(base), { account: { balance: -5 } }, 0);
    expect(snap.balance).toBe(-5);
    expect(snap.exhausted).toBe(true);
  });

  it("positive-is-debt inverts correctly", () => {
    const d = ok({ ...base, balance: { ...base.balance, sign: "positive-is-debt" } });
    const snap = readDescriptor(d, { account: { balance: 15 } }, 0);
    // 15 balance means 15 of debt → -15 credit → overdrawn.
    expect(snap.balance).toBe(-15);
    expect(snap.exhausted).toBe(true);
  });

  it("positive-is-debt does not set exhausted for a (credit) negative raw value", () => {
    const d = ok({ ...base, balance: { ...base.balance, sign: "positive-is-debt" } });
    const snap = readDescriptor(d, { account: { balance: -10 } }, 0);
    expect(snap.balance).toBe(10);
    expect(snap.exhausted).toBeUndefined();
  });

  it("a payload missing the balance path leaves balance undefined, NOT 0", () => {
    const d = ok({ ...base, balance: { ...base.balance, path: "nope.missing" } });
    const snap = readDescriptor(d, {}, 0);
    expect(snap.balance).toBeUndefined();
    expect(snap).not.toHaveProperty("balance");
  });

  it("window paths produce a UsageWindow with startedAt carried through", () => {
    const d = ok({
      ...base,
      windows: [
        {
          kind: "weekly",
          label: "7d",
          used: "data.used",
          limit: "data.limit",
          resetsAt: "data.resets_at",
          startedAt: "data.started_at",
        },
      ],
    });
    const snap = readDescriptor(
      d,
      { data: { used: 120, limit: 200, resets_at: 1700000000, started_at: 1699990000 } },
      0,
    );
    const windows = snap.windows as Array<Record<string, unknown>>;
    expect(windows).toHaveLength(1);
    const w = windows[0];
    expect(w.kind).toBe("weekly");
    expect(w.label).toBe("7d");
    expect(w.used).toBe(120);
    expect(w.limit).toBe(200);
    expect(w.pct).toBe(60);
    expect(w.startedAt).toBe(1699990000 * 1000);
    expect(w.resetsAt).toBe(1700000000 * 1000);
  });

  it("a window at 100% sets exhausted even with no balance", () => {
    const d = ok({
      ...base,
      windows: [{ kind: "session", label: "5h", pct: "w.pct" }],
    });
    const snap = readDescriptor(d, { w: { pct: 100 } }, 0);
    expect(snap.exhausted).toBe(true);
  });
});
