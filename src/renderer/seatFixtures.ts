// Shared fixtures for the multi-account renderer tests (selectors, popover,
// Settings panel). Test-only; never imported by production code.
import type { ProviderView, SeatView, UsageSnapshot, UsageWindow } from "../shared/types";

export const NOW = 1_800_000_000_000;

export function win(kind: "session" | "weekly", pct: number, extra: Partial<UsageWindow> = {}): UsageWindow {
  return { kind, label: kind === "session" ? "5h" : "7d", pct, resetsAt: NOW + 3 * 3_600_000, ...extra };
}

export function seat(id: string, label: string, session: number | null, weekly = 10, extra: Partial<SeatView> = {}): SeatView {
  const windows = session == null ? [] : [win("session", session), win("weekly", weekly)];
  return {
    id,
    label,
    email: `${id}@example.com`,
    status: "ok",
    live: false,
    windows,
    load: session == null ? null : Math.max(session, weekly),
    fetchedAt: NOW - 60_000,
    conversations: 0,
    ...extra,
  };
}

/** Three seats: two in account A (same org), one in account B. */
export function threeSeatView(over: Partial<ProviderView> = {}): ProviderView {
  return {
    provider: "claude",
    mode: "auto",
    activeSeatId: "s1",
    routingActive: true,
    nextSeatId: "s2",
    accounts: [
      {
        id: "a1",
        label: "Work",
        orgName: "Acme",
        plan: "Max 20x",
        seats: [seat("s1", "Seat 1", 96, 40, { live: true, conversations: 2 }), seat("s2", "Seat 2", 20, 15, { conversations: 1 })],
      },
      { id: "a2", label: "Personal", orgName: null, plan: "Pro", seats: [seat("s3", "Seat 1", 55, 30)] },
    ],
    ...over,
  };
}

export function oneSeatView(): ProviderView {
  return {
    provider: "claude",
    mode: "auto",
    activeSeatId: "s1",
    routingActive: true,
    nextSeatId: null,
    accounts: [{ id: "a1", label: "Work", orgName: null, plan: "Max 20x", seats: [seat("s1", "Seat 1", 42, 20, { live: true })] }],
  };
}

export const claudeSnapshot: UsageSnapshot = {
  provider: "claude",
  providerIDs: ["anthropic"],
  planLabel: "Max 20x",
  windows: [win("session", 42), win("weekly", 20)],
  fetchedAt: NOW - 60_000,
};

export const codexSnapshot: UsageSnapshot = {
  provider: "codex",
  providerIDs: ["openai"],
  planLabel: "Plus",
  windows: [win("session", 12, { label: "5h" })],
  fetchedAt: NOW - 60_000,
};
