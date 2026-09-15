// @vitest-environment jsdom
//
// ===== CtoChat tests =====
//
// Real component + the shared mock `window.api` (testHarness). These lock the
// P3b admission-seam contract in the UI:
//   - lazy open on the tab's first visit; loading/error explicit
//   - double-mount / remount re-opens through the SAME server-ensured session
//   - send goes through ctoConversationSubmit (stable client id +
//     expectedGeneration), never the legacy opencode prompt path
//   - a follow-up while a turn runs is accepted + QUEUED (bubble), with NO
//     client-side abort (the ordinary drain machinery stays dormant)
//   - a timed-out send keeps its submission id + payload across the retry
//   - the unknown barrier is visible and retryable/dismissible
//   - interrupt uses the ADMISSION RECORD id via ctoConversationInterrupt
//   - a read-only open performs NO worker/turn creation calls
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import {
  installMockApi,
  mount,
  emitAndFlush,
  resetStore,
  type Harness,
  type MockApi,
  type MockEventBus,
} from "./testHarness";
import { CtoChat } from "./CtoChat";
import { CtoPanel } from "./CtoPanel";
import type { CtoConversationState } from "../shared/api";

const SESSION = "ses_cto_1";
const GENERATION = 3;

function emptyQueue(): CtoConversationState {
  return {
    binding: { sessionId: SESSION, generation: GENERATION },
    submissions: [],
    counts: { queued: { human: 0, background: 0 }, unresolved: 0, terminal: 0 },
    droppedByPolicy: [],
  };
}

function receiptOf(input: { id?: string; text: string }) {
  return {
    id: input.id ?? "evt_srv",
    origin: "human" as const,
    status: "queued",
    payloadHash: "h",
    createdAt: Date.now(),
    submitGeneration: GENERATION,
    text: input.text,
    persisted: true,
  };
}

// The default CTO conversation harness: the four conversation-channel mocks
// every CtoChat/CtoPanel test needs unless a case overrides one. Shared so
// each call site stays a one-liner (the strict duplication gate scans this
// file against itself).
function ctoHarness(state: CtoConversationState = emptyQueue()): Record<string, unknown> {
  return {
    ctoConversationOpen: () =>
      Promise.resolve({ sessionId: SESSION, generation: GENERATION }),
    ctoConversationState: () => Promise.resolve(state),
    ctoConversationSubmit: (input: { id?: string; text: string }) =>
      Promise.resolve(receiptOf(input)),
    ctoConversationInterrupt: () =>
      Promise.resolve({ ok: true, id: "evt_x", status: "interrupt_pending" }),
  };
}

type Gate = { resolve: (v: unknown) => void };
function gate(): Gate {
  let resolve!: Gate["resolve"];
  const p = new Promise((res) => {
    resolve = res;
  });
  void p;
  return { resolve };
}

function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressEnter(el: HTMLTextAreaElement) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

async function typeAndSubmit(h: Harness, text: string) {
  const textarea = h.container.querySelector(
    'textarea[aria-label="Message the CTO"]',
  );
  expect(textarea).not.toBeNull();
  await act(async () => {
    typeInto(textarea as HTMLTextAreaElement, text);
  });
  await act(async () => {
    pressEnter(textarea as HTMLTextAreaElement);
  });
  await h.flush();
}

describe("CtoChat", () => {
  let api: MockApi;
  let bus: MockEventBus;
  let h: Harness | null = null;

  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    h?.unmount();
    h = null;
    expect(bus.listenerCount()).toBe(0);
    vi.restoreAllMocks();
  });

  function mountCto(queue: CtoConversationState = emptyQueue(), overrides: Record<string, unknown> = {}) {
    ({ api, bus } = installMockApi({ ...ctoHarness(queue), ...overrides }));
    h = mount(<CtoChat />);
    return h;
  }

  it("opens lazily with an explicit loading state, then reads the transcript through the bound session", async () => {
    const fetches: unknown[][] = [];
    h = mountCto(emptyQueue(), {
      opencodeMessages: (...args: unknown[]) => {
        fetches.push(args);
        return Promise.resolve([]);
      },
    });
    // Open is async; before it resolves the surface says what it is doing —
    // never a blank "empty healthy" transcript.
    expect(h.text()).toContain("Opening the CTO conversation");
    await h.flush();
    expect(api.calls.ctoConversationOpen?.length).toBe(1);
    // Transcript reads are scoped to the server-ensured session id.
    expect(fetches.length).toBeGreaterThan(0);
    expect(fetches[0][0]).toBe(SESSION);
    // A read-only open creates no worker/turn: no submits, no prompts.
    expect(api.calls.ctoConversationSubmit?.length ?? 0).toBe(0);
    expect(api.calls.opencodePrompt?.length ?? 0).toBe(0);
  });

  it("shows an explicit error with a working Retry when the open fails", async () => {
    let fail = true;
    h = mountCto(emptyQueue(), {
      ctoConversationOpen: () =>
        fail
          ? Promise.reject(new Error("box unreachable"))
          : Promise.resolve({ sessionId: SESSION, generation: GENERATION }),
    });
    await h.flush();
    expect(h.text()).toMatch(/Couldn.t open the CTO conversation/);
    expect(h.text()).toContain("box unreachable");
    const callsBefore = api.calls.ctoConversationOpen?.length ?? 0;
    const retryBtn = Array.from(h.container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Retry"),
    );
    expect(retryBtn).not.toBeNull();
    fail = false;
    await act(async () => {
      retryBtn!.click();
    });
    await h.flush();
    expect(api.calls.ctoConversationOpen?.length ?? 0).toBeGreaterThan(callsBefore);
    // After a successful retry the conversation is live (composer present).
    expect(h.container.querySelector('textarea[aria-label="Message the CTO"]')).not.toBeNull();
  });

  it("remount (double-mount) re-opens through the SAME server-ensured session", async () => {
    h = mountCto();
    await h.flush();
    const firstFetches = (api.calls.opencodeMessages ?? []).map((c) => c[0]);
    expect(firstFetches).toContain(SESSION);
    h.unmount();
    h = null;
    // Second mount on the same box: the server ensures the same durable
    // session, and the panel binds to exactly that.
    ({ api, bus } = installMockApi(ctoHarness()));
    h = mount(<CtoChat />);
    await h.flush();
    expect(api.calls.ctoConversationOpen?.length).toBe(1);
    expect((api.calls.opencodeMessages ?? []).some((c) => c[0] === SESSION)).toBe(true);
  });

  it("sends through ctoConversationSubmit with a stable client id + expectedGeneration — never the legacy prompt path", async () => {
    h = mountCto();
    await h.flush();
    await typeAndSubmit(h, "ship the release");
    const calls = api.calls.ctoConversationSubmit ?? [];
    expect(calls.length).toBe(1);
    const arg = calls[0][0] as { id: string; text: string; expectedGeneration?: number };
    expect(arg.id).toMatch(/^ceo_/);
    expect(arg.text).toBe("ship the release");
    expect(arg.expectedGeneration).toBe(GENERATION);
    expect(api.calls.opencodePrompt?.length ?? 0).toBe(0);
    expect(api.calls.opencodeAbort?.length ?? 0).toBe(0);
  });

  it("a follow-up while a turn runs is queued (server-side) — no client drain, no abort", async () => {
    const queuedRecord = {
      id: "evt_q_other_client",
      origin: "human" as const,
      status: "queued",
      payloadHash: "h2",
      createdAt: Date.now(),
      submitGeneration: GENERATION,
    };
    const q = emptyQueue();
    q.submissions = [queuedRecord];
    q.counts.queued.human = 1;
    h = mountCto(q);
    await h.flush();
    // A turn is running on the bound session.
    await emitAndFlush(bus, h, {
      type: "session.status",
      properties: { sessionID: SESSION, status: "busy" },
    });
    // The queued record (from this or another client) is VISIBLE as a pending
    // bubble — the queue projection is the shared truth.
    expect(h.text()).toContain("Queued — after the current turn");
    // Sending a follow-up goes through the admission API (the server queues
    // it); the client does NOT abort the running turn.
    await typeAndSubmit(h, "also check logs");
    const submits = api.calls.ctoConversationSubmit ?? [];
    expect(submits.length).toBe(1);
    expect((submits[0][0] as { text: string }).text).toBe("also check logs");
    expect(api.calls.opencodeAbort?.length ?? 0).toBe(0);
    expect(api.calls.opencodePrompt?.length ?? 0).toBe(0);
  });

  it("a double-press while a send is in flight does not mint a second submission", async () => {
    const hold = gate();
    h = mountCto(emptyQueue(), {
      ctoConversationSubmit: (input: { id?: string; text: string }) =>
        new Promise((_resolve) => {
          // Hold the send in flight until the test releases the gate.
          hold.resolve({ v: receiptOf(input) });
        }),
    });
    await h.flush();
    const textarea = h.container.querySelector(
      'textarea[aria-label="Message the CTO"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      typeInto(textarea, "once only");
    });
    await act(async () => {
      pressEnter(textarea);
      pressEnter(textarea);
    });
    await h.flush();
    expect((api.calls.ctoConversationSubmit ?? []).length).toBe(1);
    hold.resolve(undefined);
    await h.flush();
  });

  it("a timed-out send retries with the SAME submission id + payload; the unknown barrier is visible then clears", async () => {
    let n = 0;
    const seen: string[] = [];
    h = mountCto(emptyQueue(), {
      ctoConversationSubmit: (input: { id?: string; text: string }) => {
        n += 1;
        seen.push(`${input.id}:${input.text}`);
        if (n === 1) return Promise.reject(new Error("network timeout"));
        return Promise.resolve(receiptOf(input));
      },
    });
    await h.flush();
    await typeAndSubmit(h, "check the deploy");
    // The unknown barrier is visible — the outcome was never confirmed.
    expect(h.text()).toContain("Outcome unknown — reconciling");
    expect(h.text()).toContain("check the deploy");
    // Explicit Retry resubmits the SAME id + payload (server dedup makes it
    // idempotent) — never a fresh uuid per retry.
    const retryBtn = Array.from(h.container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Retry send",
    );
    expect(retryBtn).not.toBeNull();
    await act(async () => {
      retryBtn!.click();
    });
    await h.flush();
    expect(seen.length).toBe(2);
    expect(seen[0]).toBe(seen[1]);
    expect((seen[0].split(":")[0] ?? "").startsWith("ceo_")).toBe(true);
    // Both attempts were generation-gated.
    const calls = api.calls.ctoConversationSubmit ?? [];
    expect((calls[0][0] as { expectedGeneration?: number }).expectedGeneration).toBe(GENERATION);
    expect((calls[1][0] as { expectedGeneration?: number }).expectedGeneration).toBe(GENERATION);
    // Success clears the barrier.
    expect(h.text()).not.toContain("Outcome unknown — reconciling");
  });

  it("the unknown barrier can be dismissed", async () => {
    h = mountCto(emptyQueue(), {
      ctoConversationSubmit: () => Promise.reject(new Error("network timeout")),
    });
    await h.flush();
    await typeAndSubmit(h, "ping");
    expect(h.text()).toContain("Outcome unknown — reconciling");
    const dismiss = Array.from(h.container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Dismiss unknown send",
    );
    expect(dismiss).not.toBeNull();
    await act(async () => {
      dismiss!.click();
    });
    await h.flush();
    expect(h.text()).not.toContain("Outcome unknown — reconciling");
  });

  it("interrupt goes through ctoConversationInterrupt with the ADMISSION RECORD id — never an opencode abort", async () => {
    const running = {
      id: "evt_running_1",
      origin: "human" as const,
      status: "accepted",
      payloadHash: "h3",
      createdAt: Date.now(),
      submitGeneration: GENERATION,
      messageID: "msg_1",
      sessionId: SESSION,
    };
    const q = emptyQueue();
    q.submissions = [running];
    q.counts.unresolved = 1;
    h = mountCto(q);
    await h.flush();
    await emitAndFlush(bus, h, {
      type: "session.status",
      properties: { sessionID: SESSION, status: "busy" },
    });
    const stop = h.container.querySelector('button[aria-label="Interrupt"]');
    expect(stop).not.toBeNull();
    await act(async () => {
      (stop as HTMLButtonElement).click();
    });
    await h.flush();
    const interrupts = api.calls.ctoConversationInterrupt ?? [];
    expect(interrupts.length).toBe(1);
    expect((interrupts[0][0] as { id: string }).id).toBe("evt_running_1");
    expect(api.calls.opencodeAbort?.length ?? 0).toBe(0);
  });

  it("a role-binding generation change reloads the session without re-sending old submissions", async () => {
    let q = emptyQueue();
    h = mountCto(q, {
      ctoConversationState: () => Promise.resolve(q),
    });
    await h.flush();
    expect((api.calls.opencodeMessages ?? []).every((c) => c[0] === SESSION)).toBe(true);
    // Another client rebound the conversation: new session id + generation.
    const rebound = emptyQueue();
    rebound.binding = { sessionId: "ses_cto_2", generation: 4 };
    q = rebound;
    // The next poll (here: the window-focus freshness refresh) adopts the new
    // binding, reloads the transcript for the NEW session id — and does NOT
    // re-send anything.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await h.flush();
    expect((api.calls.opencodeMessages ?? []).some((c) => c[0] === "ses_cto_2")).toBe(true);
    expect((api.calls.ctoConversationSubmit?.length ?? 0)).toBe(0);
    expect(h.text()).toContain("rebound");
  });

  it("the cheap state poll only reads — never creates model turns", async () => {
    h = mountCto();
    await h.flush();
    const readsBefore = api.calls.ctoConversationState?.length ?? 0;
    expect(readsBefore).toBeGreaterThan(0);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await h.flush();
    expect((api.calls.ctoConversationState?.length ?? 0)).toBeGreaterThan(readsBefore);
    expect(api.calls.ctoConversationSubmit?.length ?? 0).toBe(0);
    expect(api.calls.opencodePrompt?.length ?? 0).toBe(0);
  });

  it("surfaces droppedByPolicy deliveries honestly — real losses, never ignored", async () => {
    const q = emptyQueue();
    q.submissions = [
      {
        id: "sched_j1_min",
        origin: "background",
        status: "queued",
        payloadHash: "hb",
        createdAt: Date.now(),
        submitGeneration: GENERATION,
      },
    ];
    q.counts.queued.background = 1;
    q.droppedByPolicy = [
      { id: "sched_j0_min", origin: "background", createdAt: Date.now() - 60_000 },
    ];
    h = mountCto(q);
    await h.flush();
    // The inspector is opened via the Work inspector toggle.
    const toggle = Array.from(h.container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Work inspector"),
    );
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle!.click();
    });
    await h.flush();
    // The drop count is in the summary line and each dropped record is listed
    // as never-run — a queue count going down must be explainable.
    expect(h.text()).toContain("dropped by the cap policy");
    expect(h.text()).toContain("sched_j0_min");
    expect(h.text()).toContain("never ran");
    expect(h.text()).toContain("never dispatched");
  });

  it("renders an uncertain abort as a PERMANENT admission hold — never transient", async () => {
    const q = emptyQueue();
    q.submissions = [
      {
        id: "evt_held_1",
        origin: "human",
        status: "interrupt_pending",
        payloadHash: "h4",
        createdAt: Date.now(),
        submitGeneration: GENERATION,
        sessionId: SESSION,
        abortState: "uncertain",
        abortOutcomeReason: "abort_outcome_unknown",
      },
    ];
    q.counts.unresolved = 1;
    h = mountCto(q);
    await h.flush();
    // The contract-mandated phrasing (limitation 1a): held for this session,
    // not "stopped", not a spinner that never resolves.
    expect(h.text()).toContain("Abort outcome unknown — admission held for this session");
    // And it reads as a barrier, not as a completed interrupt.
    expect(h.text()).not.toContain("Interrupt pending");
  });
});

// ===== CtoPanel view migration =====
//
// The CTO tab's primary surface is the conversation; the dashboard (and every
// existing sub-view) survives one click away — and back.
describe("CtoPanel primary conversation", () => {
  let api: MockApi;
  let bus: MockEventBus;
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
    expect(bus.listenerCount()).toBe(0);
  });

  it("defaults to the conversation and round-trips to the dashboard and back", async () => {
    ({ api, bus } = installMockApi({
      ...ctoHarness(),
      ctoDigestGet: () =>
        Promise.resolve({ items: [], generatedAt: Date.now(), state: "idle" }),
      ctoCardsGet: () => Promise.resolve({ cards: [] }),
      ctoFinishedGet: () => Promise.resolve({ items: [] }),
    }));
    resetStore();
    h = mount(<CtoPanel state={null} onOpenSession={() => {}} />);
    await h.flush();
    // Primary surface = the conversation (composer present).
    expect(h.container.querySelector('textarea[aria-label="Message the CTO"]')).not.toBeNull();
    // Dashboard round-trip.
    const dash = Array.from(h.container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Dashboard"),
    );
    expect(dash).not.toBeNull();
    await act(async () => {
      dash!.click();
    });
    await h.flush();
    expect(Array.from(h.container.querySelectorAll("button")).some((b) =>
      b.textContent?.includes("Digest now"),
    )).toBe(true);
    const back = h.container.querySelector('button[aria-label="Back to the conversation"]');
    expect(back).not.toBeNull();
    await act(async () => {
      (back as HTMLButtonElement).click();
    });
    await h.flush();
    expect(h.container.querySelector('textarea[aria-label="Message the CTO"]')).not.toBeNull();
    // Still no legacy prompt path anywhere in the round-trip.
    expect(api.calls.opencodePrompt?.length ?? 0).toBe(0);
  });
});
