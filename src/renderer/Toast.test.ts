import { describe, it, expect } from "vitest";
import { toastTtl, TOAST_DEFAULT_TTL_MS, MAX_TOASTS, type ToastItem } from "./Toast";

const base: ToastItem = { id: "x", message: "hi" };

describe("toastTtl", () => {
  it("never auto-dismisses when an action is present", () => {
    expect(toastTtl({ ...base, action: { label: "Undo", onClick: () => {} } })).toBeNull();
    expect(toastTtl({ ...base, action: { label: "Save", onClick: () => {} }, ttl: 6000 })).toBeNull();
  });

  it("opts out entirely with ttl: null", () => {
    expect(toastTtl({ ...base, ttl: null })).toBeNull();
  });

  it("uses an explicit ttl when provided (no action)", () => {
    expect(toastTtl({ ...base, ttl: 12000 })).toBe(12000);
  });

  it("falls back to the default ttl when unspecified and no action", () => {
    expect(toastTtl({ ...base })).toBe(TOAST_DEFAULT_TTL_MS);
    expect(TOAST_DEFAULT_TTL_MS).toBe(6000);
  });
});

describe("MAX_TOASTS", () => {
  it("is three (spec: max three stacked)", () => {
    expect(MAX_TOASTS).toBe(3);
  });
});
