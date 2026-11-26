// Shared builders for the agent pages' tests: a change record and the click / button helpers every page test repeats.

import { act } from "react";
import { expect } from "vitest";
import type { AgentChange } from "../../shared/types";
import { afterEach, beforeEach, vi, type Mock } from "vitest";
import { resetStore, type Harness } from "../testHarness";

/** An applied update of @seo by the Architect; each test overrides what it cares about. */
export const changeRecord = (over: Partial<AgentChange> = {}): AgentChange => ({
  id: "c1",
  kind: "update",
  slug: "seo",
  agentName: "SEO",
  sessionID: "ses",
  messageID: "m",
  callID: "c",
  state: "applied",
  needsClick: false,
  reason: null,
  before: "V1",
  after: "V2",
  createdAt: 1,
  decidedAt: 1,
  error: null,
  origin: { kind: "job", jobId: "j", rootJobId: "j", attempt: 1 },
  mode: "build",
  releasedAt: 1,
  decidedBy: "auto",
  summary: null,
  evidence: [],
  admission: [],
  ...over,
});

/** The first button under `scope` whose text starts with (or, with `exact`, equals) `text`. */
export const buttonIn = (scope: ParentNode, text: string, exact = false): HTMLButtonElement | undefined =>
  [...scope.querySelectorAll("button")].find((b) => (exact ? (b.textContent ?? "").trim() === text : (b.textContent ?? "").trim().startsWith(text))) as HTMLButtonElement | undefined;

/** A real click, with the page's pending reads settled after it. */
export async function clickEl(h: Harness, el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await h.flush();
}

/**
 * The describe-level setup the History and Seats tests share: a fresh store and a fresh `onChanged` spy before each test, and the
 * mounted harness unmounted after it. `current` hands the test its harness (set it in `open`).
 */
export function useHarnessLifecycle(): { // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChanged: Mock<(...args: any[]) => void>; take: (h: Harness) => Harness } {
  let current: Harness | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onChanged = vi.fn<(...args: any[]) => void>();
  beforeEach(() => {
    resetStore();
    onChanged.mockClear();
  });
  afterEach(() => {
    current?.unmount();
    current = null;
  });
  return {
    onChanged,
    take: (h) => {
      current = h;
      return h;
    },
  };
}
