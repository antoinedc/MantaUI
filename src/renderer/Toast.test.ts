import { describe, it, expect } from "vitest";
import {
  toastTtl,
  TOAST_DEFAULT_TTL_MS,
  MAX_TOASTS,
  MAX_TOAST_ACTIONS,
  type ToastItem,
} from "./Toast";

const base: ToastItem = { id: "x", message: "hi" };

// BET-1055 removed Undo from every toast. This test pins the Toast primitive's
// generic action rule (an action means no auto-dismiss) with a neutral label —
// no Settings toast carries an action any more.
describe("toastTtl", () => {
  it("never auto-dismisses when any action is present", () => {
    expect(toastTtl({ ...base, actions: [{ label: "Save", onClick: () => {} }] })).toBeNull();
    expect(
      toastTtl({ ...base, actions: [{ label: "Remind me", onClick: () => {} }, { label: "Keep going", onClick: () => {} }] }),
    ).toBeNull();
  });

  it("never auto-dismisses when an action is present even with an explicit ttl", () => {
    expect(
      toastTtl({ ...base, actions: [{ label: "Save", onClick: () => {} }], ttl: 6000 }),
    ).toBeNull();
  });

  it("regards an empty actions array as no action (keeps default ttl)", () => {
    expect(toastTtl({ ...base, actions: [] })).toBe(TOAST_DEFAULT_TTL_MS);
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

describe("MAX_TOASTS / MAX_TOAST_ACTIONS", () => {
  it("is three (spec: max three stacked)", () => {
    expect(MAX_TOASTS).toBe(3);
  });

  it("caps actions at two (spec, BET-739)", () => {
    expect(MAX_TOAST_ACTIONS).toBe(2);
  });
});
